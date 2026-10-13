//! Хранилище настроек сети: `profile.dpapi` и импорт `seed.dpapi` от установщика.
//!
//! Оба файла лежат в каталоге `network` (путь передаёт вызывающий) и зашифрованы DPAPI текущего пользователя.
//! Профиль: `{ embedded, override?, subscriptionCache, bootstrapIps, servicesEnabled }`. Встроенные значения
//! приходят из установщика, `override` ставит пользователь, приоритет у `override`.
//! Формат `seed.dpapi` и `provisioning.local.json` один: UTF-8 JSON
//! `{"schema":1,"vpn":"…","doh":"https://host/dns-query","mtproxy":"…"}`.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fmt;
use std::path::{Path, PathBuf};

/// Файл профиля.
pub const PROFILE_FILE: &str = "profile.dpapi";
/// Файл с данными от установщика; после импорта удаляется.
pub const SEED_FILE: &str = "seed.dpapi";
/// Поддерживаемая версия схемы.
pub const SCHEMA: u32 = 1;

/// Ключ VPN, приватный DoH и MTProxy: встроенные или заданные пользователем.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Provisioning {
  pub schema: u32,
  /// Одна ссылка, несколько ссылок через перевод строки либо `https://…` — адрес подписки.
  pub vpn: String,
  /// Приватный DoH: `https://host[:port]/dns-query`.
  pub doh: String,
  /// `tg://proxy?…`, `https://t.me/proxy?…` или пусто.
  pub mtproxy: String,
}

impl Default for Provisioning {
  fn default() -> Self {
    Self { schema: SCHEMA, vpn: String::new(), doh: String::new(), mtproxy: String::new() }
  }
}

// Debug без значений: ключи не должны попасть в журнал
impl fmt::Debug for Provisioning {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    write!(f, "Provisioning(vpn: {} симв., doh: {}, mtproxy: {})", self.vpn.len(),
      if self.doh.is_empty() { "нет" } else { "есть" }, if self.mtproxy.is_empty() { "нет" } else { "есть" })
  }
}

/// Откуда брать узлы VPN.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VpnSource {
  /// Текст с одной или несколькими ссылками.
  Links(String),
  /// Адрес подписки.
  SubscriptionUrl(String),
}

impl Provisioning {
  /// Разбирает JSON установщика или поля настроек; проверяет схему и адрес DoH. Значения в ошибки не попадают.
  pub fn parse(bytes: &[u8]) -> Result<Self, String> {
    let provisioning: Self = serde_json::from_slice(bytes).map_err(|_| "TUNNEL_PROVISIONING_INVALID".to_string())?;
    provisioning.validate()?;
    Ok(provisioning)
  }

  /// Проверка полей: схема 1, непустой `vpn`, DoH — `https` с хостом.
  pub fn validate(&self) -> Result<(), String> {
    if self.schema != SCHEMA { return Err("TUNNEL_PROVISIONING_SCHEMA".into()); }
    if self.vpn.trim().is_empty() { return Err("TUNNEL_PROVISIONING_VPN_EMPTY".into()); }
    let doh = url::Url::parse(self.doh.trim()).map_err(|_| "TUNNEL_PROVISIONING_DOH_INVALID".to_string())?;
    if doh.scheme() != "https" || doh.host_str().is_none() || !doh.username().is_empty() {
      return Err("TUNNEL_PROVISIONING_DOH_INVALID".into());
    }
    Ok(())
  }

  /// Источник узлов: префикс `http(s)://` у единственной строки означает адрес подписки.
  pub fn source(&self) -> VpnSource {
    let text = self.vpn.trim();
    let single_line = !text.contains(['\n', '\r']);
    if single_line && (text.starts_with("https://") || text.starts_with("http://")) {
      VpnSource::SubscriptionUrl(text.to_string())
    } else {
      VpnSource::Links(text.to_string())
    }
  }

  /// DoH без пробелов по краям.
  pub fn doh_url(&self) -> &str { self.doh.trim() }
}

/// Сохранённое состояние сети.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Profile {
  /// Значения из установщика.
  pub embedded: Option<Provisioning>,
  /// Значения пользователя; важнее `embedded`.
  #[serde(rename = "override")]
  pub override_: Option<Provisioning>,
  /// Последний скачанный текст подписки.
  pub subscription_cache: String,
  /// Когда подписка скачана в последний раз (unix, мс); 0 — не скачивалась.
  pub subscription_updated_at_ms: u64,
  /// Кэш IP по именам хостов (хост VPN, хост DoH) для `dns.hosts`.
  pub bootstrap_ips: BTreeMap<String, Vec<String>>,
  /// Сервисы, выключенные в настройках (`false`); отсутствующий сервис считается включённым.
  pub services_enabled: BTreeMap<String, bool>,
}

