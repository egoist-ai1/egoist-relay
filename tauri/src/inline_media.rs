use crate::worker_job::WorkerJob;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{
  Arc, LazyLock, Mutex,
  atomic::{AtomicBool, Ordering},
};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, Webview};
use url::Url;

const SCRIPT: &str = include_str!("../../scripts/inline-media-resolver.mjs");
const MAX_BYTES: usize = 64 * 1024 * 1024;
const MAX_MEDIA_DIMENSION: u32 = 1_000_000;
const TIMEOUT: Duration = Duration::from_secs(125);
const FILE_TIMEOUT: Duration = Duration::from_secs(900);
struct ActiveJob {
  request_id: String,
  cancel: Arc<AtomicBool>,
}
static ACTIVE: LazyLock<Mutex<Option<ActiveJob>>> = LazyLock::new(|| Mutex::new(None));
static CANCELLED: LazyLock<Mutex<Vec<(String, Instant)>>> =
  LazyLock::new(|| Mutex::new(Vec::new()));
static STOPPING: AtomicBool = AtomicBool::new(false);
static COOKIE_READING: AtomicBool = AtomicBool::new(false);

#[tauri::command]
pub async fn relay_inline_resolve_media(
  webview: Webview,
  app_handle: AppHandle,
  url: String,
  request_id: String,
) -> Result<tauri::ipc::Response, String> {
  crate::social_share::require_main(&webview)?;
  validate_request_id(&request_id)?;
  canonicalize_media_url(&url)?;
  let cancel = Arc::new(AtomicBool::new(false));
  tauri::async_runtime::spawn_blocking(move || {
    resolve_public_media(
      &app_handle,
      &request_id,
      &url,
      0,
      MAX_BYTES,
      Instant::now() + TIMEOUT,
      cancel,
    )
  })
  .await
  .map_err(|_| "MEDIA_FETCH_FAILED".to_string())?
  .map(tauri::ipc::Response::new)
}

