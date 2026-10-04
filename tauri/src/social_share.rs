use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::sync::{
  Arc, LazyLock, Mutex,
  atomic::{AtomicBool, Ordering},
};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager, Webview};
use url::Url;

const FETCH_SCRIPT: &str = include_str!("../../scripts/social-media-fetch.mjs");
const SHARE_SCRIPT: &str = include_str!("../../scripts/social-share-enhancer.js");
const MAX_FILE_BYTES: usize = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES: usize = 128 * 1024 * 1024;
const MAX_MEDIA: usize = 10;
const SHARE_TTL: Duration = Duration::from_secs(600);
const FILE_TIMEOUT: Duration = Duration::from_secs(64);
const BATCH_TIMEOUT: Duration = Duration::from_secs(180);

#[derive(serde::Deserialize, serde::Serialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShareMedia {
  url: String,
  #[serde(rename = "type")]
  media_type: String,
}

#[derive(serde::Deserialize, serde::Serialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShareRequest {
  request_id: String,
  service: String,
  url: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  text: Option<String>,
  #[serde(default)]
  media: Vec<ShareMedia>,
  #[serde(default)]
  unavailable_media: bool,
}

struct PendingShare {
  request: ShareRequest,
  created_at: Instant,
  batch_started: Option<Instant>,
  sizes: [usize; MAX_MEDIA],
  cancel: Arc<AtomicBool>,
  is_fetching: bool,
}

impl PendingShare {
  fn begin_media_batch(&mut self, index: usize) -> Result<(), String> {
    if self.cancel.load(Ordering::Acquire) {
      return Err("MEDIA_CANCELLED".into());
    }
    if index == 0 {
      self.batch_started = Some(Instant::now());
    }
    Ok(())
  }
}

static PENDING: LazyLock<Mutex<Option<PendingShare>>> = LazyLock::new(|| Mutex::new(None));
static LAST_CLOSED: LazyLock<Mutex<Option<String>>> = LazyLock::new(|| Mutex::new(None));
static SHARE_LABEL: LazyLock<Mutex<String>> = LazyLock::new(|| Mutex::new("Telegram".to_string()));

pub(crate) fn sanitize_media_worker_environment(command: &mut Command) {
  for (name, _) in std::env::vars_os() {
    let key = name.to_string_lossy().to_ascii_lowercase();
    if key.contains("proxy")
      || matches!(key.as_str(), "node_options" | "node_extra_ca_certs" | "node_tls_reject_unauthorized" | "sslkeylogfile")
    {
      command.env_remove(name);
    }
  }
}

pub(crate) fn create_enhancer_script(script: &str, token: &str, service: &str) -> String {
  let label = SHARE_LABEL
    .lock()
    .unwrap_or_else(|poisoned| poisoned.into_inner());
  let label = serde_json::to_string(label.as_str()).unwrap();
  format!(
    "{script}\n{}",
    SHARE_SCRIPT
      .replace("__EGOIST_RELAY_SHARE_TOKEN__", token)
      .replace("__EGOIST_RELAY_SHARE_SERVICE__", service)
      .replace("__EGOIST_RELAY_SHARE_LABEL__", &label)
  )
}

#[tauri::command]
pub fn multi_social_set_labels(
  webview: Webview,
  app_handle: AppHandle,
  share_label: String,
) -> Result<(), String> {
  require_main(&webview)?;
  if share_label.trim().is_empty()
    || share_label.chars().count() > 96
    || share_label.chars().any(|ch| ch.is_control())
  {
    return Err("SHARE_INPUT_DENIED".into());
  }
  *SHARE_LABEL.lock().map_err(|_| "SHARE_UNAVAILABLE")? = share_label.clone();
  let label = serde_json::to_string(&share_label).map_err(|_| "SHARE_INPUT_DENIED")?;
  for service in ["x", "instagram"] {
    if let Some(remote) = app_handle.get_webview(service_label(service)?) {
      remote.eval(format!("if(typeof window.__egoistRelayUpdateShareLabel==='function')window.__egoistRelayUpdateShareLabel({label});")).map_err(|_| "SHARE_UNAVAILABLE")?;
    }
  }
  Ok(())
}

