use serde::Serialize;
use std::sync::{Arc, LazyLock, Mutex, atomic::{AtomicBool, Ordering}, mpsc};
use std::time::{Duration, Instant};

const START_TIMEOUT: Duration = Duration::from_secs(6);
const STABLE_WORKER_TIME: Duration = Duration::from_secs(30);
const MAX_RECOVERY_DELAY: u64 = 8;
static ACTIVE: LazyLock<Mutex<Option<ActiveTransport>>> = LazyLock::new(|| Mutex::new(None));

struct ActiveTransport {
  url: String,
  alive: Arc<AtomicBool>,
  stop: mpsc::Sender<()>,
}

#[derive(Serialize, Default)]
pub(crate) struct TransportStatus {
  #[serde(skip_serializing_if = "Option::is_none")]
  url: Option<String>,
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
  tauri::async_runtime::spawn_blocking(move || start_transport(app))
    .await.map_err(|_| "TELEGRAM_TRANSPORT_UNAVAILABLE".to_string())?
}

#[cfg(not(windows))]
fn start_transport(_app: tauri::AppHandle) -> Result<TransportStatus, String> {
  Ok(TransportStatus::default())
}

#[cfg(windows)]
fn start_transport(app: tauri::AppHandle) -> Result<TransportStatus, String> {
  let mut active = ACTIVE.lock().map_err(|_| "TELEGRAM_TRANSPORT_UNAVAILABLE")?;
  if let Some(worker) = active.as_ref() && worker.alive.load(Ordering::Acquire) {
    return Ok(TransportStatus { url: Some(worker.url.clone()) });
  }
  if let Some(worker) = active.take() {
    let _ = worker.stop.send(());
  }

  let token = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
  let (stop, stop_receiver) = mpsc::channel();
  let (ready, ready_receiver) = mpsc::sync_channel(1);
  let alive = Arc::new(AtomicBool::new(false));
  let worker_alive = alive.clone();
  std::thread::Builder::new().name("relay-telegram-transport".into()).spawn(move || {
    supervise_transport(app, token, stop_receiver, ready, worker_alive.clone());
    worker_alive.store(false, Ordering::Release);
  }).map_err(|_| "TELEGRAM_TRANSPORT_UNAVAILABLE")?;

  match ready_receiver.recv_timeout(START_TIMEOUT) {
    Ok(Ok(Some(url))) => {
      *active = Some(ActiveTransport { url: url.clone(), alive, stop });
      Ok(TransportStatus { url: Some(url) })
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
  stop: mpsc::Receiver<()>,
  ready: mpsc::SyncSender<Result<Option<String>, String>>,
  alive: Arc<AtomicBool>,
) {
  let mut worker = match launch_transport(&app, &token, 0) {
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
  if let Some(reason) = message.as_ref().and_then(|value| value["reason"].as_str())
    .filter(|reason| matches!(*reason, "LAGOM_CONFIG_ACCESS_DENIED" | "LAGOM_CONFIG_UNAVAILABLE"
      | "LAGOM_LISTENER_UNAVAILABLE" | "LAGOM_INVALID_CONFIG")) {
    log::warn!("[TelegramTransport] Local bridge ready; Lagom route pending: {reason}");
  }
  alive.store(true, Ordering::Release);
  let port = url::Url::parse(&url).ok().and_then(|url| url.port()).unwrap();
  if ready.send(Ok(Some(url.clone()))).is_err() { return; }

  let mut recovery_delay = 1;
  let mut started = Instant::now();
  loop {
    if !matches!(worker.child.try_wait(), Ok(None)) {
      if started.elapsed() >= STABLE_WORKER_TIME { recovery_delay = 1; }
      log::warn!("[TelegramTransport] Owned bridge worker exited; recovering its local endpoint");
      drop(worker);
      loop {
        let delay = Duration::from_secs(recovery_delay);
        recovery_delay = (recovery_delay * 2).min(MAX_RECOVERY_DELAY);
        if !matches!(stop.recv_timeout(delay), Err(mpsc::RecvTimeoutError::Timeout)) { return; }
        if let Ok(mut next) = launch_transport(&app, &token, port) {
          let message = read_status(&mut next);
          if message.as_ref().is_some_and(|value| value["status"] == "ready" && value["url"] == url) {
            worker = next;
            started = Instant::now();
            log::info!("[TelegramTransport] Owned local bridge endpoint restored");
            break;
          }
        }
      }
    }
    match stop.recv_timeout(Duration::from_millis(100)) {
      Err(mpsc::RecvTimeoutError::Timeout) => {},
      _ => break,
    }
  }
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
  _directory: crate::inline_media::OwnedDirectory,
}

#[cfg(windows)]
fn launch_transport(app: &tauri::AppHandle, token: &str, port: u16) -> Result<OwnedWorker, String> {
  use std::io::Write;
  use std::process::{Command, Stdio};
  let node = crate::runtime::find_node_binary(app).map_err(|_| "TELEGRAM_TRANSPORT_UNAVAILABLE")?;
  let directory = crate::inline_media::OwnedDirectory::create(app)?;
  let script = directory.prepare_worker("telegram-transport.cjs",
    include_str!(concat!(env!("OUT_DIR"), "/telegram-transport.cjs")))?;
  let mut command = Command::new(node);
  crate::social_share::sanitize_media_worker_environment(&mut command);
  command.env_remove("NODE_PATH").env("WS_NO_BUFFER_UTIL", "1").env("WS_NO_UTF_8_VALIDATE", "1");
  command.arg(&script).current_dir(script.parent().ok_or("TELEGRAM_TRANSPORT_UNAVAILABLE")?)
    .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
  crate::runtime::hide_command_window(&mut command);
  let mut child = command.spawn().map_err(|_| "TELEGRAM_TRANSPORT_UNAVAILABLE")?;
  let ownership = match crate::worker_job::WorkerJob::attach(&child) {
    Ok(ownership) => ownership,
    Err(_) => {
      let _ = child.kill(); let _ = child.wait();
      return Err("TELEGRAM_TRANSPORT_UNAVAILABLE".into());
    }
  };
  let mut worker = OwnedWorker { child, ownership, _directory: directory };
  let mut origins = vec!["http://tauri.localhost", "https://tauri.localhost", "tauri://localhost"];
  if cfg!(debug_assertions) { origins.push("http://localhost:1234"); }
  let settings = serde_json::to_vec(&serde_json::json!({ "token": token, "origins": origins, "port": port }))
    .map_err(|_| "TELEGRAM_TRANSPORT_UNAVAILABLE")?;
  let stdin = worker.child.stdin.as_mut().ok_or("TELEGRAM_TRANSPORT_UNAVAILABLE")?;
  stdin.write_all(&settings).and_then(|_| stdin.write_all(b"\n"))
    .and_then(|_| stdin.flush()).map_err(|_| "TELEGRAM_TRANSPORT_UNAVAILABLE")?;
  Ok(worker)
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
  if let Ok(mut active) = ACTIVE.lock() && let Some(worker) = active.take() {
    let _ = worker.stop.send(());
    for _ in 0..20 {
      if !worker.alive.load(Ordering::Acquire) { break; }
      std::thread::sleep(Duration::from_millis(25));
    }
  }
}
