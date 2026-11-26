use std::collections::VecDeque;
use std::path::Path;
use std::sync::Mutex;

use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, Webview};
use url::Url;
use webview2_com::{
  ContextMenuRequestedEventHandler, CustomItemSelectedEventHandler, take_pwstr,
  Microsoft::Web::WebView2::Win32::{
    COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_COMMAND, COREWEBVIEW2_CONTEXT_MENU_TARGET_KIND_IMAGE,
    COREWEBVIEW2_CONTEXT_MENU_TARGET_KIND_VIDEO, ICoreWebView2, ICoreWebView2_11,
    ICoreWebView2ContextMenuRequestedEventArgs, ICoreWebView2Environment9,
  },
};
use windows_core::{BOOL, Interface, PWSTR, Result};

// Журнал хранит до 500 завершённых операций. Ссылки на файлы не живут дольше WebView.
const MAX_RECENT_DOWNLOADS: usize = 500;

type UrlHash = [u8; 32];

struct VideoDownload {
  service: &'static str,
  page: UrlHash,
  source: UrlHash,
  operation_id: String,
}

static VIDEO_DOWNLOADS: Mutex<VecDeque<VideoDownload>> = Mutex::new(VecDeque::new());

fn media_context_is_active(app: &AppHandle, service: &str) -> bool {
  crate::workspace_privacy::allows_native_content()
    && !super::has_social_overlay()
    && super::get_active_app() == service
    && app.get_window("main").is_some_and(|window| {
      window.is_visible().unwrap_or(false) && !window.is_minimized().unwrap_or(true)
    })
}

fn official_media_page(service: &str, url: &Url) -> Option<UrlHash> {
  if url.scheme() != "https"
    || url.port_or_known_default() != Some(443)
    || !url.username().is_empty()
    || url.password().is_some()
  {
    return None;
  }
  let host = url.host_str()?;
  let official = match service {
    super::X_APP => matches!(host, "x.com" | "www.x.com" | "twitter.com" | "www.twitter.com"),
    super::INSTAGRAM_APP => matches!(host, "instagram.com" | "www.instagram.com"),
    _ => false,
  };
  official.then(|| Sha256::digest(url.as_str()).into())
}

fn media_source(service: &str, url: &Url) -> Option<UrlHash> {
  ((matches!(service, super::X_APP | super::INSTAGRAM_APP))
    && url.scheme() == "https"
    && super::is_service_internal_url(service, url))
    .then(|| Sha256::digest(url.as_str()).into())
}

fn video_file(file_name: &str) -> bool {
  Path::new(file_name).extension().and_then(|value| value.to_str()).is_some_and(|extension| {
    ["mp4", "m4v", "webm", "mov", "ogv", "mkv"].iter()
      .any(|video| extension.eq_ignore_ascii_case(video))
  })
}

pub(super) fn record_download(webview: &Webview, service: &str, source: &Url, id: &str, file_name: &str) {
  let service = match service {
    super::X_APP => super::X_APP,
    super::INSTAGRAM_APP => super::INSTAGRAM_APP,
    _ => return,
  };
  if webview.label() != super::get_service_label(service) || !video_file(file_name) {
    return;
  }
  let page = webview.url().ok().and_then(|url| official_media_page(service, &url));
  let (Some(page), Some(source)) = (page, media_source(service, source)) else { return };
  let Ok(mut downloads) = VIDEO_DOWNLOADS.lock() else { return };
  downloads.retain(|entry| entry.service != service || entry.page != page || entry.source != source);
  if downloads.len() == MAX_RECENT_DOWNLOADS {
    downloads.pop_front();
  }
  downloads.push_back(VideoDownload {
    service, page, source, operation_id: id.to_owned(),
  });
}

fn recent_download(service: &str, page: UrlHash, source: UrlHash) -> Option<String> {
  VIDEO_DOWNLOADS.lock().ok()?.iter().rev()
    .find(|entry| entry.service == service && entry.page == page && entry.source == source)
    .map(|entry| entry.operation_id.clone())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn video_file_copy_uses_only_the_exact_document_service_and_target_source() {
    let page = Url::parse("https://x.com/fixture/status/1").unwrap();
    let another_page = Url::parse("https://x.com/fixture/status/2").unwrap();
    let mp4 = Url::parse("https://video.twimg.com/clip.mp4?variant=1").unwrap();
    let another_mp4 = Url::parse("https://video.twimg.com/clip.mp4?variant=2").unwrap();
    let page = official_media_page(super::super::X_APP, &page).unwrap();
    let another_page = official_media_page(super::super::X_APP, &another_page).unwrap();
    let mp4 = media_source(super::super::X_APP, &mp4).unwrap();
    let another_mp4 = media_source(super::super::X_APP, &another_mp4).unwrap();
    let service = super::super::X_APP;
    VIDEO_DOWNLOADS.lock().unwrap().push_back(VideoDownload {
      service, page, source: mp4, operation_id: "fixture-operation".into(),
    });
    assert_eq!(recent_download(service, page, mp4).as_deref(), Some("fixture-operation"));
    assert_eq!(recent_download(service, page, another_mp4), None);
    assert_eq!(recent_download(service, another_page, mp4), None);
    assert_eq!(recent_download(super::super::INSTAGRAM_APP, page, mp4), None);
    VIDEO_DOWNLOADS.lock().unwrap().retain(|entry| entry.operation_id != "fixture-operation");
  }

  #[test]
  fn untrusted_documents_and_unavailable_video_formats_do_not_get_a_copy_entry() {
    for raw in [
      "https://x.com.example.test/fixture/status/1",
      "https://fixture@x.com/home",
      "https://x.com:8443/home",
      "http://x.com/home",
      "blob:https://x.com/fixture",
    ] {
      assert!(official_media_page(super::super::X_APP, &Url::parse(raw).unwrap()).is_none());
    }
    assert!(media_source(super::super::X_APP, &Url::parse("blob:https://x.com/fixture").unwrap()).is_none());
    assert!(media_source(super::super::X_APP, &Url::parse("https://video.twimg.com.example.test/clip.mp4").unwrap()).is_none());
    assert!(video_file("fixture.MP4"));
    assert!(!video_file("fixture.mp4.exe"));
    assert!(!video_file("fixture.m3u8"));
  }
}

