//! Подпись манифеста ed25519. Подписываются ТОЧНЫЕ БАЙТЫ `manifest.json` с доменным префиксом,
//! чтобы подпись манифеста нельзя было использовать как подпись чего-то другого.
//!
//! Формат `manifest.json.sig`: одна строка `beresta-sig-v1 <key_id> <base64 64 байта>`.

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use ed25519_dalek::{Signature, VerifyingKey};
use sha2::{Digest, Sha256};

pub const SIG_MAGIC: &str = "beresta-sig-v1";
/// Доменный префикс, добавляется перед байтами манифеста.
pub const SIG_DOMAIN: &[u8] = b"beresta-sig-v1\n";
/// Предел размера файла подписи.
pub const SIG_MAX_BYTES: usize = 4 * 1024;

/// Открытый ключ с идентификатором (для ротации).
pub type PubKey<'a> = (&'a str, [u8; 32]);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SignError {
  Malformed(String),
  UnknownKey(String),
  BadSignature,
  BadKey,
}

impl std::fmt::Display for SignError {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    match self {
      SignError::Malformed(m) => write!(f, "файл подписи повреждён ({m})"),
      SignError::UnknownKey(id) => write!(f, "неизвестный ключ подписи {id}"),
      SignError::BadSignature => f.write_str("подпись не совпала"),
      SignError::BadKey => f.write_str("открытый ключ недействителен"),
    }
  }
}

pub fn sha256_hex(data: &[u8]) -> String {
  hex(&Sha256::digest(data))
}

pub fn hex(bytes: &[u8]) -> String {
  const H: &[u8; 16] = b"0123456789abcdef";
  let mut s = String::with_capacity(bytes.len() * 2);
  for b in bytes {
    s.push(H[(b >> 4) as usize] as char);
    s.push(H[(b & 15) as usize] as char);
  }
  s
}

/// Сообщение, которое реально подписывается.
pub fn signed_message(manifest: &[u8]) -> Vec<u8> {
  let mut m = Vec::with_capacity(SIG_DOMAIN.len() + manifest.len());
  m.extend_from_slice(SIG_DOMAIN);
  m.extend_from_slice(manifest);
  m
}

/// Идентификатор ключа: первые 8 hex-символов SHA-256 открытого ключа.
pub fn key_id_for(pubkey: &[u8; 32]) -> String {
  sha256_hex(pubkey)[..8].to_string()
}

struct ParsedSig {
  key_id: String,
  sig: [u8; 64],
}

fn parse_sig(text: &str) -> Result<ParsedSig, SignError> {
  let t = text.trim();
  if t.is_empty() || t.len() > SIG_MAX_BYTES || t.contains('\n') || t.contains('\r') {
    return Err(SignError::Malformed("ожидалась одна строка".into()));
  }
  let parts: Vec<&str> = t.split(' ').collect();
  let [magic, id, b64] = parts.as_slice() else {
    return Err(SignError::Malformed("неизвестный формат".into()));
  };
  if *magic != SIG_MAGIC {
    return Err(SignError::Malformed("неизвестный формат".into()));
  }
  if id.is_empty() || id.len() > 32 || !id.bytes().all(|c| c.is_ascii_alphanumeric()) {
    return Err(SignError::Malformed("key_id".into()));
  }
  let raw = B64.decode(b64).map_err(|_| SignError::Malformed("base64".into()))?;
  let sig: [u8; 64] = raw
    .try_into()
    .map_err(|_| SignError::Malformed("длина подписи не 64 байта".into()))?;
  Ok(ParsedSig { key_id: (*id).to_string(), sig })
}

/// Ключ допустим для проверки: не нулевая заглушка и не точка малого порядка.
fn usable_key(pk: &[u8; 32]) -> Result<VerifyingKey, SignError> {
  if pk.iter().all(|b| *b == 0) {
    return Err(SignError::BadKey);
  }
  let vk = VerifyingKey::from_bytes(pk).map_err(|_| SignError::BadKey)?;
  if vk.is_weak() {
    return Err(SignError::BadKey);
  }
  Ok(vk)
}

