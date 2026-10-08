use std::sync::{
  Condvar, LazyLock, Mutex, Once,
  atomic::{AtomicBool, AtomicU64, Ordering},
};
use std::path::PathBuf;
use std::time::{Duration, Instant};

use tauri::{
  AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Position, Rect, Size,
  WebviewBuilder, WebviewUrl, WebviewWindowBuilder,
  webview::{DownloadEvent, NewWindowFeatures, NewWindowResponse},
};
#[cfg(not(windows))]
use tauri::webview::PageLoadEvent;
use url::{Host, Url};

#[path = "multi_app_downloads.rs"]
mod downloads;

const TELEGRAM_APP: &str = "telegram";
const X_APP: &str = "x";
const X_HOME_URL: &str = "https://x.com";
const X_LOGIN_URL: &str = "https://x.com/i/flow/login";
const X_WEBVIEW_LABEL: &str = "x_webview";
const X_AUTH_WINDOW_LABEL_PREFIX: &str = "x-auth";
const X_AUTH_WINDOW_TITLE: &str = "X — Sign in";
const X_AUTH_WINDOW_WIDTH: f64 = 560.0;
const X_AUTH_WINDOW_HEIGHT: f64 = 760.0;
const X_AUTH_WINDOW_MIN_WIDTH: f64 = 420.0;
const X_AUTH_WINDOW_MIN_HEIGHT: f64 = 560.0;
const INSTAGRAM_APP: &str = "instagram";
const INSTAGRAM_HOME_URL: &str = "https://www.instagram.com";
const INSTAGRAM_WEBVIEW_LABEL: &str = "instagram_webview";
const INSTAGRAM_STATUS_EVENT: &str = "multi-instagram-status";
const DEFAULT_SIDEBAR_WIDTH: i32 = 72;
const DEFAULT_TITLEBAR_HEIGHT: i32 = 40;
const X_STATUS_EVENT: &str = "multi-x-status";
const INSTAGRAM_ENHANCER_SCRIPT: &str = include_str!("../../scripts/instagram-enhancer.js");
const X_ENHANCER_SCRIPT: &str = include_str!("../../scripts/x-enhancer.js");
const SERVICE_LOAD_TIMEOUT: Duration = Duration::from_secs(45);
// Explicit arguments retain the pinned Wry 0.57.0 defaults for every X profile view
#[cfg(windows)]
const X_SERVICE_BROWSER_ARGUMENTS: &str = concat!(
  "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection ",
  "--autoplay-policy=no-user-gesture-required ",
  "--host-resolver-rules=\"MAP abs.twimg.com ton.twimg.com, MAP pbs.twimg.com ton.twimg.com\"",
);

pub(crate) fn apply_service_network_profile<R: tauri::Runtime>(
  builder: WebviewBuilder<R>,
  service: &str,
) -> WebviewBuilder<R> {
  #[cfg(windows)]
  if service == X_APP {
    return builder.additional_browser_args(X_SERVICE_BROWSER_ARGUMENTS);
  }
  #[cfg(not(windows))]
  let _ = service;
  builder
}

struct ServiceLoadDeadline {
  generation: u64,
  expires_at: Option<Instant>,
}

struct ServiceLoadWatchdog {
  state: Mutex<ServiceLoadDeadline>,
  changed: Condvar,
  worker: Once,
}

impl ServiceLoadWatchdog {
  const fn new() -> Self {
    Self {
      state: Mutex::new(ServiceLoadDeadline { generation: 0, expires_at: None }),
      changed: Condvar::new(),
      worker: Once::new(),
    }
  }
}

#[derive(serde::Deserialize, serde::Serialize, Debug, Clone, Copy)]
pub struct AppBounds {
  pub x: i32,
  pub y: i32,
  pub width: i32,
  pub height: i32,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ServiceStatusPayload {
  state: &'static str,
  url: Option<String>,
  message: Option<String>,
}

static ACTIVE_APP: LazyLock<Mutex<String>> = LazyLock::new(|| Mutex::new(TELEGRAM_APP.to_string()));
static CURRENT_X_BOUNDS: LazyLock<Mutex<Option<AppBounds>>> = LazyLock::new(|| Mutex::new(None));
static X_LOAD_STATE: LazyLock<Mutex<&'static str>> = LazyLock::new(|| Mutex::new("loading"));
static X_WAITING_TO_SHOW: AtomicBool = AtomicBool::new(false);
static X_AUTH_WINDOW_SEQUENCE: AtomicU64 = AtomicU64::new(1);
static INSTAGRAM_LOAD_STATE: LazyLock<Mutex<&'static str>> =
  LazyLock::new(|| Mutex::new("loading"));
static INSTAGRAM_WAITING_TO_SHOW: AtomicBool = AtomicBool::new(false);
static X_LOAD_WATCHDOG: ServiceLoadWatchdog = ServiceLoadWatchdog::new();
static INSTAGRAM_LOAD_WATCHDOG: ServiceLoadWatchdog = ServiceLoadWatchdog::new();
static WEBVIEW_CREATION_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));
const SMOKE_CANCEL_DOWNLOAD_URL: &str = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=";
static SOCIAL_OVERLAY: AtomicBool = AtomicBool::new(false);
static CONTENT_VISIBLE: AtomicBool = AtomicBool::new(true);

pub(crate) fn has_social_overlay() -> bool {
  SOCIAL_OVERLAY.load(Ordering::Acquire)
}

pub(crate) fn set_social_overlay(app: &AppHandle, visible: bool) -> Result<(), String> {
  if visible {
    SOCIAL_OVERLAY.store(true, Ordering::Release);
    for label in [X_WEBVIEW_LABEL, INSTAGRAM_WEBVIEW_LABEL] {
      if let Some(webview) = app.get_webview(label) {
        set_media_active(&webview, false);
        if webview.hide().is_err() {
          SOCIAL_OVERLAY.store(false, Ordering::Release);
          let _ = set_social_overlay(app, false);
          return Err("SHARE_OVERLAY_FAILED".to_string());
        }
      }
    }
    return Ok(());
  }
  SOCIAL_OVERLAY.store(false, Ordering::Release);
  let active = get_active_app();
  let label = match active.as_str() { X_APP => X_WEBVIEW_LABEL, INSTAGRAM_APP => INSTAGRAM_WEBVIEW_LABEL, _ => { SOCIAL_OVERLAY.store(false, Ordering::Release); return Ok(()); } };
  let can_show = if active == X_APP { !X_WAITING_TO_SHOW.load(Ordering::Acquire) && get_x_load_state() != "auth-required" } else { !INSTAGRAM_WAITING_TO_SHOW.load(Ordering::Acquire) };
  if can_show && CONTENT_VISIBLE.load(Ordering::Acquire) {
    if let Some(webview) = app.get_webview(label) {
      webview.show().map_err(|_| "SHARE_OVERLAY_FAILED")?;
      set_media_active(&webview, true);
    }
  }
  SOCIAL_OVERLAY.store(false, Ordering::Release);
  Ok(())
}

pub(crate) fn install_browser_native_hooks(webview: &tauri::Webview) -> Result<(), String> {
  downloads::install(webview, TELEGRAM_APP)
}

pub(crate) fn release_browser_native_hooks(webview: &tauri::Webview) -> Result<(), String> {
  downloads::release(webview)
}

pub(crate) fn release_browser_native_hooks_by_label(app: &AppHandle, label: &str) -> Result<(), String> {
  let main = app.get_webview("main").ok_or("MEDIA_NATIVE_HOOK_FAILED")?;
  downloads::release_by_label(&main, label.to_string())
}

pub(crate) fn install_main_native_hooks(window: &tauri::WebviewWindow) -> Result<(), String> {
  downloads::install(window.as_ref(), TELEGRAM_APP)
}

#[tauri::command]
pub(crate) fn relay_media_download_file_name(webview: tauri::Webview, file_name: String) -> Result<String, String> {
  crate::social_share::require_main(&webview)?;
  downloads::safe_file_name(&file_name)
}

#[tauri::command]
pub(crate) fn relay_media_download_prepare(webview: tauri::Webview, app_handle: AppHandle, url: String, file_name: String) -> Result<String, String> {
  crate::social_share::require_main(&webview)?;
  downloads::prepare_download(&app_handle, url, file_name)
}

