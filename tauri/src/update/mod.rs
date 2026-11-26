//! Собственное автообновление Берёсты (вариант B): подписанный манифест ed25519, источник — приватный
//! релизный репозиторий GitHub, установка — запуск проверенного установщика с `--silent`.
//!
//! Плагин `tauri-plugin-updater` не используется. Сеть изолирована трейтом `HttpClient` (в тестах фейк),
//! системные вызовы — только в `stage` (свободное место, запуск) и `commands`.

pub mod commands;
pub mod error;
pub mod flow;
pub mod manifest;
pub mod pubkeys;
pub mod sign;
pub mod settings;
pub mod source;
pub mod stage;
#[cfg(test)]
pub mod testkit;
pub mod token;

pub use error::UpdateError;

/// Обновления включены: в сборку вшит токен чтения релизов и это не отладочная сборка.
pub fn updater_enabled() -> bool {
  !token::Token::embedded().is_empty() && !cfg!(debug_assertions)
}

/// Версия работающего приложения.
pub fn current_version() -> semver::Version {
  semver::Version::parse(env!("CARGO_PKG_VERSION")).expect("CARGO_PKG_VERSION is semver")
}