pub(crate) fn intercept_navigation(app: &AppHandle, service: &str, token: &str, url: &Url) -> bool {
  if url.scheme() != "egoist-relay-share" {
    return false;
  }
  if let Err(error) = accept_share(app, service, token, url) {
    let _ = app.emit_to(
      "main",
      "multi-social-share-error",
      serde_json::json!({ "code": error }),
    );
  }
  true
}

fn accept_share(
  app: &AppHandle,
  service: &str,
  token: &str,
  navigation: &Url,
) -> Result<(), String> {
  if navigation.as_str().len() > 65536
    || navigation.host_str() != Some("request")
    || navigation.path() != ""
    || navigation.fragment().is_some()
    || !navigation.username().is_empty()
    || navigation.password().is_some()
    || navigation.port().is_some()
  {
    return Err("SHARE_SOURCE_DENIED".into());
  }
  let label = service_label(service)?;
  let webview = app.get_webview(label).ok_or("SHARE_SOURCE_DENIED")?;
  let current = webview.url().map_err(|_| "SHARE_SOURCE_DENIED")?;
  if !is_service_origin(&current, service) || crate::multi_app::get_active_app() != service {
    return Err("SHARE_SOURCE_DENIED".into());
  }
  let parameters: Vec<_> = navigation.query_pairs().collect();
  if parameters.len() != 2
    || !parameters
      .iter()
      .any(|(name, value)| name == "token" && value == token)
  {
    return Err("SHARE_TOKEN_DENIED".into());
  }
  let payload = parameters
    .iter()
    .find(|(name, _)| name == "payload")
    .ok_or("SHARE_INPUT_DENIED")?;
  let request: ShareRequest = serde_json::from_str(&payload.1).map_err(|_| "SHARE_INPUT_DENIED")?;
  let request = validate_request(request, service)?;
  let mut state = PENDING.lock().map_err(|_| "SHARE_UNAVAILABLE")?;
  if let Some(existing) = state.as_ref() {
    if existing.created_at.elapsed() < SHARE_TTL
      && existing.request.request_id == request.request_id
    {
      return Ok(());
    }
    if crate::multi_app::has_social_overlay() {
      return Err("SHARE_BUSY".into());
    }
    existing.cancel.store(true, Ordering::Release);
  }
  *state = Some(PendingShare {
    request: request.clone(),
    created_at: Instant::now(),
    batch_started: None,
    sizes: [0; MAX_MEDIA],
    cancel: Arc::new(AtomicBool::new(false)),
    is_fetching: false,
  });
  app
    .emit_to("main", "multi-social-share", request)
    .map_err(|_| "SHARE_UNAVAILABLE".into())
}

fn validate_request(mut request: ShareRequest, service: &str) -> Result<ShareRequest, String> {
  if request.service != service
    || uuid::Uuid::parse_str(&request.request_id).is_err()
    || request.request_id.len() != 36
    || request.media.len() > MAX_MEDIA
    || request
      .text
      .as_ref()
      .is_some_and(|text| text.chars().count() > 4096 || text.chars().any(|ch| ch == '\0'))
  {
    return Err("SHARE_INPUT_DENIED".into());
  }
  let mut url = Url::parse(&request.url).map_err(|_| "SHARE_URL_DENIED")?;
  if request.url.len() > 4096 || !is_service_origin(&url, service) {
    return Err("SHARE_URL_DENIED".into());
  }
  let segments: Vec<_> = url
    .path_segments()
    .ok_or("SHARE_URL_DENIED")?
    .filter(|segment| !segment.is_empty())
    .collect();
  let valid = if service == "x" {
    segments.len() == 3
      && segments[1] == "status"
      && !segments[0].is_empty()
      && segments[0].len() <= 30
      && segments[0]
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
      && (5..=24).contains(&segments[2].len())
      && segments[2].chars().all(|ch| ch.is_ascii_digit())
  } else {
    segments.len() == 2
      && matches!(segments[0], "p" | "reel" | "reels")
      && (5..=80).contains(&segments[1].len())
      && segments[1]
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
  };
  if !valid {
    return Err("SHARE_URL_DENIED".into());
  }
  url.set_query(None);
  url.set_fragment(None);
  request.url = url.to_string();
  for media in &request.media {
    if !matches!(media.media_type.as_str(), "photo" | "video") || !is_media_url(&media.url, service)
    {
      return Err("SHARE_MEDIA_DENIED".into());
    }
  }
  Ok(request)
}

