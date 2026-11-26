//! Стадия: каталог `<app-local-data>\updates\<версия>\`, потоковое скачивание в `.part`, проверка SHA-256,
//! повторная проверка файла под удерживаемым дескриптором и запуск установщика, очистка при старте.
//!
//! Подмену файла между проверкой и запуском закрывает дескриптор: файл открыт с `FILE_SHARE_READ`
//! (чужие процессы не могут ни записать, ни удалить, ни переименовать его), пока установщик не запущен.

use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::error::{UpdateError, UpdateResult};
use super::sign::hex;
use super::source::{ByteStream, HttpError, HttpResponse};

/// Сколько раз можно предлагать один и тот же неудавшийся установщик.
pub const MAX_ATTEMPTS: u32 = 3;
/// Ждать закрытия приложения установщиком, секунд.
pub const WAIT_APP_SECS: u32 = 120;

/// Аргументы запуска установщика. Чистая функция: вынесена, чтобы тест фиксировал контракт с установщиком.
pub fn launch_args() -> Vec<String> {
  vec!["--silent".to_string(), "--launch".to_string(), format!("--wait-app={WAIT_APP_SECS}")]
}

#[derive(Debug, Clone)]
pub struct StageDirs {
  pub root: PathBuf,
}

impl StageDirs {
  pub fn new(root: PathBuf) -> StageDirs {
    StageDirs { root }
  }
  pub fn version_dir(&self, version: &Version) -> PathBuf {
    self.root.join(version.to_string())
  }
  pub fn state_path(&self) -> PathBuf {
    self.root.join("state.json")
  }
}

fn io_err(e: std::io::Error) -> UpdateError {
  UpdateError::Io(e.to_string())
}

// ------------------------------------------------------------------ state.json

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct State {
  pub version: String,
  pub path: String,
  pub sha256: String,
  pub size: u64,
  pub attempts: u32,
}

pub fn read_state(dirs: &StageDirs) -> Option<State> {
  let bytes = std::fs::read(dirs.state_path()).ok()?;
  if bytes.len() > 16 * 1024 {
    return None;
  }
  serde_json::from_slice(&bytes).ok()
}

pub fn write_state(dirs: &StageDirs, state: &State) -> UpdateResult<()> {
  std::fs::create_dir_all(&dirs.root).map_err(io_err)?;
  let tmp = dirs.root.join("state.json.tmp");
  let text = serde_json::to_vec(state).map_err(|e| UpdateError::Io(e.to_string()))?;
  std::fs::write(&tmp, text).map_err(io_err)?;
  std::fs::rename(&tmp, dirs.state_path()).map_err(io_err)
}

// ------------------------------------------------------------------ свободное место

#[cfg(windows)]
pub fn free_space(path: &Path) -> std::io::Result<u64> {
  use std::os::windows::ffi::OsStrExt;
  #[link(name = "Kernel32")]
  unsafe extern "system" {
    fn GetDiskFreeSpaceExW(dir: *const u16, available: *mut u64, total: *mut u64, free: *mut u64) -> i32;
  }
  let wide: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
  let (mut available, mut total, mut free) = (0u64, 0u64, 0u64);
  // SAFETY: wide завершён нулём и живёт на время вызова; три указателя ведут на локальные u64.
  let ok = unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), &mut available, &mut total, &mut free) };
  if ok == 0 { Err(std::io::Error::last_os_error()) } else { Ok(available) }
}

#[cfg(not(windows))]
pub fn free_space(_path: &Path) -> std::io::Result<u64> {
  Ok(u64::MAX)
}

// ------------------------------------------------------------------ скачивание

/// Удаляет `.part` при любом выходе, кроме успешного переименования.
struct PartGuard {
  path: PathBuf,
  armed: bool,
}

impl Drop for PartGuard {
  fn drop(&mut self) {
    if self.armed {
      let _ = std::fs::remove_file(&self.path);
    }
  }
}