#[tauri::command]
pub fn relay_inline_cancel_media(webview: Webview, request_id: String) -> Result<(), String> {
  crate::social_share::require_main(&webview)?;
  validate_request_id(&request_id)?;
  remember_cancel(&request_id)?;
  if let Some(job) = ACTIVE
    .lock()
    .map_err(|_| "MEDIA_UNAVAILABLE")?
    .as_ref()
    .filter(|job| job.request_id == request_id)
  {
    job.cancel.store(true, Ordering::Release);
  }
  Ok(())
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SavedMedia {
  pub(crate) path: PathBuf,
  pub(crate) file_name: String,
  pub(crate) mime_type: String,
  pub(crate) size: u64,
  #[serde(skip_serializing_if = "Option::is_none", default)]
  pub(crate) width: Option<u32>,
  #[serde(skip_serializing_if = "Option::is_none", default)]
  pub(crate) height: Option<u32>,
  #[serde(skip_serializing_if = "Option::is_none", default)]
  pub(crate) journal_warning: Option<String>,
}

#[tauri::command]
pub async fn relay_inline_save_media(
  webview: Webview,
  app_handle: AppHandle,
  url: String,
  request_id: String,
) -> Result<SavedMedia, String> {
  crate::social_share::require_main(&webview)?;
  validate_request_id(&request_id)?;
  canonicalize_media_url(&url)?;
  let cancel = Arc::new(AtomicBool::new(false));
  tauri::async_runtime::spawn_blocking(move || {
    save_public_media(&app_handle, &request_id, &url, 0, MAX_BYTES, Instant::now() + FILE_TIMEOUT, cancel)
  })
  .await
  .map_err(|_| "MEDIA_FETCH_FAILED".to_string())?
}

pub(crate) fn resolve_public_media(
  app: &AppHandle,
  request_id: &str,
  value: &str,
  index: usize,
  maximum: usize,
  deadline: Instant,
  cancel: Arc<AtomicBool>,
) -> Result<Vec<u8>, String> {
  let (directory, output, _active) = resolve_media_operation(app, request_id, value, index, maximum, deadline, cancel, false)?;
  directory.cleanup()?;
  Ok(output)
}

pub(crate) fn save_public_media(
  app: &AppHandle,
  request_id: &str,
  value: &str,
  index: usize,
  maximum: usize,
  deadline: Instant,
  cancel: Arc<AtomicBool>,
) -> Result<SavedMedia, String> {
  let (directory, output, _active) = resolve_media_operation(app, request_id, value, index, maximum, deadline, cancel.clone(), true)?;
  let result = publish_saved_media(app, request_id, &directory, &output, index, maximum, &cancel, deadline);
  if directory.cleanup().is_err() {
    log::warn!("[MediaStorage] Owned worker cleanup is incomplete");
  }
  result
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FileResult {
  file_path: PathBuf,
  metadata: FileMetadata,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FileMetadata {
  index: usize,
  name: String,
  mime_type: String,
  size: u64,
  #[serde(default)]
  width: Option<u32>,
  #[serde(default)]
  height: Option<u32>,
}

fn downloads_directory(app: &AppHandle) -> Result<PathBuf, String> {
  let downloads = if std::env::var("EGOIST_RELAY_SMOKE_TEST").as_deref() == Ok("1") {
    crate::multi_app::smoke_download_directory().ok_or("MEDIA_PATH_DENIED")?
  } else {
    app.path().download_dir().map_err(|_| "MEDIA_PATH_DENIED")?
  };
  fs::create_dir_all(&downloads).map_err(|_| "MEDIA_PATH_DENIED")?;
  fs::canonicalize(downloads).map_err(|_| "MEDIA_PATH_DENIED".into())
}

pub(crate) fn publish_saved_media(
  app: &AppHandle,
  request_id: &str,
  directory: &OwnedDirectory,
  packet: &[u8],
  expected_index: usize,
  maximum: usize,
  cancel: &AtomicBool,
  deadline: Instant,
) -> Result<SavedMedia, String> {
  let downloads = downloads_directory(app)?;
  let mut saved = publish_saved_media_in(directory, packet, expected_index, maximum, &downloads, cancel, deadline)?;
  if crate::media_operations::record_saved_file_with_dimensions(app, request_id, &saved.path, &saved.file_name, &saved.mime_type, saved.size, saved.width, saved.height).is_err() {
    saved.journal_warning = Some("MEDIA_JOURNAL_FAILED".into());
    log::warn!("[MediaStorage] File is published; protected history registration failed");
  }
  Ok(saved)
}

fn publish_saved_media_in(
  directory: &OwnedDirectory,
  packet: &[u8],
  expected_index: usize,
  maximum: usize,
  downloads: &Path,
  cancel: &AtomicBool,
  deadline: Instant,
) -> Result<SavedMedia, String> {
  check_deadline(cancel, deadline)?;
  let result: FileResult = serde_json::from_slice(packet).map_err(|_| "MEDIA_PARTIAL_BODY")?;
  if result.metadata.index != expected_index || result.metadata.index >= 10 || result.metadata.size == 0
    || result.metadata.name.len() > 96 || result.metadata.name.is_empty() || result.metadata.name.contains("..")
    || !result.metadata.name.chars().all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '.'))
    || !matches!(result.metadata.mime_type.as_str(), "image/jpeg" | "image/png" | "image/gif" | "image/webp" | "video/mp4" | "video/webm")
  {
    return Err("MEDIA_FORMAT_UNSUPPORTED".into());
  }
  if !matches!((result.metadata.width, result.metadata.height), (None, None) | (Some(1..=MAX_MEDIA_DIMENSION), Some(1..=MAX_MEDIA_DIMENSION))) {
    return Err("MEDIA_FORMAT_UNSUPPORTED".into());
  }
  if maximum == 0 || maximum > MAX_BYTES || result.metadata.size > maximum as u64 {
    return Err("MEDIA_TOO_LARGE".into());
  }
  let canonical_source = fs::canonicalize(&result.file_path).map_err(|_| "MEDIA_PATH_DENIED")?;
  if canonical_source.parent() != Some(directory.path.as_path()) {
    return Err("MEDIA_PATH_DENIED".into());
  }
  let metadata = fs::symlink_metadata(&result.file_path).map_err(|_| "MEDIA_PARTIAL_BODY")?;
  if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() != result.metadata.size {
    return Err("MEDIA_PARTIAL_BODY".into());
  }
  let name = format!("{}-{}", uuid::Uuid::new_v4(), result.metadata.name);
  let destination = downloads.join(&name);
  let staged = create_destination_staging(downloads)?;
  let partial = staged.path.join("media.part");
  copy_and_publish(&canonical_source, &partial, &destination, result.metadata.size, cancel, deadline)?;
  if staged.cleanup().is_err() {
    log::warn!("[MediaStorage] Published file has an owned staging cleanup pending");
  }
  Ok(SavedMedia {
    path: destination,
    file_name: name,
    mime_type: result.metadata.mime_type,
    size: result.metadata.size,
    width: result.metadata.width,
    height: result.metadata.height,
    journal_warning: None,
  })
}

pub(crate) fn create_destination_staging(downloads: &Path) -> Result<OwnedDirectory, String> {
  if downloads.is_symlink() || !downloads.is_dir() { return Err("MEDIA_PATH_DENIED".into()); }
  let downloads = fs::canonicalize(downloads).map_err(|_| "MEDIA_PATH_DENIED")?;
  OwnedDirectory::create_in(downloads.join(".egoist-relay-media"))
}

fn copy_and_publish(
  source: &Path,
  partial: &Path,
  destination: &Path,
  expected_size: u64,
  cancel: &AtomicBool,
  deadline: Instant,
) -> Result<(), String> {
  check_deadline(cancel, deadline)?;
  let mut input = File::open(source).map_err(|_| "MEDIA_PARTIAL_BODY")?;
  if input.metadata().map_err(|_| "MEDIA_PARTIAL_BODY")?.len() != expected_size {
    return Err("MEDIA_PARTIAL_BODY".into());
  }
  let mut output = OpenOptions::new().create_new(true).write(true).open(partial).map_err(|_| "MEDIA_PATH_DENIED")?;
  let result = (|| {
    copy_bytes(&mut input, &mut output, expected_size, cancel, deadline)?;
    output.sync_all().map_err(|_| "MEDIA_DISK_FULL")?;
    check_deadline(cancel, deadline)?;
    drop(output);
    publish_no_replace(partial, destination).map_err(|error| {
      if error.kind() == std::io::ErrorKind::AlreadyExists { "MEDIA_FILE_EXISTS".into() } else { "MEDIA_PATH_DENIED".into() }
    })
  })();
  if result.is_err() {
    let _ = fs::remove_file(partial);
  }
  result
}

fn copy_bytes(
  input: &mut impl Read,
  output: &mut impl Write,
  expected_size: u64,
  cancel: &AtomicBool,
  deadline: Instant,
) -> Result<(), String> {
  let mut buffer = vec![0_u8; 64 * 1024];
  let mut copied = 0_u64;
  loop {
    check_deadline(cancel, deadline)?;
    let length = input.read(&mut buffer).map_err(|_| "MEDIA_PARTIAL_BODY")?;
    if length == 0 { break; }
    copied = copied.checked_add(length as u64).ok_or("MEDIA_TOO_LARGE")?;
    if copied > expected_size { return Err("MEDIA_PARTIAL_BODY".into()); }
    output.write_all(&buffer[..length]).map_err(|_| "MEDIA_DISK_FULL")?;
  }
  if copied != expected_size { return Err("MEDIA_PARTIAL_BODY".into()); }
  Ok(())
}

#[cfg(windows)]
pub(crate) fn publish_no_replace(partial: &Path, destination: &Path) -> std::io::Result<()> {
  use std::os::windows::ffi::OsStrExt;
  #[link(name = "Kernel32")]
  unsafe extern "system" {
    fn MoveFileW(existing: *const u16, new: *const u16) -> i32;
  }
  let partial: Vec<_> = partial.as_os_str().encode_wide().chain(Some(0)).collect();
  let destination: Vec<_> = destination.as_os_str().encode_wide().chain(Some(0)).collect();
  // Both paths share the Downloads volume; `MoveFileW` never replaces a destination
  if unsafe { MoveFileW(partial.as_ptr(), destination.as_ptr()) } == 0 {
    return Err(std::io::Error::last_os_error());
  }
  Ok(())
}

#[cfg(not(windows))]
pub(crate) fn publish_no_replace(partial: &Path, destination: &Path) -> std::io::Result<()> {
  fs::hard_link(partial, destination)?;
  let _ = fs::remove_file(partial);
  Ok(())
}

fn check_deadline(cancel: &AtomicBool, deadline: Instant) -> Result<(), String> {
  if cancel.load(Ordering::Acquire) || STOPPING.load(Ordering::Acquire) {
    return Err("MEDIA_CANCELLED".into());
  }
  if Instant::now() >= deadline {
    return Err("MEDIA_TIMEOUT".into());
  }
  Ok(())
}

fn resolve_media_operation(
  app: &AppHandle,
  request_id: &str,
  value: &str,
  index: usize,
  maximum: usize,
  deadline: Instant,
  cancel: Arc<AtomicBool>,
  is_file_output: bool,
) -> Result<(OwnedDirectory, Vec<u8>, ActiveGuard), String> {
  validate_request_id(request_id)?;
  let url = canonicalize_media_url(value)?;
  if index >= 10 || maximum == 0 || maximum > MAX_BYTES || STOPPING.load(Ordering::Acquire) {
    return Err("MEDIA_INPUT_DENIED".into());
  }
  let active = acquire_job(request_id, cancel.clone())?;
  if cancel.load(Ordering::Acquire) || was_cancelled(request_id)? {
    return Err("MEDIA_CANCELLED".into());
  }
  check_deadline(&cancel, deadline)?;
  let directory = OwnedDirectory::create(app)?;
  let result = run_media_worker(
    app, &directory, &url, index, maximum, deadline, &cancel, None, is_file_output,
  );
  let output = if matches!(&result, Err(code) if code == "MEDIA_AUTH_REQUIRED") {
    if cancel.load(Ordering::Acquire) {
      return Err("MEDIA_CANCELLED".into());
    }
    check_deadline(&cancel, deadline)?;
    let cookies = borrow_service_cookies(app, &url, &cancel, deadline)?;
    check_deadline(&cancel, deadline)?;
    run_media_worker(
      app,
      &directory,
      &url,
      index,
      maximum,
      deadline,
      &cancel,
      Some(cookies),
      is_file_output,
    )?
  } else {
    result?
  };
  Ok((directory, output, active))
}

fn borrow_service_cookies(
  app: &AppHandle,
  value: &str,
  cancel: &AtomicBool,
  deadline: Instant,
) -> Result<Vec<serde_json::Value>, String> {
  check_deadline(cancel, deadline)?;
  let cookie_deadline = deadline.min(Instant::now() + Duration::from_secs(5));
  if COOKIE_READING
    .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
    .is_err()
  {
    return Err("MEDIA_BUSY".into());
  }
  let app = app.clone();
  let value = value.to_string();
  let (sender, receiver) = std::sync::mpsc::sync_channel(1);
  std::thread::spawn(move || {
    let result = borrow_service_cookies_inner(&app, &value);
    COOKIE_READING.store(false, Ordering::Release);
    let _ = sender.send(result);
  });
  await_cookie_result(
    receiver,
    cancel,
    cookie_deadline,
  )
}

fn await_cookie_result(
  receiver: std::sync::mpsc::Receiver<Result<Vec<serde_json::Value>, String>>,
  cancel: &AtomicBool,
  deadline: Instant,
) -> Result<Vec<serde_json::Value>, String> {
  loop {
    if cancel.load(Ordering::Acquire) || STOPPING.load(Ordering::Acquire) {
      return Err("MEDIA_CANCELLED".into());
    }
    if Instant::now() >= deadline {
      return Err("MEDIA_TIMEOUT".into());
    }
    match receiver.recv_timeout(Duration::from_millis(25)) {
      Ok(result) => return result,
      Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
        return Err("MEDIA_AUTH_REQUIRED".into());
      }
      Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
    }
  }
}