fn is_service_origin(url: &Url, service: &str) -> bool {
  let allowed = match service {
    "x" => ["x.com", "www.x.com", "twitter.com", "www.twitter.com"].as_slice(),
    "instagram" => ["instagram.com", "www.instagram.com"].as_slice(),
    _ => return false,
  };
  url.scheme() == "https"
    && url.username().is_empty()
    && url.password().is_none()
    && url.port_or_known_default() == Some(443)
    && url.host_str().is_some_and(|host| allowed.contains(&host))
}

fn is_media_url(value: &str, service: &str) -> bool {
  if value.len() > 4096 || value.chars().any(|ch| ch.is_whitespace() || ch.is_control() || ch == '\\') {
    return false;
  }
  let Ok(url) = Url::parse(value) else {
    return false;
  };
  if url.scheme() != "https"
    || !url.username().is_empty()
    || url.password().is_some()
    || url.fragment().is_some()
    || url.port_or_known_default() != Some(443)
  {
    return false;
  }
  let Some(host) = url.host_str() else {
    return false;
  };
  let lower_path = url.path().to_ascii_lowercase();
  if lower_path.ends_with(".m3u8") || lower_path.ends_with(".mpd") {
    return false;
  }
  match service {
    "x" => matches!(host, "pbs.twimg.com" | "video.twimg.com"),
    "instagram" => {
      host == "cdninstagram.com"
        || host.ends_with(".cdninstagram.com")
        || host == "fbcdn.net"
        || host.ends_with(".fbcdn.net")
    }
    _ => false,
  }
}

fn service_label(service: &str) -> Result<&'static str, String> {
  match service {
    "x" => Ok("x_webview"),
    "instagram" => Ok("instagram_webview"),
    _ => Err("SHARE_SOURCE_DENIED".into()),
  }
}

pub(crate) fn require_main(webview: &Webview) -> Result<(), String> {
  let url = webview.url().map_err(|_| "SHARE_SOURCE_DENIED")?;
  let local = (matches!(url.scheme(), "http" | "https")
    && matches!(
      url.host_str(),
      Some("tauri.localhost" | "localhost" | "127.0.0.1")
    ))
    || (url.scheme() == "tauri" && url.host_str() == Some("localhost"));
  if webview.label() != "main" || !local {
    return Err("SHARE_SOURCE_DENIED".into());
  }
  Ok(())
}

#[tauri::command]
pub fn multi_social_overlay(
  webview: Webview,
  app_handle: AppHandle,
  request_id: String,
  visible: bool,
) -> Result<(), String> {
  require_main(&webview)?;
  let mut state = PENDING.lock().map_err(|_| "SHARE_UNAVAILABLE")?;
  if !visible
    && state.is_none()
    && LAST_CLOSED
      .lock()
      .map_err(|_| "SHARE_UNAVAILABLE")?
      .as_ref()
      == Some(&request_id)
  {
    return Ok(());
  }
  let pending = state.as_mut().ok_or("SHARE_EXPIRED")?;
  if pending.request.request_id != request_id {
    return Err("SHARE_EXPIRED".into());
  }
  if visible && pending.created_at.elapsed() >= SHARE_TTL {
    return Err("SHARE_EXPIRED".into());
  }
  crate::multi_app::set_social_overlay(&app_handle, visible)?;
  if !visible {
    pending.cancel.store(true, Ordering::Release);
    *LAST_CLOSED.lock().map_err(|_| "SHARE_UNAVAILABLE")? = Some(request_id);
    *state = None;
  }
  Ok(())
}

#[tauri::command]
pub fn multi_social_cancel_media(webview: Webview, request_id: String) -> Result<(), String> {
  require_main(&webview)?;
  let state = PENDING.lock().map_err(|_| "SHARE_UNAVAILABLE")?;
  if let Some(pending) = state.as_ref() {
    if pending.request.request_id != request_id {
      return Err("SHARE_EXPIRED".into());
    }
    pending.cancel.store(true, Ordering::Release);
  }
  Ok(())
}

