use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::{Arc, LazyLock, Mutex, Once, atomic::{AtomicBool, Ordering}};
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};
use tauri::{AppHandle, Webview};

use crate::inline_media::{FileResult, OwnedDirectory};

const MAX_CHUNK_BYTES: usize = 1024 * 1024;
const MAX_STAGED_FILES: usize = 16;
const IDLE_TTL: Duration = Duration::from_secs(10 * 60);
const MAX_AGE: Duration = Duration::from_secs(4 * 60 * 60);
const DISK_RESERVE: u64 = 64 * 1024 * 1024;
const CLEANUP_INTERVAL: Duration = Duration::from_secs(60);

static REGISTRY: LazyLock<Mutex<StageRegistry>> = LazyLock::new(|| Mutex::new(StageRegistry::default()));
static CLEANER: Once = Once::new();
static STOPPING: AtomicBool = AtomicBool::new(false);

pub(crate) struct StageSource {
  pub(crate) directory: OwnedDirectory,
  pub(crate) file: FileResult,
  pub(crate) cancel: Arc<AtomicBool>,
  pub(crate) deadline: Instant,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StagedFileDescriptor {
  handle: String,
  file_name: String,
  mime_type: String,
  size: u64,
  sha256: String,
}

struct StagedFileData {
  file: File,
  // Дескриптор файла закрывается перед удалением принадлежащего операции каталога
  _directory: OwnedDirectory,
}

struct StagedFile {
  request_id: String,
  size: u64,
  cancel: Arc<AtomicBool>,
  created_at: Instant,
  touched_at: Mutex<Instant>,
  data: Mutex<StagedFileData>,
}

#[derive(Default)]
struct StageRegistry {
  files: HashMap<String, Arc<StagedFile>>,
  reservations: HashMap<String, String>,
}

struct StageReservation(String);

impl Drop for StageReservation {
  fn drop(&mut self) {
    if let Ok(mut registry) = REGISTRY.lock() { registry.reservations.remove(&self.0); }
  }
}

#[tauri::command]
pub async fn relay_social_stage_file(
  webview: Webview,
  app_handle: AppHandle,
  request_id: String,
  index: usize,
  maximum_bytes: u64,
) -> Result<StagedFileDescriptor, String> {
  crate::social_share::require_main(&webview)?;
  validate_id(&request_id)?;
  let maximum = validate_maximum(maximum_bytes)?;
  if index >= 10 || STOPPING.load(Ordering::Acquire) { return Err("MEDIA_INPUT_DENIED".into()); }
  start_cleaner();
  tauri::async_runtime::spawn_blocking(move || {
    cleanup_expired();
    let reservation = {
      let mut registry = REGISTRY.lock().map_err(|_| "MEDIA_UNAVAILABLE")?;
      StageReservation(registry.reserve(&request_id)?)
    };
    let source = crate::social_share::stage_confirmed_media_file(&app_handle, &request_id, index, maximum)?;
    let (file, descriptor) = prepare_staged_file(&request_id, reservation.0.clone(), source)?;
    crate::media_operations::authorize_social_stage(&app_handle, &request_id)?;
    if file.cancel.load(Ordering::Acquire) || STOPPING.load(Ordering::Acquire) { return Err("MEDIA_CANCELLED".into()); }
    let mut registry = REGISTRY.lock().map_err(|_| "MEDIA_UNAVAILABLE")?;
    registry.reservations.remove(&reservation.0);
    registry.files.insert(reservation.0.clone(), Arc::new(file));
    Ok(descriptor)
  }).await.map_err(|_| "MEDIA_FETCH_FAILED".to_string())?
}

#[tauri::command]
pub async fn relay_social_read_staged_chunk(
  webview: Webview,
  app_handle: AppHandle,
  handle: String,
  offset: u64,
  length: usize,
) -> Result<tauri::ipc::Response, String> {
  crate::social_share::require_main(&webview)?;
  validate_id(&handle)?;
  if length == 0 || length > MAX_CHUNK_BYTES { return Err("MEDIA_INPUT_DENIED".into()); }
  tauri::async_runtime::spawn_blocking(move || {
    cleanup_expired();
    let file = REGISTRY.lock().map_err(|_| "MEDIA_UNAVAILABLE")?.files.get(&handle).cloned().ok_or("MEDIA_UNAVAILABLE")?;
    crate::media_operations::authorize_social_stage(&app_handle, &file.request_id)?;
    let bytes = file.read_chunk(offset, length, Instant::now())?;
    Ok(tauri::ipc::Response::new(bytes))
  }).await.map_err(|_| "MEDIA_FETCH_FAILED".to_string())?
}

#[tauri::command]
pub async fn relay_social_release_staged_file(webview: Webview, handle: String) -> Result<(), String> {
  crate::social_share::require_main(&webview)?;
  validate_id(&handle)?;
  tauri::async_runtime::spawn_blocking(move || {
    let removed = REGISTRY.lock().map_err(|_| "MEDIA_UNAVAILABLE")?.files.remove(&handle);
    drop(removed);
    Ok(())
  }).await.map_err(|_| "MEDIA_FETCH_FAILED".to_string())?
}

fn validate_id(value: &str) -> Result<(), String> {
  if value.len() != 36 || uuid::Uuid::parse_str(value).is_err() { return Err("MEDIA_INPUT_DENIED".into()); }
  Ok(())
}

fn validate_maximum(value: u64) -> Result<usize, String> {
  if value == 0 || value > crate::inline_media::MAX_SAVED_FILE_BYTES as u64 { return Err("MEDIA_INPUT_DENIED".into()); }
  usize::try_from(value).map_err(|_| "MEDIA_INPUT_DENIED".into())
}

fn prepare_staged_file(request_id: &str, handle: String, source: StageSource) -> Result<(StagedFile, StagedFileDescriptor), String> {
  let StageSource { directory, file: result, cancel, deadline } = source;
  if crate::research_spool::free_space(directory.worker_directory())
    .is_some_and(|free| free < result.metadata.size.saturating_add(DISK_RESERVE))
  {
    return Err("MEDIA_DISK_FULL".into());
  }
  let mut file = open_staged_file(&result.file_path, result.metadata.size)?;
  let sha256 = hash_file(&mut file, result.metadata.size, &cancel, deadline)?;
  let now = Instant::now();
  let descriptor = StagedFileDescriptor {
    handle,
    file_name: result.metadata.name,
    mime_type: result.metadata.mime_type,
    size: result.metadata.size,
    sha256,
  };
  Ok((StagedFile {
    request_id: request_id.to_string(),
    size: descriptor.size,
    cancel,
    created_at: now,
    touched_at: Mutex::new(now),
    data: Mutex::new(StagedFileData { file, _directory: directory }),
  }, descriptor))
}

fn open_staged_file(path: &Path, expected_size: u64) -> Result<File, String> {
  let mut options = OpenOptions::new();
  options.read(true);
  #[cfg(windows)]
  {
    use std::os::windows::fs::OpenOptionsExt;
    options.share_mode(1).custom_flags(0x0020_0000); // FILE_SHARE_READ, FILE_FLAG_OPEN_REPARSE_POINT
  }
  let file = options.open(path).map_err(|_| "MEDIA_PATH_DENIED")?;
  let metadata = file.metadata().map_err(|_| "MEDIA_PARTIAL_BODY")?;
  if !metadata.is_file() || metadata.len() != expected_size || expected_size == 0 { return Err("MEDIA_PARTIAL_BODY".into()); }
  #[cfg(windows)]
  {
    use std::os::windows::fs::MetadataExt;
    if metadata.file_attributes() & 0x400 != 0 { return Err("MEDIA_PATH_DENIED".into()); }
  }
  Ok(file)
}

fn hash_file(file: &mut File, size: u64, cancel: &AtomicBool, deadline: Instant) -> Result<String, String> {
  let mut hasher = Sha256::new();
  let mut buffer = vec![0; MAX_CHUNK_BYTES];
  let mut total = 0_u64;
  loop {
    if cancel.load(Ordering::Acquire) || STOPPING.load(Ordering::Acquire) { return Err("MEDIA_CANCELLED".into()); }
    if Instant::now() >= deadline { return Err("MEDIA_TIMEOUT".into()); }
    let length = file.read(&mut buffer).map_err(|_| "MEDIA_PARTIAL_BODY")?;
    if length == 0 { break; }
    total = total.checked_add(length as u64).ok_or("MEDIA_TOO_LARGE")?;
    if total > size { return Err("MEDIA_PARTIAL_BODY".into()); }
    hasher.update(&buffer[..length]);
  }
  if total != size { return Err("MEDIA_PARTIAL_BODY".into()); }
  Ok(format!("{:x}", hasher.finalize()))
}

impl StageRegistry {
  fn reserve(&mut self, request_id: &str) -> Result<String, String> {
    if self.files.len() + self.reservations.len() >= MAX_STAGED_FILES { return Err("MEDIA_QUEUE_FULL".into()); }
    let handle = uuid::Uuid::new_v4().to_string();
    self.reservations.insert(handle.clone(), request_id.to_string());
    Ok(handle)
  }

