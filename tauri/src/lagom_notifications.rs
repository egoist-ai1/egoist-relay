use serde::{Deserialize, Serialize};
use std::{
  cell::RefCell,
  collections::VecDeque,
  hash::{DefaultHasher, Hash, Hasher},
  path::PathBuf,
  slice,
  sync::atomic::{AtomicU8, AtomicU64, Ordering},
  time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, Webview};
use url::Url;
use uuid::Uuid;
use webview2_com::{
  CoTaskMemPWSTR,
  Microsoft::Web::WebView2::Win32::{
    COREWEBVIEW2_PERMISSION_KIND, COREWEBVIEW2_PERMISSION_KIND_NOTIFICATIONS,
    COREWEBVIEW2_PERMISSION_STATE_ALLOW, COREWEBVIEW2_PERMISSION_STATE_DENY,
    ICoreWebView2, ICoreWebView2_13, ICoreWebView2_24, ICoreWebView2Notification, ICoreWebView2Profile4,
    ICoreWebView2PermissionRequestedEventArgs3,
  },
  NotificationReceivedEventHandler, PermissionRequestedEventHandler,
  SetPermissionStateCompletedHandler,
};
use windows_core::{HSTRING, Interface, PCWSTR, PWSTR};

#[path = "lagom_notification_queue.rs"]
mod queue;
use queue::{Offer, PendingNotices};

#[path = "lagom_notification_avatar.rs"]
mod avatar;

#[path = "lagom_notification_native_system.rs"]
mod system;

const MAX_TITLE: usize = 256;
const MAX_BODY: usize = 2048;
const MAX_ICON: usize = 128 * 1024;
const MAX_SHOWN: usize = 64;
const AVATAR_WAIT: Duration = Duration::from_millis(600);
const X_NOTICES: u8 = 1;
const INSTAGRAM_NOTICES: u8 = 2;
static SOCIAL_NOTICES: AtomicU8 = AtomicU8::new(0);
static SOUND_VOLUME: AtomicU8 = AtomicU8::new(5);
static LOCK_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Service {
  Telegram,
  X,
  Instagram,
}

