use serde::Serialize;
use std::sync::{Arc, LazyLock, Mutex, atomic::{AtomicBool, Ordering}, mpsc};
use std::time::{Duration, Instant};

const START_TIMEOUT: Duration = Duration::from_secs(15);
const STABLE_WORKER_TIME: Duration = Duration::from_secs(30);
/// Сколько раз пробуем поднять прокси на новом порту, если выбранный занят чужим процессом.
#[cfg(any(windows, test))]
const PORT_ATTEMPTS: u32 = 3;
#[cfg(any(windows, test))]
const RECOVERY_BASE_MS: u64 = 250;
#[cfg(any(windows, test))]
const RECOVERY_MAX_MS: u64 = 8000;
/// Предел строки stderr воркера и числа строк, попадающих в журнал за жизнь одного воркера.
#[cfg(any(windows, test))]
const STDERR_LINE_LIMIT: usize = 2048;
#[cfg(any(windows, test))]
const STDERR_LINES_PER_WORKER: usize = 50;
/// Предел журнала tg-ws-proxy: строк за скользящее окно и длина строки. Бюджет обновляется каждое окно,
/// иначе всплеск одинаковых предупреждений делает прокси «слепым» до перезапуска.
#[cfg(any(windows, test))]
const PROXY_LOG_LINES: usize = 20;
#[cfg(any(windows, test))]
const PROXY_LOG_WINDOW: Duration = Duration::from_secs(600);
#[cfg(any(windows, test))]
const PROXY_LOG_LINE_CHARS: usize = 200;
/// Сколько последних строк stderr прокси (любого уровня) хранить для записи о его выходе.
#[cfg(any(windows, test))]
const PROXY_TAIL_LINES: usize = 5;
/// Пауза перед записью о выходе воркера: если приложение закрывается, сигнал остановки успевает прийти.
#[cfg(windows)]
const SHUTDOWN_GRACE: Duration = Duration::from_millis(500);
static ACTIVE: LazyLock<Mutex<Option<ActiveTransport>>> = LazyLock::new(|| Mutex::new(None));
static LOCAL_PROXY_READY: AtomicBool = AtomicBool::new(false);

#[derive(Clone)]
pub(crate) struct BridgeConfig {
  pub(crate) local_port: u16,
  pub(crate) local_secret: String,
}

pub(crate) type BridgeConfigProvider = fn() -> Option<BridgeConfig>;

fn local_bridge_config() -> Option<BridgeConfig> {
  let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).ok()?;
  let local_port = listener.local_addr().ok()?.port();
  Some(BridgeConfig { local_port, local_secret: uuid::Uuid::new_v4().simple().to_string() })
}

pub(crate) fn is_ready() -> bool {
  LOCAL_PROXY_READY.load(Ordering::Acquire)
}

struct ActiveTransport {
  url: String,
  alive: Arc<AtomicBool>,
  stop: mpsc::Sender<()>,
}

#[derive(Serialize, Default)]
pub(crate) struct TransportStatus {
  #[serde(skip_serializing_if = "Option::is_none")]
  url: Option<String>,
  mtproxy: bool,
}

/// Настройки, которые воркер читает первой строкой stdin: сам мост (токен, origin, порт) и конфиг MTProxy.
#[cfg(any(windows, test))]
fn worker_settings(token: &str, port: u16, config: &BridgeConfig, include_dev_origin: bool) -> serde_json::Value {
  let mut origins = vec!["http://tauri.localhost", "https://tauri.localhost", "tauri://localhost"];
  if include_dev_origin { origins.push("http://localhost:1234"); }
  serde_json::json!({
    "token": token, "origins": origins, "port": port,
    "localPort": config.local_port, "localSecret": config.local_secret,
  })
}

#[tauri::command]
pub(crate) async fn relay_get_telegram_transport(
  app: tauri::AppHandle,
  webview: tauri::Webview,
) -> Result<TransportStatus, String> {
  let label = webview.label();
  let origin = webview.url().map_err(|_| "TELEGRAM_TRANSPORT_DENIED")?;
  let is_local = origin.scheme() == "tauri" || origin.host_str() == Some("tauri.localhost")
    || (cfg!(debug_assertions) && origin.host_str() == Some("localhost") && origin.port() == Some(1234));
  if !is_local || (label != "main" && uuid::Uuid::parse_str(label).is_err()) {
    return Err("TELEGRAM_TRANSPORT_DENIED".into());
  }
  tauri::async_runtime::spawn_blocking(move || start_transport(app, local_bridge_config))
    .await.map_err(|_| "TELEGRAM_TRANSPORT_UNAVAILABLE".to_string())?
}

#[cfg(not(windows))]
fn start_transport(_app: tauri::AppHandle, _provider: BridgeConfigProvider) -> Result<TransportStatus, String> {
  Ok(TransportStatus::default())
}

#[cfg(windows)]
fn start_transport(app: tauri::AppHandle, provider: BridgeConfigProvider) -> Result<TransportStatus, String> {
  let mut active = ACTIVE.lock().map_err(|_| "TELEGRAM_TRANSPORT_UNAVAILABLE")?;
  if let Some(worker) = active.as_ref() && worker.alive.load(Ordering::Acquire) {
    return Ok(TransportStatus { url: Some(worker.url.clone()), mtproxy: true });
  }
  if let Some(worker) = active.take() {
    let _ = worker.stop.send(());
  }
  let Some(config) = provider() else { return Ok(TransportStatus::default()); };

  let token = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
  let (stop, stop_receiver) = mpsc::channel();
  let (ready, ready_receiver) = mpsc::sync_channel(1);
  let alive = Arc::new(AtomicBool::new(false));
  let worker_alive = alive.clone();
  std::thread::Builder::new().name("relay-telegram-transport".into()).spawn(move || {
    supervise_transport(app, token, config, provider, stop_receiver, ready, worker_alive.clone());
    worker_alive.store(false, Ordering::Release);
    LOCAL_PROXY_READY.store(false, Ordering::Release);
  }).map_err(|_| "TELEGRAM_TRANSPORT_UNAVAILABLE")?;

  match ready_receiver.recv_timeout(START_TIMEOUT) {
    Ok(Ok(Some(url))) => {
      *active = Some(ActiveTransport { url: url.clone(), alive, stop });
      Ok(TransportStatus { url: Some(url), mtproxy: true })
    }
    Ok(Ok(None)) => Ok(TransportStatus::default()),
    _ => {
      let _ = stop.send(());
      Err("TELEGRAM_TRANSPORT_UNAVAILABLE".into())
    }
  }
}