impl fmt::Debug for Profile {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    write!(f, "Profile(embedded: {}, override: {}, cache: {} симв.)", self.embedded.is_some(), self.override_.is_some(),
      self.subscription_cache.len())
  }
}

impl Profile {
  /// Действующие значения: `override`, иначе `embedded`.
  pub fn active(&self) -> Option<&Provisioning> {
    self.override_.as_ref().or(self.embedded.as_ref())
  }

  /// Сервис включён (по умолчанию да).
  pub fn service_enabled(&self, service: &str) -> bool {
    self.services_enabled.get(service).copied().unwrap_or(true)
  }
}

/// Хранилище в каталоге `network`.
pub struct Store {
  dir: PathBuf,
}

impl Store {
  /// Хранилище в каталоге `dir` (обычно `%LOCALAPPDATA%\com.egoist.relay\network`).
  pub fn new(dir: impl Into<PathBuf>) -> Self { Self { dir: dir.into() } }

  /// Каталог хранилища.
  pub fn dir(&self) -> &Path { &self.dir }

  fn profile_path(&self) -> PathBuf { self.dir.join(PROFILE_FILE) }

  fn seed_path(&self) -> PathBuf { self.dir.join(SEED_FILE) }

  /// Читает профиль. Нет файла — пустой профиль. Повреждённый файл переименовывается в `.bad`
  /// (не удаляется: он мог быть зашифрован другим пользователем) и возвращается пустой профиль.
  pub fn load(&self) -> Profile {
    let path = self.profile_path();
    let Ok(bytes) = std::fs::read(&path) else { return Profile::default(); };
    let parsed = crate::dpapi::unprotect(&bytes).ok().and_then(|plain| serde_json::from_slice::<Profile>(&plain).ok());
    match parsed {
      Some(profile) => profile,
      None => {
        log::warn!("[Tunnel] profile.dpapi повреждён или чужой; сохранён как .bad, начат пустой профиль");
        let _ = std::fs::rename(&path, self.dir.join(format!("{PROFILE_FILE}.bad")));
        Profile::default()
      }
    }
  }

  /// Атомарно записывает профиль: временный файл, затем переименование поверх старого.
  pub fn save(&self, profile: &Profile) -> Result<(), String> {
    let plain = serde_json::to_vec(profile).map_err(|_| "TUNNEL_PROFILE_SERIALIZE".to_string())?;
    let encrypted = crate::dpapi::protect(&plain)?;
    write_atomic(&self.dir, &self.profile_path(), &encrypted)
  }

  /// Импортирует `seed.dpapi` в `embedded` и удаляет seed. `Ok(false)` — seed не было.
  /// Не расшифровавшийся seed (другой пользователь) остаётся на месте и даёт ошибку.
  /// Повреждённый seed удаляется. Новый `embedded` с другим ключом сбрасывает кэш подписки и IP.
  pub fn import_seed(&self) -> Result<bool, String> {
    let path = self.seed_path();
    let Ok(bytes) = std::fs::read(&path) else { return Ok(false); };
    let plain = crate::dpapi::unprotect(&bytes).map_err(|_| "TUNNEL_SEED_UNREADABLE".to_string())?;
    let provisioning = match Provisioning::parse(&plain) {
      Ok(provisioning) => provisioning,
      Err(error) => {
        let _ = std::fs::remove_file(&path);
        return Err(error);
      }
    };
    let mut profile = self.load();
    let changed = profile.embedded.as_ref().map(|old| old.vpn != provisioning.vpn).unwrap_or(true);
    if changed {
      profile.subscription_cache.clear();
      profile.subscription_updated_at_ms = 0;
      profile.bootstrap_ips.clear();
    }
    profile.embedded = Some(provisioning);
    self.save(&profile)?;
    std::fs::remove_file(&path).map_err(|_| "TUNNEL_SEED_REMOVE_FAILED".to_string())?;
    Ok(true)
  }

