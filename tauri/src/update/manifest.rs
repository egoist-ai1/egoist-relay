//! Манифест обновления `manifest.json`. Разбирается только ПОСЛЕ проверки подписи по тем же байтам.

use semver::Version;
use serde::Deserialize;

use super::error::{UpdateError, UpdateResult};

pub const MANIFEST_MAX_BYTES: usize = 64 * 1024;
pub const MIN_INSTALLER_BYTES: u64 = 100 * 1024 * 1024;
pub const MAX_INSTALLER_BYTES: u64 = 1024 * 1024 * 1024;

/// Допустимый размер установщика (в тестах потока данных границы уменьшают).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SizeBounds {
  pub min: u64,
  pub max: u64,
}

impl SizeBounds {
  pub const PRODUCTION: SizeBounds = SizeBounds { min: MIN_INSTALLER_BYTES, max: MAX_INSTALLER_BYTES };
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InstallerInfo {
  pub name: String,
  pub size: u64,
  pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
  pub v: u32,
  pub product: String,
  pub arch: String,
  pub version: String,
  pub published: String,
  pub installer: InstallerInfo,
  #[serde(default)]
  pub notes: String,
  #[serde(default)]
  pub min_version: Option<String>,
}

pub fn installer_file_name(version: &str) -> String {
  format!("Beresta-Setup-{version}.exe")
}

fn bad(m: &str) -> UpdateError {
  UpdateError::Manifest(m.to_string())
}

impl Manifest {
  /// Разобрать байты манифеста (подпись уже проверена вызывающим).
  pub fn parse(bytes: &[u8]) -> UpdateResult<Manifest> {
    if bytes.len() > MANIFEST_MAX_BYTES {
      return Err(UpdateError::TooLarge);
    }
    serde_json::from_slice(bytes).map_err(|e| UpdateError::Manifest(format!("JSON: {e}")))
  }

  /// Структурные проверки; возвращает версию. Сравнение с установленной версией — отдельно (`decide`).
  pub fn validate(&self, bounds: SizeBounds) -> UpdateResult<Version> {
    if self.v != 1 {
      return Err(bad("неизвестная версия формата"));
    }
    if self.product != "Beresta" {
      return Err(bad("чужой продукт"));
    }
    if self.arch != "x64" {
      return Err(bad("чужая архитектура"));
    }
    let version = Version::parse(&self.version).map_err(|_| bad("версия не semver"))?;
    if self.published.is_empty() || self.published.len() > 64 || !self.published.is_ascii() {
      return Err(bad("дата публикации"));
    }
    // Подписанные манифесты прежних выпусков содержат старое точное имя.
    if self.installer.name != installer_file_name(&self.version)
      && self.installer.name != format!("Egoist-Social-Setup-{}.exe", self.version)
    {
      return Err(bad("имя установщика не соответствует версии"));
    }
    if self.installer.size < bounds.min || self.installer.size > bounds.max {
      return Err(bad("размер установщика вне допустимых пределов"));
    }
    let sha = &self.installer.sha256;
    if sha.len() != 64 || !sha.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
      return Err(bad("sha256 установщика"));
    }
    if let Some(min) = &self.min_version {
      Version::parse(min).map_err(|_| bad("min_version не semver"))?;
    }
    Ok(version)
  }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
  UpToDate,
  Newer,
}

/// Антиоткат: строго новее — обновляем; равно — «актуально»; меньше — ошибка.
pub fn decide(manifest: &Manifest, offered: &Version, current: &Version) -> UpdateResult<Decision> {
  if offered < current {
    return Err(UpdateError::Downgrade { current: current.to_string(), offered: offered.to_string() });
  }
  if offered == current {
    return Ok(Decision::UpToDate);
  }
  if let Some(min) = &manifest.min_version {
    if let Ok(min) = Version::parse(min) {
      if current < &min {
        return Err(UpdateError::NeedsManualUpdate { min_version: min.to_string() });
      }
    }
  }
  Ok(Decision::Newer)
}

#[cfg(test)]
mod tests {
  use super::*;

  const SMALL: SizeBounds = SizeBounds { min: 10, max: 1000 };

  fn json(version: &str, size: u64, sha: &str, name: &str) -> String {
    format!(
      r#"{{"v":1,"product":"Beresta","arch":"x64","version":"{version}","published":"2026-10-25","installer":{{"name":"{name}","size":{size},"sha256":"{sha}"}},"notes":"n"}}"#
    )
  }
  fn sha() -> String {
    "ab".repeat(32)
  }
  fn ok_manifest() -> Manifest {
    Manifest::parse(json("1.2.3", 500, &sha(), "Beresta-Setup-1.2.3.exe").as_bytes()).unwrap()
  }