#[cfg(windows)]
fn supervise_transport(
  app: tauri::AppHandle,
  token: String,
  config: BridgeConfig,
  provider: BridgeConfigProvider,
  stop: mpsc::Receiver<()>,
  ready: mpsc::SyncSender<Result<Option<String>, String>>,
  alive: Arc<AtomicBool>,
) {
  let mut worker = match launch_transport(&app, &token, &config, 0, provider) {
    Ok(worker) => worker,
    Err(error) => { let _ = ready.send(Err(error)); return; }
  };
  let message = read_status(&mut worker);
  if message.as_ref().and_then(|value| value["status"].as_str()) == Some("unavailable") {
    let _ = ready.send(Ok(None));
    return;
  }
  let url = message.as_ref().filter(|value| value["status"] == "ready")
    .and_then(|value| value["url"].as_str()).filter(|value| validate_url(value, &token));
  let Some(url) = url.map(str::to_string) else {
    let _ = ready.send(Err("TELEGRAM_TRANSPORT_UNAVAILABLE".into()));
    return;
  };
  alive.store(true, Ordering::Release);
  LOCAL_PROXY_READY.store(true, Ordering::Release);
  crate::network::emit_status(&app);
  let port = url::Url::parse(&url).ok().and_then(|url| url.port()).unwrap();
  if ready.send(Ok(Some(url.clone()))).is_err() { return; }

  let mut recovery_attempt: u32 = 0;
  let mut started = Instant::now();
  loop {
    let worker_exit = worker.child.try_wait();
    let proxy_exit = worker.proxy.child.try_wait();
    let worker_alive = matches!(worker_exit, Ok(None));
    let proxy_alive = matches!(proxy_exit, Ok(None));
    if !worker_alive || !proxy_alive {
      LOCAL_PROXY_READY.store(false, Ordering::Release);
      crate::network::emit_status(&app);
      // Штатная остановка (выход приложения, замена воркера) — не падение, журнал не засоряем.
      // При выходе приложения дочерние процессы гибнут раньше, чем приходит сигнал остановки: ждём его
      if !matches!(stop.recv_timeout(SHUTDOWN_GRACE), Err(mpsc::RecvTimeoutError::Timeout)) { return; }
      let uptime = started.elapsed();
      if uptime >= STABLE_WORKER_TIME { recovery_attempt = 0; }
      // По одной строке на мёртвый процесс: код выхода, время жизни, состояние соседа и что он успел сказать.
      // Код 1 спустя часы при пустом stderr — завершение извне; 0x40010004 — завершение сеанса Windows
      if !proxy_alive {
        let code = proxy_exit.ok().flatten().and_then(|status| status.code());
        log::warn!(
          "[TelegramTransport] tg-ws-proxy exited ({}); worker alive={worker_alive}; last stderr: {}; restarting with the bridge",
          describe_exit(code, uptime), worker.proxy.tail.snapshot());
      }
      if !worker_alive {
        let code = worker_exit.ok().flatten().and_then(|status| status.code());
        log::warn!(
          "[TelegramTransport] Owned bridge worker exited ({}); proxy alive={proxy_alive}; stderr lines={}, last: {}; recovering its local endpoint",
          describe_exit(code, uptime), worker.stderr_lines.load(Ordering::Relaxed), worker.stderr_tail.snapshot());
      }
      drop(worker);
      let mut failed_attempts: u32 = 0;
      loop {
        let delay = recovery_delay(recovery_attempt, jitter_unit());
        recovery_attempt = recovery_attempt.saturating_add(1);
        if !matches!(stop.recv_timeout(delay), Err(mpsc::RecvTimeoutError::Timeout)) { return; }
        let failure = match provider().ok_or("no bridge config")
          .and_then(|config| launch_transport(&app, &token, &config, port, provider).map_err(|_| "launch failed")) {
          Err(reason) => reason,
          Ok(mut next) => {
            let message = read_status(&mut next);
            match message.as_ref() {
              None => "read timeout",
              Some(value) if value["status"] != "ready" => "status unavailable",
              Some(value) if value["url"] != url => "url mismatch",
              Some(_) => {
                worker = next;
                started = Instant::now();
                LOCAL_PROXY_READY.store(true, Ordering::Release);
                crate::network::emit_status(&app);
                log::info!("[TelegramTransport] Owned local bridge endpoint restored");
                break;
              }
            }
          }
        };
        failed_attempts = failed_attempts.saturating_add(1);
        // Первые 5 подряд, затем каждая 10-я: журнал не растёт, пока мост лежит долго
        if failed_attempts <= 5 || failed_attempts % 10 == 0 {
          log::warn!("[TelegramTransport] Bridge restart attempt {failed_attempts} failed: {failure}");
        }
      }
    }
    match stop.recv_timeout(Duration::from_millis(100)) {
      Err(mpsc::RecvTimeoutError::Timeout) => {},
      _ => break,
    }
  }
}

/// Пауза перед перезапуском упавшего воркера моста: экспонента от 250 мс до 8 с с джиттером 50-100%.
#[cfg(any(windows, test))]
fn recovery_delay(attempt: u32, unit: f64) -> Duration {
  let raw = (RECOVERY_BASE_MS << attempt.min(6)).min(RECOVERY_MAX_MS);
  Duration::from_millis((raw as f64 * (0.5 + 0.5 * unit.clamp(0.0, 1.0))) as u64)
}