fn borrow_service_cookies_inner(
  app: &AppHandle,
  value: &str,
) -> Result<Vec<serde_json::Value>, String> {
  let url = Url::parse(value).map_err(|_| "MEDIA_URL_DENIED")?;
  let (label, domain) = match url.host_str() {
    Some("x.com") => ("x_webview", "x.com"),
    Some("www.instagram.com") => ("instagram_webview", "instagram.com"),
    _ => return Err("MEDIA_AUTH_REQUIRED".into()),
  };
  let child = app.get_webview(label).ok_or("MEDIA_AUTH_REQUIRED")?;
  let current = child.url().map_err(|_| "MEDIA_AUTH_REQUIRED")?;
  if current.scheme() != "https"
    || !matches!(current.host_str(), Some(host) if host == domain || host == format!("www.{domain}"))
  {
    return Err("MEDIA_AUTH_REQUIRED".into());
  }
  let cookies = child
    .cookies_for_url(url)
    .map_err(|_| "MEDIA_AUTH_REQUIRED")?;
  if cookies.len() > 32 {
    return Err("MEDIA_SESSION_LIMIT".into());
  }
  let mut filtered = Vec::new();
  for cookie in cookies {
    let cookie_domain = cookie.domain().unwrap_or(domain);
    if cookie_domain.trim_start_matches('.') != domain {
      continue;
    }
    let name = cookie.name();
    let value = cookie.value();
    let path = cookie.path().unwrap_or("/");
    if name.is_empty()
      || name.len() > 128
      || value.len() > 8192
      || path.len() > 1024
      || [name, value, path]
        .iter()
        .any(|value| value.chars().any(|ch| ch <= '\u{1f}' || ch == '\u{7f}'))
    {
      return Err("MEDIA_SESSION_LIMIT".into());
    }
    filtered.push(serde_json::json!({"domain":cookie_domain,"path":path,"secure":cookie.secure().unwrap_or(true),"expires":cookie.expires_datetime().map_or(0, |date| date.unix_timestamp().max(0)),"name":name,"value":value}));
  }
  if filtered.is_empty() {
    return Err("MEDIA_AUTH_REQUIRED".into());
  }
  if serde_json::to_vec(&filtered)
    .map_err(|_| "MEDIA_SESSION_LIMIT")?
    .len()
    > 65536
  {
    return Err("MEDIA_SESSION_LIMIT".into());
  }
  Ok(filtered)
}

