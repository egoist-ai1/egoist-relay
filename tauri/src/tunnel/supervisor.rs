//! Запуск и надзор за `xray.exe`: выбор портов, процесс под `WorkerJob`, перезапуск на тех же портах,
//! обёртка `xray api` (балансер и outbounds), журнал с редактированием секретов.
//!
//! Процесс один на сессию. Порты фиксируются при первом выборе и не меняются при перезапуске: на них уже
//! настроены окна WebView. Конфиг (в нём ключ VPN) на диск не пишется: он уходит процессу через stdin
//! (`-c stdin:`), для перезапуска хранится в памяти. Остатки старых версий (`xray*.json`, `ado-*.json`)
//! удаляются при старте.

use super::config::{LAGOM_EXCLUDED, PORT_RANGE, Ports, TAG_BALANCER};
use serde_json::Value;
use std::io::{BufRead, BufReader, Read};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

/// Начальная пауза перезапуска, мс.
const RECOVERY_BASE_MS: u64 = 250;
/// Предел паузы перезапуска, мс.
const RECOVERY_MAX_MS: u64 = 8000;
/// Работа без падений дольше этого срока обнуляет счётчик попыток.
const STABLE_RUN: Duration = Duration::from_secs(30);
/// Сколько `start()` ждёт готовности (контракт: не больше 1,5 с).
pub const START_WAIT: Duration = Duration::from_millis(1500);
/// Сколько фоновый поток ждёт готовности запущенного процесса.
const LAUNCH_READY_TIMEOUT: Duration = Duration::from_secs(5);
/// Через сколько неудач подряд объявляется `restart-required` (порт занят или Xray не стартует).
pub const RESTART_REQUIRED_AFTER: Duration = Duration::from_secs(30);
/// Лимит строк журнала Xray: не больше стольких за окно `LOG_WINDOW`, остальные считаются и сводятся в одну строку.
const MAX_LOG_LINES_PER_WINDOW: u32 = 200;
const LOG_WINDOW: Duration = Duration::from_secs(60);
const MAX_LOG_LINE_CHARS: usize = 400;

/// События надзирателя.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SupervisorEvent {
  /// Xray запущен и принимает соединения на `P_socks`.
  Ready,
  /// Процесс остановился (упал или перезапускается); перезапуск идёт автоматически.
  Exited,
  /// Запустить Xray не удаётся дольше 30 с (порт занят): нужен перезапуск приложения.
  RestartRequired,
}

/// Приёмник событий; вызывается из потока надзирателя.
pub type EventSink = Arc<dyn Fn(SupervisorEvent) + Send + Sync>;

/// Параметры запуска.
#[derive(Clone)]
pub struct Spec {
  /// Путь к `xray.exe`.
  pub xray_exe: PathBuf,
  /// Каталог с ресурсами Xray (`geoip.dat` и т. п.) и рабочий каталог процесса.
  pub asset_dir: PathBuf,
  /// Файл конфига в рабочем каталоге сети: сам не пишется, нужен для определения каталога очистки остатков.
  pub config_path: PathBuf,
  pub ports: Ports,
  /// Unix-сокет API Xray: файл лежит в каталоге с защищённым DACL (см. `win_acl`), каталог создаёт вызывающий.
  pub api_socket: PathBuf,
  /// Подстроки, которые нельзя выводить в журнал (адрес VPN, адрес DoH).
  pub secrets: Vec<String>,
  /// Через сколько неудачных попыток подряд объявлять `restart-required`.
  pub restart_required_after: Duration,
}

enum Command_ {
  Stop,
  Restart,
}

struct Shared {
  spec: Spec,
  config: Mutex<Value>,
  ready: AtomicBool,
}

/// Надзиратель Xray.
pub struct Supervisor {
  shared: Arc<Shared>,
  commands: Sender<Command_>,
  thread: Option<JoinHandle<()>>,
}

impl Supervisor {
  /// Запускает поток надзора и ждёт готовности Xray не дольше [`START_WAIT`]. Если за это время Xray не
  /// поднялся, надзиратель всё равно возвращается и продолжает попытки в фоне (см. [`Supervisor::is_ready`]).
  pub fn start(spec: Spec, config: Value, sink: EventSink) -> Result<Self, String> {
    spec.ports.validate()?;
    purge_leftovers(spec.config_path.parent());
    let shared = Arc::new(Shared { spec, config: Mutex::new(config), ready: AtomicBool::new(false) });
    let (commands, receiver) = mpsc::channel();
    let thread_shared = shared.clone();
    let thread = std::thread::Builder::new().name("relay-tunnel-supervisor".into())
      .spawn(move || run(thread_shared, receiver, sink))
      .map_err(|_| "TUNNEL_THREAD_FAILED".to_string())?;
    let supervisor = Self { shared, commands, thread: Some(thread) };
    let deadline = Instant::now() + START_WAIT;
    while Instant::now() < deadline && !supervisor.is_ready() {
      std::thread::sleep(Duration::from_millis(20));
    }
    Ok(supervisor)
  }

  /// Xray сейчас принимает соединения.
  pub fn is_ready(&self) -> bool { self.shared.ready.load(Ordering::SeqCst) }

