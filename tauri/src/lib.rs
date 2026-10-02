use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{LogicalPosition, Manager};
use url::Url;
use uuid::Uuid;

mod deeplink;
use deeplink::Deeplink;

mod tray;
mod window;
use crate::window::{WINDOW_STATES, WindowState};

pub mod installer;
pub mod multi_app;
mod runtime;
mod system_proxy;
mod social_share;
mod inline_media;
mod youtube_player;
mod transcription;
mod worker_job;
mod telegram_transport;
mod research_bridge;
mod research_social;

static RESEARCH_HEADLESS: LazyLock<AtomicBool> = LazyLock::new(|| AtomicBool::new(
  std::env::args_os().any(|argument| argument == "--research-headless")
));

pub(crate) fn mark_user_opened_relay() {
  RESEARCH_HEADLESS.store(false, Ordering::Release);
}

#[cfg(target_os = "macos")]
mod mac;

#[derive(Debug)]
pub struct AppStateStruct {
  pub notification_count: i32,
  pub is_muted: bool,
}

impl Default for AppStateStruct {
  fn default() -> Self {
    Self {
      notification_count: 0,
      is_muted: false,
    }
  }
}

pub type AppState = Mutex<AppStateStruct>;

pub const TRAFFIC_LIGHT_POSITION_OVERLAY_LEGACY: LogicalPosition<f64> = LogicalPosition::new(26.0, 46.0);
pub const TRAFFIC_LIGHT_POSITION_OVERLAY_26: LogicalPosition<f64> = LogicalPosition::new(26.0, 50.0);
pub const TRAFFIC_LIGHT_POSITION_OVERLAY_MOBILE_LEGACY: LogicalPosition<f64> = LogicalPosition::new(16.0, 30.0);
pub const TRAFFIC_LIGHT_POSITION_OVERLAY_MOBILE_26: LogicalPosition<f64> = LogicalPosition::new(16.0, 34.0);
pub const TRAFFIC_LIGHT_POSITION_DEFAULT: LogicalPosition<f64> = LogicalPosition::new(14.0, 19.0);

pub static TRAFFIC_LIGHT_POSITION_OVERLAY: LazyLock<LogicalPosition<f64>> = LazyLock::new(|| {
  if let tauri_plugin_os::Version::Semantic(major, _, _) = tauri_plugin_os::version() {
      if major >= 26 {
          return TRAFFIC_LIGHT_POSITION_OVERLAY_26;
      }
  }
  TRAFFIC_LIGHT_POSITION_OVERLAY_LEGACY
});

pub static TRAFFIC_LIGHT_POSITION_OVERLAY_MOBILE: LazyLock<LogicalPosition<f64>> = LazyLock::new(|| {
  if let tauri_plugin_os::Version::Semantic(major, _, _) = tauri_plugin_os::version() {
      if major >= 26 {
          return TRAFFIC_LIGHT_POSITION_OVERLAY_MOBILE_26;
      }
  }
  TRAFFIC_LIGHT_POSITION_OVERLAY_MOBILE_LEGACY
});

pub static LAST_URL: LazyLock<std::sync::Mutex<String>> =
  LazyLock::new(|| std::sync::Mutex::new(BASE_URL.to_string()));

pub const DEFAULT_WINDOW_TITLE: &str = match std::option_env!("APP_TITLE") {
  Some(title) => title,
  None => "Egoist Relay",
};

pub const BASE_URL: &str = match std::option_env!("BASE_URL") {
  Some(url) => url,
  None => "http://localhost:1234",
};

pub const WITH_UPDATER: &str = match std::option_env!("WITH_UPDATER") {
  Some(str) => str,
  None => "false",
};

pub(crate) fn strip_hash_from_url(url: &str) -> String {
  if let Ok(mut parsed_url) = Url::parse(url) {
    parsed_url.set_fragment(None);
    parsed_url.to_string()
  } else {
    url.to_string()
  }
}

pub(crate) fn save_window_url(app: &tauri::AppHandle, window_label: &str) {
  if let Some(webview) = app.get_webview(window_label) {
    if let Ok(current_url) = webview.url() {
      let url_without_hash = strip_hash_from_url(current_url.as_str());
      if let Ok(mut last_url) = LAST_URL.lock() {
        *last_url = url_without_hash;
      }
    }
  }
}

