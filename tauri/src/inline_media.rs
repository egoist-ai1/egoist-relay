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
      TIMEOUT,
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
  path: PathBuf,
  file_name: String,
  mime_type: String,
  pub(crate) size: u64,
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
    save_public_media(&app_handle, &request_id, &url, 0, cancel)
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
  timeout: Duration,
  cancel: Arc<AtomicBool>,
) -> Result<Vec<u8>, String> {
  let (directory, output, _active) = resolve_media_operation(app, request_id, value, index, maximum, timeout, cancel, false)?;
  directory.cleanup()?;
  Ok(output)
}

pub(crate) fn save_public_media(
  app: &AppHandle,
  request_id: &str,
  value: &str,
  index: usize,
  cancel: Arc<AtomicBool>,
) -> Result<SavedMedia, String> {
  let (directory, output, _active) = resolve_media_operation(app, request_id, value, index, MAX_BYTES, FILE_TIMEOUT, cancel.clone(), true)?;
  let result = publish_saved_media(app, &directory, &output, index, &cancel);
  directory.cleanup()?;
  result
}

pub(crate) fn publish_saved_media(
  app: &AppHandle,
  directory: &OwnedDirectory,
  packet: &[u8],
  expected_index: usize,
  cancel: &AtomicBool,
) -> Result<SavedMedia, String> {
  #[derive(serde::Deserialize)]
  #[serde(rename_all = "camelCase", deny_unknown_fields)]
  struct FileResult { file_path: PathBuf, metadata: FileMetadata }
  #[derive(serde::Deserialize)]
  #[serde(rename_all = "camelCase", deny_unknown_fields)]
  struct FileMetadata { index: usize, name: String, mime_type: String, size: u64 }
  let result: FileResult = serde_json::from_slice(packet).map_err(|_| "MEDIA_PARTIAL_BODY")?;
  if result.metadata.index != expected_index || result.metadata.index >= 10 || result.metadata.size == 0 || result.metadata.name.len() > 96
    || result.metadata.name.is_empty() || result.metadata.name.contains("..")
    || !result.metadata.name.chars().all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '.'))
    || !matches!(result.metadata.mime_type.as_str(), "image/jpeg" | "image/png" | "image/gif" | "image/webp" | "video/mp4" | "video/webm")

  { return Err("MEDIA_FORMAT_UNSUPPORTED".into()); }
  let canonical_source = fs::canonicalize(&result.file_path).map_err(|_| "MEDIA_PATH_DENIED")?;
  if canonical_source.parent() != Some(directory.path.as_path()) { return Err("MEDIA_PATH_DENIED".into()); }
  let metadata = fs::symlink_metadata(&result.file_path).map_err(|_| "MEDIA_PARTIAL_BODY")?;
  if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() != result.metadata.size {
    return Err("MEDIA_PARTIAL_BODY".into());
  }
  let downloads = if std::env::var("EGOIST_RELAY_SMOKE_TEST").as_deref() == Ok("1") {
    crate::multi_app::smoke_download_directory().ok_or("MEDIA_PATH_DENIED")?
  } else { app.path().download_dir().map_err(|_| "MEDIA_PATH_DENIED")? };
  fs::create_dir_all(&downloads).map_err(|_| "MEDIA_PATH_DENIED")?;
  let downloads = fs::canonicalize(downloads).map_err(|_| "MEDIA_PATH_DENIED")?;
  let name = format!("{}-{}", uuid::Uuid::new_v4(), result.metadata.name);
  let destination = downloads.join(&name);
  let mut input = File::open(&result.file_path).map_err(|_| "MEDIA_PARTIAL_BODY")?;
  let mut output = OpenOptions::new().create_new(true).write(true).open(&destination).map_err(|_| "MEDIA_PATH_DENIED")?;
  let copy_result = (|| {
    let deadline = Instant::now() + FILE_TIMEOUT;
    let mut buffer = vec![0_u8; 64 * 1024];
    let mut copied = 0_u64;
    loop {
      if cancel.load(Ordering::Acquire) || STOPPING.load(Ordering::Acquire) { return Err("MEDIA_CANCELLED"); }
      if Instant::now() >= deadline { return Err("MEDIA_TIMEOUT"); }
      let length = input.read(&mut buffer).map_err(|_| "MEDIA_PARTIAL_BODY")?;
      if length == 0 { break; }
      output.write_all(&buffer[..length]).map_err(|_| "MEDIA_DISK_FULL")?;
      copied += length as u64;
    }
    if copied != result.metadata.size { return Err("MEDIA_PARTIAL_BODY"); }
    output.sync_all().map_err(|_| "MEDIA_DISK_FULL")?;
    if cancel.load(Ordering::Acquire) { return Err("MEDIA_CANCELLED"); }
    Ok(())
  })();
  drop(output);
  if let Err(error) = copy_result {
    let _ = fs::remove_file(&destination);
    return Err(error.into());
  }
  Ok(SavedMedia { path: destination, file_name: name, mime_type: result.metadata.mime_type, size: result.metadata.size })
}