  /// Порты сессии.
  #[cfg(test)]
  pub fn ports(&self) -> Ports { self.shared.spec.ports }

  /// Подменяет конфиг и перезапускает Xray на тех же портах (применение нового ключа).
  pub fn restart_with(&self, config: Value) -> Result<(), String> {
    *self.shared.config.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = config;
    self.commands.send(Command_::Restart).map_err(|_| "TUNNEL_SUPERVISOR_STOPPED".to_string())
  }

  /// Конфиг, с которым Xray поднимется при следующем запуске (после падения).
  pub fn config_slot(&self) -> ConfigSlot { ConfigSlot(self.shared.clone()) }

  /// Обёртка над `xray api` для этой сессии.
  pub fn api(&self) -> Api {
    Api { xray_exe: self.shared.spec.xray_exe.clone(), socket: self.shared.spec.api_socket.clone() }
  }

  /// Останавливает процесс и поток; все дочерние процессы завершаются вместе с job-объектом.
  pub fn stop(&mut self) {
    let _ = self.commands.send(Command_::Stop);
    if let Some(thread) = self.thread.take() { let _ = thread.join(); }
    self.shared.ready.store(false, Ordering::SeqCst);
  }
}

/// Хранилище конфига надзирателя: монитор подменяет в нём узел после смены на ходу, чтобы перезапуск
/// упавшего Xray не вернул окна на узел, который только что отказал.
#[derive(Clone)]
pub struct ConfigSlot(Arc<Shared>);

impl ConfigSlot {
  /// Следующий запуск Xray возьмёт этот конфиг; работающий процесс не трогается.
  pub fn set(&self, config: Value) {
    *self.0.config.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = config;
  }
}

impl Drop for Supervisor {
  fn drop(&mut self) { self.stop(); }
}

fn recovery_delay(attempt: u32, unit: f64) -> Duration {
  let raw = (RECOVERY_BASE_MS << attempt.min(6)).min(RECOVERY_MAX_MS);
  Duration::from_millis((raw as f64 * (0.5 + 0.5 * unit.clamp(0.0, 1.0))) as u64)
}

fn jitter_unit() -> f64 {
  let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.subsec_nanos()).unwrap_or(0);
  f64::from(nanos % 1000) / 1000.0
}

fn run(shared: Arc<Shared>, commands: Receiver<Command_>, sink: EventSink) {
  let spec = &shared.spec;
  let mut attempt: u32 = 0;
  let mut failing_since: Option<Instant> = None;
  let mut required_reported = false;
  loop {
    let config = shared.config.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone();
    let launched = if ports_free(&spec.ports) { launch(spec, &config) } else { Err("TUNNEL_PORT_BUSY".to_string()) };
    let mut skip_backoff = false;
    match launched {
      Ok(mut process) => {
        if wait_ready(&mut process, spec.ports.socks, &spec.api_socket, LAUNCH_READY_TIMEOUT) {
          shared.ready.store(true, Ordering::SeqCst);
          failing_since = None;
          required_reported = false;
          sink(SupervisorEvent::Ready);
          let started = Instant::now();
          loop {
            match commands.recv_timeout(Duration::from_millis(200)) {
              Ok(Command_::Stop) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                process.kill();
                shared.ready.store(false, Ordering::SeqCst);
                return;
              }
              Ok(Command_::Restart) => {
                process.kill();
                skip_backoff = true;
                break;
              }
              Err(mpsc::RecvTimeoutError::Timeout) => {
                if process.exited() { break; }
              }
            }
          }
          shared.ready.store(false, Ordering::SeqCst);
          if skip_backoff || started.elapsed() >= STABLE_RUN { attempt = 0; }
          if !skip_backoff { log::warn!("[Tunnel] xray остановился, перезапуск на тех же портах"); }
          sink(SupervisorEvent::Exited);
        } else {
          process.kill();
          log::warn!("[Tunnel] xray не стал готов за отведённое время");
          note_failure(&mut failing_since, &mut required_reported, spec, &sink);
        }
      }
      Err(error) => {
        if error == "TUNNEL_PORT_BUSY" { log::warn!("[Tunnel] порт сессии занят, повтор"); } else { log::warn!("[Tunnel] запуск xray не удался: {error}"); }
        note_failure(&mut failing_since, &mut required_reported, spec, &sink);
      }
    }
    // Перезапуск по команде идёт сразу, остальное — с экспоненциальной паузой
    let delay = if skip_backoff { Duration::ZERO } else {
      let delay = recovery_delay(attempt, jitter_unit());
      attempt = attempt.saturating_add(1);
      delay
    };
    match commands.recv_timeout(delay) {
      Ok(Command_::Stop) | Err(mpsc::RecvTimeoutError::Disconnected) => return,
      Ok(Command_::Restart) => attempt = 0,
      Err(mpsc::RecvTimeoutError::Timeout) => {}
    }
  }
}

fn note_failure(failing_since: &mut Option<Instant>, reported: &mut bool, spec: &Spec, sink: &EventSink) {
  let since = *failing_since.get_or_insert_with(Instant::now);
  if !*reported && since.elapsed() >= spec.restart_required_after {
    *reported = true;
    log::error!("[Tunnel] xray не запускается дольше {} с: нужен перезапуск приложения", spec.restart_required_after.as_secs());
    sink(SupervisorEvent::RestartRequired);
  }
}