#[cfg(windows)]
fn jitter_unit() -> f64 {
  let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
    .map(|elapsed| elapsed.subsec_nanos()).unwrap_or(0);
  f64::from(nanos % 1000) / 1000.0
}

#[cfg(windows)]
fn read_status(worker: &mut OwnedWorker) -> Option<serde_json::Value> {
  let stdout = worker.child.stdout.take()?;
  let (response, response_receiver) = mpsc::sync_channel(1);
  std::thread::spawn(move || {
    use std::io::{BufRead, BufReader, Read};
    let mut line = Vec::new();
    let result = BufReader::new(stdout).take(4097).read_until(b'\n', &mut line)
      .ok().filter(|size| *size > 0 && *size <= 4096)
      .and_then(|_| serde_json::from_slice::<serde_json::Value>(&line).ok());
    let _ = response.send(result);
  });
  response_receiver.recv_timeout(Duration::from_secs(5)).ok().flatten()
}

#[cfg(windows)]
fn validate_url(value: &str, token: &str) -> bool {
  let Ok(url) = url::Url::parse(value) else { return false; };
  url.scheme() == "ws" && url.host_str() == Some("127.0.0.1") && url.port().is_some()
    && url.username().is_empty() && url.password().is_none() && url.path() == "/apiws"
    && url.fragment().is_none() && url.query_pairs().count() == 1
    && url.query_pairs().any(|(name, value)| name == "token" && value == token)
}

#[cfg(windows)]
struct OwnedWorker {
  child: std::process::Child,
  ownership: crate::worker_job::WorkerJob,
  proxy: OwnedLocalProxy,
  /// Сколько строк stderr воркер успел отдать (все, а не только попавшие в журнал): «0» при выходе —
  /// он умер молча, без собственной ошибки. Последние строки — в `stderr_tail` (там и его `fatal()`).
  stderr_lines: Arc<std::sync::atomic::AtomicUsize>,
  stderr_tail: StderrTail,
  _directory: crate::inline_media::OwnedDirectory,
}

#[cfg(windows)]
struct OwnedLocalProxy {
  child: std::process::Child,
  ownership: crate::worker_job::WorkerJob,
  tail: StderrTail,
}

#[cfg(windows)]
impl Drop for OwnedLocalProxy {
  fn drop(&mut self) {
    self.ownership.terminate();
    let _ = self.child.kill();
    let _ = self.child.wait();
  }
}

#[cfg(windows)]
fn local_proxy_binary(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
  use tauri::Manager;
  let mut candidates = Vec::new();
  if let Ok(directory) = app.path().resource_dir() {
    candidates.push(directory.join("runtime/telegram/tg-ws-proxy.exe"));
  }
  if let Ok(executable) = std::env::current_exe() && let Some(directory) = executable.parent() {
    candidates.push(directory.join("runtime/telegram/tg-ws-proxy.exe"));
    candidates.push(directory.join("resources/runtime/telegram/tg-ws-proxy.exe"));
  }
  #[cfg(debug_assertions)]
  candidates.push(std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../runtime/telegram/tg-ws-proxy.exe"));
  candidates.into_iter().find(|candidate| candidate.is_file()).ok_or_else(|| "TELEGRAM_LOCAL_PROXY_MISSING".into())
}

#[cfg(windows)]
fn launch_local_proxy(
  app: &tauri::AppHandle, config: &BridgeConfig, directory: &std::path::Path,
) -> Result<OwnedLocalProxy, String> {
  use std::process::{Command, Stdio};
  let mut command = Command::new(local_proxy_binary(app)?);
  crate::social_share::sanitize_media_worker_environment(&mut command);
  command.args(["--host", "127.0.0.1", "--port", &config.local_port.to_string(),
    "--secret", &config.local_secret, "--buf-kb", "256", "--pool-size", "8",
    "--dc-ip", "4:149.154.167.220",
    "--log-file", "NUL", "--log-backups", "0"])
    .current_dir(directory).env("TEMP", directory).env("TMP", directory)
    .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped());
  crate::runtime::hide_command_window(&mut command);
  {
    use std::os::windows::process::CommandExt;
    command.creation_flags(0x0800_0000);
  }
  let mut child = command.spawn().map_err(|_| "TELEGRAM_LOCAL_PROXY_START_FAILED")?;
  let ownership = match crate::worker_job::WorkerJob::attach(&child) {
    Ok(ownership) => ownership,
    Err(_) => {
      let _ = child.kill();
      let _ = child.wait();
      return Err("TELEGRAM_LOCAL_PROXY_OWNERSHIP_FAILED".into());
    }
  };
  // stderr прокси читаем отдельным потоком: в журнал идут только warning и выше без секретов, с лимитами;
  // последние строки любого уровня копим в хвосте для записи о выходе
  let tail = StderrTail::default();
  if let Some(stderr) = child.stderr.take() {
    let secret = config.local_secret.clone();
    let tail = tail.clone();
    let _ = std::thread::Builder::new().name("relay-telegram-proxy-stderr".into()).spawn(move || {
      let mut filter = ProxyLogFilter::default();
      drain_stderr_with(stderr, usize::MAX, |line| {
        tail.push(line, &secret);
        if let Some(text) = filter.accept(line, &secret, Instant::now()) {
          log::warn!("[TelegramTransport] tg-ws-proxy: {text}");
        }
      });
    });
  }
  let mut proxy = OwnedLocalProxy { child, ownership, tail };
  let address = std::net::SocketAddr::from(([127, 0, 0, 1], config.local_port));
  let deadline = Instant::now() + Duration::from_secs(8);
  while Instant::now() < deadline {
    if !matches!(proxy.child.try_wait(), Ok(None)) { return Err("TELEGRAM_LOCAL_PROXY_EXITED".into()); }
    if std::net::TcpStream::connect_timeout(&address, Duration::from_millis(100)).is_ok() {
      // Слушатель мог оказаться чужим (порт освобождали после bind(0)): проверяем владельца
      return match verify_listener_owner(config.local_port, proxy.child.id()) {
        ListenerOwner::Foreign => {
          log::warn!("[TelegramTransport] Local proxy port is held by a foreign process; discarding this start");
          Err("TELEGRAM_LOCAL_PROXY_PORT_FOREIGN".into())
        }
        ListenerOwner::Unknown => {
          log::warn!("[TelegramTransport] Could not verify the owner of the local proxy port; continuing");
          Ok(proxy)
        }
        ListenerOwner::Ours => Ok(proxy),
      };
    }
    std::thread::sleep(Duration::from_millis(50));
  }
  Err("TELEGRAM_LOCAL_PROXY_START_TIMEOUT".into())
}