  fn take_expired(&mut self, now: Instant) -> Vec<Arc<StagedFile>> {
    let handles: Vec<_> = self.files.iter().filter(|(_, file)| file.is_expired(now) || file.cancel.load(Ordering::Acquire))
      .map(|(handle, _)| handle.clone()).collect();
    handles.into_iter().filter_map(|handle| self.files.remove(&handle)).collect()
  }

  fn take_request(&mut self, request_id: &str) -> Vec<Arc<StagedFile>> {
    let handles: Vec<_> = self.files.iter().filter(|(_, file)| file.request_id == request_id)
      .map(|(handle, _)| handle.clone()).collect();
    handles.into_iter().filter_map(|handle| self.files.remove(&handle)).collect()
  }
}

impl StagedFile {
  fn is_expired(&self, now: Instant) -> bool {
    let touched = self.touched_at.lock().map(|touched| *touched).unwrap_or(self.created_at);
    now.saturating_duration_since(self.created_at) >= MAX_AGE || now.saturating_duration_since(touched) >= IDLE_TTL
  }

  fn read_chunk(&self, offset: u64, length: usize, now: Instant) -> Result<Vec<u8>, String> {
    if self.cancel.load(Ordering::Acquire) { return Err("MEDIA_CANCELLED".into()); }
    if self.is_expired(now) { return Err("MEDIA_UNAVAILABLE".into()); }
    if length == 0 || length > MAX_CHUNK_BYTES || offset.checked_add(length as u64).is_none_or(|end| end > self.size) {
      return Err("MEDIA_INPUT_DENIED".into());
    }
    *self.touched_at.lock().map_err(|_| "MEDIA_UNAVAILABLE")? = now;
    let mut data = self.data.lock().map_err(|_| "MEDIA_UNAVAILABLE")?;
    if data.file.metadata().map_err(|_| "MEDIA_PARTIAL_BODY")?.len() != self.size { return Err("MEDIA_PARTIAL_BODY".into()); }
    data.file.seek(SeekFrom::Start(offset)).map_err(|_| "MEDIA_PARTIAL_BODY")?;
    let mut bytes = vec![0; length];
    data.file.read_exact(&mut bytes).map_err(|_| "MEDIA_PARTIAL_BODY")?;
    if self.cancel.load(Ordering::Acquire) { return Err("MEDIA_CANCELLED".into()); }
    Ok(bytes)
  }
}

fn cleanup_expired() {
  let removed = REGISTRY.lock().map(|mut registry| registry.take_expired(Instant::now())).unwrap_or_default();
  drop(removed);
}

pub(crate) fn release_request(request_id: &str) {
  let removed = REGISTRY.lock().map(|mut registry| registry.take_request(request_id)).unwrap_or_default();
  tauri::async_runtime::spawn_blocking(move || drop(removed));
}

fn start_cleaner() {
  CLEANER.call_once(|| {
    tauri::async_runtime::spawn(async {
      while !STOPPING.load(Ordering::Acquire) {
        tokio::time::sleep(CLEANUP_INTERVAL).await;
        if STOPPING.load(Ordering::Acquire) { break; }
        let _ = tauri::async_runtime::spawn_blocking(cleanup_expired).await;
      }
    });
  });
}

pub(crate) fn shutdown() {
  STOPPING.store(true, Ordering::Release);
  let removed = REGISTRY.lock().map(|mut registry| std::mem::take(&mut registry.files)).unwrap_or_default();
  drop(removed);
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::fs;
  use std::io::Write;

  fn fixture(bytes: &[u8]) -> (tempfile::TempDir, Arc<StagedFile>, StagedFileDescriptor) {
    let root = tempfile::tempdir().unwrap();
    let directory = OwnedDirectory::create_in(root.path().join("owned")).unwrap();
    let path = directory.worker_directory().join("media.download");
    fs::write(&path, bytes).unwrap();
    let packet = serde_json::to_vec(&serde_json::json!({
      "filePath": path,
      "metadata": { "index": 0, "name": "relay-x-1.mp4", "mimeType": "video/mp4", "size": bytes.len() },
    })).unwrap();
    let result = crate::inline_media::validate_file_result(&directory, &packet, 0, crate::inline_media::MAX_SAVED_FILE_BYTES).unwrap();
    let source = StageSource { directory, file: result, cancel: Arc::new(AtomicBool::new(false)), deadline: Instant::now() + Duration::from_secs(30) };
    let (file, descriptor) = prepare_staged_file("confirmed-operation", uuid::Uuid::new_v4().to_string(), source).unwrap();
    (root, Arc::new(file), descriptor)
  }

  #[test]
  fn staged_chunks_preserve_exact_bytes_and_sha256_with_strict_ranges() {
    let bytes: Vec<_> = (0..MAX_CHUNK_BYTES + 19).map(|index| (index % 251) as u8).collect();
    let (_root, file, descriptor) = fixture(&bytes);
    assert_eq!(descriptor.sha256, format!("{:x}", Sha256::digest(&bytes)));
    assert_eq!(file.read_chunk(0, MAX_CHUNK_BYTES, Instant::now()).unwrap(), bytes[..MAX_CHUNK_BYTES]);
    assert_eq!(file.read_chunk(MAX_CHUNK_BYTES as u64, 19, Instant::now()).unwrap(), bytes[MAX_CHUNK_BYTES..]);
    for (offset, length) in [(0, 0), (0, MAX_CHUNK_BYTES + 1), (bytes.len() as u64, 1), (u64::MAX, 1)] {
      assert_eq!(file.read_chunk(offset, length, Instant::now()).unwrap_err(), "MEDIA_INPUT_DENIED");
    }
  }

  #[test]
  fn release_is_idempotent_and_owned_files_disappear_after_last_reader() {
    let (_root, file, descriptor) = fixture(b"owned-stage");
    let path = file.data.lock().unwrap()._directory.worker_directory().to_path_buf();
    let mut registry = StageRegistry::default();
    registry.files.insert(descriptor.handle.clone(), file.clone());
    drop(registry.files.remove(&descriptor.handle));
    assert!(registry.files.remove(&descriptor.handle).is_none());
    assert!(path.exists());
    drop(file);
    assert!(!path.exists());
  }

  #[test]
  fn canceled_and_expired_stages_are_reclaimed_and_reads_extend_idle_ttl() {
    let (_root, file, descriptor) = fixture(b"owned-stage");
    let now = file.created_at;
    let mut registry = StageRegistry::default();
    registry.files.insert(descriptor.handle.clone(), file.clone());
    file.read_chunk(0, 1, now + IDLE_TTL / 2).unwrap();
    assert!(registry.take_expired(now + IDLE_TTL).is_empty());
    assert_eq!(registry.take_expired(now + MAX_AGE).len(), 1);
    registry.files.insert(descriptor.handle.clone(), file.clone());
    file.cancel.store(true, Ordering::Release);
    assert_eq!(file.read_chunk(0, 1, now).unwrap_err(), "MEDIA_CANCELLED");
    assert_eq!(registry.take_expired(now).len(), 1);
  }

  #[test]
  fn reservations_enforce_the_bound_before_a_worker_starts() {
    let mut registry = StageRegistry::default();
    for _ in 0..MAX_STAGED_FILES { registry.reserve("owned-operation").unwrap(); }
    assert_eq!(registry.reserve("owned-operation").unwrap_err(), "MEDIA_QUEUE_FULL");
    let handle = registry.reservations.keys().next().unwrap().clone();
    registry.reservations.remove(&handle);
    registry.reserve("owned-operation").unwrap();
  }

  #[test]
  fn chunks_cannot_open_paths_and_file_sizes_remain_account_bounded() {
    for value in ["../../private", "C:\\private\\file", "", "bad-uuid"] { assert!(validate_id(value).is_err()); }
    assert_eq!(validate_maximum(65 * 1024 * 1024).unwrap(), 65 * 1024 * 1024);
    assert_eq!(validate_maximum(crate::inline_media::MAX_SAVED_FILE_BYTES as u64).unwrap(), crate::inline_media::MAX_SAVED_FILE_BYTES);
    assert!(validate_maximum(0).is_err());
    assert!(validate_maximum(crate::inline_media::MAX_SAVED_FILE_BYTES as u64 + 1).is_err());
  }

  #[test]
  fn a_file_above_the_ipc_media_limit_is_hashed_and_read_in_bounded_chunks() {
    let root = tempfile::tempdir().unwrap();
    let directory = OwnedDirectory::create_in(root.path().join("owned")).unwrap();
    let path = directory.worker_directory().join("media.download");
    let size = 65 * 1024 * 1024;
    File::create(&path).unwrap().set_len(size).unwrap();
    let packet = serde_json::to_vec(&serde_json::json!({
      "filePath": path,
      "metadata": { "index": 0, "name": "relay-x-1.mp4", "mimeType": "video/mp4", "size": size },
    })).unwrap();
    let result = crate::inline_media::validate_file_result(&directory, &packet, 0, size as usize).unwrap();
    let source = StageSource { directory, file: result, cancel: Arc::new(AtomicBool::new(false)), deadline: Instant::now() + Duration::from_secs(60) };
    let (file, descriptor) = prepare_staged_file("confirmed-operation", uuid::Uuid::new_v4().to_string(), source).unwrap();
    assert_eq!(descriptor.size, size);
    assert_eq!(descriptor.sha256.len(), 64);
    assert_eq!(file.read_chunk(size - MAX_CHUNK_BYTES as u64, MAX_CHUNK_BYTES, Instant::now()).unwrap(), vec![0; MAX_CHUNK_BYTES]);
  }

  #[test]
  fn hashing_detects_a_partial_file_and_respects_cancellation() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("owned.bin");
    File::create(&path).unwrap().write_all(b"owned-bytes").unwrap();
    let mut file = open_staged_file(&path, 11).unwrap();
    let cancel = AtomicBool::new(false);
    assert_eq!(hash_file(&mut file, 12, &cancel, Instant::now() + Duration::from_secs(1)).unwrap_err(), "MEDIA_PARTIAL_BODY");
    cancel.store(true, Ordering::Release);
    assert_eq!(hash_file(&mut file, 11, &cancel, Instant::now() + Duration::from_secs(1)).unwrap_err(), "MEDIA_CANCELLED");
  }
}