// ---------- порты ----------

/// Выбирает три различных loopback-порта из 20000–60000 вне диапазонов Lagom; каждый проверен bind+drop.
pub fn pick_ports() -> Result<Ports, String> {
  let mut chosen: Vec<u16> = Vec::with_capacity(3);
  let span = u128::from(PORT_RANGE.1 - PORT_RANGE.0) + 1;
  let mut attempts = 0;
  while chosen.len() < 3 {
    attempts += 1;
    if attempts > 400 { return Err("TUNNEL_NO_FREE_PORT".into()); }
    let port = PORT_RANGE.0 + (uuid::Uuid::new_v4().as_u128() % span) as u16;
    let excluded = LAGOM_EXCLUDED.iter().any(|(from, to)| (*from..=*to).contains(&port));
    if excluded || chosen.contains(&port) || !Ports::is_allowed(port) || !port_free(port) { continue; }
    chosen.push(port);
  }
  Ok(Ports { socks: chosen[0], probe_proxy: chosen[1], probe_direct: chosen[2] })
}

fn port_free(port: u16) -> bool {
  TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], port))).is_ok()
}

fn ports_free(ports: &Ports) -> bool {
  // Слушатели держатся одновременно, чтобы дубли внутри набора тоже были видны
  let listeners: Vec<_> = ports.all().iter().map(|port| TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], *port)))).collect();
  listeners.iter().all(Result::is_ok)
}

// ---------- процесс ----------

struct Process {
  child: std::process::Child,
  /// Файл сокета API: после kill он остаётся на диске, и следующий запуск Xray падает на «failed to listen».
  socket: PathBuf,
  #[cfg(windows)]
  job: crate::worker_job::WorkerJob,
}

impl Process {
  fn exited(&mut self) -> bool { !matches!(self.child.try_wait(), Ok(None)) }

  fn kill(&mut self) {
    #[cfg(windows)]
    self.job.terminate();
    let _ = self.child.kill();
    let _ = self.child.wait();
    remove_socket(&self.socket);
  }
}

/// Удаляет файл сокета; «нет файла» не ошибка.
fn remove_socket(path: &Path) {
  if let Err(error) = std::fs::remove_file(path) {
    if error.kind() != std::io::ErrorKind::NotFound { log::warn!("[Tunnel] сокет API не удалён: {error}"); }
  }
}

/// Готовность: SOCKS принимает соединения и файл сокета API создан (lstat: у AF_UNIX это точка повторной обработки).
fn wait_ready(process: &mut Process, port: u16, socket: &Path, timeout: Duration) -> bool {
  let deadline = Instant::now() + timeout;
  let address = SocketAddr::from(([127, 0, 0, 1], port));
  while Instant::now() < deadline {
    if process.exited() { return false; }
    if TcpStream::connect_timeout(&address, Duration::from_millis(100)).is_ok() && std::fs::symlink_metadata(socket).is_ok() { return true; }
    std::thread::sleep(Duration::from_millis(25));
  }
  false
}

#[cfg(windows)]
fn launch(spec: &Spec, config: &Value) -> Result<Process, String> {
  use std::os::windows::process::CommandExt;
  use std::process::Stdio;
  const CREATE_NO_WINDOW: u32 = 0x0800_0000;
  if !spec.xray_exe.is_file() { return Err("TUNNEL_XRAY_MISSING".into()); }
  let bytes = serde_json::to_vec(config).map_err(|_| "TUNNEL_CONFIG_WRITE_FAILED".to_string())?;
  // После kill/сбоя старый файл сокета остаётся, и Xray не стартует («failed to listen Unix Domain Socket»)
  match std::fs::remove_file(&spec.api_socket) {
    Ok(()) => {}
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
    Err(_) => return Err("TUNNEL_API_SOCKET_BUSY".into()),
  }
  let mut command = Command::new(&spec.xray_exe);
  command.args(["run", "-format", "json", "-c", "stdin:"])
    .current_dir(&spec.asset_dir)
    .env("XRAY_LOCATION_ASSET", &spec.asset_dir)
    .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped())
    // Приоритет обычный: туннель не должен отставать от интерфейса
    .creation_flags(CREATE_NO_WINDOW);
  let mut child = command.spawn().map_err(|_| "TUNNEL_XRAY_SPAWN_FAILED".to_string())?;
  // Конфиг (с ключом) уходит только в stdin; после записи канал закрывается, и Xray читает его до конца
  let sent = child.stdin.take().map(|mut stdin| write_all_close(&mut stdin, &bytes)).unwrap_or(false);
  if !sent {
    let _ = child.kill();
    let _ = child.wait();
    return Err("TUNNEL_CONFIG_WRITE_FAILED".into());
  }
  let job = match crate::worker_job::WorkerJob::attach(&child) {
    Ok(job) => job,
    Err(_) => {
      let _ = child.kill();
      let _ = child.wait();
      return Err("TUNNEL_XRAY_OWNERSHIP_FAILED".into());
    }
  };
  if let Some(stdout) = child.stdout.take() { spawn_log_reader(stdout, false, spec.secrets.clone()); }
  if let Some(stderr) = child.stderr.take() { spawn_log_reader(stderr, true, spec.secrets.clone()); }
  Ok(Process { child, socket: spec.api_socket.clone(), job })
}

