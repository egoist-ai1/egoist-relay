use std::collections::HashMap;
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
const SAVE_TIMEOUT: Duration = Duration::from_secs(900);
const DETACHED_TTL: Duration = Duration::from_secs(4 * 60 * 60);
const MAX_DETACHED: usize = 9;

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
  save_started: Option<Instant>,
  sizes: [usize; MAX_MEDIA],
  cancel: Arc<AtomicBool>,
  is_fetching: bool,
}

impl PendingShare {
  fn begin_media_batch(&mut self, index: usize) -> Result<(), String> {
    if self.cancel.load(Ordering::Acquire) {
      return Err("MEDIA_CANCELLED".into());
    }
    if index == 0 && self.batch_started.is_none() {
      self.batch_started = Some(Instant::now());
    }
    Ok(())
  }
}

static PENDING: LazyLock<Mutex<Option<PendingShare>>> = LazyLock::new(|| Mutex::new(None));
static DETACHED: LazyLock<Mutex<HashMap<String, PendingShare>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
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
    save_started: None,
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
    return crate::multi_app::set_social_overlay(&app_handle, false);
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
pub fn multi_social_detach(
  webview: Webview,
  app_handle: AppHandle,
  request_id: String,
  operation_id: String,
) -> Result<(), String> {
  require_main(&webview)?;
  let mut pending = PENDING.lock().map_err(|_| "SHARE_UNAVAILABLE")?;
  let capture = pending.as_ref().filter(|capture| capture.request.request_id == request_id).ok_or("SHARE_EXPIRED")?;
  crate::media_operations::bind_social_capture(&app_handle, &operation_id, &capture.request.service, &capture.request.url)?;
  let mut detached = DETACHED.lock().map_err(|_| "SHARE_UNAVAILABLE")?;
  let mut closed = LAST_CLOSED.lock().map_err(|_| "SHARE_UNAVAILABLE")?;
  detach_share(&mut pending, &mut detached, &request_id, &operation_id)?;
  *closed = Some(request_id);
  Ok(())
}

fn detach_share(
  pending: &mut Option<PendingShare>,
  detached: &mut HashMap<String, PendingShare>,
  request_id: &str,
  operation_id: &str,
) -> Result<(), String> {
  if operation_id.len() != 36 || uuid::Uuid::parse_str(operation_id).is_err() {
    return Err("SHARE_INPUT_DENIED".into());
  }
  let capture = pending.as_ref().filter(|capture| capture.request.request_id == request_id).ok_or("SHARE_EXPIRED")?;
  if capture.created_at.elapsed() >= SHARE_TTL { return Err("SHARE_EXPIRED".into()); }
  if capture.cancel.load(Ordering::Acquire) { return Err("MEDIA_CANCELLED".into()); }
  if capture.is_fetching { return Err("MEDIA_BUSY".into()); }
  expire_detached(detached);
  if detached.contains_key(operation_id) { return Err("SHARE_INPUT_DENIED".into()); }
  if detached.len() >= MAX_DETACHED { return Err("SHARE_QUEUE_FULL".into()); }
  let mut capture = pending.take().ok_or("SHARE_EXPIRED")?;
  capture.request.request_id = operation_id.to_string();
  capture.created_at = Instant::now();
  detached.insert(operation_id.to_string(), capture);
  Ok(())
}

fn expire_detached(detached: &mut HashMap<String, PendingShare>) {
  detached.retain(|_, capture| {
    if capture.created_at.elapsed() < DETACHED_TTL || capture.is_fetching { return true; }
    capture.cancel.store(true, Ordering::Release);
    false
  });
}

