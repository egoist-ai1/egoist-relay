use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Position, Rect, Size, Webview, WebviewBuilder, WebviewUrl};
use url::Url;

const MAX_URL_BYTES: usize = 65_536;
const MAX_EVENT_BYTES: usize = 1_048_576;
const MAX_APPS: usize = 32;
const BRIDGE_SCRIPT: &str = include_str!("../../scripts/mini-app-bridge.js");
const EVENT_NAME: &str = "relay-mini-app-event";

#[derive(Clone)]
struct MiniApp {
  origin: String,
  nonce: String,
  navigation_id: Option<u64>,
  ready: bool,
  popups: Vec<String>,
  visible: bool,
}

static APPS: LazyLock<Mutex<HashMap<String, MiniApp>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MiniAppBounds {
  x: i32,
  y: i32,
  width: i32,
  height: i32,
}

fn label_for_id(id: &str) -> Result<String, String> {
  let parsed = uuid::Uuid::parse_str(id).map_err(|_| "MINI_APP_INVALID_ID")?;
  if parsed.to_string() != id { return Err("MINI_APP_INVALID_ID".into()); }
  Ok(format!("mini-app-{id}"))
}

fn parse_app_url(value: &str) -> Result<Url, String> {
  if value.len() > MAX_URL_BYTES || value.chars().any(char::is_control) {
    return Err("MINI_APP_INVALID_URL".into());
  }
  let url = Url::parse(value).map_err(|_| "MINI_APP_INVALID_URL")?;
  if url.scheme() != "https" || url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() {
    return Err("MINI_APP_INVALID_URL".into());
  }
  Ok(url)
}

fn parse_bridge_event(message: &str, source: &str, current_source: &str, app: &MiniApp) -> Option<String> {
  if message.len() > MAX_EVENT_BYTES || !app.ready { return None; }
  let mut source = parse_app_url(source).ok()?;
  let mut current = parse_app_url(current_source).ok()?;
  source.set_fragment(None); current.set_fragment(None);
  if source != current || source.origin().ascii_serialization() != app.origin { return None; }
  let data = message.strip_prefix(&format!("{}:", app.nonce))?;
  let parsed: Value = serde_json::from_str(data).ok()?;
  if parsed.get("generation")?.as_str()? != app.navigation_id?.to_string() { return None; }
  let name = parsed.get("eventType")?.as_str()?;
  if name.len() > 128 || !(name.starts_with("web_app_") || matches!(name, "iframe_ready" | "iframe_will_reload")) {
    return None;
  }
  Some(parsed.to_string())
}

fn emit(app: &AppHandle, id: &str, kind: &str, data: Option<String>) {
  let _ = app.emit_to("main", EVENT_NAME, json!({ "id": id, "kind": kind, "data": data }));
}

fn apply_bounds(app: &AppHandle, target: &Webview, bounds: MiniAppBounds) -> Result<(), String> {
  let main = app.get_window("main").ok_or("MINI_APP_MAIN_UNAVAILABLE")?;
  let physical = main.inner_size().map_err(|_| "MINI_APP_BOUNDS_UNAVAILABLE")?;
  let scale = main.scale_factor().map_err(|_| "MINI_APP_BOUNDS_UNAVAILABLE")?;
  if !scale.is_finite() || scale <= 0.0 || bounds.x < 0 || bounds.y < 0 || bounds.width <= 0 || bounds.height <= 0 {
    return Err("MINI_APP_INVALID_BOUNDS".into());
  }
  let width = (physical.width as f64 / scale).floor() as i32;
  let height = (physical.height as f64 / scale).floor() as i32;
  let right = bounds.x.saturating_add(bounds.width).min(width);
  let bottom = bounds.y.saturating_add(bounds.height).min(height);
  if right <= bounds.x || bottom <= bounds.y { return Err("MINI_APP_INVALID_BOUNDS".into()); }
  target.set_bounds(Rect {
    position: Position::Logical(LogicalPosition::new(bounds.x as f64, bounds.y as f64)),
    size: Size::Logical(LogicalSize::new((right - bounds.x) as f64, (bottom - bounds.y) as f64)),
  }).map_err(|_| "MINI_APP_BOUNDS_UNAVAILABLE".into())
}

