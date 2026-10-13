//! Шифрование данных средствами Windows DPAPI (область «текущий пользователь», без entropy).
//!
//! Реализация скопирована из `media_operations.rs` (`windows_storage::protect`), чтобы туннелю не зависеть
//! от того модуля. Дубль будет убран отдельной правкой. Формат совместим с установщиком: `seed.dpapi` =
//! `CryptProtectData(текущий пользователь, без entropy)`.
#![allow(dead_code)] // Подключение к приложению — следующее задание.

/// Предельный размер входа и выхода: профиль сети — десятки килобайт, больше значит мусор.
const MAX_BYTES: usize = 8 * 1024 * 1024;

/// Шифрует байты для текущего пользователя Windows. Пустой вход не допускается.
pub(crate) fn protect(plain: &[u8]) -> Result<Vec<u8>, String> {
  imp::transform(plain, false)
}

/// Расшифровывает байты, зашифрованные [`protect`] тем же пользователем Windows.
pub(crate) fn unprotect(encrypted: &[u8]) -> Result<Vec<u8>, String> {
  imp::transform(encrypted, true)
}

#[cfg(windows)]
mod imp {
  use super::MAX_BYTES;
  use std::{ffi::c_void, ptr};

  #[repr(C)]
  struct DataBlob {
    length: u32,
    data: *mut u8,
  }

  #[link(name = "Crypt32")]
  unsafe extern "system" {
    fn CryptProtectData(
      input: *const DataBlob,
      description: *const u16,
      entropy: *const DataBlob,
      reserved: *const c_void,
      prompt: *const c_void,
      flags: u32,
      output: *mut DataBlob,
    ) -> i32;
    fn CryptUnprotectData(
      input: *const DataBlob,
      description: *mut *mut u16,
      entropy: *const DataBlob,
      reserved: *const c_void,
      prompt: *const c_void,
      flags: u32,
      output: *mut DataBlob,
    ) -> i32;
  }
  #[link(name = "Kernel32")]
  unsafe extern "system" {
    fn LocalFree(value: *mut c_void) -> *mut c_void;
  }

  /// CRYPTPROTECT_UI_FORBIDDEN: без диалогов.
  const UI_FORBIDDEN: u32 = 1;

  pub(super) fn transform(value: &[u8], decrypt: bool) -> Result<Vec<u8>, String> {
    if value.is_empty() || value.len() > MAX_BYTES || value.len() > u32::MAX as usize {
      return Err("DPAPI_INPUT_INVALID".into());
    }
    let input = DataBlob { length: value.len() as u32, data: value.as_ptr().cast_mut() };
    let mut output = DataBlob { length: 0, data: ptr::null_mut() };
    // Область по умолчанию — текущий пользователь; UI_FORBIDDEN исключает диалоги
    let success = unsafe {
      if decrypt {
        CryptUnprotectData(&input, ptr::null_mut(), ptr::null(), ptr::null(), ptr::null(), UI_FORBIDDEN, &mut output)
      } else {
        CryptProtectData(&input, ptr::null(), ptr::null(), ptr::null(), ptr::null(), UI_FORBIDDEN, &mut output)
      }
    };
    if success == 0 {
      if !output.data.is_null() {
        unsafe { LocalFree(output.data.cast()); }
      }
      return Err(if decrypt { "DPAPI_DECRYPT_FAILED" } else { "DPAPI_PROTECT_FAILED" }.into());
    }
    if output.data.is_null() || output.length as usize > MAX_BYTES {
      if !output.data.is_null() {
        unsafe { LocalFree(output.data.cast()); }
      }
      return Err("DPAPI_OUTPUT_INVALID".into());
    }
    let bytes = unsafe { std::slice::from_raw_parts(output.data, output.length as usize).to_vec() };
    unsafe { LocalFree(output.data.cast()); }
    Ok(bytes)
  }
}

#[cfg(not(windows))]
mod imp {
  pub(super) fn transform(_value: &[u8], _decrypt: bool) -> Result<Vec<u8>, String> {
    Err("DPAPI_WINDOWS_REQUIRED".into())
  }
}

#[cfg(all(test, windows))]
mod tests {
  use super::*;

  #[test]
  fn round_trip_is_encrypted() {
    let plain = b"{\"schema\":1,\"vpn\":\"vless://00000000-0000-0000-0000-000000000000@example.com:443\"}";
    let encrypted = protect(plain).expect("protect");
    assert_ne!(encrypted.as_slice(), plain.as_slice());
    assert!(!encrypted.windows(7).any(|window| window == b"example"));
    assert_eq!(unprotect(&encrypted).expect("unprotect"), plain);
  }

  #[test]
  fn rejects_empty_and_garbage() {
    assert!(protect(&[]).is_err());
    assert!(unprotect(&[]).is_err());
    assert!(unprotect(b"not a dpapi blob at all").is_err());
  }

  #[test]
  fn corrupted_blob_fails_integrity_check() {
    let mut encrypted = protect(b"secret payload").expect("protect");
    let last = encrypted.len() - 1;
    encrypted[last] ^= 0xFF;
    assert!(unprotect(&encrypted).is_err());
  }
}
