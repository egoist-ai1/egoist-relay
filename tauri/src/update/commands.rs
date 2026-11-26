//! Tauri-команды и фоновая политика обновления. Команды принимает ТОЛЬКО главное окно (`main`):
//! окна с чужим содержимым (`openNewWindow`, UUID-метки) прав не получают ни в capability, ни здесь.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use super::error::UpdateError;
use super::flow::{self, Check, InstallEnv, Offer, ProgressEvent};
use super::source::CachedLatest;
use super::manifest::SizeBounds;
use super::pubkeys::trusted_keys;
use super::settings::{self, UpdateMode};
use super::source::{GithubSource, ReqwestClient};
use super::stage::{self, MAX_ATTEMPTS, ProcessLauncher, StageDirs, StartupOutcome};
use super::token::Token;
use super::{current_version, updater_enabled};

const FIRST_CHECK_DELAY: Duration = Duration::from_secs(60);
const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
const IDLE_TIMEOUT: Duration = Duration::from_secs(60);
const MAIN_LABEL: &str = "main";

/// Результат проверки живёт в памяти столько: частые вызовы окна не ходят в сеть (лимит токена общий на всех клиентов).
const CACHE_TTL: Duration = Duration::from_secs(60 * 60);

/// Одновременно выполняется одна операция обновления. `tokio::sync::Mutex`: `update_install` не получает отказ,
/// а ждёт, пока закончится фоновая подготовка файла (режим `auto`).
static OP: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Память проверок: последний результат, время и ответ `releases/latest` (ETag, манифест, подпись).
struct CheckCache {
  at: Option<Instant>,
  check: Option<Check>,
  latest: Option<CachedLatest>,
}

static CACHE: std::sync::Mutex<CheckCache> = std::sync::Mutex::new(CheckCache { at: None, check: None, latest: None });

fn cache() -> std::sync::MutexGuard<'static, CheckCache> {
  CACHE.lock().unwrap_or_else(|e| e.into_inner())
}

/// Результат не старше `ttl`.
fn cached_check(ttl: Duration) -> Option<Check> {
  let c = cache();
  match (&c.at, &c.check) {
    (Some(at), Some(check)) if at.elapsed() < ttl => Some(check.clone()),
    _ => None,
  }
}

/// Последний известный результат любого возраста.
fn last_known_check() -> Option<Check> {
  cache().check.clone()
}

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CheckResult {
  pub available: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub version: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub notes: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub size: Option<u64>,
}

impl CheckResult {
  fn from_check(check: &Check) -> CheckResult {
    match check {
      Check::UpToDate => CheckResult { available: false, version: None, notes: None, size: None },
      Check::Available(offer) => CheckResult {
        available: true,
        version: Some(offer.version.to_string()),
        notes: Some(offer.manifest.notes.clone()),
        size: Some(offer.manifest.installer.size),
      },
    }
  }
}

/// Событие `update-available` для главного окна.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct AvailablePayload {
  version: String,
  notes: String,
  size: u64,
  /// Установщик уже скачан и проверен (режим `auto`).
  ready: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct ManualPayload {
  version: String,
  message: String,
}

fn require_main(webview: &tauri::Webview) -> Result<(), String> {
  // Только главное окно со своим (локальным) содержимым: чужая страница в окне `main` прав не получает.
  let url = webview.url().map_err(|_| "UPDATE_DENIED".to_string())?;
  let is_local = (matches!(url.scheme(), "http" | "https")
    && matches!(url.host_str(), Some("tauri.localhost" | "localhost" | "127.0.0.1")))
    || (url.scheme() == "tauri" && url.host_str() == Some("localhost"));
  if webview.label() == MAIN_LABEL && is_local { Ok(()) } else { Err("UPDATE_DENIED".to_string()) }
}

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, UpdateError> {
  app.path().app_local_data_dir().map_err(|e| UpdateError::Io(e.to_string()))
}

fn stage_dirs(app: &AppHandle) -> Result<StageDirs, UpdateError> {
  Ok(StageDirs::new(app_data_dir(app)?.join("updates")))
}