#[tauri::command]
pub(crate) async fn relay_mini_app_open(webview: Webview, app_handle: AppHandle, id: String, url: String, bounds: MiniAppBounds) -> Result<(), String> {
  crate::social_share::require_main(&webview)?;
  let label = label_for_id(&id)?;
  let url = parse_app_url(&url)?;
  #[cfg(not(windows))]
  { let _ = (app_handle, label, url, bounds); return Err("MINI_APP_UNSUPPORTED".into()); }
  #[cfg(windows)]
  {
    let nonce = uuid::Uuid::new_v4().to_string();
    {
      let mut apps = APPS.lock().map_err(|_| "MINI_APP_UNAVAILABLE")?;
      if apps.contains_key(&id) || apps.len() >= MAX_APPS { return Err("MINI_APP_UNAVAILABLE".into()); }
      apps.insert(id.clone(), MiniApp { origin: url.origin().ascii_serialization(), nonce: nonce.clone(), navigation_id: None, ready: false, popups: Vec::new(), visible: false });
    }
    let create = (|| {
      let main = app_handle.get_window("main").ok_or("MINI_APP_MAIN_UNAVAILABLE")?;
      let data_dir = crate::multi_app::get_service_data_directory(&app_handle, "mini-apps")?;
      std::fs::create_dir_all(&data_dir).map_err(|_| "MINI_APP_PROFILE_UNAVAILABLE")?;
      let script = BRIDGE_SCRIPT.replace("'__RELAY_MINI_APP_NONCE__'", &serde_json::to_string(&nonce).unwrap());
      let popup_app = app_handle.clone(); let popup_id = id.clone();
      let builder = WebviewBuilder::new(&label, WebviewUrl::External(Url::parse("about:blank").unwrap()))
        .focused(false).data_directory(data_dir).disable_drag_drop_handler()
        .background_color(crate::native_theme::background_color())
        .initialization_script(script)
        .on_navigation(|next| next.as_str() == "about:blank" || parse_app_url(next.as_str()).is_ok())
        .on_new_window(move |next, features| create_popup(&popup_app, &popup_id, next, features))
        .on_download(|view, event| crate::multi_app::handle_download(&view, "telegram", event));
      // The browser engine uses the current Windows/PAC policy for documents and subresources.
      // No URL-specific proxy is pinned to this multi-origin WebView.
      let view = main.add_child(builder, LogicalPosition::new(bounds.x as f64, bounds.y as f64),
        LogicalSize::new(bounds.width.max(1) as f64, bounds.height.max(1) as f64)).map_err(|_| "MINI_APP_CREATE_FAILED")?;
      view.hide().map_err(|_| "MINI_APP_VISIBILITY_FAILED")?;
      apply_bounds(&app_handle, &view, bounds)?;
      crate::multi_app::install_browser_native_hooks(&view)?;
      install_bridge(&view, id.clone(), url)?;
      Ok(())
    })();
    if create.is_err() {
      APPS.lock().map_err(|_| "MINI_APP_UNAVAILABLE")?.remove(&id);
      if let Some(view) = app_handle.get_webview(&label) {
        let _ = crate::multi_app::release_browser_native_hooks(&view);
        let _ = view.close();
      }
    }
    create
  }
}

#[cfg(windows)]
fn create_popup(app: &AppHandle, owner_id: &str, url: Url, features: tauri::webview::NewWindowFeatures) -> tauri::webview::NewWindowResponse<tauri::Wry> {
  use tauri::webview::NewWindowResponse;
  if url.as_str() != "about:blank" && parse_app_url(url.as_str()).is_err() { return NewWindowResponse::Deny; }
  let label = format!("mini-app-popup-{}", uuid::Uuid::new_v4());
  let registered = APPS.lock().ok().is_some_and(|mut apps| {
    let Some(owner) = apps.get_mut(owner_id) else { return false; };
    if owner.popups.len() >= 8 { return false; }
    owner.popups.push(label.clone()); true
  });
  if !registered { return NewWindowResponse::Deny; }
  let result = (|| -> Result<tauri::WebviewWindow, String> {
    let main = app.get_window("main").ok_or("MINI_APP_MAIN_UNAVAILABLE")?;
    // window_features reuses the opener's exact WebView2 environment, preserving window.opener
    // and its existing Windows network policy. The popup has no Relay host permissions or bridge.
    let builder = tauri::WebviewWindowBuilder::new(app, &label, WebviewUrl::External(Url::parse("about:blank").unwrap()))
      .inner_size(960.0, 720.0).min_inner_size(480.0, 360.0).window_features(features)
      .title(format!("Relay · {}", url.host_str().unwrap_or("Mini App")))
      .theme(Some(crate::native_theme::window_theme())).background_color(crate::native_theme::background_color()).visible(false).focused(false).disable_drag_drop_handler()
      .on_navigation(|next| next.as_str() == "about:blank" || parse_app_url(next.as_str()).is_ok())
      .on_new_window(|_, _| NewWindowResponse::Deny)
      .on_download(|view, event| crate::multi_app::handle_download(&view, "telegram", event))
      .owner_raw(main.hwnd().map_err(|_| "MINI_APP_POPUP_FAILED")?);
    let window = builder.build().map_err(|_| "MINI_APP_POPUP_FAILED")?;
    let event_app = app.clone(); let event_id = owner_id.to_string(); let event_label = label.clone();
    window.on_window_event(move |event| {
      if matches!(event, tauri::WindowEvent::Destroyed) {
        if let Ok(mut apps) = APPS.lock() {
          if let Some(owner) = apps.get_mut(&event_id) { owner.popups.retain(|label| label != &event_label); }
        }
        let _ = crate::multi_app::release_browser_native_hooks_by_label(&event_app, &event_label);
      }
    });
    if let Some(view) = app.get_webview(&label) { let _ = crate::multi_app::install_browser_native_hooks(&view); }
    if APPS.lock().is_ok_and(|apps| apps.get(owner_id).is_some_and(|owner| owner.visible)) {
      let _ = window.show(); let _ = window.set_focus();
    }
    Ok(window)
  })();
  match result {
    Ok(window) => NewWindowResponse::Create { window },
    Err(_) => {
      if let Ok(mut apps) = APPS.lock() {
        if let Some(owner) = apps.get_mut(owner_id) { owner.popups.retain(|current| current != &label); }
      }
      emit(app, owner_id, "error", None);
      NewWindowResponse::Deny
    }
  }
}

