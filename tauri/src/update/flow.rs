//! Конвейер обновления: проверка (релиз → подпись → манифест → антиоткат) и установка
//! (место → скачивание → проверка → запись состояния → запуск установщика).

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use semver::Version;
use serde::Serialize;

use super::error::{UpdateError, UpdateResult};
use super::manifest::{Decision, Manifest, SizeBounds, decide};
use super::sign::{PubKey, verify_manifest};
use super::source::{AssetRef, CachedLatest, GithubSource, HttpClient, INSTALLER_TIMEOUT, asset_by_name};
use super::stage::{self, Launcher, StageDirs, State};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Offer {
  pub manifest: Manifest,
  pub version: Version,
  pub installer: AssetRef,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Check {
  UpToDate,
  Available(Offer),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
  Downloading,
  Verifying,
  Launching,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProgressEvent {
  pub phase: Phase,
  pub done: u64,
  pub total: u64,
}

/// Проверка: сначала подпись по точным байтам, потом разбор JSON, потом сравнение версий.
pub async fn check<C: HttpClient>(
  src: &GithubSource<'_, C>,
  keys: &[PubKey<'_>],
  current: &Version,
  bounds: SizeBounds,
) -> UpdateResult<Check> {
  check_with(src, keys, current, bounds, &mut None).await
}

/// То же, что `check`, но с кэшем `releases/latest`: условный запрос по ETag, манифест и подпись
/// качаются только при смене релиза. Подпись проверяется на каждом вызове (байты из кэша тоже).
pub async fn check_with<C: HttpClient>(
  src: &GithubSource<'_, C>,
  keys: &[PubKey<'_>],
  current: &Version,
  bounds: SizeBounds,
  cache: &mut Option<CachedLatest>,
) -> UpdateResult<Check> {
  let fresh = src.latest_cached(cache.as_ref()).await?;
  let latest = fresh.release.clone();
  *cache = Some(fresh);
  verify_manifest(&latest.manifest, &latest.sig, keys)?;
  let manifest = Manifest::parse(&latest.manifest)?;
  let version = manifest.validate(bounds)?;
  if decide(&manifest, &version, current)? == Decision::UpToDate {
    return Ok(Check::UpToDate);
  }
  let installer = asset_by_name(&latest.assets, &manifest.installer.name)?.clone();
  Ok(Check::Available(Offer { manifest, version, installer }))
}

pub struct InstallEnv<'a> {
  pub dirs: &'a StageDirs,
  pub free_space: &'a (dyn Fn(&Path) -> std::io::Result<u64> + Sync),
  pub launcher: Arc<dyn Launcher>,
  /// Предел простоя потока (нет данных столько времени — обрыв).
  pub idle: Duration,
}

/// Скачать (или переиспользовать уже скачанный) установщик и проверить его.
/// Возвращает путь файла. Запуска здесь нет.
pub async fn prepare<C: HttpClient>(
  src: &GithubSource<'_, C>,
  offer: &Offer,
  env: &InstallEnv<'_>,
  progress: &mut (dyn FnMut(ProgressEvent) + Send),
) -> UpdateResult<std::path::PathBuf> {
  let info = &offer.manifest.installer;
  let dir = env.dirs.version_dir(&offer.version);
  std::fs::create_dir_all(&dir).map_err(|e| UpdateError::Io(e.to_string()))?;
  let final_path = dir.join(&info.name);
  let valid = {
    // Хеширование до гигабайта — не на потоке async-рантайма.
    let (path, size, sha) = (final_path.clone(), info.size, info.sha256.clone());
    tokio::task::spawn_blocking(move || stage::existing_valid(&path, size, &sha))
      .await
      .map_err(|e| UpdateError::Io(e.to_string()))?
  };
  if valid {
    return Ok(final_path);
  }
  let _ = std::fs::remove_file(&final_path);
  let need = info.size.saturating_mul(2);
  let have = (env.free_space)(&dir).map_err(|e| UpdateError::Io(e.to_string()))?;
  if have < need {
    return Err(UpdateError::NoSpace { need, have });
  }
  let resp = src.open_asset(&offer.installer, INSTALLER_TIMEOUT).await?;
  let total = info.size;
  stage::download(resp, &dir, &info.name, info.size, &info.sha256, env.idle, &mut |done| {
    progress(ProgressEvent { phase: Phase::Downloading, done, total })
  })
  .await
}

/// Полная установка: подготовка файла, запись `state.json`, запуск. После `Ok` приложению нужно завершиться.
pub async fn install<C: HttpClient>(
  src: &GithubSource<'_, C>,
  offer: &Offer,
  env: &InstallEnv<'_>,
  progress: &mut (dyn FnMut(ProgressEvent) + Send),
) -> UpdateResult<()> {
  let info = &offer.manifest.installer;
  let path = prepare(src, offer, env, progress).await?;
  progress(ProgressEvent { phase: Phase::Verifying, done: info.size, total: info.size });
  let attempts = match stage::read_state(env.dirs) {
    Some(prev) if prev.version == offer.version.to_string() => prev.attempts + 1,
    _ => 1,
  };
  stage::write_state(
    env.dirs,
    &State {
      version: offer.version.to_string(),
      path: path.to_string_lossy().into_owned(),
      sha256: info.sha256.clone(),
      size: info.size,
      attempts,
    },
  )?;
  progress(ProgressEvent { phase: Phase::Launching, done: info.size, total: info.size });
  let result = {
    let (path, size, sha, launcher) = (path.clone(), info.size, info.sha256.clone(), env.launcher.clone());
    tokio::task::spawn_blocking(move || stage::verify_and_launch(&path, size, &sha, &*launcher))
      .await
      .map_err(|e| UpdateError::Io(e.to_string()))?
  };
  if matches!(result, Err(UpdateError::HashMismatch | UpdateError::SizeMismatch)) {
    // Файл на диске не тот, что скачали: не оставляем его для повторных попыток.
    let _ = std::fs::remove_file(&path);
  }
  result
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::update::sign::signing::sign_manifest;
  use crate::update::source::HttpError;
  use crate::update::source::fake::{FakeHttp, Scripted, ok, status};
  use crate::update::testkit::*;
  use crate::update::token::Token;
  use std::sync::Mutex;

  const BOUNDS: SizeBounds = SizeBounds { min: 1, max: 1 << 20 };
  const LATEST: &str = "https://api.github.com/repos/egoist-ai1/beresta-releases/releases/latest";
  const SECRET: &str = "ghp_SECRETtokenVALUE0123";

  fn asset(id: u64) -> String {
    GithubSource::<FakeHttp>::asset_url(id)
  }

  fn rt() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread().enable_time().build().unwrap()
  }

  fn cur(s: &str) -> Version {
    Version::parse(s).unwrap()
  }

  struct Rec(Mutex<Vec<(std::path::PathBuf, Vec<String>)>>);
  impl Launcher for Rec {
    fn launch(&self, path: &Path, args: &[String]) -> std::io::Result<()> {
      self.0.lock().unwrap().push((path.to_path_buf(), args.to_vec()));
      Ok(())
    }
  }

  struct Fixture {
    http: FakeHttp,
    data: Vec<u8>,
  }

  /// Релиз 1.2.3: манифест, подпись `sig`, установщик `data`.
  fn fixture(version: &str, data: &[u8], manifest: Option<String>, sig: Option<String>) -> Fixture {
    let http = FakeHttp::new();
    let manifest = manifest.unwrap_or_else(|| manifest_json(version, data));
    let sig = sig.unwrap_or_else(|| sign_a(manifest.as_bytes()));
    let name = installer_name(version);
    http.route(
      LATEST,
      ok(format!(
        r#"{{"tag_name":"v{version}","draft":false,"assets":[{{"id":11,"name":"manifest.json"}},{{"id":12,"name":"manifest.json.sig"}},{{"id":13,"name":"{name}"}}]}}"#
      )
      .as_bytes()),
    );
    http.route(&asset(11), ok(manifest.as_bytes()));
    http.route(&asset(12), ok(sig.as_bytes()));
    let mut body = ok(data);
    body.chunks = data.chunks(700).map(|c| c.to_vec()).collect();
    http.route(&asset(13), body);
    Fixture { http, data: data.to_vec() }
  }

  fn keys() -> Vec<PubKey<'static>> {
    vec![("k1", pub_a())]
  }

  fn data() -> Vec<u8> {
    (0..3000u32).map(|i| (i % 251) as u8).collect()
  }

  async fn run_check(fx: &Fixture, current: &str) -> UpdateResult<Check> {
    let src = GithubSource::new(&fx.http, Token::new(SECRET))?;
    check(&src, &keys(), &cur(current), BOUNDS).await
  }

  async fn run_install(
    fx: &Fixture,
    dirs: &StageDirs,
    rec: &Arc<Rec>,
    free: u64,
    events: &mut Vec<ProgressEvent>,
  ) -> UpdateResult<()> {
    let src = GithubSource::new(&fx.http, Token::new(SECRET))?;
    let Check::Available(offer) = check(&src, &keys(), &cur("1.0.0"), BOUNDS).await? else { panic!("нет обновления") };
    let free_space = move |_: &Path| Ok(free);
    let env = InstallEnv { dirs, free_space: &free_space, launcher: rec.clone(), idle: Duration::from_secs(5) };
    install(&src, &offer, &env, &mut |e| events.push(e)).await
  }

  fn setup() -> (tempfile::TempDir, StageDirs, Arc<Rec>) {
    let t = tempfile::tempdir().unwrap();
    let dirs = StageDirs::new(t.path().join("updates"));
    (t, dirs, Arc::new(Rec(Mutex::new(vec![]))))
  }

  fn no_leftovers(dirs: &StageDirs) {
    let mut found = vec![];
    if dirs.root.exists() {
      for e in walk(&dirs.root) {
        found.push(e);
      }
    }
    assert!(found.iter().all(|p| !p.ends_with(".part") && !p.ends_with(".exe")), "{found:?}");
  }

  fn walk(p: &Path) -> Vec<String> {
    let mut out = vec![];
    for e in std::fs::read_dir(p).unwrap().flatten() {
      let path = e.path();
      if path.is_dir() {
        out.extend(walk(&path));
      } else {
        out.push(path.to_string_lossy().into_owned());
      }
    }
    out
  }

  #[test]
  fn happy_path() {
    let fx = fixture("1.2.3", &data(), None, None);
    let (_t, dirs, rec) = setup();
    let mut events = vec![];
    rt().block_on(run_install(&fx, &dirs, &rec, 1 << 30, &mut events)).unwrap();
    let launched = rec.0.lock().unwrap();
    assert_eq!(launched.len(), 1);
    assert_eq!(launched[0].1, ["--silent", "--launch", "--wait-app=120"]);
    assert_eq!(std::fs::read(&launched[0].0).unwrap(), fx.data);
    assert!(launched[0].0.ends_with("1.2.3/Beresta-Setup-1.2.3.exe") || launched[0].0.ends_with("1.2.3\\Beresta-Setup-1.2.3.exe"));
    let st = stage::read_state(&dirs).unwrap();
    assert_eq!((st.version.as_str(), st.attempts, st.size), ("1.2.3", 1, 3000));
    let phases: Vec<Phase> = events.iter().map(|e| e.phase).collect();
    assert_eq!(phases.first(), Some(&Phase::Downloading));
    assert_eq!(&phases[phases.len() - 2..], [Phase::Verifying, Phase::Launching]);
    assert_eq!(events.iter().filter(|e| e.phase == Phase::Downloading).last().unwrap().done, 3000);
    // Токен ушёл только на запросы к api.github.com, первым hop'ом.
    for r in fx.http.requests.lock().unwrap().iter() {
      assert!(r.url.starts_with("https://api.github.com/"));
    }
  }

  #[test]
  fn second_attempt_increments_and_reuses_file() {
    let fx = fixture("1.2.3", &data(), None, None);
    let (_t, dirs, rec) = setup();
    let mut ev = vec![];
    rt().block_on(run_install(&fx, &dirs, &rec, 1 << 30, &mut ev)).unwrap();
    let before = fx.http.requests_to(&asset(13)).len();
    rt().block_on(run_install(&fx, &dirs, &rec, 1 << 30, &mut ev)).unwrap();
    assert_eq!(fx.http.requests_to(&asset(13)).len(), before, "файл скачан повторно");
    assert_eq!(stage::read_state(&dirs).unwrap().attempts, 2);
  }

  #[test]
  fn check_with_cache_sends_etag_and_skips_manifest_download() {
    let fx = fixture("1.2.3", &data(), None, None);
    let mut first = ok(
      br#"{"tag_name":"v1.2.3","draft":false,"assets":[{"id":11,"name":"manifest.json"},{"id":12,"name":"manifest.json.sig"},{"id":13,"name":"Beresta-Setup-1.2.3.exe"}]}"#,
    );
    first.headers.push(("ETag".into(), "\"v1\"".into()));
    fx.http.routes_replace(LATEST, first);
    let src = GithubSource::new(&fx.http, Token::new(SECRET)).unwrap();
    let mut cache = None;
    let a = rt().block_on(check_with(&src, &keys(), &cur("1.0.0"), BOUNDS, &mut cache)).unwrap();
    assert!(matches!(a, Check::Available(_)));
    let n = fx.http.requests.lock().unwrap().len();
    assert_eq!(n, 3);
    fx.http.routes_replace(LATEST, status(304));
    let b = rt().block_on(check_with(&src, &keys(), &cur("1.0.0"), BOUNDS, &mut cache)).unwrap();
    assert_eq!(a, b);
    assert_eq!(fx.http.requests.lock().unwrap().len(), n + 1, "при 304 нужен ровно один запрос");
  }

  #[test]
  fn foreign_key_is_rejected_before_any_download() {
    let d = data();
    let m = manifest_json("1.2.3", &d);
    let sig = sign_manifest(&SEED_B, "k1", m.as_bytes());
    let fx = fixture("1.2.3", &d, Some(m), Some(sig));
    let err = rt().block_on(run_check(&fx, "1.0.0")).unwrap_err();
    assert!(matches!(err, UpdateError::Signature(_)), "{err:?}");
    assert!(fx.http.requests_to(&asset(13)).is_empty());
  }

  #[test]
  fn manifest_changed_by_one_byte() {
    let d = data();
    let m = manifest_json("1.2.3", &d);
    let sig = sign_a(m.as_bytes());
    // Подпись по оригиналу, а сервер отдаёт манифест с изменённым байтом (дата публикации).
    let tampered = m.replace("2026-10-25", "2026-10-26");
    assert_eq!(tampered.len(), m.len());
    let fx = fixture("1.2.3", &d, Some(tampered), Some(sig));
    let err = rt().block_on(run_check(&fx, "1.0.0")).unwrap_err();
    assert_eq!(err, UpdateError::Signature(crate::update::sign::SignError::BadSignature));
  }

  #[test]
  fn not_newer_means_no_download() {
    let fx = fixture("1.2.3", &data(), None, None);
    assert_eq!(rt().block_on(run_check(&fx, "1.2.3")).unwrap(), Check::UpToDate);
    let err = rt().block_on(run_check(&fx, "1.3.0")).unwrap_err();
    assert!(matches!(err, UpdateError::Downgrade { .. }));
    assert!(fx.http.requests_to(&asset(13)).is_empty());
  }

  #[test]
  fn hash_mismatch_removes_part_and_does_not_launch() {
    let d = data();
    let mut other = d.clone();
    other[10] ^= 0xFF;
    // Манифест описывает `d`, сервер отдаёт `other` той же длины.
    let fx = fixture("1.2.3", &other, Some(manifest_json("1.2.3", &d)), None);
    let (_t, dirs, rec) = setup();
    let err = rt().block_on(run_install(&fx, &dirs, &rec, 1 << 30, &mut vec![])).unwrap_err();
    assert_eq!(err, UpdateError::HashMismatch);
    assert!(rec.0.lock().unwrap().is_empty());
    no_leftovers(&dirs);
  }

  #[test]
  fn size_mismatch_removes_part_and_does_not_launch() {
    let d = data();
    let fx = fixture("1.2.3", &d[..2500], Some(manifest_json("1.2.3", &d)), None);
    let (_t, dirs, rec) = setup();
    let err = rt().block_on(run_install(&fx, &dirs, &rec, 1 << 30, &mut vec![])).unwrap_err();
    assert_eq!(err, UpdateError::SizeMismatch);
    assert!(rec.0.lock().unwrap().is_empty());
    no_leftovers(&dirs);
  }

  #[test]
  fn interrupted_stream() {
    let d = data();
    let fx = fixture("1.2.3", &d, None, None);
    let mut cut: Scripted = ok(&d[..1000]);
    cut.content_length = Some(3000);
    cut.error_after = Some(HttpError::Network("соединение сброшено".into()));
    fx.http.routes_replace(&asset(13), cut);
    let (_t, dirs, rec) = setup();
    let err = rt().block_on(run_install(&fx, &dirs, &rec, 1 << 30, &mut vec![])).unwrap_err();
    assert!(matches!(err, UpdateError::Network(_)), "{err:?}");
    assert!(rec.0.lock().unwrap().is_empty());
    no_leftovers(&dirs);
  }

  #[test]
  fn not_enough_disk_space_before_download() {
    let fx = fixture("1.2.3", &data(), None, None);
    let (_t, dirs, rec) = setup();
    let err = rt().block_on(run_install(&fx, &dirs, &rec, 5999, &mut vec![])).unwrap_err();
    assert!(matches!(err, UpdateError::NoSpace { need: 6000, have: 5999 }), "{err:?}");
    assert!(fx.http.requests_to(&asset(13)).is_empty());
    // Ровно 2×size — достаточно.
    rt().block_on(run_install(&fx, &dirs, &rec, 6000, &mut vec![])).unwrap();
  }

  #[test]
  fn installer_name_without_version_is_rejected() {
    let d = data();
    let m = manifest_json("1.2.3", &d).replace("Beresta-Setup-1.2.3.exe", "Beresta-Setup.exe");
    let sig = sign_a(m.as_bytes());
    let fx = fixture("1.2.3", &d, Some(m), Some(sig));
    let err = rt().block_on(run_check(&fx, "1.0.0")).unwrap_err();
    assert!(matches!(err, UpdateError::Manifest(_)), "{err:?}");
  }

  #[test]
  fn signed_legacy_installer_is_resolved_by_its_original_name() {
    let d = data();
    let legacy_name = "Egoist-Social-Setup-1.2.3.exe";
    let m = manifest_json("1.2.3", &d).replace(&installer_name("1.2.3"), legacy_name);
    let fx = fixture("1.2.3", &d, Some(m), None);
    fx.http.routes_replace(
      LATEST,
      ok(format!(
        r#"{{"tag_name":"v1.2.3","assets":[{{"id":11,"name":"manifest.json"}},{{"id":12,"name":"manifest.json.sig"}},{{"id":13,"name":"{legacy_name}"}}]}}"#
      ).as_bytes()),
    );
    let Check::Available(offer) = rt().block_on(run_check(&fx, "1.0.0")).unwrap() else { panic!("нет обновления") };
    assert_eq!(offer.installer.name, legacy_name);
  }

  #[test]
  fn installer_asset_missing_in_release() {
    let d = data();
    let fx = fixture("1.2.3", &d, None, None);
    fx.http.routes_replace(
      LATEST,
      ok(br#"{"tag_name":"v1.2.3","assets":[{"id":11,"name":"manifest.json"},{"id":12,"name":"manifest.json.sig"}]}"#),
    );
    let err = rt().block_on(run_check(&fx, "1.0.0")).unwrap_err();
    assert_eq!(err, UpdateError::MissingAsset("Beresta-Setup-1.2.3.exe".into()));
  }

  #[test]
  fn errors_and_events_never_contain_token() {
    let fx = fixture("1.2.3", &data(), None, None);
    fx.http.routes_replace(&asset(13), status(401));
    let (_t, dirs, rec) = setup();
    let mut events = vec![];
    let err = rt().block_on(run_install(&fx, &dirs, &rec, 1 << 30, &mut events)).unwrap_err();
    let dump = format!("{err:?} | {err} | {events:?} | {:?}", fx.http.requests.lock().unwrap());
    assert!(!dump.contains(SECRET), "{dump}");
  }

  #[test]
  fn launch_failure_is_reported() {
    struct Bad;
    impl Launcher for Bad {
      fn launch(&self, _: &Path, _: &[String]) -> std::io::Result<()> {
        Err(std::io::Error::other("нет доступа"))
      }
    }
    let fx = fixture("1.2.3", &data(), None, None);
    let (_t, dirs, _) = setup();
    let src = GithubSource::new(&fx.http, Token::new(SECRET)).unwrap();
    let Check::Available(offer) = rt().block_on(check(&src, &keys(), &cur("1.0.0"), BOUNDS)).unwrap() else { panic!() };
    let free = |_: &Path| Ok(1u64 << 30);
    let env = InstallEnv { dirs: &dirs, free_space: &free, launcher: Arc::new(Bad), idle: Duration::from_secs(5) };
    let err = rt().block_on(install(&src, &offer, &env, &mut |_| {})).unwrap_err();
    assert!(matches!(err, UpdateError::Launch(_)));
  }
}