#[cfg(windows)]
fn launch_transport(
  app: &tauri::AppHandle, token: &str, config: &BridgeConfig, port: u16, provider: BridgeConfigProvider,
) -> Result<OwnedWorker, String> {
  // Чужой слушатель на выбранном порту (или прокси не поднялся) — берём новый порт, не больше PORT_ATTEMPTS попыток.
  // Новый порт получает и воркер: localPort/localSecret уходят ему из того же конфига.
  let mut config = config.clone();
  for attempt in 1..=PORT_ATTEMPTS {
    match launch_transport_once(app, token, &config, port) {
      Err(error) if attempt < PORT_ATTEMPTS
        && (error == "TELEGRAM_LOCAL_PROXY_PORT_FOREIGN" || error == "TELEGRAM_LOCAL_PROXY_EXITED") => {
        log::warn!("[TelegramTransport] Local proxy start {attempt}/{PORT_ATTEMPTS} failed ({error}); retrying on another port");
        let Some(next) = provider() else { return Err(error); };
        config = next;
      }
      other => return other,
    }
  }
  Err("TELEGRAM_LOCAL_PROXY_START_FAILED".into())
}

#[cfg(windows)]
fn launch_transport_once(app: &tauri::AppHandle, token: &str, config: &BridgeConfig, port: u16) -> Result<OwnedWorker, String> {
  use std::io::Write;
  use std::process::{Command, Stdio};
  let node = crate::runtime::find_node_binary(app).map_err(|_| "TELEGRAM_TRANSPORT_UNAVAILABLE")?;
  let directory = crate::inline_media::OwnedDirectory::create(app)?;
  let script = directory.prepare_worker("telegram-transport.cjs",
    include_str!(concat!(env!("OUT_DIR"), "/telegram-transport.cjs")))?;
  let proxy = launch_local_proxy(app, config, script.parent().ok_or("TELEGRAM_TRANSPORT_UNAVAILABLE")?)?;
  let mut command = Command::new(node);
  crate::social_share::sanitize_media_worker_environment(&mut command);
  command.env_remove("NODE_PATH").env("WS_NO_BUFFER_UTIL", "1").env("WS_NO_UTF_8_VALIDATE", "1");
  command.arg(&script).current_dir(script.parent().ok_or("TELEGRAM_TRANSPORT_UNAVAILABLE")?)
    .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
  crate::runtime::hide_command_window(&mut command);
  {
    use std::os::windows::process::CommandExt;
    command.creation_flags(0x0800_0000);
  }
  let mut child = command.spawn().map_err(|_| "TELEGRAM_TRANSPORT_UNAVAILABLE")?;
  let ownership = match crate::worker_job::WorkerJob::attach(&child) {
    Ok(ownership) => ownership,
    Err(_) => {
      let _ = child.kill(); let _ = child.wait();
      return Err("TELEGRAM_TRANSPORT_UNAVAILABLE".into());
    }
  };
  // Читатель stderr стартует до записи настроек: иначе воркер может встать на заполненном пайпе
  let stderr_lines = Arc::new(std::sync::atomic::AtomicUsize::new(0));
  let stderr_tail = StderrTail::default();
  if let Some(stderr) = child.stderr.take() {
    let counter = stderr_lines.clone();
    let tail = stderr_tail.clone();
    let _ = std::thread::Builder::new().name("relay-telegram-transport-stderr".into()).spawn(move || {
      // В журнал идут первые STDERR_LINES_PER_WORKER строк, но считаем и храним хвост всех: последняя
      // строка (JSON от `fatal()`) обычно приходит после лимита и объясняет выход
      drain_stderr_with(stderr, usize::MAX, |line| {
        let index = counter.fetch_add(1, Ordering::Relaxed);
        tail.push(line, "");
        if index < STDERR_LINES_PER_WORKER { log::warn!("[TelegramTransport] worker stderr: {line}"); }
      });
    });
  }
  let mut worker = OwnedWorker { child, ownership, proxy, stderr_lines, stderr_tail, _directory: directory };
  let settings = serde_json::to_vec(&worker_settings(token, port, config, cfg!(debug_assertions)))
    .map_err(|_| "TELEGRAM_TRANSPORT_UNAVAILABLE")?;
  let stdin = worker.child.stdin.as_mut().ok_or("TELEGRAM_TRANSPORT_UNAVAILABLE")?;
  stdin.write_all(&settings).and_then(|_| stdin.write_all(b"\n"))
    .and_then(|_| stdin.flush()).map_err(|_| "TELEGRAM_TRANSPORT_UNAVAILABLE")?;
  Ok(worker)
}

/// Строка таблицы слушающих TCP-сокетов IPv4: локальный адрес, порт и PID владельца.
#[cfg(any(windows, test))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ListenerRow {
  addr: [u8; 4],
  port: u16,
  pid: u32,
}

/// Итог проверки владельца слушателя на порту моста.
#[cfg(any(windows, test))]
#[derive(Debug, PartialEq, Eq)]
enum ListenerOwner {
  /// Все слушатели loopback-порта принадлежат нашему процессу прокси или его потомку.
  Ours,
  /// Порт слушает посторонний процесс.
  Foreign,
  /// Проверить не удалось (ошибка API или слушателя нет в таблице) — не блокируем работу.
  Unknown,
}