fn run_media_worker(
  app: &AppHandle,
  directory: &OwnedDirectory,
  url: &str,
  index: usize,
  maximum: usize,
  deadline: Instant,
  cancel: &Arc<AtomicBool>,
  cookies: Option<Vec<serde_json::Value>>,
  is_file_output: bool,
) -> Result<Vec<u8>, String> {
  check_deadline(cancel, deadline)?;
  let node = crate::runtime::find_node_binary(app).map_err(|_| "MEDIA_RUNTIME_UNAVAILABLE")?;
  let engine = find_resource(app, "yt-dlp.exe").ok_or("MEDIA_RUNTIME_UNAVAILABLE")?;
  let ffmpeg = find_resource(app, "media/ffmpeg.exe").ok_or("MEDIA_RUNTIME_UNAVAILABLE")?;
  find_resource(app, "media/ffprobe.exe").ok_or("MEDIA_RUNTIME_UNAVAILABLE")?;
  let proxy = crate::system_proxy::proxy_for_url_cancellable(url, cancel, deadline)
    .map_err(|_| check_deadline(cancel, deadline).err().unwrap_or_else(|| "MEDIA_PROXY_FAILED".into()))?;
  if cancel.load(Ordering::Acquire) || STOPPING.load(Ordering::Acquire) {
    return Err("MEDIA_CANCELLED".into());
  }
  check_deadline(cancel, deadline)?;
  let mut command = Command::new(&node);
  crate::social_share::sanitize_media_worker_environment(&mut command);
  let script = directory.prepare_worker("inline-media-resolver.mjs", SCRIPT)?;
  command
    .arg(script)
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .current_dir(&directory.path)
    .env("TEMP", &directory.path)
    .env("TMP", &directory.path)
    .env("EGOIST_RELAY_MEDIA_PROXY", proxy.as_ref().map_or("direct", Url::as_str));
  crate::runtime::hide_command_window(&mut command);
  let mut child = command.spawn().map_err(|_| "MEDIA_RUNTIME_UNAVAILABLE")?;
  let scoped = match WorkerJob::attach(&child) {
    Ok(job) => job,
    Err(error) => {
      let _ = child.kill();
      let _ = child.wait();
      return Err(error);
    }
  };
  let input = serde_json::json!({ "url": url, "enginePath": engine, "nodePath": node, "tempDir": directory.path, "index": index, "maxBytes": maximum });
  let mut input = input;
  input["ffmpegPath"] = serde_json::json!(ffmpeg);
  if is_file_output { input["outputMode"] = serde_json::json!("file"); }
  if let Some(cookies) = cookies {
    input["cookies"] = serde_json::json!(cookies);
  }
  if child
    .stdin
    .take()
    .ok_or("MEDIA_FETCH_FAILED")
    .and_then(|mut stdin| {
      stdin
        .write_all(input.to_string().as_bytes())
        .map_err(|_| "MEDIA_FETCH_FAILED")
    })
    .is_err()
  {
    scoped.terminate();
    let _ = child.kill();
    let _ = child.wait();
    return Err("MEDIA_FETCH_FAILED".into());
  }
  let stdout = child.stdout.take().ok_or("MEDIA_FETCH_FAILED")?;
  let stderr = child.stderr.take().ok_or("MEDIA_FETCH_FAILED")?;
  let output_limit = if is_file_output { 64 * 1024 } else { MAX_BYTES + 1033 };
  let output_reader = std::thread::spawn(move || {
    let mut bytes = Vec::new();
    stdout
      .take(output_limit as u64)
      .read_to_end(&mut bytes)
      .map(|_| bytes)
  });
  let error_reader = std::thread::spawn(move || {
    let mut bytes = Vec::new();
    stderr.take(1024).read_to_end(&mut bytes).map(|_| bytes)
  });
  let status = loop {
    if cancel.load(Ordering::Acquire)
      || Instant::now() >= deadline
      || STOPPING.load(Ordering::Acquire)
    {
      scoped.terminate();
      let _ = child.kill();
      break child.wait().map_err(|_| "MEDIA_FETCH_FAILED");
    }
    match child.try_wait() {
      Ok(Some(status)) => break Ok(status),
      Ok(None) => std::thread::sleep(Duration::from_millis(30)),
      Err(_) => {
        scoped.terminate();
        let _ = child.kill();
        let _ = child.wait();
        break Err("MEDIA_FETCH_FAILED");
      }
    }
  };
  scoped.terminate();
  let output = output_reader
    .join()
    .map_err(|_| "MEDIA_FETCH_FAILED")?
    .map_err(|_| "MEDIA_FETCH_FAILED")?;
  let error = error_reader
    .join()
    .map_err(|_| "MEDIA_FETCH_FAILED")?
    .map_err(|_| "MEDIA_FETCH_FAILED")?;
  if cancel.load(Ordering::Acquire) || STOPPING.load(Ordering::Acquire) {
    return Err("MEDIA_CANCELLED".into());
  }
  if Instant::now() >= deadline {
    return Err("MEDIA_TIMEOUT".into());
  }
  if !status.map_err(str::to_string)?.success() {
    let code = String::from_utf8_lossy(&error);
    if code.starts_with("MEDIA_")
      && code.len() < 64
      && code.chars().all(|ch| ch.is_ascii_uppercase() || ch == '_')
    {
      return Err(code.into_owned());
    }
    return Err("MEDIA_FETCH_FAILED".into());
  }
  if !is_file_output { crate::social_share::validate_media_packet(&output, index, maximum)?; }
  Ok(output)
}