#[tauri::command]
pub(crate) fn multi_set_content_visible(webview: tauri::Webview, app_handle: AppHandle, visible: bool) -> Result<(), String> {
  crate::social_share::require_main(&webview)?;
  let previous = CONTENT_VISIBLE.swap(visible, Ordering::AcqRel);
  if !visible {
    for label in [X_WEBVIEW_LABEL, INSTAGRAM_WEBVIEW_LABEL] {
      if let Some(view) = app_handle.get_webview(label) {
        set_media_active(&view, false);
        if view.hide().is_err() {
          CONTENT_VISIBLE.store(previous, Ordering::Release);
          let _ = restore_native_content(&app_handle);
          return Err("MEDIA_CONTENT_VISIBILITY_FAILED".into());
        }
      }
    }
    if !crate::should_avoid_foreground() { let _ = webview.set_focus(); }
    return Ok(());
  }
  if let Err(error) = restore_native_content(&app_handle) {
    CONTENT_VISIBLE.store(previous, Ordering::Release);
    return Err(error);
  }
  Ok(())
}

#[tauri::command]
pub(crate) fn relay_media_operation_source(webview: tauri::Webview, app_handle: AppHandle, id: String) -> Result<(), String> {
  crate::social_share::require_main(&webview)?;
  let (service, source) = crate::media_operations::operation_source(&app_handle, &id)?;
  if has_social_overlay() { return Err("SHARE_BUSY".into()); }
  if !CONTENT_VISIBLE.load(Ordering::Acquire) { return Err("MEDIA_OPERATIONS_OPEN".into()); }
  if get_active_app() != service { return Err("MEDIA_SOURCE_SERVICE_INACTIVE".into()); }
  if service == TELEGRAM_APP {
    return app_handle.emit_to("main", "relay-media-source", serde_json::json!({
      "operationId": id, "service": service, "url": source,
    })).map_err(|_| "MEDIA_SOURCE_UNAVAILABLE".into());
  }
  let service = match service.as_str() {
    X_APP => X_APP,
    INSTAGRAM_APP => INSTAGRAM_APP,
    _ => return Err("MEDIA_SOURCE_DENIED".into()),
  };
  let target = app_handle.get_webview(get_service_label(service)).ok_or("MEDIA_SOURCE_UNAVAILABLE")?;
  let source = Url::parse(&source).map_err(|_| "MEDIA_SOURCE_DENIED")?;
  begin_service_load(&app_handle, service);
  if target.navigate(source).is_err() {
    emit_service_error(&app_handle, service, "The media source could not be opened".into());
    return Err("MEDIA_SOURCE_UNAVAILABLE".into());
  }
  Ok(())
}

fn restore_native_content(app: &AppHandle) -> Result<(), String> {
  if !CONTENT_VISIBLE.load(Ordering::Acquire) || has_social_overlay() { return Ok(()); }
  let active = get_active_app();
  let (label, can_show) = match active.as_str() {
    X_APP => (X_WEBVIEW_LABEL, !X_WAITING_TO_SHOW.load(Ordering::Acquire) && get_x_load_state() != "auth-required"),
    INSTAGRAM_APP => (INSTAGRAM_WEBVIEW_LABEL, !INSTAGRAM_WAITING_TO_SHOW.load(Ordering::Acquire)),
    _ => return Ok(()),
  };
  if can_show {
    if let Some(view) = app.get_webview(label) {
      view.show().map_err(|_| "MEDIA_CONTENT_VISIBILITY_FAILED")?;
      set_media_active(&view, true);
      if !crate::should_avoid_foreground() { let _ = view.set_focus(); }
    }
  }
  Ok(())
}

pub fn get_active_app() -> String {
  ACTIVE_APP
    .lock()
    .unwrap_or_else(|poisoned| poisoned.into_inner())
    .clone()
}

pub fn on_main_window_resize(app_handle: &AppHandle) {
  let active = get_active_app();
  if active != X_APP && active != INSTAGRAM_APP {
    return;
  }

  let result: Result<(), String> = (|| {
    let main_window = app_handle
      .get_window("main")
      .ok_or_else(|| "Main window not found".to_string())?;
    let current = get_x_bounds().unwrap_or(default_x_bounds());
    let bounds = resolve_x_bounds(
      &main_window,
      AppBounds {
        x: current.x,
        y: current.y,
        width: i32::MAX,
        height: i32::MAX,
      },
    )?;

    if active == X_APP {
      apply_webview_bounds(app_handle, X_WEBVIEW_LABEL, bounds)?;
    } else if active == INSTAGRAM_APP {
      apply_webview_bounds(app_handle, INSTAGRAM_WEBVIEW_LABEL, bounds)?;
    }
    store_x_bounds(bounds);
    Ok(())
  })();

  if let Err(message) = result {
    if active == X_APP {
      emit_x_error(app_handle, message);
    } else if active == INSTAGRAM_APP {
      emit_instagram_error(app_handle, message);
    }
  }
}

#[tauri::command]
pub async fn multi_prewarm_x(
  app_handle: AppHandle,
  bounds: Option<AppBounds>,
) -> Result<(), String> {
  let _guard = WEBVIEW_CREATION_LOCK
    .lock()
    .unwrap_or_else(|p| p.into_inner());
  if app_handle.get_webview(X_WEBVIEW_LABEL).is_some() {
    return Ok(());
  }

  let main_window = app_handle
    .get_window("main")
    .ok_or_else(|| "Main window not found".to_string())?;

  let requested_bounds = bounds.or_else(get_x_bounds).unwrap_or(default_x_bounds());
  let bounds = resolve_x_bounds(&main_window, requested_bounds)?;

  create_x_webview(&app_handle, &main_window, bounds, true)?;
  store_x_bounds(bounds);
  Ok(())
}

#[tauri::command]
pub async fn multi_prewarm_instagram(
  app_handle: AppHandle,
  bounds: Option<AppBounds>,
) -> Result<(), String> {
  let _guard = WEBVIEW_CREATION_LOCK
    .lock()
    .unwrap_or_else(|p| p.into_inner());
  if app_handle.get_webview(INSTAGRAM_WEBVIEW_LABEL).is_some() {
    return Ok(());
  }

  let main_window = app_handle
    .get_window("main")
    .ok_or_else(|| "Main window not found".to_string())?;

  let requested_bounds = bounds.or_else(get_x_bounds).unwrap_or(default_x_bounds());
  let bounds = resolve_x_bounds(&main_window, requested_bounds)?;

  create_instagram_webview(&app_handle, &main_window, bounds, true)?;
  store_x_bounds(bounds);
  Ok(())
}

#[tauri::command]
pub async fn multi_set_active_app(
  app_handle: AppHandle,
  app: String,
  bounds: Option<AppBounds>,
) -> Result<(), String> {
  if has_social_overlay() { return Err("SHARE_BUSY".to_string()); }
  if !CONTENT_VISIBLE.load(Ordering::Acquire) { return Err("MEDIA_OPERATIONS_OPEN".into()); }
  let _guard = WEBVIEW_CREATION_LOCK
    .lock()
    .unwrap_or_else(|p| p.into_inner());
  let result = match app.as_str() {
    X_APP => activate_x(&app_handle, bounds),
    INSTAGRAM_APP => activate_instagram(&app_handle, bounds),
    TELEGRAM_APP => activate_telegram(&app_handle),
    _ => Err(format!("Unknown app: {app}")),
  };

  if let Err(message) = &result {
    if app == X_APP || app == INSTAGRAM_APP {
      for label in [X_WEBVIEW_LABEL, INSTAGRAM_WEBVIEW_LABEL] {
        if let Some(webview) = app_handle.get_webview(label) {
          set_media_active(&webview, false);
          let _ = webview.hide();
        }
      }
      store_active_app(&app);
    }
    if app == X_APP {
      emit_x_error(&app_handle, message.clone());
    } else if app == INSTAGRAM_APP {
      emit_instagram_error(&app_handle, message.clone());
    }
  }

  result
}

#[tauri::command]
pub fn multi_update_x_bounds(app_handle: AppHandle, bounds: AppBounds) -> Result<(), String> {
  let result: Result<(), String> = (|| {
    let main_window = app_handle
      .get_window("main")
      .ok_or_else(|| "Main window not found".to_string())?;
    let bounds = resolve_x_bounds(&main_window, bounds)?;

    if get_active_app() == X_APP {
      apply_webview_bounds(&app_handle, X_WEBVIEW_LABEL, bounds)?;
    } else if get_active_app() == INSTAGRAM_APP {
      apply_webview_bounds(&app_handle, INSTAGRAM_WEBVIEW_LABEL, bounds)?;
    }

    store_x_bounds(bounds);
    Ok(())
  })();

  if let Err(message) = &result {
    let active = get_active_app();
    if active == X_APP {
      emit_x_error(&app_handle, message.clone());
    } else if active == INSTAGRAM_APP {
      emit_instagram_error(&app_handle, message.clone());
    }
  }

  result
}