/// PID слушателей на `127.0.0.1:port`. Слушатель на 0.0.0.0 не считаем: loopback-подключение
/// достаётся более конкретному bind, то есть нашему.
#[cfg(any(windows, test))]
fn loopback_listener_pids(rows: &[ListenerRow], port: u16) -> Vec<u32> {
  rows.iter().filter(|row| row.port == port && row.addr == [127, 0, 0, 1]).map(|row| row.pid).collect()
}

/// `pid` — это `root` либо его потомок по таблице «процесс -> родитель». Обход ограничен по глубине
/// (защита от циклов при повторном использовании PID). PyInstaller onefile: загрузчик -> реальный процесс.
#[cfg(any(windows, test))]
fn is_self_or_descendant(pid: u32, root: u32, parents: &std::collections::HashMap<u32, u32>) -> bool {
  let mut current = pid;
  for _ in 0..32 {
    if current == root { return true; }
    match parents.get(&current) {
      Some(&parent) if parent != 0 && parent != current => current = parent,
      _ => return false,
    }
  }
  false
}

#[cfg(any(windows, test))]
fn classify_listener(
  rows: &[ListenerRow], port: u16, root: u32, parents: &std::collections::HashMap<u32, u32>,
) -> ListenerOwner {
  let pids = loopback_listener_pids(rows, port);
  if pids.is_empty() { return ListenerOwner::Unknown; }
  if pids.iter().all(|&pid| is_self_or_descendant(pid, root, parents)) { ListenerOwner::Ours } else { ListenerOwner::Foreign }
}

#[cfg(windows)]
fn verify_listener_owner(port: u16, root_pid: u32) -> ListenerOwner {
  match (tcp_listener_rows(), process_parents()) {
    (Some(rows), Some(parents)) => classify_listener(&rows, port, root_pid, &parents),
    _ => ListenerOwner::Unknown,
  }
}

/// Слушающие TCP-сокеты IPv4 с PID владельца (GetExtendedTcpTable, TCP_TABLE_OWNER_PID_LISTENER).
#[cfg(windows)]
fn tcp_listener_rows() -> Option<Vec<ListenerRow>> {
  const AF_INET: u32 = 2;
  const TCP_TABLE_OWNER_PID_LISTENER: u32 = 3;
  const ERROR_INSUFFICIENT_BUFFER: u32 = 122;
  let mut size: u32 = 0;
  // Таблица может вырасти между вызовами, поэтому размер запрашиваем заново несколько раз
  for _ in 0..5 {
    let mut buffer = vec![0u32; (size as usize).div_ceil(4)];
    let code = unsafe {
      GetExtendedTcpTable(
        if size == 0 { std::ptr::null_mut() } else { buffer.as_mut_ptr().cast() },
        &mut size, 0, AF_INET, TCP_TABLE_OWNER_PID_LISTENER, 0)
    };
    if code == ERROR_INSUFFICIENT_BUFFER { continue; }
    if code != 0 { return None; }
    // Формат: u32 число строк, затем строки MIB_TCPROW_OWNER_PID по 6 u32
    // (state, local_addr, local_port, remote_addr, remote_port, pid)
    let count = *buffer.first()? as usize;
    let words = buffer.get(1..1 + count.checked_mul(6)?)?;
    return Some(words.chunks_exact(6).map(|row| ListenerRow {
      addr: row[1].to_ne_bytes(),
      port: u16::from_be(row[2] as u16),
      pid: row[5],
    }).collect());
  }
  None
}

/// Таблица «PID -> PID родителя» по снимку процессов (CreateToolhelp32Snapshot).
#[cfg(windows)]
pub(crate) fn process_parents() -> Option<std::collections::HashMap<u32, u32>> {
  const TH32CS_SNAPPROCESS: u32 = 2;
  #[repr(C)]
  struct ProcessEntry {
    size: u32,
    usage: u32,
    pid: u32,
    heap: usize,
    module: u32,
    threads: u32,
    parent: u32,
    priority: i32,
    flags: u32,
    exe: [u16; 260],
  }
  unsafe {
    let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if snapshot.is_null() || snapshot as isize == -1 { return None; }
    let mut entry: ProcessEntry = std::mem::zeroed();
    entry.size = std::mem::size_of::<ProcessEntry>() as u32;
    let mut parents = std::collections::HashMap::new();
    let mut more = Process32FirstW(snapshot, (&mut entry as *mut ProcessEntry).cast()) != 0;
    while more {
      parents.insert(entry.pid, entry.parent);
      more = Process32NextW(snapshot, (&mut entry as *mut ProcessEntry).cast()) != 0;
    }
    CloseHandle(snapshot);
    Some(parents)
  }
}

#[cfg(windows)]
#[link(name = "iphlpapi")]
unsafe extern "system" {
  fn GetExtendedTcpTable(
    table: *mut std::ffi::c_void, size: *mut u32, order: i32, family: u32, class: u32, reserved: u32,
  ) -> u32;
}

#[cfg(windows)]
unsafe extern "system" {
  fn CreateToolhelp32Snapshot(flags: u32, pid: u32) -> *mut std::ffi::c_void;
  fn Process32FirstW(snapshot: *mut std::ffi::c_void, entry: *mut std::ffi::c_void) -> i32;
  fn Process32NextW(snapshot: *mut std::ffi::c_void, entry: *mut std::ffi::c_void) -> i32;
  fn CloseHandle(object: *mut std::ffi::c_void) -> i32;
}

/// Заменяет в строке hex-последовательности длиной от 32 символов (токен моста, ключи) на `<скрыто>`.
#[cfg(any(windows, test))]
fn redact(line: &str) -> String {
  fn flush(run: &mut String, result: &mut String) {
    if run.len() >= 32 { result.push_str("<скрыто>"); } else { result.push_str(run); }
    run.clear();
  }
  let mut result = String::with_capacity(line.len());
  let mut run = String::new();
  for character in line.chars() {
    if character.is_ascii_hexdigit() {
      run.push(character);
    } else {
      flush(&mut run, &mut result);
      result.push(character);
    }
  }
  flush(&mut run, &mut result);
  result
}