struct ActiveGuard(String);
fn acquire_job(request_id: &str, cancel: Arc<AtomicBool>) -> Result<ActiveGuard, String> {
  let mut active = ACTIVE.lock().map_err(|_| "MEDIA_UNAVAILABLE")?;
  if cancel.load(Ordering::Acquire) || was_cancelled(request_id)? {
    return Err("MEDIA_CANCELLED".into());
  }
  if active.is_some() {
    return Err("MEDIA_BUSY".into());
  }
  *active = Some(ActiveJob {
    request_id: request_id.to_string(),
    cancel,
  });
  Ok(ActiveGuard(request_id.to_string()))
}
impl Drop for ActiveGuard {
  fn drop(&mut self) {
    if let Ok(mut active) = ACTIVE.lock() {
      if active.as_ref().is_some_and(|job| job.request_id == self.0) {
        *active = None;
      }
    }
  }
}

fn validate_request_id(value: &str) -> Result<(), String> {
  if value.len() != 36 || uuid::Uuid::parse_str(value).is_err() {
    return Err("MEDIA_INPUT_DENIED".into());
  }
  Ok(())
}

fn remember_cancel(request_id: &str) -> Result<(), String> {
  let mut cancelled = CANCELLED.lock().map_err(|_| "MEDIA_UNAVAILABLE")?;
  cancelled.retain(|(_, created)| created.elapsed() < Duration::from_secs(180));
  if !cancelled.iter().any(|(value, _)| value == request_id) {
    if cancelled.len() == 128 {
      cancelled.remove(0);
    }
    cancelled.push((request_id.to_string(), Instant::now()));
  }
  Ok(())
}

fn was_cancelled(request_id: &str) -> Result<bool, String> {
  let mut cancelled = CANCELLED.lock().map_err(|_| "MEDIA_UNAVAILABLE")?;
  cancelled.retain(|(_, created)| created.elapsed() < Duration::from_secs(180));
  Ok(cancelled.iter().any(|(value, _)| value == request_id))
}

pub(crate) fn canonicalize_media_url(value: &str) -> Result<String, String> {
  if value.len() > 4096
    || value.chars().any(|ch| ch <= ' ' || ch == '\\' || ch == '%')
    || value.split('/').any(|part| {
      part == "."
        || part == ".."
        || part.starts_with(".?")
        || part.starts_with("..?")
        || part.starts_with(".#")
        || part.starts_with("..#")
    })
  {
    return Err("MEDIA_URL_DENIED".into());
  }
  let url = Url::parse(value).map_err(|_| "MEDIA_URL_DENIED")?;
  if url.scheme() != "https"
    || !url.username().is_empty()
    || url.password().is_some()
    || url.port_or_known_default() != Some(443)
  {
    return Err("MEDIA_URL_DENIED".into());
  }
  let host = url.host_str().ok_or("MEDIA_URL_DENIED")?;
  let raw_path = url.path().strip_suffix('/').unwrap_or(url.path());
  let segments: Vec<_> = raw_path
    .strip_prefix('/')
    .ok_or("MEDIA_URL_DENIED")?
    .split('/')
    .collect();
  if segments.iter().any(|part| part.is_empty()) {
    return Err("MEDIA_URL_DENIED".into());
  }
  if matches!(
    host,
    "youtube.com" | "www.youtube.com" | "m.youtube.com" | "youtu.be"
  ) {
    let video: String = if host == "youtu.be" && segments.len() == 1 {
      segments[0].into()
    } else if url.path() == "/watch" {
      let values: Vec<_> = url
        .query_pairs()
        .filter(|(key, _)| key == "v")
        .map(|(_, value)| value.to_string())
        .collect();
      if values.len() != 1 {
        return Err("MEDIA_URL_DENIED".into());
      }
      values[0].clone()
    } else if segments.len() == 2 && matches!(segments[0], "shorts" | "embed") {
      segments[1].into()
    } else {
      return Err("MEDIA_URL_DENIED".into());
    };
    if video.len() != 11
      || !video
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
    {
      return Err("MEDIA_URL_DENIED".into());
    }
    return Ok(format!("https://www.youtube.com/watch?v={video}"));
  }
  if matches!(host, "instagram.com" | "www.instagram.com")
    && segments.len() == 2
    && matches!(segments[0], "p" | "reel" | "reels" | "tv")
    && (5..=64).contains(&segments[1].len())
    && segments[1]
      .chars()
      .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
  {
    return Ok(format!(
      "https://www.instagram.com/{}/{}/",
      if segments[0] == "reels" { "reel" } else { segments[0] }, segments[1]
    ));
  }
  if matches!(
    host,
    "x.com" | "www.x.com" | "twitter.com" | "www.twitter.com" | "mobile.twitter.com"
  ) && segments.len() == 3
    && segments[1] == "status"
    && (1..=30).contains(&segments[0].len())
    && segments[0]
      .chars()
      .all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
    && (5..=24).contains(&segments[2].len())
    && segments[2].chars().all(|ch| ch.is_ascii_digit())
  {
    return Ok(format!("https://x.com/i/status/{}", segments[2]));
  }
  Err("MEDIA_URL_DENIED".into())
}

fn find_resource(app: &AppHandle, name: &str) -> Option<PathBuf> {
  let mut candidates = Vec::new();
  if let Ok(root) = app.path().resource_dir() {
    candidates.push(root.join("runtime").join(name));
  }
  if let Ok(executable) = std::env::current_exe() {
    if let Some(root) = executable.parent() {
      candidates.push(root.join("runtime").join(name));
      candidates.push(root.join("resources/runtime").join(name));
    }
  }
  #[cfg(debug_assertions)]
  candidates.push(
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
      .join("../runtime")
      .join(name),
  );
  candidates
    .into_iter()
    .find(|path| path.is_file() && !path.is_symlink())
}