#[tauri::command]
pub async fn multi_social_read_media(
  webview: Webview,
  app_handle: AppHandle,
  request_id: String,
  index: usize,
) -> Result<tauri::ipc::Response, String> {
  require_main(&webview)?;
  let (request, media, cancel, maximum, deadline) = {
    let mut state = PENDING.lock().map_err(|_| "SHARE_UNAVAILABLE")?;
    let pending = state.as_mut().ok_or("SHARE_EXPIRED")?;
    if pending.request.request_id != request_id || pending.created_at.elapsed() >= SHARE_TTL {
      return Err("SHARE_EXPIRED".into());
    }
    if pending.is_fetching {
      return Err("MEDIA_BUSY".into());
    }
    let media = if pending.request.unavailable_media {
      if index != 0 {
        return Err("MEDIA_INPUT_DENIED".into());
      }
      None
    } else {
      Some(
        pending
          .request
          .media
          .get(index)
          .ok_or("MEDIA_INPUT_DENIED")?
          .clone(),
      )
    };
    pending.begin_media_batch(index)?;
    if pending
      .batch_started
      .is_none_or(|started| started.elapsed() >= BATCH_TIMEOUT)
    {
      return Err("MEDIA_TIMEOUT".into());
    }
    let file_timeout = if media.is_none() {
      Duration::from_secs(125)
    } else {
      FILE_TIMEOUT
    };
    let timeout =
      file_timeout.min(BATCH_TIMEOUT.saturating_sub(pending.batch_started.unwrap().elapsed()));
    let used: usize = pending
      .sizes
      .iter()
      .enumerate()
      .filter(|(item, _)| *item != index)
      .map(|(_, size)| size)
      .sum();
    let maximum = MAX_FILE_BYTES.min(MAX_TOTAL_BYTES.saturating_sub(used));
    if maximum == 0 {
      return Err("MEDIA_TOO_LARGE".into());
    }
    pending.is_fetching = true;
    (
      pending.request.clone(),
      media,
      pending.cancel.clone(),
      maximum,
      Instant::now() + timeout,
    )
  };
  let fetching_app = app_handle.clone();
  let result = tauri::async_runtime::spawn_blocking(move || {
    if let Some(media) = media {
      read_media(
        &fetching_app,
        &request,
        &media,
        index,
        maximum,
        deadline,
        &cancel,
        false,
      )
    } else {
      crate::inline_media::resolve_public_media(
        &fetching_app,
        &request.request_id,
        &request.url,
        index,
        maximum,
        deadline.saturating_duration_since(Instant::now()),
        cancel,
      )
    }
  })
  .await
  .map_err(|_| "MEDIA_FETCH_FAILED".to_string())
  .and_then(|result| result);
  if let Ok(mut state) = PENDING.lock() {
    if let Some(pending) = state
      .as_mut()
      .filter(|pending| pending.request.request_id == request_id)
    {
      pending.is_fetching = false;
      if let Ok(bytes) = &result {
        pending.sizes[index] = bytes
          .len()
          .saturating_sub(8 + u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize);
      }
    }
  }
  let _ = app_handle.emit_to("main", "multi-social-media-progress", serde_json::json!({ "requestId": request_id, "index": index, "state": if result.is_ok() { "ready" } else { "error" }, "loaded": result.as_ref().map_or(0, |bytes| bytes.len()) }));
  result.map(tauri::ipc::Response::new)
}