impl Service {
  fn name(self) -> &'static str {
    match self {
      Self::Telegram => "Telegram",
      Self::X => "X",
      Self::Instagram => "Instagram",
    }
  }
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TelegramTarget {
  chat_id: Option<String>,
  message_id: Option<i32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TelegramNotice {
  title: String,
  body: String,
  icon: Option<String>,
  volume: u8,
  is_silent: bool,
  target: TelegramTarget,
}

enum Target {
  Telegram(TelegramTarget),
  Web(ICoreWebView2Notification),
}

struct Content {
  service: Service,
  title: String,
  body: String,
  icon: Option<String>,
  volume: f64,
  id: Uuid,
  redacted: bool,
}

struct Notice {
  content: Content,
  target: Target,
  avatar_url: Option<Url>,
}

impl Notice {
  fn duplicate_key(&self) -> Option<u64> {
    let Target::Telegram(target) = &self.target else { return None; };
    let mut hasher = DefaultHasher::new();
    (
      target.chat_id.as_deref()?,
      target.message_id?,
      &self.content.title,
      &self.content.body,
      self.content.volume.to_bits(),
    ).hash(&mut hasher);
    Some(hasher.finish())
  }

  fn hide_preview(&mut self) {
    (self.content.title, self.content.body, self.content.icon) =
      private_preview(self.content.service);
    self.avatar_url = None;
    self.content.redacted = true;
    if let Target::Telegram(target) = &mut self.target {
      *target = TelegramTarget::default();
    }
  }
}

struct Delivered {
  id: Uuid,
  service: Service,
  target: Target,
  redacted: bool,
  since: Instant,
  notification: system::SystemToast,
}

struct Center {
  pending: PendingNotices<Notice>,
  preparing: Option<Notice>,
  delivered: VecDeque<Delivered>,
}

thread_local! {
  static CENTER: RefCell<Center> = const { RefCell::new(Center {
    pending: PendingNotices::new(),
    preparing: None,
    delivered: VecDeque::new(),
  }) };
}

fn can_notify(app: &AppHandle) -> bool {
  !crate::is_research_headless()
    && (!crate::is_background_control() || notification_smoke_enabled())
    && app.get_window("main").is_some()
}

pub(crate) fn notification_smoke_enabled() -> bool {
  notice_smoke_profile().is_some()
}

fn notice_smoke_profile() -> Option<PathBuf> {
  if std::env::var("EGOIST_RELAY_SMOKE_TEST").as_deref() != Ok("1")
    || std::env::var("EGOIST_RELAY_SMOKE_NOTIFICATIONS").as_deref() != Ok("1")
    || std::env::var("EGOIST_RELAY_CONTROL_MODE").as_deref() == Ok("background")
  {
    return None;
  }
  std::env::var_os("EGOIST_RELAY_TEST_PROFILE")
    .map(PathBuf::from)
    .filter(|path| path.is_absolute() && path.is_dir())
}

pub(crate) fn set_social_notice_settings(app: &AppHandle, x_enabled: bool, instagram_enabled: bool, volume: u8) {
  SOUND_VOLUME.store(volume.min(10), Ordering::Relaxed);
  let enabled = u8::from(x_enabled) * X_NOTICES | u8::from(instagram_enabled) * INSTAGRAM_NOTICES;
  let changed = SOCIAL_NOTICES.swap(enabled, Ordering::AcqRel) ^ enabled;
  for (mask, service, label) in [
    (X_NOTICES, Service::X, "x_webview"),
    (INSTAGRAM_NOTICES, Service::Instagram, "instagram_webview"),
  ] {
    if changed & mask == 0 {
      continue;
    }
    if let Some(view) = app.get_webview(label) {
      let _ = view.with_webview(move |platform| {
        let result = unsafe { platform.controller().CoreWebView2() }
          .and_then(|core| apply_profile_permission(&core, service, is_service_enabled(service)));
        if let Err(error) = result {
          log::debug!("[LagomAlerts] Could not set service notification permission: {error}");
        }
      });
    }
  }
}

fn is_service_enabled(service: Service) -> bool {
  let enabled = SOCIAL_NOTICES.load(Ordering::Acquire);
  match service {
    Service::Telegram => true,
    Service::X => enabled & X_NOTICES != 0,
    Service::Instagram => enabled & INSTAGRAM_NOTICES != 0,
  }
}

fn service_origins(service: Service) -> &'static [&'static str] {
  match service {
    Service::Telegram => &[],
    Service::X => &["https://x.com", "https://www.x.com", "https://twitter.com", "https://www.twitter.com"],
    Service::Instagram => &["https://instagram.com", "https://www.instagram.com"],
  }
}

fn trusted_origin(service: Service, raw: &str) -> bool {
  let Ok(url) = Url::parse(raw) else {
    return false;
  };
  if url.scheme() != "https"
    || url.port().is_some()
    || !url.username().is_empty()
    || url.password().is_some()
  {
    return false;
  }
  service_origins(service).contains(&url.origin().ascii_serialization().as_str())
}

fn apply_profile_permission(core: &ICoreWebView2, service: Service, enabled: bool) -> windows_core::Result<()> {
  let profile = unsafe { core.cast::<ICoreWebView2_13>()?.Profile()? }.cast::<ICoreWebView2Profile4>()?;
  let state = if enabled { COREWEBVIEW2_PERMISSION_STATE_ALLOW } else { COREWEBVIEW2_PERMISSION_STATE_DENY };
  for origin in service_origins(service) {
    let origin = HSTRING::from(*origin);
    let handler = SetPermissionStateCompletedHandler::create(Box::new(move |result| {
      if let Err(error) = result {
        log::debug!("[LagomAlerts] Service notification permission was not saved: {error}");
      }
      Ok(())
    }));
    unsafe {
      profile.SetPermissionState(COREWEBVIEW2_PERMISSION_KIND_NOTIFICATIONS, PCWSTR(origin.as_ptr()), state, &handler)?;
    }
  }
  Ok(())
}