pub(crate) struct OwnedDirectory {
  root: PathBuf,
  path: PathBuf,
  lock: Option<File>,
}
impl OwnedDirectory {
  pub(crate) fn create(app: &AppHandle) -> Result<Self, String> {
    Self::create_in(resolve_cache_root(app)?)
  }
  fn create_in(root: PathBuf) -> Result<Self, String> {
    if root.exists() && root.is_symlink() {
      return Err("MEDIA_PATH_DENIED".into());
    }
    fs::create_dir_all(&root).map_err(|_| "MEDIA_PATH_DENIED")?;
    let root = fs::canonicalize(root).map_err(|_| "MEDIA_PATH_DENIED")?;
    cleanup_stale(&root);
    let path = root.join(format!("job-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&path).map_err(|_| "MEDIA_PATH_DENIED")?;
    let lock = match open_lock(&path.join("owner.lock"), true) {
      Ok(lock) => lock,
      Err(_) => {
        let _ = remove_owned_directory(&root, &path);
        return Err("MEDIA_PATH_DENIED".into());
      }
    };
    Ok(Self {
      root,
      path,
      lock: Some(lock),
    })
  }
  pub(crate) fn worker_directory(&self) -> &Path { &self.path }
  pub(crate) fn prepare_worker(&self, name: &str, source: &str) -> Result<PathBuf, String> {
    if !matches!(name, "inline-media-resolver.mjs" | "social-media-fetch.mjs" | "telegram-transport.cjs") {
      return Err("MEDIA_PATH_DENIED".into());
    }
    let files = if name == "telegram-transport.cjs" { vec![(name, source)] } else {
      vec![("media-proxy.mjs", include_str!("../../scripts/media-proxy.mjs")), (name, source)]
    };
    for (file_name, contents) in files {
      let path = self.path.join(file_name);
      match OpenOptions::new().write(true).create_new(true).open(&path) {
        Ok(mut file) => file.write_all(contents.as_bytes()).map_err(|_| "MEDIA_PATH_DENIED")?,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
          let metadata = fs::symlink_metadata(&path).map_err(|_| "MEDIA_PATH_DENIED")?;
          if !metadata.is_file() || metadata.file_type().is_symlink()
            || fs::read(&path).map_err(|_| "MEDIA_PATH_DENIED")? != contents.as_bytes()
          {
            return Err("MEDIA_PATH_DENIED".into());
          }
        }
        Err(_) => return Err("MEDIA_PATH_DENIED".into()),
      }
    }
    Ok(self.path.join(name))
  }
  pub(crate) fn cleanup(mut self) -> Result<(), String> {
    self.lock.take();
    remove_owned_directory(&self.root, &self.path)
  }
}

fn resolve_cache_root(app: &AppHandle) -> Result<PathBuf, String> {
  let root = if std::env::var("EGOIST_RELAY_SMOKE_TEST").as_deref() == Ok("1") {
    PathBuf::from(std::env::var_os("EGOIST_RELAY_TEST_PROFILE").ok_or("MEDIA_PATH_DENIED")?)
      .join("public-media")
  } else {
    app
      .path()
      .app_cache_dir()
      .map_err(|_| "MEDIA_PATH_DENIED")?
      .join("public-media")
  };
  Ok(root)
}

pub(crate) fn initialize(app: &AppHandle) -> Result<(), String> {
  let staging = downloads_directory(app)?.join(".egoist-relay-media");
  if staging.exists() {
    if staging.is_symlink() { return Err("MEDIA_PATH_DENIED".into()); }
    cleanup_stale(&fs::canonicalize(staging).map_err(|_| "MEDIA_PATH_DENIED")?);
  }
  let root = resolve_cache_root(app)?;
  if !root.exists() {
    return Ok(());
  }
  if root.is_symlink() {
    return Err("MEDIA_PATH_DENIED".into());
  }
  cleanup_stale(&fs::canonicalize(root).map_err(|_| "MEDIA_PATH_DENIED")?);
  Ok(())
}
impl Drop for OwnedDirectory {
  fn drop(&mut self) {
    self.lock.take();
    let _ = remove_owned_directory(&self.root, &self.path);
  }
}

fn open_lock(path: &Path, create: bool) -> std::io::Result<File> {
  let mut options = OpenOptions::new();
  options.read(true).write(true).create_new(create);
  #[cfg(windows)]
  {
    use std::os::windows::fs::OpenOptionsExt;
    options.share_mode(0);
  }
  options.open(path)
}
fn remove_owned_directory(root: &Path, path: &Path) -> Result<(), String> {
  if path.parent() != Some(root) {
    return Err("MEDIA_PATH_DENIED".into());
  }
  let name = path
    .file_name()
    .and_then(|name| name.to_str())
    .ok_or("MEDIA_PATH_DENIED")?;
  if !name.starts_with("job-") || uuid::Uuid::parse_str(&name[4..]).is_err() || path.is_symlink() {
    return Err("MEDIA_PATH_DENIED".into());
  }
  for _ in 0..10 {
    match fs::remove_dir_all(path) {
      Ok(()) => return Ok(()),
      Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
      Err(_) => std::thread::sleep(Duration::from_millis(50)),
    }
  }
  Err("MEDIA_CLEANUP_FAILED".into())
}
fn cleanup_stale(root: &Path) {
  let Ok(entries) = fs::read_dir(root) else {
    return;
  };
  for entry in entries.take(64).flatten() {
    let path = entry.path();
    let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
      continue;
    };
    if !name.starts_with("job-")
      || uuid::Uuid::parse_str(&name[4..]).is_err()
      || path.is_symlink()
      || !path.is_dir()
    {
      continue;
    }
    let marker = path.join("owner.lock");
    if marker.is_symlink() {
      continue;
    }
    if let Ok(lock) = open_lock(&marker, false) {
      drop(lock);
      let _ = remove_owned_directory(root, &path);
    }
  }
}