#[cfg(not(windows))]
fn launch(_spec: &Spec, _config: &Value) -> Result<Process, String> {
  Err("TUNNEL_WINDOWS_REQUIRED".into())
}

/// Пишет байты в stdin дочернего процесса и закрывает канал.
fn write_all_close(stdin: &mut std::process::ChildStdin, bytes: &[u8]) -> bool {
  use std::io::Write;
  stdin.write_all(bytes).and_then(|()| stdin.flush()).is_ok()
}

/// Файлы-остатки: конфиги Xray с ключом, временные документы `xray api ado` и сокеты API после аварийного выхода.
fn is_leftover_name(name: &str) -> bool {
  matches!(name, "xray.json" | "xray.json.tmp" | "xray-probe.json" | "xray-probe.json.tmp")
    || matches!(name, "api-main.sock" | "api-probe.sock")
    || (name.starts_with("ado-") && (name.ends_with(".json") || name.ends_with(".json.tmp")))
}

/// Удаляет остатки в каталоге сети и в его подкаталоге `ipc` (`profile.dpapi` и `seed.dpapi` не трогает).
pub fn purge_leftovers(dir: Option<&Path>) {
  let Some(dir) = dir else { return };
  for folder in [dir.to_path_buf(), dir.join(IPC_DIR)] {
    let Ok(entries) = std::fs::read_dir(&folder) else { continue };
    for entry in entries.flatten() {
      // Каталог с таким именем remove_file не удалит; сокет AF_UNIX не «обычный файл», поэтому is_file() не проверяем
      if is_leftover_name(&entry.file_name().to_string_lossy()) { let _ = std::fs::remove_file(entry.path()); }
    }
  }
}

/// Подкаталог сети с сокетами API (DACL: только текущий пользователь и SYSTEM).
pub const IPC_DIR: &str = "ipc";

/// Ответ ограничителя журнала на очередную строку.
#[derive(Debug, PartialEq, Eq)]
enum LogVerdict {
  /// Писать; `Some((пропущено, шум))` — сводка за прошлое окно.
  Pass(Option<(u32, u32)>),
  /// Не писать; `true` — первая пропущенная строка окна (стоит предупредить один раз).
  Skip(bool),
}

/// Лимит по скорости вместо жёсткого «100 строк на запуск»: реальные ошибки в конце долгого запуска не теряются.
#[derive(Default)]
struct LogLimiter {
  window_start: Option<Instant>,
  count: u32,
  skipped: u32,
  noise: u32,
}

impl LogLimiter {
  fn check(&mut self, now: Instant, noise: bool) -> LogVerdict {
    let mut summary = None;
    if self.window_start.is_none_or(|start| now.duration_since(start) >= LOG_WINDOW) {
      if self.skipped > 0 || self.noise > 0 { summary = Some((self.skipped, self.noise)); }
      *self = Self { window_start: Some(now), ..Self::default() };
    }
    if noise {
      self.noise += 1;
      return if summary.is_some() { LogVerdict::Pass(summary) } else { LogVerdict::Skip(false) };
    }
    self.count += 1;
    if self.count > MAX_LOG_LINES_PER_WINDOW {
      self.skipped += 1;
      return LogVerdict::Skip(self.skipped == 1);
    }
    LogVerdict::Pass(summary)
  }
}

/// Известный шум собственных проб: Xray жалуется, что клиент закрыл сокет до конца ответа.
fn is_probe_noise(line: &str) -> bool {
  line.contains("failed to write response") && (line.contains("aborted") || line.contains("wsasend"))
}

fn spawn_log_reader<R: Read + Send + 'static>(stream: R, is_stderr: bool, secrets: Vec<String>) {
  let _ = std::thread::Builder::new().name("relay-tunnel-log".into()).spawn(move || {
    let mut limiter = LogLimiter::default();
    for line in BufReader::new(stream).split(b'\n') {
      let Ok(bytes) = line else { break };
      let text = String::from_utf8_lossy(&bytes);
      match limiter.check(Instant::now(), is_probe_noise(&text)) {
        LogVerdict::Skip(first) => {
          if first { log::warn!("[Tunnel] xray: лимит {MAX_LOG_LINES_PER_WINDOW} строк в минуту, остальные пропускаются"); }
          continue;
        }
        LogVerdict::Pass(Some((skipped, noise))) => {
          log::warn!("[Tunnel] xray: за прошлую минуту пропущено строк: {skipped}, шума проб отфильтровано: {noise}");
        }
        LogVerdict::Pass(None) => {}
      }
      if is_probe_noise(&text) { continue; }
      let redacted = redact(text.trim_end(), &secrets);
      if is_stderr { log::warn!("[Tunnel] xray: {redacted}"); } else { log::info!("[Tunnel] xray: {redacted}"); }
    }
  });
}