fn valid_icon(icon: &str) -> bool {
  let Some((media_type, payload)) = icon.split_once(',') else {
    return false;
  };
  if icon.len() > MAX_ICON
    || !matches!(
      media_type,
      "data:image/png;base64"
        | "data:image/jpeg;base64"
        | "data:image/gif;base64"
        | "data:image/webp;base64"
    )
  {
    return false;
  }
  let data = payload.trim_end_matches('=');
  !data.is_empty()
    && payload.len() % 4 == 0
    && payload.len() - data.len() <= 2
    && data
      .bytes()
      .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/'))
}

unsafe fn read_web_string(
  read: impl FnOnce(*mut PWSTR) -> windows_core::Result<()>,
  limit: usize,
) -> windows_core::Result<String> {
  let mut value = PWSTR::null();
  let result = read(&mut value);
  let _allocation = CoTaskMemPWSTR::from(value);
  result?;
  if value.is_null() {
    return Ok(String::new());
  }
  let start = value.as_ptr();
  for length in 0..=limit {
    if unsafe { *start.add(length) } == 0 {
      return Ok(String::from_utf16_lossy(unsafe {
        slice::from_raw_parts(start, length)
      }));
    }
  }
  Ok(String::new())
}

pub(crate) fn install(view: &Webview, service: Service) -> tauri::Result<()> {
  let app = view.app_handle().clone();
  view.with_webview(move |platform| {
    let install = || unsafe {
      let core = platform.controller().CoreWebView2()?;
      let notifications = core.cast::<ICoreWebView2_24>()?;
      let mut token = 0;
      notifications.add_NotificationReceived(
        &NotificationReceivedEventHandler::create(Box::new(move |_, args| {
          let Some(args) = args else {
            return Ok(());
          };
          let origin = read_web_string(|value| args.SenderOrigin(value), 2048)?;
          if !trusted_origin(service, &origin) {
            return Ok(());
          }
          let notification = args.Notification()?;
          args.SetHandled(true)?;
          if !is_service_enabled(service) || !can_notify(&app) {
            let _ = notification.ReportClosed();
            return Ok(());
          }
          let mut is_silent = windows_core::BOOL::from(true);
          let _ = notification.IsSilent(&mut is_silent);
          let volume = if is_silent.as_bool() {
            0
          } else {
            SOUND_VOLUME.load(Ordering::Relaxed)
          };
          let (title, body, icon, avatar_url) = if crate::workspace_privacy::is_locked() {
            let (title, body, icon) = private_preview(service);
            (title, body, icon, None)
          } else {
            let title = read_web_string(|value| notification.Title(value), MAX_TITLE * 4).unwrap_or_default();
            let body = read_web_string(|value| notification.Body(value), MAX_BODY * 4).unwrap_or_default();
            let raw_icon = read_web_string(|value| notification.IconUri(value), MAX_ICON).unwrap_or_default();
            let avatar_url = avatar::trusted_url(service, &raw_icon);
            let icon = valid_icon(&raw_icon).then_some(raw_icon);
            (title, body, icon, avatar_url)
          };
          let Some(content) = make_content(service, title, body, icon, volume) else {
            let _ = notification.ReportClosed();
            return Ok(());
          };
          offer_notice(
            &app,
            Notice {
              content,
              target: Target::Web(notification),
              avatar_url,
            },
          );
          Ok(())
        })),
        &mut token,
      )?;
      let mut permissions = 0;
      let permission = core.add_PermissionRequested(
        &PermissionRequestedEventHandler::create(Box::new(move |_, args| {
          let Some(args) = args else {
            return Ok(());
          };
          let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
          args.PermissionKind(&mut kind)?;
          if kind != COREWEBVIEW2_PERMISSION_KIND_NOTIFICATIONS {
            return Ok(());
          }
          let origin = read_web_string(|value| args.Uri(value), 2048)?;
          if is_service_enabled(service) && trusted_origin(service, &origin)
            && let Ok(temporary) = args.cast::<ICoreWebView2PermissionRequestedEventArgs3>()
          {
            temporary.SetSavesInProfile(false)?;
            args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)?;
          }
          Ok(())
        })),
        &mut permissions,
      );
      if permission.is_err() {
        let _ = notifications.remove_NotificationReceived(token);
      } else if is_service_enabled(service) && let Err(error) = apply_profile_permission(&core, service, true) {
        log::debug!("[LagomAlerts] Could not initialize service notification permission: {error}");
      }
      permission
    };
    if let Err(error) = install() {
      log::debug!("[LagomAlerts] WebView2 notification integration unavailable: {error}");
    }
  })
}