/// Скачать тело ответа в `<dir>/<name>`: поток → `.part`, SHA-256 на лету, строгие проверки размера и суммы.
/// При любой ошибке (в том числе обрыве и отмене) `.part` удаляется. Возвращает путь итогового файла.
pub async fn download<B: ByteStream>(
  mut resp: HttpResponse<B>,
  dir: &Path,
  name: &str,
  size: u64,
  sha256: &str,
  idle: Duration,
  progress: &mut (dyn FnMut(u64) + Send),
) -> UpdateResult<PathBuf> {
  std::fs::create_dir_all(dir).map_err(io_err)?;
  let final_path = dir.join(name);
  let part_path = dir.join(format!("{name}.part"));
  if resp.content_length.is_some_and(|n| n != size) {
    return Err(UpdateError::SizeMismatch);
  }
  let _ = std::fs::remove_file(&part_path);
  let file = OpenOptions::new().write(true).create_new(true).open(&part_path).map_err(io_err)?;
  let mut guard = PartGuard { path: part_path.clone(), armed: true };
  // Хеширование и запись на диск — в блокирующем потоке: поток async-рантайма остаётся свободным.
  // Канал ограничен, поэтому медленный диск притормаживает чтение сети, а не раздувает память.
  let (tx, mut rx) = tokio::sync::mpsc::channel::<Vec<u8>>(8);
  let writer = tokio::task::spawn_blocking(move || -> std::io::Result<(File, String)> {
    let mut file = file;
    let mut hasher = Sha256::new();
    while let Some(chunk) = rx.blocking_recv() {
      hasher.update(&chunk);
      file.write_all(&chunk)?;
    }
    file.sync_all()?;
    Ok((file, hex(&hasher.finalize())))
  });
  let mut done: u64 = 0;
  let received: UpdateResult<()> = async {
    loop {
      let next = tokio::time::timeout(idle, resp.body.next_chunk())
        .await
        .map_err(|_| UpdateError::Timeout)?
        .map_err(|e| match e {
          HttpError::Timeout => UpdateError::Timeout,
          HttpError::Network(m) => UpdateError::Network(m),
        })?;
      let Some(chunk) = next else { return Ok(()) };
      done += chunk.len() as u64;
      if done > size {
        return Err(UpdateError::SizeMismatch);
      }
      // Ошибка отправки значит, что писатель остановился: его ошибка будет ниже.
      if tx.send(chunk).await.is_err() {
        return Ok(());
      }
      progress(done);
    }
  }
  .await;
  drop(tx);
  // Дожидаемся писателя в любом случае: `.part` удаляется только после закрытия дескриптора.
  let written = writer.await.map_err(|e| UpdateError::Io(e.to_string()))?;
  received?;
  let (file, actual) = written.map_err(io_err)?;
  if done != size {
    return Err(UpdateError::SizeMismatch);
  }
  if actual != sha256 {
    return Err(UpdateError::HashMismatch);
  }
  drop(file);
  std::fs::rename(&part_path, &final_path).map_err(io_err)?;
  guard.armed = false;
  Ok(final_path)
}

fn hash_reader(reader: &mut impl Read) -> std::io::Result<(String, u64)> {
  let mut hasher = Sha256::new();
  let mut buf = vec![0u8; 256 * 1024];
  let mut total = 0u64;
  loop {
    let n = reader.read(&mut buf)?;
    if n == 0 {
      break;
    }
    hasher.update(&buf[..n]);
    total += n as u64;
  }
  Ok((hex(&hasher.finalize()), total))
}

/// Файл уже скачан раньше и совпадает по размеру и сумме (повторное предложение после неудачной установки).
pub fn existing_valid(path: &Path, size: u64, sha256: &str) -> bool {
  let Ok(mut f) = File::open(path) else { return false };
  match hash_reader(&mut f) {
    Ok((h, n)) => n == size && h == sha256,
    Err(_) => false,
  }
}

// ------------------------------------------------------------------ запуск

pub trait Launcher: Send + Sync {
  /// Запустить `path` с аргументами напрямую (без оболочки). Вызывается, пока файл удерживается открытым.
  fn launch(&self, path: &Path, args: &[String]) -> std::io::Result<()>;
}

