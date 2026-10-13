//! Сон скрытых WebView2 (рекомендация Microsoft по производительности).
//!
//! X и Instagram, скрытые на 30 с (другой сервис, окно свёрнуто или в трее): MemoryUsageTargetLevel=LOW,
//! через 5 мин TrySuspend (только если нет живого research-окна этого провайдера и загрузка завершена).
//! Главное окно Telegram при сворачивании или трее: только LOW, без suspend.
//! При показе: Resume (если был suspend) и NORMAL до show. Таймеры отменяются счётчиком поколения.
//! Вся работа с COM идёт на главном потоке.

use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Condvar, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

use super::{INSTAGRAM_APP, INSTAGRAM_WEBVIEW_LABEL, TELEGRAM_APP, X_APP, X_WEBVIEW_LABEL};

pub(super) const LOW_DELAY: Duration = Duration::from_secs(30);
pub(super) const SUSPEND_DELAY: Duration = Duration::from_secs(300);

const LEVEL_NORMAL: u8 = 0;
const LEVEL_LOW: u8 = 1;
const LEVEL_SUSPENDED: u8 = 2;

/// Событие для rail: сервис усыплён (`TrySuspend` принят) или проснулся
pub(super) const SLEEP_EVENT: &str = "multi-service-sleep";

fn emit_sleep(app: &AppHandle, service: &str, sleeping: bool) {
  let _ = app.emit_to("main", SLEEP_EVENT, serde_json::json!({ "service": service, "sleeping": sleeping }));
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Stage {
  Low,
  Suspend,
}

/// Расписание: пары (ожидание перед стадией, стадия). Задержки в `Stage::Suspend` отсчитываются
/// от момента сна, поэтому вторая пауза равна разности.
pub(super) fn plan(may_suspend: bool, low: Duration, suspend: Duration) -> Vec<(Duration, Stage)> {
  let mut stages = vec![(low, Stage::Low)];
  if may_suspend {
    stages.push((suspend.saturating_sub(low), Stage::Suspend));
  }
  stages
}

/// Что нужно сделать при пробуждении из уровня `level`: (Resume, вернуть NORMAL).
pub(super) fn wake_needs(level: u8) -> (bool, bool) {
  (level == LEVEL_SUSPENDED, level != LEVEL_NORMAL)
}

/// Suspend разрешён, если нет живого research-окна провайдера, загрузка завершена и страница не играет звук.
pub(super) fn suspend_allowed(research_alive: bool, load_state: &str, playing_audio: bool) -> bool {
  !research_alive && load_state == "ready" && !playing_audio
}

fn research_label(service: &str) -> Option<&'static str> {
  match service {
    X_APP => Some("relay-research-x"),
    INSTAGRAM_APP => Some("relay-research-instagram"),
    _ => None,
  }
}

struct SlotState {
  epoch: u64,
  armed: bool,
}

pub(super) struct Slot {
  state: Mutex<SlotState>,
  changed: Condvar,
  level: AtomicU8,
  hidden_by_sleep: AtomicBool,
}

impl Slot {
  pub(super) const fn new() -> Self {
    Self {
      state: Mutex::new(SlotState { epoch: 0, armed: false }),
      changed: Condvar::new(),
      level: AtomicU8::new(LEVEL_NORMAL),
      hidden_by_sleep: AtomicBool::new(false),
    }
  }

  /// Ставит таймер. Если он уже стоит, возвращает None, чтобы повторное скрытие не сбрасывало отсчёт.
  pub(super) fn arm(&self) -> Option<u64> {
    let mut state = self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if state.armed {
      return None;
    }
    state.armed = true;
    state.epoch = state.epoch.wrapping_add(1);
    Some(state.epoch)
  }

  /// Отменяет таймер и будит ожидающие потоки. Возвращает true, если таймер стоял.
  pub(super) fn disarm(&self) -> bool {
    let mut state = self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let was_armed = state.armed;
    state.armed = false;
    state.epoch = state.epoch.wrapping_add(1);
    drop(state);
    self.changed.notify_all();
    was_armed
  }