/// Скрывает в строке журнала всё, что похоже на секрет: заданные подстроки (адреса VPN и DoH) и
/// длинные цепочки из букв, цифр, `-` и `_` от 32 символов (ключи, UUID, токены).
pub fn redact(line: &str, secrets: &[String]) -> String {
  let mut text: String = line.chars().take(MAX_LOG_LINE_CHARS).collect();
  for secret in secrets.iter().filter(|s| s.len() >= 3) {
    text = text.replace(secret.as_str(), "<скрыто>");
  }
  let mut result = String::with_capacity(text.len());
  let mut run = String::new();
  let flush = |run: &mut String, result: &mut String| {
    if run.chars().count() >= 32 { result.push_str("<скрыто>"); } else { result.push_str(run); }
    run.clear();
  };
  for character in text.chars() {
    if character.is_ascii_alphanumeric() || character == '-' || character == '_' {
      run.push(character);
    } else {
      flush(&mut run, &mut result);
      result.push(character);
    }
  }
  flush(&mut run, &mut result);
  result
}

// ---------- xray api ----------

/// Обёртка над `xray api`: управление балансером и outbounds уже работающего процесса.
#[derive(Clone)]
pub struct Api {
  xray_exe: PathBuf,
  socket: PathBuf,
}

impl Api {
  /// Запрещённых символов в тегах нет по построению, но проверяем: тег уходит в командную строку.
  fn valid_tag(tag: &str) -> bool {
    !tag.is_empty() && tag.len() <= 64 && tag.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
  }

  fn run(&self, args: &[&std::ffi::OsStr]) -> Result<(), String> {
    self.run_with_stdin(args, None)
  }

  /// Запускает `xray api …`; `stdin_data` (документ с ключом) передаётся через stdin, а не файлом на диске.
  fn run_with_stdin(&self, args: &[&std::ffi::OsStr], stdin_data: Option<&[u8]>) -> Result<(), String> {
    use std::process::Stdio;
    let mut command = Command::new(&self.xray_exe);
    command.arg("api").args(args)
      .stdin(if stdin_data.is_some() { Stdio::piped() } else { Stdio::null() })
      .stdout(Stdio::piped()).stderr(Stdio::piped());
    hide_window(&mut command);
    let mut child = command.spawn().map_err(|_| "TUNNEL_API_SPAWN_FAILED".to_string())?;
    if let (Some(data), Some(mut stdin)) = (stdin_data, child.stdin.take()) {
      if !write_all_close(&mut stdin, data) {
        let _ = child.kill();
        let _ = child.wait();
        return Err("TUNNEL_API_FAILED".into());
      }
    }
    let output = child.wait_with_output().map_err(|_| "TUNNEL_API_SPAWN_FAILED".to_string())?;
    // Текст вывода не разбираем (в нём бывают предупреждения про устаревшие протоколы): итог — код выхода
    if !output.status.success() { return Err("TUNNEL_API_FAILED".into()); }
    Ok(())
  }

  /// Адрес API: `unix:<путь с '/'>` (формат проверен на живом Xray: `xray api lso -s unix:C:/…/api.sock`).
  fn server_arg(&self) -> std::ffi::OsString {
    format!("-s=unix:{}", self.socket.to_string_lossy().replace('\\', "/")).into()
  }

  /// `xray api bo -b active <tag>`: принудительно направляет балансер в outbound `tag` (например `direct`).
  pub fn override_balancer(&self, tag: &str) -> Result<(), String> {
    if !Self::valid_tag(tag) { return Err("TUNNEL_API_BAD_TAG".into()); }
    self.run(&["bo".as_ref(), self.server_arg().as_os_str(), "-t=3".as_ref(), "-b".as_ref(), TAG_BALANCER.as_ref(), tag.as_ref()])
  }

  /// `xray api bo -b active -r`: снимает принудительный выбор, балансер снова выбирает `proxy`.
  pub fn clear_override(&self) -> Result<(), String> {
    self.run(&["bo".as_ref(), self.server_arg().as_os_str(), "-t=3".as_ref(), "-b".as_ref(), TAG_BALANCER.as_ref(), "-r".as_ref()])
  }

  /// `xray api ado`: добавляет outbound (JSON одного outbound). Документ с ключом идёт через stdin, файла нет.
  pub fn add_outbound(&self, outbound: &Value) -> Result<(), String> {
    let document = serde_json::to_vec(&serde_json::json!({ "outbounds": [outbound] })).map_err(|_| "TUNNEL_CONFIG_WRITE_FAILED".to_string())?;
    self.run_with_stdin(&["ado".as_ref(), self.server_arg().as_os_str(), "-t=3".as_ref(), "stdin:".as_ref()], Some(&document))
  }

  /// `xray api rmo`: удаляет outbound по тегу.
  pub fn remove_outbound(&self, tag: &str) -> Result<(), String> {
    if !Self::valid_tag(tag) { return Err("TUNNEL_API_BAD_TAG".into()); }
    self.run(&["rmo".as_ref(), self.server_arg().as_os_str(), "-t=3".as_ref(), tag.as_ref()])
  }
}

#[cfg(windows)]
fn hide_window(command: &mut Command) {
  use std::os::windows::process::CommandExt;
  command.creation_flags(0x0800_0000);
}