pub(crate) fn shutdown() {
  STOPPING.store(true, Ordering::Release);
  if let Ok(active) = ACTIVE.lock() {
    if let Some(job) = active.as_ref() {
      job.cancel.store(true, Ordering::Release);
    }
  }
  let deadline = Instant::now() + Duration::from_secs(2);
  while Instant::now() < deadline {
    if ACTIVE.lock().map_or(true, |active| active.is_none()) {
      return;
    }
    std::thread::sleep(Duration::from_millis(25));
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn file_workers_are_repeatable_and_reject_replacement_or_unexpected_names() {
    let Some(work) = std::env::var_os("EGOIST_RELAY_TEST_WORK") else { return; };
    let root = PathBuf::from(work).join(format!("worker-test-{}", uuid::Uuid::new_v4()));
    let directory = OwnedDirectory::create_in(root.clone()).unwrap();
    let path = directory.prepare_worker("inline-media-resolver.mjs", SCRIPT).unwrap();
    assert_eq!(fs::read_to_string(&path).unwrap(), SCRIPT);
    assert_eq!(directory.prepare_worker("inline-media-resolver.mjs", SCRIPT).unwrap(), path);
    assert!(directory.prepare_worker("../worker.mjs", SCRIPT).is_err());
    fs::write(&path, "modified").unwrap();
    assert!(directory.prepare_worker("inline-media-resolver.mjs", SCRIPT).is_err());
    directory.cleanup().unwrap();
    assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
    fs::remove_dir(&root).unwrap();
  }

  #[test]
  fn instagram_urls_use_the_same_canonical_forms_as_the_ui() {
    assert_eq!(canonicalize_media_url("https://www.instagram.com/reels/AbCdE12345/").unwrap(), "https://www.instagram.com/reel/AbCdE12345/");
    assert_eq!(canonicalize_media_url("https://www.instagram.com/tv/AbCdE12345/").unwrap(), "https://www.instagram.com/tv/AbCdE12345/");
  }

  #[test]
  fn source_urls_reject_ambiguous_paths_and_query_ids() {
    assert!(canonicalize_media_url("https://www.youtube.com/watch?v=abcdefghijk&v=lmnopqrstuv").is_err());
    assert!(canonicalize_media_url("https://x.com/name/../name/status/1234567890123456789").is_err());
    assert!(canonicalize_media_url("https://www.instagram.com.evil.test/reel/AbCdE12345/").is_err());
  }

  fn create_storage_fixture() -> (OwnedDirectory, PathBuf, PathBuf) {
    let work = std::env::var_os("EGOIST_RELAY_TEST_WORK").expect("Native file tests require EGOIST_RELAY_TEST_WORK");
    let root = PathBuf::from(work).join(format!("storage-test-{}", uuid::Uuid::new_v4()));
    let source = OwnedDirectory::create_in(root.join("workers")).unwrap();
    let downloads = root.join("downloads");
    fs::create_dir(&downloads).unwrap();
    (source, downloads, root)
  }

  fn create_file_packet(directory: &OwnedDirectory, bytes: &[u8]) -> Vec<u8> {
    let path = directory.path.join("source.jpg");
    fs::write(&path, bytes).unwrap();
    serde_json::to_vec(&serde_json::json!({
      "filePath": path,
      "metadata": { "index": 0, "name": "relay-source-1.jpg", "mimeType": "image/jpeg", "size": bytes.len() }
    })).unwrap()
  }

  #[test]
  fn atomic_publication_preserves_exact_bytes_and_separates_name_collisions() {
    let (source, downloads, root) = create_storage_fixture();
    let bytes: Vec<_> = (0..180_000).map(|index| (index % 251) as u8).collect();
    let packet = create_file_packet(&source, &bytes);
    let cancel = AtomicBool::new(false);
    let first = publish_saved_media_in(&source, &packet, 0, MAX_BYTES, &downloads, &cancel, Instant::now() + Duration::from_secs(5)).unwrap();
    let second = publish_saved_media_in(&source, &packet, 0, MAX_BYTES, &downloads, &cancel, Instant::now() + Duration::from_secs(5)).unwrap();
    assert_ne!(first.path, second.path);
    assert_eq!(first.size, bytes.len() as u64);
    assert_eq!(fs::read(&first.path).unwrap(), bytes);
    assert_eq!(fs::read(&second.path).unwrap(), bytes);
    assert_eq!(fs::read_dir(downloads.join(".egoist-relay-media")).unwrap().count(), 0);
    source.cleanup().unwrap();
    fs::remove_dir_all(root).unwrap();
  }

  #[test]
  fn atomic_publication_never_overwrites_a_destination_or_existing_partial() {
    let (source, downloads, root) = create_storage_fixture();
    let input = source.path.join("source.jpg");
    let partial = source.path.join("media.part");
    let destination = downloads.join("same.jpg");
    fs::write(&input, b"new bytes").unwrap();
    fs::write(&destination, b"existing file").unwrap();
    let cancel = AtomicBool::new(false);
    assert_eq!(copy_and_publish(&input, &partial, &destination, 9, &cancel, Instant::now() + Duration::from_secs(5)), Err("MEDIA_FILE_EXISTS".into()));
    assert_eq!(fs::read(&destination).unwrap(), b"existing file");
    assert!(!partial.exists());
    fs::write(&partial, b"unowned existing partial").unwrap();
    assert_eq!(copy_and_publish(&input, &partial, &destination, 9, &cancel, Instant::now() + Duration::from_secs(5)), Err("MEDIA_PATH_DENIED".into()));
    assert_eq!(fs::read(&partial).unwrap(), b"unowned existing partial");
    source.cleanup().unwrap();
    fs::remove_dir_all(root).unwrap();
  }

  #[test]
  fn publication_rejects_stale_deadline_cancellation_and_partial_metadata() {
    let (source, downloads, root) = create_storage_fixture();
    let packet = create_file_packet(&source, b"media bytes");
    let cancel = AtomicBool::new(false);
    assert!(matches!(publish_saved_media_in(&source, &packet, 0, MAX_BYTES, &downloads, &cancel, Instant::now() - Duration::from_millis(1)), Err(error) if error == "MEDIA_TIMEOUT"));
    cancel.store(true, Ordering::Release);
    assert!(matches!(publish_saved_media_in(&source, &packet, 0, MAX_BYTES, &downloads, &cancel, Instant::now() + Duration::from_secs(5)), Err(error) if error == "MEDIA_CANCELLED"));
    cancel.store(false, Ordering::Release);
    let mut wrong: serde_json::Value = serde_json::from_slice(&packet).unwrap();
    wrong["metadata"]["size"] = serde_json::json!(8);
    let wrong = serde_json::to_vec(&wrong).unwrap();
    assert!(matches!(publish_saved_media_in(&source, &wrong, 0, MAX_BYTES, &downloads, &cancel, Instant::now() + Duration::from_secs(5)), Err(error) if error == "MEDIA_PARTIAL_BODY"));
    assert!(matches!(publish_saved_media_in(&source, &packet, 0, 5, &downloads, &cancel, Instant::now() + Duration::from_secs(5)), Err(error) if error == "MEDIA_TOO_LARGE"));
    assert_eq!(fs::read_dir(&downloads).unwrap().count(), 0);
    source.cleanup().unwrap();
    fs::remove_dir_all(root).unwrap();
  }

  #[test]
  fn failed_publication_cleans_its_partial_without_touching_the_source() {
    let (source, downloads, root) = create_storage_fixture();
    let input = source.path.join("source.jpg");
    let partial = source.path.join("media.part");
    let destination = downloads.join("absent-parent").join("file.jpg");
    fs::write(&input, b"media bytes").unwrap();
    assert!(copy_and_publish(&input, &partial, &destination, 11, &AtomicBool::new(false), Instant::now() + Duration::from_secs(5)).is_err());
    assert!(!partial.exists());
    assert!(!destination.exists());
    assert_eq!(fs::read(&input).unwrap(), b"media bytes");
    source.cleanup().unwrap();
    fs::remove_dir_all(root).unwrap();
  }

  #[test]
  fn copying_reports_disk_failure_and_observes_cancel_between_chunks() {
    struct FailedDisk;
    impl Write for FailedDisk {
      fn write(&mut self, _: &[u8]) -> std::io::Result<usize> { Err(std::io::Error::new(std::io::ErrorKind::StorageFull, "Injected disk full")) }
      fn flush(&mut self) -> std::io::Result<()> { Ok(()) }
    }
    let cancel = AtomicBool::new(false);
    assert_eq!(copy_bytes(&mut std::io::Cursor::new(b"bytes"), &mut FailedDisk, 5, &cancel, Instant::now() + Duration::from_secs(5)), Err("MEDIA_DISK_FULL".into()));
    struct CancelAfterRead<'a> { cancel: &'a AtomicBool, body: std::io::Cursor<Vec<u8>> }
    impl Read for CancelAfterRead<'_> {
      fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
        let count = self.body.read(output)?;
        self.cancel.store(true, Ordering::Release);
        Ok(count)
      }
    }
    let mut input = CancelAfterRead { cancel: &cancel, body: std::io::Cursor::new(vec![1; 128 * 1024]) };
    let mut output = Vec::new();
    assert_eq!(copy_bytes(&mut input, &mut output, 128 * 1024, &cancel, Instant::now() + Duration::from_secs(5)), Err("MEDIA_CANCELLED".into()));
    assert!(output.len() < 128 * 1024);
  }

  #[test]
  fn crash_child_stages_owned_partial() {
    let Some(root) = std::env::var_os("EGOIST_RELAY_CRASH_CHILD_ROOT") else { return; };
    let directory = OwnedDirectory::create_in(PathBuf::from(root)).unwrap();
    fs::write(directory.path.join("media.part"), b"unfinished media").unwrap();
    std::process::exit(0);
  }

  #[test]
  fn crash_recovery_removes_only_owned_unfinished_staging() {
    let (source, downloads, root) = create_storage_fixture();
    let staging = downloads.join(".egoist-relay-media");
    let status = Command::new(std::env::current_exe().unwrap())
      .args(["--exact", "inline_media::tests::crash_child_stages_owned_partial", "--nocapture"])
      .env("EGOIST_RELAY_CRASH_CHILD_ROOT", &staging)
      .status().unwrap();
    assert!(status.success());
    let unfinished: Vec<_> = fs::read_dir(&staging).unwrap().flatten().map(|entry| entry.path()).collect();
    assert_eq!(unfinished.len(), 1);
    assert_eq!(fs::read(unfinished[0].join("media.part")).unwrap(), b"unfinished media");
    assert_eq!(fs::read_dir(&downloads).unwrap().count(), 1);
    let unrelated = staging.join(format!("job-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&unrelated).unwrap();
    fs::write(unrelated.join("foreign.txt"), b"keep").unwrap();
    cleanup_stale(&staging);
    assert!(!unfinished[0].exists());
    assert_eq!(fs::read(unrelated.join("foreign.txt")).unwrap(), b"keep");
    source.cleanup().unwrap();
    fs::remove_dir_all(root).unwrap();
  }


  #[test]
  fn publication_preserves_known_dimensions_and_rejects_incomplete_metadata() {
    let (source, downloads, root) = create_storage_fixture();
    let packet = create_file_packet(&source, b"media bytes");
    let mut metadata: serde_json::Value = serde_json::from_slice(&packet).unwrap();
    metadata["metadata"]["width"] = serde_json::json!(3000);
    metadata["metadata"]["height"] = serde_json::json!(2000);
    let sized = serde_json::to_vec(&metadata).unwrap();
    let cancel = AtomicBool::new(false);
    let saved = publish_saved_media_in(&source, &sized, 0, MAX_BYTES, &downloads, &cancel, Instant::now() + Duration::from_secs(5)).unwrap();
    assert_eq!((saved.width, saved.height), (Some(3000), Some(2000)));
    metadata["metadata"]["height"] = serde_json::Value::Null;
    let incomplete = serde_json::to_vec(&metadata).unwrap();
    assert!(matches!(publish_saved_media_in(&source, &incomplete, 0, MAX_BYTES, &downloads, &cancel, Instant::now() + Duration::from_secs(5)), Err(error) if error == "MEDIA_FORMAT_UNSUPPORTED"));
    source.cleanup().unwrap();
    fs::remove_dir_all(root).unwrap();
  }

}
