//! Масштаб WebView2 окон Instagram и X под размер области (только Windows).
//!
//! 1. Большие портретные экраны (монитор 1440x2560): окна сервисов получают тот же коэффициент,
//!    что и интерфейс Egoist Social (rem в `src/styles/index.scss`), иначе страницы выглядят мельче оболочки.
//! 2. Reels Instagram в портретном окне: Instagram ограничивает ширину колонки в CSS-пикселях,
//!    поэтому ролик остаётся узким. Масштаб сужает CSS-viewport до ~540 px: страница включает
//!    узкую раскладку с нижней панелью, DPR растёт и плеер берёт лучшее качество; вписывание
//!    ролика в экран делает `scripts/instagram-enhancer.js`.
//! Классы страниц Instagram не затрагиваются.

use std::sync::atomic::{AtomicI32, Ordering};

use tauri::AppHandle;
#[cfg(windows)]
use tauri::Manager;

/// Ширина CSS-viewport, к которой стремится масштаб Reels.
const REELS_TARGET_CSS_WIDTH: f64 = 540.0;
const REELS_MIN_ZOOM: f64 = 1.1;
const REELS_MAX_ZOOM: f64 = 3.0;
/// Окно считается портретным, когда высота не меньше ширины в этой пропорции.
const PORTRAIT_RATIO: f64 = 1.15;
/// Узкие окна не масштабируются: на них Instagram уже показывает узкую раскладку.
const MIN_WIDTH_FOR_ZOOM: i32 = 600;

/// Области сервисов меньше окна на боковую панель (72) и заголовок (40 px); пороги
/// соответствуют `@media` в `src/styles/index.scss` (1000x1700 и 1300x2300 для окна).
const LARGE_AREA: (i32, i32) = (928, 1660);
const XLARGE_AREA: (i32, i32) = (1228, 2260);

pub(crate) struct ViewState {
  width: AtomicI32,
  height: AtomicI32,
  zoom_percent: AtomicI32,
}

impl ViewState {
  const fn new() -> Self {
    Self { width: AtomicI32::new(0), height: AtomicI32::new(0), zoom_percent: AtomicI32::new(100) }
  }
}

static INSTAGRAM: ViewState = ViewState::new();
static X: ViewState = ViewState::new();

fn state_for(label: &str) -> Option<(&'static ViewState, bool)> {
  match label {
    "instagram_webview" => Some((&INSTAGRAM, true)),
    "x_webview" => Some((&X, false)),
    _ => None,
  }
}

/// Лента Reels и конкретный ролик в ней. Сетка роликов звука и модальные /reel/<id> не затрагиваются.
fn is_reels_path(path: &str) -> bool {
  (path == "/reels" || path.starts_with("/reels/")) && !path.starts_with("/reels/audio/")
}

/// Общий коэффициент интерфейса для области `width` x `height` (логические пиксели).
pub(crate) fn base_zoom_factor(width: i32, height: i32) -> f64 {
  if width >= XLARGE_AREA.0 && height >= XLARGE_AREA.1 {
    1.25
  } else if width >= LARGE_AREA.0 && height >= LARGE_AREA.1 {
    1.125
  } else {
    1.0
  }
}

/// Коэффициент масштаба для страницы `path` в области `width` x `height`.
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

/// Итоговый масштаб: Reels (если применим) важнее общего коэффициента.
pub(crate) fn zoom_for(is_instagram: bool, path: &str, width: i32, height: i32) -> f64 {
  if is_instagram {
    let reels = reels_zoom_factor(path, width, height);
    if reels > 1.0 {
      return reels;
    }
  }
  base_zoom_factor(width, height)
}

/// Сбрасывает кэш: у нового WebView масштаб снова 100 %.
pub(crate) fn reset(label: &str) {
  if let Some((state, _)) = state_for(label) {
    state.zoom_percent.store(100, Ordering::Release);
  }
}

/// Запоминает область сервиса и применяет масштаб к текущей странице.
pub(crate) fn remember_bounds(app: &AppHandle, label: &str, width: i32, height: i32) {
  let Some((state, _)) = state_for(label) else { return; };
  state.width.store(width, Ordering::Release);
  state.height.store(height, Ordering::Release);
  apply(app, label, None);
}

/// Применяет масштаб для страницы `path` (или для текущего адреса WebView, если путь не задан).
/// Вычисление и запись идут в главном потоке: команды вызывают эту функцию из потоков tokio, а
/// SourceChanged приходит из UI-потока, и устаревший результат не должен перекрыть свежий.
pub(crate) fn apply(app: &AppHandle, label: &str, path: Option<&str>) {
  #[cfg(windows)]
  {
    let Some((state, is_instagram)) = state_for(label) else { return; };
    let path = path.map(str::to_owned);
    let task_app = app.clone();
    let label = label.to_owned();
    let _ = app.run_on_main_thread(move || {
      let Some(webview) = task_app.get_webview(&label) else { return; };
      let path = path.unwrap_or_else(|| webview.url().map(|url| url.path().to_string()).unwrap_or_default());
      let zoom = zoom_for(is_instagram, &path, state.width.load(Ordering::Acquire), state.height.load(Ordering::Acquire));
      let percent = (zoom * 100.0).round() as i32;
      if state.zoom_percent.load(Ordering::Acquire) == percent {
        return;
      }
      match webview.set_zoom(zoom) {
        Ok(()) => state.zoom_percent.store(percent, Ordering::Release),
        Err(error) => log::warn!("[ViewZoom] Failed to set the zoom of {label} to {zoom}: {error}"),
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
  fn other_pages_and_landscape_windows_keep_the_normal_reels_scale() {
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
  fn reels_zoom_is_capped_and_stepped() {
    assert_eq!(reels_zoom_factor("/reels/", 2400, 3800), 3.0);
    assert_eq!(reels_zoom_factor("/reels/", 1234, 2000), 2.3);
  }

  #[test]
  fn interface_scale_follows_the_screen_class() {
    // монитор владельца 1440x2560: область сервисов 1368x2519
    assert_eq!(base_zoom_factor(1368, 2519), 1.25);
    assert_eq!(base_zoom_factor(1008, 1880), 1.125);
    assert_eq!(base_zoom_factor(1848, 1040), 1.0);
    assert_eq!(base_zoom_factor(800, 520), 1.0);
  }

  #[test]
  fn reels_override_the_interface_scale_only_for_instagram() {
    assert_eq!(zoom_for(true, "/reels/", 1368, 2519), 2.55);
    assert_eq!(zoom_for(true, "/", 1368, 2519), 1.25);
    assert_eq!(zoom_for(false, "/reels/", 1368, 2519), 1.25);
    assert_eq!(zoom_for(true, "/reels/", 1848, 1040), 1.0);
  }
}