  #[test]
  fn valid_manifest() {
    let m = ok_manifest();
    assert_eq!(m.validate(SMALL).unwrap(), Version::new(1, 2, 3));
  }

  #[test]
  fn legacy_manifest_name_requires_exact_version() {
    let legacy = Manifest::parse(json("1.2.3", 500, &sha(), "Egoist-Social-Setup-1.2.3.exe").as_bytes()).unwrap();
    assert_eq!(legacy.validate(SMALL).unwrap(), Version::new(1, 2, 3));
    for invalid in [
      "Egoist-Social-Setup-1.2.2.exe",
      "Beresta-Setup-1.2.2.exe",
      "../Beresta-Setup-1.2.3.exe",
      "../Egoist-Social-Setup-1.2.3.exe",
    ] {
      let manifest = Manifest::parse(json("1.2.3", 500, &sha(), invalid).as_bytes()).unwrap();
      assert!(manifest.validate(SMALL).is_err(), "{invalid}");
    }
  }

  #[test]
  fn name_without_version_rejected() {
    let m = Manifest::parse(json("1.2.3", 500, &sha(), "Beresta-Setup.exe").as_bytes()).unwrap();
    assert!(m.validate(SMALL).is_err());
    let m = Manifest::parse(json("1.2.3", 500, &sha(), "../Beresta-Setup-1.2.3.exe").as_bytes()).unwrap();
    assert!(m.validate(SMALL).is_err());
  }

  #[test]
  fn size_bounds() {
    for size in [9, 1001] {
      let m = Manifest::parse(json("1.2.3", size, &sha(), "Beresta-Setup-1.2.3.exe").as_bytes()).unwrap();
      assert!(m.validate(SMALL).is_err(), "{size}");
    }
    let m = Manifest::parse(json("1.2.3", 50 * 1024 * 1024, &sha(), "Beresta-Setup-1.2.3.exe").as_bytes()).unwrap();
    assert!(m.validate(SizeBounds::PRODUCTION).is_err());
    let m = Manifest::parse(json("1.2.3", 200 * 1024 * 1024, &sha(), "Beresta-Setup-1.2.3.exe").as_bytes()).unwrap();
    assert!(m.validate(SizeBounds::PRODUCTION).is_ok());
  }

  #[test]
  fn bad_sha_and_fields() {
    for s in ["", "xyz", &"A".repeat(64), &"a".repeat(63)] {
      let m = Manifest::parse(json("1.2.3", 500, s, "Beresta-Setup-1.2.3.exe").as_bytes()).unwrap();
      assert!(m.validate(SMALL).is_err(), "{s}");
    }
    let mut m = ok_manifest();
    m.product = "Other".into();
    assert!(m.validate(SMALL).is_err());
    let mut m = ok_manifest();
    m.arch = "arm64".into();
    assert!(m.validate(SMALL).is_err());
    let mut m = ok_manifest();
    m.v = 2;
    assert!(m.validate(SMALL).is_err());
  }

  #[test]
  fn unknown_fields_rejected() {
    let text = json("1.2.3", 500, &sha(), "Beresta-Setup-1.2.3.exe").replace("\"notes\"", "\"extra\":1,\"notes\"");
    assert!(Manifest::parse(text.as_bytes()).is_err());
  }

  #[test]
  fn oversized_rejected() {
    let big = vec![b' '; MANIFEST_MAX_BYTES + 1];
    assert_eq!(Manifest::parse(&big), Err(UpdateError::TooLarge));
  }

  #[test]
  fn antirollback() {
    let m = ok_manifest();
    let cur = |s: &str| Version::parse(s).unwrap();
    assert_eq!(decide(&m, &cur("1.2.3"), &cur("1.2.2")).unwrap(), Decision::Newer);
    assert_eq!(decide(&m, &cur("1.2.3"), &cur("1.2.3")).unwrap(), Decision::UpToDate);
    assert!(matches!(decide(&m, &cur("1.2.3"), &cur("1.2.4")), Err(UpdateError::Downgrade { .. })));
  }

  #[test]
  fn min_version_requires_manual() {
    let mut m = ok_manifest();
    m.min_version = Some("1.2.0".into());
    let cur = |s: &str| Version::parse(s).unwrap();
    assert!(matches!(
      decide(&m, &cur("1.2.3"), &cur("1.1.0")),
      Err(UpdateError::NeedsManualUpdate { .. })
    ));
    assert_eq!(decide(&m, &cur("1.2.3"), &cur("1.2.1")).unwrap(), Decision::Newer);
  }
}
