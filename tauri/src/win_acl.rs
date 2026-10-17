//! Общие вызовы Windows для защищённых каталогов: DACL только у текущего пользователя и SYSTEM.
//! Нужны журналу медиа (`media_operations`) и IPC-каталогу туннеля (`tunnel`, сокет API Xray).

use std::{
  ffi::c_void,
  fs,
  os::windows::{ffi::OsStrExt, fs::MetadataExt},
  path::Path,
  ptr,
};

/// Причина отказа; вызывающий сопоставляет её со своим кодом ошибки.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AclError {
  /// Путь содержит NUL.
  InputDenied,
  /// Каталог не создан или это не обычный каталог (ссылка, файл).
  Unavailable,
  /// Не удалось получить SID или выставить DACL.
  AclFailed,
}

#[repr(C)]
struct SecurityAttributes {
  length: u32,
  descriptor: *mut c_void,
  inherit: i32,
}
#[repr(C)]
struct SidAndAttributes {
  sid: *mut c_void,
  attributes: u32,
}
#[repr(C)]
struct TokenUser {
  user: SidAndAttributes,
}

#[link(name = "Advapi32")]
unsafe extern "system" {
  fn OpenProcessToken(process: *mut c_void, access: u32, token: *mut *mut c_void) -> i32;
  fn GetTokenInformation(
    token: *mut c_void,
    class: u32,
    information: *mut c_void,
    length: u32,
    returned: *mut u32,
  ) -> i32;
  fn ConvertSidToStringSidW(sid: *const c_void, output: *mut *mut u16) -> i32;
  fn ConvertStringSecurityDescriptorToSecurityDescriptorW(
    value: *const u16,
    revision: u32,
    output: *mut *mut c_void,
    length: *mut u32,
  ) -> i32;
  fn GetSecurityDescriptorDacl(
    descriptor: *const c_void,
    present: *mut i32,
    dacl: *mut *mut c_void,
    defaulted: *mut i32,
  ) -> i32;
  fn GetNamedSecurityInfoW(
    name: *const u16,
    object_type: u32,
    information: u32,
    owner: *mut *mut c_void,
    group: *mut *mut c_void,
    dacl: *mut *mut c_void,
    sacl: *mut *mut c_void,
    descriptor: *mut *mut c_void,
  ) -> u32;
  fn SetNamedSecurityInfoW(
    name: *const u16,
    object_type: u32,
    information: u32,
    owner: *const c_void,
    group: *const c_void,
    dacl: *const c_void,
    sacl: *const c_void,
  ) -> u32;
}
#[link(name = "Kernel32")]
unsafe extern "system" {
  fn GetCurrentProcess() -> *mut c_void;
  fn CloseHandle(handle: *mut c_void) -> i32;
  fn LocalFree(value: *mut c_void) -> *mut c_void;
  fn CreateDirectoryW(path: *const u16, security: *const SecurityAttributes) -> i32;
  fn GetLastError() -> u32;
}

fn wide(path: &Path) -> Result<Vec<u16>, AclError> {
  let mut value: Vec<_> = path.as_os_str().encode_wide().collect();
  if value.contains(&0) {
    return Err(AclError::InputDenied);
  }
  value.push(0);
  Ok(value)
}

fn current_user_sid() -> Result<String, AclError> {
  let mut token = ptr::null_mut();
  if unsafe { OpenProcessToken(GetCurrentProcess(), 8, &mut token) } == 0 {
    return Err(AclError::AclFailed);
  }
  let result = (|| {
    let mut length = 0;
    unsafe {
      GetTokenInformation(token, 1, ptr::null_mut(), 0, &mut length);
    }
    if length == 0 || length > 64 * 1024 {
      return Err(AclError::AclFailed);
    }
    let mut information = vec![0usize; (length as usize).div_ceil(std::mem::size_of::<usize>())];
    if unsafe {
      GetTokenInformation(
        token,
        1,
        information.as_mut_ptr().cast(),
        length,
        &mut length,
      )
    } == 0
    {
      return Err(AclError::AclFailed);
    }
    let user = unsafe { &*information.as_ptr().cast::<TokenUser>() };
    let mut text = ptr::null_mut();
    if unsafe { ConvertSidToStringSidW(user.user.sid, &mut text) } == 0 {
      return Err(AclError::AclFailed);
    }
    let mut size = 0;
    while size < 256 && unsafe { *text.add(size) } != 0 {
      size += 1;
    }
    let result = if size < 256 {
      String::from_utf16(unsafe { std::slice::from_raw_parts(text, size) })
        .map_err(|_| AclError::AclFailed)
    } else {
      Err(AclError::AclFailed)
    };
    unsafe {
      LocalFree(text.cast());
    }
    result
  })();
  unsafe {
    CloseHandle(token);
  }
  result
}

