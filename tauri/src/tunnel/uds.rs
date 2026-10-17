//! Проверки AF_UNIX на Windows: можно ли подключиться к сокету и работает ли сокет в данном каталоге.
//!
//! Зачем: на некоторых машинах файл сокета в каталоге профиля (`%LOCALAPPDATA%`, `%APPDATA%`) создаётся, но
//! подключиться к нему нельзя (`connect` → WSAEINVAL), а сам файл не открыть и не удалить (ошибка 1920).
//! Причина в среде (фильтр файловой системы), не в DACL и не в Xray: в `%TEMP%` и `%ProgramData%` то же
//! работает. Поэтому готовность Xray проверяется настоящим `connect`, а каталог сокетов выбирается пробой.

use std::path::Path;

#[cfg(windows)]
mod sys {
  use std::sync::Once;

  #[repr(C)]
  pub struct WsaData { pub raw: [u8; 408] }
  #[repr(C)]
  pub struct SockaddrUn { pub family: u16, pub path: [u8; 108] }

  pub const AF_UNIX: i32 = 1;
  pub const SOCK_STREAM: i32 = 1;
  pub const INVALID_SOCKET: usize = usize::MAX;

  #[link(name = "ws2_32")]
  unsafe extern "system" {
    pub fn WSAStartup(version: u16, data: *mut WsaData) -> i32;
    pub fn socket(af: i32, kind: i32, protocol: i32) -> usize;
    pub fn connect(s: usize, name: *const SockaddrUn, len: i32) -> i32;
    pub fn bind(s: usize, name: *const SockaddrUn, len: i32) -> i32;
    pub fn listen(s: usize, backlog: i32) -> i32;
    pub fn closesocket(s: usize) -> i32;
  }

  pub fn init() {
    static START: Once = Once::new();
    START.call_once(|| {
      let mut data = WsaData { raw: [0; 408] };
      unsafe { WSAStartup(0x0202, &mut data) };
    });
  }

  /// `sockaddr_un` и его длина; путь длиннее 107 байт или с NUL не годится.
  pub fn address(path: &std::path::Path) -> Option<(SockaddrUn, i32)> {
    let text = path.to_str()?.replace('\\', "/");
    let bytes = text.as_bytes();
    if bytes.is_empty() || bytes.len() > 107 || bytes.contains(&0) { return None; }
    let mut address = SockaddrUn { family: AF_UNIX as u16, path: [0; 108] };
    address.path[..bytes.len()].copy_from_slice(bytes);
    Some((address, (2 + bytes.len() + 1) as i32))
  }
}

/// Принимает ли сокет по этому пути соединения (настоящий `connect`, файл сам по себе ничего не доказывает).
#[cfg(windows)]
pub fn can_connect(path: &Path) -> bool {
  let Some((address, length)) = sys::address(path) else { return false };
  sys::init();
  unsafe {
    let handle = sys::socket(sys::AF_UNIX, sys::SOCK_STREAM, 0);
    if handle == sys::INVALID_SOCKET { return false; }
    let connected = sys::connect(handle, &address, length) == 0;
    sys::closesocket(handle);
    connected
  }
}
#[cfg(not(windows))]
pub fn can_connect(_path: &Path) -> bool { false }

/// Слушающий сокет AF_UNIX: закрывается при `Drop`, файл остаётся (как после аварийного выхода).
#[cfg(windows)]
pub struct Listener(usize);

#[cfg(windows)]
impl Listener {
  pub fn bind(path: &Path) -> Option<Self> {
    let (address, length) = sys::address(path)?;
    sys::init();
    unsafe {
      let handle = sys::socket(sys::AF_UNIX, sys::SOCK_STREAM, 0);
      if handle == sys::INVALID_SOCKET { return None; }
      if sys::bind(handle, &address, length) != 0 || sys::listen(handle, 4) != 0 {
        sys::closesocket(handle);
        return None;
      }
      Some(Self(handle))
    }
  }
}

#[cfg(windows)]
impl Drop for Listener {
  fn drop(&mut self) { unsafe { sys::closesocket(self.0) }; }
}

/// Имя пробного сокета: постоянное, чтобы в заблокированном каталоге не копились неудаляемые файлы
/// (следующая проба упирается в тот же файл и сразу получает отказ).
const PROBE_NAME: &str = "uds-probe.sock";

/// Работает ли AF_UNIX в каталоге: создаёт сокет, слушает, подключается, затем убирает файл.
#[cfg(windows)]
pub fn probe_dir(dir: &Path) -> bool {
  let path = dir.join(PROBE_NAME);
  // Остаток прошлой пробы; если не удаляется, bind ниже откажет, и это верный ответ
  let _ = std::fs::remove_file(&path);
  let Some(listener) = Listener::bind(&path) else { return false };
  let connected = can_connect(&path);
  drop(listener);
  let _ = std::fs::remove_file(&path);
  connected
}
#[cfg(not(windows))]
pub fn probe_dir(_dir: &Path) -> bool { false }

#[cfg(all(test, windows))]
mod tests {
  use super::*;

  fn temp_dir() -> std::path::PathBuf {
    let base = std::env::var_os("EGOIST_RELAY_TEST_WORK").map(std::path::PathBuf::from).unwrap_or_else(std::env::temp_dir);
    let dir = base.join(format!("us-{}", &uuid::Uuid::new_v4().simple().to_string()[..8]));
    std::fs::create_dir_all(&dir).unwrap();
    dir
  }

  #[test]
  fn connect_needs_a_live_listener_not_just_a_file() {
    let dir = temp_dir();
    let path = dir.join("a.sock");
    assert!(!can_connect(&path), "файла нет");
    let listener = Listener::bind(&path).expect("bind");
    assert!(std::fs::symlink_metadata(&path).is_ok());
    assert!(can_connect(&path), "слушатель принимает соединения");
    drop(listener);
    assert!(!can_connect(&path), "файл остался, а слушателя нет: connect обязан отказать");
    std::fs::remove_file(&path).unwrap();
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn probe_passes_in_a_normal_dir_and_cleans_up() {
    let dir = temp_dir();
    assert!(probe_dir(&dir));
    assert!(probe_dir(&dir), "повтор работает");
    assert!(std::fs::symlink_metadata(dir.join(PROBE_NAME)).is_err(), "пробный файл убран");
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn probe_fails_when_the_socket_cannot_be_created() {
    let dir = temp_dir();
    // Вместо файла сокета каталог: remove_file и bind отказывают (как у неудаляемого остатка)
    std::fs::create_dir_all(dir.join(PROBE_NAME).join("x")).unwrap();
    assert!(!probe_dir(&dir));
    assert!(!probe_dir(&dir.join("нет такого каталога")));
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn too_long_or_invalid_paths_are_refused() {
    assert!(sys::address(Path::new(&format!("C:/{}", "a".repeat(120)))).is_none());
    assert!(sys::address(Path::new("")).is_none());
    assert!(!can_connect(Path::new("C:/нет/такого.sock")));
  }
}