#[tauri::command]
pub fn multi_social_restore(
  webview: Webview,
  app_handle: AppHandle,
  operation_id: String,
) -> Result<ShareRequest, String> {
  require_main(&webview)?;
  let (service, url, item_count) = crate::media_operations::restore_social_source(&app_handle, &operation_id)?;
  let request = build_restored_share(&operation_id, &service, &url, item_count)?;
  let mut detached = DETACHED.lock().map_err(|_| "SHARE_UNAVAILABLE")?;
  expire_detached(&mut detached);
  if let Some(existing) = detached.get(&operation_id) {
    if existing.is_fetching { return Err("MEDIA_BUSY".into()); }
    existing.cancel.store(true, Ordering::Release);
  } else if detached.len() >= MAX_DETACHED {
    return Err("SHARE_QUEUE_FULL".into());
  }
  detached.insert(operation_id, PendingShare {
    request: request.clone(),
    created_at: Instant::now(),
    batch_started: None,
    save_started: None,
    sizes: [0; MAX_MEDIA],
    cancel: Arc::new(AtomicBool::new(false)),
    is_fetching: false,
  });
  Ok(request)
}

fn build_restored_share(
  operation_id: &str,
  service: &str,
  url: &str,
  item_count: Option<usize>,
) -> Result<ShareRequest, String> {
  // The existing public resolver returns one item; albums require a fresh capture
  if item_count.is_some_and(|count| count != 1) { return Err("MEDIA_RECAPTURE_REQUIRED".into()); }
  validate_request(ShareRequest {
    request_id: operation_id.to_string(),
    service: service.to_string(),
    url: url.to_string(),
    text: None,
    media: Vec::new(),
    unavailable_media: true,
  }, service)
}

fn with_share_mut<T>(
  request_id: &str,
  check_expiry: bool,
  update: impl FnOnce(&mut PendingShare) -> Result<T, String>,
) -> Result<T, String> {
  let mut pending = PENDING.lock().map_err(|_| "SHARE_UNAVAILABLE")?;
  if let Some(capture) = pending.as_mut().filter(|capture| capture.request.request_id == request_id) {
    if check_expiry && capture.created_at.elapsed() >= SHARE_TTL { return Err("SHARE_EXPIRED".into()); }
    return update(capture);
  }
  drop(pending);
  let mut detached = DETACHED.lock().map_err(|_| "SHARE_UNAVAILABLE")?;
  let capture = detached.get_mut(request_id).ok_or("SHARE_EXPIRED")?;
  if check_expiry && capture.created_at.elapsed() >= DETACHED_TTL {
    capture.cancel.store(true, Ordering::Release);
    return Err("SHARE_EXPIRED".into());
  }
  update(capture)
}

#[tauri::command]
pub fn multi_social_release(webview: Webview, request_id: String) -> Result<(), String> {
  require_main(&webview)?;
  if request_id.len() != 36 || uuid::Uuid::parse_str(&request_id).is_err() {
    return Err("SHARE_INPUT_DENIED".into());
  }
  let mut detached = DETACHED.lock().map_err(|_| "SHARE_UNAVAILABLE")?;
  if let Some(capture) = detached.get(&request_id) {
    if capture.is_fetching { return Err("MEDIA_BUSY".into()); }
    capture.cancel.store(true, Ordering::Release);
  }
  detached.remove(&request_id);
  Ok(())
}

#[tauri::command]
pub fn multi_social_cancel_media(webview: Webview, request_id: String) -> Result<(), String> {
  require_main(&webview)?;
  with_share_mut(&request_id, false, |capture| {
    capture.cancel.store(true, Ordering::Release);
    Ok(())
  })
}