/// Читает stderr воркера до конца (иначе он встанет на заполненном пайпе), строки режет по лимиту
/// и отдаёт в `sink` не более `STDERR_LINES_PER_WORKER` штук уже без секретов.
#[cfg(test)]
fn drain_stderr<R: std::io::Read>(reader: R, sink: impl FnMut(&str)) {
  drain_stderr_with(reader, STDERR_LINES_PER_WORKER, sink)
}

/// Строка без секретов и длиннее лимита не бывает: секрет прокси вырезается до `redact`
/// (он может быть короче 32 символов), затем скрывается длинный hex.
#[cfg(any(windows, test))]
fn sanitize_proxy_line(line: &str, secret: &str) -> String {
  let cleaned = if secret.is_empty() { line.to_string() } else { line.replace(secret, "<скрыто>") };
  redact(&cleaned).chars().take(PROXY_LOG_LINE_CHARS).collect()
}

/// Строка журнала tg-ws-proxy заслуживает записи. Формат прокси: `HH:MM:SS  LEVEL  сообщение` — тогда
/// решает уровень (WARNING и выше), и обычные INFO-закрытия сессий с именем исключения не считаются
/// предупреждениями. Строки без такого префикса (traceback, вывод PyInstaller) — по ключевым словам.
#[cfg(any(windows, test))]
fn proxy_line_is_loggable(line: &str) -> bool {
  fn is_clock(value: &str) -> bool {
    let parts: Vec<&str> = value.split(':').collect();
    parts.len() == 3 && parts.iter().all(|part| (1..=2).contains(&part.len()) && part.chars().all(|c| c.is_ascii_digit()))
  }
  let mut parts = line.split_whitespace();
  if let (Some(time), Some(level)) = (parts.next(), parts.next()) && is_clock(time) {
    return matches!(level.to_ascii_uppercase().as_str(), "WARNING" | "WARN" | "ERROR" | "CRITICAL" | "FATAL");
  }
  let lower = line.to_ascii_lowercase();
  ["warn", "error", "critical", "fatal", "traceback", "exception"].iter().any(|level| lower.contains(level))
}

/// Отбирает строки stderr прокси для журнала: только warning и выше, не больше `PROXY_LOG_LINES`
/// за окно `PROXY_LOG_WINDOW` (бюджет обновляется, число пропущенных строк сообщается в следующей
/// принятой), каждая не длиннее `PROXY_LOG_LINE_CHARS`; секрет прокси и длинный hex вырезаются.
#[cfg(any(windows, test))]
#[derive(Default)]
struct ProxyLogFilter {
  window_start: Option<Instant>,
  logged: usize,
  skipped: usize,
}

#[cfg(any(windows, test))]
impl ProxyLogFilter {
  fn accept(&mut self, line: &str, secret: &str, now: Instant) -> Option<String> {
    if !proxy_line_is_loggable(line) { return None; }
    if !matches!(self.window_start, Some(start) if now.saturating_duration_since(start) < PROXY_LOG_WINDOW) {
      self.window_start = Some(now);
      self.logged = 0;
    }
    if self.logged >= PROXY_LOG_LINES {
      self.skipped += 1;
      return None;
    }
    self.logged += 1;
    let text = sanitize_proxy_line(line, secret);
    Some(match std::mem::take(&mut self.skipped) {
      0 => text,
      skipped => format!("(пропущено строк: {skipped}) {text}"),
    })
  }
}

/// Последние строки stderr прокси любого уровня: при его выходе они показывают, чем он занимался
/// (INFO-строки фильтр в журнал не пускает, а перед падением они единственное, что есть).
#[cfg(any(windows, test))]
#[derive(Clone, Default)]
struct StderrTail(Arc<Mutex<std::collections::VecDeque<String>>>);

#[cfg(any(windows, test))]
impl StderrTail {
  fn push(&self, line: &str, secret: &str) {
    let text = sanitize_proxy_line(line.trim_end(), secret);
    if text.is_empty() { return; }
    if let Ok(mut lines) = self.0.lock() {
      if lines.len() >= PROXY_TAIL_LINES { lines.pop_front(); }
      lines.push_back(text);
    }
  }

  fn snapshot(&self) -> String {
    match self.0.lock() {
      Ok(lines) if !lines.is_empty() => lines.iter().cloned().collect::<Vec<_>>().join(" | "),
      _ => "none".to_string(),
    }
  }
}

/// Код выхода и время жизни процесса одной строкой: по ним различается убийство извне (код 1 или
/// 0xFFFFFFFF спустя часы работы), падение при старте и завершение сеанса Windows (0x40010004).
#[cfg(any(windows, test))]
fn describe_exit(code: Option<i32>, uptime: Duration) -> String {
  let seconds = uptime.as_secs();
  let uptime = if seconds < 60 {
    format!("{seconds}s")
  } else if seconds < 3600 {
    format!("{}m{:02}s", seconds / 60, seconds % 60)
  } else {
    format!("{}h{:02}m{:02}s", seconds / 3600, seconds % 3600 / 60, seconds % 60)
  };
  format!("{}, uptime={uptime}", crate::worker_job::exit_code_text(code))
}

