//! Настройки обновлений — простой json в app-data рядом с профилем (не в `updates/`, который чистится).
//!
//! Режим (`auto|ask|off`):
//! * `ask` (по умолчанию): приложение только проверяет и сообщает; скачивание и установка — по вызову `update_install`.
//! * `auto`: найденное обновление заранее скачивается и проверяется; запуск установщика всё равно по `update_install`,
//!   чтобы приложение не закрывалось само посреди работы.
//! * `off`: автоматических проверок нет; ручной `update_check` работает.
//!
//! `failed_version` — версия, автоматическая установка которой не удалась `MAX_ATTEMPTS` раз. Её не предлагают
//! автоматически, пока не выйдет другая версия (каталог стадии при этом чистится, счётчик там не живёт).

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UpdateMode {
  Auto,
  #[default]
  Ask,
  Off,
}

#[derive(Serialize, Deserialize, Default)]
struct SettingsFile {
  #[serde(default)]
  mode: UpdateMode,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  failed_version: Option<String>,
}

pub fn settings_path(app_data: &Path) -> PathBuf {
  app_data.join("update-settings.json")
}

/// Нет файла или он повреждён — значения по умолчанию.
fn read_file(app_data: &Path) -> SettingsFile {
  std::fs::read(settings_path(app_data))
    .ok()
    .filter(|b| b.len() <= 4096)
    .and_then(|b| serde_json::from_slice::<SettingsFile>(&b).ok())
    .unwrap_or_default()
}

fn write_file(app_data: &Path, file: &SettingsFile) -> Result<(), String> {
  std::fs::create_dir_all(app_data).map_err(|e| e.to_string())?;
  let text = serde_json::to_vec(file).map_err(|e| e.to_string())?;
  let tmp = app_data.join("update-settings.json.tmp");
  std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
  std::fs::rename(&tmp, settings_path(app_data)).map_err(|e| e.to_string())
}

pub fn read_mode(app_data: &Path) -> UpdateMode {
  read_file(app_data).mode
}

pub fn write_mode(app_data: &Path, mode: UpdateMode) -> Result<(), String> {
  let mut file = read_file(app_data);
  file.mode = mode;
  write_file(app_data, &file)
}

/// Версия, которую не предлагаем автоматически.
pub fn read_failed_version(app_data: &Path) -> Option<String> {
  read_file(app_data).failed_version
}

pub fn write_failed_version(app_data: &Path, version: Option<&str>) -> Result<(), String> {
  let mut file = read_file(app_data);
  file.failed_version = version.map(str::to_string);
  write_file(app_data, &file)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn default_is_ask_and_roundtrip() {
    let t = tempfile::tempdir().unwrap();
    assert_eq!(read_mode(t.path()), UpdateMode::Ask);
    write_mode(t.path(), UpdateMode::Off).unwrap();
    assert_eq!(read_mode(t.path()), UpdateMode::Off);
    std::fs::write(settings_path(t.path()), b"{\"mode\":\"weird\"}").unwrap();
    assert_eq!(read_mode(t.path()), UpdateMode::Ask);
  }

  #[test]
  fn failed_version_survives_mode_changes() {
    let t = tempfile::tempdir().unwrap();
    assert_eq!(read_failed_version(t.path()), None);
    write_failed_version(t.path(), Some("1.2.0")).unwrap();
    write_mode(t.path(), UpdateMode::Auto).unwrap();
    assert_eq!(read_failed_version(t.path()).as_deref(), Some("1.2.0"));
    assert_eq!(read_mode(t.path()), UpdateMode::Auto);
    write_failed_version(t.path(), None).unwrap();
    assert_eq!(read_failed_version(t.path()), None);
    assert_eq!(read_mode(t.path()), UpdateMode::Auto);
  }
}