/// Проверить подпись `manifest` по списку допустимых ключей (`verify_strict`).
/// Возвращает `key_id` ключа, которым подпись проверена.
pub fn verify_manifest(manifest: &[u8], sig_text: &str, keys: &[PubKey<'_>]) -> Result<String, SignError> {
  let parsed = parse_sig(sig_text)?;
  let sig = Signature::from_bytes(&parsed.sig);
  let (_, pk) = keys
    .iter()
    .find(|(kid, _)| *kid == parsed.key_id)
    .ok_or_else(|| SignError::UnknownKey(parsed.key_id.clone()))?;
  let vk = usable_key(pk)?;
  vk.verify_strict(&signed_message(manifest), &sig)
    .map_err(|_| SignError::BadSignature)?;
  Ok(parsed.key_id)
}

#[cfg(test)]
pub mod signing {
  //! Подпись нужна только тестам: приложение ничего не подписывает.
  use super::*;
  use ed25519_dalek::{Signer, SigningKey};

  pub fn public_key_of(secret: &[u8; 32]) -> [u8; 32] {
    SigningKey::from_bytes(secret).verifying_key().to_bytes()
  }

  pub fn sign_manifest(secret: &[u8; 32], key_id: &str, manifest: &[u8]) -> String {
    let sig = SigningKey::from_bytes(secret).sign(&signed_message(manifest));
    format!("{SIG_MAGIC} {key_id} {}\n", B64.encode(sig.to_bytes()))
  }

  pub fn sign_raw(secret: &[u8; 32], msg: &[u8]) -> [u8; 64] {
    SigningKey::from_bytes(secret).sign(msg).to_bytes()
  }
}

#[cfg(test)]
mod tests {
  use super::signing::*;
  use super::*;
  use crate::update::testkit::{SEED_A, SEED_B, pub_a};

  const MANIFEST: &[u8] = br#"{"v":1}"#;

  #[test]
  fn sign_and_verify() {
    let sig = sign_manifest(&SEED_A, "k1", MANIFEST);
    assert!(sig.starts_with("beresta-sig-v1 k1 "));
    assert_eq!(verify_manifest(MANIFEST, &sig, &[("k1", pub_a())]).unwrap(), "k1");
  }

  #[test]
  fn changed_byte_fails() {
    let sig = sign_manifest(&SEED_A, "k1", MANIFEST);
    let mut m = MANIFEST.to_vec();
    m[3] ^= 1;
    assert_eq!(verify_manifest(&m, &sig, &[("k1", pub_a())]), Err(SignError::BadSignature));
    let mut m2 = MANIFEST.to_vec();
    m2.push(b'\n');
    assert_eq!(verify_manifest(&m2, &sig, &[("k1", pub_a())]), Err(SignError::BadSignature));
  }

  #[test]
  fn foreign_key_rejected() {
    let sig = sign_manifest(&SEED_B, "k1", MANIFEST);
    assert_eq!(verify_manifest(MANIFEST, &sig, &[("k1", pub_a())]), Err(SignError::BadSignature));
  }

  #[test]
  fn unknown_key_id() {
    let sig = sign_manifest(&SEED_A, "zz", MANIFEST);
    assert_eq!(
      verify_manifest(MANIFEST, &sig, &[("k1", pub_a())]),
      Err(SignError::UnknownKey("zz".into()))
    );
  }

  #[test]
  fn domain_separation() {
    let raw = sign_raw(&SEED_A, MANIFEST);
    let text = format!("{SIG_MAGIC} k1 {}", B64.encode(raw));
    assert_eq!(verify_manifest(MANIFEST, &text, &[("k1", pub_a())]), Err(SignError::BadSignature));
  }

  #[test]
  fn bare_base64_is_not_accepted() {
    let full = sign_manifest(&SEED_A, "k1", MANIFEST);
    let bare = full.split(' ').nth(2).unwrap().trim().to_string();
    assert!(matches!(
      verify_manifest(MANIFEST, &bare, &[("k1", pub_a())]),
      Err(SignError::Malformed(_))
    ));
  }

  #[test]
  fn malformed_variants() {
    let keys = [("k1", pub_a())];
    for bad in [
      "",
      "garbage with spaces here",
      "beresta-sig-v1 k1",
      "beresta-sig-v1 k1 !!!notbase64",
      "beresta-sig-v1 k1 AAAA",
      "other-magic k1 AAAA",
      "egoist-gate-sig-v1 k1 AAAA",
      "a\nb",
    ] {
      assert!(
        matches!(verify_manifest(MANIFEST, bad, &keys), Err(SignError::Malformed(_))),
        "{bad:?}"
      );
    }
  }

  #[test]
  fn key_id_is_stable() {
    assert_eq!(key_id_for(&pub_a()).len(), 8);
    assert_ne!(key_id_for(&pub_a()), key_id_for(&public_key_of(&SEED_B)));
  }

  #[test]
  fn zero_key_never_verifies() {
    // Классическая подделка для ключа малого порядка: R = единица, S = 0.
    let mut forged = [0u8; 64];
    forged[0] = 1;
    let text = format!("{SIG_MAGIC} k0 {}", B64.encode(forged));
    assert_eq!(verify_manifest(MANIFEST, &text, &[("k0", [0u8; 32])]), Err(SignError::BadKey));
    // Настоящая подпись чужим ключом тоже не проходит.
    let sig = sign_manifest(&SEED_A, "k0", MANIFEST);
    assert_eq!(verify_manifest(MANIFEST, &sig, &[("k0", [0u8; 32])]), Err(SignError::BadKey));
  }
}
