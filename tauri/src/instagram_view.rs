//! Масштаб WebView2 Instagram для Reels в портретном окне (только Windows).
//!
//! Instagram ограничивает ширину колонки Reels в CSS-пикселях, поэтому в высоком окне
//! ролик остаётся узким. Масштаб WebView2 сужает CSS-viewport: страница включает узкую
//! раскладку, где ролик занимает почти всю ширину, а DPR растёт и плеер берёт лучшее
//! качество. Классы Instagram не затрагиваются.

use std::sync::atomic::{AtomicI32, Ordering};

#[cfg(windows)]
use tauri::Manager;
use tauri::AppHandle;

/// Ширина CSS-viewport, к которой стремится масштаб.
const REELS_TARGET_CSS_WIDTH: f64 = 540.0;
const REELS_MIN_ZOOM: f64 = 1.1;
const REELS_MAX_ZOOM: f64 = 3.0;
/// Окно считается портретным, когда высота не меньше ширины в этой пропорции.
const PORTRAIT_RATIO: f64 = 1.15;
/// Узкие окна не масштабируются: на них Instagram уже показывает узкую раскладку.
const MIN_WIDTH_FOR_ZOOM: i32 = 600;

static LAST_WIDTH: AtomicI32 = AtomicI32::new(0);
static LAST_HEIGHT: AtomicI32 = AtomicI32::new(0);
static LAST_ZOOM_PERCENT: AtomicI32 = AtomicI32::new(100);

/// Лента Reels и конкретный ролик в ней. Сетка роликов звука и модальные /reel/<id> не затрагиваются.
fn is_reels_path(path: &str) -> bool {
  (path == "/reels" || path.starts_with("/reels/")) && !path.starts_with("/reels/audio/")
}

/// Коэффициент масштаба для страницы `path` в области `width` x `height` (логические пиксели).
pub(crate) fn reels_zoom_factor(path: &str, width: i32, height: i32) -> f64 {
  if !is_reels_path(path) || width < MIN_WIDTH_FOR_ZOOM || height <= 0 {
    return 1.0;
  }
  if (height as f64) < (width as f64) * PORTRAIT_RATIO {
    return 1.0;
  }
  let zoom = (width as f64 / REELS_TARGET_CSS_WIDTH).min(REELS_MAX_ZOOM);
  let zoom = (zoom * 20.0).round() / 20.0;
  if zoom < REELS_MIN_ZOOM { 1.0 } else { zoom }
}

/// Сбрасывает кэш: у нового WebView масштаб снова 100 %.
pub(crate) fn reset() {
  LAST_ZOOM_PERCENT.store(100, Ordering::Release);
}

/// Запоминает область Instagram и применяет масштаб к текущей странице.
pub(crate) fn remember_bounds(app: &AppHandle, label: &str, width: i32, height: i32) {
  LAST_WIDTH.store(width, Ordering::Release);
  LAST_HEIGHT.store(height, Ordering::Release);
  apply(app, label, None);
}

/// Применяет масштаб для страницы `path` (или для текущего адреса WebView, если путь не задан).
/// Вычисление и запись идут в главном потоке: команды вызывают эту функцию из потоков tokio, а
/// SourceChanged приходит из UI-потока, и устаревший результат не должен перекрыть свежий.
pub(crate) fn apply(app: &AppHandle, label: &str, path: Option<&str>) {
  #[cfg(windows)]
  {
    let path = path.map(str::to_owned);
    let task_app = app.clone();
    let label = label.to_owned();
    let _ = app.run_on_main_thread(move || {
      let Some(webview) = task_app.get_webview(&label) else { return; };
      let path = path.unwrap_or_else(|| webview.url().map(|url| url.path().to_string()).unwrap_or_default());
      let zoom = reels_zoom_factor(&path, LAST_WIDTH.load(Ordering::Acquire), LAST_HEIGHT.load(Ordering::Acquire));
      let percent = (zoom * 100.0).round() as i32;
      if LAST_ZOOM_PERCENT.load(Ordering::Acquire) == percent {
        return;
      }
      match webview.set_zoom(zoom) {
        Ok(()) => LAST_ZOOM_PERCENT.store(percent, Ordering::Release),
        Err(error) => log::warn!("[InstagramView] Failed to set the zoom to {zoom}: {error}"),
      }
    });
  }
  #[cfg(not(windows))]
  let _ = (app, label, path);
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn portrait_reels_are_scaled_to_the_target_width() {
    assert_eq!(reels_zoom_factor("/reels/", 1080, 1800), 2.0);
    assert_eq!(reels_zoom_factor("/reels/ABC123/", 1080, 1800), 2.0);
    assert_eq!(reels_zoom_factor("/reels/ABC123/", 1000, 1700), 1.85);
  }

  #[test]
  fn other_pages_and_landscape_windows_keep_the_normal_scale() {
    assert_eq!(reels_zoom_factor("/", 1080, 1800), 1.0);
    assert_eq!(reels_zoom_factor("/direct/inbox/", 1080, 1800), 1.0);
    assert_eq!(reels_zoom_factor("/reelsxyz/", 1080, 1800), 1.0);
    assert_eq!(reels_zoom_factor("/reel/ABC123/", 1080, 1800), 1.0);
    assert_eq!(reels_zoom_factor("/reels/audio/123/", 1080, 1800), 1.0);
    assert_eq!(reels_zoom_factor("/reels/", 1800, 1000), 1.0);
    assert_eq!(reels_zoom_factor("/reels/", 1000, 1100), 1.0);
  }

  #[test]
  fn narrow_or_empty_areas_are_not_scaled() {
    assert_eq!(reels_zoom_factor("/reels/", 500, 1200), 1.0);
    assert_eq!(reels_zoom_factor("/reels/", 640, 0), 1.0);
  }

  #[test]
  fn zoom_is_capped_and_stepped() {
    assert_eq!(reels_zoom_factor("/reels/", 2400, 3800), 3.0);
    assert_eq!(reels_zoom_factor("/reels/", 1234, 2000), 2.3);
  }
}
