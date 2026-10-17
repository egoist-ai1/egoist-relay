use serde::Serialize;
use std::sync::{Arc, LazyLock, Mutex, atomic::{AtomicBool, Ordering}, mpsc};
use std::time::{Duration, Instant};

const START_TIMEOUT: Duration = Duration::from_secs(15);
const STABLE_WORKER_TIME: Duration = Duration::from_secs(30);
#[cfg(any(windows, test))]
const RECOVERY_BASE_MS: u64 = 250;
#[cfg(any(windows, test))]
const RECOVERY_MAX_MS: u64 = 8000;
/// Предел строки stderr воркера и числа строк, попадающих в журнал за жизнь одного воркера.
#[cfg(any(windows, test))]
const STDERR_LINE_LIMIT: usize = 2048;
#[cfg(any(windows, test))]
const STDERR_LINES_PER_WORKER: usize = 50;
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
  let mut worker = match launch_transport(&app, &token, &config, 0) {
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
    let exit = worker.child.try_wait();
    let proxy_alive = matches!(worker.proxy.child.try_wait(), Ok(None));
    if !matches!(exit, Ok(None)) || !proxy_alive {
      LOCAL_PROXY_READY.store(false, Ordering::Release);
      crate::network::emit_status(&app);
      // Штатная остановка (выход приложения, замена воркера) — не падение, журнал не засоряем
      if !matches!(stop.try_recv(), Err(mpsc::TryRecvError::Empty)) { return; }
      if started.elapsed() >= STABLE_WORKER_TIME { recovery_attempt = 0; }
      match exit {
        Ok(Some(status)) => log::warn!(
          "[TelegramTransport] Owned bridge worker exited ({status}); recovering its local endpoint"),
        _ => log::warn!(
          "[TelegramTransport] Owned bridge worker exited (status unavailable); recovering its local endpoint"),
      }
      drop(worker);
      let mut failed_attempts: u32 = 0;
      loop {
        let delay = recovery_delay(recovery_attempt, jitter_unit());
        recovery_attempt = recovery_attempt.saturating_add(1);
        if !matches!(stop.recv_timeout(delay), Err(mpsc::RecvTimeoutError::Timeout)) { return; }
        let failure = match provider().ok_or("no bridge config")
          .and_then(|config| launch_transport(&app, &token, &config, port).map_err(|_| "launch failed")) {
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
  _directory: crate::inline_media::OwnedDirectory,
}

#[cfg(windows)]
struct OwnedLocalProxy {
  child: std::process::Child,
  ownership: crate::worker_job::WorkerJob,
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
    .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
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
  let mut proxy = OwnedLocalProxy { child, ownership };
  let address = std::net::SocketAddr::from(([127, 0, 0, 1], config.local_port));
  let deadline = Instant::now() + Duration::from_secs(8);
  while Instant::now() < deadline {
    if !matches!(proxy.child.try_wait(), Ok(None)) { return Err("TELEGRAM_LOCAL_PROXY_EXITED".into()); }
    if std::net::TcpStream::connect_timeout(&address, Duration::from_millis(100)).is_ok() { return Ok(proxy); }
    std::thread::sleep(Duration::from_millis(50));
  }
  Err("TELEGRAM_LOCAL_PROXY_START_TIMEOUT".into())
}

#[cfg(windows)]
fn launch_transport(app: &tauri::AppHandle, token: &str, config: &BridgeConfig, port: u16) -> Result<OwnedWorker, String> {
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
  if let Some(stderr) = child.stderr.take() {
    let _ = std::thread::Builder::new().name("relay-telegram-transport-stderr".into()).spawn(move || {
      drain_stderr(stderr, |line| log::warn!("[TelegramTransport] worker stderr: {line}"));
    });
  }
  let mut worker = OwnedWorker { child, ownership, proxy, _directory: directory };
  let settings = serde_json::to_vec(&worker_settings(token, port, config, cfg!(debug_assertions)))
    .map_err(|_| "TELEGRAM_TRANSPORT_UNAVAILABLE")?;
  let stdin = worker.child.stdin.as_mut().ok_or("TELEGRAM_TRANSPORT_UNAVAILABLE")?;
  stdin.write_all(&settings).and_then(|_| stdin.write_all(b"\n"))
    .and_then(|_| stdin.flush()).map_err(|_| "TELEGRAM_TRANSPORT_UNAVAILABLE")?;
  Ok(worker)
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
#[cfg(any(windows, test))]
fn drain_stderr<R: std::io::Read>(reader: R, mut sink: impl FnMut(&str)) {
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
    if logged < STDERR_LINES_PER_WORKER {
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
}