pub(crate) fn is_background_control() -> bool {
  std::env::var("EGOIST_RELAY_CONTROL_MODE").as_deref() == Ok("background")
    || std::env::var("EGOIST_RELAY_SMOKE_TEST").as_deref() == Ok("1")
}

pub(crate) fn is_research_headless() -> bool {
  RESEARCH_HEADLESS.load(Ordering::Acquire)
}

pub(crate) fn should_avoid_foreground() -> bool {
  is_background_control() || is_research_headless()
}

#[tauri::command]
fn relay_control_status(app: tauri::AppHandle) -> serde_json::Value {
  let windows = app.windows();
  serde_json::json!({
    "enabled": std::env::var("EGOIST_RELAY_CONTROL_MODE").as_deref() == Ok("background"),
    "background": is_background_control(),
    "isolatedTest": std::env::var("EGOIST_RELAY_SMOKE_TEST").as_deref() == Ok("1"),
    "downloadProbeVersion": if multi_app::smoke_download_directory().is_some() { 1 } else { 0 },
    "appPid": std::process::id(),
    "mainLabel": "main",
    "mainWindowPresent": windows.contains_key("main"),
    "primaryWindowCount": usize::from(windows.contains_key("main")),
    "legacyTelegramWindowCount": windows.keys().filter(|label| Uuid::parse_str(label).is_ok()).count(),
    "updaterEnabled": WITH_UPDATER == "true",
    "networkMode": "system",
    "youtubeEmbedReferer": youtube_player::diagnostics()
  })
}