#[tauri::command]
pub async fn multi_x_navigate(app_handle: AppHandle, action: String) -> Result<(), String> {
  if has_social_overlay() { return Err("SHARE_BUSY".to_string()); }
  if !CONTENT_VISIBLE.load(Ordering::Acquire) { return Err("MEDIA_OPERATIONS_OPEN".into()); }
  let result: Result<(), String> = (|| {
    if get_active_app() != X_APP {
      return Err("X is not active".to_string());
    }
    let webview = app_handle
      .get_webview(X_WEBVIEW_LABEL)
      .ok_or_else(|| "X webview is not available".to_string())?;

    if action == "reload" || action == "home" || action == "login" {
      begin_service_load(&app_handle, X_APP);
    }

    if X_WAITING_TO_SHOW.load(Ordering::Acquire) {
      emit_x_status(&app_handle, "loading", None);
    } else {
      webview
        .show()
        .map_err(|error| format!("Failed to show X: {error}"))?;
      if !crate::should_avoid_foreground() {
        webview
          .set_focus()
          .map_err(|error| format!("Failed to focus X: {error}"))?;
      }
    }

    match action.as_str() {
      "back" => webview.eval("window.history.back()"),
      "forward" => webview.eval("window.history.forward()"),
      "reload" => webview.reload(),
      "home" => webview.navigate(parse_x_home_url()?),
      "login" => webview.navigate(Url::parse(X_LOGIN_URL).expect("The X sign-in URL is valid")),
      _ => return Err(format!("Unknown X navigation action: {action}")),
    }
    .map_err(|error| format!("Failed to navigate X: {error}"))
  })();

  if let Err(message) = &result {
    emit_x_error(&app_handle, message.clone());
  }

  result
}

#[tauri::command]
pub async fn multi_instagram_navigate(app_handle: AppHandle, action: String) -> Result<(), String> {
  if has_social_overlay() { return Err("SHARE_BUSY".to_string()); }
  if !CONTENT_VISIBLE.load(Ordering::Acquire) { return Err("MEDIA_OPERATIONS_OPEN".into()); }
  let result: Result<(), String> = (|| {
    if get_active_app() != INSTAGRAM_APP {
      return Err("Instagram is not active".to_string());
    }
    let webview = app_handle
      .get_webview(INSTAGRAM_WEBVIEW_LABEL)
      .ok_or_else(|| "Instagram webview is not available".to_string())?;

    if action == "reload" || action == "home" || action == "login" {
      begin_service_load(&app_handle, INSTAGRAM_APP);
    }

    if INSTAGRAM_WAITING_TO_SHOW.load(Ordering::Acquire) {
      emit_instagram_status(&app_handle, "loading", None);
    } else {
      webview
        .show()
        .map_err(|error| format!("Failed to show Instagram: {error}"))?;
      if !crate::should_avoid_foreground() {
        webview
          .set_focus()
          .map_err(|error| format!("Failed to focus Instagram: {error}"))?;
      }
    }

    match action.as_str() {
      "back" => webview.eval("window.history.back()"),
      "forward" => webview.eval("window.history.forward()"),
      "reload" => webview.reload(),
      "home" | "login" => webview.navigate(parse_instagram_home_url()?),
      _ => return Err(format!("Unknown Instagram navigation action: {action}")),
    }
    .map_err(|error| format!("Failed to navigate Instagram: {error}"))
  })();

  if let Err(message) = &result {
    emit_instagram_error(&app_handle, message.clone());
  }

  result
}

#[tauri::command]
pub fn multi_open_external(app_handle: AppHandle, url: String) -> Result<(), String> {
  use tauri_plugin_shell::ShellExt;

  let url = validate_remote_url(&url)?;
  #[allow(deprecated)]
  app_handle
    .shell()
    .open(url.as_str(), None)
    .map_err(|error| format!("Failed to open external URL: {error}"))
}

fn activate_x(app_handle: &AppHandle, requested_bounds: Option<AppBounds>) -> Result<(), String> {
  let main_window = app_handle
    .get_window("main")
    .ok_or_else(|| "Main window not found".to_string())?;
  if let Err(error) = main_window.set_theme(Some(crate::native_theme::window_theme())) {
    eprintln!("[MultiApp] Failed to set the native window theme: {error}");
  }
  let requested_bounds = requested_bounds
    .or_else(get_x_bounds)
    .unwrap_or(default_x_bounds());
  let bounds = resolve_x_bounds(&main_window, requested_bounds)?;
  let was_active = get_active_app() == X_APP;

  if let Some(ig_webview) = app_handle.get_webview(INSTAGRAM_WEBVIEW_LABEL) {
    set_media_active(&ig_webview, false);
    let _ = ig_webview.hide();
  }

  if let Some(webview) = app_handle.get_webview(X_WEBVIEW_LABEL) {
    apply_webview_bounds(app_handle, X_WEBVIEW_LABEL, bounds)?;
    if get_x_load_state() == "auth-required" {
      emit_x_status(app_handle, "auth-required", None);
    } else if get_x_load_state() == "error" || is_browser_error_document(&webview) {
      begin_service_load(app_handle, X_APP);
      webview
        .reload()
        .map_err(|error| format!("Failed to reload X: {error}"))?;
    } else if X_WAITING_TO_SHOW.load(Ordering::Acquire) {
      emit_x_status(app_handle, "loading", None);
    } else {
      webview
        .show()
        .map_err(|error| format!("Failed to show X: {error}"))?;
      if !crate::should_avoid_foreground() {
        if let Err(error) = webview.set_focus() {
          if !was_active {
            let _ = webview.hide();
          }
          return Err(format!("Failed to focus X: {error}"));
        }
      }

      emit_x_status(app_handle, get_x_load_state(), None);
    }
  } else {
    create_x_webview(app_handle, &main_window, bounds, false)?;
  }

  store_x_bounds(bounds);
  store_active_app(X_APP);
  if let Some(webview) = app_handle.get_webview(X_WEBVIEW_LABEL) {
    let visible = CONTENT_VISIBLE.load(Ordering::Acquire) && !has_social_overlay()
      && !X_WAITING_TO_SHOW.load(Ordering::Acquire) && get_x_load_state() != "auth-required";
    set_media_active(&webview, visible);
    if !visible { let _ = webview.hide(); }
  }
  Ok(())
}

fn activate_instagram(
  app_handle: &AppHandle,
  requested_bounds: Option<AppBounds>,
) -> Result<(), String> {
  let main_window = app_handle
    .get_window("main")
    .ok_or_else(|| "Main window not found".to_string())?;
  if let Err(error) = main_window.set_theme(Some(crate::native_theme::window_theme())) {
    eprintln!("[MultiApp] Failed to set the native window theme: {error}");
  }
  let requested_bounds = requested_bounds
    .or_else(get_x_bounds)
    .unwrap_or(default_x_bounds());
  let bounds = resolve_x_bounds(&main_window, requested_bounds)?;
  let was_active = get_active_app() == INSTAGRAM_APP;

  if let Some(x_webview) = app_handle.get_webview(X_WEBVIEW_LABEL) {
    set_media_active(&x_webview, false);
    let _ = x_webview.hide();
  }

  if let Some(webview) = app_handle.get_webview(INSTAGRAM_WEBVIEW_LABEL) {
    apply_webview_bounds(app_handle, INSTAGRAM_WEBVIEW_LABEL, bounds)?;
    if get_instagram_load_state() == "error" || is_browser_error_document(&webview) {
      begin_service_load(app_handle, INSTAGRAM_APP);
      webview
        .reload()
        .map_err(|error| format!("Failed to reload Instagram: {error}"))?;
    } else if INSTAGRAM_WAITING_TO_SHOW.load(Ordering::Acquire) {
      emit_instagram_status(app_handle, "loading", None);
    } else {
      webview
        .show()
        .map_err(|error| format!("Failed to show Instagram: {error}"))?;
      if !crate::should_avoid_foreground() {
        if let Err(error) = webview.set_focus() {
          if !was_active {
            let _ = webview.hide();
          }
          return Err(format!("Failed to focus Instagram: {error}"));
        }
      }

      emit_instagram_status(app_handle, get_instagram_load_state(), None);
    }
  } else {
    create_instagram_webview(app_handle, &main_window, bounds, false)?;
  }

  store_x_bounds(bounds);
  store_active_app(INSTAGRAM_APP);
  if let Some(webview) = app_handle.get_webview(INSTAGRAM_WEBVIEW_LABEL) {
    let visible = CONTENT_VISIBLE.load(Ordering::Acquire) && !has_social_overlay()
      && !INSTAGRAM_WAITING_TO_SHOW.load(Ordering::Acquire);
    set_media_active(&webview, visible);
    if !visible { let _ = webview.hide(); }
  }
  Ok(())
}