/// Как `drain_stderr`, но с явным пределом числа строк, передаваемых в `sink`.
#[cfg(any(windows, test))]
fn drain_stderr_with<R: std::io::Read>(reader: R, max_lines: usize, mut sink: impl FnMut(&str)) {
  use std::io::{BufRead, BufReader, Read};
  let mut reader = BufReader::new(reader);
  let mut logged = 0usize;
  loop {
    let mut line = Vec::new();
    match reader.by_ref().take(STDERR_LINE_LIMIT as u64).read_until(b'\n', &mut line) {
      Ok(0) | Err(_) => return,
      Ok(_) => {}
    }
    // Хвост слишком длинной строки отбрасываем до перевода строки
    if line.last() != Some(&b'\n') && line.len() >= STDERR_LINE_LIMIT {
      let mut skipped = Vec::new();
      while let Ok(size) = reader.by_ref().take(STDERR_LINE_LIMIT as u64).read_until(b'\n', &mut skipped) {
        if size == 0 || skipped.last() == Some(&b'\n') { break; }
        skipped.clear();
      }
    }
    if logged < max_lines {
      let text = String::from_utf8_lossy(&line);
      let text = text.trim_end();
      if !text.is_empty() {
        logged += 1;
        sink(&redact(text));
      }
    }
  }
}

#[cfg(windows)]
impl Drop for OwnedWorker {
  fn drop(&mut self) {
    self.child.stdin.take();
    self.ownership.terminate();
    let _ = self.child.kill();
    let _ = self.child.wait();
  }
}

