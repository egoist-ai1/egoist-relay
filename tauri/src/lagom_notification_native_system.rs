use super::{Content, Service};
use image::RgbaImage;
use std::{
  fs::{self, OpenOptions},
  io::{self, Cursor, Write},
  path::{Path, PathBuf},
  sync::OnceLock,
  time::{Duration, SystemTime, UNIX_EPOCH},
};
use url::Url;
use uuid::Uuid;
use windows::{
  Data::Xml::Dom::XmlDocument,
  Foundation::{DateTime, IReference, PropertyValue, TypedEventHandler},
  UI::Notifications::{
    ToastDismissalReason, ToastDismissedEventArgs, ToastNotification,
    ToastNotificationManager, ToastNotifier,
  },
  core::{HSTRING, Interface, Result},
};

const APP_ID: &str = "com.egoist.relay";
const MAIN_GROUP: &str = "beresta";
const IMAGE_LIMIT: usize = 96;
pub(super) const EXPIRATION: Duration = Duration::from_secs(4 * 60 * 60);

pub(super) struct Context {
  group: String,
  smoke: Option<PathBuf>,
}

impl Context {
  pub(super) fn new(smoke: Option<PathBuf>) -> Self {
    static QA_GROUP: OnceLock<String> = OnceLock::new();
    let group = if smoke.is_some() {
      QA_GROUP.get_or_init(|| format!("be-qa-{}", &Uuid::new_v4().simple().to_string()[..8])).clone()
    } else {
      MAIN_GROUP.into()
    };
    Self { group, smoke }
  }

  pub(super) fn clear_history(&self) -> Result<()> {
    let history = ToastNotificationManager::History()?;
    history.RemoveGroupWithId(&HSTRING::from(&self.group), &HSTRING::from(APP_ID))?;
    self.record("cleared", None, serde_json::json!({}));
    Ok(())
  }

  pub(super) fn remove_from_history(&self, id: Uuid) -> Result<()> {
    ToastNotificationManager::History()?.RemoveGroupedTagWithId(
      &HSTRING::from(tag(id)), &HSTRING::from(&self.group), &HSTRING::from(APP_ID),
    )
  }

  pub(super) fn record(&self, event: &str, id: Option<Uuid>, details: serde_json::Value) {
    let Some(profile) = self.smoke.as_deref() else { return; };
    let value = serde_json::json!({
      "event": event,
      "tag": id.map(tag),
      "group": self.group,
      "aumid": APP_ID,
      "atMs": SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis(),
      "details": details,
    });
    let _ = OpenOptions::new().create(true).append(true).open(profile.join("notice-system.jsonl"))
      .and_then(|mut file| writeln!(file, "{value}"));
  }

  pub(super) fn show(
    &self,
    content: &Content,
    photo: Option<RgbaImage>,
    finish: impl Fn(Outcome) + Send + Sync + 'static,
  ) -> Result<SystemToast> {
    let app_id = HSTRING::from(APP_ID);
    let notifier = ToastNotificationManager::CreateToastNotifierWithId(&app_id)?;
    let mut avatar = photo.and_then(|photo| self.save_photo(content.id, photo).ok()).map(PendingPhoto);
    let avatar_uri = avatar.as_ref().and_then(|photo| Url::from_file_path(&photo.0).ok());
    let xml = toast_xml(content, avatar_uri.as_ref());
    let document = XmlDocument::new()?;
    document.LoadXml(&HSTRING::from(xml))?;
    let toast = ToastNotification::CreateToastNotification(&document)?;
    toast.SetGroup(&HSTRING::from(&self.group))?;
    toast.SetTag(&HSTRING::from(tag(content.id)))?;
    toast.SetExpirationTime(&expiration()?)?;

    let finish = std::sync::Arc::new(finish);
    let activated = std::sync::Arc::clone(&finish);
    let closed = std::sync::Arc::clone(&finish);
    let mut registration = SystemToast {
      toast, notifier, activated: None, dismissed: None, failed: None, photo: None,
    };
    registration.activated = Some(registration.toast.Activated(&TypedEventHandler::new(move |_, _| {
      activated(Outcome::Activated);
      Ok(())
    }))?);
    registration.dismissed = Some(registration.toast.Dismissed(&TypedEventHandler::<ToastNotification, ToastDismissedEventArgs>::new(move |_, args| {
      // При исчезновении баннера уведомление остаётся доступным в центре уведомлений.
      if args.as_ref().is_some_and(|args| args.Reason() == Ok(ToastDismissalReason::UserCanceled)) {
        closed(Outcome::Dismissed);
      }
      Ok(())
    }))?);
    registration.failed = Some(registration.toast.Failed(&TypedEventHandler::new(move |_, _| {
      finish(Outcome::Failed);
      Ok(())
    }))?);
    registration.notifier.Show(&registration.toast)?;
    registration.photo = avatar.take().map(|mut photo| std::mem::take(&mut photo.0));
    self.record("shown", Some(content.id), serde_json::json!({
      "service": content.service.name(), "avatar": avatar_uri.is_some(), "silent": content.volume <= 0.0,
      "bodyChars": content.body.chars().count(), "redacted": content.redacted,
    }));
    Ok(registration)
  }

