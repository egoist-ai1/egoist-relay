use crate::research_spool::{self, SpoolWriter};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

const MAX_FRAME: usize = 262144;
const MAX_MEDIA: u64 = 1073741824;
const MAX_JOB_BYTES: u64 = 2147483648;
const MAX_TELEGRAM_RUNS: usize = 3;
// Last-resort ceiling for run starts, independent of the daemon pacing
const EMERGENCY_RUNS_PER_MINUTE: usize = 90;
const EMERGENCY_WINDOW: Duration = Duration::from_secs(60);
const MAX_FEATURES: usize = 16;
const MAX_WAIT_SECONDS: u64 = 86400;
const SPOOL_TERMINAL_CODES: [&str; 7] = [
  "INVALID_MEDIA",
  "MEDIA_LIMIT",
  "RESUME_MISMATCH",
  "DISK_RESERVE",
  "SPOOL_UNSAFE",
  "MEDIA_SIZE_MISMATCH",
  "SPOOL_IO",
];
static RUN_STARTS: LazyLock<Mutex<VecDeque<Instant>>> = LazyLock::new(|| Mutex::new(VecDeque::new()));
static ACTIVE: LazyLock<Mutex<Option<Bridge>>> = LazyLock::new(|| Mutex::new(None));
static FRONTEND_REGISTERED: AtomicBool = AtomicBool::new(false);
static STOPPING: AtomicBool = AtomicBool::new(false);
static STARTUP: LazyLock<Mutex<StartupState>> =
  LazyLock::new(|| Mutex::new(StartupState::default()));
static DRAINING: LazyLock<Mutex<HashMap<String, Draining>>> =
  LazyLock::new(|| Mutex::new(HashMap::new()));
static OWNER_DELIVERY: Mutex<()> = Mutex::new(());

#[derive(Default)]
struct StartupState {
  starting: Option<String>,
  attempts: u8,
  next_attempt: Option<Instant>,
  last_error: Option<String>,
}

struct Draining {
  nonce: String,
  provider: String,
}

struct Bridge {
  runtime_id: String,
  state_root: PathBuf,
  app: tauri::AppHandle,
  child: Arc<Mutex<Child>>,
  stdin: Arc<Mutex<ChildStdin>>,
  frontend_ready: bool,
  helper_pid: u32,
  helper_ready: bool,
  started_at: Instant,
  acknowledged_at: Option<Instant>,
  budget_reset: bool,
  pending: HashMap<String, Pending>,
}

struct Pending {
  nonce: String,
  method: String,
  provider: Option<String>,
  deadline: Instant,
  cancelled: bool,
  dispatched: bool,
  binding: Option<(String, String)>,
  ready_bound: bool,
  scoped: bool,
  records: HashSet<String>,
  parts: HashMap<String, (u64, bool, usize)>,
  media: HashMap<String, Media>,
  total_bytes: u64,
  spool: Option<SpoolPlan>,
  spool_writer: Option<SharedSpool>,
}

type SharedSpool = Arc<Mutex<Option<SpoolWriter>>>;

#[derive(Clone)]
struct SpoolPlan {
  key: String,
  resume_offset: u64,
}

struct Media {
  next_sequence: u64,
  bytes: u64,
  declared: Option<u64>,
  closed: bool,
  spool: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
  r#type: String,
  request_id: String,
  nonce: String,
  method: Option<String>,
  provider: Option<String>,
  operation: Option<String>,
  input: Option<Value>,
  job_id: Option<String>,
  deadline_ms: Option<u64>,
  expected_account: Option<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StartupMessage {
  r#type: String,
  protocol_version: u32,
  runtime_id: String,
  helper_pid: u32,
  code: Option<String>,
}

fn reserve_startup(
  state: &mut StartupState,
  runtime_id: &str,
  now: Instant,
) -> Result<bool, String> {
  if state.starting.is_some() {
    return Ok(false);
  }
  if state.attempts >= 3 {
    return Err("BRIDGE_RECOVERY_EXHAUSTED".into());
  }
  if state.next_attempt.is_some_and(|deadline| deadline > now) {
    return Err("BRIDGE_RECOVERY_WAIT".into());
  }
  state.attempts += 1;
  state.starting = Some(runtime_id.to_string());
  state.next_attempt = Some(now + Duration::from_secs(if state.attempts == 1 { 1 } else { 3 }));
  Ok(true)
}

fn provider_capacity(provider: Option<&str>) -> usize {
  if provider == Some("telegram") {
    MAX_TELEGRAM_RUNS
  } else {
    1
  }
}

fn draining_count(provider: Option<&str>) -> usize {
  provider.map_or(0, |provider| {
    DRAINING.lock().map_or(usize::MAX, |leases| {
      leases.values().filter(|lease| lease.provider == provider).count()
    })
  })
}

// Check-and-record: a start is counted only when it is accepted
fn emergency_check(window: &mut VecDeque<Instant>, now: Instant, cap: usize) -> Result<(), Duration> {
  while window
    .front()
    .is_some_and(|started| now.duration_since(*started) >= EMERGENCY_WINDOW)
  {
    window.pop_front();
  }
  if window.len() >= cap {
    let oldest = *window.front().unwrap();
    return Err(EMERGENCY_WINDOW.saturating_sub(now.duration_since(oldest)));
  }
  window.push_back(now);
  Ok(())
}

fn parse_spool(provider: Option<&str>, input: &Value) -> Result<Option<SpoolPlan>, ()> {
  let sink = match input.get("mediaSink") {
    None => None,
    Some(value) => Some(value.as_str().ok_or(())?),
  };
  let key = input.get("mediaKey");
  match sink {
    Some("spool") => {
      let key = key
        .and_then(Value::as_str)
        .filter(|key| research_spool::valid_key(key))
        .ok_or(())?;
      let resume_offset = match input.get("resumeOffset") {
        None => 0,
        Some(value) => value.as_u64().ok_or(())?,
      };
      if provider != Some("telegram") || resume_offset % research_spool::ALIGN != 0 {
        return Err(());
      }
      Ok(Some(SpoolPlan {
        key: key.to_string(),
        resume_offset,
      }))
    }
    None | Some("json") if key.is_none() => Ok(None),
    _ => Err(()),
  }
}

fn identifier(value: &str, maximum: usize) -> bool {
  !value.is_empty()
    && value.len() <= maximum
    && value
      .bytes()
      .all(|byte| byte.is_ascii_alphanumeric() || b"_.:-".contains(&byte))
}

fn code(value: &str) -> bool {
  !value.is_empty()
    && value.len() <= 80
    && value
      .bytes()
      .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
}

fn operation_allowed(provider: &str, operation: &str) -> bool {
  let common = matches!(
    operation,
    "discover" | "read" | "search" | "channel_history" | "chat_export" | "download"
  );
  match provider {
    "telegram" => {
      common
        || matches!(
          operation,
          "chat_info" | "join_chat" | "probe" | "comments" | "topics" | "similar_channels" | "invite_preview"
        )
    }
    "x" => common || matches!(operation, "profile" | "article" | "read_thread"),
    "instagram" => common || matches!(operation, "profile" | "read_thread"),
    _ => false,
  }
}

fn valid_input(value: &Value, depth: usize, nodes: &mut usize) -> bool {
  *nodes += 1;
  if depth > 12 || *nodes > 10000 {
    return false;
  }
  match value {
    Value::Array(items) => {
      items.len() <= 1000 && items.iter().all(|item| valid_input(item, depth + 1, nodes))
    }
    Value::Object(items) => items.iter().all(|(key, item)| {
      !matches!(
        key.as_str(),
        "script"
          | "eval"
          | "method"
          | "args"
          | "headers"
          | "cookies"
          | "session"
          | "authKey"
          | "accessHash"
          | "outputDirectory"
          | "stateRoot"
          | "path"
          | "expectedAccount"
          | "__proto__"
          | "prototype"
          | "constructor"
      ) && valid_input(item, depth + 1, nodes)
    }),
    _ => true,
  }
}

fn trusted_main(webview: &tauri::Webview) -> bool {
  if webview.label() != "main" {
    return false;
  }
  let Ok(origin) = webview.url() else {
    return false;
  };
  (origin.scheme() == "tauri" && origin.host_str() == Some("localhost"))
    || (matches!(origin.scheme(), "http" | "https")
      && origin.host_str() == Some("tauri.localhost")
      && origin.port().is_none())
    || (cfg!(debug_assertions)
      && origin.scheme() == "http"
      && origin.host_str() == Some("localhost")
      && origin.port() == Some(1234))
}

fn resource(app: &tauri::AppHandle, name: &str) -> Result<PathBuf, String> {
  let mut candidates = Vec::new();
  if let Ok(directory) = app.path().resource_dir() {
    candidates.push(directory.join("runtime/research").join(name));
  }
  if let Ok(executable) = std::env::current_exe()
    && let Some(directory) = executable.parent()
  {
    candidates.push(directory.join("runtime/research").join(name));
    candidates.push(directory.join("resources/runtime/research").join(name));
  }
  #[cfg(debug_assertions)]
  candidates.push(
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
      .join("../runtime/research")
      .join(name),
  );
  candidates
    .into_iter()
    .find(|candidate| candidate.is_file())
    .ok_or_else(|| "BRIDGE_RESOURCE_MISSING".into())
}

#[cfg(windows)]
fn process_started_at() -> Result<u64, String> {
  #[repr(C)]
  #[derive(Default)]
  struct FileTime {
    low: u32,
    high: u32,
  }
  #[link(name = "kernel32")]
  unsafe extern "system" {
    fn GetCurrentProcess() -> *mut std::ffi::c_void;
    fn GetProcessTimes(
      process: *mut std::ffi::c_void,
      created: *mut FileTime,
      exited: *mut FileTime,
      kernel: *mut FileTime,
      user: *mut FileTime,
    ) -> i32;
  }
  let (mut created, mut exited, mut kernel, mut user) = (
    FileTime::default(),
    FileTime::default(),
    FileTime::default(),
    FileTime::default(),
  );
  if unsafe {
    GetProcessTimes(
      GetCurrentProcess(),
      &mut created,
      &mut exited,
      &mut kernel,
      &mut user,
    )
  } == 0
  {
    return Err("BRIDGE_PROCESS_IDENTITY_UNAVAILABLE".into());
  }
  (((created.high as u64) << 32 | created.low as u64) / 10000)
    .checked_sub(11644473600000)
    .ok_or_else(|| "BRIDGE_PROCESS_IDENTITY_UNAVAILABLE".into())
}

fn write_event(
  stdin: &Arc<Mutex<ChildStdin>>,
  request_id: &str,
  nonce: &str,
  event: Value,
) -> Result<(), String> {
  let mut bytes =
    serde_json::to_vec(&json!({"type":"event","requestId":request_id,"nonce":nonce,"event":event}))
      .map_err(|_| "INVALID_EVENT")?;
  if bytes.len() > MAX_FRAME {
    return Err("FRAME_TOO_LARGE".into());
  }
  bytes.push(b'\n');
  let mut writer = stdin.lock().map_err(|_| "BRIDGE_UNAVAILABLE")?;
  writer
    .write_all(&bytes)
    .and_then(|()| writer.flush())
    .map_err(|_| "BRIDGE_UNAVAILABLE".into())
}

fn cancel_owner(app: &tauri::AppHandle, request_id: &str, nonce: &str, provider: Option<&str>) {
  let Ok(_delivery) = OWNER_DELIVERY.lock() else {
    return;
  };
  if matches!(provider, Some("x" | "instagram")) {
    crate::research_social::cancel(request_id, nonce);
  } else {
    let _ = app.emit_to(
      "main",
      "relay-research-cancel",
      json!({"requestId":request_id,"nonce":nonce}),
    );
  }
}

fn cancel(expected_runtime: &str, request_id: &str, nonce: &str) {
  let target = {
    let Ok(mut active) = ACTIVE.lock() else {
      return;
    };
    let Some(bridge) = active
      .as_mut()
      .filter(|bridge| bridge.runtime_id == expected_runtime)
    else {
      return;
    };
    let Some(pending) = bridge.pending.get_mut(request_id) else {
      return;
    };
    if pending.nonce != nonce || pending.cancelled {
      return;
    }
    pending.cancelled = true;
    if !pending.dispatched {
      bridge.pending.remove(request_id);
      return;
    }
    Some((bridge.app.clone(), pending.provider.clone()))
  };
  if let Some((app, provider)) = target {
    cancel_owner(&app, request_id, nonce, provider.as_deref());
  }
}

fn dispatch(app: &tauri::AppHandle, expected_runtime: &str, request: Request) {
  if !identifier(&request.request_id, 64)
    || request.nonce.len() != 64
    || !request.nonce.bytes().all(|byte| byte.is_ascii_hexdigit())
  {
    return;
  }
  if request.r#type == "cancel" {
    cancel(expected_runtime, &request.request_id, &request.nonce);
    return;
  }
  let method = request.method.as_deref().unwrap_or("");
  let deadline_ms = request.deadline_ms.unwrap_or(0);
  let provider = request.provider.as_deref();
  let operation = request.operation.as_deref();
  let mut input = request.input.clone().unwrap_or_else(|| json!({}));
  let expected_binding = request.expected_account.as_ref().and_then(binding);
  let mut nodes = 0;
  let run = method == "run";
  let spool_plan = parse_spool(provider, &input);
  let valid = request.r#type == "request"
    && spool_plan.is_ok()
    && matches!(method, "status" | "capabilities" | "run")
    && (1..=300000).contains(&deadline_ms)
    && ((run
      && provider.is_some_and(|name| operation.is_some_and(|op| operation_allowed(name, op)))
      && request
        .job_id
        .as_deref()
        .is_some_and(|id| identifier(id, 128))
      && expected_binding.is_some()
      && input.is_object()
      && serde_json::to_vec(&input).is_ok_and(|bytes| bytes.len() <= 65536)
      && valid_input(&input, 0, &mut nodes))
      || (!run
        && request.provider.is_none()
        && request.operation.is_none()
        && request.job_id.is_none()
        && request.expected_account.is_none()
        && request.input.is_none()));
  let registration = {
    let Ok(mut active) = ACTIVE.lock() else {
      return;
    };
    let Some(bridge) = active
      .as_mut()
      .filter(|bridge| bridge.runtime_id == expected_runtime)
    else {
      return;
    };
    let fail: Option<(&str, Option<Duration>)> = if !valid {
      Some(("INVALID_REQUEST", None))
    } else if bridge.pending.contains_key(&request.request_id) {
      Some(("REQUEST_REPLAY", None))
    } else if bridge.pending.len() >= 16 {
      Some(("BRIDGE_BUSY", None))
    } else if run
      && draining_count(provider).saturating_add(
        bridge
          .pending
          .values()
          .filter(|item| item.provider.as_deref() == provider)
          .count(),
      ) >= provider_capacity(provider)
    {
      Some(("PROVIDER_BUSY", None))
    } else if !bridge.helper_ready
      || ((provider.is_none() || provider == Some("telegram")) && !bridge.frontend_ready)
    {
      Some(("INITIALIZING", None))
    } else if run && provider == Some("telegram") {
      match RUN_STARTS.lock() {
        Ok(mut window) => emergency_check(&mut window, Instant::now(), EMERGENCY_RUNS_PER_MINUTE)
          .err()
          .map(|wait| ("RATE_LIMITED", Some(wait))),
        Err(_) => Some(("BRIDGE_UNAVAILABLE", None)),
      }
    } else {
      None
    };
    if let Some((reason, wait)) = fail {
      Err((bridge.stdin.clone(), reason, wait))
    } else {
      bridge.pending.insert(
        request.request_id.clone(),
        Pending {
          nonce: request.nonce.clone(),
          method: method.to_string(),
          provider: request.provider.clone(),
          deadline: Instant::now() + Duration::from_millis(deadline_ms),
          cancelled: false,
          dispatched: false,
          binding: expected_binding,
          ready_bound: false,
          scoped: false,
          records: HashSet::new(),
          parts: HashMap::new(),
          media: HashMap::new(),
          total_bytes: 0,
          spool: spool_plan.clone().ok().flatten(),
          spool_writer: None,
        },
      );
      Ok(())
    }
  };
  if let Err((stdin, reason, wait)) = registration {
    let mut event = json!({"kind":"error","code":reason,"reason":reason});
    if let Some(wait) = wait {
      let seconds = wait.as_secs().saturating_add(1).min(MAX_WAIT_SECONDS);
      event["seconds"] = json!(seconds);
      event["retryAfterMs"] = json!(seconds * 1000);
      event["waitKind"] = json!("EMERGENCY_CAP");
    }
    let _ = write_event(&stdin, &request.request_id, &request.nonce, event);
    return;
  }
  let Ok(_delivery) = OWNER_DELIVERY.lock() else {
    return;
  };
  {
    let Ok(mut active) = ACTIVE.lock() else {
      return;
    };
    let Some(bridge) = active
      .as_mut()
      .filter(|bridge| bridge.runtime_id == expected_runtime)
    else {
      return;
    };
    let Some(pending) = bridge.pending.get_mut(&request.request_id) else {
      return;
    };
    if pending.nonce != request.nonce || pending.cancelled || pending.deadline <= Instant::now() {
      if !pending.dispatched {
        bridge.pending.remove(&request.request_id);
      }
      return;
    }
    pending.dispatched = true;
  }
  if matches!(provider, Some("x" | "instagram")) {
    input["expectedAccount"] = request.expected_account.clone().unwrap();
    if let Err(reason) = crate::research_social::dispatch(
      app,
      &request.request_id,
      &request.nonce,
      provider.unwrap(),
      operation.unwrap(),
      input,
      request.job_id.as_deref().unwrap(),
      deadline_ms,
    ) {
      let stable = if code(&reason) {
        reason
      } else {
        "PROVIDER_ERROR".into()
      };
      let _ = publish(
        &request.request_id,
        &request.nonce,
        json!({"kind":"error","code":stable}),
      );
    }
  } else {
    let event = json!({"requestId":request.request_id,"nonce":request.nonce,"method":method,"provider":request.provider,"operation":request.operation,"input":input,"jobId":request.job_id,"deadlineMs":deadline_ms,"expectedAccount":request.expected_account});
    if app
      .emit_to("main", "relay-research-request", event)
      .is_err()
    {
      let _ = publish(
        &request.request_id,
        &request.nonce,
        json!({"kind":"error","code":"BRIDGE_UNAVAILABLE"}),
      );
    }
  }
}