fn resolve_media_operation(
  app: &AppHandle,
  request_id: &str,
  value: &str,
  index: usize,
  maximum: usize,
  timeout: Duration,
  cancel: Arc<AtomicBool>,
  is_file_output: bool,
) -> Result<(OwnedDirectory, Vec<u8>, ActiveGuard), String> {
  validate_request_id(request_id)?;
  let url = canonicalize_media_url(value)?;
  if index >= 10 || !is_file_output && (maximum == 0 || maximum > MAX_BYTES) || STOPPING.load(Ordering::Acquire) {
    return Err("MEDIA_INPUT_DENIED".into());
  }
  let active = acquire_job(request_id, cancel.clone())?;
  if cancel.load(Ordering::Acquire) || was_cancelled(request_id)? {
    return Err("MEDIA_CANCELLED".into());
  }
  let directory = OwnedDirectory::create(app)?;
  let started = Instant::now();
  let timeout = timeout.min(if is_file_output { FILE_TIMEOUT } else { TIMEOUT });
  let result = run_media_worker(
    app, &directory, &url, index, maximum, timeout, &cancel, None, is_file_output,
  );
  let output = if matches!(&result, Err(code) if code == "MEDIA_AUTH_REQUIRED") {
    if cancel.load(Ordering::Acquire) {
      return Err("MEDIA_CANCELLED".into());
    }
    let cookie_timeout = timeout.saturating_sub(started.elapsed());
    if cookie_timeout.is_zero() {
      return Err("MEDIA_TIMEOUT".into());
    }
    let cookies = borrow_service_cookies(app, &url, &cancel, cookie_timeout)?;
    let remaining = timeout.saturating_sub(started.elapsed());
    if remaining.is_zero() {
      return Err("MEDIA_TIMEOUT".into());
    }
    run_media_worker(
      app,
      &directory,
      &url,
      index,
      maximum,
      remaining,
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
  timeout: Duration,
) -> Result<Vec<serde_json::Value>, String> {
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
    Instant::now() + timeout.min(Duration::from_secs(5)),
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
  timeout: Duration,
  cancel: &Arc<AtomicBool>,
  cookies: Option<Vec<serde_json::Value>>,
  is_file_output: bool,
) -> Result<Vec<u8>, String> {
  let deadline = Instant::now() + timeout.min(if is_file_output { FILE_TIMEOUT } else { TIMEOUT });
  if cancel.load(Ordering::Acquire) || STOPPING.load(Ordering::Acquire) {
    return Err("MEDIA_CANCELLED".into());
  }
  let node = crate::runtime::find_node_binary(app).map_err(|_| "MEDIA_RUNTIME_UNAVAILABLE")?;
  let engine = find_resource(app, "yt-dlp.exe").ok_or("MEDIA_RUNTIME_UNAVAILABLE")?;
  let ffmpeg = find_resource(app, "media/ffmpeg.exe").ok_or("MEDIA_RUNTIME_UNAVAILABLE")?;
  find_resource(app, "media/ffprobe.exe").ok_or("MEDIA_RUNTIME_UNAVAILABLE")?;
  let proxy = crate::system_proxy::proxy_for_url(url)
    .map_err(|_| "MEDIA_PROXY_FAILED")?;
  if cancel.load(Ordering::Acquire) || STOPPING.load(Ordering::Acquire) {
    return Err("MEDIA_CANCELLED".into());
  }
  let timeout = deadline.saturating_duration_since(Instant::now());
  if timeout.is_zero() {
    return Err("MEDIA_TIMEOUT".into());
  }
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
  let started = Instant::now();
  let timeout = timeout.min(if is_file_output { FILE_TIMEOUT } else { TIMEOUT });
  let status = loop {
    if cancel.load(Ordering::Acquire)
      || started.elapsed() > timeout
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
  if started.elapsed() > timeout {
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

fn canonicalize_media_url(value: &str) -> Result<String, String> {
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
}