#[tauri::command]
pub(crate) async fn relay_lagom_telegram_notice(
  webview: Webview,
  notice: TelegramNotice,
) -> Result<bool, String> {
  if webview.label() != "main" {
    return Err("Only the main view may display notices".into());
  }
  let app = webview.app_handle().clone();
  let lock_sequence = LOCK_SEQUENCE.load(Ordering::Relaxed);
  if !can_notify(&app) {
    return Ok(crate::workspace_privacy::is_locked());
  }
  SOUND_VOLUME.store(notice.volume.min(10), Ordering::Relaxed);
  let Some(content) = make_content(
    Service::Telegram,
    notice.title,
    notice.body,
    notice.icon,
    if notice.is_silent { 0 } else { notice.volume },
  ) else {
    return Ok(false);
  };
  let ui = app.clone();
  let (send, receive) = tokio::sync::oneshot::channel();
  app
    .run_on_main_thread(move || {
      let mut notice = Notice {
        content,
        target: Target::Telegram(notice.target),
        avatar_url: None,
      };
      let crossed_lock = lock_sequence != LOCK_SEQUENCE.load(Ordering::Relaxed);
      if crossed_lock {
        notice.hide_preview();
      }
      let accepted = offer_notice(&ui, notice);
      // Текст, полученный перед блокировкой, не должен уйти в системное превью.
      let _ = send.send(accepted || crossed_lock || crate::workspace_privacy::is_locked());
    })
    .map_err(|error| error.to_string())?;
  receive.await.map_err(|error| error.to_string())
}

fn make_content(
  service: Service,
  title: String,
  body: String,
  icon: Option<String>,
  volume: u8,
) -> Option<Content> {
  let redacted = crate::workspace_privacy::is_locked();
  let (title, body, icon) = if redacted {
    private_preview(service)
  } else {
    (title, body, icon)
  };
  let mut title = bounded_text(&title, MAX_TITLE);
  let mut body = bounded_text(&body, MAX_BODY);
  if title.is_empty() && body.is_empty() {
    if service == Service::Telegram {
      return None;
    }
    (title, body, _) = private_preview(service);
  }
  let icon = icon.filter(|value| valid_icon(value));
  Some(Content {
    service,
    title,
    body,
    icon,
    id: Uuid::new_v4(),
    redacted,
    volume: f64::from(volume.min(10)) / 10.0,
  })
}

fn bounded_text(value: &str, limit: usize) -> String {
  value
    .trim()
    .chars()
    .filter(|character| !character.is_control() || *character == '\n')
    .take(limit)
    .collect()
}

fn private_preview(service: Service) -> (String, String, Option<String>) {
  (service.name().to_string(), "Новое уведомление".to_string(), None)
}

pub(crate) fn clear_for_workspace_lock(_app: &AppHandle) -> bool {
  LOCK_SEQUENCE.fetch_add(1, Ordering::Relaxed);
  let (preparing, pending, delivered) = CENTER.with_borrow_mut(|center| {
    (center.preparing.take(), center.pending.drain(), std::mem::take(&mut center.delivered))
  });
  for entry in &delivered {
    entry.notification.hide();
  }
  let context = system::Context::new(notice_smoke_profile());
  let removed = context.clear_history();
  preparing.into_iter().chain(pending).for_each(close_notice);
  for mut entry in delivered {
    entry.notification.remove_photo();
    report_closed(entry.target);
  }
  if let Err(error) = removed {
    log::warn!("[LagomAlerts] Could not clear Windows notification history: {error}");
  }
  true
}