fn read_frame(reader: &mut impl BufRead) -> std::io::Result<Option<Vec<u8>>> {
  let mut bytes = Vec::new();
  loop {
    let available = reader.fill_buf()?;
    if available.is_empty() {
      return if bytes.is_empty() {
        Ok(None)
      } else {
        Err(std::io::Error::other("INCOMPLETE_FRAME"))
      };
    }
    let newline = available.iter().position(|byte| *byte == b'\n');
    let count = newline.map_or(available.len(), |index| index + 1);
    if bytes.len() + count > MAX_FRAME + usize::from(newline.is_some()) {
      return Err(std::io::Error::other("FRAME_TOO_LARGE"));
    }
    bytes.extend_from_slice(&available[..count]);
    reader.consume(count);
    if newline.is_some() {
      bytes.pop();
      return Ok(Some(bytes));
    }
  }
}

#[cfg(not(windows))]
pub(crate) fn start(_app: &tauri::AppHandle) -> Result<(), String> {
  Ok(())
}

#[cfg(windows)]
pub(crate) fn start(app: &tauri::AppHandle) -> Result<(), String> {
  let isolated_test = std::env::var("EGOIST_RELAY_SMOKE_TEST").as_deref() == Ok("1");
  if isolated_test && std::env::var("EGOIST_RELAY_RESEARCH_TEST").as_deref() != Ok("1") {
    return Ok(());
  }
  if STOPPING.load(Ordering::Acquire) {
    return Err("BRIDGE_SHUTTING_DOWN".into());
  }
  if ACTIVE.lock().map_err(|_| "BRIDGE_UNAVAILABLE")?.is_some() {
    return Ok(());
  }
  let runtime_id = uuid::Uuid::new_v4().to_string();
  if !reserve_startup(
    &mut *STARTUP.lock().map_err(|_| "BRIDGE_UNAVAILABLE")?,
    &runtime_id,
    Instant::now(),
  )? {
    return Ok(());
  }
  let startup_app = app.clone();
  let startup_runtime = runtime_id.clone();
  if std::thread::Builder::new()
    .name("relay-research-start".into())
    .spawn(move || {
      if let Err(reason) = start_owned(&startup_app, &startup_runtime, isolated_test) {
        startup_failed(&startup_runtime, &reason);
        schedule_recovery(&startup_app);
      }
    })
    .is_err()
  {
    startup_failed(&runtime_id, "BRIDGE_START_FAILED");
    return Err("BRIDGE_START_FAILED".into());
  }
  Ok(())
}