/// Проверка с кэшем: свежий результат берётся из памяти; иначе один условный запрос по ETag
/// (304 — без скачивания манифеста и подписи). Вызывать под `OP`.
async fn refresh(ttl: Duration) -> Result<Check, UpdateError> {
  if !updater_enabled() {
    return Err(UpdateError::Unavailable);
  }
  if let Some(check) = cached_check(ttl) {
    return Ok(check);
  }
  let client = http_client()?;
  let src = GithubSource::new(&client, Token::embedded())?;
  let mut latest = cache().latest.clone();
  let outcome = flow::check_with(&src, &trusted_keys(), &current_version(), SizeBounds::PRODUCTION, &mut latest).await;
  let mut c = cache();
  c.latest = latest;
  let check = outcome?;
  c.at = Some(Instant::now());
  c.check = Some(check.clone());
  Ok(check)
}

/// Предложение, которое можно показывать и качать автоматически: версия, отказавшая `MAX_ATTEMPTS` раз, не повторяется.
fn auto_offer<'a>(check: &'a Check, data: &Path) -> Option<&'a Offer> {
  let Check::Available(offer) = check else { return None };
  if settings::read_failed_version(data).as_deref() == Some(offer.version.to_string().as_str()) {
    return None;
  }
  Some(offer)
}

fn result_for_ui(check: &Check, data: &Path) -> CheckResult {
  match auto_offer(check, data) {
    Some(_) => CheckResult::from_check(check),
    None => CheckResult::from_check(&Check::UpToDate),
  }
}

fn http_client() -> Result<ReqwestClient, UpdateError> {
  ReqwestClient::new().map_err(UpdateError::Network)
}

/// Проверить наличие обновления. Ничего не скачивает; отвечает из памяти, пока результат свежий (час).
#[tauri::command]
pub(crate) async fn update_check(webview: tauri::Webview, app: AppHandle) -> Result<CheckResult, String> {
  require_main(&webview)?;
  let data = app_data_dir(&app).map_err(|e| e.to_string())?;
  if let Some(check) = cached_check(CACHE_TTL) {
    return Ok(result_for_ui(&check, &data));
  }
  let Ok(_op) = OP.try_lock() else {
    // Идёт фоновая подготовка: не ждём её, отвечаем последним известным.
    return match last_known_check() {
      Some(check) => Ok(result_for_ui(&check, &data)),
      None => Err(UpdateError::Busy.to_string()),
    };
  };
  let check = refresh(CACHE_TTL).await.map_err(|e| e.to_string())?;
  Ok(result_for_ui(&check, &data))
}

/// Скачать, проверить и запустить установщик; после успешного запуска приложение завершается.
#[tauri::command]
pub(crate) async fn update_install(
  webview: tauri::Webview,
  app: AppHandle,
  on_event: tauri::ipc::Channel<ProgressEvent>,
) -> Result<(), String> {
  require_main(&webview)?;
  // Ждём окончания фоновой подготовки, а не отказываем.
  let _op = OP.lock().await;
  let data = app_data_dir(&app).map_err(|e| e.to_string())?;
  let dirs = stage_dirs(&app).map_err(|e| e.to_string())?;
  // Предложение обновляем условным запросом (ETag) и проверяем подпись: от окна приходит только команда «ставить».
  let check = refresh(Duration::ZERO).await.map_err(|e| e.to_string())?;
  let Check::Available(offer) = check else {
    return Err("Установлена последняя версия, обновлять нечего.".to_string());
  };
  if auto_offer(&Check::Available(offer.clone()), &data).is_none() {
    return Err(manual_message(&offer.version.to_string()));
  }
  let client = http_client().map_err(|e| e.to_string())?;
  let src = GithubSource::new(&client, Token::embedded()).map_err(|e| e.to_string())?;
  let env = InstallEnv {
    dirs: &dirs,
    free_space: &stage::free_space,
    launcher: Arc::new(ProcessLauncher),
    idle: IDLE_TIMEOUT,
  };
  flow::install(&src, &offer, &env, &mut |event| {
    let _ = on_event.send(event);
  })
  .await
  .map_err(|e| {
    log::warn!("[EgoistRelay] Update install failed: {e}");
    e.to_string()
  })?;
  log::info!("[EgoistRelay] Update installer {} started, exiting", offer.version);
  let handle = app.clone();
  tauri::async_runtime::spawn(async move {
    // Дать ответу команды дойти до окна, затем штатно завершиться: установщик ждёт закрытия приложения.
    // Если установщик не справится, он сам вернёт прежнюю версию, а при следующем старте придёт `update-failed`.
    tokio::time::sleep(Duration::from_millis(400)).await;
    handle.exit(0);
  });
  Ok(())
}