#[tauri::command]
pub async fn multi_social_save_media(
  webview: Webview,
  app_handle: AppHandle,
  request_id: String,
  index: usize,
) -> Result<crate::inline_media::SavedMedia, String> {
  require_main(&webview)?;
  let (request, media, cancel) = {
    let mut state = PENDING.lock().map_err(|_| "SHARE_UNAVAILABLE")?;
    let pending = state.as_mut().ok_or("SHARE_EXPIRED")?;
    if pending.request.request_id != request_id || pending.created_at.elapsed() >= SHARE_TTL { return Err("SHARE_EXPIRED".into()); }
    if pending.is_fetching { return Err("MEDIA_BUSY".into()); }
    if pending.cancel.load(Ordering::Acquire) { return Err("MEDIA_CANCELLED".into()); }
    let media = if pending.request.unavailable_media {
      if index != 0 { return Err("MEDIA_INPUT_DENIED".into()); }
      None
    } else { Some(pending.request.media.get(index).ok_or("MEDIA_INPUT_DENIED")?.clone()) };
    pending.is_fetching = true;
    (pending.request.clone(), media, pending.cancel.clone())
  };
  let deadline = Instant::now() + Duration::from_secs(900);
  let fetching_app = app_handle.clone();
  let result = tauri::async_runtime::spawn_blocking(move || {
    if let Some(media) = media {
      let output = read_media(&fetching_app, &request, &media, index, MAX_FILE_BYTES, deadline, &cancel, true)?;
      serde_json::from_slice(&output).map_err(|_| "MEDIA_PARTIAL_BODY".into())
    } else {
      crate::inline_media::save_public_media(&fetching_app, &request.request_id, &request.url, index, cancel)
    }
  }).await.map_err(|_| "MEDIA_FETCH_FAILED".to_string()).and_then(|result| result);
  if let Ok(mut state) = PENDING.lock() {
    if let Some(pending) = state.as_mut().filter(|pending| pending.request.request_id == request_id) { pending.is_fetching = false; }
  }
  let _ = app_handle.emit_to("main", "multi-social-media-progress", serde_json::json!({ "requestId": request_id, "index": index, "state": if result.is_ok() { "ready" } else { "error" }, "loaded": result.as_ref().map_or(0, |saved| saved.size) }));
  result
}

fn read_media(
  app: &AppHandle,
  request: &ShareRequest,
  media: &ShareMedia,
  index: usize,
  maximum: usize,
  deadline: Instant,
  cancel: &AtomicBool,
  is_file_output: bool,
) -> Result<Vec<u8>, String> {
  check_media_deadline(cancel, deadline)?;
  let node = crate::runtime::find_node_binary(app)?;
  check_media_deadline(cancel, deadline)?;
  let proxy = crate::system_proxy::proxy_for_url(&media.url)
    .map_err(|_| "MEDIA_PROXY_FAILED")?;
  check_media_deadline(cancel, deadline)?;
  let _ = app.emit_to("main", "multi-social-media-progress", serde_json::json!({ "requestId": request.request_id, "index": index, "state": "fetching", "loaded": 0 }));
  let mut command = Command::new(node);
  sanitize_media_worker_environment(&mut command);
  let directory = crate::inline_media::OwnedDirectory::create(app)?;
  let script = directory.prepare_worker("social-media-fetch.mjs", FETCH_SCRIPT)?;
  command
    .arg(script)
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .env("EGOIST_RELAY_MEDIA_PROXY", proxy.as_ref().map_or("direct", Url::as_str));
  crate::runtime::hide_command_window(&mut command);
  check_media_deadline(cancel, deadline)?;
  let mut child = command.spawn().map_err(|_| "MEDIA_RUNTIME_UNAVAILABLE")?;
  let job = match crate::worker_job::WorkerJob::attach(&child) {
    Ok(job) => job,
    Err(error) => {
      let _ = child.kill();
      let _ = child.wait();
      return Err(error);
    }
  };
  let mut input = serde_json::json!({ "url": media.url, "service": request.service, "type": media.media_type, "index": index, "maxBytes": maximum });
  if is_file_output { input["outputMode"] = serde_json::json!("file"); input["tempDir"] = serde_json::json!(directory.worker_directory()); }
  let write_result = child
    .stdin
    .take()
    .ok_or_else(|| "MEDIA_FETCH_FAILED".to_string())
    .and_then(|mut stdin| {
      check_media_deadline(cancel, deadline)?;
      stdin
        .write_all(input.to_string().as_bytes())
        .map_err(|_| "MEDIA_FETCH_FAILED".to_string())
    });
  if let Err(error) = write_result {
    job.terminate();
    let _ = child.kill();
    let _ = child.wait();
    return Err(error);
  }
  let stdout = child.stdout.take().ok_or("MEDIA_FETCH_FAILED")?;
  let stderr = child.stderr.take().ok_or("MEDIA_FETCH_FAILED")?;
  let output_limit = if is_file_output { 64 * 1024 } else { MAX_FILE_BYTES + 1033 };
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
    if cancel.load(Ordering::Acquire) || Instant::now() >= deadline {
      job.terminate();
      let _ = child.kill();
      break child.wait().map_err(|_| "MEDIA_FETCH_FAILED");
    }
    match child.try_wait() {
      Ok(Some(status)) => break Ok(status),
      Ok(None) => std::thread::sleep(Duration::from_millis(30)),
      Err(_) => {
        job.terminate();
        let _ = child.kill();
        let _ = child.wait();
        break Err("MEDIA_FETCH_FAILED");
      }
    }
  };
  job.terminate();
  let output = output_reader
    .join()
    .map_err(|_| "MEDIA_FETCH_FAILED")?
    .map_err(|_| "MEDIA_FETCH_FAILED")?;
  let error = error_reader
    .join()
    .map_err(|_| "MEDIA_FETCH_FAILED")?
    .map_err(|_| "MEDIA_FETCH_FAILED")?;
  check_media_deadline(cancel, deadline)?;
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
  if is_file_output {
    let saved = crate::inline_media::publish_saved_media(app, &directory, &output, index, cancel)?;
    directory.cleanup()?;
    return serde_json::to_vec(&saved).map_err(|_| "MEDIA_PARTIAL_BODY".into());
  }
  validate_media_packet(&output, index, maximum)?;
  directory.cleanup()?;
  Ok(output)
}

