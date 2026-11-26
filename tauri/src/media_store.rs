use std::{
  fs::{self, File, OpenOptions},
  io::{ErrorKind, Read, Write},
  path::Path,
};

use serde::{Serialize, de::DeserializeOwned};

use crate::media_operations::{ensure_private_directory, replace_atomically};

const MAX_BYTES: usize = 7 * 1024 * 1024;
const MAX_ENCRYPTED_BYTES: usize = MAX_BYTES + 64 * 1024;

pub(crate) fn read<T: DeserializeOwned>(
  directory: &Path,
  name: &str,
  entropy: &[u8],
) -> Result<Option<T>, &'static str> {
  ensure_private_directory(directory).map_err(|_| "MEDIA_STORE_UNAVAILABLE")?;
  let path = directory.join(name);
  if !check_store_file(&path)? {
    return Ok(None);
  }
  let mut encrypted = Vec::new();
  File::open(&path)
    .map_err(|_| "MEDIA_STORE_UNAVAILABLE")?
    .take((MAX_ENCRYPTED_BYTES + 1) as u64)
    .read_to_end(&mut encrypted)
    .map_err(|_| "MEDIA_STORE_UNAVAILABLE")?;
  if encrypted.len() > MAX_ENCRYPTED_BYTES {
    return Err("MEDIA_STORE_CORRUPT");
  }
  let mut plain =
    crate::dpapi::unprotect_with_entropy(&encrypted, entropy).map_err(|_| "MEDIA_STORE_CORRUPT")?;
  let result = if plain.len() > MAX_BYTES {
    Err("MEDIA_STORE_CORRUPT")
  } else {
    serde_json::from_slice(&plain)
      .map(Some)
      .map_err(|_| "MEDIA_STORE_CORRUPT")
  };
  plain.fill(0);
  result
}

pub(crate) fn write<T: Serialize>(
  directory: &Path,
  name: &str,
  entropy: &[u8],
  value: &T,
) -> Result<(), &'static str> {
  ensure_private_directory(directory).map_err(|_| "MEDIA_STORE_UNAVAILABLE")?;
  let target = directory.join(name);
  check_store_file(&target)?;
  let mut plain = serde_json::to_vec(value).map_err(|_| "MEDIA_STORE_WRITE_FAILED")?;
  let encrypted = if plain.len() <= MAX_BYTES {
    crate::dpapi::protect_with_entropy(&plain, entropy).map_err(|_| "MEDIA_STORE_WRITE_FAILED")
  } else {
    Err("MEDIA_STORE_FULL")
  };
  plain.fill(0);
  let encrypted = encrypted?;
  if encrypted.len() > MAX_ENCRYPTED_BYTES {
    return Err("MEDIA_STORE_FULL");
  }

  let temporary = directory.join(format!("{name}-{}.part", uuid::Uuid::new_v4()));
  let result = (|| {
    let mut file = OpenOptions::new()
      .write(true)
      .create_new(true)
      .open(&temporary)
      .map_err(|_| "MEDIA_STORE_WRITE_FAILED")?;
    file
      .write_all(&encrypted)
      .and_then(|_| file.sync_all())
      .map_err(|_| "MEDIA_STORE_WRITE_FAILED")?;
    drop(file);
    replace_atomically(&temporary, &target).map_err(|_| "MEDIA_STORE_WRITE_FAILED")
  })();
  if result.is_err() {
    let _ = fs::remove_file(&temporary);
  }
  result
}

fn check_store_file(path: &Path) -> Result<bool, &'static str> {
  let metadata = match fs::symlink_metadata(path) {
    Ok(metadata) => metadata,
    Err(error) if error.kind() == ErrorKind::NotFound => return Ok(false),
    Err(_) => return Err("MEDIA_STORE_UNAVAILABLE"),
  };
  #[cfg(windows)]
  {
    use std::os::windows::fs::MetadataExt;
    if metadata.file_attributes() & 0x400 != 0 {
      return Err("MEDIA_STORE_CORRUPT");
    }
  }
  if !metadata.is_file() || metadata.file_type().is_symlink() {
    return Err("MEDIA_STORE_CORRUPT");
  }
  Ok(true)
}