  pub(super) fn is_current(&self, epoch: u64) -> bool {
    self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).epoch == epoch
  }

  /// Ждёт `duration`. Возвращает true, если за это время поколение не менялось.
  pub(super) fn wait_current(&self, epoch: u64, duration: Duration) -> bool {
    let state = self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let (state, _) = self
      .changed
      .wait_timeout_while(state, duration, |state| state.epoch == epoch)
      .unwrap_or_else(|poisoned| poisoned.into_inner());
    state.epoch == epoch
  }
}

static X_SLOT: Slot = Slot::new();
static INSTAGRAM_SLOT: Slot = Slot::new();
static MAIN_SLOT: Slot = Slot::new();

fn slot_for(service: &str) -> Option<&'static Slot> {
  match service {
    X_APP => Some(&X_SLOT),
    INSTAGRAM_APP => Some(&INSTAGRAM_SLOT),
    TELEGRAM_APP => Some(&MAIN_SLOT),
    _ => None,
  }
}

fn label_for(service: &str) -> Option<&'static str> {
  match service {
    X_APP => Some(X_WEBVIEW_LABEL),
    INSTAGRAM_APP => Some(INSTAGRAM_WEBVIEW_LABEL),
    TELEGRAM_APP => Some("main"),
    _ => None,
  }
}

/// Запускает отсчёт сна для скрытого сервиса. Повторный вызов при уже идущем отсчёте ничего не делает.
pub(super) fn schedule(app: &AppHandle, service: &'static str) {
  let (Some(slot), Some(label)) = (slot_for(service), label_for(service)) else { return; };
  if app.get_webview(label).is_none() {
    return;
  }
  let Some(epoch) = slot.arm() else { return; };
  let app = app.clone();
  let stages = plan(service != TELEGRAM_APP, LOW_DELAY, SUSPEND_DELAY);
  std::thread::spawn(move || {
    for (delay, stage) in stages {
      if !slot.wait_current(epoch, delay) {
        return;
      }
      apply_stage(&app, service, slot, epoch, stage);
    }
  });
}

/// Будит сервис: отменяет таймеры, при необходимости Resume и NORMAL. Вызывать до show.
/// Безопасно вызывать с любого потока, в том числе с главного.
pub(super) fn wake(app: &AppHandle, service: &'static str) {
  let Some(slot) = slot_for(service) else { return; };
  slot.disarm();
  if slot.level.load(Ordering::Acquire) == LEVEL_NORMAL && !slot.hidden_by_sleep.load(Ordering::Acquire) {
    return;
  }
  let app_for_main = app.clone();
  if let Err(error) = super::run_on_main(app, move || wake_on_main(&app_for_main, service, slot)) {
    log::warn!("[MultiApp] {service} could not wake: {error}");
  }
}

fn apply_stage(app: &AppHandle, service: &'static str, slot: &'static Slot, epoch: u64, stage: Stage) {
  let app_for_main = app.clone();
  let result = super::run_on_main(app, move || {
    if !slot.is_current(epoch) {
      return;
    }
    stage_on_main(&app_for_main, service, slot, epoch, stage);
  });
  if let Err(error) = result {
    log::warn!("[MultiApp] {service} sleep stage {stage:?} skipped: {error}");
  }
}

