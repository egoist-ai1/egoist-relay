use std::sync::{
  Condvar, LazyLock, Mutex, Once, OnceLock,
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
#[cfg(windows)]
#[path = "multi_app_media_context.rs"]
mod media_context;
#[path = "multi_app_recovery.rs"]
mod recovery;
use recovery::WebviewOpError;
#[path = "multi_app_sleep.rs"]
mod sleep;

const TELEGRAM_APP: &str = "telegram";
const X_APP: &str = "x";
const X_HOME_URL: &str = "https://x.com";
const X_LOGIN_URL: &str = "https://x.com/i/flow/login";
const X_WEBVIEW_LABEL: &str = "x_webview";
const X_AUTH_WINDOW_LABEL_PREFIX: &str = "x-auth";
const X_AUTH_WINDOW_TITLE: &str = "X — Вход";
const X_AUTH_WINDOW_WIDTH: f64 = 560.0;
const X_AUTH_WINDOW_HEIGHT: f64 = 760.0;
const X_AUTH_WINDOW_MIN_WIDTH: f64 = 420.0;
const X_AUTH_WINDOW_MIN_HEIGHT: f64 = 560.0;
const INSTAGRAM_APP: &str = "instagram";
const INSTAGRAM_HOME_URL: &str = "https://www.instagram.com";
const INSTAGRAM_LOGIN_URL: &str = "https://www.instagram.com/accounts/login/";
const INSTAGRAM_WEBVIEW_LABEL: &str = "instagram_webview";
const INSTAGRAM_STATUS_EVENT: &str = "multi-instagram-status";
const DEFAULT_SIDEBAR_WIDTH: i32 = 72;
const DEFAULT_TITLEBAR_HEIGHT: i32 = 40;
const X_STATUS_EVENT: &str = "multi-x-status";
const INSTAGRAM_ENHANCER_SCRIPT: &str = include_str!("../../scripts/instagram-enhancer.js");
const X_ENHANCER_SCRIPT: &str = include_str!("../../scripts/x-enhancer.js");
const SERVICE_LOAD_TIMEOUT: Duration = Duration::from_secs(45);
const X_LOAD_TIMEOUT: Duration = Duration::from_secs(18);
const X_INTERACTIVE_LOAD_TIMEOUT: Duration = Duration::from_secs(35);
/// Аргументы WebView2 для окружения сервиса: значения по умолчанию Wry 0.57.0 (явные аргументы их заменяют),
/// а также автозапуск медиа для X и Instagram.
/// Окружения с одним каталогом данных (профиль, окна входа, research) обязаны получать одинаковую строку,
/// иначе WebView2 вернёт ERROR_INVALID_STATE, поэтому строку везде собирает только эта функция.
#[cfg(windows)]
pub(crate) fn service_browser_arguments(service: &str) -> String {
  let mut arguments = String::from("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection");
  if service == X_APP || service == INSTAGRAM_APP {
    arguments.push_str(" --autoplay-policy=no-user-gesture-required");
  }
  arguments
}

pub(crate) fn apply_service_network_profile<R: tauri::Runtime>(
  builder: WebviewBuilder<R>,
  service: &str,
) -> WebviewBuilder<R> {
  #[cfg(windows)]
  let builder = builder.additional_browser_args(&service_browser_arguments(service));
  #[cfg(not(windows))]
  let _ = service;
  builder
}

struct ServiceLoadDeadline {
  generation: u64,
  expires_at: Option<Instant>,
  waiting_for_x_controls: bool,
}

impl ServiceLoadDeadline {
  #[cfg(windows)]
  fn observe_x_document(&mut self) -> bool {
    let Some(expires_at) = self.expires_at else { return false; };
    if self.waiting_for_x_controls { return false; }
    self.waiting_for_x_controls = true;
    self.expires_at = Some(expires_at + (X_INTERACTIVE_LOAD_TIMEOUT - X_LOAD_TIMEOUT));
    true
  }
}

struct ServiceLoadWatchdog {
  state: Mutex<ServiceLoadDeadline>,
  changed: Condvar,
  worker: Once,
}

impl ServiceLoadWatchdog {
  const fn new() -> Self {
    Self {
      state: Mutex::new(ServiceLoadDeadline { generation: 0, expires_at: None, waiting_for_x_controls: false }),
      changed: Condvar::new(),
      worker: Once::new(),
    }
  }
}

#[derive(serde::Deserialize, serde::Serialize, Debug, Clone, Copy, PartialEq, Eq)]
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

static MAIN_THREAD: OnceLock<std::thread::ThreadId> = OnceLock::new();
static X_RECREATE_LIMITER: Mutex<recovery::RecreateLimiter> = Mutex::new(recovery::RecreateLimiter::new());
static INSTAGRAM_RECREATE_LIMITER: Mutex<recovery::RecreateLimiter> = Mutex::new(recovery::RecreateLimiter::new());
static X_RECOVERING: AtomicBool = AtomicBool::new(false);
static INSTAGRAM_RECOVERING: AtomicBool = AtomicBool::new(false);
static X_AUTO_RETRY: recovery::AutoRetry = recovery::AutoRetry::new();
static INSTAGRAM_AUTO_RETRY: recovery::AutoRetry = recovery::AutoRetry::new();
static X_LOAD_TIMER: recovery::LoadTimer = recovery::LoadTimer::new();
static INSTAGRAM_LOAD_TIMER: recovery::LoadTimer = recovery::LoadTimer::new();
const MAIN_THREAD_TIMEOUT: Duration = Duration::from_secs(3);

/// Запоминает главный поток; вызывается из `setup`, который идёт на нём.
pub fn note_main_thread() {
  let _ = MAIN_THREAD.set(std::thread::current().id());
}

fn is_main_thread() -> bool {
  MAIN_THREAD.get() == Some(&std::thread::current().id())
}

/// Выполняет `f` на главном потоке и возвращает результат. На самом главном потоке `f` вызывается
/// напрямую: ждать собственную очередь нельзя (колбэки WebView2, `on_window_event`). С другого
/// потока ожидание ограничено `MAIN_THREAD_TIMEOUT`; не держите там блокировки, которые нужны главному потоку.
pub(crate) fn run_on_main<T: Send + 'static>(
  app: &AppHandle,
  f: impl FnOnce() -> T + Send + 'static,
) -> Result<T, WebviewOpError> {
  if is_main_thread() {
    return Ok(f());
  }
  let (sender, receiver) = std::sync::mpsc::channel();
  app
    .run_on_main_thread(move || {
      let _ = sender.send(f());
    })
    .map_err(|error| WebviewOpError::Timeout(format!("Main thread is unavailable: {error}")))?;
  receiver
    .recv_timeout(MAIN_THREAD_TIMEOUT)
    .map_err(|_| WebviewOpError::Timeout("Main thread did not respond in time".to_string()))
}

/// Проверка живости контроллера: мёртвый контроллер (0x8007139F) отвечает ошибкой на IsVisible.
#[cfg(windows)]
fn probe_webview(webview: &tauri::Webview) -> Result<(), WebviewOpError> {
  let (sender, receiver) = std::sync::mpsc::channel();
  webview
    .with_webview(move |platform| {
      let controller = platform.controller();
      let result = unsafe {
        let mut visible = windows_core::BOOL(0);
        controller.IsVisible(&mut visible).and_then(|_| controller.CoreWebView2()).map(|_| ())
      };
      let _ = sender.send(result.map_err(|error| WebviewOpError::Dead(error.to_string())));
    })
    .map_err(|error| WebviewOpError::Timeout(error.to_string()))?;
  receiver
    .recv_timeout(Duration::from_secs(2))
    .map_err(|_| WebviewOpError::Timeout("WebView probe timed out".to_string()))?
}

#[cfg(not(windows))]
fn probe_webview(_: &tauri::Webview) -> Result<(), WebviewOpError> {
  Ok(())
}

/// show/hide/navigate идут fire-and-forget и всегда дают Ok; здесь операция выполняется на главном
/// потоке и сразу проверяется состоянием контроллера, поэтому ошибка мёртвого WebView видна вызывающему.
/// Таймаут повторяется один раз; пересоздавать WebView нужно только при `Dead`.
fn webview_op_checked(
  app: &AppHandle,
  label: &'static str,
  op: impl Fn(&tauri::Webview) -> tauri::Result<()> + Clone + Send + 'static,
) -> Result<(), WebviewOpError> {
  recovery::retry_on_timeout(|| {
    let app_for_main = app.clone();
    let op = op.clone();
    run_on_main(app, move || {
      let webview = app_for_main
        .get_webview(label)
        .ok_or_else(|| WebviewOpError::Dead(format!("{label} webview is not available")))?;
      op(&webview).map_err(|error| WebviewOpError::Dead(error.to_string()))?;
      probe_webview(&webview)
    })?
  })
}

