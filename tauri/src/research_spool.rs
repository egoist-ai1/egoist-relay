// Прямой приём байтов исследовательского медиа: файл растёт в каталоге spool внутри закрытого корня состояния,
// имя строится из проверенных hex-значений, поэтому ни страница, ни демон не выбирают путь записи.
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

pub(crate) const ALIGN: u64 = 1_048_576;
pub(crate) const MAX_CHUNK: usize = 4 * 1_048_576;
pub(crate) const MAX_FILE: u64 = 1_073_741_824;
pub(crate) const DISK_RESERVE: u64 = 1_073_741_824;
pub(crate) const STALE_AFTER: Duration = Duration::from_secs(14 * 86400);
const SPOOL_DIRECTORY: &str = "spool";

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum SpoolError {
  InvalidKey,
  InvalidFingerprint,
  InvalidOffset,
  InvalidSize,
  ResumeMismatch,
  DiskReserve,
  Unsafe,
  Sequence,
  Overflow,
  Incomplete,
  Io,
}

impl SpoolError {
  pub(crate) fn code(&self) -> &'static str {
    match self {
      SpoolError::InvalidKey | SpoolError::InvalidFingerprint | SpoolError::InvalidOffset => "INVALID_MEDIA",
      SpoolError::InvalidSize | SpoolError::Overflow | SpoolError::Sequence => "MEDIA_LIMIT",
      SpoolError::ResumeMismatch => "RESUME_MISMATCH",
      SpoolError::DiskReserve => "DISK_RESERVE",
      SpoolError::Unsafe => "SPOOL_UNSAFE",
      SpoolError::Incomplete => "MEDIA_SIZE_MISMATCH",
      SpoolError::Io => "SPOOL_IO",
    }
  }
}

pub(crate) struct SpoolDone {
  pub(crate) name: String,
  pub(crate) bytes: u64,
  pub(crate) sha256: String,
}

impl SpoolDone {
  pub(crate) fn to_value(&self) -> Value {
    json!({"name":self.name,"bytes":self.bytes,"sha256":self.sha256})
  }
}

pub(crate) struct SpoolWriter {
  file: File,
  part: PathBuf,
  done: PathBuf,
  name: String,
  declared: u64,
  written: u64,
  next_sequence: u64,
  hasher: Sha256,
}

