use std::collections::VecDeque;
use std::sync::Mutex;

use tauri::{Emitter, Manager};
use tauri_plugin_deep_link::DeepLinkExt;
use url::Url;

const MAX_PENDING: usize = 16;
const MAX_LINK_LENGTH: usize = 16_384;

#[derive(Default)]
pub(crate) struct PendingLinks(Mutex<VecDeque<Url>>);

pub(crate) fn setup(app: &tauri::AppHandle) {
  app.manage(PendingLinks::default());
  if let Ok(Some(urls)) = app.deep_link().get_current() {
    enqueue(app, urls);
  }
  // Ссылка Telegram также может быть передана явно при запуске EXE.
  accept_web_argument(app, std::env::args_os().skip(1).filter_map(|arg| arg.into_string().ok()));
  let handle = app.clone();
  app.deep_link().on_open_url(move |event| {
    enqueue(&handle, event.urls());
    #[cfg(target_os = "macos")]
    if !crate::should_avoid_foreground() && let Some(window) = handle.get_window("main") {
      let _ = window.show();
      let _ = window.unminimize();
      let _ = window.set_focus();
      crate::multi_app::refresh_main_window_visibility(&handle);
    }
  });
}

pub(crate) fn accept_web_argument(app: &tauri::AppHandle, mut args: impl Iterator<Item = String>) {
  if let Some(arg) = args.next()
    && args.next().is_none()
    && let Ok(url) = Url::parse(&arg)
    && matches!(url.scheme(), "https" | "http")
  {
    enqueue(app, [url]);
  }
}

fn has_safe_authority(url: &Url) -> bool {
  url.as_str().len() <= MAX_LINK_LENGTH && url.username().is_empty() && url.password().is_none()
    && url.port().is_none()
}

fn normalize_telegram_link(mut url: Url) -> Option<Url> {
  if !has_safe_authority(&url) {
    return None;
  }
  if url.scheme() == "beresta" {
    if url.host_str() != Some("open") || !url.path().is_empty() || url.fragment().is_some() {
      return None;
    }
    let mut fields = url.query_pairs();
    let (key, link) = fields.next()?;
    if key != "url" || fields.next().is_some() || link.chars().any(char::is_control) {
      return None;
    }
    let target = Url::parse(&link).ok()?;
    if target.scheme() != "https" {
      return None;
    }
    url = target;
    if !has_safe_authority(&url) {
      return None;
    }
  }

  match url.scheme() {
    "tg" if !url.path().is_empty() || url.host_str().is_some() => {
      url.set_fragment(None);
      Some(url)
    }
    "https" | "http" => {
      let host = url.host_str()?;
      if host == "web.telegram.org" {
        if url.scheme() != "https"
          || !matches!(url.path().trim_end_matches('/'), "/a" | "/k" | "/z")
          || url.query_pairs().any(|(key, value)| key != "account"
            || value.is_empty() || value.len() > 3 || !value.bytes().all(|b| b.is_ascii_digit()))
        {
          return None;
        }
      } else {
        let short_host = matches!(host, "t.me" | "www.t.me" | "telegram.me" | "telegram.dog");
        if (!short_host && !host.strip_suffix(".t.me").is_some_and(is_username))
          || (short_host && url.path().len() <= 1)
        {
          return None;
        }
        url.set_fragment(None);
        url.set_scheme("https").ok()?;
      }
      Some(url)
    }
    _ => None,
  }
}

fn is_username(username: &str) -> bool {
  (2..=32).contains(&username.len())
    && username.chars().next().is_some_and(|ch| ch.is_ascii_alphabetic())
    && username.bytes().all(|ch| ch.is_ascii_alphanumeric() || ch == b'_')
}

fn enqueue(app: &tauri::AppHandle, urls: impl IntoIterator<Item = Url>) {
  let Some(pending) = app.try_state::<PendingLinks>() else { return; };
  {
    let mut queue = pending.0.lock().unwrap_or_else(|error| error.into_inner());
    for url in urls.into_iter().take(MAX_PENDING).filter_map(normalize_telegram_link) {
      if queue.back() == Some(&url) {
        continue;
      }
      if queue.len() == MAX_PENDING {
        queue.pop_front();
      }
      queue.push_back(url);
    }
  }
  let _ = app.emit_to("main", "relay-deep-links-pending", ());
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn accepts_system_links_and_unwraps_browser_activation() {
    let browser = Url::parse("beresta://open?url=https%3A%2F%2Ft.me%2Fsample_bot%2Fhello%3Fstartapp%3Dtest").unwrap();
    assert_eq!(
      normalize_telegram_link(browser).unwrap().as_str(),
      "https://t.me/sample_bot/hello?startapp=test"
    );
    for link in ["tg://settings", "https://sample_bot.t.me/hello", "https://web.telegram.org/a/#@sample_bot"] {
      assert!(normalize_telegram_link(Url::parse(link).unwrap()).is_some());
    }
  }

  #[test]
  fn rejects_browser_activation_for_unrelated_hosts_and_ambiguous_parameters() {
    for link in [
      "beresta://open?url=https%3A%2F%2Ft.me.example%2Ffoo",
      "beresta://open?url=tg%3A%2F%2Fsettings",
      "beresta://open?url=https%3A%2F%2Ft.me%2Ffoo&url=https%3A%2F%2Ft.me%2Fbar",
      "https://web.telegram.org/a/?other=1",
      "https://t.me:8443/foo",
    ] {
      assert!(normalize_telegram_link(Url::parse(link).unwrap()).is_none(), "{link}");
    }
  }
}

#[tauri::command]
pub(crate) fn relay_take_deep_links(webview: tauri::Webview, pending: tauri::State<'_, PendingLinks>) -> Vec<Url> {
  if webview.label() != "main" {
    return Vec::new();
  }
  pending.0.lock().unwrap_or_else(|error| error.into_inner()).drain(..).collect()
}
