use std::collections::{HashMap, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Condvar, LazyLock, Mutex, Once};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Listener, Manager, Webview};
use url::Url;

const PREPARE_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_PREPARED_DOWNLOADS: usize = 128;
const MAX_FILE_NAME_UTF16_UNITS: usize = 160;
const MAX_FILE_COLLISIONS: usize = 9999;
const MINI_APP_LABEL_PREFIX: &str = "mini-app-";
const MINI_APP_MAX_FILE_BYTES: u64 = 256 * 1024 * 1024;
const MINI_APP_MAX_ACTIVE: usize = 3;
const MINI_APP_MAX_STARTS: usize = 5;
const MINI_APP_START_WINDOW: Duration = Duration::from_secs(60);
const MINI_APP_MAX_SOURCES: usize = 64;
const MINI_APP_NOTICE_INTERVAL: Duration = Duration::from_secs(1);
// Executable, script and installer types that web content must not drop into the downloads folder.
const BLOCKED_EXTENSIONS: &[&str] = &[
  "exe", "msi", "msp", "mst", "bat", "cmd", "ps1", "ps1xml", "psc1", "psd1", "psm1", "js", "jse", "vbs", "vbe", "wsf", "wsh",
  "ws", "wsc", "sct", "lnk", "url", "scr", "hta", "jar", "jnlp", "dll", "reg", "cpl", "com", "pif", "inf", "scf", "msc",
  "application", "gadget", "appx", "msix", "appinstaller", "chm",
];
static CANCELLATION_LISTENER: Once = Once::new();
static EXPIRY_WORKER: Once = Once::new();
static EXPIRY_CHANGED: Condvar = Condvar::new();
static TRANSFERS: LazyLock<Mutex<TransferBook>> = LazyLock::new(|| Mutex::new(TransferBook::default()));

struct PreparedDownload {
  id: String,
  url: String,
  file_name: String,
  expires: Instant,
  cancelled: bool,
}

#[derive(Default)]
struct PreparedQueue(VecDeque<PreparedDownload>);

impl PreparedQueue {
  fn take(&mut self, url: &str, file_name: &str) -> Option<PreparedDownload> {
    let index = self.0.iter().position(|entry| entry.url == url && entry.file_name == file_name)?;
    self.0.remove(index)
  }

  fn expire(&mut self, now: Instant) -> Vec<PreparedDownload> {
    let mut expired = Vec::new();
    self.0.retain_mut(|entry| {
      if now < entry.expires { return true; }
      expired.push(PreparedDownload {
        id: std::mem::take(&mut entry.id), url: std::mem::take(&mut entry.url), file_name: std::mem::take(&mut entry.file_name),
        expires: entry.expires, cancelled: entry.cancelled,
      });
      false
    });
    expired
  }
}

struct Transfer {
  id: String,
  webview_label: String,
  service: String,
  url: String,
  file_name: String,
  final_path: PathBuf,
  partial: PathBuf,
  directory: crate::inline_media::OwnedDirectory,
  cancelled: bool,
  // Started by untrusted page content (a Mini App or its popup) instead of the main renderer.
  restricted: bool,
  blocked: Option<&'static str>,
}

#[derive(Default)]
struct TransferBook {
  prepared: PreparedQueue,
  active: HashMap<String, Transfer>,
  restricted_starts: HashMap<String, VecDeque<Instant>>,
  last_rejection_notice: Option<Instant>,
}

impl TransferBook {
  // Admits a download requested by untrusted page content: type denylist, queue size and request rate per source.
  fn admit_restricted(&mut self, source: &str, file_name: &str, now: Instant) -> Result<(), &'static str> {
    if is_blocked_file_name(file_name) { return Err("MEDIA_TYPE_BLOCKED"); }
    if self.active.values().filter(|entry| entry.restricted).count() >= MINI_APP_MAX_ACTIVE { return Err("MEDIA_QUEUE_FULL"); }
    self.restricted_starts.retain(|_, starts| {
      while starts.front().is_some_and(|started| now.saturating_duration_since(*started) >= MINI_APP_START_WINDOW) { starts.pop_front(); }
      !starts.is_empty()
    });
    if !self.restricted_starts.contains_key(source) && self.restricted_starts.len() >= MINI_APP_MAX_SOURCES { return Err("MEDIA_RATE_LIMITED"); }
    let starts = self.restricted_starts.entry(source.to_string()).or_default();
    if starts.len() >= MINI_APP_MAX_STARTS { return Err("MEDIA_RATE_LIMITED"); }
    starts.push_back(now);
    Ok(())
  }

  fn should_notify_rejection(&mut self, now: Instant) -> bool {
    if self.last_rejection_notice.is_some_and(|last| now.saturating_duration_since(last) < MINI_APP_NOTICE_INTERVAL) { return false; }
    self.last_rejection_notice = Some(now);
    true
  }
}

fn is_blocked_file_name(file_name: &str) -> bool {
  // Every dot-separated part after the first is checked, so "invoice.pdf.exe" and "tool.exe.txt" are both refused.
  file_name.split('.').skip(1).any(|part| {
    let part = part.trim().to_ascii_lowercase();
    BLOCKED_EXTENSIONS.contains(&part.as_str())
  })
}

fn exceeds_restricted_limit(loaded: i64, total: i64) -> bool {
  let limit = MINI_APP_MAX_FILE_BYTES as i64;
  loaded > limit || total > limit
}

fn is_restricted_source(service: &str, label: &str) -> bool {
  service == "telegram" && label.starts_with(MINI_APP_LABEL_PREFIX)
}

pub(super) fn prepare_download(app: &AppHandle, url: String, file_name: String) -> Result<String, String> {
  let url = ephemeral_url(&url)?;
  let file_name = safe_file_name(&file_name)?;
  expire_prepared(app);
  let mut transfers = TRANSFERS.lock().map_err(|_| "MEDIA_UNAVAILABLE")?;
  if transfers.prepared.0.len() >= MAX_PREPARED_DOWNLOADS { return Err("MEDIA_BUSY".into()); }
  let source = canonical_source("telegram", &url);
  let id = crate::media_operations::register_download(app, "telegram", source.as_deref(), &file_name)?;
  transfers.prepared.0.push_back(PreparedDownload {
    id: id.clone(), url, file_name, expires: Instant::now() + PREPARE_TIMEOUT, cancelled: false,
  });
  drop(transfers);
  let expiry_app = app.clone();
  EXPIRY_WORKER.call_once(|| {
    std::thread::spawn(move || watch_prepared_expiry(&expiry_app));
  });
  EXPIRY_CHANGED.notify_one();
  Ok(id)
}