pub struct ProcessLauncher;

impl Launcher for ProcessLauncher {
  fn launch(&self, path: &Path, args: &[String]) -> std::io::Result<()> {
    // Прямой CreateProcess: без ShellExecute и cmd. Ребёнка не ждём: приложение после запуска завершается.
    std::process::Command::new(path).args(args).spawn().map(drop)
  }
}

fn open_shared_read(path: &Path) -> std::io::Result<File> {
  let mut options = OpenOptions::new();
  options.read(true);
  #[cfg(windows)]
  {
    use std::os::windows::fs::OpenOptionsExt;
    options.share_mode(1); // FILE_SHARE_READ
  }
  options.open(path)
}

/// Открыть итоговый файл с общим доступом только на чтение, перечитать и сверить размер и сумму,
/// и, НЕ закрывая дескриптор, запустить установщик.
pub fn verify_and_launch(path: &Path, size: u64, sha256: &str, launcher: &dyn Launcher) -> UpdateResult<()> {
  let mut file = open_shared_read(path).map_err(io_err)?;
  let (actual, total) = hash_reader(&mut file).map_err(io_err)?;
  if total != size {
    return Err(UpdateError::SizeMismatch);
  }
  if actual != sha256 {
    return Err(UpdateError::HashMismatch);
  }
  launcher.launch(path, &launch_args()).map_err(|e| UpdateError::Launch(e.to_string()))?;
  drop(file);
  Ok(())
}

// ------------------------------------------------------------------ старт новой версии

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StartupOutcome {
  Nothing,
  /// Обновление применено или стадия устарела: каталог удалён.
  Cleaned,
  /// Прошлая установка не удалась, файл цел: предложить снова.
  Retry { version: String, size: u64, attempts: u32 },
  /// Три неудачи: каталог удалён, пользователю нужен ручной установщик.
  Manual { version: String },
}