  /// «Сбросить к встроенным»: убирает `override` и кэш подписки.
  pub fn reset_override(&self) -> Result<Profile, String> {
    let mut profile = self.load();
    profile.override_ = None;
    profile.subscription_cache.clear();
    profile.subscription_updated_at_ms = 0;
    profile.bootstrap_ips.clear();
    self.save(&profile)?;
    Ok(profile)
  }
}

/// Запись через временный файл рядом: при сбое рабочий файл остаётся целым.
fn write_atomic(dir: &Path, target: &Path, bytes: &[u8]) -> Result<(), String> {
  use std::io::Write;
  std::fs::create_dir_all(dir).map_err(|_| "TUNNEL_STORE_WRITE_FAILED".to_string())?;
  let temporary = target.with_extension("dpapi.tmp");
  let result = (|| -> std::io::Result<()> {
    let mut file = std::fs::File::create(&temporary)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    std::fs::rename(&temporary, target)
  })();
  if result.is_err() {
    let _ = std::fs::remove_file(&temporary);
    return Err("TUNNEL_STORE_WRITE_FAILED".into());
  }
  Ok(())
}

#[cfg(all(test, windows))]
mod tests {
  use super::*;

  const LINK: &str = "vless://00000000-0000-0000-0000-000000000000@example.com:443?security=none#t";
  const DOH: &str = "https://dns.example.net/dns-query";

  struct TestDir(PathBuf);
  impl TestDir {
    fn new() -> Self {
      let base = std::env::var_os("EGOIST_RELAY_TEST_WORK").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
      let dir = base.join(format!("tunnel-store-{}", uuid::Uuid::new_v4()));
      std::fs::create_dir_all(&dir).unwrap();
      Self(dir)
    }
  }
  impl Drop for TestDir {
    fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
  }