fn watch_prepared_expiry(app: &AppHandle) {
  loop {
    let Ok(mut transfers) = TRANSFERS.lock() else { return; };
    let Some(expires) = transfers.prepared.0.iter().map(|entry| entry.expires).min() else {
      drop(EXPIRY_CHANGED.wait(transfers));
      continue;
    };
    let remaining = expires.saturating_duration_since(Instant::now());
    if !remaining.is_zero() {
      drop(EXPIRY_CHANGED.wait_timeout(transfers, remaining));
      continue;
    }
    let expired = transfers.prepared.expire(Instant::now());
    drop(transfers);
    for entry in expired {
      finish_prepared(app, entry);
    }
  }
}

fn expire_prepared(app: &AppHandle) {
  let expired = TRANSFERS.lock().map(|mut transfers| transfers.prepared.expire(Instant::now())).unwrap_or_default();
  for entry in expired {
    finish_prepared(app, entry);
  }
}

fn finish_prepared(app: &AppHandle, entry: PreparedDownload) {
  let error = if entry.cancelled || crate::media_operations::is_cancel_requested(&entry.id) { "MEDIA_CANCELLED" } else { "MEDIA_DOWNLOAD_NOT_STARTED" };
  fail_download(app, &entry.id, "telegram", &entry.url, &entry.file_name, error);
}

fn fail_download(app: &AppHandle, id: &str, service: &str, url: &str, file_name: &str, error: &str) {
  let _ = crate::media_operations::finish_download(app, id, None, false);
  let _ = app.emit_to("main", "download-finished", serde_json::json!({
    "operationId": id, "service": service, "url": url, "fileName": file_name,
    "path": serde_json::Value::Null, "success": false, "error": error,
  }));
}

pub(super) fn request(webview: &Webview, service: &str, url: &Url, destination: &mut PathBuf) -> Result<String, String> {
  expire_prepared(webview.app_handle());
  drain_cancellations(webview.app_handle());
  let requested_name = destination.file_name().and_then(|name| name.to_str()).ok_or("MEDIA_PATH_DENIED")?.to_string();
  let file_name = safe_file_name(&requested_name)?;
  let prepared = {
    let mut transfers = TRANSFERS.lock().map_err(|_| "MEDIA_UNAVAILABLE")?;
    if service == "telegram" { transfers.prepared.take(url.as_str(), &file_name) } else { None }
  };
  let is_restricted = prepared.is_none() && is_restricted_source(service, webview.label());
  let id = if let Some(prepared) = prepared {
    if prepared.cancelled || crate::media_operations::is_cancel_requested(&prepared.id) {
      fail_download(webview.app_handle(), &prepared.id, service, url.as_str(), &file_name, "MEDIA_CANCELLED");
      return Err("MEDIA_CANCELLED".into());
    }
    prepared.id
  } else {
    if is_restricted {
      let source = restricted_source_key(webview);
      let (admitted, should_notify) = {
        let mut transfers = TRANSFERS.lock().map_err(|_| "MEDIA_UNAVAILABLE")?;
        let admitted = transfers.admit_restricted(&source, &file_name, Instant::now());
        (admitted, admitted.is_err() && transfers.should_notify_rejection(Instant::now()))
      };
      if let Err(reason) = admitted {
        if should_notify { notify_rejected(webview.app_handle(), service, url.as_str(), &file_name, reason); }
        return Err(reason.into());
      }
    }
    let page = webview.url().ok().and_then(|page| canonical_source(service, page.as_str()));
    crate::media_operations::register_download(webview.app_handle(), service, page.as_deref(), &file_name)?
  };
  let failure_file_name = file_name.clone();
  request_owned_download(&id,
    |id| crate::media_operations::start_download(webview.app_handle(), id),
    || {
      #[cfg(windows)]
      if !NATIVE_HOOKS.with(|hooks| hooks.borrow().contains_key(webview.label())) { return Err("MEDIA_NATIVE_HOOK_FAILED".into()); }
      let downloads = if super::is_smoke_test() {
        super::smoke_download_directory().ok_or("MEDIA_PATH_DENIED")?
      } else {
        webview.app_handle().path().download_dir().map_err(|_| "MEDIA_PATH_DENIED")?
      };
      let directory = crate::inline_media::create_destination_staging(&downloads)?;
      let downloads = directory.worker_directory().parent().and_then(Path::parent).ok_or("MEDIA_PATH_DENIED")?.to_path_buf();
      let partial = directory.worker_directory().join("media.part");
      let mut transfers = match TRANSFERS.lock() {
        Ok(transfers) => transfers,
        Err(_) => { let _ = directory.cleanup(); return Err("MEDIA_UNAVAILABLE".into()); }
      };
      let final_path = match reserve_destination(&downloads, &file_name, transfers.active.values().map(|entry| &entry.final_path)) {
        Ok(path) => path,
        Err(error) => { drop(transfers); let _ = directory.cleanup(); return Err(error); }
      };
      transfers.active.insert(id.clone(), Transfer {
        id: id.clone(), webview_label: webview.label().into(), service: service.into(), url: url.to_string(),
        file_name, final_path, partial: partial.clone(), directory, cancelled: false, restricted: is_restricted, blocked: None,
      });
      *destination = partial;
      Ok(id.clone())
    },
    |id, error| fail_download(webview.app_handle(), id, service, url.as_str(), &failure_file_name, error),
  )
}

fn restricted_source_key(webview: &Webview) -> String {
  webview.url().ok().map(|page| page.origin().ascii_serialization()).filter(|origin| origin != "null")
    .unwrap_or_else(|| webview.label().to_string())
}

// Page content never gets an operation record for a refused file; the main window only receives a short notice.
fn notify_rejected(app: &AppHandle, service: &str, url: &str, file_name: &str, error: &str) {
  let _ = app.emit_to("main", "download-finished", serde_json::json!({
    "service": service, "url": url, "fileName": file_name, "path": serde_json::Value::Null, "success": false, "error": error,
  }));
}

fn request_owned_download(
  id: &str,
  start: impl FnOnce(&str) -> Result<(), String>,
  allocate: impl FnOnce() -> Result<String, String>,
  fail: impl FnOnce(&str, &str),
) -> Result<String, String> {
  let requested = start(id).and_then(|()| allocate());
  if let Err(error) = &requested { fail(id, error); }
  requested
}