/// Вызывается при старте приложения.
pub fn startup_check(dirs: &StageDirs, current: &Version) -> StartupOutcome {
  if !dirs.root.exists() {
    return StartupOutcome::Nothing;
  }
  let remove = || {
    let _ = std::fs::remove_dir_all(&dirs.root);
  };
  let Some(state) = read_state(dirs) else {
    // Состояния нет: остался недокачанный `.part` или мусор — при старте ничего не качается.
    remove();
    return StartupOutcome::Cleaned;
  };
  let Ok(version) = Version::parse(&state.version) else {
    remove();
    return StartupOutcome::Cleaned;
  };
  if current >= &version {
    remove();
    return StartupOutcome::Cleaned;
  }
  if state.attempts >= MAX_ATTEMPTS {
    remove();
    return StartupOutcome::Manual { version: state.version };
  }
  let path = PathBuf::from(&state.path);
  if path.starts_with(&dirs.root) && existing_valid(&path, state.size, &state.sha256) {
    StartupOutcome::Retry { version: state.version, size: state.size, attempts: state.attempts }
  } else {
    remove();
    StartupOutcome::Cleaned
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::update::source::fake::{FakeHttp, ok};
  use crate::update::source::{HttpClient, HttpRequest};
  use crate::update::testkit::sha_hex_of;
  use std::sync::Mutex;

  fn rt() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread().enable_time().build().unwrap()
  }

  async fn response(r: crate::update::source::fake::Scripted) -> HttpResponse<crate::update::source::fake::FakeBody> {
    let http = FakeHttp::new();
    http.route("https://x/y", r);
    http.get(&HttpRequest { url: "https://x/y".into(), headers: vec![], timeout: Duration::from_secs(1) })
      .await
      .unwrap()
  }

  #[test]
  fn args_contract() {
    assert_eq!(launch_args(), ["--silent", "--launch", "--wait-app=120"]);
  }

  #[test]
  fn download_ok_and_progress() {
    let dir = tempfile::tempdir().unwrap();
    let data = vec![5u8; 3000];
    let resp = rt().block_on(response(ok(&data)));
    let mut seen = vec![];
    let p = rt()
      .block_on(download(resp, dir.path(), "a.exe", 3000, &sha_hex_of(&data), Duration::from_secs(5), &mut |d| seen.push(d)))
      .unwrap();
    assert_eq!(std::fs::read(&p).unwrap(), data);
    assert!(!dir.path().join("a.exe.part").exists());
    assert_eq!(seen.last(), Some(&3000));
  }

  #[test]
  fn download_failures_leave_no_part() {
    let dir = tempfile::tempdir().unwrap();
    let data = vec![5u8; 3000];
    let good = sha_hex_of(&data);
    // неверная сумма
    let resp = rt().block_on(response(ok(&data)));
    let e = rt().block_on(download(resp, dir.path(), "a.exe", 3000, &"0".repeat(64), Duration::from_secs(5), &mut |_| {}));
    assert_eq!(e, Err(UpdateError::HashMismatch));
    // тело короче заявленного размера
    let resp = rt().block_on(response(ok(&data[..2000])));
    let mut short = ok(&data[..2000]);
    short.content_length = None;
    let resp2 = rt().block_on(response(short));
    drop(resp);
    let e = rt().block_on(download(resp2, dir.path(), "a.exe", 3000, &good, Duration::from_secs(5), &mut |_| {}));
    assert_eq!(e, Err(UpdateError::SizeMismatch));
    // Content-Length не равен size
    let resp = rt().block_on(response(ok(&data[..2000])));
    let e = rt().block_on(download(resp, dir.path(), "a.exe", 3000, &good, Duration::from_secs(5), &mut |_| {}));
    assert_eq!(e, Err(UpdateError::SizeMismatch));
    // тело длиннее заявленного
    let mut long = ok(&data);
    long.content_length = None;
    let resp = rt().block_on(response(long));
    let e = rt().block_on(download(resp, dir.path(), "a.exe", 2000, &good, Duration::from_secs(5), &mut |_| {}));
    assert_eq!(e, Err(UpdateError::SizeMismatch));
    // обрыв потока
    let mut cut = ok(&data[..1000]);
    cut.content_length = Some(3000);
    cut.error_after = Some(HttpError::Network("reset".into()));
    let resp = rt().block_on(response(cut));
    let e = rt().block_on(download(resp, dir.path(), "a.exe", 3000, &good, Duration::from_secs(5), &mut |_| {}));
    assert!(matches!(e, Err(UpdateError::Network(_))));
    let left: Vec<_> = std::fs::read_dir(dir.path()).unwrap().collect();
    assert!(left.is_empty(), "{left:?}");
  }

  struct Rec(Mutex<Vec<(PathBuf, Vec<String>)>>);
  impl Launcher for Rec {
    fn launch(&self, path: &Path, args: &[String]) -> std::io::Result<()> {
      self.0.lock().unwrap().push((path.to_path_buf(), args.to_vec()));
      Ok(())
    }
  }

  #[test]
  fn verify_and_launch_checks_file_again() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("s.exe");
    std::fs::write(&p, b"installer-bytes").unwrap();
    let sha = sha_hex_of(b"installer-bytes");
    let rec = Rec(Mutex::new(vec![]));
    verify_and_launch(&p, 15, &sha, &rec).unwrap();
    assert_eq!(rec.0.lock().unwrap().len(), 1);
    // файл подменили после скачивания
    std::fs::write(&p, b"installer-bytez").unwrap();
    assert_eq!(verify_and_launch(&p, 15, &sha, &rec), Err(UpdateError::HashMismatch));
    assert_eq!(verify_and_launch(&p, 16, &sha, &rec), Err(UpdateError::SizeMismatch));
    assert_eq!(rec.0.lock().unwrap().len(), 1);
  }

  /// Реальный запуск безобидного системного exe: проверяем, что процесс стартует,
  /// пока наш дескриптор держит файл с FILE_SHARE_READ.
  #[cfg(windows)]
  #[test]
  fn real_launch_works_under_share_read_handle() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("probe.exe");
    let system = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("C:\\Windows"));
    std::fs::copy(system.join("System32").join("hostname.exe"), &p).unwrap();
    let bytes = std::fs::read(&p).unwrap();
    struct Wait;
    impl Launcher for Wait {
      fn launch(&self, path: &Path, _args: &[String]) -> std::io::Result<()> {
        // Пока дескриптор открыт, чужая запись и удаление должны быть запрещены.
        assert!(OpenOptions::new().write(true).open(path).is_err());
        assert!(std::fs::remove_file(path).is_err());
        let mut child = std::process::Command::new(path).spawn()?;
        child.wait().map(drop)
      }
    }
    verify_and_launch(&p, bytes.len() as u64, &sha_hex_of(&bytes), &Wait).unwrap();
  }

  fn state_for(dir: &Path, version: &str, attempts: u32, data: &[u8]) -> StageDirs {
    let dirs = StageDirs::new(dir.join("updates"));
    let v = dirs.root.join(version);
    std::fs::create_dir_all(&v).unwrap();
    let path = v.join("setup.exe");
    std::fs::write(&path, data).unwrap();
    write_state(
      &dirs,
      &State {
        version: version.into(),
        path: path.to_string_lossy().into_owned(),
        sha256: sha_hex_of(data),
        size: data.len() as u64,
        attempts,
      },
    )
    .unwrap();
    dirs
  }

  fn ver(s: &str) -> Version {
    Version::parse(s).unwrap()
  }

  #[test]
  fn startup_cleans_after_successful_update() {
    let t = tempfile::tempdir().unwrap();
    let dirs = state_for(t.path(), "1.2.0", 1, b"x");
    assert_eq!(startup_check(&dirs, &ver("1.2.0")), StartupOutcome::Cleaned);
    assert!(!dirs.root.exists());
    let dirs = state_for(t.path(), "1.2.0", 1, b"x");
    assert_eq!(startup_check(&dirs, &ver("1.3.0")), StartupOutcome::Cleaned);
    assert!(!dirs.root.exists());
  }

  #[test]
  fn startup_retry_then_manual() {
    let t = tempfile::tempdir().unwrap();
    let dirs = state_for(t.path(), "1.2.0", 2, b"data");
    assert_eq!(
      startup_check(&dirs, &ver("1.1.0")),
      StartupOutcome::Retry { version: "1.2.0".into(), size: 4, attempts: 2 }
    );
    assert!(dirs.root.exists());
    let dirs = state_for(t.path(), "1.2.0", 3, b"data");
    assert_eq!(startup_check(&dirs, &ver("1.1.0")), StartupOutcome::Manual { version: "1.2.0".into() });
    assert!(!dirs.root.exists());
  }

  #[test]
  fn startup_corrupt_file_or_state_is_removed() {
    let t = tempfile::tempdir().unwrap();
    let dirs = state_for(t.path(), "1.2.0", 1, b"data");
    std::fs::write(dirs.root.join("1.2.0").join("setup.exe"), b"evil").unwrap();
    assert_eq!(startup_check(&dirs, &ver("1.1.0")), StartupOutcome::Cleaned);
    assert!(!dirs.root.exists());
    let dirs = StageDirs::new(t.path().join("updates"));
    std::fs::create_dir_all(&dirs.root).unwrap();
    std::fs::write(dirs.state_path(), b"{not json").unwrap();
    assert_eq!(startup_check(&dirs, &ver("1.1.0")), StartupOutcome::Cleaned);
    assert_eq!(startup_check(&dirs, &ver("1.1.0")), StartupOutcome::Nothing);
  }

  #[test]
  fn startup_state_pointing_outside_root_is_not_trusted() {
    let t = tempfile::tempdir().unwrap();
    let dirs = state_for(t.path(), "1.2.0", 1, b"data");
    let outside = t.path().join("outside.exe");
    std::fs::write(&outside, b"data").unwrap();
    let mut st = read_state(&dirs).unwrap();
    st.path = outside.to_string_lossy().into_owned();
    write_state(&dirs, &st).unwrap();
    assert_eq!(startup_check(&dirs, &ver("1.1.0")), StartupOutcome::Cleaned);
    assert!(outside.exists());
  }
}