fn activate_telegram(app_handle: &AppHandle) -> Result<(), String> {
  let main_window = app_handle
    .get_window("main")
    .ok_or_else(|| "Main window not found".to_string())?;

  if let Some(webview) = app_handle.get_webview(X_WEBVIEW_LABEL) {
    set_media_active(&webview, false);
    let _ = webview.hide();
  }
  if let Some(ig_webview) = app_handle.get_webview(INSTAGRAM_WEBVIEW_LABEL) {
    set_media_active(&ig_webview, false);
    let _ = ig_webview.hide();
  }

  if !crate::should_avoid_foreground() {
    main_window
      .set_focus()
      .map_err(|error| format!("Failed to focus Telegram: {error}"))?;
  }

  store_active_app(TELEGRAM_APP);
  Ok(())
}

fn get_service_label(service: &str) -> &'static str {
  if service == X_APP { X_WEBVIEW_LABEL } else { INSTAGRAM_WEBVIEW_LABEL }
}

fn get_service_waiting_flag(service: &str) -> &'static AtomicBool {
  if service == X_APP { &X_WAITING_TO_SHOW } else { &INSTAGRAM_WAITING_TO_SHOW }
}

fn get_service_load_state(service: &str) -> &'static str {
  if service == X_APP { get_x_load_state() } else { get_instagram_load_state() }
}

fn emit_service_status(app_handle: &AppHandle, service: &str, state: &'static str) {
  if service == X_APP { emit_x_status(app_handle, state, None); }
  else { emit_instagram_status(app_handle, state, None); }
}

fn get_service_watchdog(service: &str) -> &'static ServiceLoadWatchdog {
  if service == X_APP { &X_LOAD_WATCHDOG } else { &INSTAGRAM_LOAD_WATCHDOG }
}

fn begin_service_load(app_handle: &AppHandle, service: &'static str) {
  let watchdog = get_service_watchdog(service);
  watchdog.worker.call_once(|| {
    let app = app_handle.clone();
    std::thread::spawn(move || watch_service_load(&app, service));
  });
  {
    let mut state = watchdog.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    state.generation = state.generation.wrapping_add(1);
    state.expires_at = Some(Instant::now() + SERVICE_LOAD_TIMEOUT);
  }
  watchdog.changed.notify_one();
  get_service_waiting_flag(service).store(true, Ordering::Release);
  if let Some(webview) = app_handle.get_webview(get_service_label(service)) {
    set_media_active(&webview, false);
    let _ = webview.hide();
  }
  emit_service_status(app_handle, service, "loading");
}

fn cancel_service_load_deadline(service: &str) {
  let watchdog = get_service_watchdog(service);
  {
    let mut state = watchdog.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    state.generation = state.generation.wrapping_add(1);
    state.expires_at = None;
  }
  watchdog.changed.notify_one();
}

fn watch_service_load(app_handle: &AppHandle, service: &'static str) {
  let watchdog = get_service_watchdog(service);
  loop {
    let mut state = watchdog.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let Some(expires_at) = state.expires_at else {
      drop(watchdog.changed.wait(state).unwrap_or_else(|poisoned| poisoned.into_inner()));
      continue;
    };
    let remaining = expires_at.saturating_duration_since(Instant::now());
    if !remaining.is_zero() {
      drop(watchdog.changed.wait_timeout(state, remaining).unwrap_or_else(|poisoned| poisoned.into_inner()));
      continue;
    }
    let generation = state.generation;
    state.expires_at = None;
    drop(state);
    let app = app_handle.clone();
    let _ = app_handle.run_on_main_thread(move || {
      let state = get_service_watchdog(service).state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
      if state.generation != generation || state.expires_at.is_some() {
        return;
      }
      drop(state);
      if get_service_load_state(service) != "loading" {
        return;
      }
      if let Some(webview) = app.get_webview(get_service_label(service)) {
        let _ = webview.eval("window.__egoistRelayStopReadyProbe?.(); window.stop();");
      }
      emit_service_error(&app, service, "The service did not become ready within 45 seconds".to_string());
    });
  }
}

fn complete_service_load(app_handle: &AppHandle, service: &str) {
  if get_service_load_state(service) != "loading" {
    return;
  }
  cancel_service_load_deadline(service);
  get_service_waiting_flag(service).store(false, Ordering::Release);
  if let Some(webview) = app_handle.get_webview(get_service_label(service)) {
    let is_active = get_active_app() == service && !has_social_overlay() && CONTENT_VISIBLE.load(Ordering::Acquire);
    if is_active {
      let result = webview.show().and_then(|_| {
        if crate::should_avoid_foreground() { Ok(()) } else { webview.set_focus() }
      });
      if let Err(error) = result {
        emit_service_error(app_handle, service, format!("Failed to restore the service: {error}"));
        return;
      }
    }
    set_media_active(&webview, is_active);
  }
  emit_service_status(app_handle, service, "ready");
}

#[cfg(windows)]
fn create_service_ready_script(token: &str) -> String {
  let token = serde_json::to_string(token).expect("The readiness token is serializable");
  format!(r#"(function () {{
    if (window.top !== window || window.location.protocol !== 'https:') return;
    const token = {token};
    let generation;
    let hasReported = false;
    let hasStopped = false;
    let timer;
    const observer = new MutationObserver(scheduleProbe);
    function probeReady(nextGeneration) {{
      if (nextGeneration !== undefined) {{ generation = nextGeneration; hasReported = false; }}
      if (hasStopped || generation === undefined || hasReported || !document.body) return;
      const controls = document.querySelectorAll('button, input:not([type="hidden"]), textarea, [role="button"], nav a[href], [role="navigation"] a[href]');
      const hasVisibleControl = Array.from(controls).some((control) => {{
        if (control.disabled || control.getAttribute('aria-disabled') === 'true') return false;
        const bounds = control.getBoundingClientRect();
        if (bounds.width <= 0 || bounds.height <= 0 || bounds.bottom <= 0 || bounds.top >= window.innerHeight
          || bounds.right <= 0 || bounds.left >= window.innerWidth) return false;
        const style = getComputedStyle(control);
        return style.visibility === 'visible' && style.display !== 'none' && style.opacity !== '0';
      }});
      if (!hasVisibleControl) return;
      hasReported = true;
      window.chrome?.webview?.postMessage(token + ':' + generation);
    }}
    function scheduleProbe() {{
      if (hasStopped || timer !== undefined || hasReported || generation === undefined) return;
      timer = setTimeout(() => {{ timer = undefined; probeReady(); }}, 50);
    }}
    function stopProbe() {{
      hasStopped = true;
      observer.disconnect();
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    }}
    window.__egoistRelayProbeReady = probeReady;
    window.__egoistRelayStopReadyProbe = stopProbe;
    function startProbe() {{
      if (hasStopped || !document.documentElement) return;
      observer.observe(document.documentElement, {{ childList: true, subtree: true, attributes: true,
        attributeFilter: ['class', 'style', 'hidden', 'disabled', 'aria-disabled'] }});
      scheduleProbe();
    }}
    if (document.readyState === 'loading') {{
      document.addEventListener('DOMContentLoaded', startProbe, {{ once: true }});
    }} else {{ startProbe(); }}
    window.addEventListener('pagehide', stopProbe);
    window.addEventListener('pageshow', (event) => {{
      if (!event.persisted) return;
      hasStopped = false;
      hasReported = false;
      startProbe();
    }});
  }})();"#)
}

