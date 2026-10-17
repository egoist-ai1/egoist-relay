//! Связка туннеля с оболочкой: запуск до окон, команды `relay_network_*` и событие `relay-network-status`.
//!
//! Значения ключей, адреса подписки и DoH во фронтенд не передаются: наружу идёт только `NetworkStatus`.

use crate::tunnel::{self, ApplyRequest, NetworkError, NetworkStatus};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager};

const STATUS_EVENT: &str = "relay-network-status";

/// Каталог с `xray.exe`: ресурсы приложения, затем соседние каталоги, в отладочной сборке — `runtime/` проекта.
fn runtime_dir(app: &AppHandle) -> PathBuf {
  let mut candidates = Vec::new();
  if let Ok(directory) = app.path().resource_dir() {
    candidates.push(directory.join("runtime"));
  }
  if let Ok(executable) = std::env::current_exe() && let Some(directory) = executable.parent() {
    candidates.push(directory.join("runtime"));
    candidates.push(directory.join("resources").join("runtime"));
  }
  #[cfg(debug_assertions)]
  candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../runtime"));
  let fallback = candidates.first().cloned().unwrap_or_else(|| PathBuf::from("runtime"));
  candidates.into_iter().find(|directory| directory.join("xray.exe").is_file()).unwrap_or(fallback)
}

/// Запускает туннель до создания окон и подписывает событие статуса. Не падает: если Xray не поднялся,
/// окна всё равно создаются с прокси на закрытый порт (kill switch), статус показывает причину.
pub(crate) fn start(app: &AppHandle) {
  let data_dir = match crate::multi_app::get_service_data_directory(app, "") {
    Ok(path) => path,
    Err(error) => {
      log::error!("[Tunnel] каталог данных недоступен: {error}");
      return;
    }
  };
  let started = std::time::Instant::now();
  match tunnel::start(&data_dir, &runtime_dir(app)) {
    Ok(_) => log::info!("[Tunnel] запущен за {} мс", started.elapsed().as_millis()),
    Err(error) => log::error!("[Tunnel] не запущен: {error}"),
  }
  let emitter = app.clone();
  tunnel::subscribe(move |status| {
    let _ = emitter.emit_to("main", STATUS_EVENT, with_telegram_route(status.clone()));
  });
}

fn with_telegram_route(mut status: NetworkStatus) -> NetworkStatus {
  let route = if crate::telegram_transport::is_ready() { tunnel::ServiceRoute::LocalProxy }
    else { tunnel::ServiceRoute::Unavailable };
  status.services.insert("telegram".to_string(), route);
  status
}

pub(crate) fn emit_status(app: &AppHandle) {
  let _ = app.emit_to("main", STATUS_EVENT, with_telegram_route(tunnel::status()));
}

/// Команды сети принимает только главное окно (локальный интерфейс): запасная проверка к `capabilities/network.json`.
fn ensure_main(webview: &tauri::Webview) -> Result<(), NetworkError> {
  if webview.label() == "main" { Ok(()) } else { Err(NetworkError::ApplyFailed) }
}

async fn blocking<T: Send + 'static>(
  operation: impl FnOnce() -> Result<T, NetworkError> + Send + 'static,
) -> Result<T, NetworkError> {
  tauri::async_runtime::spawn_blocking(operation).await.map_err(|_| NetworkError::ApplyFailed)?
}

#[tauri::command]
pub(crate) async fn relay_network_status(webview: tauri::Webview) -> Result<NetworkStatus, NetworkError> {
  ensure_main(&webview)?;
  Ok(with_telegram_route(tunnel::status()))
}

#[tauri::command]
pub(crate) async fn relay_network_apply(
  _app: AppHandle,
  webview: tauri::Webview,
  vpn: Option<String>,
  doh: Option<String>,
  mtproxy: Option<String>,
) -> Result<NetworkStatus, NetworkError> {
  ensure_main(&webview)?;
  blocking(move || {
    let status = tunnel::apply(ApplyRequest { vpn, doh, mtproxy })?;
    Ok(with_telegram_route(status))
  }).await
}

#[tauri::command]
pub(crate) async fn relay_network_reset(_app: AppHandle, webview: tauri::Webview) -> Result<NetworkStatus, NetworkError> {
  ensure_main(&webview)?;
  blocking(move || {
    let status = tunnel::reset()?;
    Ok(with_telegram_route(status))
  }).await
}

#[tauri::command]
pub(crate) async fn relay_network_refresh_subscription(webview: tauri::Webview) -> Result<NetworkStatus, NetworkError> {
  ensure_main(&webview)?;
  blocking(|| tunnel::refresh_subscription().map(with_telegram_route)).await
}

#[tauri::command]
pub(crate) async fn relay_network_set_service_enabled(
  app: AppHandle,
  webview: tauri::Webview,
  service: String,
  enabled: bool,
) -> Result<NetworkStatus, NetworkError> {
  ensure_main(&webview)?;
  blocking(move || {
    let status = tunnel::set_service_enabled(&service, enabled)?;
    if !enabled {
      // Выключенный сервис не держит WebView и соединения
      crate::multi_app::close_service_webview(&app, &service);
    }
    Ok(with_telegram_route(status))
  }).await
}

#[cfg(test)]
mod tests {
  use std::path::{Path, PathBuf};

  fn rust_sources(directory: &Path, found: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(directory).unwrap().flatten() {
      let path = entry.path();
      if path.is_dir() {
        rust_sources(&path, found);
      } else if path.extension().is_some_and(|extension| extension == "rs") {
        found.push(path);
      }
    }
  }

  /// Инвариант утечек: каждое место, где создаётся WebView2, получает аргументы туннеля, а системного
  /// прокси и правил обхода DNS в оболочке нет.
  #[test]
  fn every_webview_is_created_with_tunnel_arguments() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    assert!(!root.join("system_proxy.rs").exists(), "system_proxy.rs должен быть удалён");
    let mut files = Vec::new();
    rust_sources(&root, &mut files);
    let mut creators = Vec::new();
    for file in files {
      let name = file.strip_prefix(&root).unwrap().to_string_lossy().replace('\\', "/");
      if name.starts_with("tunnel/") || name == "network.rs" { continue; }
      let text = std::fs::read_to_string(&file).unwrap();
      assert!(!text.contains("system_proxy") && !text.contains("proxy_for_url"), "{name}: системный прокси");
      assert!(!text.contains("host-resolver-rules"), "{name}: обход DNS мимо туннеля");
      let creates = text.contains("WebviewBuilder::new(")
        || text.contains("WebviewWindowBuilder::new(")
        || text.contains("WebviewWindowBuilder::from_config(");
      if creates {
        let covered = text.contains("service_browser_arguments(") || text.contains("apply_service_network_profile(")
          || text.contains("tunnel::browser_args(");
        assert!(covered, "{name}: WebView создаётся без аргументов туннеля");
        creators.push(name);
      }
    }
    creators.sort();
    // Новый файл с созданием WebView — осознанное решение: сначала подключить аргументы, потом дополнить список
    assert_eq!(creators, ["bot_web_apps.rs", "lib.rs", "multi_app.rs", "research_social.rs"]);
  }

  #[test]
  fn service_arguments_keep_defaults_and_route_through_the_tunnel() {
    #[cfg(windows)]
    for service in ["telegram", "x", "instagram", "mini-apps"] {
      let arguments = crate::multi_app::service_browser_arguments(service);
      assert!(arguments.starts_with("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection"));
      assert!(arguments.contains("--proxy-server=socks5://127.0.0.1:"));
      assert!(arguments.contains("--disable-quic"));
    }
  }
}