  fn save_photo(&self, id: Uuid, photo: RgbaImage) -> io::Result<PathBuf> {
    let root = if let Some(profile) = &self.smoke {
      profile.join("notification-avatars")
    } else {
      std::env::temp_dir().join("beresta-system-notice-avatars")
    };
    fs::create_dir_all(&root)?;
    prune_photos(&root);
    let file = root.join(format!("{}.png", id.simple()));
    let mut png = Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(photo).write_to(&mut png, image::ImageFormat::Png).map_err(io::Error::other)?;
    let mut writer = OpenOptions::new().write(true).create_new(true).open(&file)?;
    if let Err(error) = writer.write_all(&png.into_inner()) {
      drop(writer);
      let _ = fs::remove_file(&file);
      return Err(error);
    }
    Ok(file)
  }
}

struct PendingPhoto(PathBuf);

impl Drop for PendingPhoto {
  fn drop(&mut self) {
    if !self.0.as_os_str().is_empty() { let _ = fs::remove_file(&self.0); }
  }
}

fn tag(id: Uuid) -> String { id.simple().to_string()[..16].to_owned() }

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Outcome { Activated, Dismissed, Failed }

pub(super) struct SystemToast {
  toast: ToastNotification,
  notifier: ToastNotifier,
  activated: Option<i64>,
  dismissed: Option<i64>,
  failed: Option<i64>,
  photo: Option<PathBuf>,
}

impl SystemToast {
  pub(super) fn hide(&self) {
    let _ = self.notifier.Hide(&self.toast);
  }

  pub(super) fn remove_photo(&mut self) {
    if let Some(photo) = self.photo.take() { let _ = fs::remove_file(photo); }
  }
}

impl Drop for SystemToast {
  fn drop(&mut self) {
    // Отписка сохраняет историю Windows даже после завершения Бересты.
    if let Some(token) = self.activated { let _ = self.toast.RemoveActivated(token); }
    if let Some(token) = self.dismissed { let _ = self.toast.RemoveDismissed(token); }
    if let Some(token) = self.failed { let _ = self.toast.RemoveFailed(token); }
  }
}

fn expiration() -> Result<IReference<DateTime>> {
  const WINDOWS_EPOCH_OFFSET_SECONDS: u64 = 11_644_473_600;
  let seconds = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()
    + WINDOWS_EPOCH_OFFSET_SECONDS + EXPIRATION.as_secs();
  PropertyValue::CreateDateTime(DateTime { UniversalTime: seconds as i64 * 10_000_000 })?.cast()
}

