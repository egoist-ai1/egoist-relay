//! Чистая логика восстановления сервисов X/Instagram: когда игнорировать resize, как ограничивать
//! пересоздание WebView, один автоповтор загрузки, замер времени begin -> ready.
//! Здесь нет обращений к WebView и окнам, поэтому всё проверяется юнит-тестами.

use std::collections::VecDeque;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

/// Не более `MAX_RECREATIONS` пересозданий WebView за `RECREATION_WINDOW` на сервис.
pub(super) const MAX_RECREATIONS: usize = 3;
pub(super) const RECREATION_WINDOW: Duration = Duration::from_secs(300);
/// Пауза перед единственным автоповтором загрузки.
pub(super) const AUTO_RETRY_DELAY: Duration = Duration::from_secs(3);

/// Свёрнутое окно и нулевой размер дают `inner_size` 0x0; пересчёт bounds в этот момент
/// превращался в состояние error у активного сервиса.
pub(super) fn should_ignore_resize(minimized: bool, width: u32, height: u32) -> bool {
  minimized || width == 0 || height == 0
}

/// Окно скрыто для пользователя: свёрнуто либо убрано в трей.
pub(super) fn is_window_hidden(minimized: bool, visible: bool) -> bool {
  minimized || !visible
}

pub(super) struct RecreateLimiter {
  times: VecDeque<Instant>,
}

impl RecreateLimiter {
  pub(super) const fn new() -> Self {
    Self { times: VecDeque::new() }
  }

  /// Разрешает очередное пересоздание и запоминает его, либо отказывает.
  pub(super) fn allow(&mut self, now: Instant) -> bool {
    while let Some(first) = self.times.front() {
      if now.saturating_duration_since(*first) >= RECREATION_WINDOW {
        self.times.pop_front();
      } else {
        break;
      }
    }
    if self.times.len() >= MAX_RECREATIONS {
      return false;
    }
    self.times.push_back(now);
    true
  }
}

/// Один автоповтор на загрузку: первый вызов возвращает true, остальные false до `reset`.
pub(super) struct AutoRetry(AtomicBool);

impl AutoRetry {
  pub(super) const fn new() -> Self {
    Self(AtomicBool::new(false))
  }

  pub(super) fn take(&self) -> bool {
    !self.0.swap(true, Ordering::AcqRel)
  }

  pub(super) fn reset(&self) {
    self.0.store(false, Ordering::Release);
  }
}

/// Начало загрузки запоминается один раз за серию переходов, `finish` отдаёт длительность.
pub(super) struct LoadTimer(Mutex<Option<Instant>>);

impl LoadTimer {
  pub(super) const fn new() -> Self {
    Self(Mutex::new(None))
  }

  pub(super) fn begin(&self, now: Instant) {
    self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).get_or_insert(now);
  }

  pub(super) fn finish(&self, now: Instant) -> Option<Duration> {
    self.0
      .lock()
      .unwrap_or_else(|poisoned| poisoned.into_inner())
      .take()
      .map(|started| now.saturating_duration_since(started))
  }
}

/// Ошибка операции над WebView. Таймаут (главный поток занят) не означает смерть контроллера:
/// пересоздавать WebView нужно только при `Dead`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum WebviewOpError {
  /// Главный поток или проба не ответили вовремя; состояние WebView неизвестно.
  Timeout(String),
  /// WebView отсутствует или контроллер ответил ошибкой COM.
  Dead(String),
}

impl WebviewOpError {
  pub(super) fn is_dead(&self) -> bool {
    matches!(self, Self::Dead(_))
  }
}

impl std::fmt::Display for WebviewOpError {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    match self {
      Self::Timeout(message) | Self::Dead(message) => f.write_str(message),
    }
  }
}

impl From<WebviewOpError> for String {
  fn from(error: WebviewOpError) -> Self {
    error.to_string()
  }
}

/// Выполняет операцию; при таймауте повторяет один раз без пересоздания WebView.
pub(super) fn retry_on_timeout<T>(mut op: impl FnMut() -> Result<T, WebviewOpError>) -> Result<T, WebviewOpError> {
  match op() {
    Err(WebviewOpError::Timeout(_)) => op(),
    other => other,
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn only_dead_error_requires_recreation() {
    assert!(WebviewOpError::Dead("com".into()).is_dead());
    assert!(!WebviewOpError::Timeout("slow".into()).is_dead());
    assert_eq!(String::from(WebviewOpError::Timeout("slow".into())), "slow");
  }

  #[test]
  fn timeout_is_retried_once_then_reported() {
    let mut calls = 0;
    let result = retry_on_timeout(|| {
      calls += 1;
      if calls == 1 { Err(WebviewOpError::Timeout("t".into())) } else { Ok(()) }
    });
    assert_eq!((result, calls), (Ok(()), 2));

    let mut calls = 0;
    let result: Result<(), _> = retry_on_timeout(|| {
      calls += 1;
      Err(WebviewOpError::Timeout("t".into()))
    });
    assert_eq!((result.map_err(|e| e.is_dead()), calls), (Err(false), 2));
  }

  #[test]
  fn dead_error_is_not_retried() {
    let mut calls = 0;
    let result: Result<(), _> = retry_on_timeout(|| {
      calls += 1;
      Err(WebviewOpError::Dead("d".into()))
    });
    assert!(result.is_err_and(|e| e.is_dead()));
    assert_eq!(calls, 1);
  }

  #[test]
  fn resize_is_ignored_for_minimized_or_empty_window() {
    assert!(should_ignore_resize(true, 1200, 800));
    assert!(should_ignore_resize(false, 0, 800));
    assert!(should_ignore_resize(false, 1200, 0));
    assert!(!should_ignore_resize(false, 1200, 800));
  }

  #[test]
  fn window_is_hidden_when_minimized_or_in_tray() {
    assert!(is_window_hidden(true, true));
    assert!(is_window_hidden(false, false));
    assert!(!is_window_hidden(false, true));
  }

  #[test]
  fn limiter_allows_three_per_window_then_recovers() {
    let start = Instant::now();
    let mut limiter = RecreateLimiter::new();
    assert!(limiter.allow(start));
    assert!(limiter.allow(start + Duration::from_secs(10)));
    assert!(limiter.allow(start + Duration::from_secs(20)));
    assert!(!limiter.allow(start + Duration::from_secs(30)));
    assert!(!limiter.allow(start + Duration::from_secs(299)));
    // Первое пересоздание вышло из окна, освободилось одно место
    assert!(limiter.allow(start + Duration::from_secs(300)));
    assert!(!limiter.allow(start + Duration::from_secs(301)));
  }

  #[test]
  fn auto_retry_is_single_until_reset() {
    let retry = AutoRetry::new();
    assert!(retry.take());
    assert!(!retry.take());
    retry.reset();
    assert!(retry.take());
  }

  #[test]
  fn load_timer_measures_from_first_begin() {
    let timer = LoadTimer::new();
    let start = Instant::now();
    assert_eq!(timer.finish(start), None);
    timer.begin(start);
    timer.begin(start + Duration::from_secs(5));
    assert_eq!(timer.finish(start + Duration::from_secs(8)), Some(Duration::from_secs(8)));
    assert_eq!(timer.finish(start + Duration::from_secs(9)), None);
  }
}