pub(super) fn finish(webview: &Webview, service: &str, url: &Url, path: Option<&Path>, success: bool) -> Option<serde_json::Value> {
  // Interrupted Wry events omit the path. The COM observer supplies its exact owned path.
  let path = path?;
  let transfer = {
    let mut transfers = TRANSFERS.lock().ok()?;
    take_matching_transfer(&mut transfers, webview.label(), service, url.as_str(), path)?
  };
  let result = if let Some(reason) = transfer.blocked {
    Err(reason.into())
  } else if transfer.cancelled || crate::media_operations::is_cancel_requested(&transfer.id) {
    Err("MEDIA_CANCELLED".into())
  } else if success {
    completed_size(&transfer.id).and_then(|expected_size| publish_transfer(&transfer, expected_size))
  } else { Err("MEDIA_FETCH_FAILED".into()) };
  let (final_path, mut completed, mut error) = match result {
    Ok(path) => (Some(path), true, None),
    Err(error) => (None, false, Some(error)),
  };
  let mut journal_warning = None;
  if let Err(reason) = crate::media_operations::finish_download(webview.app_handle(), &transfer.id, final_path.as_deref(), completed) {
    if completed && reason.contains("JOURNAL") {
      // The file is already published. Its retained in-memory result must remain a success.
      journal_warning = Some(reason);
    } else {
      completed = false;
      error = Some(reason);
    }
  }
  let file_name = final_path.as_ref().and_then(|path| path.file_name()).map(|name| name.to_string_lossy().into_owned())
    .unwrap_or_else(|| transfer.file_name.clone());
  let id = transfer.id.clone();
  let _ = transfer.directory.cleanup();
  #[cfg(windows)]
  forget_observer(&id);
  Some(serde_json::json!({
    "operationId": id, "url": url.as_str(), "success": completed, "service": service,
    "fileName": file_name, "path": final_path.map(|path| path.to_string_lossy().into_owned()), "error": error, "journalWarning": journal_warning,
  }))
}

fn take_matching_transfer(transfers: &mut TransferBook, label: &str, service: &str, url: &str, path: &Path) -> Option<Transfer> {
  let id = transfers.active.iter().find_map(|(id, entry)| {
    (entry.webview_label == label && entry.service == service && entry.url == url && same_path(&entry.partial, path)).then(|| id.clone())
  })?;
  transfers.active.remove(&id)
}

fn publish_transfer(transfer: &Transfer, expected_size: Option<u64>) -> Result<PathBuf, String> {
  let metadata = fs::symlink_metadata(&transfer.partial).map_err(|_| "MEDIA_PARTIAL_BODY")?;
  if !metadata.is_file() || metadata.file_type().is_symlink() { return Err("MEDIA_PATH_DENIED".into()); }
  if expected_size.is_some_and(|expected| metadata.len() != expected) { return Err("MEDIA_PARTIAL_BODY".into()); }
  #[cfg(windows)]
  {
    use std::os::windows::fs::MetadataExt;
    if metadata.file_attributes() & 0x400 != 0 { return Err("MEDIA_PATH_DENIED".into()); }
  }
  let source = fs::canonicalize(&transfer.partial).map_err(|_| "MEDIA_PATH_DENIED")?;
  if source.parent() != Some(transfer.directory.worker_directory()) { return Err("MEDIA_PATH_DENIED".into()); }
  fs::OpenOptions::new().read(true).write(true).open(&source).and_then(|file| file.sync_all()).map_err(|_| "MEDIA_DISK_FULL")?;
  let directory = transfer.final_path.parent().ok_or("MEDIA_PATH_DENIED")?;
  let mut destination = transfer.final_path.clone();
  for _ in 0..=MAX_FILE_COLLISIONS {
    match crate::inline_media::publish_no_replace(&source, &destination) {
      Ok(()) => return Ok(destination),
      Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
        let transfers = TRANSFERS.lock().map_err(|_| "MEDIA_UNAVAILABLE")?;
        destination = reserve_destination(directory, &transfer.file_name, transfers.active.values().map(|entry| &entry.final_path))?;
      }
      Err(_) => return Err("MEDIA_PATH_DENIED".into()),
    }
  }
  Err("MEDIA_PATH_DENIED".into())
}

fn reserve_destination<'a>(directory: &Path, file_name: &str, reserved: impl Iterator<Item = &'a PathBuf>) -> Result<PathBuf, String> {
  let reserved: Vec<&PathBuf> = reserved.collect();
  for sequence in 0..=MAX_FILE_COLLISIONS {
    let candidate = directory.join(collision_file_name(file_name, sequence));
    if fs::symlink_metadata(&candidate).is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound) && !reserved.iter().any(|path| same_path(path, &candidate)) { return Ok(candidate); }
  }
  Err("MEDIA_PATH_DENIED".into())
}

fn collision_file_name(file_name: &str, sequence: usize) -> String {
  if sequence == 0 { return file_name.to_string(); }
  let path = Path::new(file_name);
  let stem = path.file_stem().unwrap_or_default().to_string_lossy();
  match path.extension() {
    Some(extension) => format!("{stem} ({sequence}).{}", extension.to_string_lossy()),
    None => format!("{stem} ({sequence})"),
  }
}

pub(super) fn safe_file_name(value: &str) -> Result<String, String> {
  if value.is_empty() || value.chars().count() > 512 { return Err("MEDIA_INPUT_DENIED".into()); }
  let name: String = value.chars().map(|character| {
    if character.is_control() || "<>:\"/\\|?*".contains(character) { '_' } else { character }
  }).collect();
  let mut name = name.trim().trim_end_matches(['.', ' ']).to_string();
  if name.is_empty() || matches!(name.as_str(), "." | "..") { return Err("MEDIA_INPUT_DENIED".into()); }
  if name.encode_utf16().count() > MAX_FILE_NAME_UTF16_UNITS {
    let (stem, suffix) = name.rsplit_once('.').filter(|(_, suffix)| !suffix.is_empty() && suffix.encode_utf16().count() <= 24)
      .map(|(stem, suffix)| (stem, format!(".{suffix}"))).unwrap_or((name.as_str(), String::new()));
    let available = MAX_FILE_NAME_UTF16_UNITS - suffix.encode_utf16().count();
    let mut used = 0;
    let prefix: String = stem.chars().take_while(|character| {
      used += character.len_utf16();
      used <= available
    }).collect();
    name = format!("{prefix}{suffix}").trim_end_matches(['.', ' ']).to_string();
  }
  let stem = name.split('.').next().unwrap_or_default().trim_end().to_ascii_uppercase();
  if matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
    || (stem.len() == 4 && (stem.starts_with("COM") || stem.starts_with("LPT")) && matches!(stem.as_bytes()[3], b'1'..=b'9')) {
    name.insert(0, '_');
  }
  Ok(name)
}