fn stage_on_main(app: &AppHandle, service: &'static str, slot: &'static Slot, epoch: u64, stage: Stage) {
  let Some(webview) = label_for(service).and_then(|label| app.get_webview(label)) else {
    return;
  };
  match stage {
    Stage::Low => match platform::set_low(&webview, true) {
      Ok(()) => {
        slot.level.store(LEVEL_LOW, Ordering::Release);
        log::info!("[MultiApp] {service} sleep level low");
      }
      Err(error) => log::warn!("[MultiApp] {service} could not lower memory level: {error}"),
    },
    Stage::Suspend => {
      let research_alive = research_label(service).is_some_and(|label| app.get_webview(label).is_some());
      let load_state = super::get_service_load_state(service);
      let playing_audio = platform::is_playing_audio(&webview);
      if !suspend_allowed(research_alive, load_state, playing_audio) {
        log::info!("[MultiApp] {service} suspend skipped (research={research_alive}, state={load_state}, audio={playing_audio})");
        return;
      }
      // Активный сервис при свёрнутом окне ещё "виден" контроллеру: без скрытия TrySuspend отказывает
      if super::get_active_app() == service && platform::hide_controller(&webview).is_ok() {
        slot.hidden_by_sleep.store(true, Ordering::Release);
      }
      let completion_app = app.clone();
      let result = platform::try_suspend(&webview, move |suspended| {
        if !suspended {
          log::info!("[MultiApp] {service} suspend was declined by WebView2");
          return;
        }
        if slot.is_current(epoch) {
          slot.level.store(LEVEL_SUSPENDED, Ordering::Release);
          log::info!("[MultiApp] {service} sleep level suspended");
          emit_sleep(&completion_app, service, true);
        } else if let Some(webview) = label_for(service).and_then(|label| completion_app.get_webview(label)) {
          // Пользователь вернулся, пока TrySuspend выполнялся
          let _ = platform::resume(&webview);
        }
      });
      if let Err(error) = result {
        log::warn!("[MultiApp] {service} could not suspend: {error}");
      }
    }
  }
}

fn wake_on_main(app: &AppHandle, service: &'static str, slot: &'static Slot) {
  let level = slot.level.swap(LEVEL_NORMAL, Ordering::AcqRel);
  let (needs_resume, needs_normal) = wake_needs(level);
  if let Some(webview) = label_for(service).and_then(|label| app.get_webview(label)) {
    if needs_resume {
      match platform::resume(&webview) {
        Ok(()) => log::info!("[MultiApp] {service} resumed"),
        Err(error) => log::warn!("[MultiApp] {service} could not resume: {error}"),
      }
    }
    if needs_normal {
      if let Err(error) = platform::set_low(&webview, false) {
        log::warn!("[MultiApp] {service} could not restore memory level: {error}");
      } else if !needs_resume {
        log::info!("[MultiApp] {service} sleep level normal");
      }
    }
  }
  if needs_resume {
    emit_sleep(app, service, false);
  }
  if slot.hidden_by_sleep.swap(false, Ordering::AcqRel) {
    let _ = super::restore_native_content(app);
  }
}

#[cfg(windows)]
mod platform {
  use std::sync::mpsc;
  use std::time::Duration;

  use webview2_com::{
    Microsoft::Web::WebView2::Win32::{
      COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
      ICoreWebView2_3, ICoreWebView2_8, ICoreWebView2_19,
    },
    TrySuspendCompletedHandler,
  };
  use windows_core::Interface;

  const COM_TIMEOUT: Duration = Duration::from_secs(2);

  /// Выполняет `f` внутри `with_webview`. Вызывать только с главного потока: там замыкание идёт сразу.
  fn with_core<T: Send + 'static>(
    webview: &tauri::Webview,
    f: impl FnOnce(&webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller, &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2) -> windows_core::Result<T> + Send + 'static,
  ) -> Result<T, String> {
    let (sender, receiver) = mpsc::channel();
    webview
      .with_webview(move |platform| {
        let controller = platform.controller();
        let result = unsafe { controller.CoreWebView2().and_then(|core| f(&controller, &core)) };
        let _ = sender.send(result.map_err(|error| error.to_string()));
      })
      .map_err(|error| error.to_string())?;
    receiver.recv_timeout(COM_TIMEOUT).map_err(|_| "WEBVIEW_COM_TIMEOUT".to_string())?
  }

  pub(super) fn set_low(webview: &tauri::Webview, low: bool) -> Result<(), String> {
    with_core(webview, move |_, core| unsafe {
      let level = if low { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW } else { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL };
      core.cast::<ICoreWebView2_19>()?.SetMemoryUsageTargetLevel(level)
    })
  }

  pub(super) fn is_playing_audio(webview: &tauri::Webview) -> bool {
    with_core(webview, |_, core| unsafe {
      let mut playing = false.into();
      core.cast::<ICoreWebView2_8>()?.IsDocumentPlayingAudio(&mut playing)?;
      Ok(playing.as_bool())
    })
    .unwrap_or(false)
  }

  pub(super) fn hide_controller(webview: &tauri::Webview) -> Result<(), String> {
    with_core(webview, |controller, _| unsafe { controller.SetIsVisible(false) })
  }

  /// Запускает TrySuspend; `done(true)` вызывается на главном потоке, когда suspend состоялся.
  pub(super) fn try_suspend(
    webview: &tauri::Webview,
    done: impl FnOnce(bool) + Send + 'static,
  ) -> Result<(), String> {
    with_core(webview, move |_, core| unsafe {
      let core = core.cast::<ICoreWebView2_3>()?;
      let handler = TrySuspendCompletedHandler::create(Box::new(move |result, suspended| {
        done(result.is_ok() && suspended);
        Ok(())
      }));
      core.TrySuspend(&handler)
    })
  }

  pub(super) fn resume(webview: &tauri::Webview) -> Result<(), String> {
    with_core(webview, |_, core| unsafe {
      let core = core.cast::<ICoreWebView2_3>()?;
      let mut suspended = false.into();
      core.IsSuspended(&mut suspended)?;
      if suspended.as_bool() { core.Resume() } else { Ok(()) }
    })
  }
}