fn offer_notice(app: &AppHandle, mut notice: Notice) -> bool {
  if !can_notify(app) || !is_service_enabled(notice.content.service) {
    close_notice(notice);
    return false;
  }
  if crate::workspace_privacy::is_locked() {
    notice.hide_preview();
  }
  let now = Instant::now();
  let duplicate_key = notice.duplicate_key();
  let (expired, accepted, present) = CENTER.with_borrow_mut(|center| {
    let expired = center.pending.expire(now);
    let accepted = center.pending.offer(notice, now, duplicate_key);
    (expired, accepted, center.preparing.is_none())
  });
  expired.for_each(close_notice);
  match accepted {
    Offer::Accepted => {
      if present { schedule_ui(app, show_next); }
      true
    }
    Offer::Duplicate(notice) => {
      close_notice(notice);
      true
    }
    Offer::Full(notice) => {
      close_notice(notice);
      false
    }
  }
}

fn report_closed(target: Target) {
  if let Target::Web(notification) = target {
    let _ = unsafe { notification.ReportClosed() };
  }
}

fn close_notice(notice: Notice) { report_closed(notice.target); }

fn schedule_ui(app: &AppHandle, action: impl FnOnce(&AppHandle) + Send + 'static) {
  let app = app.clone();
  tauri::async_runtime::spawn(async move {
    let ui = app.clone();
    let _ = app.run_on_main_thread(move || action(&ui));
  });
}

fn show_next(app: &AppHandle) {
  if CENTER.with_borrow(|center| center.preparing.is_some()) {
    return;
  }
  if !can_notify(app) {
    CENTER.with_borrow_mut(|center| center.pending.drain()).for_each(close_notice);
    return;
  }
  let (expired, notice) = CENTER.with_borrow_mut(|center| {
    (center.pending.expire(Instant::now()), center.pending.pop())
  });
  expired.for_each(close_notice);
  let Some(mut notice) = notice else { return; };
  if !is_service_enabled(notice.content.service) {
    close_notice(notice);
    schedule_ui(app, show_next);
    return;
  }
  if crate::workspace_privacy::is_locked() {
    notice.hide_preview();
  }
  let photo = notice.content.icon.as_deref().and_then(avatar::decode);
  if photo.is_none() && let Some(url) = notice.avatar_url.take() {
    let id = notice.content.id;
    CENTER.with_borrow_mut(|center| center.preparing = Some(notice));
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
      let photo = tokio::time::timeout(AVATAR_WAIT, avatar::fetch(url)).await.ok().flatten();
      schedule_ui(&app, move |ui| {
        let notice = CENTER.with_borrow_mut(|center| center.preparing.take_if(|notice| notice.content.id == id));
        if let Some(notice) = notice {
          show_system_toast(ui, notice, photo);
          show_next(ui);
        }
      });
    });
    return;
  }
  show_system_toast(app, notice, photo);
  schedule_ui(app, show_next);
}