fn show_checked(app: &AppHandle, label: &'static str) -> Result<(), WebviewOpError> {
  webview_op_checked(app, label, |webview| {
    if crate::workspace_privacy::allows_native_content() && !has_social_overlay() {
      webview.show()
    } else {
      webview.hide()
    }
  })
}

fn hide_checked(app: &AppHandle, label: &'static str) -> Result<(), WebviewOpError> {
  let app_for_main = app.clone();
  run_on_main(app, move || {
    let Some(webview) = app_for_main.get_webview(label) else { return Ok(()); };
    park_webview(&webview, false)
  })?
}

#[cfg(windows)]
#[link(name = "user32")]
unsafe extern "system" {
  fn GetWindowLongW(hwnd: *mut std::ffi::c_void, index: i32) -> i32;
  fn IsWindow(hwnd: *mut std::ffi::c_void) -> i32;
  fn IsWindowVisible(hwnd: *mut std::ffi::c_void) -> i32;
  fn ShowWindow(hwnd: *mut std::ffi::c_void, command: i32) -> i32;
}

#[cfg(windows)]
pub(crate) unsafe fn hide_native_window_checked(hwnd: *mut std::ffi::c_void) -> bool {
  const GWL_STYLE: i32 = -16;
  const SW_HIDE: i32 = 0;
  const WS_VISIBLE: i32 = 0x10000000;
  if hwnd.is_null() { return false; }
  unsafe {
    if IsWindow(hwnd) == 0 { return true; }
    // IsWindowVisible также возвращает false, когда скрыт только родитель.
    ShowWindow(hwnd, SW_HIDE);
    IsWindow(hwnd) == 0
      || (GetWindowLongW(hwnd, GWL_STYLE) & WS_VISIBLE == 0 && IsWindowVisible(hwnd) == 0)
  }
}

#[cfg(windows)]
fn park_webview(webview: &tauri::Webview, close_on_failure: bool) -> Result<(), WebviewOpError> {
  let (sender, receiver) = std::sync::mpsc::channel();
  webview.with_webview(move |platform| {
    let controller = platform.controller();
    let result = unsafe {
      // Wry 0.57 создаёт дочерний HWND и передаёт его контроллеру как ParentWindow.
      let mut container = Default::default();
      let container_hidden = controller.ParentWindow(&mut container).is_ok()
        && hide_native_window_checked(container.0);
      let mut visible = windows_core::BOOL(1);
      let controller_hidden = controller.SetIsVisible(false).is_ok()
        && controller.IsVisible(&mut visible).is_ok() && !visible.as_bool();
      if container_hidden && controller_hidden {
        Ok(false)
      } else if container_hidden && close_on_failure {
        controller.Close().map(|_| true).map_err(|error| WebviewOpError::Dead(error.to_string()))
      } else {
        Err(WebviewOpError::Dead("WebView hiding could not be verified".to_string()))
      }
    };
    let _ = sender.send(result);
  }).map_err(|error| WebviewOpError::Timeout(error.to_string()))?;
  // На UI-потоке Wry выполняет with_webview синхронно.
  if receiver.try_recv()
    .map_err(|_| WebviewOpError::Timeout("WebView visibility was not confirmed".to_string()))?? {
    let _ = webview.close();
  }
  Ok(())
}

#[cfg(not(windows))]
fn park_webview(webview: &tauri::Webview, close_on_failure: bool) -> Result<(), WebviewOpError> {
  let parked = webview.hide();
  if close_on_failure { parked.or_else(|_| webview.close()) } else { parked }
    .map_err(|error| WebviewOpError::Dead(error.to_string()))
}

pub(crate) fn park_window(window: &tauri::Window) -> bool {
  let _ = window.hide();
  #[cfg(windows)]
  {
    let Ok(hwnd) = window.hwnd() else {
      let _ = window.destroy();
      return false;
    };
    if unsafe { hide_native_window_checked(hwnd.0) } { return true; }
    let _ = window.destroy();
    // Tauri ставит уничтожение в очередь, поэтому подтверждаем результат через Win32.
    unsafe { hide_native_window_checked(hwnd.0) }
  }
  #[cfg(not(windows))]
  {
    if matches!(window.is_visible(), Ok(false)) { return true; }
    let _ = window.destroy();
    matches!(window.is_visible(), Ok(false))
  }
}

fn service_recreate_limiter(service: &str) -> &'static Mutex<recovery::RecreateLimiter> {
  if service == X_APP { &X_RECREATE_LIMITER } else { &INSTAGRAM_RECREATE_LIMITER }
}

fn service_auto_retry(service: &str) -> &'static recovery::AutoRetry {
  if service == X_APP { &X_AUTO_RETRY } else { &INSTAGRAM_AUTO_RETRY }
}

fn service_load_timer(service: &str) -> &'static recovery::LoadTimer {
  if service == X_APP { &X_LOAD_TIMER } else { &INSTAGRAM_LOAD_TIMER }
}

/// Закрывает WebView сервиса и создаёт заново. Вызывающий держит `WEBVIEW_CREATION_LOCK`
/// (либо вызывает не из главного потока через `spawn_recovery`).
/// Закрывает WebView сервиса (его выключили в настройках сети): сетевая нагрузка прекращается.
pub(crate) fn close_service_webview(app: &AppHandle, service: &str) {
  let label = get_service_label(service);
  let app_for_main = app.clone();
  let _ = run_on_main(app, move || {
    if let Some(webview) = app_for_main.get_webview(label) && let Err(error) = webview.close() {
      log::warn!("[MultiApp] Failed to close {label}: {error}");
    }
  });
}

fn recreate_service_webview(app: &AppHandle, service: &'static str, reason: &str) -> Result<(), String> {
  let allowed = service_recreate_limiter(service)
    .lock()
    .unwrap_or_else(|poisoned| poisoned.into_inner())
    .allow(Instant::now());
  if !allowed {
    log::warn!("[MultiApp] {service} recreation limit reached ({reason})");
    return Err("The service browser keeps failing".to_string());
  }
  log::warn!("[MultiApp] {service} recreating webview: {reason}");
  let main_window = app
    .get_window("main")
    .ok_or_else(|| "Main window not found".to_string())?;
  let label = get_service_label(service);
  let app_for_main = app.clone();
  run_on_main(app, move || {
    if let Some(webview) = app_for_main.get_webview(label)
      && let Err(error) = webview.close()
    {
      log::warn!("[MultiApp] Failed to close {label}: {error}");
    }
  })?;
  sleep::wake(app, service);
  let bounds = resolve_x_bounds(&main_window, get_x_bounds().unwrap_or_else(|| default_x_bounds(&main_window)))?;
  let start_hidden = get_active_app() != service;
  if service == X_APP {
    create_x_webview(app, &main_window, bounds, start_hidden)?;
  } else {
    create_instagram_webview(app, &main_window, bounds, start_hidden)?;
  }
  store_x_bounds(bounds);
  if start_hidden {
    sleep::schedule(app, service);
  }
  Ok(())
}

/// Восстановление из колбэка WebView2 (главный поток): блокировку создания берём в отдельном потоке,
/// иначе главный поток встал бы в очередь за потоком, который ждёт главный.
fn spawn_recovery(app: &AppHandle, service: &'static str, reason: String) {
  let recovering = if service == X_APP { &X_RECOVERING } else { &INSTAGRAM_RECOVERING };
  if recovering.swap(true, Ordering::AcqRel) {
    return;
  }
  let app = app.clone();
  std::thread::spawn(move || {
    let result = {
      let _guard = WEBVIEW_CREATION_LOCK.lock().unwrap_or_else(|p| p.into_inner());
      recreate_service_webview(&app, service, &reason)
    };
    recovering.store(false, Ordering::Release);
    if let Err(error) = result {
      emit_service_error(&app, service, format!("Failed to recover the service: {error}"));
    }
  });
}

pub(crate) fn has_social_overlay() -> bool {
  SOCIAL_OVERLAY.load(Ordering::Acquire)
}