#[cfg(not(windows))]
fn hide_window(_command: &mut Command) {}

// ---------- временный Xray для проверки нового ключа ----------

/// Временный Xray на отдельных портах: проверка нового ключа и DoH перед заменой рабочих. Один запуск,
/// без перезапусков; процесс завершается при `Drop`.
pub struct TempXray {
  process: Process,
  spec: Spec,
}

impl TempXray {
  /// Запускает Xray по `config` и ждёт готовности не дольше `timeout`.
  pub fn start(spec: Spec, config: &Value, timeout: Duration) -> Result<Self, String> {
    spec.ports.validate()?;
    if !ports_free(&spec.ports) { return Err("TUNNEL_PORT_BUSY".into()); }
    let mut process = launch(&spec, config)?;
    if !wait_ready(&mut process, spec.ports.socks, &spec.api_socket, timeout) {
      process.kill();
      return Err("TUNNEL_XRAY_NOT_READY".into());
    }
    Ok(Self { process, spec })
  }

  /// Порты временного процесса.
  #[allow(dead_code)]
  pub fn ports(&self) -> Ports { self.spec.ports }

  /// `xray api` временного процесса (смена узла при проверке нескольких).
  pub fn api(&self) -> Api {
    Api { xray_exe: self.spec.xray_exe.clone(), socket: self.spec.api_socket.clone() }
  }
}

impl Drop for TempXray {
  fn drop(&mut self) { self.process.kill(); }
}

#[cfg(all(test, windows))]
mod tests {
  use super::*;
  use crate::tunnel::config::{ConfigInput, build};
  use crate::tunnel::uri::parse_link;
  use std::collections::BTreeMap;
  use std::sync::Mutex as StdMutex;