pub fn run() {
  let is_smoke_test = std::env::var("EGOIST_RELAY_SMOKE_TEST").as_deref() == Ok("1");
  let mut context = tauri::generate_context!();
  if let Some(main) = context.config_mut().app.windows.iter_mut().find(|window| window.label == "main") {
    main.create = false;
  }
  if should_avoid_foreground() {
    for window in &mut context.config_mut().app.windows {
      window.visible = false;
      window.focus = false;
    }
  }
  if is_smoke_test {
    let profile = std::env::var_os("EGOIST_RELAY_TEST_PROFILE")
      .map(std::path::PathBuf::from)
      .filter(|path| path.is_absolute() && path.is_dir())
      .expect("Smoke checks require an existing absolute EGOIST_RELAY_TEST_PROFILE");
    context.config_mut().identifier = "com.egoist.relay.smoke".to_string();
    for window in &mut context.config_mut().app.windows {
      window.visible = false;
      window.focus = false;
      window.data_directory = Some(profile.join("main"));
    }
  }
  let mut log_builder = tauri_plugin_log::Builder::default();
  if is_smoke_test {
    let profile = std::path::PathBuf::from(std::env::var_os("EGOIST_RELAY_TEST_PROFILE").unwrap());
    log_builder = log_builder.clear_targets().target(tauri_plugin_log::Target::new(
      tauri_plugin_log::TargetKind::Folder { path: profile.join("logs"), file_name: Some("relay".to_string()) },
    ));
  }
  let app = tauri::Builder::default()
    .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
      if is_background_control() {
        return;
      }
      if args.iter().any(|argument| argument == "--research-recover-existing")
        && !args.iter().any(|argument| argument == "--research-headless")
      {
        return;
      }
      if args.iter().any(|argument| argument == "--research-headless") {
        if let Err(reason) = research_bridge::start(app) {
          log::warn!("[EgoistRelay] Research helper recovery unavailable: {reason}");
        }
        return;
      }
      mark_user_opened_relay();
      if let Some(window) = app.get_window("main") {
        window.show().unwrap_or_default();
        window.unminimize().unwrap_or_default();
        window.set_focus().unwrap_or_default();
      } else if let Err(error) = create_main_window(app) {
        log::error!("Failed to restore the main Relay window: {error}");
      }
    }))
    .plugin(tauri_plugin_os::init())
    .plugin(tauri_plugin_fs::init())
    .plugin(tauri_plugin_shell::init())
    .plugin(tauri_plugin_notification::init())
    .plugin(log_builder.build())
    .plugin(tauri_plugin_deep_link::init())
    .plugin(tauri_plugin_process::init());

  let app = app.on_window_event(|window, event| match event {
    tauri::WindowEvent::Resized(_) => {
      multi_app::on_main_window_resize(&window.app_handle());
    }
    tauri::WindowEvent::CloseRequested { api, .. } => {
      if window.label() == "main" {
        // The primary Relay window stays alive while authentication popups close normally
        save_window_url(&window.app_handle(), window.label());

        #[cfg(target_os = "macos")]
        window.app_handle().hide().unwrap_or_default();
        #[cfg(not(target_os = "macos"))]
        window.hide().unwrap_or_default();
        api.prevent_close();
      }
    }
    tauri::WindowEvent::ThemeChanged(_) => {
      #[cfg(target_os = "macos")]
      if let Some(base_window) = window.app_handle().get_window(window.label()) {
        if let Ok(mut states) = WINDOW_STATES.lock() {
          if let Some(state) = states.get_mut(window.label()) {
            let title = if state.is_overlay {
              "".to_string()
            } else {
              state.title.clone()
            };
            let traffic_position = if state.is_overlay {
              if state.is_mobile {
                *TRAFFIC_LIGHT_POSITION_OVERLAY_MOBILE
              } else {
                *TRAFFIC_LIGHT_POSITION_OVERLAY
              }
            } else {
              TRAFFIC_LIGHT_POSITION_DEFAULT
            };
            mac::update_window_title(base_window.clone(), title, traffic_position);
          }
        }
      }
    }
    tauri::WindowEvent::Destroyed => {
      if let Ok(mut states) = WINDOW_STATES.lock() {
        states.remove(window.label());
      }
    }
    _ => {}
  });

  let app = app.setup(|app| {
    if std::env::args_os().any(|argument| argument == "--research-recover-existing") {
      // This transient controller must hand off to the existing owner or exit before account initialization.
      std::process::exit(0);
    }
    // Manage app state
    app.manage(AppState::new(AppStateStruct::default()));
    if let Err(err) = inline_media::initialize(app.handle()) {
      log::warn!("[EgoistRelay] Cannot clean temporary media: {err}");
    }
    transcription::initialize(app.handle());

    let deeplink = Deeplink::init();
    if let Err(err) = deeplink.setup(app.handle()) {
      log::error!("Failed to setup deeplink: {:?}", err);
    }

    if WITH_UPDATER == "true" {
      app
        .handle()
        .plugin(tauri_plugin_updater::Builder::new().build())?;
    }

    crate::tray::TrayManager::init(app.handle().clone())?;
    if let Err(error) = research_bridge::start(app.handle()) {
      log::warn!("[EgoistRelay] Research bridge unavailable: {error}");
    }
    create_main_window(app.handle()).map_err(std::io::Error::other)?;

    Ok(())
  });

  let app = app.invoke_handler(tauri::generate_handler![
    mark_title_bar_overlay,
    set_notifications_count,
    set_window_title,
    open_new_window_cmd,
    save_current_url,
    set_menu_translations,
    relay_control_status,
    telegram_transport::relay_get_telegram_transport,
    research_bridge::relay_research_ready,
    research_bridge::relay_research_reply,
    research_social::relay_research_social_reply,
    installer::get_default_install_dir,
    installer::choose_install_dir,
    installer::minimize_installer,
    installer::close_installer,
    installer::launch_installed_app,
    installer::perform_install,
    multi_app::multi_set_active_app,
    multi_app::multi_prewarm_x,
    multi_app::multi_prewarm_instagram,
    multi_app::multi_update_x_bounds,
    multi_app::multi_x_navigate,
    multi_app::multi_instagram_navigate,
    multi_app::multi_open_external,
    social_share::multi_social_overlay,
    social_share::multi_social_set_labels,
    social_share::multi_social_cancel_media,
    social_share::multi_social_read_media,
    social_share::multi_social_save_media,
    inline_media::relay_inline_resolve_media,
    inline_media::relay_inline_save_media,
    inline_media::relay_inline_cancel_media,
    transcription::transcribe_voice,
    transcription::cancel_voice_transcription,
  ]);

  app
    .build(context)
    .expect("error while building Egoist Relay")
    .run(|_app, event| match event {
      tauri::RunEvent::Exit => {
        telegram_transport::shutdown();
        research_bridge::shutdown();
        inline_media::shutdown();
        transcription::shutdown();
      }
      _ => {}
    });
}