#[cfg(windows)]
fn install_service_load_observers(
  webview: &tauri::Webview,
  service: &'static str,
  ready_token: String,
) -> Result<(), String> {
  use std::sync::Arc;
  use windows_core::Interface;
  use webview2_com::{
    Microsoft::Web::WebView2::Win32::{
      COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED,
      COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED,
      COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE,
      COREWEBVIEW2_WEB_ERROR_STATUS_OPERATION_CANCELED,
      ICoreWebView2_2,
    },
    DOMContentLoadedEventHandler, NavigationCompletedEventHandler, NavigationStartingEventHandler,
    ProcessFailedEventHandler, WebMessageReceivedEventHandler,
  };
  let app = webview.app_handle().clone();
  webview.with_webview(move |platform| {
    let install = || -> windows_core::Result<()> {
      unsafe {
        let core = platform.controller().CoreWebView2()?;
        let navigation_id = Arc::new(AtomicU64::new(0));
        let has_loaded_document = Arc::new(AtomicBool::new(false));
        let starting_id = navigation_id.clone();
        let starting_loaded = has_loaded_document.clone();
        let starting_app = app.clone();
        let mut registration = 0;
        core.add_NavigationStarting(&NavigationStartingEventHandler::create(Box::new(move |_, args| {
          let Some(args) = args else { return Ok(()); };
          let mut is_cancelled = false.into();
          args.Cancel(&mut is_cancelled)?;
          if is_cancelled.as_bool() { return Ok(()); }
          let mut next_id = 0;
          args.NavigationId(&mut next_id)?;
          starting_loaded.store(false, Ordering::Release);
          if starting_id.swap(next_id, Ordering::AcqRel) != next_id {
            begin_service_load(&starting_app, service);
          }
          Ok(())
        })), &mut registration)?;
        if let Ok(core_with_dom) = core.cast::<ICoreWebView2_2>() {
          let dom_id = navigation_id.clone();
          let dom_loaded = has_loaded_document.clone();
          let dom_app = app.clone();
          core_with_dom.add_DOMContentLoaded(&DOMContentLoadedEventHandler::create(Box::new(move |sender, args| {
            let (Some(sender), Some(args)) = (sender, args) else { return Ok(()); };
            let mut document_id = 0;
            args.NavigationId(&mut document_id)?;
            if document_id == 0 || document_id != dom_id.load(Ordering::Acquire)
              || get_service_load_state(service) != "loading" { return Ok(()); }
            let mut source = windows_core::PWSTR::null();
            sender.Source(&mut source)?;
            let source = webview2_com::take_pwstr(source);
            if !Url::parse(&source).is_ok_and(|url| url.scheme() == "https" && is_service_internal_url(service, &url)) {
              return Ok(());
            }
            dom_loaded.store(true, Ordering::Release);
            if let Some(webview) = dom_app.get_webview(get_service_label(service)) {
              let _ = webview.eval(&format!("window.__egoistRelayProbeReady?.('{document_id}');"));
            }
            Ok(())
          })), &mut registration)?;
        }
        let completed_id = navigation_id.clone();
        let completed_loaded = has_loaded_document.clone();
        let completed_app = app.clone();
        core.add_NavigationCompleted(&NavigationCompletedEventHandler::create(Box::new(move |_, args| {
          let Some(args) = args else { return Ok(()); };
          let mut finished_id = 0;
          args.NavigationId(&mut finished_id)?;
          let current_id = completed_id.load(Ordering::Acquire);
          if current_id != 0 && current_id != finished_id { return Ok(()); }
          let mut is_success = false.into();
          args.IsSuccess(&mut is_success)?;
          if !is_success.as_bool() {
            let mut error_status = Default::default();
            args.WebErrorStatus(&mut error_status)?;
            if error_status != COREWEBVIEW2_WEB_ERROR_STATUS_OPERATION_CANCELED {
              emit_service_error(&completed_app, service, format!("The service navigation failed: {error_status:?}"));
            }
            return Ok(());
          }
          if get_service_load_state(service) != "loading" { return Ok(()); }
          completed_id.store(finished_id, Ordering::Release);
          completed_loaded.store(true, Ordering::Release);
          if let Some(webview) = completed_app.get_webview(get_service_label(service)) {
            let _ = webview.eval(&format!("window.__egoistRelayProbeReady?.('{finished_id}');"));
          }
          Ok(())
        })), &mut registration)?;
        let ready_app = app.clone();
        core.add_WebMessageReceived(&WebMessageReceivedEventHandler::create(Box::new(move |sender, args| {
          let (Some(sender), Some(args)) = (sender, args) else { return Ok(()); };
          if !has_loaded_document.load(Ordering::Acquire) || get_service_load_state(service) != "loading" {
            return Ok(());
          }
          let mut message = windows_core::PWSTR::null();
          if args.TryGetWebMessageAsString(&mut message).is_err() { return Ok(()); }
          let message = webview2_com::take_pwstr(message);
          if message != format!("{ready_token}:{}", navigation_id.load(Ordering::Acquire)) { return Ok(()); }
          let mut source = windows_core::PWSTR::null();
          args.Source(&mut source)?;
          let source = webview2_com::take_pwstr(source);
          if !Url::parse(&source).is_ok_and(|url| url.scheme() == "https" && is_service_internal_url(service, &url)) {
            return Ok(());
          }
          let mut current_source = windows_core::PWSTR::null();
          sender.Source(&mut current_source)?;
          if source != webview2_com::take_pwstr(current_source) { return Ok(()); }
          if let Some(webview) = ready_app.get_webview(get_service_label(service)) {
            let _ = webview.eval("window.__egoistRelayStopReadyProbe?.();");
          }
          complete_service_load(&ready_app, service);
          Ok(())
        })), &mut registration)?;
        let failed_app = app.clone();
        core.add_ProcessFailed(&ProcessFailedEventHandler::create(Box::new(move |_, args| {
          let Some(args) = args else { return Ok(()); };
          let mut kind = Default::default();
          args.ProcessFailedKind(&mut kind)?;
          if matches!(kind, COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED
            | COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED
            | COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE) {
            emit_service_error(&failed_app, service, "The service browser process stopped responding".to_string());
            if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED {
              if let Some(webview) = failed_app.get_webview(get_service_label(service)) { let _ = webview.close(); }
            }
          }
          Ok(())
        })), &mut registration)?;
      }
      Ok(())
    };
    if let Err(error) = install() {
      emit_service_error(&app, service, format!("Failed to monitor the service browser: {error}"));
    }
  }).map_err(|error| format!("Failed to attach the service load monitor: {error}"))
}

fn is_browser_error_document(webview: &tauri::Webview) -> bool {
  webview
    .url()
    .is_ok_and(|url| url.scheme() == "chrome-error" && url.host_str() == Some("chromewebdata"))
}

fn is_x_internal_url(url: &Url) -> bool {
  if url.as_str() == "about:blank" {
    return true;
  }
  if url.scheme() == "blob" {
    return Url::parse(url.path()).is_ok_and(|origin| is_x_internal_url(&origin));
  }
  if validate_remote_url(url.as_str()).is_err() || url.port_or_known_default() != Some(443) {
    return false;
  }
  let Some(host) = url.host_str() else {
    return false;
  };
  let host = host.to_ascii_lowercase();
  host == "x.com"
    || host.ends_with(".x.com")
    || host == "twitter.com"
    || host.ends_with(".twitter.com")
    || host == "t.co"
    || host.ends_with(".t.co")
    || host == "twimg.com"
    || host.ends_with(".twimg.com")
    || host == "appleid.apple.com"
    || host == "arkoselabs.com"
    || host.ends_with(".arkoselabs.com")
    || host == "recaptcha.net"
    || host.ends_with(".recaptcha.net")
    || host == "x.ai"
    || host.ends_with(".x.ai")
    || host == "grok.com"
    || host.ends_with(".grok.com")
    || host == "auth0.com"
    || host.ends_with(".auth0.com")
}