fn show_system_toast(app: &AppHandle, mut notice: Notice, mut photo: Option<image::RgbaImage>) {
  let id = notice.content.id;
  let service = notice.content.service;
  if !can_notify(app) || !is_service_enabled(service) {
    close_notice(notice);
    return;
  }
  if crate::workspace_privacy::is_locked() {
    notice.hide_preview();
    photo = None;
  }
  let context = system::Context::new(notice_smoke_profile());
  let ui = app.clone();
  let notification = match context.show(&notice.content, photo, move |outcome| {
    schedule_ui(&ui, move |ui| finish_notice(ui, id, outcome));
  }) {
    Ok(notification) => notification,
    Err(error) => {
      context.record("unavailable", Some(id), serde_json::json!({ "service": service.name() }));
      log::debug!("[LagomAlerts] Could not post the Windows notification: {error}");
      close_notice(notice);
      return;
    }
  };
  let web = match &notice.target {
    Target::Web(notification) => Some(notification.clone()),
    Target::Telegram(_) => None,
  };
  let expired = CENTER.with_borrow_mut(|center| {
    let now = Instant::now();
    let mut expired = Vec::new();
    while center.delivered.front().is_some_and(|entry| now.duration_since(entry.since) >= system::EXPIRATION) {
      expired.extend(center.delivered.pop_front());
    }
    if center.delivered.len() >= MAX_SHOWN {
      expired.extend(center.delivered.pop_front());
    }
    center.delivered.push_back(Delivered {
      id, service, target: notice.target, redacted: notice.content.redacted, since: now, notification,
    });
    expired
  });
  for mut entry in expired {
    entry.notification.hide();
    if let Err(error) = context.remove_from_history(entry.id) {
      log::debug!("[LagomAlerts] Could not retire a Windows notification: {error}");
    }
    entry.notification.remove_photo();
    report_closed(entry.target);
  }
  if let Some(notification) = web {
    let _ = unsafe { notification.ReportShown() };
  }
  if !crate::workspace_privacy::is_locked() {
    let _ = app.emit_to("main", "relay-lagom-notice-delivered", serde_json::json!({ "service": service }));
  }
}

fn finish_notice(app: &AppHandle, id: Uuid, outcome: system::Outcome) {
  let entry = CENTER.with_borrow_mut(|center| {
    let index = center.delivered.iter().position(|entry| entry.id == id)?;
    center.delivered.remove(index)
  });
  let Some(mut entry) = entry else { return; };
  entry.notification.remove_photo();
  system::Context::new(notice_smoke_profile()).record("finished", Some(id), serde_json::json!({
    "activated": outcome == system::Outcome::Activated, "failed": outcome == system::Outcome::Failed,
  }));
  if outcome != system::Outcome::Activated || crate::workspace_privacy::is_locked() {
    report_closed(entry.target);
    return;
  }
  let service = entry.service;
  let target = match entry.target {
    Target::Web(notification) => {
      unsafe {
        if entry.redacted {
          let _ = notification.ReportClosed();
        } else {
          let _ = notification.ReportClicked();
        }
      }
      None
    }
    Target::Telegram(target) => (!entry.redacted).then_some(target),
  };
  crate::mark_user_opened_relay();
  let _ = app.emit_to(
    "main",
    "relay-lagom-notice-opened",
    serde_json::json!({ "service": service, "target": target }),
  );
  if let Some(main) = app.get_window("main") {
    let _ = main.show();
    let _ = main.unminimize();
    let _ = main.set_focus();
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn verifies_provider_origin_and_does_not_cross_profiles() {
    assert!(trusted_origin(Service::X, "https://x.com:443/"));
    assert!(trusted_origin(
      Service::Instagram,
      "https://www.instagram.com/"
    ));
    assert!(!trusted_origin(Service::X, "https://www.instagram.com/"));
    assert!(!trusted_origin(Service::X, "https://x.com.evil.example/"));
    assert!(!trusted_origin(Service::X, "https://bad@x.com/"));
    assert!(!trusted_origin(Service::X, "https://x.com:444/"));
  }

  #[test]
  fn only_bounded_raster_icons_are_rendered() {
    assert!(valid_icon("data:image/png;base64,YQ=="));
    assert!(!valid_icon("data:image/svg+xml;base64,YQ=="));
    assert!(!valid_icon("file:///avatar.png"));
    assert!(!valid_icon("https://example.org/avatar.png"));
    assert!(!valid_icon("data:image/png;base64,=YQ="));
  }

  #[test]
  fn renders_text_and_keeps_inserted_markup_as_text() {
    assert_eq!(bounded_text(" <b>\n\0Привет</b> ", 64), "<b>\nПривет</b>");
    assert_eq!(bounded_text("Бе́реста", 2), "Бе");
  }
}