#[tauri::command]
pub(crate) fn relay_mini_app_update(webview: Webview, app_handle: AppHandle, id: String, bounds: Option<MiniAppBounds>, visible: bool) -> Result<(), String> {
  crate::social_share::require_main(&webview)?;
  let target = app_handle.get_webview(&label_for_id(&id)?).ok_or("MINI_APP_UNAVAILABLE")?;
  if visible { apply_bounds(&app_handle, &target, bounds.ok_or("MINI_APP_INVALID_BOUNDS")?)?; }
  let popups = {
    let mut apps = APPS.lock().map_err(|_| "MINI_APP_UNAVAILABLE")?;
    let owner = apps.get_mut(&id).ok_or("MINI_APP_UNAVAILABLE")?;
    owner.visible = visible; owner.popups.clone()
  };
  for label in popups {
    if let Some(window) = app_handle.get_webview_window(&label) {
      let result = if visible { window.show() } else { window.hide() };
      result.map_err(|_| "MINI_APP_VISIBILITY_FAILED")?;
    }
  }
  (if visible { target.show() } else { target.hide() }).map_err(|_| "MINI_APP_VISIBILITY_FAILED".into())
}

#[tauri::command]
pub(crate) fn relay_mini_app_reload(webview: Webview, app_handle: AppHandle, id: String, url: String) -> Result<(), String> {
  crate::social_share::require_main(&webview)?;
  let label = label_for_id(&id)?;
  let url = parse_app_url(&url)?;
  {
    let mut apps = APPS.lock().map_err(|_| "MINI_APP_UNAVAILABLE")?;
    let state = apps.get_mut(&id).ok_or("MINI_APP_UNAVAILABLE")?;
    state.origin = url.origin().ascii_serialization(); state.ready = false;
  }
  app_handle.get_webview(&label).ok_or("MINI_APP_UNAVAILABLE")?.navigate(url).map_err(|_| "MINI_APP_NAVIGATION_FAILED".into())
}

#[tauri::command]
pub(crate) fn relay_mini_app_send(webview: Webview, app_handle: AppHandle, id: String, event: Value) -> Result<(), String> {
  crate::social_share::require_main(&webview)?;
  let label = label_for_id(&id)?;
  let event_name = event.get("eventType").and_then(Value::as_str).ok_or("MINI_APP_INVALID_EVENT")?;
  if event_name.len() > 128 || event.to_string().len() > MAX_EVENT_BYTES { return Err("MINI_APP_INVALID_EVENT".into()); }
  let (origin, nonce, generation) = {
    let apps = APPS.lock().map_err(|_| "MINI_APP_UNAVAILABLE")?;
    let current = apps.get(&id).ok_or("MINI_APP_UNAVAILABLE")?;
    if !current.ready { return Ok(()); }
    (current.origin.clone(), current.nonce.clone(), current.navigation_id.ok_or("MINI_APP_UNAVAILABLE")?.to_string())
  };
  #[cfg(windows)]
  {
    use windows_core::{HSTRING, PWSTR};
    let target = app_handle.get_webview(&label).ok_or("MINI_APP_UNAVAILABLE")?;
    target.with_webview(move |platform| {
      let result = (|| -> windows_core::Result<()> {
        unsafe {
          let core = platform.controller().CoreWebView2()?;
          let mut source = PWSTR::null(); core.Source(&mut source)?;
          let source = webview2_com::take_pwstr(source);
          if !parse_app_url(&source).is_ok_and(|url| url.origin().ascii_serialization() == origin) { return Ok(()); }
          core.PostWebMessageAsJson(&HSTRING::from(json!({"nonce": nonce, "generation": generation, "event": event}).to_string()))?;
        }
        Ok(())
      })();
      if result.is_err() { emit(&app_handle, &id, "error", None); }
    }).map_err(|_| "MINI_APP_UNAVAILABLE".into())
  }
  #[cfg(not(windows))]
  { let _ = (app_handle, label, origin, nonce, generation, event); Err("MINI_APP_UNSUPPORTED".into()) }
}