pub fn secure_directory(path: &Path) -> Result<(), AclError> {
  let name = wide(path)?;
  let sid = current_user_sid()?;
  let sddl: Vec<u16> = format!("O:{sid}D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;{sid})")
    .encode_utf16()
    .chain(Some(0))
    .collect();
  let mut descriptor = ptr::null_mut();
  if unsafe {
    ConvertStringSecurityDescriptorToSecurityDescriptorW(
      sddl.as_ptr(),
      1,
      &mut descriptor,
      ptr::null_mut(),
    )
  } == 0
  {
    return Err(AclError::AclFailed);
  }
  let result = (|| {
    let security = SecurityAttributes {
      length: std::mem::size_of::<SecurityAttributes>() as u32,
      descriptor,
      inherit: 0,
    };
    if unsafe { CreateDirectoryW(name.as_ptr(), &security) } == 0
      && unsafe { GetLastError() } != 183
    {
      return Err(AclError::Unavailable);
    }
    let metadata = fs::symlink_metadata(path).map_err(|_| AclError::Unavailable)?;
    if !metadata.is_dir() || metadata.file_attributes() & 0x400 != 0 {
      return Err(AclError::Unavailable);
    }
    let mut present = 0;
    let mut defaulted = 0;
    let mut dacl = ptr::null_mut();
    if unsafe { GetSecurityDescriptorDacl(descriptor, &mut present, &mut dacl, &mut defaulted) }
      == 0
      || present == 0
      || dacl.is_null()
    {
      return Err(AclError::AclFailed);
    }
    if unsafe {
      SetNamedSecurityInfoW(
        name.as_ptr(),
        1,
        0x80000004,
        ptr::null(),
        ptr::null(),
        dacl,
        ptr::null(),
      )
    } != 0
    {
      return Err(AclError::AclFailed);
    }
    Ok(())
  })();
  unsafe {
    LocalFree(descriptor);
  }
  result
}

/// Стабильный короткий идентификатор текущего пользователя: 8 hex-символов от SHA-256 его SID.
/// Нужен запасному каталогу сокета в `%ProgramData%`, где у каждого пользователя свой подкаталог.
pub fn current_user_hash8() -> Result<String, AclError> {
  use sha2::{Digest, Sha256};
  let sid = current_user_sid()?;
  let digest = Sha256::digest(sid.as_bytes());
  Ok(digest.iter().take(4).map(|byte| format!("{byte:02x}")).collect())
}

/// Строковый SID владельца каталога.
fn directory_owner_sid(path: &Path) -> Result<String, AclError> {
  let name = wide(path)?;
  let mut owner = ptr::null_mut();
  let mut descriptor = ptr::null_mut();
  if unsafe {
    GetNamedSecurityInfoW(
      name.as_ptr(),
      1,
      1,
      &mut owner,
      ptr::null_mut(),
      ptr::null_mut(),
      ptr::null_mut(),
      &mut descriptor,
    )
  } != 0
    || owner.is_null()
  {
    return Err(AclError::AclFailed);
  }
  let mut text = ptr::null_mut();
  let result = if unsafe { ConvertSidToStringSidW(owner, &mut text) } == 0 {
    Err(AclError::AclFailed)
  } else {
    let mut size = 0;
    while size < 256 && unsafe { *text.add(size) } != 0 {
      size += 1;
    }
    let value = String::from_utf16(unsafe { std::slice::from_raw_parts(text, size) })
      .map_err(|_| AclError::AclFailed);
    unsafe {
      LocalFree(text.cast());
    }
    value
  };
  unsafe {
    LocalFree(descriptor);
  }
  result
}

/// Как [`secure_directory`], но каталог обязан принадлежать текущему пользователю.
/// Для общих мест (`%ProgramData%`), где чужой процесс мог заранее создать каталог с тем же именем:
/// чужой владелец сам вернул бы себе права, поэтому такой каталог отвергается.
pub fn secure_directory_owned(path: &Path) -> Result<(), AclError> {
  secure_directory(path)?;
  if directory_owner_sid(path)? != current_user_sid()? {
    return Err(AclError::Unavailable);
  }
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn owned_directory_is_accepted_and_hash_is_stable() {
    let dir = std::env::temp_dir().join(format!("egoist-acl-owned-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    secure_directory_owned(&dir).expect("свой каталог принимается");
    secure_directory_owned(&dir).expect("повторный вызов идемпотентен");
    let _ = fs::remove_dir_all(&dir);
    let first = current_user_hash8().unwrap();
    assert_eq!(first.len(), 8);
    assert_eq!(first, current_user_hash8().unwrap());
  }
}