fn ephemeral_url(value: &str) -> Result<String, String> {
  if value.len() > 16 * 1024 * 1024 { return Err("MEDIA_INPUT_DENIED".into()); }
  let parsed = Url::parse(value).map_err(|_| "MEDIA_INPUT_DENIED")?;
  if !matches!(parsed.scheme(), "blob" | "data" | "http" | "https") || !parsed.username().is_empty() || parsed.password().is_some() {
    return Err("MEDIA_INPUT_DENIED".into());
  }
  Ok(parsed.to_string())
}

fn canonical_source(service: &str, value: &str) -> Option<String> {
  let mut url = Url::parse(value).ok()?;
  if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() || url.port_or_known_default() != Some(443) { return None; }
  let host = url.host_str()?;
  let parts: Vec<_> = url.path().trim_matches('/').split('/').collect();
  let allowed = match service {
    "telegram" => host == "t.me" && parts.len() >= 2 && parts.last()?.bytes().all(|byte| byte.is_ascii_digit()),
    "x" => matches!(host, "x.com" | "www.x.com" | "twitter.com" | "www.twitter.com") && parts.len() == 3
      && parts[1] == "status" && !parts[2].is_empty() && parts[2].bytes().all(|byte| byte.is_ascii_digit()),
    "instagram" => matches!(host, "instagram.com" | "www.instagram.com") && parts.len() == 2
      && matches!(parts[0], "p" | "reel" | "tv") && !parts[1].is_empty(),
    _ => false,
  };
  if !allowed { return None; }
  url.set_query(None);
  url.set_fragment(None);
  Some(url.to_string())
}

fn same_path(first: &Path, second: &Path) -> bool {
  #[cfg(windows)]
  {
    fn normalized(path: &Path) -> String { path.to_string_lossy().trim_start_matches("\\\\?\\").replace('/', "\\").to_lowercase() }
    normalized(first) == normalized(second)
  }
  #[cfg(not(windows))]
  { first == second }
}

fn mark_cancelled(ids: &[String]) {
  if let Ok(mut transfers) = TRANSFERS.lock() {
    for entry in &mut transfers.prepared.0 { if ids.contains(&entry.id) { entry.cancelled = true; } }
    for entry in transfers.active.values_mut() { if ids.contains(&entry.id) { entry.cancelled = true; } }
  }
}

pub(super) fn drain_cancellations(_app: &AppHandle) {
  let ids = crate::media_operations::take_cancelled_downloads();
  mark_cancelled(&ids);
  #[cfg(windows)]
  for id in ids {
    let operation = DOWNLOAD_OBSERVERS.with(|observers| observers.borrow().get(&id).map(|observer| observer.operation.clone()));
    if let Some(operation) = operation { unsafe { let _ = operation.Cancel(); } }
  }
}

pub(super) fn install(webview: &Webview, service: &'static str) -> Result<(), String> {
  let cancellation_app = webview.app_handle().clone();
  CANCELLATION_LISTENER.call_once(|| {
    let app = cancellation_app.clone();
    cancellation_app.listen("relay-media-cancel-download", move |_| {
      let pending_app = app.clone();
      let _ = app.run_on_main_thread(move || drain_cancellations(&pending_app));
    });
  });
  #[cfg(windows)]
  return install_windows(webview, service);
  #[cfg(not(windows))]
  { let _ = service; Ok(()) }
}

#[cfg(windows)]
use std::cell::RefCell;
#[cfg(windows)]
use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2DownloadOperation, ICoreWebView2Controller, ICoreWebView2_4};

#[cfg(windows)]
struct DownloadObserver {
  operation: ICoreWebView2DownloadOperation,
  bytes_token: i64,
  state_token: i64,
}

#[cfg(windows)]
struct NativeHooks {
  core: ICoreWebView2_4,
  controller: ICoreWebView2Controller,
  download_token: i64,
  accelerator_token: i64,
}

#[cfg(windows)]
thread_local! {
  static DOWNLOAD_OBSERVERS: RefCell<HashMap<String, DownloadObserver>> = RefCell::new(HashMap::new());
  static NATIVE_HOOKS: RefCell<HashMap<String, NativeHooks>> = RefCell::new(HashMap::new());
}

#[cfg(windows)]
fn forget_observer(id: &str) {
  let observer = DOWNLOAD_OBSERVERS.with(|observers| observers.borrow_mut().remove(id));
  if let Some(observer) = observer {
    unsafe {
      let _ = observer.operation.remove_BytesReceivedChanged(observer.bytes_token);
      let _ = observer.operation.remove_StateChanged(observer.state_token);
    }
  }
}