#[tauri::command]
pub(crate) fn relay_mini_app_close(webview: Webview, app_handle: AppHandle, id: String) -> Result<(), String> {
  crate::social_share::require_main(&webview)?;
  let label = label_for_id(&id)?;
  let owner = APPS.lock().map_err(|_| "MINI_APP_UNAVAILABLE")?.remove(&id);
  if let Some(owner) = owner {
    for popup in owner.popups {
      if let Some(view) = app_handle.get_webview(&popup) { let _ = crate::multi_app::release_browser_native_hooks(&view); }
      if let Some(window) = app_handle.get_webview_window(&popup) { let _ = window.destroy(); }
    }
  }
  if let Some(view) = app_handle.get_webview(&label) {
    crate::multi_app::release_browser_native_hooks(&view)?;
    view.close().map_err(|_| "MINI_APP_CLOSE_FAILED")?;
  }
  Ok(())
}

#[cfg(windows)]
fn install_bridge(view: &Webview, id: String, url: Url) -> Result<(), String> {
  use webview2_com::{take_pwstr, AcceleratorKeyPressedEventHandler, NavigationCompletedEventHandler, NavigationStartingEventHandler, WebMessageReceivedEventHandler};
  use windows_core::{HSTRING, PWSTR};
  let app = view.app_handle().clone();
  view.with_webview(move |platform| {
    let installed = (|| -> windows_core::Result<()> {
      unsafe {
        let core = platform.controller().CoreWebView2()?;
        let mut registration = 0;
        let event_app = app.clone(); let event_id = id.clone();
        core.add_WebMessageReceived(&WebMessageReceivedEventHandler::create(Box::new(move |sender, args| {
          let (Some(sender), Some(args)) = (sender, args) else { return Ok(()); };
          let mut message = PWSTR::null();
          if args.TryGetWebMessageAsString(&mut message).is_err() { return Ok(()); }
          let message = take_pwstr(message);
          let mut source = PWSTR::null(); args.Source(&mut source)?; let source = take_pwstr(source);
          let mut current = PWSTR::null(); sender.Source(&mut current)?; let current = take_pwstr(current);
          let data = APPS.lock().ok().and_then(|apps| apps.get(&event_id).and_then(|state| parse_bridge_event(&message, &source, &current, state)));
          if let Some(data) = data { emit(&event_app, &event_id, "event", Some(data)); }
          Ok(())
        })), &mut registration)?;
        let started_app = app.clone(); let started_id = id.clone();
        core.add_NavigationStarting(&NavigationStartingEventHandler::create(Box::new(move |_, args| {
          let Some(args) = args else { return Ok(()); };
          let mut navigation_id = 0; args.NavigationId(&mut navigation_id)?;
          let registered = APPS.lock().ok().is_some_and(|mut apps| {
            let Some(state) = apps.get_mut(&started_id) else { return false; };
            state.navigation_id = Some(navigation_id); state.ready = false; true
          });
          if registered { emit(&started_app, &started_id, "loading", None); }
          Ok(())
        })), &mut registration)?;
        let loaded_app = app.clone(); let loaded_id = id.clone();
        core.add_NavigationCompleted(&NavigationCompletedEventHandler::create(Box::new(move |sender, args| {
          let (Some(sender), Some(args)) = (sender, args) else { return Ok(()); };
          let mut navigation_id = 0; args.NavigationId(&mut navigation_id)?;
          let mut success = false.into(); args.IsSuccess(&mut success)?;
          let mut source = PWSTR::null(); sender.Source(&mut source)?; let source = take_pwstr(source);
          let is_current = APPS.lock().ok().is_some_and(|mut apps| {
            let Some(state) = apps.get_mut(&loaded_id) else { return false; };
            if state.navigation_id != Some(navigation_id) { return false; }
            state.ready = success.as_bool() && parse_app_url(&source).is_ok_and(|url| url.origin().ascii_serialization() == state.origin);
            true
          });
          if !is_current { return Ok(()); }
          if success.as_bool() {
            let script = format!("window.__egoistRelayMiniAppBind?.({})", serde_json::to_string(&navigation_id.to_string()).unwrap());
            sender.ExecuteScript(&HSTRING::from(script), None)?;
          }
          emit(&loaded_app, &loaded_id, if success.as_bool() { "loaded" } else { "error" }, None);
          Ok(())
        })), &mut registration)?;
        let escape_app = app.clone(); let escape_id = id.clone();
        platform.controller().add_AcceleratorKeyPressed(&AcceleratorKeyPressedEventHandler::create(Box::new(move |_, args| {
          let Some(args) = args else { return Ok(()); };
          use webview2_com::Microsoft::Web::WebView2::Win32::{COREWEBVIEW2_KEY_EVENT_KIND, COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN, COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN, COREWEBVIEW2_PHYSICAL_KEY_STATUS};
          let mut key = 0; args.VirtualKey(&mut key)?;
          let mut kind = COREWEBVIEW2_KEY_EVENT_KIND::default(); args.KeyEventKind(&mut kind)?;
          if key != 0x1b || !(kind == COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN || kind == COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN) { return Ok(()); }
          args.SetHandled(true)?;
          let mut physical = COREWEBVIEW2_PHYSICAL_KEY_STATUS::default(); args.PhysicalKeyStatus(&mut physical)?;
          if physical.WasKeyDown.as_bool() || physical.RepeatCount > 1 { return Ok(()); }
          if APPS.lock().is_ok_and(|apps| apps.contains_key(&escape_id)) {
            let app = escape_app.clone(); let id = escape_id.clone();
            tauri::async_runtime::spawn(async move {
              if let Some(main) = app.get_webview("main") { let _ = main.set_focus(); }
              emit(&app, &id, "escape", None);
            });
          }
          Ok(())
        })), &mut registration)?;
        core.Navigate(&HSTRING::from(url.as_str()))?;
      }
      Ok(())
    })();
    if installed.is_err() { emit(&app, &id, "error", None); }
  }).map_err(|_| "MINI_APP_BRIDGE_FAILED".into())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn host_permissions_are_not_uuid_label_permissions() {
    let id = "b44f751e-320a-4fb3-a212-615578106989";
    assert_eq!(label_for_id(id).unwrap(), format!("mini-app-{id}"));
    assert!(label_for_id("../../main").is_err());
    assert!(label_for_id("B44F751E-320A-4FB3-A212-615578106989").is_err());
  }

  #[test]
  fn source_accepts_https_and_keeps_init_fragment_without_credentials_or_controls() {
    let value = "https://shop.example/app#tgWebAppData=query_id%3Dtest%26user%3D%257B%257D&tgWebAppPlatform=weba";
    assert_eq!(parse_app_url(value).unwrap().as_str(), value);
    for invalid in ["http://shop.example", "file:///secret", "javascript:alert(1)", "https://user:secret@shop.example", "https://shop.example/\n"] {
      assert!(parse_app_url(invalid).is_err());
    }
  }

  #[test]
  fn bridge_is_bound_to_current_top_level_origin_nonce_and_size() {
    let state = MiniApp { origin: "https://shop.example".into(), nonce: "owned".into(), navigation_id: Some(7), ready: true, popups: Vec::new(), visible: false };
    let source = "https://shop.example/app";
    let data = "owned:{\"eventType\":\"web_app_ready\",\"generation\":\"7\"}";
    assert!(parse_bridge_event(data, source, source, &state).is_some());
    assert!(parse_bridge_event(data, &format!("{source}#tgWebAppData=test"), source, &state).is_some());
    assert!(parse_bridge_event(&data.replace("7", "6"), source, source, &state).is_none());
    let pending = MiniApp { ready: false, ..state.clone() };
    assert!(parse_bridge_event(data, source, source, &pending).is_none());
    assert!(parse_bridge_event(data, source, "https://shop.example/other", &state).is_none());
    assert!(parse_bridge_event(data, "https://other.example", "https://other.example", &state).is_none());
    assert!(parse_bridge_event(&data.replace("owned", "foreign"), source, source, &state).is_none());
    assert!(parse_bridge_event("owned:{\"eventType\":\"execute_shell\"}", source, source, &state).is_none());
    assert!(parse_bridge_event(&"x".repeat(MAX_EVENT_BYTES + 1), source, source, &state).is_none());
  }
}