  fn runtime_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("runtime")
  }

  #[test]
  fn log_limiter_caps_rate_and_reports_skipped() {
    let start = Instant::now();
    let mut limiter = LogLimiter::default();
    for _ in 0..MAX_LOG_LINES_PER_WINDOW {
      assert_eq!(limiter.check(start, false), LogVerdict::Pass(None));
    }
    assert_eq!(limiter.check(start, false), LogVerdict::Skip(true));
    assert_eq!(limiter.check(start, false), LogVerdict::Skip(false));
    // новое окно: строки снова идут, со сводкой «пропущено 2»
    let later = start + LOG_WINDOW;
    assert_eq!(limiter.check(later, false), LogVerdict::Pass(Some((2, 0))));
    assert_eq!(limiter.check(later, false), LogVerdict::Pass(None));
  }

  #[test]
  fn log_limiter_does_not_count_probe_noise_against_the_limit() {
    let start = Instant::now();
    let mut limiter = LogLimiter::default();
    for _ in 0..1000 {
      assert_eq!(limiter.check(start, true), LogVerdict::Skip(false));
    }
    for _ in 0..MAX_LOG_LINES_PER_WINDOW {
      assert_eq!(limiter.check(start, false), LogVerdict::Pass(None));
    }
    assert!(is_probe_noise("accepted ... failed to write response > write tcp: wsasend: An established connection was aborted"));
    assert!(!is_probe_noise("proxy/vless: connection ends > EOF"));
  }

  fn have_xray() -> bool { runtime_dir().join("xray.exe").is_file() }

  fn work_dir() -> PathBuf {
    let base = std::env::var_os("EGOIST_RELAY_TEST_WORK").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    // Имя короткое: путь сокета AF_UNIX не длиннее 108 байт
    let dir = base.join(format!("ts-{}", &uuid::Uuid::new_v4().simple().to_string()[..8]));
    std::fs::create_dir_all(&dir).unwrap();
    dir
  }

  /// Каталог сокетов с защищённым DACL внутри рабочего каталога теста.
  fn ipc_dir(dir: &Path, name: &str) -> PathBuf {
    let ipc = dir.join(name);
    crate::win_acl::secure_directory(&ipc).expect("защищённый каталог");
    ipc
  }

  fn spec_for(ports: Ports, dir: &Path) -> Spec {
    let ipc = ipc_dir(dir, IPC_DIR);
    Spec {
      xray_exe: runtime_dir().join("xray.exe"),
      asset_dir: runtime_dir(),
      config_path: dir.join("xray.json"),
      api_socket: ipc.join("api-main.sock"),
      ports,
      secrets: vec!["vpn.example.com".into()],
      restart_required_after: Duration::from_secs(2),
    }
  }

  fn sample_config(spec: &Spec) -> Value {
    let node = parse_link("vless://00000000-0000-0000-0000-000000000000@vpn.example.com:443?security=reality&flow=xtls-rprx-vision&sni=www.example.org&pbk=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&sid=ab12&fp=chrome").unwrap();
    build(&ConfigInput { ports: spec.ports, api_socket: &spec.api_socket.to_string_lossy(), node: Some(&node), doh: "https://dns.example.net/dns-query", host_ips: &BTreeMap::new(), node_hosts: &[] }).unwrap()
  }

  fn collecting_sink() -> (EventSink, Arc<StdMutex<Vec<SupervisorEvent>>>) {
    let events = Arc::new(StdMutex::new(Vec::new()));
    let inner = events.clone();
    (Arc::new(move |event| inner.lock().unwrap().push(event)), events)
  }

  #[test]
  fn picked_ports_are_allowed_distinct_and_bindable() {
    for _ in 0..20 {
      let ports = pick_ports().unwrap();
      ports.validate().unwrap();
      assert!(ports_free(&ports));
    }
  }

  #[test]
  fn recovery_delay_grows_to_cap() {
    let full: Vec<u64> = (0..8).map(|a| recovery_delay(a, 1.0).as_millis() as u64).collect();
    assert_eq!(full, vec![250, 500, 1000, 2000, 4000, 8000, 8000, 8000]);
    assert_eq!(recovery_delay(0, 0.0).as_millis(), 125);
    assert_eq!(recovery_delay(u32::MAX, 9.0).as_millis(), 8000);
  }

  #[test]
  fn redact_hides_ids_keys_and_listed_hosts() {
    let uuid = "00000000-0000-0000-0000-000000000000";
    let key = "A".repeat(43);
    let secrets = vec!["vpn.example.com".to_string()];
    assert_eq!(redact(&format!("failed to dial vpn.example.com:443 id {uuid} key {key}"), &secrets),
      "failed to dial <скрыто>:443 id <скрыто> key <скрыто>");
    assert_eq!(redact("Xray 26.7.28 started on 127.0.0.1:1080", &secrets), "Xray 26.7.28 started on 127.0.0.1:1080");
    assert_eq!(redact(&"f".repeat(31), &[]), "f".repeat(31));
    assert!(redact(&"я".repeat(1000), &[]).chars().count() <= MAX_LOG_LINE_CHARS);
  }

  #[test]
  fn purge_leftovers_removes_only_key_configs() {
    let dir = work_dir();
    for name in ["xray.json", "xray.json.tmp", "xray-probe.json", "ado-0123abcd.json", "ado-0123abcd.json.tmp", "profile.dpapi", "seed.dpapi", "notes.json"] {
      std::fs::write(dir.join(name), b"x").unwrap();
    }
    purge_leftovers(Some(&dir));
    let mut left: Vec<String> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    left.sort();
    assert_eq!(left, vec!["notes.json", "profile.dpapi", "seed.dpapi"]);
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn api_rejects_unsafe_tags() {
    let api = Api { xray_exe: PathBuf::from("xray.exe"), socket: PathBuf::from("C:/x/api.sock") };
    assert!(api.override_balancer("direct; calc").is_err());
    assert!(api.remove_outbound("").is_err());
    assert!(api.remove_outbound(&"a".repeat(65)).is_err());
  }

  #[test]
  fn real_xray_starts_switches_balancer_and_restarts_on_same_ports() {
    if !have_xray() { eprintln!("runtime/xray.exe нет: тест пропущен"); return; }
    let dir = work_dir();
    let ports = pick_ports().unwrap();
    let (sink, events) = collecting_sink();
    let spec = spec_for(ports, &dir);
    let config = sample_config(&spec);
    let mut supervisor = Supervisor::start(spec, config.clone(), sink).unwrap();
    assert!(supervisor.is_ready(), "xray не поднялся за START_WAIT");
    assert!(!dir.join("xray.json").exists(), "конфиг с ключом должен быть удалён после готовности");

    let api = supervisor.api();
    api.override_balancer("direct").expect("bo direct");
    api.clear_override().expect("bo -r");
    let outbound = crate::tunnel::config::outbound(&parse_link("ss://aes-256-gcm:pw@192.0.2.10:8388").unwrap());
    api.remove_outbound("proxy").expect("rmo proxy");
    api.add_outbound(&outbound).expect("ado proxy");
    assert!(std::fs::read_dir(&dir).unwrap().all(|e| e.unwrap().file_name() == IPC_DIR), "ключ не должен попадать на диск");

    // перезапуск на тех же портах
    supervisor.restart_with(config).unwrap();
    let deadline = Instant::now() + Duration::from_secs(8);
    while Instant::now() < deadline && events.lock().unwrap().iter().filter(|e| **e == SupervisorEvent::Ready).count() < 2 {
      std::thread::sleep(Duration::from_millis(50));
    }
    assert_eq!(events.lock().unwrap().iter().filter(|e| **e == SupervisorEvent::Ready).count(), 2);
    assert_eq!(supervisor.ports(), ports);
    assert!(TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], ports.socks)), Duration::from_secs(1)).is_ok());
    supervisor.stop();
    assert!(TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], ports.socks)), Duration::from_millis(300)).is_err());
    let _ = std::fs::remove_dir_all(&dir);
  }

  /// Ловушка 2: после kill файл сокета остаётся; новый запуск обязан его убрать, иначе «failed to listen».
  #[test]
  fn api_survives_stale_socket() {
    if !have_xray() { eprintln!("runtime/xray.exe нет: тест пропущен"); return; }
    let dir = work_dir();
    let ports = pick_ports().unwrap();
    let (sink, events) = collecting_sink();
    let spec = spec_for(ports, &dir);
    let socket = spec.api_socket.clone();
    let config = sample_config(&spec);
    let mut supervisor = Supervisor::start(spec, config.clone(), sink).unwrap();
    assert!(supervisor.is_ready());
    let api = supervisor.api();
    api.override_balancer("direct").expect("bo до перезапуска");
    supervisor.restart_with(config.clone()).unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline && events.lock().unwrap().iter().filter(|e| **e == SupervisorEvent::Ready).count() < 2 {
      std::thread::sleep(Duration::from_millis(50));
    }
    assert_eq!(events.lock().unwrap().iter().filter(|e| **e == SupervisorEvent::Ready).count(), 2, "второй запуск не состоялся");
    api.clear_override().expect("bo после перезапуска");
    supervisor.stop();
    assert!(std::fs::symlink_metadata(&socket).is_err(), "сокет должен удаляться при остановке");
    // Остаток сокета подложен вручную (как после аварийного выхода): запуск обязан его убрать
    std::fs::write(&socket, b"stale").unwrap();
    let (sink2, _events2) = collecting_sink();
    let mut again = Supervisor::start(spec_for(ports, &dir), config, sink2).unwrap();
    assert!(again.is_ready(), "запуск поверх остатка сокета не удался");
    again.api().override_balancer("direct").expect("bo поверх остатка");
    again.stop();
    let _ = std::fs::remove_dir_all(&dir);
  }

  /// Каталог сокета: защищённый DACL (`D:P`), только SYSTEM и текущий пользователь, без BU/AU/WD.
  #[test]
  fn api_socket_dir_is_private() {
    let dir = work_dir();
    let ipc = ipc_dir(&dir, IPC_DIR);
    let output = Command::new("powershell.exe")
      .args(["-NoProfile", "-NonInteractive", "-Command", &format!("(Get-Acl -LiteralPath '{}').Sddl", ipc.display())])
      .output().expect("powershell");
    let sddl = String::from_utf8_lossy(&output.stdout).trim().to_string();
    assert!(sddl.contains("D:P"), "DACL не защищён от наследования: {sddl}");
    for group in [";;;BU)", ";;;AU)", ";;;WD)", ";;;BA)"] {
      assert!(!sddl.contains(group), "лишний доступ {group}: {sddl}");
    }
    assert_eq!(sddl.matches("(A;").count(), 2, "ожидались ровно две записи (SYSTEM и пользователь): {sddl}");
    assert!(sddl.contains(";;;SY)"));
    let _ = std::fs::remove_dir_all(&dir);
  }

  /// API больше не занимает TCP-порт: в конфиге у api-inbound нет `port`, TCP-inbound ровно три.
  #[test]
  fn tcp_api_absent() {
    let dir = work_dir();
    let ports = pick_ports().unwrap();
    assert_eq!(ports.all().len(), 3);
    let spec = spec_for(ports, &dir);
    let config = sample_config(&spec);
    let inbounds = config["inbounds"].as_array().unwrap();
    let api = inbounds.iter().find(|i| i["tag"] == "api").unwrap();
    assert!(api.get("port").is_none());
    let mut tcp: Vec<u16> = inbounds.iter().filter_map(|i| i.get("port").and_then(Value::as_u64)).map(|p| p as u16).collect();
    tcp.sort_unstable();
    let mut expected = ports.all().to_vec();
    expected.sort_unstable();
    assert_eq!(tcp, expected);
    assert!(ports_free(&ports));
    let _ = std::fs::remove_dir_all(&dir);
  }

  /// Путь с кириллицей и пробелом: проверка, принимает ли Xray такой путь сокета.
  #[test]
  fn api_socket_path_with_cyrillic_and_space() {
    if !have_xray() { eprintln!("runtime/xray.exe нет: тест пропущен"); return; }
    let dir = work_dir();
    let ports = pick_ports().unwrap();
    let (sink, _events) = collecting_sink();
    let mut spec = spec_for(ports, &dir);
    spec.api_socket = ipc_dir(&dir, "ипц x").join("api.sock");
    let config = sample_config(&spec);
    let mut supervisor = Supervisor::start(spec, config, sink).unwrap();
    assert!(supervisor.is_ready());
    supervisor.api().override_balancer("direct").expect("bo по пути с кириллицей и пробелом");
    supervisor.stop();
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn busy_port_retries_then_reports_restart_required_and_recovers() {
    if !have_xray() { eprintln!("runtime/xray.exe нет: тест пропущен"); return; }
    let dir = work_dir();
    let ports = pick_ports().unwrap();
    let blocker = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], ports.probe_direct))).unwrap();
    let (sink, events) = collecting_sink();
    let spec = spec_for(ports, &dir);
    let config = sample_config(&spec);
    let mut supervisor = Supervisor::start(spec, config, sink).unwrap();
    assert!(!supervisor.is_ready());
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline && !events.lock().unwrap().contains(&SupervisorEvent::RestartRequired) {
      std::thread::sleep(Duration::from_millis(100));
    }
    assert!(events.lock().unwrap().contains(&SupervisorEvent::RestartRequired));
    // порт освободился: надзиратель сам поднимает Xray
    drop(blocker);
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline && !supervisor.is_ready() {
      std::thread::sleep(Duration::from_millis(100));
    }
    assert!(supervisor.is_ready());
    supervisor.stop();
    let _ = std::fs::remove_dir_all(&dir);
  }
}
