//! Ошибки обновления. Тексты — для пользователя, по-русски; ни токена, ни URL в них нет.
//! `Debug` выводится автоматически и безопасен: токен ни в один вариант не попадает.

use super::sign::SignError;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UpdateError {
  /// В сборку не вшит токен: обновления недоступны.
  Unavailable,
  Busy,
  Network(String),
  Timeout,
  TooLarge,
  Unauthorized,
  Forbidden,
  NotFound,
  RateLimited,
  HttpStatus(u16),
  BadResponse(String),
  MissingAsset(String),
  InsecureRedirect(String),
  TooManyRedirects,
  Signature(SignError),
  Manifest(String),
  Downgrade { current: String, offered: String },
  NeedsManualUpdate { min_version: String },
  SizeMismatch,
  HashMismatch,
  NoSpace { need: u64, have: u64 },
  Io(String),
  Launch(String),
}

pub type UpdateResult<T> = Result<T, UpdateError>;

impl std::fmt::Display for UpdateError {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    use UpdateError::*;
    match self {
      Unavailable => f.write_str("Обновления недоступны в этой сборке."),
      Busy => f.write_str("Обновление уже выполняется."),
      Network(m) => write!(f, "Нет связи с сервером обновлений: {m}"),
      Timeout => f.write_str("Сервер обновлений не ответил вовремя."),
      TooLarge => f.write_str("Сервер вернул слишком большой ответ."),
      Unauthorized => f.write_str("Сервер обновлений отклонил доступ. Обновите приложение вручную."),
      Forbidden => f.write_str("Доступ к обновлениям запрещён."),
      NotFound => f.write_str("Релиз обновления не найден."),
      RateLimited => f.write_str("Сервер обновлений временно ограничил запросы. Повторите позже."),
      HttpStatus(s) => write!(f, "Сервер обновлений ответил кодом {s}."),
      BadResponse(m) => write!(f, "Некорректный ответ сервера обновлений: {m}"),
      MissingAsset(n) => write!(f, "В релизе нет файла {n}."),
      InsecureRedirect(m) => write!(f, "Небезопасное перенаправление отклонено: {m}."),
      TooManyRedirects => f.write_str("Слишком много перенаправлений."),
      Signature(e) => write!(f, "Подпись обновления не прошла проверку: {e}."),
      Manifest(m) => write!(f, "Описание обновления некорректно: {m}."),
      Downgrade { current, offered } => write!(
        f,
        "Предложена более старая версия {offered} (установлена {current}); обновление отклонено."
      ),
      NeedsManualUpdate { min_version } => write!(
        f,
        "Для этого обновления нужна версия не ниже {min_version}. Скачайте установщик вручную."
      ),
      SizeMismatch => f.write_str("Размер скачанного файла не совпал с заявленным."),
      HashMismatch => f.write_str("Контрольная сумма скачанного файла не совпала."),
      NoSpace { need, have } => write!(
        f,
        "Не хватает места на диске: нужно около {} МБ, свободно {} МБ.",
        need / (1024 * 1024),
        have / (1024 * 1024)
      ),
      Io(m) => write!(f, "Ошибка работы с файлами: {m}"),
      Launch(m) => write!(f, "Не удалось запустить установщик: {m}"),
    }
  }
}

impl std::error::Error for UpdateError {}

impl From<SignError> for UpdateError {
  fn from(e: SignError) -> Self {
    UpdateError::Signature(e)
  }
}