pub(crate) fn set_social_overlay(app: &AppHandle, visible: bool) -> Result<(), String> {
  if visible {
    SOCIAL_OVERLAY.store(true, Ordering::Release);
    for label in [X_WEBVIEW_LABEL, INSTAGRAM_WEBVIEW_LABEL] {
      if let Some(webview) = app.get_webview(label) {
        set_media_active(&webview, false);
        match hide_checked(app, label) {
          Ok(()) => {}
          // Таймаут: команда скрытия уже стоит в очереди главного потока, шаринг не срываем
          Err(error @ WebviewOpError::Timeout(_)) => {
            log::warn!("[MultiApp] Share overlay: hiding {label} timed out, continuing: {error}");
          }
          Err(error) => {
            log::warn!("[MultiApp] Share overlay could not hide {label}: {error}");
            SOCIAL_OVERLAY.store(false, Ordering::Release);
            let _ = set_social_overlay(app, false);
            return Err("SHARE_OVERLAY_FAILED".to_string());
          }
        }
      }
    }
    return Ok(());
  }
  SOCIAL_OVERLAY.store(false, Ordering::Release);
  let active = get_active_app();
  let label = match active.as_str() { X_APP => X_WEBVIEW_LABEL, INSTAGRAM_APP => INSTAGRAM_WEBVIEW_LABEL, _ => { SOCIAL_OVERLAY.store(false, Ordering::Release); return Ok(()); } };
  let can_show = if active == X_APP { !X_WAITING_TO_SHOW.load(Ordering::Acquire) && get_x_load_state() != "auth-required" } else { !INSTAGRAM_WAITING_TO_SHOW.load(Ordering::Acquire) };
  if can_show && crate::workspace_privacy::allows_native_content() {
    if let Some(webview) = app.get_webview(label) {
      sleep::wake(app, get_service_for_label(label));
      match show_checked(app, label) {
        Ok(()) => {}
        Err(error @ WebviewOpError::Timeout(_)) => {
          log::warn!("[MultiApp] Share overlay: restoring {label} timed out, continuing: {error}");
        }
        Err(error) => {
          log::warn!("[MultiApp] Share overlay could not restore {label}: {error}");
          return Err("SHARE_OVERLAY_FAILED".to_string());
        }
      }
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

#[tauri::command(async)]
pub(crate) fn relay_media_download_prepare(webview: tauri::Webview, app_handle: AppHandle, url: String, file_name: String, source_url: Option<String>) -> Result<String, String> {
  crate::social_share::require_main(&webview)?;
  downloads::prepare_download(&app_handle, url, file_name, source_url)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SocialNotificationSettings {
  x_enabled: bool,
  instagram_enabled: bool,
  volume: u8,
}

#[tauri::command]
pub(crate) fn multi_set_content_visible(
  webview: tauri::Webview,
  app_handle: AppHandle,
  generation: u64,
  locked: bool,
  visible: bool,
  bounds: Option<AppBounds>,
  notification_settings: Option<SocialNotificationSettings>,
) -> Result<bool, String> {
  crate::social_share::require_main(&webview)?;
  let app = app_handle.clone();
  run_on_main(&app_handle, move || {
    let was_locked = crate::workspace_privacy::is_locked();
    if !crate::workspace_privacy::set_visibility(generation, locked, visible) {
      return Ok(false);
    }
    if let Some(settings) = notification_settings {
      #[cfg(windows)]
      let notification_smoke = crate::lagom_notifications::notification_smoke_enabled();
      #[cfg(not(windows))]
      let notification_smoke = false;
      let delivers_notifications = !crate::is_research_headless()
        && (!crate::is_background_control() || notification_smoke);
      let x_enabled = delivers_notifications && settings.x_enabled;
      let instagram_enabled = delivers_notifications && settings.instagram_enabled;
      #[cfg(windows)]
      crate::lagom_notifications::set_social_notice_settings(&app, x_enabled, instagram_enabled, settings.volume);
      #[cfg(not(windows))]
      let _ = settings.volume;
      sleep::set_notification_services(&app, x_enabled, instagram_enabled, was_locked != locked);
    }

    if !crate::workspace_privacy::allows_native_content() {
      let mut covered = crate::bot_web_apps::hide_for_workspace(&app);
      #[cfg(windows)]
      if locked { covered &= crate::lagom_notifications::clear_for_workspace_lock(&app); }
      for label in [X_WEBVIEW_LABEL, INSTAGRAM_WEBVIEW_LABEL] {
        if let Some(view) = app.get_webview(label) {
          set_media_active(&view, false);
          covered &= park_webview(&view, locked).is_ok();
        }
      }
      if locked {
        for (label, window) in app.windows() {
          if label.starts_with("x-auth-") || label.starts_with("instagram-auth-") {
            covered &= park_window(&window);
          }
        }
      }
      if !crate::should_avoid_foreground() { let _ = webview.set_focus(); }
      if !covered {
        if locked && let Some(main) = app.get_window("main") {
          let _ = main.hide();
          let _ = main.destroy();
        }
        return Err("MEDIA_CONTENT_VISIBILITY_FAILED".into());
      }
      return Ok(true);
    }

    let restored = (|| {
      if let Some(bounds) = bounds {
        apply_active_bounds(&app, bounds)?;
      }
      restore_native_content(&app)
    })();
    if let Err(error) = restored {
      crate::workspace_privacy::keep_covered();
      return Err(error);
    }
    Ok(true)
  }).map_err(String::from)?
}

#[tauri::command]
pub(crate) fn relay_media_operation_source(webview: tauri::Webview, app_handle: AppHandle, id: String) -> Result<(), String> {
  crate::social_share::require_main(&webview)?;
  let (service, source) = crate::media_operations::operation_source(&app_handle, &id)?;
  if has_social_overlay() { return Err("SHARE_BUSY".into()); }
  if !crate::workspace_privacy::allows_native_content() { return Err("MEDIA_OPERATIONS_OPEN".into()); }
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
  sleep::wake(&app_handle, service);
  service_auto_retry(service).reset();
  begin_service_load(&app_handle, service);
  if target.navigate(source).is_err() {
    emit_service_error(&app_handle, service, "The media source could not be opened".into());
    return Err("MEDIA_SOURCE_UNAVAILABLE".into());
  }
  Ok(())
}

fn restore_native_content(app: &AppHandle) -> Result<(), String> {
  if !crate::workspace_privacy::allows_native_content() || has_social_overlay() { return Ok(()); }
  let active = get_active_app();
  let (label, can_show) = match active.as_str() {
    X_APP => (X_WEBVIEW_LABEL, !X_WAITING_TO_SHOW.load(Ordering::Acquire) && get_x_load_state() != "auth-required"),
    INSTAGRAM_APP => (INSTAGRAM_WEBVIEW_LABEL, !INSTAGRAM_WAITING_TO_SHOW.load(Ordering::Acquire)),
    _ => return Ok(()),
  };
  if can_show {
    if let Some(view) = app.get_webview(label) {
      show_checked(app, label).map_err(|_| "MEDIA_CONTENT_VISIBILITY_FAILED")?;
      set_media_active(&view, true);

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

/// Главное окно свёрнуто, убрано в трей или показано снова: запускает или отменяет сон скрытых WebView.
pub fn refresh_main_window_visibility(app_handle: &AppHandle) {
  let Some(main_window) = app_handle.get_window("main") else { return; };
  let hidden = recovery::is_window_hidden(
    main_window.is_minimized().unwrap_or(false),
    main_window.is_visible().unwrap_or(true),
  );
  if hidden { on_main_window_hidden(app_handle) } else { on_main_window_shown(app_handle) }
}

pub fn on_main_window_hidden(app_handle: &AppHandle) {
  sleep::schedule(app_handle, TELEGRAM_APP);
  match get_active_app().as_str() {
    X_APP => sleep::schedule(app_handle, X_APP),
    INSTAGRAM_APP => sleep::schedule(app_handle, INSTAGRAM_APP),
    _ => {}
  }
}

pub fn on_main_window_shown(app_handle: &AppHandle) {
  sleep::wake(app_handle, TELEGRAM_APP);
  match get_active_app().as_str() {
    X_APP => sleep::wake(app_handle, X_APP),
    INSTAGRAM_APP => sleep::wake(app_handle, INSTAGRAM_APP),
    _ => {}
  }
}

/// Размер главного окна сейчас нулевой или окно свёрнуто: bounds пересчитывать нельзя.
fn main_window_resize_is_ignorable(main_window: &tauri::Window) -> bool {
  let size = main_window.inner_size().unwrap_or_default();
  recovery::should_ignore_resize(main_window.is_minimized().unwrap_or(false), size.width, size.height)
}

pub fn on_main_window_resize(app_handle: &AppHandle) {
  // Размер дочернего окна задаётся прямоугольником рабочего места.
  refresh_main_window_visibility(app_handle);
}

fn can_prewarm(app: &AppHandle, window: &tauri::Window) -> bool {
  crate::workspace_privacy::allows_native_content()
    && (is_smoke_test()
      || window.is_visible().unwrap_or(false) && !window.is_minimized().unwrap_or(true))
    && app.get_webview("main").is_some()
}

#[tauri::command]
pub async fn multi_prewarm_x(
  webview: tauri::Webview,
  app_handle: AppHandle,
  bounds: Option<AppBounds>,
  for_notifications: Option<bool>,
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

  if !can_prepare_service(&webview, &app_handle, &main_window, X_APP, for_notifications)? { return Ok(()); }
  let bounds = resolve_prewarm_bounds(&main_window, bounds, for_notifications)?;

  create_x_webview(&app_handle, &main_window, bounds, true)?;
  if for_notifications != Some(true) { store_x_bounds(bounds); }
  // Прогретый скрытый сервис тоже должен засыпать, иначе он держит память, пока его не откроют
  if get_active_app() != X_APP {
    sleep::schedule(&app_handle, X_APP);
  }
  Ok(())
}

#[tauri::command]
pub async fn multi_prewarm_instagram(
  webview: tauri::Webview,
  app_handle: AppHandle,
  bounds: Option<AppBounds>,
  for_notifications: Option<bool>,
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

  if !can_prepare_service(&webview, &app_handle, &main_window, INSTAGRAM_APP, for_notifications)? { return Ok(()); }
  let bounds = resolve_prewarm_bounds(&main_window, bounds, for_notifications)?;

  create_instagram_webview(&app_handle, &main_window, bounds, true)?;
  if for_notifications != Some(true) { store_x_bounds(bounds); }
  if get_active_app() != INSTAGRAM_APP {
    sleep::schedule(&app_handle, INSTAGRAM_APP);
  }
  Ok(())
}

fn can_prepare_service(
  webview: &tauri::Webview,
  app: &AppHandle,
  main: &tauri::Window,
  service: &'static str,
  for_notifications: Option<bool>,
) -> Result<bool, String> {
  if for_notifications != Some(true) {
    return Ok(can_prewarm(app, main));
  }
  crate::social_share::require_main(webview)?;
  if !sleep::keeps_notifications_active(service) || crate::is_research_headless() || crate::is_background_control() {
    return Ok(false);
  }
  // Наличие каталога позволяет восстановить использовавшийся WebView2 без доступа к cookies.
  Ok(get_service_data_directory(app, service)?.is_dir())
}

fn resolve_prewarm_bounds(
  window: &tauri::Window,
  requested: Option<AppBounds>,
  for_notifications: Option<bool>,
) -> Result<AppBounds, String> {
  if for_notifications == Some(true) {
    // Свёрнутое окно может вернуть нулевую клиентскую область. Скрытая вкладка получает
    // нормальную ширину для загрузки настольной страницы, без изменения геометрии рабочей области.
    return Ok(get_x_bounds().unwrap_or(AppBounds { x: 0, y: 0, width: 960, height: 640 }));
  }
  let requested = requested.or_else(get_x_bounds).unwrap_or_else(|| default_x_bounds(window));
  resolve_x_bounds(window, requested)
}

#[tauri::command]
pub async fn multi_set_active_app(
  app_handle: AppHandle,
  app: String,
  bounds: Option<AppBounds>,
) -> Result<(), String> {
  if has_social_overlay() { return Err("SHARE_BUSY".to_string()); }
  if crate::workspace_privacy::is_locked() { return Err("WORKSPACE_LOCKED".into()); }
  let _guard = WEBVIEW_CREATION_LOCK
    .lock()
    .unwrap_or_else(|p| p.into_inner());
  if crate::workspace_privacy::is_locked() { return Err("WORKSPACE_LOCKED".into()); }
  if app == X_APP || app == INSTAGRAM_APP {
    let shell = app_handle.clone();
    if !run_on_main(&app_handle, move || crate::bot_web_apps::hide_for_workspace(&shell))? {
      return Err("MEDIA_CONTENT_VISIBILITY_FAILED".into());
    }
  }
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
pub fn multi_update_x_bounds(
  app_handle: AppHandle, bounds: AppBounds, app: Option<String>,
) -> Result<(), String> {
  let shell = app_handle.clone();
  let result = run_on_main(&app_handle, move || {
    if app.is_some_and(|requested| requested != get_active_app()) {
      return Ok(());
    }
    apply_active_bounds(&shell, bounds)
  }).map_err(String::from).and_then(|result| result);

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

fn apply_active_bounds(app: &AppHandle, requested: AppBounds) -> Result<(), String> {
  let active = get_active_app();
  if active == TELEGRAM_APP { return Ok(()); }

  let main = app.get_window("main").ok_or("Main window not found")?;
  if main_window_resize_is_ignorable(&main) { return Ok(()); }

  let bounds = resolve_x_bounds(&main, requested)?;
  if get_x_bounds() == Some(bounds) { return Ok(()); }

  apply_webview_bounds(app, get_service_label(&active), bounds)?;
  store_x_bounds(bounds);
  Ok(())
}

#[tauri::command]
pub async fn multi_x_navigate(app_handle: AppHandle, action: String) -> Result<(), String> {
  if has_social_overlay() { return Err("SHARE_BUSY".to_string()); }
  if !crate::workspace_privacy::allows_native_content() { return Err("MEDIA_OPERATIONS_OPEN".into()); }
  if action == "browser-login" {
    return open_service_login_in_browser(app_handle, X_APP);
  }
  let result: Result<(), String> = (|| {
    if get_active_app() != X_APP {
      return Err("X is not active".to_string());
    }
    let webview = app_handle
      .get_webview(X_WEBVIEW_LABEL)
      .ok_or_else(|| "X webview is not available".to_string())?;

    sleep::wake(&app_handle, X_APP);
    if action == "reload" || action == "home" || action == "login" {
      X_AUTO_RETRY.reset();
      begin_service_load(&app_handle, X_APP);
    }

    if X_WAITING_TO_SHOW.load(Ordering::Acquire) {
      emit_x_status(&app_handle, "loading", None);
    } else {
      show_checked(&app_handle, X_WEBVIEW_LABEL)
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
      "login" => webview.navigate(service_login_url(X_APP)),
      _ => return Err(format!("Unknown X navigation action: {action}")),
    }
    .map_err(|error| format!("Failed to navigate X: {error}"))?;
    // navigate/reload идут без результата: мёртвый контроллер видно только по пробе
    recovery::retry_on_timeout(|| probe_webview(&webview)).map_err(|error| {
      if error.is_dead() {
        spawn_recovery(&app_handle, X_APP, format!("navigate failed: {error}"));
      }
      format!("Failed to navigate X: {error}")
    })
  })();

  if let Err(message) = &result {
    emit_x_error(&app_handle, message.clone());
  }

  result
}

#[tauri::command]
pub async fn multi_instagram_navigate(app_handle: AppHandle, action: String) -> Result<(), String> {
  if has_social_overlay() { return Err("SHARE_BUSY".to_string()); }
  if !crate::workspace_privacy::allows_native_content() { return Err("MEDIA_OPERATIONS_OPEN".into()); }
  if action == "browser-login" {
    return open_service_login_in_browser(app_handle, INSTAGRAM_APP);
  }
  let result: Result<(), String> = (|| {
    if get_active_app() != INSTAGRAM_APP {
      return Err("Instagram is not active".to_string());
    }
    let webview = app_handle
      .get_webview(INSTAGRAM_WEBVIEW_LABEL)
      .ok_or_else(|| "Instagram webview is not available".to_string())?;

    sleep::wake(&app_handle, INSTAGRAM_APP);
    if action == "reload" || action == "home" || action == "login" {
      INSTAGRAM_AUTO_RETRY.reset();
      begin_service_load(&app_handle, INSTAGRAM_APP);
    }

    if INSTAGRAM_WAITING_TO_SHOW.load(Ordering::Acquire) {
      emit_instagram_status(&app_handle, "loading", None);
    } else {
      show_checked(&app_handle, INSTAGRAM_WEBVIEW_LABEL)
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
      "home" => webview.navigate(parse_instagram_home_url()?),
      "login" => webview.navigate(service_login_url(INSTAGRAM_APP)),
      _ => return Err(format!("Unknown Instagram navigation action: {action}")),
    }
    .map_err(|error| format!("Failed to navigate Instagram: {error}"))?;
    recovery::retry_on_timeout(|| probe_webview(&webview)).map_err(|error| {
      if error.is_dead() {
        spawn_recovery(&app_handle, INSTAGRAM_APP, format!("navigate failed: {error}"));
      }
      format!("Failed to navigate Instagram: {error}")
    })
  })();

  if let Err(message) = &result {
    emit_instagram_error(&app_handle, message.clone());
  }

  result
}

fn open_service_login_in_browser(app_handle: AppHandle, service: &'static str) -> Result<(), String> {
  if get_active_app() != service {
    return Err("The sign-in service is not active".to_string());
  }
  multi_open_external(app_handle, service_login_url(service).into())
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
    log::warn!("[MultiApp] Failed to set the native window theme: {error}");
  }
  let requested_bounds = requested_bounds
    .or_else(get_x_bounds)
    .unwrap_or_else(|| default_x_bounds(&main_window));
  let bounds = resolve_x_bounds(&main_window, requested_bounds)?;
  let was_active = get_active_app() == X_APP;

  // Разбудить до show: после suspend контроллер не отвечает
  sleep::wake(app_handle, X_APP);
  if let Some(ig_webview) = app_handle.get_webview(INSTAGRAM_WEBVIEW_LABEL) {
    set_media_active(&ig_webview, false);
    let _ = hide_checked(app_handle, INSTAGRAM_WEBVIEW_LABEL);
    sleep::schedule(app_handle, INSTAGRAM_APP);
  }

  if let Some(webview) = app_handle.get_webview(X_WEBVIEW_LABEL) {
    let mut broken = apply_webview_bounds(app_handle, X_WEBVIEW_LABEL, bounds)
      .err()
      .map(|error| format!("bounds: {error}"));
    if broken.is_some() {
      // Мёртвый контроллер проявляется ошибкой уже на bounds; пересоздаём ниже
    } else if get_x_load_state() == "auth-required" {
      emit_x_status(app_handle, "auth-required", None);
    } else if get_x_load_state() == "error" || is_browser_error_document(&webview) {
      X_AUTO_RETRY.reset();
      begin_service_load(app_handle, X_APP);
      webview
        .reload()
        .map_err(|error| format!("Failed to reload X: {error}"))?;
    } else if X_WAITING_TO_SHOW.load(Ordering::Acquire) {
      emit_x_status(app_handle, "loading", None);
    } else {
      match show_checked(app_handle, X_WEBVIEW_LABEL) {
        // Таймаут не означает смерть WebView: пересоздание только при Dead
        Err(error) if !error.is_dead() => {
          return Err(format!("Failed to show X: {error}"));
        }
        Err(error) => broken = Some(format!("show: {error}")),
        Ok(()) => {
          if crate::workspace_privacy::allows_native_content()
            && !has_social_overlay() && !crate::should_avoid_foreground()
            && let Err(error) = webview.set_focus()
          {
            if !was_active {
              let _ = hide_checked(app_handle, X_WEBVIEW_LABEL);
            }
            return Err(format!("Failed to focus X: {error}"));
          }

          emit_x_status(app_handle, get_x_load_state(), None);
        }
      }
    }
    if let Some(reason) = broken {
      recreate_service_webview(app_handle, X_APP, &reason)?;
    }
  } else {
    create_x_webview(app_handle, &main_window, bounds, false)?;
  }

  store_x_bounds(bounds);
  store_active_app(X_APP);
  if let Some(webview) = app_handle.get_webview(X_WEBVIEW_LABEL) {
    let visible = crate::workspace_privacy::allows_native_content() && !has_social_overlay()
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
    log::warn!("[MultiApp] Failed to set the native window theme: {error}");
  }
  let requested_bounds = requested_bounds
    .or_else(get_x_bounds)
    .unwrap_or_else(|| default_x_bounds(&main_window));
  let bounds = resolve_x_bounds(&main_window, requested_bounds)?;
  let was_active = get_active_app() == INSTAGRAM_APP;

  // Разбудить до show: после suspend контроллер не отвечает
  sleep::wake(app_handle, INSTAGRAM_APP);
  if let Some(x_webview) = app_handle.get_webview(X_WEBVIEW_LABEL) {
    set_media_active(&x_webview, false);
    let _ = hide_checked(app_handle, X_WEBVIEW_LABEL);
    sleep::schedule(app_handle, X_APP);
  }

  if let Some(webview) = app_handle.get_webview(INSTAGRAM_WEBVIEW_LABEL) {
    let mut broken = apply_webview_bounds(app_handle, INSTAGRAM_WEBVIEW_LABEL, bounds)
      .err()
      .map(|error| format!("bounds: {error}"));
    if broken.is_some() {
      // Мёртвый контроллер проявляется ошибкой уже на bounds; пересоздаём ниже
    } else if get_instagram_load_state() == "error" || is_browser_error_document(&webview) {
      INSTAGRAM_AUTO_RETRY.reset();
      begin_service_load(app_handle, INSTAGRAM_APP);
      webview
        .reload()
        .map_err(|error| format!("Failed to reload Instagram: {error}"))?;
    } else if get_instagram_load_state() == "auth-required" {
      emit_instagram_status(app_handle, "auth-required", None);
    } else if INSTAGRAM_WAITING_TO_SHOW.load(Ordering::Acquire) {
      emit_instagram_status(app_handle, "loading", None);
    } else {
      match show_checked(app_handle, INSTAGRAM_WEBVIEW_LABEL) {
        // Таймаут не означает смерть WebView: пересоздание только при Dead
        Err(error) if !error.is_dead() => {
          return Err(format!("Failed to show Instagram: {error}"));
        }
        Err(error) => broken = Some(format!("show: {error}")),
        Ok(()) => {
          if crate::workspace_privacy::allows_native_content()
            && !has_social_overlay() && !crate::should_avoid_foreground()
            && let Err(error) = webview.set_focus()
          {
            if !was_active {
              let _ = hide_checked(app_handle, INSTAGRAM_WEBVIEW_LABEL);
            }
            return Err(format!("Failed to focus Instagram: {error}"));
          }

          emit_instagram_status(app_handle, get_instagram_load_state(), None);
        }
      }
    }
    if let Some(reason) = broken {
      recreate_service_webview(app_handle, INSTAGRAM_APP, &reason)?;
    }
  } else {
    create_instagram_webview(app_handle, &main_window, bounds, false)?;
  }

  store_x_bounds(bounds);
  store_active_app(INSTAGRAM_APP);
  if let Some(webview) = app_handle.get_webview(INSTAGRAM_WEBVIEW_LABEL) {
    let visible = crate::workspace_privacy::allows_native_content() && !has_social_overlay()
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

  sleep::wake(app_handle, TELEGRAM_APP);
  if let Some(webview) = app_handle.get_webview(X_WEBVIEW_LABEL) {
    set_media_active(&webview, false);
    let _ = hide_checked(app_handle, X_WEBVIEW_LABEL);
    sleep::schedule(app_handle, X_APP);
  }
  if let Some(ig_webview) = app_handle.get_webview(INSTAGRAM_WEBVIEW_LABEL) {
    set_media_active(&ig_webview, false);
    let _ = hide_checked(app_handle, INSTAGRAM_WEBVIEW_LABEL);
    sleep::schedule(app_handle, INSTAGRAM_APP);
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

fn get_service_for_label(label: &str) -> &'static str {
  if label == X_WEBVIEW_LABEL { X_APP } else { INSTAGRAM_APP }
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

fn service_load_timeout(service: &str) -> Duration {
  if service == X_APP { X_LOAD_TIMEOUT } else { SERVICE_LOAD_TIMEOUT }
}

fn begin_service_load(app_handle: &AppHandle, service: &'static str) {
  service_load_timer(service).begin(Instant::now());
  let watchdog = get_service_watchdog(service);
  watchdog.worker.call_once(|| {
    let app = app_handle.clone();
    std::thread::spawn(move || watch_service_load(&app, service));
  });
  {
    let mut state = watchdog.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    state.generation = state.generation.wrapping_add(1);
    state.expires_at = Some(Instant::now() + service_load_timeout(service));
    state.waiting_for_x_controls = false;
  }
  watchdog.changed.notify_one();
  get_service_waiting_flag(service).store(true, Ordering::Release);
  if let Some(webview) = app_handle.get_webview(get_service_label(service)) {
    set_media_active(&webview, false);
    let _ = webview.hide();
  }
  emit_service_status(app_handle, service, "loading");
}

fn cancel_service_load_deadline(service: &str) -> u64 {
  let watchdog = get_service_watchdog(service);
  let generation = {
    let mut state = watchdog.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    state.generation = state.generation.wrapping_add(1);
    state.expires_at = None;
    state.generation
  };
  watchdog.changed.notify_one();
  generation
}

fn current_load_generation(service: &str) -> u64 {
  get_service_watchdog(service)
    .state
    .lock()
    .unwrap_or_else(|poisoned| poisoned.into_inner())
    .generation
}

/// Сбой загрузки: один раз за серию перезагружаем через 3 с, повторный сбой уходит в экран ошибки.
fn handle_load_failure(app_handle: &AppHandle, service: &'static str, message: String) {
  if get_service_load_state(service) == "loading"
    && app_handle.get_webview(get_service_label(service)).is_some()
    && service_auto_retry(service).take()
  {
    let generation = cancel_service_load_deadline(service);
    log::warn!("[MultiApp] {service} load failed ({message}); reloading in {} s", recovery::AUTO_RETRY_DELAY.as_secs());
    let app = app_handle.clone();
    std::thread::spawn(move || {
      std::thread::sleep(recovery::AUTO_RETRY_DELAY);
      let app_for_main = app.clone();
      let result = run_on_main(&app, move || {
        // Проверяем очередность непосредственно перед переходом, на том же потоке.
        if current_load_generation(service) != generation || get_service_load_state(service) != "loading" {
          return Ok(());
        }
        sleep::wake(&app_for_main, service);
        begin_service_load(&app_for_main, service);
        app_for_main
          .get_webview(get_service_label(service))
          .ok_or_else(|| "webview is not available".to_string())
          .and_then(|webview| webview.reload().map_err(|error| error.to_string()))
      });
      if let Err(error) = result.map_err(String::from).and_then(|inner| inner) {
        log::warn!("[MultiApp] {service} automatic reload failed: {error}");
        emit_service_error(&app, service, message);
      }
    });
    return;
  }
  emit_service_error(app_handle, service, message);
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
    let timeout = if state.waiting_for_x_controls { X_INTERACTIVE_LOAD_TIMEOUT } else { service_load_timeout(service) };
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
      handle_load_failure(&app, service, format!(
        "The service did not become ready within {} seconds", timeout.as_secs(),
      ));
    });
  }
}

fn complete_service_load(app_handle: &AppHandle, service: &'static str) {
  if get_service_load_state(service) != "loading" {
    return;
  }
  cancel_service_load_deadline(service);
  service_auto_retry(service).reset();
  if let Some(elapsed) = service_load_timer(service).finish(Instant::now()) {
    log::info!("[MultiApp] {service} ready in {} ms", elapsed.as_millis());
  }
  get_service_waiting_flag(service).store(false, Ordering::Release);
  if let Some(webview) = app_handle.get_webview(get_service_label(service)) {
    let is_active = get_active_app() == service && !has_social_overlay() && crate::workspace_privacy::allows_native_content();
    if is_active {
      sleep::wake(app_handle, service);
      let result = show_checked(app_handle, get_service_label(service)).and_then(|_| {
        if crate::should_avoid_foreground() || !crate::workspace_privacy::allows_native_content() || has_social_overlay() {
          Ok(())
        } else {
          webview.set_focus().map_err(|error| WebviewOpError::Dead(error.to_string()))
        }
      });
      if let Err(error) = result {
        if error.is_dead() {
          // Мёртвый контроллер: пересоздаём WebView, а не оставляем пустую область
          spawn_recovery(app_handle, service, format!("show failed after load: {error}"));
        } else {
          // Таймаут: WebView, скорее всего, жив; пересоздание не нужно, сообщаем об ошибке
          log::warn!("[MultiApp] {service} show after load timed out: {error}");
          emit_service_error(app_handle, service, format!("Failed to show the service: {error}"));
        }
        return;
      }
    }
    set_media_active(&webview, is_active);
    // Загрузка скрытого сервиса закончилась уже после того, как таймер сна не сработал или не ставился
    if service != TELEGRAM_APP && get_active_app() != service {
      sleep::schedule(app_handle, service);
    }
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
    let lastReportAt = -Infinity;
    let hasStopped = false;
    let timer;
    let poll;
    const observer = new MutationObserver(scheduleProbe);
    function probeReady(nextGeneration) {{
      if (nextGeneration !== undefined && generation !== nextGeneration) {{
        generation = nextGeneration;
        lastReportAt = -Infinity;
      }}
      if (hasStopped || generation === undefined || !document.body || performance.now() - lastReportAt < 750) return;
      const controls = document.querySelectorAll('button, input:not([type="hidden"]), textarea, select, a[href], [role="button"], [role="link"], [contenteditable="true"]');
      const hasVisibleControl = Array.from(controls).some((control) => {{
        if (control.matches(':disabled') || control.getAttribute('aria-disabled') === 'true'
          || control.closest('[inert], [aria-hidden="true"], [aria-busy="true"]')) return false;
        const bounds = control.getBoundingClientRect();
        if (bounds.width <= 0 || bounds.height <= 0 || bounds.bottom <= 0 || bounds.top >= window.innerHeight
          || bounds.right <= 0 || bounds.left >= window.innerWidth) return false;
        for (let node = control; node; node = node.parentElement) {{
          const style = getComputedStyle(node);
          // У потомка модального слоя может быть своё pointer-events: auto.
          if (style.visibility !== 'visible' || style.display === 'none' || style.opacity === '0'
            || (node === control && style.pointerEvents === 'none')) return false;
        }}
        return true;
      }});
      if (!hasVisibleControl) return;
      lastReportAt = performance.now();
      window.chrome?.webview?.postMessage(token + ':' + generation);
    }}
    function scheduleProbe() {{
      if (hasStopped || timer !== undefined || generation === undefined) return;
      timer = setTimeout(() => {{ timer = undefined; probeReady(); }}, 50);
    }}
    function stopProbe() {{
      hasStopped = true;
      observer.disconnect();
      if (timer !== undefined) clearTimeout(timer);
      if (poll !== undefined) clearInterval(poll);
      timer = undefined;
      poll = undefined;
    }}
    window.__egoistRelayProbeReady = probeReady;
    window.__egoistRelayStopReadyProbe = stopProbe;
    function startProbe() {{
      if (hasStopped || !document.documentElement) return;
      observer.observe(document.documentElement, {{ childList: true, subtree: true, attributes: true,
        attributeFilter: ['class', 'style', 'hidden', 'disabled', 'aria-disabled', 'aria-hidden', 'aria-busy', 'inert', 'role', 'href'] }});
      // CSS-анимации и загрузка стилей могут открыть контрол без изменения атрибутов DOM.
      if (poll === undefined) poll = setInterval(probeReady, 250);
      scheduleProbe();
    }}
    if (document.readyState === 'loading') {{
      document.addEventListener('DOMContentLoaded', startProbe, {{ once: true }});
    }} else {{ startProbe(); }}
    window.addEventListener('pagehide', stopProbe);
    window.addEventListener('pageshow', (event) => {{
      if (!event.persisted) return;
      hasStopped = false;
      lastReportAt = -Infinity;
      startProbe();
    }});
  }})();"#)
}

#[cfg(windows)]
fn observe_service_document(service: &str, loaded: &AtomicBool, source: &str) -> bool {
  if !Url::parse(source).is_ok_and(|url| url.scheme() == "https" && is_service_internal_url(service, &url)) {
    return false;
  }
  if !loaded.swap(true, Ordering::AcqRel) && service == X_APP {
    // Доставленный документ X может ждать лениво загружаемый интерфейс входа.
    // Однократное продление сохраняет документ и общий предел времени попытки.
    let watchdog = get_service_watchdog(service);
    let extended = watchdog.state.lock().unwrap_or_else(|error| error.into_inner()).observe_x_document();
    if extended { watchdog.changed.notify_one(); }
  }
  true
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
    DOMContentLoadedEventHandler, HistoryChangedEventHandler, NavigationCompletedEventHandler,
    NavigationStartingEventHandler,
    ProcessFailedEventHandler, SourceChangedEventHandler, WebMessageReceivedEventHandler,
  };
  if let Err(error) = media_context::install(webview, service) {
    log::debug!("[MultiApp] {service} media context listener unavailable: {error}");
  }
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
        let history_app = app.clone();
        if let Err(error) = core.add_HistoryChanged(&HistoryChangedEventHandler::create(Box::new(move |sender, _| {
          let Some(sender) = sender else { return Ok(()); };
          let mut can_go_back = windows_core::BOOL(0);
          let mut can_go_forward = windows_core::BOOL(0);
          sender.CanGoBack(&mut can_go_back)?;
          sender.CanGoForward(&mut can_go_forward)?;
          let _ = history_app.emit_to("main", "multi-service-history", serde_json::json!({
            "service": service,
            "canGoBack": can_go_back.as_bool(),
            "canGoForward": can_go_forward.as_bool(),
          }));
          Ok(())
        })), &mut registration) {
          log::debug!("[MultiApp] {service} history listener unavailable: {error}");
        }
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
            if !observe_service_document(service, &dom_loaded, &webview2_com::take_pwstr(source)) {
              return Ok(());
            }
            if let Some(webview) = dom_app.get_webview(get_service_label(service)) {
              let _ = webview.eval(&format!("window.__egoistRelayProbeReady?.('{document_id}');"));
            }
            Ok(())
          })), &mut registration)?;
        }
        let completed_id = navigation_id.clone();
        let completed_loaded = has_loaded_document.clone();
        let completed_app = app.clone();
        core.add_NavigationCompleted(&NavigationCompletedEventHandler::create(Box::new(move |sender, args| {
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
              // В журнал идёт только хост адреса: в строке запроса могут быть токены
              let mut host = String::new();
              if let Some(sender) = sender.as_ref() {
                let mut source = windows_core::PWSTR::null();
                if sender.Source(&mut source).is_ok() {
                  host = Url::parse(&webview2_com::take_pwstr(source)).ok()
                    .and_then(|url| url.host_str().map(str::to_string)).unwrap_or_default();
                }
              }
              log::warn!("[MultiApp] {service} navigation failed: WebErrorStatus={} host={host}", error_status.0);
              handle_load_failure(&completed_app, service, format!("The service navigation failed: WebErrorStatus {}", error_status.0));
            }
            return Ok(());
          }
          if get_service_load_state(service) != "loading" { return Ok(()); }
          let Some(sender) = sender else { return Ok(()); };
          let mut source = windows_core::PWSTR::null();
          sender.Source(&mut source)?;
          if !observe_service_document(service, &completed_loaded, &webview2_com::take_pwstr(source)) {
            return Ok(());
          }
          completed_id.store(finished_id, Ordering::Release);
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
          let Ok(source) = Url::parse(&source) else { return Ok(()); };
          if source.scheme() != "https" || !is_service_internal_url(service, &source) {
            return Ok(());
          }
          let mut current_source = windows_core::PWSTR::null();
          sender.Source(&mut current_source)?;
          // SPA может изменить путь между postMessage и IPC. Документ уже связан с NavigationId.
          if !Url::parse(&webview2_com::take_pwstr(current_source)).is_ok_and(|current| current.origin() == source.origin()) {
            return Ok(());
          }
          if let Some(webview) = ready_app.get_webview(get_service_label(service)) {
            let _ = webview.eval("window.__egoistRelayStopReadyProbe?.();");
          }
          complete_service_load(&ready_app, service);
          Ok(())
        })), &mut registration)?;
        {
          // SPA-переходы (например, в Reels и обратно) не создают навигацию документа, но меняют адрес
          let source_app = app.clone();
          core.add_SourceChanged(&SourceChangedEventHandler::create(Box::new(move |sender, _| {
            let Some(sender) = sender else { return Ok(()); };
            let mut source = windows_core::PWSTR::null();
            sender.Source(&mut source)?;
            let source = webview2_com::take_pwstr(source);
            if let Ok(url) = Url::parse(&source) {
              crate::instagram_view::apply(&source_app, get_service_label(service), Some(url.path()));
            }
            Ok(())
          })), &mut registration)?;
        }
        let failed_app = app.clone();
        core.add_ProcessFailed(&ProcessFailedEventHandler::create(Box::new(move |sender, args| {
          let Some(args) = args else { return Ok(()); };
          let mut kind = Default::default();
          args.ProcessFailedKind(&mut kind)?;
          log::warn!("[MultiApp] {service} WebView2 process failed: ProcessFailedKind={}", kind.0);
          if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED {
            // Браузерный процесс умер вместе с контроллером. Мы на главном потоке:
            // пересоздание уходит в отдельный поток
            spawn_recovery(&failed_app, service, format!("process failed, kind {}", kind.0));
          } else if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED {
            // Рендерер упал, контроллер жив: достаточно перезагрузить страницу
            match sender.as_ref().map(|core| core.Reload()) {
              Some(Ok(())) => {}
              _ => spawn_recovery(&failed_app, service, "render process exited, reload failed".to_string()),
            }
          } else if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE {
            watch_unresponsive_renderer(&failed_app, service);
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

/// Рендерер завис: ждём, не оживёт ли сам; если страница не отвечает на скрипт, перезагружаем её.
/// Лимит пересозданий не тратится, WebView не закрывается.
#[cfg(windows)]
fn watch_unresponsive_renderer(app: &AppHandle, service: &'static str) {
  static X_WATCHING: AtomicBool = AtomicBool::new(false);
  static INSTAGRAM_WATCHING: AtomicBool = AtomicBool::new(false);
  let watching = if service == X_APP { &X_WATCHING } else { &INSTAGRAM_WATCHING };
  if watching.swap(true, Ordering::AcqRel) {
    return;
  }
  let app = app.clone();
  std::thread::spawn(move || {
    std::thread::sleep(UNRESPONSIVE_GRACE);
    if let Some(webview) = app.get_webview(get_service_label(service)) {
      if renderer_answers(&webview) {
        log::info!("[MultiApp] {service} renderer recovered by itself");
      } else {
        log::warn!("[MultiApp] {service} renderer is still unresponsive, reloading");
        let app_for_main = app.clone();
        let _ = run_on_main(&app, move || {
          if let Some(webview) = app_for_main.get_webview(get_service_label(service))
            && let Err(error) = webview.reload()
          {
            log::warn!("[MultiApp] {service} reload after hang failed: {error}");
          }
        });
      }
    }
    watching.store(false, Ordering::Release);
  });
}

#[cfg(not(windows))]
fn watch_unresponsive_renderer(_: &AppHandle, _: &'static str) {}

const UNRESPONSIVE_GRACE: Duration = Duration::from_secs(5);

/// Выполняет тривиальный скрипт в странице и ждёт ответа: зависший рендерер его не вернёт.
#[cfg(windows)]
fn renderer_answers(webview: &tauri::Webview) -> bool {
  let (sender, receiver) = std::sync::mpsc::channel();
  let started = webview.with_webview(move |platform| {
    let run = || -> windows_core::Result<()> {
      unsafe {
        let core = platform.controller().CoreWebView2()?;
        let handler = webview2_com::ExecuteScriptCompletedHandler::create(Box::new(move |_, _| {
          let _ = sender.send(());
          Ok(())
        }));
        core.ExecuteScript(&windows_core::HSTRING::from("1"), &handler)
      }
    };
    let _ = run();
  });
  started.is_ok() && receiver.recv_timeout(Duration::from_secs(2)).is_ok()
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
  X_AUTO_RETRY.reset();
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
      allow_service_navigation(&navigation_app, X_APP, url)
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

  let position = LogicalPosition::new(-1.0, -1.0);
  let size = LogicalSize::new(1.0, 1.0);
  log::info!("[MultiApp] Creating X webview with bounds: {:?}", bounds);
  let webview = match main_window.add_child(webview_builder, position, size) {
    Ok(wv) => {
      log::info!("[MultiApp] Created X webview");
      wv
    }
    Err(err) => {
      log::error!("[MultiApp] Failed to add_child X webview: {err}");
      return Err(format!("Failed to create X webview: {err}"));
    }
  };

  crate::instagram_view::reset(X_WEBVIEW_LABEL);
  crate::relay_cache::clear_pending_for_service(&webview);
  webview.hide().map_err(|error| error.to_string())?;
  apply_webview_bounds(app_handle, X_WEBVIEW_LABEL, bounds)?;

  #[cfg(windows)]
  {
    downloads::install(&webview, X_APP)?;
    if let Err(error) = crate::lagom_notifications::install(&webview, crate::lagom_notifications::Service::X) {
      log::debug!("[MultiApp] X notification listener unavailable: {error}");
    }
    install_service_load_observers(&webview, X_APP, ready_token)?;
    webview.navigate(parse_x_home_url()?)
      .map_err(|error| format!("Failed to start loading X: {error}"))?;
  }

  if start_hidden || X_WAITING_TO_SHOW.load(Ordering::Acquire) || !crate::workspace_privacy::allows_native_content() {
    let _ = webview.hide();
  } else {
    show_checked(app_handle, X_WEBVIEW_LABEL).map_err(|error| {
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
  if !crate::workspace_privacy::allows_native_content()
    || !allow_service_navigation(app_handle, service, &url)
  {
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
  let builder = builder.additional_browser_args(&service_browser_arguments(service));

  let builder = builder
    .title(if service == X_APP {
      X_AUTH_WINDOW_TITLE
    } else {
      "Instagram — Вход"
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
      let allowed = allow_service_navigation(&popup_navigation_app, service, popup_url);
      if !allowed && is_google_sign_in(popup_url) {
        if let Some(popup) = popup_navigation_app.get_window(&popup_label) {
          let _ = popup.close();
        }
      }
      allowed
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
  let (width, height) = (bounds.width, bounds.height);
  let bounds = Rect {
    position: Position::Logical(LogicalPosition::new(bounds.x as f64, bounds.y as f64)),
    size: Size::Logical(LogicalSize::new(bounds.width as f64, bounds.height as f64)),
  };

  webview
    .set_bounds(bounds)
    .map_err(|error| format!("Failed to resize {label}: {error}"))?;
  crate::instagram_view::remember_bounds(app_handle, label, width, height);
  Ok(())
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

fn service_login_url(service: &str) -> Url {
  let url = if service == X_APP { X_LOGIN_URL } else { INSTAGRAM_LOGIN_URL };
  Url::parse(url).expect("The canonical sign-in URL is valid")
}

fn is_google_sign_in(url: &Url) -> bool {
  url.host_str().is_some_and(|host| host.trim_end_matches('.') == "accounts.google.com")
}

fn allow_service_navigation(app_handle: &AppHandle, service: &'static str, url: &Url) -> bool {
  if is_google_sign_in(url) {
    show_direct_login_help(app_handle, service);
    return false;
  }
  if is_service_internal_url(service, url) {
    return true;
  }
  if crate::workspace_privacy::allows_native_content() { open_external_navigation(app_handle, url); }
  false
}

fn show_direct_login_help(app_handle: &AppHandle, service: &'static str) {
  cancel_service_load_deadline(service);
  get_service_waiting_flag(service).store(true, Ordering::Release);
  if let Some(webview) = app_handle.get_webview(get_service_label(service)) {
    set_media_active(&webview, false);
    if let Err(error) = webview.hide() {
      emit_service_error(app_handle, service, format!("Failed to show sign-in help: {error}"));
      return;
    }
  }
  if get_active_app() == service && crate::workspace_privacy::allows_native_content()
    && !has_social_overlay() && !crate::should_avoid_foreground()
  {
    if let Some(main) = app_handle.get_webview("main") {
      let _ = main.set_focus();
    }
  }
  emit_service_status(app_handle, service, "auth-required");
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
    if state == "ready" {
      crate::research_social::service_ready("x");
    }
  }

  let payload = ServiceStatusPayload {
    state,
    url: None,
    message,
  };

  if let Err(error) = app_handle.emit_to("main", X_STATUS_EVENT, payload) {
    log::warn!("[MultiApp] Failed to emit X status: {error}");
  }
}

fn log_service_error(service: &str, message: &str) {
  match service_load_timer(service).finish(Instant::now()) {
    Some(elapsed) => log::warn!("[MultiApp] {service} error after {} ms: {message}", elapsed.as_millis()),
    None => log::warn!("[MultiApp] {service} error: {message}"),
  }
}

fn emit_x_error(app_handle: &AppHandle, message: String) {
  log_service_error(X_APP, &message);
  cancel_service_load_deadline(X_APP);
  X_WAITING_TO_SHOW.store(true, Ordering::Release);
  if let Some(webview) = app_handle.get_webview(X_WEBVIEW_LABEL) {
    set_media_active(&webview, false);
    if let Err(error) = webview.hide() {
      log::warn!("[MultiApp] Failed to hide X after an error: {error}");
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
  INSTAGRAM_AUTO_RETRY.reset();
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

  let webview_builder = apply_service_network_profile(webview_builder, INSTAGRAM_APP);
  #[cfg(windows)]
  let webview_builder = webview_builder.initialization_script(&create_service_ready_script(&ready_token));

  let webview_builder = webview_builder
    .on_new_window(move |url, features| {
      create_service_auth_window(&new_window_app, INSTAGRAM_APP, url, features)
    })
    .on_navigation(move |url| {
      allow_service_navigation(&navigation_app, INSTAGRAM_APP, url)
    });
  #[cfg(not(windows))]
  let webview_builder = webview_builder.on_page_load(|webview, payload| {
    if get_instagram_load_state() == "auth-required" {
      return;
    }
    match payload.event() {
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
    }
  });

  let position = LogicalPosition::new(-1.0, -1.0);
  let size = LogicalSize::new(1.0, 1.0);
  log::info!("[MultiApp] Creating Instagram webview with bounds: {:?}", bounds);
  let webview = match main_window.add_child(webview_builder, position, size) {
    Ok(wv) => {
      log::info!("[MultiApp] Created Instagram webview");
      wv
    }
    Err(err) => {
      log::error!("[MultiApp] Failed to add_child Instagram webview: {err}");
      return Err(format!("Failed to create Instagram webview: {err}"));
    }
  };

  crate::instagram_view::reset(INSTAGRAM_WEBVIEW_LABEL);
  crate::relay_cache::clear_pending_for_service(&webview);
  webview.hide().map_err(|error| error.to_string())?;
  apply_webview_bounds(app_handle, INSTAGRAM_WEBVIEW_LABEL, bounds)?;

  #[cfg(windows)]
  {
    downloads::install(&webview, INSTAGRAM_APP)?;
    if let Err(error) = crate::lagom_notifications::install(
      &webview, crate::lagom_notifications::Service::Instagram,
    ) {
      log::debug!("[MultiApp] Instagram notification listener unavailable: {error}");
    }
    install_service_load_observers(&webview, INSTAGRAM_APP, ready_token)?;
    webview.navigate(parse_instagram_home_url()?)
      .map_err(|error| format!("Failed to start loading Instagram: {error}"))?;
  }

  if start_hidden || INSTAGRAM_WAITING_TO_SHOW.load(Ordering::Acquire) || !crate::workspace_privacy::allows_native_content() {
    let _ = webview.hide();
  } else {
    show_checked(app_handle, INSTAGRAM_WEBVIEW_LABEL).map_err(|error| {
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
    if state == "ready" {
      crate::research_social::service_ready("instagram");
    }
  }

  let payload = ServiceStatusPayload {
    state,
    url: None,
    message,
  };

  if let Err(error) = app_handle.emit_to("main", INSTAGRAM_STATUS_EVENT, payload) {
    log::warn!("[MultiApp] Failed to emit Instagram status: {error}");
  }
}

fn emit_instagram_error(app_handle: &AppHandle, message: String) {
  log_service_error(INSTAGRAM_APP, &message);
  cancel_service_load_deadline(INSTAGRAM_APP);
  INSTAGRAM_WAITING_TO_SHOW.store(true, Ordering::Release);
  if let Some(webview) = app_handle.get_webview(INSTAGRAM_WEBVIEW_LABEL) {
    set_media_active(&webview, false);
    if let Err(error) = webview.hide() {
      log::warn!("[MultiApp] Failed to hide Instagram after an error: {error}");
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

fn default_x_bounds(window: &tauri::Window) -> AppBounds {
  let scale = window.scale_factor().unwrap_or(1.0).max(f64::EPSILON);
  let size = window.inner_size().unwrap_or_default();
  AppBounds {
    x: DEFAULT_SIDEBAR_WIDTH,
    y: DEFAULT_TITLEBAR_HEIGHT,
    width: ((f64::from(size.width) / scale) as i32 - DEFAULT_SIDEBAR_WIDTH).max(1),
    height: ((f64::from(size.height) / scale) as i32 - DEFAULT_TITLEBAR_HEIGHT).max(1),
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



#[cfg(test)]
mod sign_in_tests {
  use super::*;

  #[test]
  fn browser_sign_in_starts_on_the_account_service() {
    for (service, host, path) in [
      (X_APP, "x.com", "/i/flow/login"),
      (INSTAGRAM_APP, "www.instagram.com", "/accounts/login/"),
    ] {
      let url = service_login_url(service);
      assert_eq!(url.scheme(), "https");
      assert_eq!(url.host_str(), Some(host));
      assert_eq!(url.path(), path);
      assert!(url.query().is_none());
      assert!(url.fragment().is_none());
      assert!(is_service_internal_url(service, &url));
    }
  }

  #[test]
  fn google_popup_detection_accepts_the_dns_root_dot_and_rejects_lookalikes() {
    for address in [
      "https://accounts.google.com/gsi/select?state=fixture",
      "https://accounts.google.com./gsi/select?state=fixture",
    ] {
      assert!(is_google_sign_in(&Url::parse(address).unwrap()));
    }
    for address in [
      "https://accounts.google.com.example.org/",
      "https://example.org/accounts.google.com/",
    ] {
      assert!(!is_google_sign_in(&Url::parse(address).unwrap()));
    }
  }
}