pub(crate) fn shutdown() {
  LOCAL_PROXY_READY.store(false, Ordering::Release);
  if let Ok(mut active) = ACTIVE.lock() && let Some(worker) = active.take() {
    let _ = worker.stop.send(());
    for _ in 0..20 {
      if !worker.alive.load(Ordering::Acquire) { break; }
      std::thread::sleep(Duration::from_millis(25));
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn recovery_delay_grows_to_cap_with_bounded_jitter() {
    let full: Vec<u64> = (0..8).map(|attempt| recovery_delay(attempt, 1.0).as_millis() as u64).collect();
    assert_eq!(full, vec![250, 500, 1000, 2000, 4000, 8000, 8000, 8000]);
    let half: Vec<u64> = (0..4).map(|attempt| recovery_delay(attempt, 0.0).as_millis() as u64).collect();
    assert_eq!(half, vec![125, 250, 500, 1000]);
  }

  #[test]
  fn redact_hides_tokens_and_long_hex_only() {
    let token = "a1".repeat(32);
    assert_eq!(
      redact(&format!("ws://127.0.0.1:1/apiws?token={token} failed")),
      "ws://127.0.0.1:1/apiws?token=<скрыто> failed"
    );
    assert_eq!(redact(&"f".repeat(31)), "f".repeat(31));
    assert_eq!(redact(&"F".repeat(32)), "<скрыто>");
    assert_eq!(redact("ECONNRESET: тест"), "ECONNRESET: тест");
  }

  #[test]
  fn stderr_drain_limits_lines_and_reads_to_eof() {
    let token = "0f".repeat(32);
    let mut input = format!("token={token}\n");
    input.push_str(&"x".repeat(5000));
    input.push('\n');
    for index in 0..100 { input.push_str(&format!("line {index}\n")); }
    let mut lines = Vec::new();
    drain_stderr(input.as_bytes(), |line| lines.push(line.to_string()));
    assert_eq!(lines.len(), STDERR_LINES_PER_WORKER);
    assert_eq!(lines[0], "token=<скрыто>");
    assert_eq!(lines[1].len(), STDERR_LINE_LIMIT);
    assert_eq!(lines[2], "line 0");
    assert!(lines.iter().all(|line| !line.contains(&token)));
  }

  #[test]
  fn proxy_log_filter_keeps_warnings_redacts_and_limits() {
    let secret = "s3cretvalue";
    let mut filter = ProxyLogFilter::default();
    let now = Instant::now();
    assert_eq!(filter.accept("INFO connected", secret, now), None);
    let long = format!("ERROR {secret} {} {}", "ab".repeat(20), "z".repeat(500));
    let text = filter.accept(&long, secret, now).unwrap();
    assert!(!text.contains(secret) && !text.contains(&"ab".repeat(20)));
    assert!(text.starts_with("ERROR <скрыто> <скрыто>"));
    assert_eq!(text.chars().count(), PROXY_LOG_LINE_CHARS);
    let accepted = (0..100).filter(|_| filter.accept("warning: dc failed", secret, now).is_some()).count();
    assert_eq!(accepted, PROXY_LOG_LINES - 1);
  }

  #[test]
  fn proxy_log_filter_refills_budget_after_window_and_counts_skipped() {
    let mut filter = ProxyLogFilter::default();
    let start = Instant::now();
    let line = "14:48:42  WARNING  DC2 CF proxy failed: gaierror(11001)";
    for _ in 0..PROXY_LOG_LINES { assert!(filter.accept(line, "s", start).is_some()); }
    // Всплеск не помещается в бюджет: лишнее пропускается, но считается
    assert_eq!(filter.accept(line, "s", start + Duration::from_secs(1)), None);
    assert_eq!(filter.accept(line, "s", start + Duration::from_secs(2)), None);
    // Окно прошло: бюджет обновился, и первая принятая строка сообщает о пропущенных
    let text = filter.accept(line, "s", start + PROXY_LOG_WINDOW + Duration::from_secs(1)).unwrap();
    assert!(text.starts_with("(пропущено строк: 2) 14:48:42  WARNING"), "{text}");
    let next = filter.accept(line, "s", start + PROXY_LOG_WINDOW + Duration::from_secs(2)).unwrap();
    assert!(next.starts_with("14:48:42"), "{next}");
  }

  #[test]
  fn proxy_log_filter_uses_level_for_formatted_lines_and_keywords_for_the_rest() {
    let mut filter = ProxyLogFilter::default();
    let now = Instant::now();
    // INFO с именем исключения в тексте — штатное закрытие сессии, не предупреждение
    let info = "12:33:01  INFO     DC2 WS session closed (upstream: ConnectionResetError)";
    assert_eq!(filter.accept(info, "s", now), None);
    assert!(filter.accept("12:33:02  WARNING  pool exhausted", "s", now).is_some());
    assert!(filter.accept("12:33:03  ERROR    handshake failed", "s", now).is_some());
    // traceback и вывод загрузчика PyInstaller префикса не имеют
    assert!(filter.accept("Traceback (most recent call last):", "s", now).is_some());
    assert!(filter.accept("[PYI-1234:ERROR] Failed to load Python DLL", "s", now).is_some());
    assert_eq!(filter.accept("starting proxy", "s", now), None);
  }

  #[test]
  fn stderr_tail_keeps_last_lines_of_any_level_without_secrets() {
    let tail = StderrTail::default();
    assert_eq!(tail.snapshot(), "none");
    for index in 0..8 { tail.push(&format!("12:00:0{index}  INFO  line {index}\r\n"), "s3cret"); }
    tail.push("12:00:09  INFO  key=s3cret", "s3cret");
    tail.push("   ", "s3cret");
    let snapshot = tail.snapshot();
    assert_eq!(snapshot.split(" | ").count(), PROXY_TAIL_LINES);
    assert!(snapshot.starts_with("12:00:04  INFO  line 4"), "{snapshot}");
    assert!(snapshot.ends_with("key=<скрыто>"), "{snapshot}");
    assert!(!snapshot.contains("s3cret") && !snapshot.contains('\r'));
  }

  #[test]
  fn describe_exit_formats_code_hex_and_uptime() {
    assert_eq!(describe_exit(Some(1), Duration::from_secs(7)), "code=1 (0x00000001), uptime=7s");
    assert_eq!(
      describe_exit(Some(0x4001_0004), Duration::from_secs(3723)),
      "code=1073807364 (0x40010004), uptime=1h02m03s");
    assert_eq!(describe_exit(Some(-1), Duration::from_secs(125)), "code=-1 (0xFFFFFFFF), uptime=2m05s");
    assert_eq!(describe_exit(None, Duration::ZERO), "code=unknown, uptime=0s");
  }

  #[test]
  fn worker_settings_carry_local_proxy_in_one_json_line() {
    let config = BridgeConfig { local_port: 31337, local_secret: "ab".repeat(16) };
    let value = worker_settings("t".repeat(64).as_str(), 0, &config, false);
    assert_eq!(value["localPort"], 31337);
    assert_eq!(value["localSecret"], "ab".repeat(16));
    assert!(value.get("socksPort").is_none());
    assert!(value.get("mtproxy").is_none());
    assert_eq!(value["origins"].as_array().unwrap().len(), 3);
    assert!(!serde_json::to_string(&value).unwrap().contains('\n'));
    assert_eq!(worker_settings("t", 0, &config, true)["origins"].as_array().unwrap().len(), 4);
  }

  #[test]
  fn local_proxy_config_is_independent_of_the_tunnel() {
    let first = local_bridge_config().unwrap();
    let second = local_bridge_config().unwrap();
    assert!(first.local_port >= 1024);
    assert!(uuid::Uuid::parse_str(&first.local_secret).is_ok());
    assert_ne!(first.local_secret, second.local_secret);
    let status = serde_json::to_value(TransportStatus::default()).unwrap();
    assert_eq!(status["mtproxy"], false);
    assert!(status.get("url").is_none());
  }

  #[test]
  fn recovery_delay_survives_extreme_inputs() {
    assert_eq!(recovery_delay(u32::MAX, 5.0).as_millis(), 8000);
    assert_eq!(recovery_delay(0, -1.0).as_millis(), 125);
  }

  fn rows(items: &[([u8; 4], u16, u32)]) -> Vec<ListenerRow> {
    items.iter().map(|&(addr, port, pid)| ListenerRow { addr, port, pid }).collect()
  }

  #[test]
  fn descendant_check_follows_parents_and_rejects_strangers() {
    let parents: std::collections::HashMap<u32, u32> = [(20, 10), (30, 20), (99, 1), (1, 99)].into();
    assert!(is_self_or_descendant(10, 10, &parents));
    assert!(is_self_or_descendant(30, 10, &parents)); // внук (загрузчик -> реальный процесс)
    assert!(!is_self_or_descendant(10, 30, &parents)); // предок не считается потомком
    assert!(!is_self_or_descendant(99, 10, &parents)); // чужой, цикл не зацикливает
    assert!(!is_self_or_descendant(7, 10, &parents)); // неизвестный PID
  }

  #[test]
  fn classify_listener_accepts_ours_and_rejects_foreign() {
    let parents: std::collections::HashMap<u32, u32> = [(20, 10)].into();
    let lo = [127, 0, 0, 1];
    assert_eq!(classify_listener(&rows(&[(lo, 5000, 20)]), 5000, 10, &parents), ListenerOwner::Ours);
    assert_eq!(classify_listener(&rows(&[(lo, 5000, 555)]), 5000, 10, &parents), ListenerOwner::Foreign);
    // один чужой среди своих — всё равно чужой
    assert_eq!(classify_listener(&rows(&[(lo, 5000, 20), (lo, 5000, 555)]), 5000, 10, &parents), ListenerOwner::Foreign);
    // другой порт и 0.0.0.0 не учитываются; слушателя нет — «не определено», а не «чужой»
    let other = rows(&[(lo, 5001, 555), ([0, 0, 0, 0], 5000, 555)]);
    assert_eq!(classify_listener(&other, 5000, 10, &parents), ListenerOwner::Unknown);
  }

  #[cfg(windows)]
  #[test]
  fn listener_opened_by_this_process_is_attributed_to_it() {
    let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    let me = std::process::id();
    let table = tcp_listener_rows().expect("GetExtendedTcpTable");
    assert_eq!(loopback_listener_pids(&table, port), vec![me]);
    let parents = process_parents().expect("снимок процессов");
    assert!(parents.contains_key(&me));
    assert_eq!(classify_listener(&table, port, me, &parents), ListenerOwner::Ours);
    // для «чужого» корня тот же слушатель отвергается
    assert_eq!(classify_listener(&table, port, u32::MAX - 1, &parents), ListenerOwner::Foreign);
    assert_eq!(verify_listener_owner(port, me), ListenerOwner::Ours);
  }
}