fn create_x_webview(
  app_handle: &AppHandle,
  main_window: &tauri::Window,
  bounds: AppBounds,
  start_hidden: bool,
) -> Result<(), String> {
  let navigation_app = app_handle.clone();
  let new_window_app = app_handle.clone();
  let x_data_dir = get_service_data_directory(app_handle, X_APP)?;
  std::fs::create_dir_all(&x_data_dir)
    .map_err(|error| format!("Failed to create the X profile: {error}"))?;
  let share_token = uuid::Uuid::new_v4().to_string();
  #[cfg(windows)]
  let ready_token = uuid::Uuid::new_v4().to_string();
  begin_service_load(app_handle, X_APP);

  let webview_builder =
    WebviewBuilder::new(X_WEBVIEW_LABEL, WebviewUrl::External(parse_initial_service_url(X_APP)?))
      .focused(false)
      .data_directory(x_data_dir)
      .background_color(crate::native_theme::background_color())
      .disable_drag_drop_handler()
      .on_download(|webview, event| handle_download(&webview, X_APP, event))
      .initialization_script(&crate::social_share::create_enhancer_script(X_ENHANCER_SCRIPT, &share_token, X_APP));

  let webview_builder = apply_service_network_profile(webview_builder, X_APP);
  #[cfg(windows)]
  let webview_builder = webview_builder.initialization_script(&create_service_ready_script(&ready_token));

  let webview_builder = webview_builder
    .on_new_window(move |url, features| {
      create_service_auth_window(&new_window_app, X_APP, url, features)
    })
    .on_navigation(move |url| {
      if crate::social_share::intercept_navigation(&navigation_app, X_APP, &share_token, url) { return false; }
      if is_google_sign_in(url) {
        show_direct_login_help(&navigation_app);
        return false;
      }
      if is_x_internal_url(url) {
        return true;
      }
      if validate_remote_url(url.as_str()).is_ok() {
        use tauri_plugin_shell::ShellExt;
        #[allow(deprecated)]
        let _ = navigation_app.shell().open(url.as_str(), None);
        return false;
      }
      false
    });
  #[cfg(not(windows))]
  let webview_builder = webview_builder.on_page_load(|webview, payload| {
      if get_x_load_state() == "auth-required" {
        return;
      }
      match payload.event() {
        PageLoadEvent::Started => begin_service_load(webview.app_handle(), X_APP),
        PageLoadEvent::Finished => {
          if is_browser_error_document(&webview) {
            emit_x_error(webview.app_handle(), "X page could not load".to_string());
            return;
          }
          complete_service_load(webview.app_handle(), X_APP);
        }
      }
    });

  let position = LogicalPosition::new(bounds.x as f64, bounds.y as f64);
  let size = LogicalSize::new(bounds.width as f64, bounds.height as f64);
  eprintln!("[MultiApp] Creating X webview with bounds: {:?}", bounds);
  let webview = match main_window.add_child(webview_builder, position, size) {
    Ok(wv) => {
      eprintln!("[MultiApp] Successfully created X webview!");
      wv
    }
    Err(err) => {
      eprintln!("[MultiApp] ERROR: Failed to add_child X webview: {err}");
      return Err(format!("Failed to create X webview: {err}"));
    }
  };

  #[cfg(windows)]
  {
    downloads::install(&webview, X_APP)?;
    install_service_load_observers(&webview, X_APP, ready_token)?;
    webview.navigate(parse_x_home_url()?)
      .map_err(|error| format!("Failed to start loading X: {error}"))?;
  }

  if start_hidden || X_WAITING_TO_SHOW.load(Ordering::Acquire) || !CONTENT_VISIBLE.load(Ordering::Acquire) {
    let _ = webview.hide();
  } else {
    webview.show().map_err(|error| {
      let _ = webview.hide();
      format!("Failed to show X: {error}")
    })?;
    if !crate::should_avoid_foreground() {
      webview.set_focus().map_err(|error| {
        let _ = webview.hide();
        format!("Failed to focus X: {error}")
      })?;
    }
  }

  Ok(())
}

fn create_service_auth_window(
  app_handle: &AppHandle,
  service: &'static str,
  url: Url,
  features: NewWindowFeatures,
) -> NewWindowResponse<tauri::Wry> {
  if service == X_APP && is_google_sign_in(&url) {
    show_direct_login_help(app_handle);
    return NewWindowResponse::Deny;
  }
  if !is_service_internal_url(service, &url) {
    open_external_navigation(app_handle, &url);
    return NewWindowResponse::Deny;
  }

  let label_prefix = if service == X_APP {
    X_AUTH_WINDOW_LABEL_PREFIX
  } else {
    "instagram-auth"
  };
  let label = format!(
    "{label_prefix}-{}",
    X_AUTH_WINDOW_SEQUENCE.fetch_add(1, Ordering::Relaxed)
  );
  let popup_navigation_app = app_handle.clone();
  let popup_label = label.clone();
  let nested_popup_app = app_handle.clone();
  let data_dir = match get_service_data_directory(app_handle, service) {
    Ok(path) => path,
    Err(error) => {
      log::error!("Failed to locate the {service} sign-in profile: {error}");
      return NewWindowResponse::Deny;
    }
  };
  if let Err(error) = std::fs::create_dir_all(&data_dir) {
    log::error!("Failed to create the {service} sign-in profile: {error}");
    return NewWindowResponse::Deny;
  }
  let builder = WebviewWindowBuilder::new(
    app_handle,
    label,
    WebviewUrl::External(Url::parse("about:blank").expect("about:blank must be a valid URL")),
  )
  .data_directory(data_dir)
  .disable_drag_drop_handler()
  .on_download(move |webview, event| handle_download(&webview, service, event));

  #[cfg(windows)]
  let builder = if service == X_APP {
    builder.additional_browser_args(X_SERVICE_BROWSER_ARGUMENTS)
  } else {
    builder
  };

  let builder = builder
    .title(if service == X_APP {
      X_AUTH_WINDOW_TITLE
    } else {
      "Instagram — Sign in"
    })
    .inner_size(X_AUTH_WINDOW_WIDTH, X_AUTH_WINDOW_HEIGHT)
    .min_inner_size(X_AUTH_WINDOW_MIN_WIDTH, X_AUTH_WINDOW_MIN_HEIGHT)
    .resizable(true)
    .theme(Some(crate::native_theme::window_theme()))
    .background_color(crate::native_theme::background_color())
    .visible(!crate::should_avoid_foreground())
    .focused(!crate::should_avoid_foreground())
    .window_features(features)
    .on_new_window(move |nested_url, nested_features| {
      create_service_auth_window(&nested_popup_app, service, nested_url, nested_features)
    })
    .on_navigation(move |popup_url| {
      if service == X_APP && is_google_sign_in(popup_url) {
        show_direct_login_help(&popup_navigation_app);
        if let Some(popup) = popup_navigation_app.get_window(&popup_label) {
          let _ = popup.close();
        }
        return false;
      }
      if is_service_internal_url(service, popup_url) {
        return true;
      }

      open_external_navigation(&popup_navigation_app, popup_url);
      false
    });

  let main_window = match app_handle.get_window("main") {
    Some(main_window) => main_window,
    None => {
      emit_service_error(
        app_handle,
        service,
        "Main window not found while opening sign-in".to_string(),
      );
      return NewWindowResponse::Deny;
    }
  };

  #[cfg(windows)]
  let builder = match main_window.hwnd() {
    Ok(owner) => builder.owner_raw(owner),
    Err(error) => {
      emit_service_error(
        app_handle,
        service,
        format!("Failed to attach the sign-in window: {error}"),
      );
      return NewWindowResponse::Deny;
    }
  };

  #[cfg(target_os = "macos")]
  let builder = match main_window.ns_window() {
    Ok(parent) => builder.parent_raw(parent),
    Err(error) => {
      emit_service_error(
        app_handle,
        service,
        format!("Failed to attach the sign-in window: {error}"),
      );
      return NewWindowResponse::Deny;
    }
  };

  #[cfg(any(
    target_os = "linux",
    target_os = "dragonfly",
    target_os = "freebsd",
    target_os = "netbsd",
    target_os = "openbsd"
  ))]
  let builder = match main_window.gtk_window() {
    Ok(parent) => builder.transient_for_raw(&parent),
    Err(error) => {
      emit_service_error(
        app_handle,
        service,
        format!("Failed to attach the sign-in window: {error}"),
      );
      return NewWindowResponse::Deny;
    }
  };

  match builder.build() {
    Ok(window) => {
      if let Err(error) = downloads::install(window.as_ref(), service) {
        log::warn!("[Media] Sign-in WebView download hooks unavailable: {error}");
      }
      NewWindowResponse::Create { window }
    },
    Err(error) => {
      emit_service_error(
        app_handle,
        service,
        format!("Failed to open the sign-in window: {error}"),
      );
      NewWindowResponse::Deny
    }
  }
}

fn apply_webview_bounds(
  app_handle: &AppHandle,
  label: &str,
  bounds: AppBounds,
) -> Result<(), String> {
  let webview = app_handle
    .get_webview(label)
    .ok_or_else(|| format!("{label} webview is not available"))?;
  let bounds = Rect {
    position: Position::Logical(LogicalPosition::new(bounds.x as f64, bounds.y as f64)),
    size: Size::Logical(LogicalSize::new(bounds.width as f64, bounds.height as f64)),
  };

  webview
    .set_bounds(bounds)
    .map_err(|error| format!("Failed to resize {label}: {error}"))
}

fn resolve_x_bounds(
  main_window: &tauri::Window,
  requested: AppBounds,
) -> Result<AppBounds, String> {
  if requested.x < 0 || requested.y < 0 {
    return Err("X bounds position must be non-negative".to_string());
  }
  if requested.width <= 0 || requested.height <= 0 {
    return Err("X bounds size must be positive".to_string());
  }

  let physical_size = main_window
    .inner_size()
    .map_err(|error| format!("Failed to read main window size: {error}"))?;
  let scale_factor = main_window
    .scale_factor()
    .map_err(|error| format!("Failed to read main window scale: {error}"))?;
  if !scale_factor.is_finite() || scale_factor <= 0.0 {
    return Err("Main window scale is invalid".to_string());
  }

  let window_width = (physical_size.width as f64 / scale_factor).floor() as i32;
  let window_height = (physical_size.height as f64 / scale_factor).floor() as i32;
  if requested.x >= window_width || requested.y >= window_height {
    return Err("X bounds start outside the main window".to_string());
  }

  Ok(AppBounds {
    x: requested.x,
    y: requested.y,
    width: requested.width.min(window_width - requested.x),
    height: requested.height.min(window_height - requested.y),
  })
}

