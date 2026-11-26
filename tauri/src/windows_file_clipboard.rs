use std::ffi::c_void;
use std::os::windows::ffi::OsStrExt;
use std::path::{Component, Path, Prefix};
use std::ptr;

const CF_HDROP: u32 = 15;
const GMEM_MOVEABLE: u32 = 0x0002;
const DROPFILES_BYTES: usize = 20;
const WIDE_FLAG_OFFSET: usize = 16;

#[link(name = "user32")]
unsafe extern "system" {
  fn OpenClipboard(owner: *mut c_void) -> i32;
  fn CloseClipboard() -> i32;
  fn EmptyClipboard() -> i32;
  fn SetClipboardData(format: u32, memory: *mut c_void) -> *mut c_void;
}

#[link(name = "kernel32")]
unsafe extern "system" {
  fn GlobalAlloc(flags: u32, bytes: usize) -> *mut c_void;
  fn GlobalLock(memory: *mut c_void) -> *mut c_void;
  fn GlobalUnlock(memory: *mut c_void) -> i32;
  fn GlobalFree(memory: *mut c_void) -> *mut c_void;
}

struct ClipboardMemory(*mut c_void);

impl Drop for ClipboardMemory {
  fn drop(&mut self) {
    unsafe { GlobalFree(self.0); }
  }
}

struct OpenedClipboard;

impl Drop for OpenedClipboard {
  fn drop(&mut self) {
    unsafe { CloseClipboard(); }
  }
}

fn file_drop(path: &Path) -> Result<Vec<u8>, &'static str> {
  let mut name: Vec<u16> = path.as_os_str().encode_wide().collect();
  if !path.is_absolute() || name.contains(&0) {
    return Err("MEDIA_FILE_MISSING");
  }
  // Короткие пути отдаём в форме, которую одинаково читают Проводник и обычные приложения.
  if name.len() < 260 && let Some(Component::Prefix(prefix)) = path.components().next() {
    match prefix.kind() {
      Prefix::VerbatimDisk(_) => { name.drain(..4); }
      Prefix::VerbatimUNC(_, _) => { name.drain(2..8); }
      _ => {}
    }
  }

  let mut data = vec![0; DROPFILES_BYTES];
  data[..4].copy_from_slice(&(DROPFILES_BYTES as u32).to_le_bytes());
  data[WIDE_FLAG_OFFSET..DROPFILES_BYTES].copy_from_slice(&1u32.to_le_bytes());
  data.extend(name.into_iter().chain([0, 0]).flat_map(u16::to_le_bytes));
  Ok(data)
}

pub(crate) fn copy_file(owner: *mut c_void, path: &Path) -> Result<(), &'static str> {
  if owner.is_null() { return Err("MEDIA_CLIPBOARD_UNAVAILABLE"); }
  let data = file_drop(path)?;
  let handle = unsafe { GlobalAlloc(GMEM_MOVEABLE, data.len()) };
  if handle.is_null() { return Err("MEDIA_CLIPBOARD_UNAVAILABLE"); }
  let memory = ClipboardMemory(handle);
  let target = unsafe { GlobalLock(memory.0) };
  if target.is_null() { return Err("MEDIA_CLIPBOARD_UNAVAILABLE"); }
  // Буфер выделен в размере data и остаётся заблокированным до конца копирования.
  unsafe {
    ptr::copy_nonoverlapping(data.as_ptr(), target.cast::<u8>(), data.len());
    GlobalUnlock(memory.0);
  }

  if unsafe { OpenClipboard(owner) } == 0 { return Err("MEDIA_CLIPBOARD_BUSY"); }
  let _clipboard = OpenedClipboard;
  if unsafe { EmptyClipboard() } == 0
    || unsafe { SetClipboardData(CF_HDROP, memory.0) }.is_null()
  {
    return Err("MEDIA_CLIPBOARD_UNAVAILABLE");
  }
  // После успешного SetClipboardData блок принадлежит Windows.
  std::mem::forget(memory);
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::path::Path;

  #[test]
  fn encodes_unicode_file_drop_for_explorer() {
    let drop = file_drop(Path::new(r"\\?\C:\Материалы\Клип 🎞.mp4")).unwrap();
    assert_eq!(&drop[..4], &20u32.to_le_bytes());
    assert_eq!(&drop[16..20], &1u32.to_le_bytes());
    assert_eq!(&drop[drop.len() - 4..], &[0, 0, 0, 0]);
    let name = drop[20..drop.len() - 4].chunks_exact(2)
      .map(|unit| u16::from_le_bytes([unit[0], unit[1]])).collect::<Vec<_>>();
    assert_eq!(String::from_utf16(&name).unwrap(), r"C:\Материалы\Клип 🎞.mp4");
  }

  #[test]
  fn rejects_relative_path_and_embedded_null() {
    assert!(file_drop(Path::new(r"dir\clip.mp4")).is_err());
    assert!(file_drop(Path::new("C:\\dir\\clip\0.mp4")).is_err());
  }
}