#[cfg(windows)]
fn install_windows(webview: &Webview, service: &'static str) -> Result<(), String> {
  use windows_core::Interface;
  use webview2_com::{AcceleratorKeyPressedEventHandler, DownloadStartingEventHandler};
  let owner = webview.clone();
  let app = webview.app_handle().clone();
  let label = webview.label().to_string();
  webview.with_webview(move |platform| {
    let installed = (|| -> windows_core::Result<()> {
      unsafe {
        let controller = platform.controller();
        let core = controller.CoreWebView2()?.cast::<ICoreWebView2_4>()?;
        let previous = NATIVE_HOOKS.with(|hooks| hooks.borrow_mut().remove(&label));
        if let Some(previous) = previous {
          let _ = previous.core.remove_DownloadStarting(previous.download_token);
          let _ = previous.controller.remove_AcceleratorKeyPressed(previous.accelerator_token);
        }
        let download_owner = owner.clone();
        let mut download_token = 0;
        core.add_DownloadStarting(&DownloadStartingEventHandler::create(Box::new(move |_, args| {
          let Some(args) = args else { return Ok(()); };
          let mut cancelled = false.into();
          args.Cancel(&mut cancelled)?;
          if cancelled.as_bool() { return Ok(()); }
          let operation = args.DownloadOperation()?;
          let mut path = windows_core::PWSTR::null();
          args.ResultFilePath(&mut path)?;
          let path = PathBuf::from(webview2_com::take_pwstr(path));
          let id = TRANSFERS.lock().ok().and_then(|transfers| transfers.active.iter().find_map(|(id, entry)| {
            (entry.webview_label == download_owner.label() && same_path(&entry.partial, &path)).then(|| id.clone())
          }));
          if let Some(id) = id {
            let is_restricted = TRANSFERS.lock().ok().is_some_and(|transfers| transfers.active.get(&id).is_some_and(|entry| entry.restricted));
            if let Err(error) = observe_download(&download_owner, service, &id, operation.clone(), is_restricted) {
              let _ = operation.Cancel();
              report_interrupted(&download_owner, service, &id);
              log::warn!("[Media] Native download observer unavailable: {error}");
            }
          }
          Ok(())
        })), &mut download_token)?;
        let accelerator_app = app.clone();
        let is_mini_app = label.starts_with("mini-app-");
        let mut accelerator_token = 0;
        if let Err(error) = controller.add_AcceleratorKeyPressed(&AcceleratorKeyPressedEventHandler::create(Box::new(move |_, args| {
          let Some(args) = args else { return Ok(()); };
          let mut key = 0;
          args.VirtualKey(&mut key)?;
          let mut kind = webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_KEY_EVENT_KIND::default();
          args.KeyEventKind(&mut kind)?;
          use webview2_com::Microsoft::Web::WebView2::Win32::{COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN, COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN};
          let is_down = kind == COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN || kind == COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN;
          if !is_ctrl_j(key, is_down, key_down(0x11), key_down(0x12), key_down(0x10)) { return Ok(()); }
          args.SetHandled(true)?;
          let mut physical = webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_PHYSICAL_KEY_STATUS::default();
          args.PhysicalKeyStatus(&mut physical)?;
          if physical.WasKeyDown.as_bool() || physical.RepeatCount > 1 { return Ok(()); }
          let app = accelerator_app.clone();
          tauri::async_runtime::spawn(async move {
            if is_mini_app {
              if let Some(main) = app.get_webview("main") { let _ = main.set_focus(); }
            }
            let _ = app.emit_to("main", "relay-media-toggle", ());
          });
          Ok(())
        })), &mut accelerator_token) {
          let _ = core.remove_DownloadStarting(download_token);
          return Err(error);
        }
        NATIVE_HOOKS.with(|hooks| hooks.borrow_mut().insert(label.clone(), NativeHooks {
          core, controller, download_token, accelerator_token,
        }));
      }
      Ok(())
    })();
    if let Err(error) = installed { log::warn!("[Media] Native WebView hooks unavailable: {error}"); }
  }).map_err(|_| "MEDIA_NATIVE_HOOK_FAILED".into())
}

fn is_ctrl_j(key: u32, is_down: bool, control: bool, alt: bool, shift: bool) -> bool {
  key == 0x4a && is_down && control && !alt && !shift
}

#[cfg(windows)]
unsafe fn key_down(key: i32) -> bool {
  #[link(name = "user32")]
  unsafe extern "system" { fn GetKeyState(key: i32) -> i16; }
  unsafe { GetKeyState(key) < 0 }
}

#[cfg(windows)]
unsafe fn observe_download(owner: &Webview, service: &'static str, id: &str, operation: ICoreWebView2DownloadOperation, is_restricted: bool) -> windows_core::Result<()> {
  use webview2_com::{BytesReceivedChangedEventHandler, StateChangedEventHandler};
  let progress_app = owner.app_handle().clone();
  let progress_id = id.to_string();
  let mut bytes_token = 0;
  unsafe {
    operation.add_BytesReceivedChanged(&BytesReceivedChangedEventHandler::create(Box::new(move |operation, _| {
      if let Some(operation) = operation { update_progress(&progress_app, &progress_id, &operation, is_restricted); }
      Ok(())
    })), &mut bytes_token)?;
  }
  let state_owner = owner.clone();
  let state_id = id.to_string();
  let mut state_token = 0;
  unsafe {
    if let Err(error) = operation.add_StateChanged(&StateChangedEventHandler::create(Box::new(move |operation, _| {
      let Some(operation) = operation else { return Ok(()); };
      let mut state = webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_DOWNLOAD_STATE::default();
      operation.State(&mut state)?;
      use webview2_com::Microsoft::Web::WebView2::Win32::{COREWEBVIEW2_DOWNLOAD_STATE_INTERRUPTED, COREWEBVIEW2_DOWNLOAD_STATE_COMPLETED};
      if state == COREWEBVIEW2_DOWNLOAD_STATE_INTERRUPTED {
        // WebView2 may auto-resume an interrupted operation. Stop it before removing its owned stage.
        forget_observer(&state_id);
        let _ = operation.Cancel();
        report_interrupted(&state_owner, service, &state_id);
      } else if state == COREWEBVIEW2_DOWNLOAD_STATE_COMPLETED { forget_observer(&state_id); }
      Ok(())
    })), &mut state_token) {
      let _ = operation.remove_BytesReceivedChanged(bytes_token);
      return Err(error);
    }
  }
  update_progress(owner.app_handle(), id, &operation, is_restricted);
  DOWNLOAD_OBSERVERS.with(|observers| observers.borrow_mut().insert(id.to_string(), DownloadObserver { operation: operation.clone(), bytes_token, state_token }));
  let _ = owner.app_handle().emit_to("main", "relay-media-download-started", serde_json::json!({ "operationId": id }));
  drain_cancellations(owner.app_handle());
  let cancelled = TRANSFERS.lock().ok().and_then(|transfers| transfers.active.get(id).map(|entry| entry.cancelled)).unwrap_or(false);
  if cancelled || crate::media_operations::is_cancel_requested(id) { unsafe { let _ = operation.Cancel(); } }
  Ok(())
}

#[cfg(windows)]
fn update_progress(app: &AppHandle, id: &str, operation: &ICoreWebView2DownloadOperation, is_restricted: bool) {
  let mut loaded = 0;
  let mut total = 0;
  unsafe {
    if operation.BytesReceived(&mut loaded).is_err() { return; }
    if operation.TotalBytesToReceive(&mut total).is_err() { total = -1; }
    if is_restricted && exceeds_restricted_limit(loaded, total) {
      if let Ok(mut transfers) = TRANSFERS.lock() {
        if let Some(entry) = transfers.active.get_mut(id) { entry.blocked = Some("MEDIA_TOO_LARGE"); }
      }
      let _ = operation.Cancel();
      return;
    }
    let (loaded, total) = download_progress(loaded, total);
    let _ = crate::media_operations::update_download_progress(app, id, loaded, total);
  }
}