#[cfg(windows)]
fn start_owned(
  app: &tauri::AppHandle,
  runtime_id: &str,
  isolated_test: bool,
) -> Result<(), String> {
  if STOPPING.load(Ordering::Acquire) {
    return Err("BRIDGE_SHUTTING_DOWN".into());
  }
  let node = crate::runtime::find_node_binary(app).map_err(|_| "BRIDGE_RUNTIME_UNAVAILABLE")?;
  let script = resource(app, "bridge-server.mjs")?;
  let _privacy = resource(app, "ensure-private-state.ps1")?;
  let state_root = if isolated_test {
    PathBuf::from(std::env::var_os("EGOIST_RELAY_TEST_PROFILE").ok_or("BRIDGE_TEST_SCOPE_INVALID")?)
      .join("research")
  } else {
    PathBuf::from(std::env::var_os("USERPROFILE").ok_or("BRIDGE_STATE_UNAVAILABLE")?)
      .join(".egoist-research")
  };
  if !state_root.is_absolute() {
    return Err("BRIDGE_STATE_UNAVAILABLE".into());
  }
  let app_started_at = process_started_at()?;
  let executable_path =
    std::env::current_exe().map_err(|_| "BRIDGE_PROCESS_IDENTITY_UNAVAILABLE")?;
  let mut command = Command::new(node);
  command
    .arg(script)
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::null());
  crate::runtime::hide_command_window(&mut command);
  let mut child = command.spawn().map_err(|_| "BRIDGE_START_FAILED")?;
  let helper_pid = child.id();
  let mut stdin = child.stdin.take().ok_or("BRIDGE_START_FAILED")?;
  let stdout = child.stdout.take().ok_or("BRIDGE_START_FAILED")?;
  let init = json!({"type":"init","protocolVersion":1,"runtimeId":runtime_id,"appPid":std::process::id(),"appStartedAt":app_started_at,
    "executablePath":executable_path,"stateRoot":state_root,"isolatedTest":isolated_test});
  if writeln!(stdin, "{init}")
    .and_then(|()| stdin.flush())
    .is_err()
  {
    let _ = child.kill();
    let _ = child.wait();
    return Err("BRIDGE_START_FAILED".into());
  }
  let child = Arc::new(Mutex::new(child));
  let stdin = Arc::new(Mutex::new(stdin));
  let mut active = ACTIVE.lock().map_err(|_| "BRIDGE_UNAVAILABLE")?;
  if active.is_some() || STOPPING.load(Ordering::Acquire) {
    drop(stdin);
    if let Ok(mut child) = child.lock() {
      let _ = child.kill();
      let _ = child.wait();
    }
    return Err("BRIDGE_START_SUPERSEDED".into());
  }
  *active = Some(Bridge {
    runtime_id: runtime_id.to_string(),
    state_root: state_root.clone(),
    app: app.clone(),
    child,
    stdin,
    frontend_ready: FRONTEND_REGISTERED.load(Ordering::Acquire),
    helper_pid,
    helper_ready: false,
    started_at: Instant::now(),
    acknowledged_at: None,
    budget_reset: false,
    pending: HashMap::new(),
  });
  drop(active);
  let reader_app = app.clone();
  let reader_runtime = runtime_id.to_string();
  std::thread::spawn(move || {
    let mut reader = BufReader::new(stdout);
    loop {
      match read_frame(&mut reader) {
        Ok(Some(bytes)) => {
          let Ok(frame) = serde_json::from_slice::<Value>(&bytes) else {
            break;
          };
          if matches!(
            frame.get("type").and_then(Value::as_str),
            Some("startup_ready" | "startup_error")
          ) {
            let Ok(message) = serde_json::from_value::<StartupMessage>(frame) else {
              break;
            };
            if !accept_startup(&reader_runtime, message) {
              break;
            }
          } else {
            let Ok(request) = serde_json::from_value::<Request>(frame) else {
              break;
            };
            dispatch(&reader_app, &reader_runtime, request);
          }
        }
        _ => break,
      }
    }
    shutdown_runtime(&reader_runtime);
    schedule_recovery(&reader_app);
  });
  let runtime_id = runtime_id.to_string();
  std::thread::spawn(move || {
    loop {
      std::thread::sleep(Duration::from_millis(250));
      let expired = {
        let Ok(mut active) = ACTIVE.lock() else {
          return;
        };
        let Some(bridge) = active
          .as_mut()
          .filter(|bridge| bridge.runtime_id == runtime_id)
        else {
          return;
        };
        if !bridge.helper_ready && bridge.started_at.elapsed() >= Duration::from_secs(45) {
          drop(active);
          startup_failed(&runtime_id, "BRIDGE_STARTUP_TIMEOUT");
          shutdown_runtime(&runtime_id);
          return;
        }
        if bridge.helper_ready
          && !bridge.budget_reset
          && bridge
            .acknowledged_at
            .is_some_and(|started| started.elapsed() >= Duration::from_secs(30))
        {
          if let Ok(mut startup) = STARTUP.lock() {
            if startup.starting.is_none() {
              startup.attempts = 0;
              startup.next_attempt = None;
              startup.last_error = None;
              bridge.budget_reset = true;
            }
          }
        }
        let ids = bridge
          .pending
          .iter()
          .filter(|(_, item)| {
            item.deadline <= Instant::now() && (!item.cancelled || item.method != "run")
          })
          .map(|(id, _)| id.clone())
          .collect::<Vec<_>>();
        let mut expired = Vec::new();
        for id in ids {
          let Some(pending) = bridge.pending.get_mut(&id) else {
            continue;
          };
          let notify = !pending.cancelled;
          pending.cancelled = true;
          let non_run = pending.method != "run";
          expired.push((
            bridge.app.clone(),
            bridge.stdin.clone(),
            id.clone(),
            pending.nonce.clone(),
            pending.provider.clone(),
            notify,
          ));
          if non_run {
            bridge.pending.remove(&id);
          }
        }
        expired
      };
      for (app, stdin, id, nonce, provider, notify) in expired {
        cancel_owner(&app, &id, &nonce, provider.as_deref());
        if notify {
          let _ = write_event(
            &stdin,
            &id,
            &nonce,
            json!({"kind":"error","code":"DEADLINE_EXCEEDED","reason":"DEADLINE_EXCEEDED","completionUncertain":provider.is_some()}),
          );
        }
      }
    }
  });
  Ok(())
}

fn startup_code(reason: &str) -> &'static str {
  match reason {
    "WINDOWS_REQUIRED" => "WINDOWS_REQUIRED",
    "INIT_DENIED" => "INIT_DENIED",
    "BRIDGE_ALREADY_RUNNING" => "BRIDGE_ALREADY_RUNNING",
    "BRIDGE_RESOURCE_MISSING" => "BRIDGE_RESOURCE_MISSING",
    "BRIDGE_RUNTIME_UNAVAILABLE" => "BRIDGE_RUNTIME_UNAVAILABLE",
    "BRIDGE_STATE_UNAVAILABLE" => "BRIDGE_STATE_UNAVAILABLE",
    "BRIDGE_TEST_SCOPE_INVALID" => "BRIDGE_TEST_SCOPE_INVALID",
    "BRIDGE_PROCESS_IDENTITY_UNAVAILABLE" => "BRIDGE_PROCESS_IDENTITY_UNAVAILABLE",
    "BRIDGE_START_SUPERSEDED" => "BRIDGE_START_SUPERSEDED",
    "BRIDGE_STARTUP_PROTOCOL" => "BRIDGE_STARTUP_PROTOCOL",
    "BRIDGE_STARTUP_TIMEOUT" => "BRIDGE_STARTUP_TIMEOUT",
    "BRIDGE_HELPER_EOF" => "BRIDGE_HELPER_EOF",
    "BRIDGE_SHUTTING_DOWN" => "BRIDGE_SHUTTING_DOWN",
    "RESEARCH_STATE_SCOPE_INVALID" => "RESEARCH_STATE_SCOPE_INVALID",
    "RESEARCH_STATE_REPARSE_DENIED" => "RESEARCH_STATE_REPARSE_DENIED",
    "RESEARCH_STATE_FILE_INVALID" => "RESEARCH_STATE_FILE_INVALID",
    "RESEARCH_STATE_FILE_OVERSIZED" => "RESEARCH_STATE_FILE_OVERSIZED",
    "RESEARCH_STATE_OWNER_MISMATCH" => "RESEARCH_STATE_OWNER_MISMATCH",
    "RESEARCH_STATE_ACL_UNEXPECTED" => "RESEARCH_STATE_ACL_UNEXPECTED",
    "RESEARCH_STATE_ACL_NOT_PRIVATE" => "RESEARCH_STATE_ACL_NOT_PRIVATE",
    "RESEARCH_STATE_ACL_INCOMPLETE" => "RESEARCH_STATE_ACL_INCOMPLETE",
    "RESEARCH_STATE_UNOWNED" => "RESEARCH_STATE_UNOWNED",
    "RESEARCH_STATE_MISSING" => "RESEARCH_STATE_MISSING",
    "RESEARCH_STATE_NOT_PRIVATE" => "RESEARCH_STATE_NOT_PRIVATE",
    "RESEARCH_STATE_MARKER_INVALID" => "RESEARCH_STATE_MARKER_INVALID",
    "RESEARCH_STATE_INITIALIZATION_BUSY" => "RESEARCH_STATE_INITIALIZATION_BUSY",
    "RESEARCH_TEST_SCOPE_INVALID" => "RESEARCH_TEST_SCOPE_INVALID",
    _ => "BRIDGE_START_FAILED",
  }
}

fn startup_failed(runtime_id: &str, reason: &str) {
  let stable = startup_code(reason);
  if let Ok(mut startup) = STARTUP.lock() {
    if startup
      .starting
      .as_deref()
      .is_some_and(|current| current != runtime_id)
    {
      return;
    }
    startup.starting = None;
    startup.last_error = Some(stable.to_string());
  }
  if !STOPPING.load(Ordering::Acquire) {
    log::warn!("[EgoistRelay] Research helper unavailable: {stable}");
  }
}

fn accept_startup(runtime_id: &str, message: StartupMessage) -> bool {
  if message.protocol_version != 1 || message.runtime_id != runtime_id {
    startup_failed(runtime_id, "BRIDGE_STARTUP_PROTOCOL");
    return false;
  }
  let accepted = {
    let Ok(mut active) = ACTIVE.lock() else {
      return false;
    };
    let Some(bridge) = active
      .as_mut()
      .filter(|bridge| bridge.runtime_id == runtime_id)
    else {
      return false;
    };
    if bridge.helper_pid != message.helper_pid || bridge.helper_ready {
      false
    } else if message.r#type == "startup_ready" && message.code.is_none() {
      bridge.helper_ready = true;
      bridge.acknowledged_at = Some(Instant::now());
      bridge.frontend_ready = FRONTEND_REGISTERED.load(Ordering::Acquire);
      true
    } else if message.r#type == "startup_error" && message.code.is_some() {
      drop(active);
      startup_failed(runtime_id, message.code.as_deref().unwrap());
      return false;
    } else {
      false
    }
  };
  if !accepted {
    startup_failed(runtime_id, "BRIDGE_STARTUP_PROTOCOL");
    return false;
  }
  if let Ok(mut startup) = STARTUP.lock() {
    if startup.starting.as_deref() == Some(runtime_id) {
      startup.starting = None;
      startup.last_error = None;
    }
  }
  log::info!("[EgoistRelay] Research helper ready");
  true
}

fn schedule_recovery(app: &tauri::AppHandle) {
  if STOPPING.load(Ordering::Acquire) {
    return;
  }
  let delay = {
    let Ok(startup) = STARTUP.lock() else {
      return;
    };
    if startup.attempts >= 3 || startup.starting.is_some() {
      return;
    }
    startup
      .next_attempt
      .map_or(Duration::from_millis(250), |deadline| {
        deadline
          .saturating_duration_since(Instant::now())
          .max(Duration::from_millis(250))
      })
  };
  let recovery_app = app.clone();
  let _ = std::thread::Builder::new()
    .name("relay-research-recover".into())
    .spawn(move || {
      std::thread::sleep(delay);
      let _ = start(&recovery_app);
    });
}

fn shutdown_runtime(runtime_id: &str) {
  let bridge = ACTIVE.lock().ok().and_then(|mut active| {
    if active
      .as_ref()
      .is_some_and(|bridge| bridge.runtime_id == runtime_id)
    {
      let bridge = active.take()?;
      if let Ok(mut draining) = DRAINING.lock() {
        for (id, pending) in &bridge.pending {
          if pending.method == "run" && pending.dispatched {
            if let Some(provider) = &pending.provider {
              draining.insert(
                id.clone(),
                Draining {
                  nonce: pending.nonce.clone(),
                  provider: provider.clone(),
                },
              );
            }
          }
        }
      }
      Some(bridge)
    } else {
      None
    }
  });
  if let Some(bridge) = bridge {
    if !bridge.helper_ready {
      let needs_reason = STARTUP
        .lock()
        .is_ok_and(|startup| startup.last_error.is_none());
      if needs_reason {
        startup_failed(runtime_id, "BRIDGE_HELPER_EOF");
      }
    }
    for (id, pending) in &bridge.pending {
      let _ = write_event(
        &bridge.stdin,
        id,
        &pending.nonce,
        json!({"kind":"error","code":"RUNTIME_CHANGED","reason":"RUNTIME_CHANGED","completionUncertain":pending.method == "run"}),
      );
      cancel_owner(&bridge.app, id, &pending.nonce, pending.provider.as_deref());
    }
    // Dropping the only parent stdin closes the app-owned helper and its owned metadata.
    drop(bridge.stdin);
    if let Ok(mut child) = bridge.child.lock() {
      for _ in 0..20 {
        if child.try_wait().ok().flatten().is_some() {
          return;
        }
        std::thread::sleep(Duration::from_millis(25));
      }
      let _ = child.kill();
      let _ = child.wait();
    }
  }
}

