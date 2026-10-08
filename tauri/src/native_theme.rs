//! Нативная тема оболочки: цвет подложки дочерних WebView и тема окна.
//!
//! Страницы X, Instagram и Mini App рисуют свой фон сами; здесь задаётся только подложка,
//! которая видна до загрузки страницы и на шве между интерфейсом и нативным WebView.
//! Интерфейс присылает цвет роли `--color-background` активной темы Lagom командой `relay_set_theme`.

use std::sync::{LazyLock, Mutex, MutexGuard};

use tauri::{AppHandle, Manager, Theme, webview::Color};

/// Тёмный Lagom (`LAGOM_DARK.bg` в `src/util/lagomTheme.ts`): значение до первого сообщения интерфейса.
const DEFAULT_BACKGROUND: [u8; 3] = [0x0E, 0x0E, 0x0F];
const MAIN_WINDOW_LABEL: &str = "main";
const X_WEBVIEW_LABEL: &str = "x_webview";
const INSTAGRAM_WEBVIEW_LABEL: &str = "instagram_webview";
const MINI_APP_PREFIX: &str = "mini-app-";
const MINI_APP_POPUP_PREFIX: &str = "mini-app-popup-";
const AUTH_WINDOW_PREFIXES: [&str; 2] = ["x-auth-", "instagram-auth-"];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct NativeTheme {
  rgb: [u8; 3],
  is_dark: bool,
}

impl NativeTheme {
  const fn lagom_dark() -> Self {
    Self { rgb: DEFAULT_BACKGROUND, is_dark: true }
  }

  pub(crate) fn color(self) -> Color {
    Color(self.rgb[0], self.rgb[1], self.rgb[2], 255)
  }

  pub(crate) fn theme(self) -> Theme {
    if self.is_dark { Theme::Dark } else { Theme::Light }
  }
}

static CURRENT: LazyLock<Mutex<NativeTheme>> = LazyLock::new(|| Mutex::new(NativeTheme::lagom_dark()));

fn lock_current() -> MutexGuard<'static, NativeTheme> {
  // Состояние — два простых значения: отравление замка не может его испортить.
  CURRENT.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub(crate) fn current() -> NativeTheme {
  *lock_current()
}

/// Цвет подложки для нового WebView (вместо жёсткого `#000`).
pub(crate) fn background_color() -> Color {
  current().color()
}

/// Тема окна для нового окна (вместо жёсткого `Theme::Dark`).
pub(crate) fn window_theme() -> Theme {
  current().theme()
}

