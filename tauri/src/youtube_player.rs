use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use url::Url;

static CONFIGURED: AtomicBool = AtomicBool::new(false);
static REQUESTS_IDENTIFIED: AtomicU64 = AtomicU64::new(0);

fn app_referrer(identifier: &str) -> Option<String> {
  let identifier = identifier.to_ascii_lowercase();
  if identifier.len() > 253 || !identifier.contains('.') || identifier.split('.').any(|label| {
    label.is_empty() || label.len() > 63 || label.starts_with('-') || label.ends_with('-')
      || !label.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
  }) {
    return None;
  }
  Some(format!("https://{identifier}/"))
}

fn is_youtube_embed_request(value: &str, method: &str) -> bool {
  let Ok(url) = Url::parse(value) else { return false; };
  if method != "GET" || url.scheme() != "https" || !url.username().is_empty()
    || url.password().is_some() || url.port_or_known_default() != Some(443)
    || !matches!(url.host_str(), Some("www.youtube.com" | "www.youtube-nocookie.com")) {
    return false;
  }
  let Some(id) = url.path().strip_prefix("/embed/") else { return false; };
  id.len() == 11 && id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

pub(crate) fn diagnostics() -> serde_json::Value {
  serde_json::json!({
    "configured": CONFIGURED.load(Ordering::Acquire),
    "identifiedRequests": REQUESTS_IDENTIFIED.load(Ordering::Relaxed)
  })
}

pub(crate) fn smoke_fixture_enabled() -> bool {
  std::env::var("EGOIST_RELAY_YOUTUBE_SMOKE_TEST").as_deref() == Ok("1")
    && std::env::var("EGOIST_RELAY_CONTROL_MODE").as_deref() == Ok("background")
    && crate::multi_app::smoke_download_directory().is_some()
}

#[cfg(windows)]
pub(crate) fn configure(window: &tauri::WebviewWindow, identifier: &str) -> Result<(), String> {
  use webview2_com::{take_pwstr, WebResourceRequestedEventHandler};
  use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2_22, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT,
    COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL,
  };
  use windows_core::{w, HSTRING, Interface, PWSTR};

  let referrer = app_referrer(identifier).ok_or("Invalid YouTube client identity")?;
  window.with_webview(move |platform| {
    let result = (|| -> windows_core::Result<()> {
      // YouTube requires the registered app ID as HTTPS Referer for desktop WebViews.
      // Only document requests for the official embedded player receive this identity.
      unsafe {
        let webview = platform.controller().CoreWebView2()?;
        let handler = WebResourceRequestedEventHandler::create(Box::new(move |_, args| {
          let Some(args) = args else { return Ok(()); };
          let request = args.Request()?;
          let mut uri = PWSTR::null();
          request.Uri(&mut uri)?;
          let uri = take_pwstr(uri);
          let mut method = PWSTR::null();
          request.Method(&mut method)?;
          let method = take_pwstr(method);
          if is_youtube_embed_request(&uri, &method) {
            request.Headers()?.SetHeader(w!("Referer"), &HSTRING::from(&referrer))?;
            REQUESTS_IDENTIFIED.fetch_add(1, Ordering::Relaxed);
          }
          Ok(())
        }));
        let mut token = 0;
        webview.add_WebResourceRequested(&handler, &mut token)?;
        for filter in ["https://www.youtube-nocookie.com/embed/*", "https://www.youtube.com/embed/*"] {
          let filter = HSTRING::from(filter);
          if let Ok(modern) = webview.cast::<ICoreWebView2_22>() {
            modern.AddWebResourceRequestedFilterWithRequestSourceKinds(
              &filter, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT,
              COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL,
            )?;
          } else {
            webview.AddWebResourceRequestedFilter(&filter, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT)?;
          }
        }
      }
      Ok(())
    })();
    CONFIGURED.store(result.is_ok(), Ordering::Release);
    if result.is_err() {
      log::warn!("[EgoistRelay] YouTube embedded-player identity could not be configured");
    }
  }).map_err(|_| "YouTube player configuration could not reach the main WebView".to_string())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn app_identity_uses_registered_identifier_not_a_third_party_site() {
    assert_eq!(app_referrer("com.egoist.relay"), Some("https://com.egoist.relay/".into()));
    for invalid in ["", "localhost", "user@youtube.com", "com.egoist.relay/path", "com.egoist.relay\r\nX:yes", ".com.relay", "com..relay", "com.-relay", "com.relay-"] {
      assert!(app_referrer(invalid).is_none());
    }
  }

  #[test]
  fn identity_header_is_limited_to_https_get_embedded_player_documents() {
    for host in ["www.youtube.com", "www.youtube-nocookie.com"] {
      assert!(is_youtube_embed_request(&format!("https://{host}/embed/abcdefghijk?enablejsapi=1"), "GET"));
    }
    for url in [
      "http://www.youtube.com/embed/abcdefghijk", "https://www.youtube.com:8443/embed/abcdefghijk",
      "https://www.youtube.com.evil.test/embed/abcdefghijk", "https://user@www.youtube.com/embed/abcdefghijk",
      "https://www.youtube.com/watch?v=abcdefghijk", "https://www.youtube.com/embed/short",
      "https://www.youtube.com/embed/abcdefghijk/extra", "https://www.youtube.com/embed/%61bcdefghijk",
      "https://googlevideo.com/embed/abcdefghijk",
    ] { assert!(!is_youtube_embed_request(url, "GET"), "{url}"); }
    assert!(!is_youtube_embed_request("https://www.youtube.com/embed/abcdefghijk", "POST"));
  }
}