pub(crate) fn shutdown() {
  STOPPING.store(true, Ordering::Release);
  let runtime_id = ACTIVE
    .lock()
    .ok()
    .and_then(|active| active.as_ref().map(|bridge| bridge.runtime_id.clone()));
  if let Some(runtime_id) = runtime_id {
    shutdown_runtime(&runtime_id);
  }
}

fn epoch(value: &Value) -> Option<String> {
  if let Some(value) = value.as_str() {
    identifier(value, 128).then(|| value.to_string())
  } else {
    value.as_u64().map(|value| value.to_string())
  }
}

fn binding(event: &Value) -> Option<(String, String)> {
  let account_ref = event.get("accountRef")?.as_str()?;
  if !identifier(account_ref, 160) {
    return None;
  }
  Some((account_ref.to_string(), epoch(event.get("accountEpoch")?)?))
}

fn decoded_size(base64: &str) -> Option<u64> {
  if base64.is_empty() || base64.len() > 65536 || base64.len() % 4 != 0 {
    return None;
  }
  let padding = base64
    .bytes()
    .rev()
    .take_while(|byte| *byte == b'=')
    .count();
  if padding > 2
    || !base64[..base64.len() - padding]
      .bytes()
      .all(|byte| byte.is_ascii_alphanumeric() || b"+/".contains(&byte))
  {
    return None;
  }
  Some((base64.len() / 4 * 3 - padding) as u64)
}

fn validate_event(pending: &mut Pending, event: &mut Value) -> Result<bool, String> {
  let kind = event
    .get("kind")
    .and_then(Value::as_str)
    .unwrap_or("")
    .to_string();
  if kind == "error" {
    let raw_code = event
      .get("code")
      .and_then(Value::as_str)
      .unwrap_or("PROVIDER_ERROR");
    let stable = if code(raw_code) {
      raw_code.to_string()
    } else {
      "PROVIDER_ERROR".to_string()
    };
    event["code"] = Value::String(stable.clone());
    let uncertain = event.get("completionUncertain").and_then(Value::as_bool) == Some(true);
    event["reason"] = Value::String(if uncertain {
      if matches!(stable.as_str(), "CANCELLED" | "DEADLINE_EXCEEDED") {
        "cancelled_completion_uncertain".into()
      } else {
        "remote_completion_uncertain".into()
      }
    } else {
      stable
    });
    if !uncertain {
      event.as_object_mut().unwrap().remove("completionUncertain");
    }
    sanitize_wait(event);
    return Ok(true);
  }
  if kind == "status" {
    let providers = event
      .get_mut("providers")
      .and_then(Value::as_array_mut)
      .ok_or("INVALID_STATUS")?;
    if providers.is_empty() || providers.len() > 3 {
      return Err("INVALID_STATUS".into());
    }
    let mut seen = HashSet::new();
    for item in providers.iter_mut() {
      let provider = item
        .get("provider")
        .and_then(Value::as_str)
        .ok_or("INVALID_STATUS")?
        .to_string();
      let state = item
        .get("state")
        .and_then(Value::as_str)
        .ok_or("INVALID_STATUS")?
        .to_string();
      if !matches!(provider.as_str(), "telegram" | "x" | "instagram")
        || !seen.insert(provider.clone())
        || !matches!(
          state.as_str(),
          "ready"
            | "initializing"
            | "auth_required"
            | "challenge_required"
            | "rate_limited"
            | "unavailable"
            | "unsupported"
        )
      {
        return Err("INVALID_STATUS".into());
      }
      if let Some(ops) = item.get("operations") {
        if !ops.as_array().is_some_and(|ops| {
          ops.len() <= 16
            && ops.iter().all(|op| {
              op.as_str()
                .is_some_and(|op| operation_allowed(&provider, op))
            })
        }) {
          return Err("INVALID_STATUS".into());
        }
      }
      let reason = item
        .get("reason")
        .and_then(Value::as_str)
        .filter(|reason| code(reason))
        .map_or_else(|| state.to_ascii_uppercase(), str::to_string);
      let fields = item.as_object_mut().ok_or("INVALID_STATUS")?;
      fields.retain(|key, _| {
        matches!(
          key.as_str(),
          "provider"
            | "state"
            | "reason"
            | "operations"
            | "accountRef"
            | "accountEpoch"
            | "maxConcurrent"
            | "features"
        )
      });
      sanitize_capabilities(fields, provider == "telegram");
      fields.insert("reason".into(), Value::String(reason));
    }
    if pending.method != "run" {
      return Ok(true);
    }
    let item = providers
      .iter()
      .find(|item| item.get("provider").and_then(Value::as_str) == pending.provider.as_deref())
      .ok_or("INVALID_STATUS")?;
    if item.get("state").and_then(Value::as_str) != Some("ready") {
      return Err("ACCOUNT_UNAVAILABLE".into());
    }
    let current = binding(item).ok_or("INVALID_ACCOUNT_SCOPE")?;
    if pending
      .binding
      .as_ref()
      .is_some_and(|previous| previous != &current)
    {
      return Err("STALE_ACCOUNT".into());
    }
    pending.binding = Some(current);
    pending.ready_bound = true;
    return Ok(false);
  }
  if pending.method != "run" {
    return Err("INVALID_EVENT".into());
  }
  if !matches!(
    kind.as_str(),
    "scope" | "records" | "media_open" | "media_chunk" | "media_close" | "done"
  ) {
    return Err("INVALID_EVENT".into());
  }
  let current = binding(event).ok_or("INVALID_ACCOUNT_SCOPE")?;
  if pending.binding.as_ref() != Some(&current) {
    return Err("STALE_ACCOUNT".into());
  }
  if kind == "scope" {
    if !pending.ready_bound {
      return Err("ACCOUNT_SCOPE_REQUIRED".into());
    }
    pending.scoped = true;
    return Ok(false);
  }
  if !pending.scoped {
    return Err("ACCOUNT_SCOPE_REQUIRED".into());
  }
  match kind.as_str() {
    "records" => {
      let records = event
        .get("records")
        .and_then(Value::as_array)
        .ok_or("INVALID_RECORDS")?;
      if records.len() > 100 {
        return Err("INVALID_RECORDS".into());
      }
      for record in records {
        let id = record
          .get("id")
          .and_then(Value::as_str)
          .filter(|id| !id.is_empty() && id.len() <= 512)
          .ok_or("INVALID_RECORDS")?;
        let record_type = record
          .get("type")
          .and_then(Value::as_str)
          .unwrap_or("record");
        if !identifier(record_type, 80) {
          return Err("INVALID_RECORDS".into());
        }
        let record_key = format!("{record_type}:{id}");
        if let Some(part) = record.get("textPart") {
          let index = part
            .get("index")
            .and_then(Value::as_u64)
            .ok_or("INVALID_RECORD_PART")?;
          let final_part = part
            .get("final")
            .and_then(Value::as_bool)
            .ok_or("INVALID_RECORD_PART")?;
          let text = part
            .get("text")
            .and_then(Value::as_str)
            .ok_or("INVALID_RECORD_PART")?;
          let sequence = pending
            .parts
            .entry(record_key.clone())
            .or_insert((0, false, 0));
          if sequence.0 != index || sequence.1 {
            return Err("INVALID_RECORD_PART".into());
          }
          if sequence.2 + text.len() > 4194304 {
            return Err("TEXT_LIMIT".into());
          }
          *sequence = (index + 1, final_part, sequence.2 + text.len());
        } else if pending.parts.contains_key(&record_key) {
          return Err("INVALID_RECORD_PART".into());
        }
        pending.records.insert(record_key);
      }
      if pending.records.len() > 1000 {
        return Err("RECORD_LIMIT".into());
      }
    }
    "media_open" => {
      let id = event
        .get("mediaId")
        .and_then(Value::as_str)
        .filter(|id| identifier(id, 128))
        .ok_or("INVALID_MEDIA")?;
      let filename = event
        .get("fileName")
        .and_then(Value::as_str)
        .ok_or("INVALID_MEDIA")?;
      if filename.is_empty()
        || filename.len() > 240
        || filename.contains(['/', '\\', ':', '\0', '\n', '\r'])
        || filename == "."
        || filename == ".."
      {
        return Err("INVALID_MEDIA".into());
      }
      if !event
        .get("mimeType")
        .and_then(Value::as_str)
        .is_some_and(|mime| mime.len() <= 160 && mime.contains('/') && !mime.contains(['\r', '\n']))
        || !event
          .get("sourceUrl")
          .and_then(Value::as_str)
          .is_some_and(|source| source.len() <= 4096 && source.starts_with("https://"))
      {
        return Err("INVALID_MEDIA".into());
      }
      let declared = match event.get("declaredBytes") {
        None | Some(Value::Null) => None,
        Some(value) => Some(value.as_u64().ok_or("INVALID_MEDIA")?),
      };
      let is_spool = match event.get("sink").and_then(Value::as_str) {
        None => false,
        Some("spool") => true,
        Some(_) => return Err("INVALID_MEDIA".into()),
      };
      if is_spool != pending.spool.is_some() || (is_spool && declared.is_none()) {
        return Err("INVALID_MEDIA".into());
      }
      let resume_from = match event.get("resumeFrom") {
        None | Some(Value::Null) => 0,
        Some(value) => value.as_u64().ok_or("INVALID_MEDIA")?,
      };
      if resume_from % research_spool::ALIGN != 0
        || declared.is_some_and(|bytes| resume_from >= bytes && resume_from > 0)
        || (resume_from > 0 && declared.is_none())
        || (is_spool && resume_from != pending.spool.as_ref().map_or(0, |plan| plan.resume_offset))
        || (is_spool && pending.spool_writer.is_none())
      {
        return Err("INVALID_MEDIA".into());
      }
      if declared.is_some_and(|bytes| bytes > MAX_MEDIA)
        || pending.media.len() >= 500
        || pending.media.values().filter(|media| !media.closed).count() >= if is_spool { 1 } else { 8 }
        || pending.media.contains_key(id)
      {
        return Err("MEDIA_LIMIT".into());
      }
      pending.media.insert(
        id.to_string(),
        Media {
          next_sequence: 0,
          bytes: resume_from,
          declared,
          closed: false,
          spool: is_spool,
        },
      );
    }
    "media_chunk" => {
      let id = event
        .get("mediaId")
        .and_then(Value::as_str)
        .ok_or("INVALID_MEDIA")?;
      let sequence = event
        .get("sequence")
        .and_then(Value::as_u64)
        .ok_or("INVALID_MEDIA")?;
      let bytes = decoded_size(
        event
          .get("base64")
          .and_then(Value::as_str)
          .ok_or("INVALID_MEDIA")?,
      )
      .ok_or("INVALID_MEDIA")?;
      let media = pending.media.get_mut(id).ok_or("INVALID_MEDIA")?;
      if media.spool {
        return Err("INVALID_MEDIA".into());
      }
      if media.closed
        || media.next_sequence != sequence
        || media.bytes + bytes > MAX_MEDIA
        || pending.total_bytes + bytes > MAX_JOB_BYTES
      {
        return Err("MEDIA_LIMIT".into());
      }
      media.next_sequence += 1;
      media.bytes += bytes;
      pending.total_bytes += bytes;
    }
    "media_close" => {
      let id = event
        .get("mediaId")
        .and_then(Value::as_str)
        .ok_or("INVALID_MEDIA")?;
      let total = event
        .get("totalBytes")
        .and_then(Value::as_u64)
        .ok_or("INVALID_MEDIA")?;
      let media = pending.media.get_mut(id).ok_or("INVALID_MEDIA")?;
      if media.closed
        || media.bytes != total
        || media.declared.is_some_and(|declared| declared != total)
        || (media.spool && event.get("spool").is_none())
      {
        return Err("MEDIA_SIZE_MISMATCH".into());
      }
      media.closed = true;
      if media.spool {
        pending.spool_writer = None;
      } else if let Some(fields) = event.as_object_mut() {
        fields.remove("spool");
        fields.remove("sink");
      }
    }
    "done" => {
      if !event.get("coverage").is_some_and(Value::is_object)
        || !event
          .get("count")
          .and_then(Value::as_u64)
          .is_some_and(|count| count <= 1000 && count as usize == pending.records.len())
        || !matches!(
          event.get("outcome").and_then(Value::as_str),
          Some("results" | "empty" | "partial" | "cancelled")
        )
      {
        return Err("INVALID_DONE".into());
      }
      if event.get("outcome").and_then(Value::as_str) == Some("empty")
        && !pending.records.is_empty()
      {
        return Err("INVALID_DONE".into());
      }
      if pending.media.values().any(|media| !media.closed)
        || pending.parts.values().any(|part| !part.1)
      {
        return Err("INCOMPLETE_STREAM".into());
      }
      return Ok(true);
    }
    _ => {}
  }
  Ok(false)
}