/// Строго `#RRGGBB`: без сокращений `#RGB`, без альфы, без пробелов и имён цветов.
pub(crate) fn parse_hex_color(value: &str) -> Result<[u8; 3], String> {
  let bytes = value.as_bytes();
  if bytes.len() != 7 || bytes[0] != b'#' || !bytes[1..].iter().all(u8::is_ascii_hexdigit) {
    return Err("Background must be #RRGGBB".to_string());
  }
  let channel = |start: usize| u8::from_str_radix(&value[start..start + 2], 16).map_err(|_| "Background must be #RRGGBB".to_string());
  Ok([channel(1)?, channel(3)?, channel(5)?])
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ThemedTarget {
  /// Дочерний WebView главного окна: X, Instagram, Mini App.
  ChildWebview,
  /// Отдельное окно: popup Mini App, окно входа X/Instagram.
  Window,
}

fn classify_label(label: &str) -> Option<ThemedTarget> {
  if label == X_WEBVIEW_LABEL || label == INSTAGRAM_WEBVIEW_LABEL {
    return Some(ThemedTarget::ChildWebview);
  }
  if label.starts_with(MINI_APP_POPUP_PREFIX) || AUTH_WINDOW_PREFIXES.iter().any(|prefix| label.starts_with(prefix)) {
    return Some(ThemedTarget::Window);
  }
  if label.starts_with(MINI_APP_PREFIX) {
    return Some(ThemedTarget::ChildWebview);
  }
  None
}

fn apply(app: &AppHandle, theme: NativeTheme) -> Vec<String> {
  let mut failures = Vec::new();
  let color = Some(theme.color());
  if let Some(main) = app.get_window(MAIN_WINDOW_LABEL) {
    if let Err(error) = main.set_theme(Some(theme.theme())) {
      failures.push(format!("main window theme: {error}"));
    }
  }
  for (label, window) in app.webview_windows() {
    if classify_label(&label) != Some(ThemedTarget::Window) {
      continue;
    }
    if let Err(error) = window.set_theme(Some(theme.theme())) {
      failures.push(format!("{label} theme: {error}"));
    }
    if let Err(error) = window.set_background_color(color) {
      failures.push(format!("{label} background: {error}"));
    }
  }
  for (label, webview) in app.webviews() {
    if classify_label(&label) != Some(ThemedTarget::ChildWebview) {
      continue;
    }
    if let Err(error) = webview.set_background_color(color) {
      failures.push(format!("{label} background: {error}"));
    }
  }
  failures
}

#[tauri::command]
pub fn relay_set_theme(app: AppHandle, background: String, is_dark: bool) -> Result<(), String> {
  let rgb = parse_hex_color(&background)?;
  let theme = NativeTheme { rgb, is_dark };
  *lock_current() = theme;
  let failures = apply(&app, theme);
  if failures.is_empty() {
    Ok(())
  } else {
    Err(failures.join("; "))
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn parses_only_strict_six_digit_hex() {
    assert_eq!(parse_hex_color("#0E0E0F"), Ok([0x0E, 0x0E, 0x0F]));
    assert_eq!(parse_hex_color("#f5f5f2"), Ok([0xF5, 0xF5, 0xF2]));
    assert_eq!(parse_hex_color("#000000"), Ok([0, 0, 0]));
    for invalid in [
      "", "#", "0E0E0F", "#0E0E0", "#0E0E0F0", "#0E0E0FFF", "#FFF", "#GGGGGG", "# 0E0E0F", " #0E0E0F", "#0E0E0F ",
      "#0E0E0F\n", "rgb(14,14,15)", "black", "#0E0E0é", "#+E0E0F", "#-E0E0F", "##0E0E0F", "#0x0E0F",
    ] {
      assert!(parse_hex_color(invalid).is_err(), "{invalid:?} must be rejected");
    }
  }

  #[test]
  fn multibyte_input_is_rejected_without_panicking() {
    // Семь байт, но не семь символов: срез по байтам не должен попасть внутрь символа.
    assert!(parse_hex_color("#ёё1").is_err());
    assert!(parse_hex_color("#日日").is_err());
  }

  #[test]
  fn default_is_opaque_lagom_dark_not_black() {
    let theme = NativeTheme::lagom_dark();
    assert_eq!(theme.color().0, 0x0E);
    assert_eq!(theme.color().1, 0x0E);
    assert_eq!(theme.color().2, 0x0F);
    assert_eq!(theme.color().3, 255);
    assert_eq!(theme.theme(), Theme::Dark);
  }

  #[test]
  fn theme_follows_the_dark_flag_and_color_is_always_opaque() {
    let light = NativeTheme { rgb: [0xF5, 0xF5, 0xF2], is_dark: false };
    assert_eq!(light.theme(), Theme::Light);
    assert_eq!(light.color().3, 255);
    assert_eq!(NativeTheme { is_dark: true, ..light }.theme(), Theme::Dark);
  }

  #[test]
  fn shared_state_is_replaced_and_read_back() {
    // Единственный тест, который меняет общее состояние: параллельные тесты его не читают.
    let before = current();
    *lock_current() = NativeTheme { rgb: [0xF5, 0xF5, 0xF2], is_dark: false };
    assert_eq!(window_theme(), Theme::Light);
    assert_eq!((background_color().0, background_color().1, background_color().2), (0xF5, 0xF5, 0xF2));
    *lock_current() = before;
    assert_eq!(current(), before);
  }

  #[test]
  fn labels_of_native_views_are_classified() {
    assert_eq!(classify_label("x_webview"), Some(ThemedTarget::ChildWebview));
    assert_eq!(classify_label("instagram_webview"), Some(ThemedTarget::ChildWebview));
    assert_eq!(classify_label("mini-app-6f1c"), Some(ThemedTarget::ChildWebview));
    assert_eq!(classify_label("mini-app-popup-6f1c"), Some(ThemedTarget::Window));
    assert_eq!(classify_label("x-auth-3"), Some(ThemedTarget::Window));
    assert_eq!(classify_label("instagram-auth-1"), Some(ThemedTarget::Window));
  }

  #[test]
  fn main_and_research_views_are_never_recolored() {
    for label in ["main", "relay-research-window-1", "relay-research-x", "relay-research-instagram", "", "x_webview2"] {
      assert_eq!(classify_label(label), None, "{label:?}");
    }
  }
}
