//! Список допустимых открытых ключей (ротация): `(key_id, ключ)`. Первый — действующий.
//! Новый ключ добавляют в начало, старый убирают через один релиз после перехода.
//!
//! Ключ создан `beresta-sign keygen` 25.10.2026. Приватная часть лежит вне репозитория:
//! `%LOCALAPPDATA%\Egoist\sign\beresta-update.key`. Открытый ключ коммитить можно.

use super::sign::PubKey;

/// `key_id` действующего ключа в `manifest.json.sig`.
pub const CURRENT_KEY_ID: &str = "e7f27d0b";

/// Открытый ключ ed25519 (32 байта).
pub const UPDATE_PUBKEY: [u8; 32] = [
  239, 194, 65, 207, 214, 61, 219, 225, 192, 125, 59, 66, 205, 126, 229, 189, 69, 178, 144, 103, 78,
  17, 113, 17, 229, 192, 132, 177, 63, 249, 106, 10,
];

/// Ключи, которым приложение доверяет.
pub fn trusted_keys() -> Vec<PubKey<'static>> {
  vec![(CURRENT_KEY_ID, UPDATE_PUBKEY)]
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::update::sign::signing::sign_manifest;
  use crate::update::sign::{key_id_for, verify_manifest};
  use crate::update::testkit::SEED_A;

  /// `key_id` равен хешу самого ключа, а ключ — настоящая точка кривой.
  #[test]
  fn id_matches_key() {
    assert_eq!(CURRENT_KEY_ID, key_id_for(&UPDATE_PUBKEY));
    assert!(ed25519_dalek::VerifyingKey::from_bytes(&UPDATE_PUBKEY).is_ok());
  }

  /// Тестовый секрет не совпадает с вшитым ключом: его подпись не проходит.
  #[test]
  fn test_seed_is_not_trusted() {
    let sig = sign_manifest(&SEED_A, CURRENT_KEY_ID, b"x");
    assert!(verify_manifest(b"x", &sig, &trusted_keys()).is_err());
  }

  #[test]
  fn zero_key_is_never_trusted() {
    let zero: [u8; 32] = [0; 32];
    assert!(trusted_keys().iter().all(|(_, key)| *key != zero));
  }
}