fn validate_remote_url(value: &str) -> Result<Url, String> {
  let url = Url::parse(value).map_err(|_| "Invalid URL".to_string())?;
  if url.scheme() != "https" {
    return Err("Only HTTPS remote navigation is allowed".to_string());
  }
  if !url.username().is_empty() || url.password().is_some() {
    return Err("URLs with embedded credentials are not allowed".to_string());
  }

  match url.host() {
    Some(Host::Domain(host)) if !is_local_domain(host) => Ok(url),
    Some(Host::Ipv4(address)) if is_public_ipv4(address) => Ok(url),
    Some(Host::Ipv6(address))
      if !address.is_loopback()
        && !address.is_unique_local()
        && !address.is_unicast_link_local()
        && !address.is_unspecified()
        && !address.is_multicast()
        && address.to_ipv4().is_none_or(is_public_ipv4) =>
    {
      Ok(url)
    }
    Some(_) => Err("Local network navigation is not allowed".to_string()),
    None => Err("URL host is missing".to_string()),
  }
}

fn is_public_ipv4(address: std::net::Ipv4Addr) -> bool {
  !address.is_private()
    && !address.is_loopback()
    && !address.is_link_local()
    && !address.is_unspecified()
    && !address.is_broadcast()
    && !address.is_multicast()
    && address.octets()[0] != 0
    && address.octets()[0] < 240
}

fn is_service_internal_url(service: &str, url: &Url) -> bool {
  if service == X_APP {
    is_x_internal_url(url)
  } else {
    is_instagram_internal_url(url)
  }
}

fn open_external_navigation(app_handle: &AppHandle, url: &Url) {
  if validate_remote_url(url.as_str()).is_err() {
    return;
  }
  use tauri_plugin_shell::ShellExt;
  #[allow(deprecated)]
  if let Err(error) = app_handle.shell().open(url.as_str(), None) {
    log::error!("Failed to open an external link: {error}");
  }
}

fn set_media_active(webview: &tauri::Webview, is_active: bool) {
  let script = format!(
    "if (typeof window.__egoistRelaySetActive === 'function') window.__egoistRelaySetActive({is_active});"
  );
  if let Err(error) = webview.eval(script) {
    log::debug!(
      "Failed to update media visibility in {}: {error}",
      webview.label()
    );
  }
}

pub(crate) fn handle_download(webview: &tauri::Webview, service: &str, event: DownloadEvent<'_>) -> bool {
  match event {
    DownloadEvent::Requested { url, destination } => {
      if let Err(error) = downloads::request(webview, service, &url, destination) {
        log::warn!("[Media] Native download request rejected: {error}");
        return false;
      }
      if is_smoke_test() && url.as_str() == SMOKE_CANCEL_DOWNLOAD_URL {
        if let Some(mut payload) = downloads::finish(webview, service, &url, Some(destination), false) {
          payload["smokeCanceled"] = serde_json::json!(true);
          let _ = webview.app_handle().emit_to("main", "download-finished", payload);
        }
        return false;
      }
    }
    DownloadEvent::Finished { url, path, success } => {
      if let Some(payload) = downloads::finish(webview, service, &url, path.as_deref(), success) {
        if let Err(error) = webview.app_handle().emit_to("main", "download-finished", payload) {
          log::error!("Failed to report the {service} download result: {error}");
        }
      }
    }
    _ => {}
  }
  true
}

pub(crate) fn smoke_download_directory() -> Option<PathBuf> {
  if !is_smoke_test() {
    return None;
  }
  let profile = PathBuf::from(std::env::var_os("EGOIST_RELAY_TEST_PROFILE")?);
  if !profile.is_absolute() || !profile.is_dir() {
    return None;
  }
  let directory = profile.join("downloads");
  let profile_metadata = std::fs::symlink_metadata(&profile).ok()?;
  let directory_metadata = std::fs::symlink_metadata(&directory).ok()?;
  if profile_metadata.file_type().is_symlink()
    || directory_metadata.file_type().is_symlink()
    || !directory_metadata.is_dir()
  {
    return None;
  }
  let canonical_profile = std::fs::canonicalize(&profile).ok()?;
  let canonical_directory = std::fs::canonicalize(&directory).ok()?;
  if canonical_directory != canonical_profile.join("downloads") {
    return None;
  }
  Some(canonical_directory)
}

pub(crate) fn get_service_data_directory(app_handle: &AppHandle, service: &str) -> Result<PathBuf, String> {
  let root = if is_smoke_test() {
    let profile = std::env::var_os("EGOIST_RELAY_TEST_PROFILE")
      .map(PathBuf::from)
      .ok_or_else(|| "Smoke tests require an isolated EGOIST_RELAY_TEST_PROFILE".to_string())?;
    if !profile.is_absolute() || !profile.is_dir() {
      return Err("The smoke-test profile must be an existing absolute directory".to_string());
    }
    profile
  } else {
    app_handle
      .path()
      .app_local_data_dir()
      .map_err(|error| format!("Failed to locate the service profile: {error}"))?
  };
  Ok(root.join(service))
}

fn emit_service_error(app_handle: &AppHandle, service: &str, message: String) {
  if service == X_APP {
    emit_x_error(app_handle, message);
  } else {
    emit_instagram_error(app_handle, message);
  }
}

fn is_google_sign_in(url: &Url) -> bool {
  url.host_str() == Some("accounts.google.com")
}

fn show_direct_login_help(app_handle: &AppHandle) {
  cancel_service_load_deadline(X_APP);
  X_WAITING_TO_SHOW.store(true, Ordering::Release);
  if let Some(webview) = app_handle.get_webview(X_WEBVIEW_LABEL) {
    set_media_active(&webview, false);
    if let Err(error) = webview.hide() {
      emit_x_error(
        app_handle,
        format!("Failed to show X sign-in help: {error}"),
      );
      return;
    }
  }
  if !crate::should_avoid_foreground() {
    if let Some(main) = app_handle.get_webview("main") {
      let _ = main.set_focus();
    }
  }
  emit_x_status(app_handle, "auth-required", None);
}

fn is_local_domain(host: &str) -> bool {
  let host = host.trim_end_matches('.').to_ascii_lowercase();
  host.eq_ignore_ascii_case("localhost")
    || host.ends_with(".localhost")
    || host.ends_with(".local")
    || host.ends_with(".internal")
    || host.ends_with(".lan")
    || host == "home.arpa"
    || host.ends_with(".home.arpa")
}

fn parse_x_home_url() -> Result<Url, String> {
  Url::parse(X_HOME_URL).map_err(|error| format!("Invalid X home URL: {error}"))
}

fn parse_initial_service_url(service: &str) -> Result<Url, String> {
  #[cfg(windows)]
  {
    let _ = service;
    Url::parse("about:blank").map_err(|error| format!("Invalid initial service URL: {error}"))
  }
  #[cfg(not(windows))]
  {
    if service == X_APP { parse_x_home_url() } else { parse_instagram_home_url() }
  }
}

fn emit_x_status(app_handle: &AppHandle, state: &'static str, message: Option<String>) {
  let previous_state = {
    let mut load_state = X_LOAD_STATE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    std::mem::replace(&mut *load_state, state)
  };
  if previous_state != state && matches!(state, "loading" | "ready" | "error" | "auth-required") {
    log::info!("[MultiApp] UI state: x {state}");
  }

  let payload = ServiceStatusPayload {
    state,
    url: None,
    message,
  };

  if let Err(error) = app_handle.emit_to("main", X_STATUS_EVENT, payload) {
    eprintln!("[MultiApp] Failed to emit X status: {error}");
  }
}

fn emit_x_error(app_handle: &AppHandle, message: String) {
  cancel_service_load_deadline(X_APP);
  X_WAITING_TO_SHOW.store(true, Ordering::Release);
  if let Some(webview) = app_handle.get_webview(X_WEBVIEW_LABEL) {
    set_media_active(&webview, false);
    if let Err(error) = webview.hide() {
      eprintln!("[MultiApp] Failed to hide X after an error: {error}");
    }
  }
  emit_x_status(app_handle, "error", Some(message));
}