#[tauri::command]
pub async fn multi_social_read_media(
  webview: Webview,
  app_handle: AppHandle,
  request_id: String,
  index: usize,
) -> Result<tauri::ipc::Response, String> {
  require_main(&webview)?;
  let (request, media, cancel, maximum, deadline) = with_share_mut(&request_id, true, |pending| {
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
    Ok((
      pending.request.clone(),
      media,
      pending.cancel.clone(),
      maximum,
      Instant::now() + timeout,
    ))
  })?;
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
        deadline,
        cancel,
      )
    }
  })
  .await
  .map_err(|_| "MEDIA_FETCH_FAILED".to_string())
  .and_then(|result| result);
  let _ = with_share_mut(&request_id, false, |pending| {
    pending.is_fetching = false;
    if let Ok(bytes) = &result {
      pending.sizes[index] = bytes.len().saturating_sub(8 + u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize);
    }
    Ok(())
  });
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
  let (request, media, cancel, maximum, deadline) = with_share_mut(&request_id, true, |pending| {
    if pending.is_fetching { return Err("MEDIA_BUSY".into()); }
    if pending.cancel.load(Ordering::Acquire) { return Err("MEDIA_CANCELLED".into()); }
    let media = if pending.request.unavailable_media {
      if index != 0 { return Err("MEDIA_INPUT_DENIED".into()); }
      None
    } else { Some(pending.request.media.get(index).ok_or("MEDIA_INPUT_DENIED")?.clone()) };
    let started = *pending.save_started.get_or_insert_with(Instant::now);
    let deadline = started + SAVE_TIMEOUT;
    check_media_deadline(&pending.cancel, deadline)?;
    let used: usize = pending.sizes.iter().enumerate().filter(|(item, _)| *item != index).map(|(_, size)| size).sum();
    let maximum = MAX_FILE_BYTES.min(MAX_TOTAL_BYTES.saturating_sub(used));
    if maximum == 0 { return Err("MEDIA_TOO_LARGE".into()); }
    pending.is_fetching = true;
    Ok((pending.request.clone(), media, pending.cancel.clone(), maximum, deadline))
  })?;
  let fetching_app = app_handle.clone();
  let result = tauri::async_runtime::spawn_blocking(move || {
    if let Some(media) = media {
      let output = read_media(&fetching_app, &request, &media, index, maximum, deadline, &cancel, true)?;
      serde_json::from_slice(&output).map_err(|_| "MEDIA_PARTIAL_BODY".into())
    } else {
      crate::inline_media::save_public_media(&fetching_app, &request.request_id, &request.url, index, maximum, deadline, cancel)
    }
  }).await.map_err(|_| "MEDIA_FETCH_FAILED".to_string()).and_then(|result| result);
  let _ = with_share_mut(&request_id, false, |pending| {
    pending.is_fetching = false;
    if let Ok(saved) = &result { pending.sizes[index] = saved.size as usize; }
    Ok(())
  });
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
  let proxy = crate::system_proxy::proxy_for_url_cancellable(&media.url, cancel, deadline)
    .map_err(|_| check_media_deadline(cancel, deadline).err().unwrap_or_else(|| "MEDIA_PROXY_FAILED".into()))?;
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
    let saved = crate::inline_media::publish_saved_media(app, &request.request_id, &directory, &output, index, maximum, cancel, deadline)?;
    if directory.cleanup().is_err() { log::warn!("[MediaStorage] Owned worker cleanup is incomplete"); }
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
    save_started: None,
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

  fn create_capture() -> PendingShare {
    PendingShare {
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
      save_started: None,
      sizes: [0; MAX_MEDIA],
      cancel: Arc::new(AtomicBool::new(false)),
      is_fetching: false,
    }
  }

  #[test]
  fn accepted_capture_survives_modal_close_and_service_capture_replacement() {
    let capture = create_capture();
    let original_id = capture.request.request_id.clone();
    let original_cancel = capture.cancel.clone();
    let operation_id = uuid::Uuid::new_v4().to_string();
    let mut pending = Some(capture);
    let mut detached = HashMap::new();
    detach_share(&mut pending, &mut detached, &original_id, &operation_id).unwrap();
    assert!(pending.is_none());
    assert!(!original_cancel.load(Ordering::Acquire));
    let next_capture = create_capture();
    next_capture.cancel.store(true, Ordering::Release);
    pending = Some(next_capture);
    pending.take();
    let accepted = detached.get(&operation_id).unwrap();
    assert_eq!(accepted.request.request_id, operation_id);
    assert_eq!(accepted.request.url, "https://x.com/i/status/1234567890123456789");
    assert!(!accepted.cancel.load(Ordering::Acquire));
  }

  #[test]
  fn detached_queue_bounds_and_expired_captures_do_not_replace_owned_contexts() {
    let mut detached = HashMap::new();
    for _ in 0..MAX_DETACHED {
      let capture = create_capture();
      let request_id = capture.request.request_id.clone();
      detach_share(&mut Some(capture), &mut detached, &request_id, &uuid::Uuid::new_v4().to_string()).unwrap();
    }
    let capture = create_capture();
    let request_id = capture.request.request_id.clone();
    let mut pending = Some(capture);
    assert_eq!(detach_share(&mut pending, &mut detached, &request_id, &uuid::Uuid::new_v4().to_string()), Err("SHARE_QUEUE_FULL".into()));
    assert_eq!(pending.as_ref().unwrap().request.request_id, request_id);
    let first_id = detached.keys().next().unwrap().clone();
    assert_eq!(detach_share(&mut pending, &mut detached, &request_id, &first_id), Err("SHARE_INPUT_DENIED".into()));
    detached.get_mut(&first_id).unwrap().created_at = Instant::now() - DETACHED_TTL;
    detach_share(&mut pending, &mut detached, &request_id, &uuid::Uuid::new_v4().to_string()).unwrap();
    assert_eq!(detached.len(), MAX_DETACHED);
    assert!(!detached.contains_key(&first_id));
  }

  #[test]
  fn detach_preserves_pending_capture_when_guard_checks_fail() {
    let mut capture = create_capture();
    let request_id = capture.request.request_id.clone();
    capture.created_at = Instant::now() - SHARE_TTL;
    let mut pending = Some(capture);
    let mut detached = HashMap::new();
    assert_eq!(detach_share(&mut pending, &mut detached, &request_id, &uuid::Uuid::new_v4().to_string()), Err("SHARE_EXPIRED".into()));
    pending.as_mut().unwrap().created_at = Instant::now();
    pending.as_mut().unwrap().is_fetching = true;
    assert_eq!(detach_share(&mut pending, &mut detached, &request_id, &uuid::Uuid::new_v4().to_string()), Err("MEDIA_BUSY".into()));
    pending.as_mut().unwrap().is_fetching = false;
    pending.as_ref().unwrap().cancel.store(true, Ordering::Release);
    assert_eq!(detach_share(&mut pending, &mut detached, &request_id, &uuid::Uuid::new_v4().to_string()), Err("MEDIA_CANCELLED".into()));
    assert!(pending.is_some());
    assert!(detached.is_empty());
  }

  #[test]
  fn beginning_another_read_does_not_extend_the_existing_batch_budget() {
    let mut capture = create_capture();
    let started = Instant::now() - Duration::from_secs(30);
    capture.batch_started = Some(started);
    capture.begin_media_batch(0).unwrap();
    assert_eq!(capture.batch_started, Some(started));
    assert_eq!(check_media_deadline(&capture.cancel, Instant::now() - Duration::from_millis(1)), Err("MEDIA_TIMEOUT".into()));
  }


  #[test]
  fn restoration_uses_only_a_canonical_registered_single_item_source() {
    let operation_id = uuid::Uuid::new_v4().to_string();
    let restored = build_restored_share(&operation_id, "x", "https://x.com/name/status/1234567890123456789?tracking=secret", Some(1)).unwrap();
    assert_eq!(restored.request_id, operation_id);
    assert_eq!(restored.url, "https://x.com/name/status/1234567890123456789");
    assert!(restored.media.is_empty());
    assert!(restored.text.is_none());
    assert!(restored.unavailable_media);
    assert!(matches!(build_restored_share(&operation_id, "instagram", "https://www.instagram.com/reel/AbCdE12345/", Some(2)), Err(error) if error == "MEDIA_RECAPTURE_REQUIRED"));
    assert!(build_restored_share(&operation_id, "x", "https://evil.test/video", None).is_err());
    assert!(build_restored_share(&operation_id, "youtube", "https://www.youtube.com/watch?v=abcdefghijk", None).is_err());
  }




}