fn manual_message(version: &str) -> String {
  format!("Автоматическая установка версии {version} не удалась несколько раз. Скачайте новый установщик вручную.")
}

#[tauri::command]
pub(crate) fn update_get_mode(webview: tauri::Webview, app: AppHandle) -> Result<UpdateMode, String> {
  require_main(&webview)?;
  Ok(settings::read_mode(&app_data_dir(&app).map_err(|e| e.to_string())?))
}

#[tauri::command]
pub(crate) fn update_set_mode(webview: tauri::Webview, app: AppHandle, mode: UpdateMode) -> Result<(), String> {
  require_main(&webview)?;
  settings::write_mode(&app_data_dir(&app).map_err(|e| e.to_string())?, mode)
}

fn emit_available(app: &AppHandle, offer: &Offer, ready: bool) {
  let payload = AvailablePayload {
    version: offer.version.to_string(),
    notes: offer.manifest.notes.clone(),
    size: offer.manifest.installer.size,
    ready,
  };
  let _ = app.emit_to(MAIN_LABEL, "update-available", payload);
}

/// Автоматическая проверка по расписанию. Все ошибки только в журнал: пользователя они не отвлекают.
async fn background_check(app: &AppHandle) {
  if !updater_enabled() {
    return;
  }
  let Ok(data) = app_data_dir(app) else { return };
  let mode = settings::read_mode(&data);
  if mode == UpdateMode::Off {
    return;
  }
  let Ok(_op) = OP.try_lock() else { return };
  let result = async {
    let check = refresh(CACHE_TTL).await?;
    if let Some(offer) = auto_offer(&check, &data) {
      emit_available(app, offer, false);
      if mode == UpdateMode::Auto {
        // Только подготовка файла: запуск установщика остаётся за пользователем (`update_install`).
        let dirs = stage_dirs(app)?;
        let client = http_client()?;
        let src = GithubSource::new(&client, Token::embedded())?;
        let env = InstallEnv {
          dirs: &dirs,
          free_space: &stage::free_space,
          launcher: Arc::new(ProcessLauncher),
          idle: IDLE_TIMEOUT,
        };
        flow::prepare(&src, offer, &env, &mut |_| {}).await?;
        emit_available(app, offer, true);
      }
    }
    Ok::<(), UpdateError>(())
  }
  .await;
  if let Err(e) = result {
    log::info!("[EgoistRelay] Update check skipped: {e}");
  }
}

/// Событие `update-failed`: прошлая установка не завершилась (версия не выросла), попытки ещё есть.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct FailedPayload {
  version: String,
  attempts: u32,
  message: String,
}