fn get_x_load_state() -> &'static str {
  *X_LOAD_STATE
    .lock()
    .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn is_instagram_internal_url(url: &Url) -> bool {
  if url.as_str() == "about:blank" {
    return true;
  }
  if url.scheme() == "blob" {
    return Url::parse(url.path()).is_ok_and(|origin| is_instagram_internal_url(&origin));
  }
  if validate_remote_url(url.as_str()).is_err() || url.port_or_known_default() != Some(443) {
    return false;
  }
  let Some(host) = url.host_str() else {
    return false;
  };
  let host = host.to_ascii_lowercase();
  host == "instagram.com"
    || host.ends_with(".instagram.com")
    || host == "cdninstagram.com"
    || host.ends_with(".cdninstagram.com")
    || host == "meta.com"
    || host.ends_with(".meta.com")
    || ((host == "facebook.com" || host.ends_with(".facebook.com"))
      && is_facebook_auth_path(url.path()))
    || host == "facebook.net"
    || host.ends_with(".facebook.net")
    || host == "meta.ai"
    || host.ends_with(".meta.ai")
    || host == "fbcdn.net"
    || host.ends_with(".fbcdn.net")
    || host == "fbsbx.com"
    || host.ends_with(".fbsbx.com")
    || host == "threads.net"
    || host.ends_with(".threads.net")
    || host == "recaptcha.net"
    || host.ends_with(".recaptcha.net")
    || host == "arkoselabs.com"
    || host.ends_with(".arkoselabs.com")
    || host == "accountkit.com"
    || host.ends_with(".accountkit.com")
}

fn is_facebook_auth_path(path: &str) -> bool {
  let path = path.trim_start_matches('/');
  let path = path.split_once('/').and_then(|(version, remainder)| {
    let (major, minor) = version.strip_prefix('v')?.split_once('.')?;
    if major.is_empty() || minor.is_empty()
      || !major.bytes().all(|value| value.is_ascii_digit())
      || !minor.bytes().all(|value| value.is_ascii_digit()) {
      return None;
    }
    Some(remainder)
  }).unwrap_or(path);
  matches!(path.split('/').next().unwrap_or_default(),
    "login" | "login.php" | "dialog" | "checkpoint" | "recover" | "two_step_verification")
}

fn create_instagram_webview(
  app_handle: &AppHandle,
  main_window: &tauri::Window,
  bounds: AppBounds,
  start_hidden: bool,
) -> Result<(), String> {
  let navigation_app = app_handle.clone();
  let new_window_app = app_handle.clone();
  let ig_data_dir = get_service_data_directory(app_handle, INSTAGRAM_APP)?;
  std::fs::create_dir_all(&ig_data_dir)
    .map_err(|error| format!("Failed to create the Instagram profile: {error}"))?;
  #[cfg(windows)]
  let ready_token = uuid::Uuid::new_v4().to_string();
  begin_service_load(app_handle, INSTAGRAM_APP);

  let webview_builder = WebviewBuilder::new(
    INSTAGRAM_WEBVIEW_LABEL,
    WebviewUrl::External(parse_initial_service_url(INSTAGRAM_APP)?),
  )
  .focused(false)
  .data_directory(ig_data_dir)
  .background_color(crate::native_theme::background_color())
  .disable_drag_drop_handler()
  .on_download(|webview, event| handle_download(&webview, INSTAGRAM_APP, event))
  .initialization_script(INSTAGRAM_ENHANCER_SCRIPT);

  #[cfg(windows)]
  let webview_builder = webview_builder.initialization_script(&create_service_ready_script(&ready_token));

  let webview_builder = webview_builder
    .on_new_window(move |url, features| {
      create_service_auth_window(&new_window_app, INSTAGRAM_APP, url, features)
    })
    .on_navigation(move |url| {
      if is_instagram_internal_url(url) {
        return true;
      }
      if validate_remote_url(url.as_str()).is_ok() {
        use tauri_plugin_shell::ShellExt;
        #[allow(deprecated)]
        let _ = navigation_app.shell().open(url.as_str(), None);
        return false;
      }
      false
    });
  #[cfg(not(windows))]
  let webview_builder = webview_builder.on_page_load(|webview, payload| match payload.event() {
      PageLoadEvent::Started => begin_service_load(webview.app_handle(), INSTAGRAM_APP),
      PageLoadEvent::Finished => {
        if is_browser_error_document(&webview) {
          emit_instagram_error(
            webview.app_handle(),
            "Instagram page could not load".to_string(),
          );
          return;
        }
        complete_service_load(webview.app_handle(), INSTAGRAM_APP);
      }
    });

  let position = LogicalPosition::new(bounds.x as f64, bounds.y as f64);
  let size = LogicalSize::new(bounds.width as f64, bounds.height as f64);
  eprintln!(
    "[MultiApp] Creating Instagram webview with bounds: {:?}",
    bounds
  );
  let webview = match main_window.add_child(webview_builder, position, size) {
    Ok(wv) => {
      eprintln!("[MultiApp] Successfully created Instagram webview!");
      wv
    }
    Err(err) => {
      eprintln!("[MultiApp] ERROR: Failed to add_child Instagram webview: {err}");
      return Err(format!("Failed to create Instagram webview: {err}"));
    }
  };

  #[cfg(windows)]
  {
    downloads::install(&webview, INSTAGRAM_APP)?;
    install_service_load_observers(&webview, INSTAGRAM_APP, ready_token)?;
    webview.navigate(parse_instagram_home_url()?)
      .map_err(|error| format!("Failed to start loading Instagram: {error}"))?;
  }

  if start_hidden || INSTAGRAM_WAITING_TO_SHOW.load(Ordering::Acquire) || !CONTENT_VISIBLE.load(Ordering::Acquire) {
    let _ = webview.hide();
  } else {
    webview.show().map_err(|error| {
      let _ = webview.hide();
      format!("Failed to show Instagram: {error}")
    })?;
    if !crate::should_avoid_foreground() {
      webview.set_focus().map_err(|error| {
        let _ = webview.hide();
        format!("Failed to focus Instagram: {error}")
      })?;
    }
  }

  Ok(())
}

fn parse_instagram_home_url() -> Result<Url, String> {
  Url::parse(INSTAGRAM_HOME_URL).map_err(|error| format!("Invalid Instagram home URL: {error}"))
}

fn emit_instagram_status(app_handle: &AppHandle, state: &'static str, message: Option<String>) {
  let previous_state = {
    let mut load_state = INSTAGRAM_LOAD_STATE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    std::mem::replace(&mut *load_state, state)
  };
  if previous_state != state && matches!(state, "loading" | "ready" | "error" | "auth-required") {
    log::info!("[MultiApp] UI state: instagram {state}");
  }

  let payload = ServiceStatusPayload {
    state,
    url: None,
    message,
  };

  if let Err(error) = app_handle.emit_to("main", INSTAGRAM_STATUS_EVENT, payload) {
    eprintln!("[MultiApp] Failed to emit Instagram status: {error}");
  }
}

fn emit_instagram_error(app_handle: &AppHandle, message: String) {
  cancel_service_load_deadline(INSTAGRAM_APP);
  INSTAGRAM_WAITING_TO_SHOW.store(true, Ordering::Release);
  if let Some(webview) = app_handle.get_webview(INSTAGRAM_WEBVIEW_LABEL) {
    set_media_active(&webview, false);
    if let Err(error) = webview.hide() {
      eprintln!("[MultiApp] Failed to hide Instagram after an error: {error}");
    }
  }
  emit_instagram_status(app_handle, "error", Some(message));
}

fn get_instagram_load_state() -> &'static str {
  *INSTAGRAM_LOAD_STATE
    .lock()
    .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn is_smoke_test() -> bool {
  std::env::var("EGOIST_RELAY_SMOKE_TEST").as_deref() == Ok("1")
}

fn default_x_bounds() -> AppBounds {
  AppBounds {
    x: DEFAULT_SIDEBAR_WIDTH,
    y: DEFAULT_TITLEBAR_HEIGHT,
    width: i32::MAX,
    height: i32::MAX,
  }
}

fn get_x_bounds() -> Option<AppBounds> {
  *CURRENT_X_BOUNDS
    .lock()
    .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn store_x_bounds(bounds: AppBounds) {
  *CURRENT_X_BOUNDS
    .lock()
    .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(bounds);
}

fn store_active_app(app: &str) {
  *ACTIVE_APP
    .lock()
    .unwrap_or_else(|poisoned| poisoned.into_inner()) = app.to_string();
}