// A provider is busy only when every slot is taken by a pending run or a lease that still drains
fn busy_provider_status(
  providers: &mut [Value],
  pending: &HashMap<String, Pending>,
  leases: &HashMap<String, Draining>,
) {
  for status in providers {
    let provider = status.get("provider").and_then(Value::as_str);
    let running = pending
      .values()
      .filter(|item| item.method == "run" && item.provider.as_deref() == provider)
      .count();
    let draining = leases
      .values()
      .filter(|lease| Some(lease.provider.as_str()) == provider)
      .count();
    if provider.is_some() && running + draining > 0 && running + draining >= provider_capacity(provider) {
      status["state"] = json!("unavailable");
      status["reason"] = json!("PROVIDER_BUSY");
    }
  }
}

fn sanitize_wait(event: &mut Value) {
  let Some(fields) = event.as_object_mut() else {
    return;
  };
  if !fields
    .get("seconds")
    .and_then(Value::as_u64)
    .is_some_and(|seconds| seconds <= MAX_WAIT_SECONDS)
  {
    fields.remove("seconds");
  }
  if !fields
    .get("waitKind")
    .and_then(Value::as_str)
    .is_some_and(|kind| kind.len() <= 32 && code(kind))
  {
    fields.remove("waitKind");
  }
  if !fields
    .get("retryAfterMs")
    .and_then(Value::as_u64)
    .is_some_and(|millis| millis <= MAX_WAIT_SECONDS * 1000)
  {
    fields.remove("retryAfterMs");
  }
}

fn sanitize_capabilities(fields: &mut serde_json::Map<String, Value>, is_telegram: bool) {
  let slots_ok = is_telegram
    && fields
      .get("maxConcurrent")
      .and_then(Value::as_u64)
      .is_some_and(|slots| (1..=MAX_TELEGRAM_RUNS as u64).contains(&slots));
  if !slots_ok {
    fields.remove("maxConcurrent");
  }
  let features_ok = is_telegram
    && fields.get("features").and_then(Value::as_array).is_some_and(|features| {
      features.len() <= MAX_FEATURES
        && features.iter().all(|feature| {
          feature.as_str().is_some_and(|name| {
            !name.is_empty()
              && name.len() <= 32
              && name
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
          })
        })
    });
  if !features_ok {
    fields.remove("features");
  }
}

fn stamp_status_runtime(event: &mut Value, runtime_id: &str) {
  if event.get("kind").and_then(Value::as_str) == Some("status") {
    event["runtimeId"] = Value::String(runtime_id.to_string());
  }
}

fn settle_draining(
  leases: &mut HashMap<String, Draining>,
  request_id: &str,
  nonce: &str,
  terminal: bool,
) -> Option<Result<(), String>> {
  let lease = leases.get(request_id)?;
  if lease.nonce != nonce {
    return Some(Err("REQUEST_NOT_PENDING".into()));
  }
  if terminal {
    leases.remove(request_id);
    Some(Ok(()))
  } else {
    Some(Err("CANCELLED".into()))
  }
}

pub(crate) fn publish(request_id: &str, nonce: &str, mut event: Value) -> Result<(), String> {
  if !event.is_object()
    || serde_json::to_vec(&event)
      .map_err(|_| "INVALID_EVENT")?
      .len()
      > MAX_FRAME - 512
  {
    return Err("FRAME_TOO_LARGE".into());
  }
  if let Err(code) = prepare_spool_event(request_id, nonce, &mut event) {
    if SPOOL_TERMINAL_CODES.contains(&code.as_str()) {
      // The daemon gets the precise cause; the renderer sees the same code as the failure of this reply
      let _ = publish(request_id, nonce, json!({"kind":"error","code":code}));
    }
    return Err(code);
  }
  {
    let mut leases = DRAINING.lock().map_err(|_| "BRIDGE_UNAVAILABLE")?;
    let terminal = matches!(
      event.get("kind").and_then(Value::as_str),
      Some("done" | "error")
    );
    if let Some(result) = settle_draining(&mut leases, request_id, nonce, terminal) {
      return result;
    }
  }
  let status_app = {
    let active = ACTIVE.lock().map_err(|_| "BRIDGE_UNAVAILABLE")?;
    let bridge = active.as_ref().ok_or("BRIDGE_UNAVAILABLE")?;
    let pending = bridge
      .pending
      .get(request_id)
      .ok_or("REQUEST_NOT_PENDING")?;
    if pending.nonce != nonce {
      return Err("REQUEST_NOT_PENDING".into());
    }
    stamp_status_runtime(&mut event, &bridge.runtime_id);
    (pending.method != "run"
      && !pending.cancelled
      && event.get("kind").and_then(Value::as_str) == Some("status"))
    .then(|| bridge.app.clone())
  };
  let social_status = status_app.map_or_else(Vec::new, |app| crate::research_social::status(&app));
  let output = {
    let mut active = ACTIVE.lock().map_err(|_| "BRIDGE_UNAVAILABLE")?;
    let bridge = active.as_mut().ok_or("BRIDGE_UNAVAILABLE")?;
    if event.get("kind").and_then(Value::as_str) == Some("status")
      && bridge
        .pending
        .get(request_id)
        .is_some_and(|pending| pending.method != "run")
    {
      let providers = event
        .get_mut("providers")
        .and_then(Value::as_array_mut)
        .ok_or("INVALID_STATUS")?;
      if providers
        .iter()
        .any(|item| item.get("provider").and_then(Value::as_str) != Some("telegram"))
      {
        return Err("INVALID_STATUS".into());
      }
      providers.extend(social_status);
      busy_provider_status(
        providers,
        &bridge.pending,
        &*DRAINING.lock().map_err(|_| "BRIDGE_UNAVAILABLE")?,
      );
    }
    let pending = bridge
      .pending
      .get_mut(request_id)
      .ok_or("REQUEST_NOT_PENDING")?;
    if pending.nonce != nonce {
      return Err("REQUEST_NOT_PENDING".into());
    }
    let terminal = matches!(
      event.get("kind").and_then(Value::as_str),
      Some("done" | "error")
    ) || (pending.method != "run"
      && event.get("kind").and_then(Value::as_str) == Some("status"));
    if pending.cancelled || (terminal && pending.deadline <= Instant::now()) {
      if terminal {
        bridge.pending.remove(request_id);
        return Ok(());
      }
      return Err("CANCELLED".into());
    }
    if pending.deadline <= Instant::now() {
      return Err("REQUEST_NOT_PENDING".into());
    }
    let terminal = validate_event(pending, &mut event)?;
    let stdin = bridge.stdin.clone();
    if terminal {
      bridge.pending.remove(request_id);
    }
    stdin
  };
  write_event(&output, request_id, nonce, event)
}

fn prepare_spool_event(request_id: &str, nonce: &str, event: &mut Value) -> Result<(), String> {
  match event.get("kind").and_then(Value::as_str) {
    Some("media_open") if event.get("sink").and_then(Value::as_str) == Some("spool") => {
      open_spool(request_id, nonce, event)
    }
    Some("media_close") => close_spool(request_id, nonce, event),
    _ => Ok(()),
  }
}

// The file is opened and a resumed prefix is hashed outside the bridge lock
fn open_spool(request_id: &str, nonce: &str, event: &Value) -> Result<(), String> {
  let declared = event
    .get("declaredBytes")
    .and_then(Value::as_u64)
    .ok_or("INVALID_MEDIA")?;
  let fingerprint = event
    .get("fingerprint")
    .and_then(Value::as_str)
    .filter(|value| research_spool::valid_fingerprint(value))
    .ok_or("INVALID_MEDIA")?;
  let resume_from = match event.get("resumeFrom") {
    None | Some(Value::Null) => 0,
    Some(value) => value.as_u64().ok_or("INVALID_MEDIA")?,
  };
  let (plan, state_root) = {
    let active = ACTIVE.lock().map_err(|_| "BRIDGE_UNAVAILABLE")?;
    let bridge = active.as_ref().ok_or("BRIDGE_UNAVAILABLE")?;
    let pending = bridge
      .pending
      .get(request_id)
      .ok_or("REQUEST_NOT_PENDING")?;
    if pending.nonce != nonce || pending.cancelled || pending.provider.as_deref() != Some("telegram") {
      return Err("REQUEST_NOT_PENDING".into());
    }
    if pending.spool_writer.is_some() {
      return Err("MEDIA_LIMIT".into());
    }
    (
      pending.spool.clone().ok_or("INVALID_MEDIA")?,
      bridge.state_root.clone(),
    )
  };
  if resume_from != plan.resume_offset {
    return Err("INVALID_MEDIA".into());
  }
  research_spool::prune(&state_root, std::time::SystemTime::now());
  let writer = SpoolWriter::open(
    &state_root,
    &plan.key,
    fingerprint,
    declared,
    resume_from,
    &research_spool::free_space,
  )
  .map_err(|error| error.code().to_string())?;
  let mut active = ACTIVE.lock().map_err(|_| "BRIDGE_UNAVAILABLE")?;
  let pending = active
    .as_mut()
    .and_then(|bridge| bridge.pending.get_mut(request_id))
    .ok_or("REQUEST_NOT_PENDING")?;
  if pending.nonce != nonce || pending.cancelled {
    return Err("REQUEST_NOT_PENDING".into());
  }
  pending.spool_writer = Some(Arc::new(Mutex::new(Some(writer))));
  Ok(())
}