#[cfg(any(windows, test))]
fn download_progress(loaded: i64, header_total: i64) -> (u64, Option<u64>) {
  let loaded = loaded.max(0) as u64;
  // Content-Length is only an estimate; never reject actual received bytes when it is smaller.
  let total = (header_total > 0 && header_total as u64 >= loaded).then_some(header_total as u64);
  (loaded, total)
}

fn completed_size(id: &str) -> Result<Option<u64>, String> {
  #[cfg(windows)]
  {
    let operation = DOWNLOAD_OBSERVERS.with(|observers| observers.borrow().get(id).map(|observer| observer.operation.clone()));
    let Some(operation) = operation else { return Ok(None); };
    let mut loaded = 0;
    unsafe {
      operation.BytesReceived(&mut loaded).map_err(|_| "MEDIA_PARTIAL_BODY")?;
      if loaded < 0 { return Err("MEDIA_PARTIAL_BODY".into()); }
    }
    Ok(Some(loaded as u64))
  }
  #[cfg(not(windows))]
  { let _ = id; Ok(None) }
}

#[cfg(windows)]
fn report_interrupted(owner: &Webview, service: &'static str, id: &str) {
  let transfer = TRANSFERS.lock().ok().and_then(|transfers| transfers.active.get(id).map(|entry| (entry.url.clone(), entry.partial.clone())));
  if let Some((url, path)) = transfer {
    if let Ok(url) = Url::parse(&url) {
      super::handle_download(owner, service, tauri::webview::DownloadEvent::Finished { url, path: Some(path), success: false });
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn prepared(id: &str, url: &str, file_name: &str, now: Instant) -> PreparedDownload {
    PreparedDownload { id: id.into(), url: url.into(), file_name: file_name.into(), expires: now + PREPARE_TIMEOUT, cancelled: false }
  }

  #[test]
  fn prepared_and_ordinary_start_failure_keeps_owner_and_skips_destination_allocation() {
    for is_prepared in [true, false] {
      let mut queue = PreparedQueue::default();
      queue.0.push_back(prepared("prepared-id", "blob:one", "photo.png", Instant::now()));
      let id = if is_prepared {
        queue.take("blob:one", "photo.png").unwrap().id
      } else { "ordinary-id".to_string() };
      let starts = std::cell::Cell::new(0);
      let failures = std::cell::RefCell::new(Vec::new());
      let result = request_owned_download(&id,
        |started_id| {
          assert_eq!(started_id, id);
          starts.set(starts.get() + 1);
          Err("MEDIA_JOURNAL_UNAVAILABLE".into())
        },
        || panic!("A rejected start must not allocate a staging directory"),
        |failed_id, error| failures.borrow_mut().push((failed_id.to_string(), error.to_string())),
      );
      assert_eq!(result.unwrap_err(), "MEDIA_JOURNAL_UNAVAILABLE");
      assert_eq!(starts.get(), 1);
      assert_eq!(*failures.borrow(), [(id.clone(), "MEDIA_JOURNAL_UNAVAILABLE".to_string())]);
      assert_eq!(queue.0.len(), usize::from(!is_prepared));
    }
  }

  #[test]
  fn destination_failure_finishes_the_started_operation_once() {
    let starts = std::cell::Cell::new(0);
    let failures = std::cell::RefCell::new(Vec::new());
    let result = request_owned_download("owned-id",
      |id| { assert_eq!(id, "owned-id"); starts.set(starts.get() + 1); Ok(()) },
      || Err("MEDIA_DISK_FULL".into()),
      |id, error| failures.borrow_mut().push((id.to_string(), error.to_string())),
    );
    assert_eq!(result.unwrap_err(), "MEDIA_DISK_FULL");
    assert_eq!(starts.get(), 1);
    assert_eq!(*failures.borrow(), [("owned-id".to_string(), "MEDIA_DISK_FULL".to_string())]);
  }

  #[test]
  fn accepted_owned_download_returns_its_id_without_failure_notification() {
    let allocations = std::cell::Cell::new(0);
    let result = request_owned_download("owned-id",
      |_| Ok(()),
      || { allocations.set(allocations.get() + 1); Ok("owned-id".to_string()) },
      |_, _| panic!("An accepted download must not emit a failure"),
    );
    assert_eq!(result.unwrap(), "owned-id");
    assert_eq!(allocations.get(), 1);
  }

  #[test]
  fn preparation_matches_exact_url_and_name_in_fifo_order() {
    let now = Instant::now();
    let mut queue = PreparedQueue::default();
    queue.0.push_back(prepared("first", "blob:one", "photo.png", now));
    queue.0.push_back(prepared("other-name", "blob:one", "other.png", now));
    queue.0.push_back(prepared("second", "blob:one", "photo.png", now));
    assert!(queue.take("blob:two", "photo.png").is_none());
    assert_eq!(queue.take("blob:one", "photo.png").unwrap().id, "first");
    assert_eq!(queue.take("blob:one", "photo.png").unwrap().id, "second");
    assert_eq!(queue.take("blob:one", "other.png").unwrap().id, "other-name");
  }

  #[test]
  fn cancellation_tombstone_keeps_its_fifo_slot_and_expiry_drops_only_expired_entries() {
    let now = Instant::now();
    let mut queue = PreparedQueue::default();
    let mut first = prepared("cancelled", "blob:one", "file.txt", now);
    first.cancelled = true;
    queue.0.push_back(first);
    queue.0.push_back(prepared("later", "blob:one", "file.txt", now + Duration::from_secs(1)));
    assert!(queue.take("blob:one", "file.txt").unwrap().cancelled);
    assert!(queue.expire(now + PREPARE_TIMEOUT).is_empty());
    assert_eq!(queue.expire(now + PREPARE_TIMEOUT + Duration::from_secs(1))[0].id, "later");
  }

  #[test]
  fn reserved_names_collisions_and_non_post_sources_are_bounded() {
    assert_eq!(safe_file_name("CON.txt").unwrap(), "_CON.txt");
    assert_eq!(safe_file_name("../private:photo.png").unwrap(), ".._private_photo.png");
    assert!(safe_file_name("..").is_err());
    let long = safe_file_name(&format!("{}.mp4", "📷".repeat(150))).unwrap();
    assert!(long.ends_with(".mp4"));
    assert!(long.encode_utf16().count() <= MAX_FILE_NAME_UTF16_UNITS);
    assert_eq!(collision_file_name("photo.png", 2), "photo (2).png");
    assert_eq!(collision_file_name("README", 1), "README (1)");
    assert!(canonical_source("x", "https://x.com/home").is_none());
    assert!(canonical_source("telegram", "blob:https://tauri.localhost/secret").is_none());
    assert_eq!(canonical_source("instagram", "https://www.instagram.com/reel/ABC/?secret=one#fragment").unwrap(), "https://www.instagram.com/reel/ABC/");
    assert!(ephemeral_url("file:///C:/private.txt").is_err());
  }

  #[test]
  fn ctrl_j_does_not_capture_devtools_variants_or_key_up() {
    assert!(is_ctrl_j(0x4a, true, true, false, false));
    assert!(!is_ctrl_j(0x4a, true, true, false, true));
    assert!(!is_ctrl_j(0x4a, true, true, true, false));
    assert!(!is_ctrl_j(0x4a, false, true, false, false));
    assert!(!is_ctrl_j(0x4a, true, false, false, false));
  }

  #[test]
  fn dangerous_and_double_extensions_are_refused_for_page_content() {
    for name in ["setup.exe", "Счёт.pdf.exe", "run.BAT", "a.ps1", "x.js", "link.lnk", "note.hta", "driver.dll", "k.reg", "p.pif", "m.msi",
      "report.exe.txt", ".exe", "archive.jar", "s.vbs", "s.wsf", "c.cpl", "a.scr", "s.com", "a.cmd", "a.psm1", "a.jse", "a.vbe", "a.wsh"] {
      assert!(is_blocked_file_name(name), "{name} must be blocked");
    }
    for name in ["photo.png", "document.pdf", "archive.zip", "video.mp4", "README", "notes.txt", "jsonl", "exe", "Счёт.pdf"] {
      assert!(!is_blocked_file_name(name), "{name} must be allowed");
    }
  }

  #[test]
  fn restricted_downloads_are_limited_by_type_and_rate_per_source() {
    let now = Instant::now();
    let mut book = TransferBook::default();
    assert_eq!(book.admit_restricted("https://app.example", "run.exe", now), Err("MEDIA_TYPE_BLOCKED"));
    assert!(book.restricted_starts.is_empty());
    for index in 0..MINI_APP_MAX_STARTS {
      assert_eq!(book.admit_restricted("https://app.example", "photo.png", now + Duration::from_secs(index as u64)), Ok(()));
    }
    let blocked_at = now + Duration::from_secs(10);
    assert_eq!(book.admit_restricted("https://app.example", "photo.png", blocked_at), Err("MEDIA_RATE_LIMITED"));
    assert_eq!(book.admit_restricted("https://other.example", "photo.png", blocked_at), Ok(()));
    // The window slides: the oldest request has expired after a minute.
    assert_eq!(book.admit_restricted("https://app.example", "photo.png", now + MINI_APP_START_WINDOW), Ok(()));
    assert_eq!(book.admit_restricted("https://app.example", "photo.png", now + MINI_APP_START_WINDOW), Err("MEDIA_RATE_LIMITED"));
  }

  #[test]
  fn restricted_queue_and_source_table_are_bounded() {
    let now = Instant::now();
    let downloads = TestDownloads::create();
    let mut book = TransferBook::default();
    for _ in 0..MINI_APP_MAX_ACTIVE {
      let mut transfer = downloads.transfer("file.bin");
      transfer.restricted = true;
      book.active.insert(transfer.id.clone(), transfer);
    }
    let trusted = downloads.transfer("main.bin");
    book.active.insert(trusted.id.clone(), trusted);
    assert_eq!(book.admit_restricted("https://app.example", "file.bin", now), Err("MEDIA_QUEUE_FULL"));
    for (_, transfer) in book.active.drain() { transfer.directory.cleanup().unwrap(); }
    for index in 0..MINI_APP_MAX_SOURCES {
      assert_eq!(book.admit_restricted(&format!("https://source-{index}.example"), "file.bin", now), Ok(()));
    }
    assert_eq!(book.admit_restricted("https://one-more.example", "file.bin", now), Err("MEDIA_RATE_LIMITED"));
  }

  #[test]
  fn rejection_notices_are_throttled_and_size_limit_uses_received_or_declared_bytes() {
    let now = Instant::now();
    let mut book = TransferBook::default();
    assert!(book.should_notify_rejection(now));
    assert!(!book.should_notify_rejection(now + Duration::from_millis(10)));
    assert!(book.should_notify_rejection(now + MINI_APP_NOTICE_INTERVAL));
    let limit = MINI_APP_MAX_FILE_BYTES as i64;
    assert!(!exceeds_restricted_limit(limit, limit));
    assert!(exceeds_restricted_limit(limit + 1, -1));
    assert!(exceeds_restricted_limit(0, limit + 1));
    assert!(!exceeds_restricted_limit(10, -1));
    assert!(is_restricted_source("telegram", "mini-app-abc"));
    assert!(is_restricted_source("telegram", "mini-app-popup-abc"));
    assert!(!is_restricted_source("telegram", "main"));
    assert!(!is_restricted_source("x", "mini-app-abc"));
  }

  struct TestDownloads(PathBuf);

  impl TestDownloads {
    fn create() -> Self {
      let work = PathBuf::from(std::env::var_os("EGOIST_RELAY_TEST_WORK").or_else(|| std::env::var_os("EGOIST_RELAY_AUDIT_WORK")).expect("file tests require EGOIST_RELAY_TEST_WORK pointing to task-owned work"));
      let work = fs::canonicalize(work).unwrap();
      let path = work.join(format!("native-downloads-test-{}", uuid::Uuid::new_v4()));
      fs::create_dir(&path).unwrap();
      Self(fs::canonicalize(path).unwrap())
    }

    fn transfer(&self, file_name: &str) -> Transfer {
      let directory = crate::inline_media::create_destination_staging(&self.0).unwrap();
      let partial = directory.worker_directory().join("media.part");
      let final_path = reserve_destination(&self.0, file_name, std::iter::empty()).unwrap();
      Transfer {
        id: uuid::Uuid::new_v4().to_string(), webview_label: "test-main".into(), service: "telegram".into(),
        url: "blob:test".into(), file_name: file_name.into(), final_path, partial, directory, cancelled: false,
        restricted: false, blocked: None,
      }
    }
  }

  impl Drop for TestDownloads {
    fn drop(&mut self) {
      let work = PathBuf::from(std::env::var_os("EGOIST_RELAY_TEST_WORK").or_else(|| std::env::var_os("EGOIST_RELAY_AUDIT_WORK")).unwrap());
      if let Ok(work) = fs::canonicalize(work) {
        if self.0.parent() == Some(work.as_path()) && self.0.file_name().is_some_and(|name| name.to_string_lossy().starts_with("native-downloads-test-")) {
          let _ = fs::remove_dir_all(&self.0);
        }
      }
    }
  }

  #[test]
  fn successful_download_is_only_published_after_validation_and_owned_stage_is_removed() {
    let downloads = TestDownloads::create();
    let transfer = downloads.transfer("photo.png");
    let stage = transfer.directory.worker_directory().to_path_buf();
    fs::write(&transfer.partial, b"complete-media").unwrap();
    assert!(!transfer.final_path.exists());
    assert!(stage.join("owner.lock").is_file());
    let published = publish_transfer(&transfer, Some(14)).unwrap();
    assert_eq!(fs::read(&published).unwrap(), b"complete-media");
    assert!(!transfer.partial.exists());
    transfer.directory.cleanup().unwrap();
    assert!(!stage.exists());
    assert_eq!(fs::read(&published).unwrap(), b"complete-media");
  }

  #[test]
  fn late_destination_collision_preserves_existing_file_and_selects_new_name() {
    let downloads = TestDownloads::create();
    let transfer = downloads.transfer("video.mp4");
    fs::write(&transfer.partial, b"new-video").unwrap();
    fs::write(&transfer.final_path, b"user-original").unwrap();
    let published = publish_transfer(&transfer, Some(9)).unwrap();
    assert_eq!(published.file_name().unwrap(), "video (1).mp4");
    assert_eq!(fs::read(&transfer.final_path).unwrap(), b"user-original");
    assert_eq!(fs::read(&published).unwrap(), b"new-video");
    transfer.directory.cleanup().unwrap();
  }

  #[test]
  fn missing_or_short_partial_never_creates_a_final_name_and_zero_byte_files_are_valid() {
    let downloads = TestDownloads::create();
    let missing = downloads.transfer("missing.txt");
    assert_eq!(publish_transfer(&missing, None).unwrap_err(), "MEDIA_PARTIAL_BODY");
    assert!(!missing.final_path.exists());
    missing.directory.cleanup().unwrap();
    let short = downloads.transfer("short.txt");
    fs::write(&short.partial, b"short").unwrap();
    assert_eq!(publish_transfer(&short, Some(6)).unwrap_err(), "MEDIA_PARTIAL_BODY");
    assert!(!short.final_path.exists());
    short.directory.cleanup().unwrap();
    let empty = downloads.transfer("empty.txt");
    fs::write(&empty.partial, b"").unwrap();
    let published = publish_transfer(&empty, Some(0)).unwrap();
    assert_eq!(fs::metadata(published).unwrap().len(), 0);
    empty.directory.cleanup().unwrap();
  }

  #[test]
  fn reservation_skips_other_active_downloads_and_existing_names() {
    let downloads = TestDownloads::create();
    let first = reserve_destination(&downloads.0, "media.jpg", std::iter::empty()).unwrap();
    let second = reserve_destination(&downloads.0, "media.jpg", std::iter::once(&first)).unwrap();
    assert_eq!(second.file_name().unwrap(), "media (1).jpg");
    fs::write(&second, b"existing").unwrap();
    let third = reserve_destination(&downloads.0, "media.jpg", std::iter::once(&first)).unwrap();
    assert_eq!(third.file_name().unwrap(), "media (2).jpg");
  }


  #[test]
  fn identical_url_completions_require_exact_owned_path_and_ignore_late_events() {
    let downloads = TestDownloads::create();
    let first = downloads.transfer("shared.bin");
    let second = downloads.transfer("shared.bin");
    let first_id = first.id.clone();
    let second_id = second.id.clone();
    let second_path = second.partial.clone();
    let mut transfers = TransferBook::default();
    transfers.active.insert(first_id.clone(), first);
    transfers.active.insert(second_id.clone(), second);
    assert!(take_matching_transfer(&mut transfers, "wrong-view", "telegram", "blob:test", &second_path).is_none());
    assert!(take_matching_transfer(&mut transfers, "test-main", "x", "blob:test", &second_path).is_none());
    assert!(take_matching_transfer(&mut transfers, "test-main", "telegram", "blob:other", &second_path).is_none());
    let finished = take_matching_transfer(&mut transfers, "test-main", "telegram", "blob:test", &second_path).unwrap();
    assert_eq!(finished.id, second_id);
    assert!(transfers.active.contains_key(&first_id));
    assert!(take_matching_transfer(&mut transfers, "test-main", "telegram", "blob:test", &second_path).is_none());
    finished.directory.cleanup().unwrap();
  }


  #[test]
  fn received_file_bytes_do_not_depend_on_a_missing_or_smaller_header_estimate() {
    assert_eq!(download_progress(12, 9), (12, None));
    assert_eq!(download_progress(12, -1), (12, None));
    assert_eq!(download_progress(12, 12), (12, Some(12)));
    assert_eq!(download_progress(12, 20), (12, Some(20)));
    assert_eq!(download_progress(0, 0), (0, None));
  }

}
pub(super) fn release(webview: &Webview) -> Result<(), String> {
  release_by_label(webview, webview.label().to_string())
}

pub(super) fn release_by_label(dispatcher: &Webview, label: String) -> Result<(), String> {
  #[cfg(windows)]
  {
    dispatcher.with_webview(move |_| {
      let previous = NATIVE_HOOKS.with(|hooks| hooks.borrow_mut().remove(&label));
      if let Some(previous) = previous {
        unsafe {
          let _ = previous.core.remove_DownloadStarting(previous.download_token);
          let _ = previous.controller.remove_AcceleratorKeyPressed(previous.accelerator_token);
        }
      }
    }).map_err(|_| "MEDIA_NATIVE_HOOK_FAILED".into())
  }
  #[cfg(not(windows))]
  { let _ = (dispatcher, label); Ok(()) }
}
