use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, atomic::{AtomicBool, AtomicU64, Ordering}};
use std::time::Duration;

use tauri::{AppHandle, Manager, Webview};

const CLEAR_TIMEOUT: Duration = Duration::from_secs(20);
static CLEARING: AtomicBool = AtomicBool::new(false);
static NEXT_GENERATION: AtomicU64 = AtomicU64::new(1);
static X_PENDING: AtomicU64 = AtomicU64::new(0);
static INSTAGRAM_PENDING: AtomicU64 = AtomicU64::new(0);
static PENDING_IO: Mutex<()> = Mutex::new(());

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CacheClearStatus {
  Cleared,
  Deferred,
  Failed,
}

#[derive(serde::Serialize)]
pub struct CacheClearReport {
  telegram: CacheClearStatus,
  x: CacheClearStatus,
  instagram: CacheClearStatus,
}

struct ClearGuard;

impl Drop for ClearGuard {
  fn drop(&mut self) {
    CLEARING.store(false, Ordering::Release);
  }
}

#[tauri::command]
pub async fn relay_clear_webview_cache(
  webview: Webview,
  app_handle: AppHandle,
) -> Result<CacheClearReport, String> {
  crate::social_share::require_main(&webview).map_err(|_| "CACHE_SOURCE_DENIED".to_string())?;
  if CLEARING.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).is_err() {
    return Ok(CacheClearReport {
      telegram: CacheClearStatus::Failed,
      x: CacheClearStatus::Failed,
      instagram: CacheClearStatus::Failed,
    });
  }
  let _guard = ClearGuard;
  let generation = NEXT_GENERATION.fetch_add(1, Ordering::AcqRel);
  let (telegram, x, instagram) = tokio::join!(
    clear_service(&app_handle, "main", None, generation),
    clear_service(&app_handle, "x_webview", Some(&X_PENDING), generation),
    clear_service(&app_handle, "instagram_webview", Some(&INSTAGRAM_PENDING), generation),
  );
  Ok(CacheClearReport { telegram, x, instagram })
}

async fn clear_service(
  app: &AppHandle,
  label: &str,
  pending: Option<&'static AtomicU64>,
  generation: u64,
) -> CacheClearStatus {
  let app_for_marker = app.clone();
  let marker_label = label.to_string();
  let is_recorded = tauri::async_runtime::spawn_blocking(move || {
    record_pending(&app_for_marker, &marker_label, pending, generation)
  }).await.unwrap_or(false);
  let Some(webview) = app.get_webview(label) else {
    return if is_recorded { CacheClearStatus::Deferred } else { CacheClearStatus::Failed };
  };
  let status = clear_webview(&webview).await;
  if status == CacheClearStatus::Cleared {
    complete_pending(app, label, pending, generation).await;
  }
  status
}

fn marker_path(app: &AppHandle, label: &str) -> Result<PathBuf, String> {
  Ok(crate::multi_app::get_service_data_directory(app, "cache-maintenance")?.join(format!("{label}.pending")))
}

fn record_pending(app: &AppHandle, label: &str, pending: Option<&AtomicU64>, generation: u64) -> bool {
  let Some(pending) = pending else { return true; };
  let _lock = PENDING_IO.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
  pending.store(generation, Ordering::Release);
  let Ok(path) = marker_path(app, label) else { return false; };
  let directory = path.parent().unwrap();
  if fs::create_dir_all(directory).is_err() || directory.is_symlink() { return false; }
  match fs::OpenOptions::new().write(true).create_new(true).open(&path) {
    Ok(file) => file.sync_all().is_ok(),
    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
      fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_file() && !metadata.file_type().is_symlink())
    }
    Err(_) => false,
  }
}

async fn complete_pending(app: &AppHandle, label: &str, pending: Option<&'static AtomicU64>, generation: u64) {
  let Some(pending) = pending else { return; };
  let app = app.clone();
  let label = label.to_string();
  let _ = tauri::async_runtime::spawn_blocking(move || {
    let _lock = PENDING_IO.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if complete_generation(pending, generation) {
      if let Ok(path) = marker_path(&app, &label) { let _ = fs::remove_file(path); }
    }
  }).await;
}

fn complete_generation(pending: &AtomicU64, generation: u64) -> bool {
  pending.compare_exchange(generation, 0, Ordering::AcqRel, Ordering::Acquire).is_ok()
}

fn read_pending(app: &AppHandle, label: &str, pending: &AtomicU64) -> u64 {
  let _lock = PENDING_IO.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
  let generation = pending.load(Ordering::Acquire);
  if generation != 0 { return generation; }
  let is_recorded = marker_path(app, label).ok().is_some_and(|path| {
    fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_file() && !metadata.file_type().is_symlink())
  });
  if !is_recorded { return 0; }
  let generation = NEXT_GENERATION.fetch_add(1, Ordering::AcqRel);
  pending.store(generation, Ordering::Release);
  generation
}

/// Отложенная очистка хранится отдельно от профилей и выполняется при создании сервиса
pub(crate) fn clear_pending_for_service(webview: &Webview) {
  let pending = match webview.label() {
    "x_webview" => &X_PENDING,
    "instagram_webview" => &INSTAGRAM_PENDING,
    _ => return,
  };
  let webview = webview.clone();
  tauri::async_runtime::spawn(async move {
    let app = webview.app_handle().clone();
    let label = webview.label().to_string();
    let marker_app = app.clone();
    let marker_label = label.clone();
    let generation = tauri::async_runtime::spawn_blocking(move || {
      read_pending(&marker_app, &marker_label, pending)
    }).await.unwrap_or(0);
    if generation == 0 { return; }
    if clear_webview(&webview).await == CacheClearStatus::Cleared {
      complete_pending(&app, &label, Some(pending), generation).await;
    }
  });
}

#[cfg(windows)]
async fn clear_webview(webview: &Webview) -> CacheClearStatus {
  use webview2_com::{
    ClearBrowsingDataCompletedHandler,
    Microsoft::Web::WebView2::Win32::{
      COREWEBVIEW2_BROWSING_DATA_KINDS_DISK_CACHE, ICoreWebView2_13, ICoreWebView2Profile2,
    },
  };
  use windows_core::Interface;

  let (sender, receiver) = tokio::sync::oneshot::channel();
  let started = webview.with_webview(move |platform| {
    let run = || -> windows_core::Result<()> {
      unsafe {
        let core = platform.controller().CoreWebView2()?;
        let profile = core.cast::<ICoreWebView2_13>()?.Profile()?.cast::<ICoreWebView2Profile2>()?;
        let handler = ClearBrowsingDataCompletedHandler::create(Box::new(move |result| {
          let _ = sender.send(result.is_ok());
          Ok(())
        }));
        profile.ClearBrowsingData(COREWEBVIEW2_BROWSING_DATA_KINDS_DISK_CACHE, &handler)
      }
    };
    let _ = run();
  });
  if started.is_err() { return CacheClearStatus::Failed; }
  match tokio::time::timeout(CLEAR_TIMEOUT, receiver).await {
    Ok(Ok(true)) => CacheClearStatus::Cleared,
    _ => CacheClearStatus::Failed,
  }
}

#[cfg(not(windows))]
async fn clear_webview(_: &Webview) -> CacheClearStatus {
  CacheClearStatus::Failed
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn earlier_completion_keeps_the_new_cleanup_request() {
    let pending = AtomicU64::new(2);
    assert!(!complete_generation(&pending, 1));
    assert_eq!(pending.load(Ordering::Acquire), 2);
    assert!(complete_generation(&pending, 2));
    assert_eq!(pending.load(Ordering::Acquire), 0);
  }
}