// Closing finalizes the file (sync, rename, hash) and puts the verified result into the event the daemon reads
fn close_spool(request_id: &str, nonce: &str, event: &mut Value) -> Result<(), String> {
  let Some(media_id) = event.get("mediaId").and_then(Value::as_str).map(str::to_string) else {
    return Ok(());
  };
  let handle = {
    let active = ACTIVE.lock().map_err(|_| "BRIDGE_UNAVAILABLE")?;
    let Some(pending) = active
      .as_ref()
      .and_then(|bridge| bridge.pending.get(request_id))
    else {
      return Ok(());
    };
    if pending.nonce != nonce
      || !pending
        .media
        .get(&media_id)
        .is_some_and(|media| media.spool && !media.closed)
    {
      return Ok(());
    }
    pending.spool_writer.clone()
  };
  let total = event
    .get("totalBytes")
    .and_then(Value::as_u64)
    .ok_or("INVALID_MEDIA")?;
  let writer = handle
    .ok_or("INVALID_MEDIA")?
    .lock()
    .map_err(|_| "SPOOL_IO")?
    .take()
    .ok_or("INVALID_MEDIA")?;
  let done = writer.finish(total).map_err(|error| error.code().to_string())?;
  event["sink"] = json!("spool");
  event["spool"] = done.to_value();
  Ok(())
}

// Accounting for one raw piece; the same limits and ordering as base64 chunks apply
fn account_spool_chunk(
  pending: &mut Pending,
  media_id: &str,
  sequence: u64,
  length: u64,
) -> Result<SharedSpool, String> {
  if !pending.scoped || pending.cancelled {
    return Err("INVALID_MEDIA".into());
  }
  let writer = pending.spool_writer.clone().ok_or("INVALID_MEDIA")?;
  let media = pending.media.get_mut(media_id).ok_or("INVALID_MEDIA")?;
  if !media.spool || media.closed || media.next_sequence != sequence {
    return Err("INVALID_MEDIA".into());
  }
  if length == 0
    || length > research_spool::MAX_CHUNK as u64
    || media.bytes + length > MAX_MEDIA
    || media.declared.is_some_and(|declared| media.bytes + length > declared)
    || pending.total_bytes + length > MAX_JOB_BYTES
  {
    return Err("MEDIA_LIMIT".into());
  }
  media.next_sequence += 1;
  media.bytes += length;
  pending.total_bytes += length;
  Ok(writer)
}

struct MediaChunk {
  request_id: String,
  nonce: String,
  media_id: String,
  sequence: u64,
  bytes: Vec<u8>,
}

fn parse_media_chunk(request: &tauri::ipc::Request<'_>) -> Result<MediaChunk, String> {
  let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
    return Err("INVALID_MEDIA".into());
  };
  let header = |name: &str| {
    request
      .headers()
      .get(name)
      .and_then(|value| value.to_str().ok())
      .map(str::to_string)
      .ok_or_else(|| "INVALID_MEDIA".to_string())
  };
  let chunk = MediaChunk {
    request_id: header("x-request-id")?,
    nonce: header("x-nonce")?,
    media_id: header("x-media-id")?,
    sequence: header("x-sequence")?
      .parse()
      .map_err(|_| "INVALID_MEDIA".to_string())?,
    bytes: bytes.clone(),
  };
  if !identifier(&chunk.request_id, 64)
    || chunk.nonce.len() != 64
    || !chunk.nonce.bytes().all(|byte| byte.is_ascii_hexdigit())
    || !identifier(&chunk.media_id, 128)
    || chunk.bytes.is_empty()
    || chunk.bytes.len() > research_spool::MAX_CHUNK
  {
    return Err("INVALID_MEDIA".into());
  }
  Ok(chunk)
}

#[tauri::command]
pub(crate) async fn relay_research_media_chunk(
  webview: tauri::Webview,
  request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
  if !trusted_main(&webview) {
    return Err("RESEARCH_REPLY_DENIED".into());
  }
  let chunk = parse_media_chunk(&request)?;
  tauri::async_runtime::spawn_blocking(move || handle_media_chunk(chunk))
    .await
    .map_err(|_| "RESEARCH_DISPATCH_UNAVAILABLE".to_string())?
}

fn handle_media_chunk(chunk: MediaChunk) -> Result<(), String> {
  let writer = {
    let mut active = ACTIVE.lock().map_err(|_| "BRIDGE_UNAVAILABLE")?;
    let pending = active
      .as_mut()
      .and_then(|bridge| bridge.pending.get_mut(&chunk.request_id))
      .ok_or("REQUEST_NOT_PENDING")?;
    if pending.nonce != chunk.nonce
      || pending.provider.as_deref() != Some("telegram")
      || pending.deadline <= Instant::now()
    {
      return Err("REQUEST_NOT_PENDING".into());
    }
    account_spool_chunk(
      pending,
      &chunk.media_id,
      chunk.sequence,
      chunk.bytes.len() as u64,
    )?
  };
  let appended = writer
    .lock()
    .map_err(|_| "SPOOL_IO".to_string())
    .and_then(|mut guard| {
      guard
        .as_mut()
        .ok_or_else(|| "INVALID_MEDIA".to_string())?
        .append(chunk.sequence, &chunk.bytes)
        .map_err(|error| error.code().to_string())
    });
  if let Err(code) = &appended {
    let _ = publish(
      &chunk.request_id,
      &chunk.nonce,
      json!({"kind":"error","code":code}),
    );
  }
  appended
}

#[tauri::command]
pub(crate) fn relay_research_ready(webview: tauri::Webview) -> Result<(), String> {
  if !trusted_main(&webview) {
    return Err("RESEARCH_REPLY_DENIED".into());
  }
  FRONTEND_REGISTERED.store(true, Ordering::Release);
  start(webview.app_handle())?;
  let mut active = ACTIVE.lock().map_err(|_| "BRIDGE_UNAVAILABLE")?;
  if let Some(bridge) = active.as_mut() {
    bridge.frontend_ready = true;
    if bridge.helper_ready {
      return Ok(());
    }
  }
  Err("BRIDGE_STARTING".into())
}

#[tauri::command]
pub(crate) async fn relay_research_reply(
  webview: tauri::Webview,
  request_id: String,
  nonce: String,
  event: Value,
) -> Result<(), String> {
  tauri::async_runtime::spawn_blocking(move || handle_research_reply(webview, request_id, nonce, event))
    .await
    .map_err(|_| "RESEARCH_DISPATCH_UNAVAILABLE".to_string())?
}

fn handle_research_reply(
  webview: tauri::Webview,
  request_id: String,
  nonce: String,
  event: Value,
) -> Result<(), String> {
  if !trusted_main(&webview) {
    return Err("RESEARCH_REPLY_DENIED".into());
  }
  let draining = DRAINING
    .lock()
    .map_err(|_| "BRIDGE_UNAVAILABLE")?
    .get(&request_id)
    .map(|lease| (lease.nonce.clone(), lease.provider.clone()));
  if let Some((owned_nonce, provider)) = draining {
    if owned_nonce != nonce || provider != "telegram" {
      return Err("RESEARCH_REPLY_DENIED".into());
    }
    return publish(&request_id, &nonce, event);
  }
  {
    let active = ACTIVE.lock().map_err(|_| "BRIDGE_UNAVAILABLE")?;
    let pending = active
      .as_ref()
      .and_then(|bridge| bridge.pending.get(&request_id))
      .ok_or("REQUEST_NOT_PENDING")?;
    if pending
      .provider
      .as_deref()
      .is_some_and(|provider| provider != "telegram")
    {
      return Err("RESEARCH_REPLY_DENIED".into());
    }
  }
  publish(&request_id, &nonce, event)
}

#[cfg(test)]
mod tests {
  use super::*;