#[cfg(not(windows))]
mod platform {
  pub(super) fn set_low(_: &tauri::Webview, _: bool) -> Result<(), String> { Ok(()) }
  pub(super) fn is_playing_audio(_: &tauri::Webview) -> bool { false }
  pub(super) fn hide_controller(_: &tauri::Webview) -> Result<(), String> { Ok(()) }
  pub(super) fn try_suspend(_: &tauri::Webview, done: impl FnOnce(bool) + Send + 'static) -> Result<(), String> {
    done(false);
    Ok(())
  }
  pub(super) fn resume(_: &tauri::Webview) -> Result<(), String> { Ok(()) }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn plan_has_low_then_suspend_for_social_and_only_low_for_telegram() {
    assert_eq!(
      plan(true, LOW_DELAY, SUSPEND_DELAY),
      vec![(Duration::from_secs(30), Stage::Low), (Duration::from_secs(270), Stage::Suspend)]
    );
    assert_eq!(plan(false, LOW_DELAY, SUSPEND_DELAY), vec![(Duration::from_secs(30), Stage::Low)]);
  }

  #[test]
  fn wake_needs_resume_only_after_suspend() {
    assert_eq!(wake_needs(LEVEL_NORMAL), (false, false));
    assert_eq!(wake_needs(LEVEL_LOW), (false, true));
    assert_eq!(wake_needs(LEVEL_SUSPENDED), (true, true));
  }

  #[test]
  fn suspend_requires_no_research_window_ready_state_and_silence() {
    assert!(suspend_allowed(false, "ready", false));
    assert!(!suspend_allowed(true, "ready", false));
    assert!(!suspend_allowed(false, "loading", false));
    assert!(!suspend_allowed(false, "error", false));
    assert!(!suspend_allowed(false, "ready", true));
  }

  #[test]
  fn slot_arm_is_idempotent_until_disarmed() {
    let slot = Slot::new();
    let first = slot.arm().expect("first arm");
    assert_eq!(slot.arm(), None);
    assert!(slot.is_current(first));
    assert!(slot.disarm());
    assert!(!slot.is_current(first));
    assert!(!slot.disarm());
    assert!(slot.arm().is_some());
  }

  #[test]
  fn wait_current_survives_timeout_and_breaks_on_disarm() {
    let slot = std::sync::Arc::new(Slot::new());
    let epoch = slot.arm().unwrap();
    assert!(slot.wait_current(epoch, Duration::from_millis(20)));
    let waiter = {
      let slot = slot.clone();
      std::thread::spawn(move || slot.wait_current(epoch, Duration::from_secs(10)))
    };
    std::thread::sleep(Duration::from_millis(50));
    slot.disarm();
    assert!(!waiter.join().unwrap());
  }

  #[test]
  fn research_labels_cover_only_social_providers() {
    assert_eq!(research_label(X_APP), Some("relay-research-x"));
    assert_eq!(research_label(INSTAGRAM_APP), Some("relay-research-instagram"));
    assert_eq!(research_label(TELEGRAM_APP), None);
  }
}