fn is_hex(value: &str, length: usize) -> bool {
  value.len() == length
    && value
      .bytes()
      .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub(crate) fn valid_key(value: &str) -> bool {
  is_hex(value, 32)
}

pub(crate) fn valid_fingerprint(value: &str) -> bool {
  is_hex(value, 16)
}

pub(crate) fn spool_directory(state_root: &Path) -> PathBuf {
  state_root.join(SPOOL_DIRECTORY)
}

// A reparse point (junction, symlink) or a non-directory in the path is never followed
fn is_plain(path: &Path, directory: bool) -> bool {
  let Ok(meta) = fs::symlink_metadata(path) else {
    return false;
  };
  if meta.file_type().is_symlink() || (directory && !meta.is_dir()) || (!directory && !meta.is_file()) {
    return false;
  }
  #[cfg(windows)]
  {
    use std::os::windows::fs::MetadataExt;
    if meta.file_attributes() & 0x400 != 0 {
      return false;
    }
  }
  true
}

fn ensure_directory(state_root: &Path) -> Result<PathBuf, SpoolError> {
  if !is_plain(state_root, true) {
    return Err(SpoolError::Unsafe);
  }
  let directory = spool_directory(state_root);
  if !directory.exists() {
    fs::create_dir(&directory).map_err(|_| SpoolError::Io)?;
  }
  if !is_plain(&directory, true) {
    return Err(SpoolError::Unsafe);
  }
  Ok(directory)
}

impl SpoolWriter {
  // `free_space` returns the free bytes of the volume holding the directory, or none when unknown
  pub(crate) fn open(
    state_root: &Path,
    key: &str,
    fingerprint: &str,
    declared: u64,
    resume_from: u64,
    free_space: &dyn Fn(&Path) -> Option<u64>,
  ) -> Result<Self, SpoolError> {
    if !valid_key(key) {
      return Err(SpoolError::InvalidKey);
    }
    if !valid_fingerprint(fingerprint) {
      return Err(SpoolError::InvalidFingerprint);
    }
    if declared == 0 || declared > MAX_FILE {
      return Err(SpoolError::InvalidSize);
    }
    if resume_from % ALIGN != 0 || resume_from >= declared {
      return Err(SpoolError::InvalidOffset);
    }
    let directory = ensure_directory(state_root)?;
    let needed = declared - resume_from;
    if free_space(&directory).is_some_and(|free| free < needed.saturating_add(DISK_RESERVE)) {
      return Err(SpoolError::DiskReserve);
    }
    let name = format!("{key}.{fingerprint}");
    let part = directory.join(format!("{name}.part"));
    let done = directory.join(format!("{name}.done"));
    let mut hasher = Sha256::new();
    let mut options = OpenOptions::new();
    options.read(true).write(true);
    #[cfg(windows)]
    {
      use std::os::windows::fs::OpenOptionsExt;
      // Other processes may read the part but not write it, so one run owns a key
      options.share_mode(1);
    }
    let file = if resume_from == 0 {
      remove_versions(&directory, key);
      options.create(true).truncate(true);
      options.open(&part).map_err(|_| SpoolError::Io)?
    } else {
      if !is_plain(&part, false) {
        return Err(SpoolError::ResumeMismatch);
      }
      let mut file = options.open(&part).map_err(|_| SpoolError::Io)?;
      let length = file.metadata().map_err(|_| SpoolError::Io)?.len();
      if length < resume_from {
        return Err(SpoolError::ResumeMismatch);
      }
      file.set_len(resume_from).map_err(|_| SpoolError::Io)?;
      hash_prefix(&mut file, resume_from, &mut hasher)?;
      file.seek(SeekFrom::Start(resume_from)).map_err(|_| SpoolError::Io)?;
      file
    };
    Ok(SpoolWriter {
      file,
      part,
      done,
      name,
      declared,
      written: resume_from,
      next_sequence: 0,
      hasher,
    })
  }

  #[cfg(test)]
  pub(crate) fn written(&self) -> u64 {
    self.written
  }

  pub(crate) fn append(&mut self, sequence: u64, bytes: &[u8]) -> Result<(), SpoolError> {
    if sequence != self.next_sequence {
      return Err(SpoolError::Sequence);
    }
    if bytes.is_empty() || bytes.len() > MAX_CHUNK {
      return Err(SpoolError::InvalidSize);
    }
    if self.written + bytes.len() as u64 > self.declared {
      return Err(SpoolError::Overflow);
    }
    self.file.write_all(bytes).map_err(|_| SpoolError::Io)?;
    self.hasher.update(bytes);
    self.written += bytes.len() as u64;
    self.next_sequence += 1;
    Ok(())
  }

  pub(crate) fn finish(self, total: u64) -> Result<SpoolDone, SpoolError> {
    if self.written != total || total != self.declared {
      return Err(SpoolError::Incomplete);
    }
    self.file.sync_all().map_err(|_| SpoolError::Io)?;
    drop(self.file);
    fs::rename(&self.part, &self.done).map_err(|_| SpoolError::Io)?;
    Ok(SpoolDone {
      name: format!("{}.done", self.name),
      bytes: total,
      sha256: hex(&self.hasher.finalize()),
    })
  }
}

fn hex(bytes: &[u8]) -> String {
  bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn hash_prefix(file: &mut File, length: u64, hasher: &mut Sha256) -> Result<(), SpoolError> {
  file.seek(SeekFrom::Start(0)).map_err(|_| SpoolError::Io)?;
  let mut buffer = vec![0u8; 1 << 20];
  let mut remaining = length;
  while remaining > 0 {
    let take = remaining.min(buffer.len() as u64) as usize;
    file.read_exact(&mut buffer[..take]).map_err(|_| SpoolError::Io)?;
    hasher.update(&buffer[..take]);
    remaining -= take as u64;
  }
  Ok(())
}

// A fresh start of a key drops files of the same key left for other remote file versions
fn remove_versions(directory: &Path, key: &str) {
  let Ok(entries) = fs::read_dir(directory) else {
    return;
  };
  for entry in entries.flatten() {
    let name = entry.file_name();
    let Some(name) = name.to_str() else {
      continue;
    };
    if name.starts_with(&format!("{key}.")) && (name.ends_with(".part") || name.ends_with(".done")) && is_plain(&entry.path(), false) {
      let _ = fs::remove_file(entry.path());
    }
  }
}

// Spool files nobody promoted for `STALE_AFTER` are removed; only plain files with the spool naming are touched
pub(crate) fn prune(state_root: &Path, now: SystemTime) -> usize {
  let directory = spool_directory(state_root);
  if !is_plain(&directory, true) {
    return 0;
  }
  let Ok(entries) = fs::read_dir(&directory) else {
    return 0;
  };
  let mut removed = 0;
  for entry in entries.flatten() {
    let path = entry.path();
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
      continue;
    };
    let stem = name.strip_suffix(".part").or_else(|| name.strip_suffix(".done"));
    let Some((key, fingerprint)) = stem.and_then(|stem| stem.split_once('.')) else {
      continue;
    };
    if !valid_key(key) || !valid_fingerprint(fingerprint) || !is_plain(&path, false) {
      continue;
    }
    let old = fs::metadata(&path)
      .and_then(|meta| meta.modified())
      .is_ok_and(|modified| now.duration_since(modified).is_ok_and(|age| age >= STALE_AFTER));
    if old && fs::remove_file(&path).is_ok() {
      removed += 1;
    }
  }
  removed
}

#[cfg(windows)]
pub(crate) fn free_space(path: &Path) -> Option<u64> {
  use std::os::windows::ffi::OsStrExt;
  #[link(name = "kernel32")]
  unsafe extern "system" {
    fn GetDiskFreeSpaceExW(
      directory: *const u16,
      available: *mut u64,
      total: *mut u64,
      free: *mut u64,
    ) -> i32;
  }
  let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
  let (mut available, mut total, mut free) = (0u64, 0u64, 0u64);
  // SAFETY: the buffer is NUL-terminated and the three outputs are valid for writes for the call.
  let ok = unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), &mut available, &mut total, &mut free) };
  (ok != 0).then_some(available)
}