  fn pending() -> Pending {
    Pending {
      nonce: "n".into(),
      method: "run".into(),
      provider: Some("telegram".into()),
      deadline: Instant::now() + Duration::from_secs(10),
      cancelled: false,
      dispatched: false,
      binding: Some(("account-ref".into(), "epoch-1".into())),
      ready_bound: false,
      scoped: false,
      records: HashSet::new(),
      parts: HashMap::new(),
      media: HashMap::new(),
      total_bytes: 0,
      spool: None,
      spool_writer: None,
    }
  }
  fn bound(kind: &str) -> Value {
    json!({"kind":kind,"accountRef":"account-ref","accountEpoch":"epoch-1"})
  }
  fn scoped() -> Pending {
    let mut pending = pending();
    let mut status = json!({"kind":"status","providers":[{"provider":"telegram","state":"ready","operations":["read"],"accountRef":"account-ref","accountEpoch":"epoch-1"}]});
    assert_eq!(validate_event(&mut pending, &mut status), Ok(false));
    assert_eq!(validate_event(&mut pending, &mut bound("scope")), Ok(false));
    pending
  }
  #[test]
  fn records_require_ready_scope() {
    let mut pending = pending();
    assert_eq!(
      validate_event(&mut pending, &mut bound("scope")),
      Err("ACCOUNT_SCOPE_REQUIRED".into())
    );
    let mut event = bound("records");
    event["records"] = json!([{"id":"1","text":"hello"}]);
    assert_eq!(
      validate_event(&mut pending, &mut event),
      Err("ACCOUNT_SCOPE_REQUIRED".into())
    );
  }
  #[test]
  fn drift_rejected_before_scope() {
    let mut pending = pending();
    let mut event = json!({"kind":"status","providers":[{"provider":"telegram","state":"ready","accountRef":"other-account","accountEpoch":"epoch-2"}]});
    assert_eq!(
      validate_event(&mut pending, &mut event),
      Err("STALE_ACCOUNT".into())
    );
  }
  #[test]
  fn complete_ordered_text_and_media() {
    let mut pending = scoped();
    for (index, final_part) in [(0, false), (1, true)] {
      let mut event = bound("records");
      event["records"] =
        json!([{"id":"1","textPart":{"index":index,"text":"long text","final":final_part}}]);
      assert_eq!(validate_event(&mut pending, &mut event), Ok(false));
    }
    let mut open = bound("media_open");
    open["mediaId"] = json!("m");
    open["fileName"] = json!("asset.bin");
    open["mimeType"] = json!("application/octet-stream");
    open["sourceUrl"] = json!("https://t.me/test/1");
    open["declaredBytes"] = json!(1);
    assert_eq!(validate_event(&mut pending, &mut open), Ok(false));
    let mut chunk = bound("media_chunk");
    chunk["mediaId"] = json!("m");
    chunk["sequence"] = json!(0);
    chunk["base64"] = json!("AA==");
    assert_eq!(validate_event(&mut pending, &mut chunk), Ok(false));
    let mut close = bound("media_close");
    close["mediaId"] = json!("m");
    close["totalBytes"] = json!(1);
    assert_eq!(validate_event(&mut pending, &mut close), Ok(false));
    let mut done = bound("done");
    done["outcome"] = json!("results");
    done["count"] = json!(1);
    done["coverage"] = json!({"complete":true});
    assert_eq!(validate_event(&mut pending, &mut done), Ok(true));
    assert_eq!(pending.records.len(), 1);
  }
  #[test]
  fn incomplete_text_cannot_finish() {
    let mut pending = scoped();
    let mut event = bound("records");
    event["records"] = json!([{"id":"1","textPart":{"index":0,"text":"part","final":false}}]);
    assert_eq!(validate_event(&mut pending, &mut event), Ok(false));
    let mut done = bound("done");
    done["outcome"] = json!("results");
    done["count"] = json!(1);
    done["coverage"] = json!({});
    assert_eq!(
      validate_event(&mut pending, &mut done),
      Err("INCOMPLETE_STREAM".into())
    );
  }
  #[test]
  fn text_replay_and_sequence_rejected() {
    let mut pending = scoped();
    let mut event = bound("records");
    event["records"] =
      json!([{"id":"1","textPart":{"index":1,"text":"out of order","final":true}}]);
    assert_eq!(
      validate_event(&mut pending, &mut event),
      Err("INVALID_RECORD_PART".into())
    );
  }
  #[test]
  fn cancelled_errors_never_forward_raw_reason() {
    let mut pending = pending();
    let mut error = json!({"kind":"error","code":"CANCELLED","reason":"private raw exception"});
    assert_eq!(validate_event(&mut pending, &mut error), Ok(true));
    assert_eq!(error["reason"], json!("CANCELLED"));
    let mut error = json!({"kind":"error","code":"CANCELLED","reason":"private raw exception","completionUncertain":true});
    assert_eq!(validate_event(&mut pending, &mut error), Ok(true));
    assert_eq!(error["reason"], json!("cancelled_completion_uncertain"));
  }
  #[test]
  fn status_strips_private_extra_fields() {
    let mut pending = pending();
    pending.method = "status".into();
    let mut event = json!({"kind":"status","providers":[{"provider":"telegram","state":"auth_required","reason":"raw page","userId":"secret","operations":["read"]}]});
    assert_eq!(validate_event(&mut pending, &mut event), Ok(true));
    assert!(event["providers"][0].get("userId").is_none());
    assert_eq!(event["providers"][0]["reason"], json!("AUTH_REQUIRED"));
  }
  #[test]
  fn bounded_base64_and_inputs() {
    assert_eq!(decoded_size("AAAA"), Some(3));
    assert_eq!(decoded_size("A=AA"), None);
    assert_eq!(decoded_size(&"A".repeat(65540)), None);
    assert!(!valid_input(&json!({"nested":{"headers":{}}}), 0, &mut 0));
    assert!(!operation_allowed("x", "join_chat"));
    assert!(!operation_allowed("telegram", "publicPostsPaid"));
    assert!(operation_allowed("telegram", "join_chat"));
  }
  #[test]
  fn done_count_matches_unique_type_and_id() {
    let mut pending = scoped();
    let mut records = bound("records");
    records["records"] = json!([{"type":"user","id":"1"},{"type":"channel","id":"1"}]);
    assert_eq!(validate_event(&mut pending, &mut records), Ok(false));
    let mut done = bound("done");
    done["coverage"] = json!({});
    done["outcome"] = json!("results");
    done["count"] = json!(1);
    assert_eq!(
      validate_event(&mut pending, &mut done),
      Err("INVALID_DONE".into())
    );
    done["count"] = json!(2);
    assert_eq!(validate_event(&mut pending, &mut done), Ok(true));
    done["outcome"] = json!("empty");
    assert_eq!(
      validate_event(&mut pending, &mut done),
      Err("INVALID_DONE".into())
    );
  }
  #[test]
  fn text_has_an_explicit_per_record_byte_limit() {
    let mut pending = scoped();
    for index in 0..64 {
      let mut event = bound("records");
      event["records"] = json!([{"type":"post","id":"1","textPart":{"index":index,"text":"a".repeat(65536),"final":false}}]);
      assert_eq!(validate_event(&mut pending, &mut event), Ok(false));
    }
    let mut event = bound("records");
    event["records"] =
      json!([{"type":"post","id":"1","textPart":{"index":64,"text":"a","final":true}}]);
    assert_eq!(
      validate_event(&mut pending, &mut event),
      Err("TEXT_LIMIT".into())
    );
  }
  #[test]
  fn media_open_count_is_independent_from_total_completed_files() {
    let mut pending = scoped();
    let mut open = bound("media_open");
    open["fileName"] = json!("asset.bin");
    open["mimeType"] = json!("application/octet-stream");
    open["sourceUrl"] = json!("https://t.me/test/1");
    open["declaredBytes"] = json!(0);
    for index in 0..8 {
      open["mediaId"] = json!(format!("m{index}"));
      assert_eq!(validate_event(&mut pending, &mut open), Ok(false));
    }
    open["mediaId"] = json!("m8");
    assert_eq!(
      validate_event(&mut pending, &mut open),
      Err("MEDIA_LIMIT".into())
    );
    let mut close = bound("media_close");
    close["mediaId"] = json!("m0");
    close["totalBytes"] = json!(0);
    assert_eq!(validate_event(&mut pending, &mut close), Ok(false));
    assert_eq!(validate_event(&mut pending, &mut open), Ok(false));
  }
  #[test]
  fn native_frames_require_newline_and_enforce_byte_limit() {
    use std::io::{BufReader, Cursor};
    let mut reader = BufReader::new(Cursor::new(b"{}\n"));
    assert_eq!(read_frame(&mut reader).unwrap(), Some(b"{}".to_vec()));
    assert_eq!(read_frame(&mut reader).unwrap(), None);
    let mut reader = BufReader::new(Cursor::new(b"{}"));
    assert!(read_frame(&mut reader).is_err());
    let mut reader = BufReader::new(Cursor::new(vec![b'x'; MAX_FRAME + 1]));
    assert!(read_frame(&mut reader).is_err());
  }
  #[test]
  fn cancelled_run_remains_busy_until_owned_terminal_settlement() {
    let mut leases = HashMap::new();
    for index in 0..MAX_TELEGRAM_RUNS {
      let mut lease = scoped();
      lease.cancelled = true;
      lease.deadline = Instant::now() - Duration::from_secs(1);
      leases.insert(format!("job{index}"), lease);
    }
    let mut providers = vec![
      json!({"provider":"telegram","state":"ready","reason":"READY","operations":["read"],"accountRef":"account-ref","accountEpoch":"epoch-1"}),
      json!({"provider":"x","state":"ready"}),
    ];
    busy_provider_status(&mut providers, &leases, &HashMap::new());
    assert_eq!(providers[0]["state"], json!("unavailable"));
    assert_eq!(providers[0]["reason"], json!("PROVIDER_BUSY"));
    assert_eq!(providers[0]["accountRef"], json!("account-ref"));
    assert_eq!(providers[0]["operations"], json!(["read"]));
    assert_eq!(providers[1]["state"], json!("ready"));
    leases.clear();
    let mut fresh = vec![json!({"provider":"telegram","state":"ready"})];
    busy_provider_status(&mut fresh, &leases, &HashMap::new());
    assert_eq!(fresh[0]["state"], json!("ready"));
  }
  #[test]
  fn owner_run_status_gets_trusted_runtime_before_transport() {
    let mut pending = pending();
    let mut event = json!({"kind":"status","providers":[{"provider":"telegram","state":"ready","operations":["read"],"accountRef":"account-ref","accountEpoch":"epoch-1"}]});
    assert!(event.get("runtimeId").is_none());
    stamp_status_runtime(&mut event, "trusted-runtime");
    assert_eq!(event["runtimeId"], json!("trusted-runtime"));
    assert_eq!(validate_event(&mut pending, &mut event), Ok(false));
    event["runtimeId"] = json!("producer-selected");
    stamp_status_runtime(&mut event, "trusted-runtime");
    assert_eq!(event["runtimeId"], json!("trusted-runtime"));
  }
  #[test]
  fn sent_join_stale_scope_preserves_typed_uncertainty() {
    let mut pending = scoped();
    let mut error = json!({"kind":"error","code":"STALE_ACCOUNT","completionUncertain":true,"reason":"private raw exception"});
    assert_eq!(validate_event(&mut pending, &mut error), Ok(true));
    assert_eq!(error["completionUncertain"], json!(true));
    assert_eq!(error["reason"], json!("remote_completion_uncertain"));
    let mut plain = json!({"kind":"error","code":"STALE_ACCOUNT","completionUncertain":"true","reason":"private raw exception"});
    assert_eq!(validate_event(&mut pending, &mut plain), Ok(true));
    assert!(plain.get("completionUncertain").is_none());
    assert_eq!(plain["reason"], json!("STALE_ACCOUNT"));
  }