#[tauri::command]
#[cfg(target_os = "macos")]
fn mark_title_bar_overlay(window: tauri::Window, is_overlay: bool, is_mobile: Option<bool>) {
  use crate::mac;

  let mut is_mobile_val = false;

  if let Ok(mut states) = WINDOW_STATES.lock() {
    if let Some(state) = states.get_mut(window.label()) {
      state.is_overlay = is_overlay;
      // Only `Some` updates the stored flag; `None` keeps the previous value
      if let Some(mobile) = is_mobile {
        state.is_mobile = mobile;
      }
      is_mobile_val = state.is_mobile;
    }
  }

  if is_overlay {
    let position = if is_mobile_val {
      *TRAFFIC_LIGHT_POSITION_OVERLAY_MOBILE
    } else {
      *TRAFFIC_LIGHT_POSITION_OVERLAY
    };

    window
      .set_title_bar_style(tauri::utils::TitleBarStyle::Overlay)
      .unwrap_or_default();

    if let Some(base_window) = window.app_handle().get_window(window.label()) {
      mac::update_window_title(
        base_window.clone(),
        "".to_string(),
        position,
      );
    }
  } else {
    window
      .set_title_bar_style(tauri::utils::TitleBarStyle::Visible)
      .unwrap_or_default();

    // Determine the title we should restore.
    let mut title_to_set = DEFAULT_WINDOW_TITLE.to_string();
    if let Ok(states) = WINDOW_STATES.lock() {
      if let Some(state) = states.get(window.label()) {
        title_to_set = state.title.clone();
      }
    }

    if let Some(base_window) = window.app_handle().get_window(window.label()) {
      mac::update_window_title(
        base_window.clone(),
        title_to_set,
        TRAFFIC_LIGHT_POSITION_DEFAULT,
      );
    }
  }
}

#[tauri::command]
#[cfg(not(target_os = "macos"))]
#[allow(unused_variables)]
fn mark_title_bar_overlay(window: tauri::Window, is_overlay: bool, is_mobile: Option<bool>) {
  // noop
}

#[tauri::command]
fn set_notifications_count(
  window: tauri::Window,
  amount: i32,
  is_muted: bool,
  state: tauri::State<'_, AppState>,
) {
  // Update app state
  if let Ok(mut app_state) = state.lock() {
    app_state.notification_count = amount;
    app_state.is_muted = is_muted;
  }

  crate::tray::set_notifications_count(&window, amount, is_muted);
}

#[tauri::command]
fn set_menu_translations(translations: HashMap<String, String>) {
  crate::tray::set_menu_translations(translations);
}

#[tauri::command]
fn set_window_title(window: tauri::Window, title: String) {
  if let Ok(mut states) = WINDOW_STATES.lock() {
    if let Some(state) = states.get_mut(window.label()) {
      state.title = title.clone();
      if !state.is_overlay {
        window.set_title(&title).unwrap_or_default();
      }
    }
  }
}

#[tauri::command]
async fn open_new_window_cmd(app: tauri::AppHandle, url: String) -> bool {
  open_new_window(app, url).is_ok()
}

#[tauri::command]
fn save_current_url(webview: tauri::Webview) {
  if let Ok(current_url) = webview.url() {
    let url_without_hash = strip_hash_from_url(current_url.as_str());
    if let Ok(mut last_url) = LAST_URL.lock() {
      *last_url = url_without_hash;
    }
  }
}

pub(crate) fn open_new_window(
  app: tauri::AppHandle,
  url: String,
) -> Result<tauri::Window, String> {
  if app.get_window("main").is_none() {
    create_main_window(&app)?;
  }
  let window = app.get_window("main").ok_or("Main Relay window is unavailable")?;
  let webview = app.get_webview("main").ok_or("Main Relay WebView is unavailable")?;
  let current_url = webview.url().map_err(|err| err.to_string())?;
  let base_url = current_url.clone();
  let url = resolve_app_url(&url, &base_url).ok_or_else(|| format!("Disallowed app URL: {url}"))?;
  if url != current_url {
    webview.navigate(url).map_err(|err| err.to_string())?;
  }
  if !should_avoid_foreground() {
    window.show().map_err(|err| err.to_string())?;
    window.unminimize().map_err(|err| err.to_string())?;
    window.set_focus().map_err(|err| err.to_string())?;
  }
  Ok(window)
}