pub(super) fn install(webview: &Webview, service: &'static str) -> std::result::Result<(), String> {
  let app = webview.app_handle().clone();
  webview.with_webview(move |platform| {
    let result = (|| -> Result<()> {
      // При пересоздании WebView кнопка не ссылается на загрузки предыдущего экземпляра.
      if let Ok(mut downloads) = VIDEO_DOWNLOADS.lock() {
        downloads.retain(|entry| entry.service != service);
      }
      let context_menu = unsafe { platform.controller().CoreWebView2()? }.cast::<ICoreWebView2_11>()?;
      let environment = platform.environment().cast::<ICoreWebView2Environment9>().ok();
      let callback = ContextMenuRequestedEventHandler::create(Box::new(move |sender, args| {
        let (Some(sender), Some(args)) = (sender, args) else { return Ok(()) };
        if let Err(error) = on_media_menu(&app, service, &sender, &args, environment.as_ref()) {
          log::debug!("[MultiApp] {service} media context menu unavailable: {}", error.code());
        }
        Ok(())
      }));
      unsafe { context_menu.add_ContextMenuRequested(&callback, &mut 0) }
    })();
    if let Err(error) = result {
      log::debug!("[MultiApp] {service} media context listener unavailable: {}", error.code());
    }
  }).map_err(|error| error.to_string())
}

fn on_media_menu(
  app: &AppHandle,
  service: &'static str,
  sender: &ICoreWebView2,
  args: &ICoreWebView2ContextMenuRequestedEventArgs,
  environment: Option<&ICoreWebView2Environment9>,
) -> Result<()> {
  let target = unsafe { args.ContextMenuTarget()? };
  let mut kind = Default::default();
  unsafe { target.Kind(&mut kind)? };
  if kind != COREWEBVIEW2_CONTEXT_MENU_TARGET_KIND_IMAGE
    && kind != COREWEBVIEW2_CONTEXT_MENU_TARGET_KIND_VIDEO
  {
    return Ok(());
  }
  if !media_context_is_active(app, service) {
    return unsafe { args.SetHandled(true) };
  }
  // Просмотрщик использует встроенное меню для сохранения и копирования изображения/адреса.
  // WebView2 сам определяет точное медиа под курсором, в том числе в полноэкранном видео.
  let Some(environment) = environment.filter(|_| kind == COREWEBVIEW2_CONTEXT_MENU_TARGET_KIND_VIDEO) else {
    return Ok(());
  };
  let mut main_frame = BOOL(0);
  let mut has_source = BOOL(0);
  unsafe {
    target.IsRequestedForMainFrame(&mut main_frame)?;
    target.HasSourceUri(&mut has_source)?;
  }
  if !main_frame.as_bool() || !has_source.as_bool() {
    return Ok(());
  }
  let mut current_uri = PWSTR::null();
  unsafe { sender.Source(&mut current_uri)? };
  let current_uri = take_pwstr(current_uri);
  let mut page_uri = PWSTR::null();
  unsafe { target.PageUri(&mut page_uri)? };
  let page_uri = take_pwstr(page_uri);
  let page = Url::parse(&page_uri).ok().and_then(|url| official_media_page(service, &url));
  let current = Url::parse(&current_uri).ok().and_then(|url| official_media_page(service, &url));
  let Some(page) = page.filter(|page| Some(*page) == current) else { return Ok(()) };
  let mut source_uri = PWSTR::null();
  unsafe { target.SourceUri(&mut source_uri)? };
  let source = Url::parse(&take_pwstr(source_uri)).ok().and_then(|url| media_source(service, &url));
  let Some(source) = source else { return Ok(()) };
  let Some(id) = recent_download(service, page, source) else { return Ok(()) };

  let item = unsafe {
    environment.CreateContextMenuItem(
      windows_core::w!("Копировать файл"),
      None,
      COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_COMMAND,
    )?
  };
  let action_app = app.clone();
  let action = CustomItemSelectedEventHandler::create(Box::new(move |_, _| {
    if !media_context_is_active(&action_app, service) {
      return Ok(());
    }
    let current = action_app.get_webview(super::get_service_label(service))
      .and_then(|webview| webview.url().ok())
      .and_then(|url| official_media_page(service, &url));
    if current != Some(page) || recent_download(service, page, source).as_deref() != Some(id.as_str()) {
      return Ok(());
    }
    if let Some(window) = action_app.get_window("main") {
      if let Err(error) = crate::media_operations::copy_registered_file(&action_app, &window, &id, 0) {
        log::debug!("[MultiApp] {service} video file clipboard unavailable: {error}");
      }
    }
    Ok(())
  }));
  let items = unsafe { args.MenuItems()? };
  let mut count = 0;
  unsafe {
    item.add_CustomItemSelected(&action, &mut 0)?;
    items.Count(&mut count)?;
    items.InsertValueAtIndex(count, &item)
  }
}