fn check_media_deadline(cancel: &AtomicBool, deadline: Instant) -> Result<(), String> {
  if cancel.load(Ordering::Acquire) {
    return Err("MEDIA_CANCELLED".into());
  }
  if Instant::now() >= deadline {
    return Err("MEDIA_TIMEOUT".into());
  }
  Ok(())
}

pub(crate) fn validate_media_packet(
  output: &[u8],
  index: usize,
  maximum: usize,
) -> Result<(), String> {
  if output.len() < 8 || &output[..4] != b"ERMS" {
    return Err("MEDIA_PARTIAL_BODY".into());
  }
  let header_length = u32::from_le_bytes(output[4..8].try_into().unwrap()) as usize;
  if header_length > 1024
    || output.len() <= 8 + header_length
    || output.len() > maximum + header_length + 8
  {
    return Err("MEDIA_TOO_LARGE".into());
  }
  let header: serde_json::Value =
    serde_json::from_slice(&output[8..8 + header_length]).map_err(|_| "MEDIA_PARTIAL_BODY")?;
  if header["index"].as_u64() != Some(index as u64)
    || header["size"].as_u64() != Some((output.len() - 8 - header_length) as u64)
  {
    return Err("MEDIA_PARTIAL_BODY".into());
  }
  let mime = header["mimeType"]
    .as_str()
    .ok_or("MEDIA_FORMAT_UNSUPPORTED")?;
  if !matches!(
    mime,
    "image/jpeg" | "image/png" | "image/gif" | "image/webp" | "video/mp4" | "video/webm"
  ) {
    return Err("MEDIA_FORMAT_UNSUPPORTED".into());
  }
  let name = header["name"].as_str().ok_or("MEDIA_FORMAT_UNSUPPORTED")?;
  if name.is_empty() || name.len() > 96
    || !name
      .chars()
      .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '.')
    || name.contains("..")
  {
    return Err("MEDIA_FORMAT_UNSUPPORTED".into());
  }
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn cancellation_remains_latched_before_the_first_media_read() {
    let mut pending = PendingShare {
      request: ShareRequest {
        request_id: uuid::Uuid::new_v4().to_string(),
        service: "x".into(),
        url: "https://x.com/i/status/1234567890123456789".into(),
        text: None,
        media: Vec::new(),
        unavailable_media: true,
      },
      created_at: Instant::now(),
      batch_started: None,
      sizes: [0; MAX_MEDIA],
      cancel: Arc::new(AtomicBool::new(true)),
      is_fetching: false,
    };
    assert_eq!(pending.begin_media_batch(0), Err("MEDIA_CANCELLED".into()));
    assert!(pending.batch_started.is_none());
    assert!(pending.cancel.load(Ordering::Acquire));
  }

  #[test]
  fn media_urls_reject_controls_and_unrelated_hosts() {
    assert!(is_media_url("https://pbs.twimg.com/media/test.jpg", "x"));
    assert!(!is_media_url("https://pbs.twimg.com/\nmedia/test.jpg", "x"));
    assert!(!is_media_url("https://pbs.twimg.com.evil.test/media/test.jpg", "x"));
    assert!(!is_media_url("https://video.twimg.com/media/test.m3u8", "x"));
  }
}