/// Вызывается из `setup`: очистка стадии новой версии и расписание проверок. Не блокирует запуск.
pub fn start(app: &AppHandle) {
  if std::env::var("EGOIST_RELAY_SMOKE_TEST").as_deref() == Ok("1") {
    return;
  }
  let handle = app.clone();
  tauri::async_runtime::spawn(async move {
    let notice = match stage_dirs(&handle) {
      Ok(dirs) => {
        let current = current_version();
        tokio::task::spawn_blocking(move || stage::startup_check(&dirs, &current)).await.ok()
      }
      Err(_) => None,
    };
    let data = app_data_dir(&handle).ok();
    // Версия, отказавшая три раза, запоминается в настройках (каталог стадии при этом удалён).
    if let (Some(StartupOutcome::Manual { version }), Some(data)) = (&notice, &data)
      && let Err(e) = settings::write_failed_version(data, Some(version))
    {
      log::warn!("[EgoistRelay] Could not store failed update version: {e}");
    }
    let manual_version = match (&notice, &data) {
      (Some(StartupOutcome::Manual { version }), _) => Some(version.clone()),
      (_, Some(data)) => known_failed_version(data),
      _ => None,
    };
    tokio::time::sleep(FIRST_CHECK_DELAY).await;
    if let Some(StartupOutcome::Retry { version, attempts, .. }) = &notice {
      log::info!("[EgoistRelay] Previous update to {version} did not complete; it will be offered again");
      let message = format!(
        "Обновление до версии {version} не удалось (попытка {attempts} из {MAX_ATTEMPTS}). Его можно повторить."
      );
      let payload = FailedPayload { version: version.clone(), attempts: *attempts, message };
      let _ = handle.emit_to(MAIN_LABEL, "update-failed", payload);
    }
    if let Some(version) = manual_version {
      let message = manual_message(&version);
      let _ = handle.emit_to(MAIN_LABEL, "update-manual", ManualPayload { version, message });
    }
    loop {
      background_check(&handle).await;
      tokio::time::sleep(CHECK_INTERVAL).await;
    }
  });
}

/// Сохранённая отказавшая версия, если она всё ещё новее установленной (иначе запись снимается).
fn known_failed_version(data: &Path) -> Option<String> {
  let stored = settings::read_failed_version(data)?;
  let newer = semver::Version::parse(&stored).is_ok_and(|v| v > current_version());
  if newer {
    Some(stored)
  } else {
    let _ = settings::write_failed_version(data, None);
    None
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn install_waits_for_background_operation() {
    // Тест единственный, кто трогает OP. Второй захват ждёт первого, а не получает отказ.
    let rt = tokio::runtime::Builder::new_current_thread().enable_time().build().unwrap();
    rt.block_on(async {
      let first = OP.lock().await;
      assert!(OP.try_lock().is_err());
      let waiter = tokio::spawn(async { drop(OP.lock().await) });
      tokio::task::yield_now().await;
      assert!(!waiter.is_finished());
      drop(first);
      waiter.await.unwrap();
      assert!(OP.try_lock().is_ok());
    });
  }

  #[test]
  fn failed_version_is_not_offered_automatically() {
    use crate::update::manifest::Manifest;
    let t = tempfile::tempdir().unwrap();
    let data = vec![1u8; 10];
    let text = crate::update::testkit::manifest_json("1.2.3", &data);
    let manifest = Manifest::parse(text.as_bytes()).unwrap();
    let offer = Offer {
      version: semver::Version::parse("1.2.3").unwrap(),
      installer: crate::update::source::AssetRef { id: 13, name: manifest.installer.name.clone() },
      manifest,
    };
    let check = Check::Available(offer);
    assert!(auto_offer(&check, t.path()).is_some());
    settings::write_failed_version(t.path(), Some("1.2.3")).unwrap();
    assert!(auto_offer(&check, t.path()).is_none());
    assert!(!result_for_ui(&check, t.path()).available);
    // Другая (более новая) версия снова предлагается.
    settings::write_failed_version(t.path(), Some("1.2.2")).unwrap();
    assert!(auto_offer(&check, t.path()).is_some());
  }

  #[test]
  fn known_failed_version_clears_when_installed() {
    let t = tempfile::tempdir().unwrap();
    settings::write_failed_version(t.path(), Some("999.0.0")).unwrap();
    assert_eq!(known_failed_version(t.path()).as_deref(), Some("999.0.0"));
    settings::write_failed_version(t.path(), Some("0.0.1")).unwrap();
    assert_eq!(known_failed_version(t.path()), None);
    assert_eq!(settings::read_failed_version(t.path()), None);
  }

  #[test]
  fn check_result_json_shape() {
    let none = serde_json::to_value(CheckResult::from_check(&Check::UpToDate)).unwrap();
    assert_eq!(none, serde_json::json!({ "available": false }));
  }
}