fn prune_photos(directory: &Path) {
  let Ok(entries) = fs::read_dir(directory) else { return; };
  let now = SystemTime::now();
  let mut fresh = Vec::new();
  for entry in entries.flatten() {
    // Очищаем только обычные PNG с именем, которое создаёт этот модуль.
    let path = entry.path();
    let belongs = path.extension().is_some_and(|ext| ext == "png")
      && path.file_stem().and_then(|stem| stem.to_str()).is_some_and(|stem| {
        stem.len() == 32 && stem.bytes().all(|byte| byte.is_ascii_hexdigit())
      });
    if !belongs || !entry.file_type().is_ok_and(|kind| kind.is_file()) { continue; }
    let Ok(modified) = entry.metadata().and_then(|info| info.modified()) else { continue; };
    if now.duration_since(modified).is_ok_and(|age| age >= EXPIRATION) {
      let _ = fs::remove_file(path);
    } else {
      fresh.push((modified, path));
    }
  }
  let excess = fresh.len().saturating_sub(IMAGE_LIMIT - 1);
  if excess > 0 {
    fresh.sort_unstable_by_key(|entry| entry.0);
    for (_, path) in fresh.into_iter().take(excess) { let _ = fs::remove_file(path); }
  }
}

fn toast_xml(content: &Content, photo: Option<&Url>) -> String {
  let service = content.service.name();
  let title = if content.title.is_empty() { service } else { &content.title };
  let mut xml = format!(
    "<toast duration=\"short\"><visual><binding template=\"ToastGeneric\"><text>{}</text>",
    escape(title),
  );
  if !content.body.is_empty() {
    xml.push_str(&format!("<text>{}</text>", escape(&content.body)));
  }
  xml.push_str(&format!("<text placement=\"attribution\">{service}</text>"));
  if let Some(photo) = photo {
    xml.push_str(&format!("<image placement=\"appLogoOverride\" hint-crop=\"circle\" src=\"{}\"/>", escape(photo.as_str())));
  }
  xml.push_str("</binding></visual>");
  if content.volume <= 0.0 {
    xml.push_str("<audio silent=\"true\"/>");
  } else {
    let sound = match content.service {
      Service::Telegram => "IM",
      Service::X => "Mail",
      Service::Instagram => "Default",
    };
    xml.push_str(&format!("<audio src=\"ms-winsoundevent:Notification.{sound}\"/>"));
  }
  xml.push_str("</toast>");
  xml
}

fn escape(value: &str) -> String {
  let mut xml = String::with_capacity(value.len());
  for character in value.chars() {
    match character {
      '&' => xml.push_str("&amp;"),
      '<' => xml.push_str("&lt;"),
      '>' => xml.push_str("&gt;"),
      '"' => xml.push_str("&quot;"),
      '\'' => xml.push_str("&apos;"),
      '\u{fffe}' | '\u{ffff}' => {}
      _ => xml.push(character),
    }
  }
  xml
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn renders_escaped_native_toast_xml_and_windows_sound() {
    let mut content = Content {
      service: Service::Telegram, title: "Петя <3 & Оля".into(), body: "<audio/>".into(),
      icon: None, volume: 0.3, id: Uuid::new_v4(), redacted: false,
    };
    let photo = Url::parse("file:///C:/tmp/%D0%B0%D0%B2%D0%B0%D1%82%D0%B0%D1%80.png").unwrap();
    let xml = toast_xml(&content, Some(&photo));
    assert!(xml.contains("Петя &lt;3 &amp; Оля"));
    assert!(xml.contains("&lt;audio/&gt;"));
    assert!(xml.contains("placement=\"appLogoOverride\" hint-crop=\"circle\""));
    assert!(xml.contains("ms-winsoundevent:Notification.IM"));
    content.volume = 0.0;
    let xml = toast_xml(&content, None);
    assert!(!xml.contains("appLogoOverride"));
    assert!(xml.contains("<audio silent=\"true\"/>"));
  }

  #[test]
  fn separates_smoke_group_from_production_and_stays_stable_during_lock() {
    let smoke = Context::new(Some(std::env::temp_dir()));
    let smoke_later = Context::new(Some(std::env::temp_dir()));
    assert_ne!(smoke.group, Context::new(None).group);
    assert_eq!(smoke.group, smoke_later.group);
  }
}