fn create_main_window(app: &tauri::AppHandle) -> Result<tauri::WebviewWindow, String> {
  let config = app.config().app.windows.iter().find(|window| window.label == "main")
    .ok_or("Main window configuration is missing")?;
  let mut main_builder = tauri::WebviewWindowBuilder::from_config(app, config)
    .map_err(|err| err.to_string())?
  .visible(!should_avoid_foreground())
  .focused(!should_avoid_foreground())
  .disable_drag_drop_handler()
  .initialization_script(&format!(
    "window.tauri = {{ version: '{}', updaterEnabled: {}, youtubePlayerSmoke: {} }};",
    env!("CARGO_PKG_VERSION"), WITH_UPDATER == "true", youtube_player::smoke_fixture_enabled()
  ))
  .on_download(|window, event| multi_app::handle_download(&window, "telegram", event));

  if std::env::var("EGOIST_RELAY_SMOKE_TEST").as_deref() == Ok("1") {
    let profile = std::env::var_os("EGOIST_RELAY_TEST_PROFILE")
      .map(std::path::PathBuf::from).filter(|path| path.is_absolute() && path.is_dir())
      .ok_or("Smoke checks require an existing absolute profile")?;
    main_builder = main_builder.data_directory(profile.join("main"));
  }

  let window = main_builder.build().map_err(|err| err.to_string())?;

  #[cfg(windows)]
  if let Err(error) = youtube_player::configure(&window, &app.config().identifier) {
    log::warn!("[EgoistRelay] {error}");
  }

  if let Ok(mut states) = WINDOW_STATES.lock() {
    let new_state = WindowState {
      title: DEFAULT_WINDOW_TITLE.to_string(),
      is_overlay: cfg!(target_os = "macos"),
      is_mobile: false,
    };
    states.insert("main".to_string(), new_state);
  }

  #[cfg(target_os = "macos")]
  if let Some(base_window) = app.get_window("main") {
    mac::setup_traffic_light_positioner(&base_window, *TRAFFIC_LIGHT_POSITION_OVERLAY);
  }

  // Apply stored notification count to the new window
  if let Some(state) = app.try_state::<AppState>() {
    if let Ok(app_state) = state.lock() {
      crate::tray::set_notifications_count(
        &window.as_ref().window(),
        app_state.notification_count,
        app_state.is_muted,
      );
    }
  }

  Ok(window)
}

fn resolve_app_url(url: &str, base_url: &Url) -> Option<Url> {
  let url = base_url.join(url).ok()?;

  is_allowed_app_url(&url, base_url).then_some(url)
}

fn is_allowed_app_url(url: &Url, base_url: &Url) -> bool {
  matches!(url.scheme(), "http" | "https" | "tauri")
    && url.scheme() == base_url.scheme()
    && url.host_str() == base_url.host_str()
    && url.port_or_known_default() == base_url.port_or_known_default()
    && url.username().is_empty()
    && url.password().is_none()
}

#[cfg(test)]
mod app_url_tests {
  use super::*;

  #[test]
  fn preserves_local_navigation_and_removes_message_hashes() {
    let base = Url::parse("http://tauri.localhost/").unwrap();
    assert!(resolve_app_url("/#12345", &base).is_some());
    assert_eq!(strip_hash_from_url("http://tauri.localhost/#12345"), "http://tauri.localhost/");
  }

  #[test]
  fn rejects_remote_and_privileged_window_urls() {
    let base = Url::parse("http://tauri.localhost/").unwrap();
    for value in ["https://x.com/", "file:///C:/Windows/", "javascript:alert(1)",
      "http://user@tauri.localhost/", "http://tauri.localhost:9000/", "//example.com/"] {
      assert!(resolve_app_url(value, &base).is_none(), "{value}");
    }
  }
}