#[cfg(not(windows))]
pub(crate) fn free_space(_path: &Path) -> Option<u64> {
  None
}

#[cfg(test)]
mod tests {
  use super::*;

  const KEY: &str = "0123456789abcdef0123456789abcdef";
  const PRINT: &str = "fedcba9876543210";

  fn root() -> PathBuf {
    let base = std::env::var_os("EGOIST_RELAY_TEST_WORK")
      .or_else(|| std::env::var_os("EGOIST_RELAY_AUDIT_WORK"))
      .map(PathBuf::from)
      .expect("Native file tests require EGOIST_RELAY_TEST_WORK or EGOIST_RELAY_AUDIT_WORK");
    let root = base.join(format!("spool-test-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&root).unwrap();
    root
  }
  fn roomy(_: &Path) -> Option<u64> {
    Some(u64::MAX)
  }
  fn data(length: usize) -> Vec<u8> {
    (0..length).map(|index| (index * 31 % 251) as u8).collect()
  }
  fn sha(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
  }

  #[test]
  fn sha256_matches_the_published_test_vector() {
    assert_eq!(
      sha(b"abc"),
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  }

  #[test]
  fn full_write_publishes_done_file_with_exact_bytes_and_hash() {
    let root = root();
    let bytes = data(2 * ALIGN as usize + 12345);
    let mut writer =
      SpoolWriter::open(&root, KEY, PRINT, bytes.len() as u64, 0, &roomy).unwrap();
    for (sequence, piece) in bytes.chunks(ALIGN as usize).enumerate() {
      writer.append(sequence as u64, piece).unwrap();
    }
    let done = writer.finish(bytes.len() as u64).unwrap();
    assert_eq!(done.name, format!("{KEY}.{PRINT}.done"));
    assert_eq!(done.bytes, bytes.len() as u64);
    assert_eq!(done.sha256, sha(&bytes));
    let stored = fs::read(spool_directory(&root).join(&done.name)).unwrap();
    assert_eq!(stored, bytes);
    assert!(!spool_directory(&root).join(format!("{KEY}.{PRINT}.part")).exists());
  }

  #[test]
  fn interrupted_download_resumes_from_the_aligned_offset_with_the_same_hash() {
    let root = root();
    let bytes = data(3 * ALIGN as usize + 777);
    let total = bytes.len() as u64;
    let mut first = SpoolWriter::open(&root, KEY, PRINT, total, 0, &roomy).unwrap();
    first.append(0, &bytes[..ALIGN as usize]).unwrap();
    first.append(1, &bytes[ALIGN as usize..2 * ALIGN as usize]).unwrap();
    // The break leaves 100 bytes of a third piece behind the aligned point
    first.append(2, &bytes[2 * ALIGN as usize..2 * ALIGN as usize + 100]).unwrap();
    drop(first);
    let mut second = SpoolWriter::open(&root, KEY, PRINT, total, 2 * ALIGN, &roomy).unwrap();
    assert_eq!(second.written(), 2 * ALIGN);
    second.append(0, &bytes[2 * ALIGN as usize..3 * ALIGN as usize]).unwrap();
    second.append(1, &bytes[3 * ALIGN as usize..]).unwrap();
    let done = second.finish(total).unwrap();
    assert_eq!(done.sha256, sha(&bytes));
    assert_eq!(fs::read(spool_directory(&root).join(done.name)).unwrap(), bytes);
  }

  #[test]
  fn resume_needs_the_same_remote_file_and_enough_bytes() {
    let root = root();
    let bytes = data(2 * ALIGN as usize + 5);
    let total = bytes.len() as u64;
    let mut first = SpoolWriter::open(&root, KEY, PRINT, total, 0, &roomy).unwrap();
    first.append(0, &bytes[..ALIGN as usize]).unwrap();
    drop(first);
    // Another fingerprint has no part file
    assert!(matches!(
      SpoolWriter::open(&root, KEY, "0000000000000000", total, ALIGN, &roomy),
      Err(SpoolError::ResumeMismatch)
    ));
    // The part is shorter than the requested offset
    assert!(matches!(
      SpoolWriter::open(&root, KEY, PRINT, total, 2 * ALIGN, &roomy),
      Err(SpoolError::ResumeMismatch)
    ));
    // A resume to a point beyond the declared size is not an offset at all
    assert!(matches!(
      SpoolWriter::open(&root, KEY, PRINT, total, 3 * ALIGN, &roomy),
      Err(SpoolError::InvalidOffset)
    ));
    assert!(matches!(
      SpoolWriter::open(&root, KEY, PRINT, total, 4096, &roomy),
      Err(SpoolError::InvalidOffset)
    ));
  }

  #[test]
  fn names_come_only_from_validated_hex_and_cannot_leave_the_directory() {
    let root = root();
    for key in ["../escape", "0123456789ABCDEF0123456789ABCDEF", "short", "0123456789abcdef0123456789abcde/"] {
      assert!(matches!(
        SpoolWriter::open(&root, key, PRINT, 10, 0, &roomy),
        Err(SpoolError::InvalidKey)
      ));
    }
    assert!(matches!(
      SpoolWriter::open(&root, KEY, "..\\..\\x", 10, 0, &roomy),
      Err(SpoolError::InvalidFingerprint)
    ));
    assert!(!valid_key(""));
  }

  #[test]
  fn sequence_size_and_declared_length_are_enforced() {
    let root = root();
    let mut writer = SpoolWriter::open(&root, KEY, PRINT, 10, 0, &roomy).unwrap();
    assert!(matches!(writer.append(1, b"abc"), Err(SpoolError::Sequence)));
    assert!(matches!(writer.append(0, b""), Err(SpoolError::InvalidSize)));
    writer.append(0, b"abcdef").unwrap();
    assert!(matches!(writer.append(0, b"x"), Err(SpoolError::Sequence)));
    assert!(matches!(writer.append(1, b"abcde"), Err(SpoolError::Overflow)));
    assert!(matches!(writer.finish(6), Err(SpoolError::Incomplete)));
  }

  #[test]
  fn low_disk_space_and_oversized_files_are_refused_before_any_write() {
    let root = root();
    let tight = |_: &Path| Some(DISK_RESERVE + 99);
    assert!(matches!(
      SpoolWriter::open(&root, KEY, PRINT, 100, 0, &tight),
      Err(SpoolError::DiskReserve)
    ));
    assert!(SpoolWriter::open(&root, KEY, PRINT, 99, 0, &tight).is_ok());
    assert!(matches!(
      SpoolWriter::open(&root, KEY, PRINT, MAX_FILE + 1, 0, &roomy),
      Err(SpoolError::InvalidSize)
    ));
    assert!(matches!(
      SpoolWriter::open(&root, KEY, PRINT, 0, 0, &roomy),
      Err(SpoolError::InvalidSize)
    ));
    assert_eq!(SpoolError::DiskReserve.code(), "DISK_RESERVE");
  }

  #[test]
  fn fresh_start_removes_other_versions_of_the_same_key_only() {
    let root = root();
    let directory = ensure_directory(&root).unwrap();
    let other_version = directory.join(format!("{KEY}.1111111111111111.part"));
    let other_key = directory.join("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.1111111111111111.part");
    fs::write(&other_version, b"old").unwrap();
    fs::write(&other_key, b"keep").unwrap();
    SpoolWriter::open(&root, KEY, PRINT, 10, 0, &roomy).unwrap();
    assert!(!other_version.exists());
    assert!(other_key.exists());
  }

  #[test]
  fn prune_removes_only_stale_files_with_spool_names() {
    let root = root();
    let directory = ensure_directory(&root).unwrap();
    let stale = directory.join(format!("{KEY}.{PRINT}.done"));
    let foreign = directory.join("notes.txt");
    fs::write(&stale, b"x").unwrap();
    fs::write(&foreign, b"x").unwrap();
    assert_eq!(prune(&root, SystemTime::now()), 0);
    assert_eq!(prune(&root, SystemTime::now() + STALE_AFTER + Duration::from_secs(5)), 1);
    assert!(!stale.exists());
    assert!(foreign.exists());
  }

  #[test]
  fn a_file_in_place_of_the_state_root_is_unsafe() {
    let root = root();
    let file = root.join("not-a-directory");
    fs::write(&file, b"x").unwrap();
    assert!(matches!(
      SpoolWriter::open(&file, KEY, PRINT, 10, 0, &roomy),
      Err(SpoolError::Unsafe)
    ));
  }

  // Heavy check, run by hand: cargo test --lib large_file -- --ignored --nocapture
  #[test]
  #[ignore]
  fn large_file_cut_in_the_middle_resumes_with_the_hash_of_one_uninterrupted_write() {
    let root = root();
    let total: u64 = 520 * ALIGN;
    let piece = |index: u64| -> Vec<u8> {
      let mut state = index.wrapping_mul(0x9E37_79B9_7F4A_7C15).wrapping_add(1);
      (0..ALIGN as usize)
        .map(|_| {
          state ^= state << 13;
          state ^= state >> 7;
          state ^= state << 17;
          (state >> 24) as u8
        })
        .collect()
    };
    let mut reference = Sha256::new();
    (0..520).for_each(|index| reference.update(piece(index)));
    let reference = hex(&reference.finalize());
    let started = std::time::Instant::now();
    let mut first = SpoolWriter::open(&root, KEY, PRINT, total, 0, &roomy).unwrap();
    for index in 0..300 {
      first.append(index, &piece(index)).unwrap();
    }
    // The cut: 123 bytes of the next piece reach the disk, then the process is gone
    first.append(300, &piece(300)[..123]).unwrap();
    drop(first);
    let mut second = SpoolWriter::open(&root, KEY, PRINT, total, 300 * ALIGN, &roomy).unwrap();
    for index in 300..520 {
      second.append(index - 300, &piece(index)).unwrap();
    }
    let done = second.finish(total).unwrap();
    let seconds = started.elapsed().as_secs_f64();
    println!("SPOOL_FILE={}", spool_directory(&root).join(&done.name).display());
    println!("SPOOL_SHA256={}", done.sha256);
    println!("REFERENCE_SHA256={reference}");
    println!("SPOOL_SECONDS={seconds:.2} MIB_PER_SECOND={:.1}", 520.0 / seconds);
    assert_eq!(done.sha256, reference);
    assert_eq!(done.bytes, total);
  }
}
