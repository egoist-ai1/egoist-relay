//! Общие тестовые данные: ключи (создаются из фиксированных тестовых сидов) и сборка манифестов.
use super::sign::signing::{public_key_of, sign_manifest};

pub const SEED_A: [u8; 32] = [7; 32];
pub const SEED_B: [u8; 32] = [9; 32];

pub fn pub_a() -> [u8; 32] {
  public_key_of(&SEED_A)
}

pub fn sha_hex_of(data: &[u8]) -> String {
  super::sign::sha256_hex(data)
}

pub fn installer_name(version: &str) -> String {
  super::manifest::installer_file_name(version)
}

/// Текст манифеста для установщика `data`.
pub fn manifest_json(version: &str, data: &[u8]) -> String {
  format!(
    r#"{{"v":1,"product":"Beresta","arch":"x64","version":"{version}","published":"2026-10-25T10:00:00Z","installer":{{"name":"{}","size":{},"sha256":"{}"}},"notes":"Исправления"}}"#,
    installer_name(version),
    data.len(),
    sha_hex_of(data)
  )
}

pub fn sign_a(manifest: &[u8]) -> String {
  sign_manifest(&SEED_A, "k1", manifest)
}