  fn seed_json(vpn: &str) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({ "schema": 1, "vpn": vpn, "doh": DOH, "mtproxy": "" })).unwrap()
  }

  fn provisioning(vpn: &str) -> Provisioning {
    Provisioning { schema: 1, vpn: vpn.into(), doh: DOH.into(), mtproxy: String::new() }
  }

  #[test]
  fn provisioning_parse_and_source() {
    let parsed = Provisioning::parse(&seed_json(LINK)).unwrap();
    assert_eq!(parsed.source(), VpnSource::Links(LINK.into()));
    let sub = Provisioning::parse(&seed_json("https://sub.example.com/token")).unwrap();
    assert_eq!(sub.source(), VpnSource::SubscriptionUrl("https://sub.example.com/token".into()));
    let many = provisioning(&format!("{LINK}\nhttps://sub.example.com/x"));
    assert!(matches!(many.source(), VpnSource::Links(_)));
    // mtproxy необязателен
    assert!(Provisioning::parse(br#"{"schema":1,"vpn":"ss://a:b@example.com:1","doh":"https://d.example.net/dns-query"}"#).is_ok());
  }

  #[test]
  fn provisioning_rejects_bad_input_without_leaking() {
    assert!(Provisioning::parse(b"not json").is_err());
    assert_eq!(Provisioning::parse(br#"{"schema":2,"vpn":"x","doh":"https://d.example.net/dns-query"}"#).unwrap_err(), "TUNNEL_PROVISIONING_SCHEMA");
    assert!(Provisioning::parse(br#"{"schema":1,"vpn":"  ","doh":"https://d.example.net/dns-query"}"#).is_err());
    assert!(Provisioning::parse(br#"{"schema":1,"vpn":"x","doh":"http://d.example.net/dns-query"}"#).is_err());
    assert!(Provisioning::parse(br#"{"schema":1,"vpn":"x","doh":""}"#).is_err());
    let secret = provisioning("SECRETVALUE-123456");
    assert!(!format!("{secret:?}").contains("SECRET"));
    assert!(!format!("{:?}", Profile { embedded: Some(secret), ..Profile::default() }).contains("SECRET"));
  }

  #[test]
  fn save_load_round_trip_is_encrypted_and_leaves_no_temp_file() {
    let dir = TestDir::new();
    let store = Store::new(dir.0.join("network"));
    assert_eq!(store.load(), Profile::default());
    let mut profile = Profile { embedded: Some(provisioning(LINK)), ..Profile::default() };
    profile.services_enabled.insert("instagram".into(), false);
    profile.bootstrap_ips.insert("example.com".into(), vec!["192.0.2.1".into()]);
    store.save(&profile).unwrap();
    assert_eq!(store.load(), profile);
    let raw = std::fs::read(store.dir().join(PROFILE_FILE)).unwrap();
    assert!(!raw.windows(11).any(|w| w == b"example.com"));
    let leftovers: Vec<_> = std::fs::read_dir(store.dir()).unwrap().map(|e| e.unwrap().file_name()).collect();
    assert_eq!(leftovers.len(), 1, "{leftovers:?}");
    // повторная запись заменяет файл
    profile.subscription_cache = "cache".into();
    store.save(&profile).unwrap();
    assert_eq!(store.load().subscription_cache, "cache");
  }

  #[test]
  fn override_beats_embedded_and_reset_restores() {
    let dir = TestDir::new();
    let store = Store::new(&dir.0);
    let profile = Profile { embedded: Some(provisioning(LINK)), override_: Some(provisioning("trojan://pw@o.example.com:443")), subscription_cache: "x".into(), ..Profile::default() };
    assert_eq!(profile.active().unwrap().vpn, "trojan://pw@o.example.com:443");
    store.save(&profile).unwrap();
    let reset = store.reset_override().unwrap();
    assert_eq!(reset.active().unwrap().vpn, LINK);
    assert!(reset.subscription_cache.is_empty());
    assert_eq!(store.load().active().unwrap().vpn, LINK);
    assert!(Profile::default().active().is_none());
  }

  #[test]
  fn service_enabled_defaults_to_true() {
    let mut profile = Profile::default();
    assert!(profile.service_enabled("x"));
    profile.services_enabled.insert("x".into(), false);
    assert!(!profile.service_enabled("x"));
    assert!(profile.service_enabled("telegram"));
  }

  #[test]
  fn seed_import_creates_embedded_and_deletes_seed() {
    let dir = TestDir::new();
    let store = Store::new(&dir.0);
    assert_eq!(store.import_seed(), Ok(false));
    std::fs::write(dir.0.join(SEED_FILE), crate::dpapi::protect(&seed_json(LINK)).unwrap()).unwrap();
    assert_eq!(store.import_seed(), Ok(true));
    assert!(!dir.0.join(SEED_FILE).exists());
    assert_eq!(store.load().embedded.unwrap().vpn, LINK);
    assert_eq!(store.import_seed(), Ok(false));
  }

  #[test]
  fn seed_import_with_new_key_drops_cache_but_keeps_override_and_flags() {
    let dir = TestDir::new();
    let store = Store::new(&dir.0);
    let mut profile = Profile { embedded: Some(provisioning(LINK)), override_: Some(provisioning("trojan://pw@o.example.com:443")), subscription_cache: "old".into(), ..Profile::default() };
    profile.services_enabled.insert("x".into(), false);
    store.save(&profile).unwrap();
    let new_link = "ss://aes-256-gcm:pw@new.example.com:8388";
    std::fs::write(dir.0.join(SEED_FILE), crate::dpapi::protect(&seed_json(new_link)).unwrap()).unwrap();
    store.import_seed().unwrap();
    let loaded = store.load();
    assert_eq!(loaded.embedded.as_ref().unwrap().vpn, new_link);
    assert!(loaded.subscription_cache.is_empty());
    assert!(loaded.override_.is_some());
    assert!(!loaded.service_enabled("x"));
  }

  #[test]
  fn broken_seed_is_removed_and_foreign_seed_is_kept() {
    let dir = TestDir::new();
    let store = Store::new(&dir.0);
    // расшифровывается, но не наш формат: удаляется
    std::fs::write(dir.0.join(SEED_FILE), crate::dpapi::protect(b"{\"schema\":1}").unwrap()).unwrap();
    assert!(store.import_seed().is_err());
    assert!(!dir.0.join(SEED_FILE).exists());
    // не расшифровывается (чужой пользователь или мусор): остаётся
    std::fs::write(dir.0.join(SEED_FILE), b"garbage that is not dpapi").unwrap();
    assert_eq!(store.import_seed(), Err("TUNNEL_SEED_UNREADABLE".into()));
    assert!(dir.0.join(SEED_FILE).exists());
  }

  #[test]
  fn corrupt_profile_is_quarantined() {
    let dir = TestDir::new();
    let store = Store::new(&dir.0);
    std::fs::write(dir.0.join(PROFILE_FILE), b"broken").unwrap();
    assert_eq!(store.load(), Profile::default());
    assert!(dir.0.join("profile.dpapi.bad").exists());
    assert!(!dir.0.join(PROFILE_FILE).exists());
  }
}