  fn lease(provider: &str) -> Draining {
    Draining {
      nonce: "n".into(),
      provider: provider.into(),
    }
  }
  #[test]
  fn telegram_has_three_slots_and_other_providers_one() {
    assert_eq!(provider_capacity(Some("telegram")), 3);
    assert_eq!(provider_capacity(Some("x")), 1);
    assert_eq!(provider_capacity(Some("instagram")), 1);
    let mut leases = HashMap::new();
    leases.insert("a".to_string(), lease("telegram"));
    leases.insert("b".to_string(), lease("x"));
    let mut providers = vec![
      json!({"provider":"telegram","state":"ready"}),
      json!({"provider":"x","state":"ready"}),
    ];
    busy_provider_status(&mut providers, &HashMap::new(), &leases);
    assert_eq!(providers[0]["state"], json!("ready"));
    assert_eq!(providers[1]["reason"], json!("PROVIDER_BUSY"));
    // Running requests and draining leases fill the same three slots
    let mut running = HashMap::new();
    running.insert("r1".to_string(), scoped());
    running.insert("r2".to_string(), scoped());
    let mut telegram = vec![json!({"provider":"telegram","state":"ready"})];
    busy_provider_status(&mut telegram, &running, &HashMap::new());
    assert_eq!(telegram[0]["state"], json!("ready"));
    let mut one = HashMap::new();
    one.insert("a".to_string(), lease("telegram"));
    busy_provider_status(&mut telegram, &running, &one);
    assert_eq!(telegram[0]["reason"], json!("PROVIDER_BUSY"));
  }
  #[test]
  fn emergency_cap_counts_accepted_starts_and_names_the_wait() {
    let start = Instant::now();
    let mut window = VecDeque::new();
    for index in 0..EMERGENCY_RUNS_PER_MINUTE {
      let at = start + Duration::from_millis(index as u64 * 100);
      assert_eq!(emergency_check(&mut window, at, EMERGENCY_RUNS_PER_MINUTE), Ok(()));
    }
    let refused = start + Duration::from_secs(10);
    let wait = emergency_check(&mut window, refused, EMERGENCY_RUNS_PER_MINUTE).unwrap_err();
    assert_eq!(wait, Duration::from_secs(50));
    assert_eq!(window.len(), EMERGENCY_RUNS_PER_MINUTE);
    // The oldest start leaves the window after a minute
    let later = start + Duration::from_secs(60);
    assert_eq!(emergency_check(&mut window, later, EMERGENCY_RUNS_PER_MINUTE), Ok(()));
    assert_eq!(window.len(), EMERGENCY_RUNS_PER_MINUTE);
  }
  #[test]
  fn stage_two_operations_are_telegram_only() {
    for operation in ["probe", "comments", "topics", "similar_channels", "invite_preview"] {
      assert!(operation_allowed("telegram", operation));
      assert!(!operation_allowed("x", operation));
      assert!(!operation_allowed("instagram", operation));
    }
  }
  #[test]
  fn status_keeps_valid_capabilities_and_drops_invalid_ones() {
    let mut pending = pending();
    pending.method = "status".into();
    let mut event = json!({"kind":"status","providers":[{"provider":"telegram","state":"ready","operations":["read","probe"],"maxConcurrent":3,"features":["offset_date","min_id","media_spool"]}]});
    assert_eq!(validate_event(&mut pending, &mut event), Ok(true));
    assert_eq!(event["providers"][0]["maxConcurrent"], json!(3));
    assert_eq!(
      event["providers"][0]["features"],
      json!(["offset_date", "min_id", "media_spool"])
    );
    for (slots, features) in [
      (json!(4), json!(["ok"])),
      (json!(0), json!(["Bad-Name"])),
      (json!("3"), json!("offset_date")),
      (json!(2), json!(vec!["a"; 17])),
    ] {
      let mut event = json!({"kind":"status","providers":[{"provider":"telegram","state":"ready","maxConcurrent":slots,"features":features}]});
      assert_eq!(validate_event(&mut pending, &mut event), Ok(true));
      let provider = &event["providers"][0];
      assert!(provider.get("features").is_none() || provider["features"] == json!(["ok"]));
      assert!(provider.get("maxConcurrent").is_none() || provider["maxConcurrent"] == json!(2));
    }
    let mut social = json!({"kind":"status","providers":[{"provider":"x","state":"ready","maxConcurrent":3,"features":["offset_date"]}]});
    assert_eq!(validate_event(&mut pending, &mut social), Ok(true));
    assert!(social["providers"][0].get("maxConcurrent").is_none());
    assert!(social["providers"][0].get("features").is_none());
  }
  #[test]
  fn rate_limit_error_keeps_structured_wait_and_drops_invalid_fields() {
    let mut pending = scoped();
    let mut error = json!({"kind":"error","code":"RATE_LIMITED","seconds":31,"waitKind":"FLOOD_WAIT","retryAfterMs":31000,"reason":"raw text"});
    assert_eq!(validate_event(&mut pending, &mut error), Ok(true));
    assert_eq!(error["code"], json!("RATE_LIMITED"));
    assert_eq!(error["reason"], json!("RATE_LIMITED"));
    assert_eq!(error["seconds"], json!(31));
    assert_eq!(error["waitKind"], json!("FLOOD_WAIT"));
    assert_eq!(error["retryAfterMs"], json!(31000));
    let mut bad = json!({"kind":"error","code":"RATE_LIMITED","seconds":86401,"waitKind":"flood wait","retryAfterMs":-5});
    assert_eq!(validate_event(&mut pending, &mut bad), Ok(true));
    assert!(bad.get("seconds").is_none());
    assert!(bad.get("waitKind").is_none());
    assert!(bad.get("retryAfterMs").is_none());
  }
  #[test]
  fn done_may_carry_a_structured_flood_wait_for_the_daemon() {
    let mut pending = scoped();
    let mut records = bound("records");
    records["records"] = json!([{"type":"post","id":"1"}]);
    assert_eq!(validate_event(&mut pending, &mut records), Ok(false));
    let mut done = bound("done");
    done["outcome"] = json!("partial");
    done["count"] = json!(1);
    done["coverage"] = json!({});
    done["reason"] = json!("FLOOD_WAIT");
    done["floodWait"] = json!({"seconds":12,"waitKind":"FLOOD_WAIT"});
    assert_eq!(validate_event(&mut pending, &mut done), Ok(true));
    assert_eq!(done["floodWait"]["seconds"], json!(12));
  }
  #[test]
  fn spool_plan_accepts_only_checked_hex_aligned_offsets_for_telegram() {
    let key = "0123456789abcdef0123456789abcdef";
    let plan = parse_spool(Some("telegram"), &json!({"mediaSink":"spool","mediaKey":key,"resumeOffset":2097152}))
      .unwrap()
      .unwrap();
    assert_eq!(plan.key, key);
    assert_eq!(plan.resume_offset, 2097152);
    assert!(parse_spool(Some("telegram"), &json!({"channel":"a"})).unwrap().is_none());
    assert!(parse_spool(Some("telegram"), &json!({"mediaSink":"json"})).unwrap().is_none());
    // JSON resume is allowed without a spool key
    assert!(parse_spool(Some("telegram"), &json!({"resumeOffset":1048576})).unwrap().is_none());
    for input in [
      json!({"mediaSink":"spool"}),
      json!({"mediaSink":"spool","mediaKey":"../../x"}),
      json!({"mediaSink":"spool","mediaKey":key,"resumeOffset":4096}),
      json!({"mediaSink":"json","mediaKey":key}),
      json!({"mediaSink":"elsewhere"}),
      json!({"mediaSink":7}),
    ] {
      assert!(parse_spool(Some("telegram"), &input).is_err(), "{input}");
    }
    assert!(parse_spool(Some("x"), &json!({"mediaSink":"spool","mediaKey":key})).is_err());
  }
  fn spool_pending() -> Pending {
    let mut pending = scoped();
    pending.spool = Some(SpoolPlan {
      key: "0123456789abcdef0123456789abcdef".into(),
      resume_offset: 0,
    });
    pending
  }
  fn media_open(sink: Option<&str>, declared: u64, resume_from: Option<u64>) -> Value {
    let mut open = bound("media_open");
    open["mediaId"] = json!("m");
    open["fileName"] = json!("asset.bin");
    open["mimeType"] = json!("application/octet-stream");
    open["sourceUrl"] = json!("https://t.me/test/1");
    open["declaredBytes"] = json!(declared);
    if let Some(sink) = sink {
      open["sink"] = json!(sink);
    }
    if let Some(resume_from) = resume_from {
      open["resumeFrom"] = json!(resume_from);
    }
    open
  }
  fn dummy_writer() -> SharedSpool {
    let root = std::env::var_os("EGOIST_RELAY_TEST_WORK")
      .or_else(|| std::env::var_os("EGOIST_RELAY_AUDIT_WORK"))
      .map(PathBuf::from)
      .expect("Native file tests require EGOIST_RELAY_TEST_WORK or EGOIST_RELAY_AUDIT_WORK")
      .join(format!("bridge-spool-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let writer = SpoolWriter::open(
      &root,
      "0123456789abcdef0123456789abcdef",
      "fedcba9876543210",
      3 * research_spool::ALIGN,
      0,
      &|_| Some(u64::MAX),
    )
    .unwrap();
    Arc::new(Mutex::new(Some(writer)))
  }
  #[test]
  fn spool_media_requires_matching_sink_and_never_accepts_base64_chunks() {
    let mut pending = spool_pending();
    // A JSON open in spool mode and a spool open in JSON mode are both protocol errors
    assert_eq!(
      validate_event(&mut pending, &mut media_open(None, 10, None)),
      Err("INVALID_MEDIA".into())
    );
    let mut plain = scoped();
    assert_eq!(
      validate_event(&mut plain, &mut media_open(Some("spool"), 10, None)),
      Err("INVALID_MEDIA".into())
    );
    // The native side attaches the writer before the open event is accepted
    assert_eq!(
      validate_event(&mut pending, &mut media_open(Some("spool"), 10, None)),
      Err("INVALID_MEDIA".into())
    );
    pending.spool_writer = Some(dummy_writer());
    assert_eq!(
      validate_event(&mut pending, &mut media_open(Some("spool"), 3 * research_spool::ALIGN, None)),
      Ok(false)
    );
    let mut chunk = bound("media_chunk");
    chunk["mediaId"] = json!("m");
    chunk["sequence"] = json!(0);
    chunk["base64"] = json!("AA==");
    assert_eq!(validate_event(&mut pending, &mut chunk), Err("INVALID_MEDIA".into()));
    // A second open stream is refused: spool mode keeps one file at a time
    let mut second = media_open(Some("spool"), 10, None);
    second["mediaId"] = json!("m2");
    assert_eq!(validate_event(&mut pending, &mut second), Err("MEDIA_LIMIT".into()));
  }
  #[test]
  fn spool_chunks_follow_order_size_and_declared_length() {
    let mut pending = spool_pending();
    pending.spool_writer = Some(dummy_writer());
    let declared = 3 * research_spool::ALIGN;
    assert_eq!(
      validate_event(&mut pending, &mut media_open(Some("spool"), declared, None)),
      Ok(false)
    );
    let mib = research_spool::ALIGN;
    assert!(account_spool_chunk(&mut pending, "m", 1, mib).is_err());
    assert!(account_spool_chunk(&mut pending, "m", 0, 0).is_err());
    assert!(account_spool_chunk(&mut pending, "m", 0, research_spool::MAX_CHUNK as u64 + 1).is_err());
    assert!(account_spool_chunk(&mut pending, "other", 0, mib).is_err());
    assert!(account_spool_chunk(&mut pending, "m", 0, mib).is_ok());
    assert!(account_spool_chunk(&mut pending, "m", 1, 2 * mib).is_ok());
    // One byte over the declared length is refused
    assert_eq!(
      account_spool_chunk(&mut pending, "m", 2, 1).err(),
      Some("MEDIA_LIMIT".into())
    );
    assert_eq!(pending.total_bytes, 3 * mib);
    // Closing needs the verified native result and the exact byte count
    let mut close = bound("media_close");
    close["mediaId"] = json!("m");
    close["totalBytes"] = json!(declared);
    assert_eq!(validate_event(&mut pending, &mut close), Err("MEDIA_SIZE_MISMATCH".into()));
    close["spool"] = json!({"name":"x.done","bytes":declared,"sha256":"00"});
    assert_eq!(validate_event(&mut pending, &mut close), Ok(false));
    assert!(pending.spool_writer.is_none());
  }
  #[test]
  fn resumed_media_counts_the_prefix_and_checks_the_aligned_offset() {
    let mib = research_spool::ALIGN;
    // JSON path resume
    let mut pending = scoped();
    assert_eq!(
      validate_event(&mut pending, &mut media_open(None, 3 * mib, Some(mib + 1))),
      Err("INVALID_MEDIA".into())
    );
    assert_eq!(
      validate_event(&mut pending, &mut media_open(None, 3 * mib, Some(3 * mib))),
      Err("INVALID_MEDIA".into())
    );
    assert_eq!(
      validate_event(&mut pending, &mut media_open(None, 3 * mib, Some(2 * mib))),
      Ok(false)
    );
    let mut chunk = bound("media_chunk");
    chunk["mediaId"] = json!("m");
    chunk["sequence"] = json!(0);
    chunk["base64"] = json!("AA==");
    assert_eq!(validate_event(&mut pending, &mut chunk), Ok(false));
    let mut early = bound("media_close");
    early["mediaId"] = json!("m");
    early["totalBytes"] = json!(3 * mib);
    assert_eq!(validate_event(&mut pending, &mut early), Err("MEDIA_SIZE_MISMATCH".into()));
    // A page cannot smuggle spool fields into a JSON-mode close
    let mut pending = scoped();
    assert_eq!(
      validate_event(&mut pending, &mut media_open(None, 1, None)),
      Ok(false)
    );
    let mut chunk = bound("media_chunk");
    chunk["mediaId"] = json!("m");
    chunk["sequence"] = json!(0);
    chunk["base64"] = json!("AA==");
    assert_eq!(validate_event(&mut pending, &mut chunk), Ok(false));
    let mut close = bound("media_close");
    close["mediaId"] = json!("m");
    close["totalBytes"] = json!(1);
    close["spool"] = json!({"name":"../../evil","bytes":1,"sha256":"00"});
    close["sink"] = json!("spool");
    assert_eq!(validate_event(&mut pending, &mut close), Ok(false));
    assert!(close.get("spool").is_none());
    assert!(close.get("sink").is_none());
  }
  #[test]
  fn spool_resume_offset_must_match_the_request_input() {
    let mib = research_spool::ALIGN;
    let mut pending = spool_pending();
    pending.spool.as_mut().unwrap().resume_offset = 2 * mib;
    pending.spool_writer = Some(dummy_writer());
    assert_eq!(
      validate_event(&mut pending, &mut media_open(Some("spool"), 3 * mib, Some(mib))),
      Err("INVALID_MEDIA".into())
    );
    assert_eq!(
      validate_event(&mut pending, &mut media_open(Some("spool"), 3 * mib, Some(2 * mib))),
      Ok(false)
    );
    assert_eq!(pending.media.get("m").unwrap().bytes, 2 * mib);
  }
}
