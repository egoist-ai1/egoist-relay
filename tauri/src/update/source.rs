//! Источник релизов: GitHub API приватного репозитория `egoist-ai1/beresta-releases`.
//!
//! Сеть — только через трейт `HttpClient` (в тестах фейк). Клиент сам перенаправлениям не следует:
//! это делает `Fetcher`, чтобы управлять заголовком `Authorization`. Токен уходит только на ПЕРВЫЙ запрос
//! к api.github.com; на любых перенаправлениях (CDN, возврат на api.github.com) заголовок не отправляется.
//! Адрес скачивания ассета строится из числового id, поля `url`/`browser_download_url` из ответа не читаются.

use std::future::Future;
use std::time::Duration;

use serde::Deserialize;

use super::error::{UpdateError, UpdateResult};
use super::manifest::MANIFEST_MAX_BYTES;
use super::sign::SIG_MAX_BYTES;
use super::token::Token;

pub const API_HOST: &str = "api.github.com";
pub const OWNER: &str = "egoist-ai1";
pub const REPO: &str = "beresta-releases";
pub const USER_AGENT: &str = "Beresta-Updater";
pub const MANIFEST_ASSET: &str = "manifest.json";
pub const SIG_ASSET: &str = "manifest.json.sig";
const MAX_REDIRECTS: usize = 5;
const RELEASE_JSON_MAX: u64 = 1024 * 1024;
const API_TIMEOUT: Duration = Duration::from_secs(20);
/// Общий потолок на скачивание установщика (целиком, вместе с телом). Зависание ловит таймаут простоя
/// (`InstallEnv::idle`, нет данных 60 с), поэтому потолок большой: медленная, но живая сеть докачает.
pub const INSTALLER_TIMEOUT: Duration = Duration::from_secs(4 * 60 * 60);

// ------------------------------------------------------------------ HTTP-граница

#[derive(Clone, PartialEq, Eq)]
pub struct HttpRequest {
  pub url: String,
  pub headers: Vec<(String, String)>,
  pub timeout: Duration,
}

/// Debug не печатает значения секретных заголовков.
impl std::fmt::Debug for HttpRequest {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    let masked: Vec<(&str, &str)> = self
      .headers
      .iter()
      .map(|(k, v)| {
        let secret = ["authorization", "cookie", "proxy-authorization"].iter().any(|s| k.eq_ignore_ascii_case(s));
        (k.as_str(), if secret { "***" } else { v.as_str() })
      })
      .collect();
    f.debug_struct("HttpRequest")
      .field("url", &self.url)
      .field("headers", &masked)
      .field("timeout", &self.timeout)
      .finish()
  }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HttpError {
  Timeout,
  Network(String),
}

/// Тело ответа потоком.
pub trait ByteStream: Send {
  fn next_chunk(&mut self) -> impl Future<Output = Result<Option<Vec<u8>>, HttpError>> + Send;
}

pub struct HttpResponse<B> {
  pub status: u16,
  pub headers: Vec<(String, String)>,
  pub content_length: Option<u64>,
  pub body: B,
}

impl<B> HttpResponse<B> {
  pub fn header(&self, name: &str) -> Option<&str> {
    self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
  }
}

/// HTTP GET без автоматических перенаправлений. Реализация обязана: только https, таймаут `timeout`,
/// не логировать заголовки.
pub trait HttpClient: Send + Sync {
  type Body: ByteStream;
  fn get(&self, req: &HttpRequest) -> impl Future<Output = Result<HttpResponse<Self::Body>, HttpError>> + Send;
}

fn map_http_error(e: HttpError) -> UpdateError {
  match e {
    HttpError::Timeout => UpdateError::Timeout,
    HttpError::Network(m) => UpdateError::Network(m),
  }
}

fn map_status<B>(r: &HttpResponse<B>) -> UpdateError {
  match r.status {
    401 => UpdateError::Unauthorized,
    404 => UpdateError::NotFound,
    429 => UpdateError::RateLimited,
    403 => {
      if r.header("x-ratelimit-remaining") == Some("0") || r.header("retry-after").is_some() {
        UpdateError::RateLimited
      } else {
        UpdateError::Forbidden
      }
    }
    s => UpdateError::HttpStatus(s),
  }
}

/// Прочитать тело целиком, не больше `max_bytes`.
pub async fn read_limited<B: ByteStream>(resp: &mut HttpResponse<B>, max_bytes: u64) -> UpdateResult<Vec<u8>> {
  if resp.content_length.is_some_and(|n| n > max_bytes) {
    return Err(UpdateError::TooLarge);
  }
  let mut out = Vec::new();
  while let Some(chunk) = resp.body.next_chunk().await.map_err(map_http_error)? {
    if out.len() as u64 + chunk.len() as u64 > max_bytes {
      return Err(UpdateError::TooLarge);
    }
    out.extend_from_slice(&chunk);
  }
  Ok(out)
}

// ------------------------------------------------------------------ Fetcher

pub struct Fetcher<'a, C: HttpClient> {
  pub client: &'a C,
  pub token: Token,
}

impl<'a, C: HttpClient> Fetcher<'a, C> {
  pub fn new(client: &'a C, token: Token) -> Self {
    Fetcher { client, token }
  }

  fn headers_for(&self, url: &url::Url, accept: &str, first_hop: bool, etag: Option<&str>) -> Vec<(String, String)> {
    let mut h = vec![
      ("Accept".to_string(), accept.to_string()),
      ("User-Agent".to_string(), USER_AGENT.to_string()),
    ];
    if url.host_str() == Some(API_HOST) {
      h.push(("X-GitHub-Api-Version".to_string(), "2022-11-28".to_string()));
      if first_hop && !self.token.is_empty() {
        h.push(("Authorization".to_string(), format!("Bearer {}", self.token.expose())));
      }
      if first_hop && let Some(tag) = etag {
        h.push(("If-None-Match".to_string(), tag.to_string()));
      }
    }
    h
  }

  /// GET с ручными перенаправлениями (не больше 5); возвращает ответ 200 с неначатым телом.
  pub async fn open(&self, url: &str, accept: &str, timeout: Duration) -> UpdateResult<HttpResponse<C::Body>> {
    self.open_inner(url, accept, timeout, None).await
  }

  /// Как `open`; при заданном `etag` шлёт `If-None-Match` (только на первый запрос) и пропускает ответ 304.
  async fn open_inner(
    &self,
    url: &str,
    accept: &str,
    timeout: Duration,
    etag: Option<&str>,
  ) -> UpdateResult<HttpResponse<C::Body>> {
    let mut current = url::Url::parse(url).map_err(|_| UpdateError::BadResponse("некорректный URL".into()))?;
    for hop in 0..=MAX_REDIRECTS {
      if current.scheme() != "https" {
        return Err(UpdateError::InsecureRedirect("не https".into()));
      }
      if !current.username().is_empty() || current.password().is_some() {
        return Err(UpdateError::InsecureRedirect("учётные данные в адресе".into()));
      }
      let req = HttpRequest {
        url: current.to_string(),
        headers: self.headers_for(&current, accept, hop == 0, etag),
        timeout,
      };
      let resp = self.client.get(&req).await.map_err(map_http_error)?;
      match resp.status {
        200 => return Ok(resp),
        304 if etag.is_some() && hop == 0 => return Ok(resp),
        301 | 302 | 303 | 307 | 308 => {
          let loc = resp
            .header("location")
            .ok_or_else(|| UpdateError::BadResponse("перенаправление без Location".into()))?;
          current = current.join(loc).map_err(|_| UpdateError::BadResponse("Location".into()))?;
        }
        _ => return Err(map_status(&resp)),
      }
    }
    Err(UpdateError::TooManyRedirects)
  }

  pub async fn get_bytes(&self, url: &str, accept: &str, max_bytes: u64, timeout: Duration) -> UpdateResult<Vec<u8>> {
    let mut resp = self.open(url, accept, timeout).await?;
    read_limited(&mut resp, max_bytes).await
  }
}

// ------------------------------------------------------------------ Источник

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssetRef {
  pub id: u64,
  pub name: String,
}

/// Последний релиз: байты манифеста и подписи (ещё НЕ проверены) и список файлов релиза.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LatestRelease {
  pub tag: String,
  pub manifest: Vec<u8>,
  pub sig: String,
  pub assets: Vec<AssetRef>,
}

/// Результат прошлого запроса `releases/latest`: ETag и байты манифеста/подписи для повторного использования.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CachedLatest {
  pub etag: Option<String>,
  pub release: LatestRelease,
  manifest_id: u64,
  sig_id: u64,
}

#[derive(Deserialize)]
struct ReleaseJson {
  tag_name: String,
  #[serde(default)]
  draft: bool,
  #[serde(default)]
  assets: Vec<AssetJson>,
}

#[derive(Deserialize)]
struct AssetJson {
  id: u64,
  name: String,
}

pub struct GithubSource<'a, C: HttpClient> {
  fetcher: Fetcher<'a, C>,
}

/// Файл с точным именем: нет — `MissingAsset`, больше одного — ошибка.
pub fn asset_by_name<'r>(assets: &'r [AssetRef], name: &str) -> UpdateResult<&'r AssetRef> {
  let mut it = assets.iter().filter(|a| a.name == name);
  let first = it.next().ok_or_else(|| UpdateError::MissingAsset(name.to_string()))?;
  if it.next().is_some() {
    return Err(UpdateError::BadResponse(format!("несколько файлов {name}")));
  }
  Ok(first)
}

impl<'a, C: HttpClient> GithubSource<'a, C> {
  pub fn new(client: &'a C, token: Token) -> UpdateResult<Self> {
    if token.is_empty() {
      return Err(UpdateError::Unavailable);
    }
    Ok(GithubSource { fetcher: Fetcher::new(client, token) })
  }

  fn base() -> String {
    format!("https://{API_HOST}/repos/{OWNER}/{REPO}")
  }

  pub fn asset_url(id: u64) -> String {
    format!("{}/releases/assets/{id}", Self::base())
  }

  /// Скачивание ассета потоком. Адрес строится из числового id.
  pub async fn open_asset(&self, asset: &AssetRef, timeout: Duration) -> UpdateResult<HttpResponse<C::Body>> {
    self.fetcher.open(&Self::asset_url(asset.id), "application/octet-stream", timeout).await
  }

  async fn small_asset(&self, asset: &AssetRef, max: u64) -> UpdateResult<Vec<u8>> {
    self.fetcher
      .get_bytes(&Self::asset_url(asset.id), "application/octet-stream", max, API_TIMEOUT)
      .await
  }

  pub async fn latest(&self) -> UpdateResult<LatestRelease> {
    Ok(self.latest_cached(None).await?.release)
  }

  /// Последний релиз с условным запросом: при совпадении ETag (ответ 304) возвращается копия `cache`
  /// без скачивания манифеста и подписи; манифест и подпись качаются только если изменились их файлы.
  pub async fn latest_cached(&self, cache: Option<&CachedLatest>) -> UpdateResult<CachedLatest> {
    let etag = cache.and_then(|c| c.etag.as_deref());
    let mut resp = self
      .fetcher
      .open_inner(&format!("{}/releases/latest", Self::base()), "application/vnd.github+json", API_TIMEOUT, etag)
      .await?;
    if resp.status == 304 {
      return cache.cloned().ok_or_else(|| UpdateError::BadResponse("304 без кэша".into()));
    }
    let new_etag = resp.header("etag").filter(|v| v.len() <= 256).map(str::to_string);
    let body = read_limited(&mut resp, RELEASE_JSON_MAX).await?;
    let rel: ReleaseJson =
      serde_json::from_slice(&body).map_err(|e| UpdateError::BadResponse(format!("релиз: {e}")))?;
    if rel.draft {
      return Err(UpdateError::BadResponse("черновик релиза".into()));
    }
    let assets: Vec<AssetRef> = rel
      .assets
      .into_iter()
      .filter(|a| a.id != 0)
      .map(|a| AssetRef { id: a.id, name: a.name })
      .collect();
    let m_ref = asset_by_name(&assets, MANIFEST_ASSET)?.clone();
    let s_ref = asset_by_name(&assets, SIG_ASSET)?.clone();
    if let Some(c) = cache
      && c.release.tag == rel.tag_name
      && c.manifest_id == m_ref.id
      && c.sig_id == s_ref.id
    {
      // Тот же тег и те же файлы: байты манифеста и подписи уже есть.
      return Ok(CachedLatest {
        etag: new_etag,
        release: LatestRelease { assets, ..c.release.clone() },
        manifest_id: m_ref.id,
        sig_id: s_ref.id,
      });
    }
    let manifest = self.small_asset(&m_ref, MANIFEST_MAX_BYTES as u64).await?;
    let sig_bytes = self.small_asset(&s_ref, SIG_MAX_BYTES as u64).await?;
    let sig = String::from_utf8(sig_bytes).map_err(|_| UpdateError::BadResponse("подпись не UTF-8".into()))?;
    Ok(CachedLatest {
      etag: new_etag,
      release: LatestRelease { tag: rel.tag_name, manifest, sig, assets },
      manifest_id: m_ref.id,
      sig_id: s_ref.id,
    })
  }
}

// ------------------------------------------------------------------ Реализация на reqwest

pub struct ReqwestClient {
  client: reqwest::Client,
}

impl ReqwestClient {
  pub fn new() -> Result<ReqwestClient, String> {
    // Провайдер шифрования rustls (ring) — один раз на процесс; повторная установка не ошибка.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let client = reqwest::Client::builder()
      .redirect(reqwest::redirect::Policy::none())
      .https_only(true)
      .connect_timeout(Duration::from_secs(15))
      .build()
      .map_err(|e| e.without_url().to_string())?;
    Ok(ReqwestClient { client })
  }
}

pub struct ReqwestBody(reqwest::Response);

impl ByteStream for ReqwestBody {
  async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, HttpError> {
    self.0.chunk().await.map(|c| c.map(|b| b.to_vec())).map_err(map_reqwest_error)
  }
}

fn map_reqwest_error(e: reqwest::Error) -> HttpError {
  if e.is_timeout() {
    HttpError::Timeout
  } else {
    // Без адреса: он не нужен пользователю и не должен попадать в сообщения.
    HttpError::Network(e.without_url().to_string())
  }
}

impl HttpClient for ReqwestClient {
  type Body = ReqwestBody;

  async fn get(&self, req: &HttpRequest) -> Result<HttpResponse<ReqwestBody>, HttpError> {
    let mut builder = self.client.get(&req.url).timeout(req.timeout);
    for (k, v) in &req.headers {
      let mut value =
        reqwest::header::HeaderValue::from_str(v).map_err(|_| HttpError::Network("недопустимый заголовок".into()))?;
      if ["authorization", "cookie", "proxy-authorization"].iter().any(|s| k.eq_ignore_ascii_case(s)) {
        // Секретное значение не попадает в Debug-вывод и журналы клиента.
        value.set_sensitive(true);
      }
      builder = builder.header(k, value);
    }
    let resp = builder.send().await.map_err(map_reqwest_error)?;
    let headers = resp
      .headers()
      .iter()
      .filter_map(|(k, v)| v.to_str().ok().map(|v| (k.as_str().to_string(), v.to_string())))
      .collect();
    Ok(HttpResponse {
      status: resp.status().as_u16(),
      headers,
      content_length: resp.content_length(),
      body: ReqwestBody(resp),
    })
  }
}

// ------------------------------------------------------------------ фейк для тестов

#[cfg(test)]
pub mod fake {
  use super::*;
  use std::collections::{HashMap, VecDeque};
  use std::sync::Mutex;

  /// Ответ: статус, заголовки, куски тела и необязательная ошибка после них (обрыв).
  #[derive(Clone)]
  pub struct Scripted {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub chunks: Vec<Vec<u8>>,
    pub error_after: Option<HttpError>,
    pub content_length: Option<u64>,
  }

  pub fn ok(body: &[u8]) -> Scripted {
    Scripted {
      status: 200,
      headers: vec![],
      chunks: vec![body.to_vec()],
      error_after: None,
      content_length: Some(body.len() as u64),
    }
  }

  pub fn status(code: u16) -> Scripted {
    Scripted { status: code, headers: vec![], chunks: vec![], error_after: None, content_length: Some(0) }
  }

  pub fn redirect(location: &str) -> Scripted {
    Scripted {
      status: 302,
      headers: vec![("Location".into(), location.into())],
      chunks: vec![],
      error_after: None,
      content_length: Some(0),
    }
  }

  pub struct FakeBody {
    chunks: VecDeque<Vec<u8>>,
    error: Option<HttpError>,
  }

  impl ByteStream for FakeBody {
    async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, HttpError> {
      if let Some(c) = self.chunks.pop_front() {
        return Ok(Some(c));
      }
      match self.error.take() {
        Some(e) => Err(e),
        None => Ok(None),
      }
    }
  }

  /// Скриптуемый HTTP: очередь ответов по URL (последний «липкий»), журнал запросов.
  #[derive(Default)]
  pub struct FakeHttp {
    routes: Mutex<HashMap<String, Vec<Scripted>>>,
    pub requests: Mutex<Vec<HttpRequest>>,
  }

  impl FakeHttp {
    pub fn new() -> FakeHttp {
      FakeHttp::default()
    }
    pub fn route(&self, url: &str, r: Scripted) {
      self.routes.lock().unwrap().entry(url.to_string()).or_default().push(r);
    }
    /// Заменить всю очередь ответов маршрута одним.
    pub fn routes_replace(&self, url: &str, r: Scripted) {
      self.routes.lock().unwrap().insert(url.to_string(), vec![r]);
    }
    pub fn urls(&self) -> Vec<String> {
      self.requests.lock().unwrap().iter().map(|r| r.url.clone()).collect()
    }
    pub fn requests_to(&self, url: &str) -> Vec<HttpRequest> {
      self.requests.lock().unwrap().iter().filter(|r| r.url == url).cloned().collect()
    }
  }

  impl HttpClient for FakeHttp {
    type Body = FakeBody;

    async fn get(&self, req: &HttpRequest) -> Result<HttpResponse<FakeBody>, HttpError> {
      self.requests.lock().unwrap().push(req.clone());
      let mut routes = self.routes.lock().unwrap();
      let queue = routes.get_mut(&req.url).ok_or_else(|| HttpError::Network("нет маршрута".into()))?;
      let r = if queue.len() > 1 { queue.remove(0) } else { queue[0].clone() };
      Ok(HttpResponse {
        status: r.status,
        headers: r.headers,
        content_length: r.content_length,
        body: FakeBody { chunks: r.chunks.into(), error: r.error_after },
      })
    }
  }
}

#[cfg(test)]
mod tests {
  use super::fake::*;
  use super::*;

  const LATEST: &str = "https://api.github.com/repos/egoist-ai1/beresta-releases/releases/latest";

  fn token() -> Token {
    Token::new("secret_TOKEN_value_123")
  }

  fn release_json(extra: &str) -> Vec<u8> {
    format!(
      r#"{{"tag_name":"v1.2.3","draft":false,"assets":[{{"id":11,"name":"manifest.json","url":"https://evil.example/x"}},{{"id":12,"name":"manifest.json.sig"}},{{"id":13,"name":"Beresta-Setup-1.2.3.exe"}}{extra}]}}"#
    )
    .into_bytes()
  }

  fn rt() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread().enable_time().build().unwrap()
  }

  #[test]
  fn latest_uses_ids_and_token_only_on_first_hop() {
    let http = FakeHttp::new();
    http.route(LATEST, ok(&release_json("")));
    http.route(&GithubSource::<FakeHttp>::asset_url(11), ok(b"{}"));
    http.route(&GithubSource::<FakeHttp>::asset_url(12), ok(b"sig"));
    let src = GithubSource::new(&http, token()).unwrap();
    let rel = rt().block_on(src.latest()).unwrap();
    assert_eq!(rel.manifest, b"{}");
    assert_eq!(rel.sig, "sig");
    assert_eq!(rel.assets.len(), 3);
    // Поле url из JSON не использовалось.
    assert!(http.urls().iter().all(|u| u.starts_with("https://api.github.com/")));
    let first = &http.requests.lock().unwrap()[0];
    assert!(first.headers.iter().any(|(k, v)| k == "Authorization" && v == "Bearer secret_TOKEN_value_123"));
    assert!(first.headers.contains(&("Accept".into(), "application/vnd.github+json".into())));
    assert!(first.headers.contains(&("X-GitHub-Api-Version".into(), "2022-11-28".into())));
  }

  #[test]
  fn conditional_latest_uses_etag_and_skips_assets_on_304() {
    let http = FakeHttp::new();
    let mut first = ok(&release_json(""));
    first.headers.push(("ETag".into(), "\"abc\"".into()));
    http.route(LATEST, first);
    http.route(&GithubSource::<FakeHttp>::asset_url(11), ok(b"{}"));
    http.route(&GithubSource::<FakeHttp>::asset_url(12), ok(b"sig"));
    let src = GithubSource::new(&http, token()).unwrap();
    let c1 = rt().block_on(src.latest_cached(None)).unwrap();
    assert_eq!(c1.etag.as_deref(), Some("\"abc\""));
    assert_eq!(http.urls().len(), 3);
    // Второй запрос: сервер отвечает 304, манифест и подпись не качаются.
    http.routes_replace(LATEST, status(304));
    let c2 = rt().block_on(src.latest_cached(Some(&c1))).unwrap();
    assert_eq!(c2, c1);
    let reqs = http.requests_to(LATEST);
    assert_eq!(reqs.len(), 2);
    assert!(!reqs[0].headers.iter().any(|(k, _)| k == "If-None-Match"));
    assert!(reqs[1].headers.contains(&("If-None-Match".into(), "\"abc\"".into())));
    assert_eq!(http.urls().len(), 4, "лишние запросы: {:?}", http.urls());
  }

  #[test]
  fn same_tag_new_etag_reuses_manifest_but_new_assets_redownload() {
    let http = FakeHttp::new();
    let mut first = ok(&release_json(""));
    first.headers.push(("ETag".into(), "\"a\"".into()));
    http.route(LATEST, first);
    http.route(&GithubSource::<FakeHttp>::asset_url(11), ok(b"{}"));
    http.route(&GithubSource::<FakeHttp>::asset_url(12), ok(b"sig"));
    let src = GithubSource::new(&http, token()).unwrap();
    let c1 = rt().block_on(src.latest_cached(None)).unwrap();
    // ETag сменился, тег и id файлов те же: скачивается только JSON релиза.
    let mut second = ok(&release_json(""));
    second.headers.push(("ETag".into(), "\"b\"".into()));
    http.routes_replace(LATEST, second);
    let c2 = rt().block_on(src.latest_cached(Some(&c1))).unwrap();
    assert_eq!(c2.etag.as_deref(), Some("\"b\""));
    assert_eq!(c2.release.manifest, c1.release.manifest);
    assert_eq!(http.urls().len(), 4);
    // Манифест перезалит (другой id): качается заново.
    let moved = String::from_utf8(release_json("")).unwrap().replace("\"id\":11", "\"id\":21");
    http.routes_replace(LATEST, ok(moved.as_bytes()));
    http.route(&GithubSource::<FakeHttp>::asset_url(21), ok(b"{\"n\":1}"));
    let c3 = rt().block_on(src.latest_cached(Some(&c2))).unwrap();
    assert_eq!(c3.release.manifest, b"{\"n\":1}");
  }

  #[test]
  fn draft_missing_and_duplicate_assets() {
    let http = FakeHttp::new();
    http.route(LATEST, ok(br#"{"tag_name":"v1","draft":true,"assets":[]}"#));
    let src = GithubSource::new(&http, token()).unwrap();
    assert!(matches!(rt().block_on(src.latest()), Err(UpdateError::BadResponse(_))));

    let http = FakeHttp::new();
    http.route(LATEST, ok(br#"{"tag_name":"v1","assets":[{"id":11,"name":"manifest.json"}]}"#));
    let src = GithubSource::new(&http, token()).unwrap();
    assert_eq!(rt().block_on(src.latest()), Err(UpdateError::MissingAsset("manifest.json.sig".into())));

    let http = FakeHttp::new();
    http.route(LATEST, ok(&release_json(r#",{"id":99,"name":"manifest.json"}"#)));
    let src = GithubSource::new(&http, token()).unwrap();
    assert!(matches!(rt().block_on(src.latest()), Err(UpdateError::BadResponse(_))));
  }

  #[test]
  fn empty_token_is_unavailable() {
    let http = FakeHttp::new();
    assert!(matches!(GithubSource::new(&http, Token::empty()), Err(UpdateError::Unavailable)));
  }

  #[test]
  fn redirect_to_other_host_drops_authorization() {
    let http = FakeHttp::new();
    let asset = GithubSource::<FakeHttp>::asset_url(13);
    http.route(&asset, redirect("https://objects.example.net/blob?x=1"));
    http.route("https://objects.example.net/blob?x=1", ok(b"data"));
    let f = Fetcher::new(&http, token());
    let body = rt().block_on(f.get_bytes(&asset, "application/octet-stream", 100, Duration::from_secs(5))).unwrap();
    assert_eq!(body, b"data");
    let reqs = http.requests.lock().unwrap();
    assert!(reqs[0].headers.iter().any(|(k, _)| k == "Authorization"));
    assert!(reqs[1].headers.iter().all(|(k, _)| !k.eq_ignore_ascii_case("authorization")));
    assert!(reqs[1].headers.iter().all(|(k, _)| k != "X-GitHub-Api-Version"));
  }

  #[test]
  fn redirect_back_to_api_host_has_no_token() {
    let http = FakeHttp::new();
    let a = GithubSource::<FakeHttp>::asset_url(13);
    let b = GithubSource::<FakeHttp>::asset_url(14);
    http.route(&a, redirect(&b));
    http.route(&b, ok(b"x"));
    let f = Fetcher::new(&http, token());
    rt().block_on(f.get_bytes(&a, "application/octet-stream", 10, Duration::from_secs(5))).unwrap();
    let reqs = http.requests.lock().unwrap();
    assert!(reqs[1].headers.iter().all(|(k, _)| !k.eq_ignore_ascii_case("authorization")));
  }

  #[test]
  fn http_redirect_refused() {
    let http = FakeHttp::new();
    let a = GithubSource::<FakeHttp>::asset_url(13);
    http.route(&a, redirect("http://objects.example.net/blob"));
    let f = Fetcher::new(&http, token());
    let err = rt().block_on(f.open(&a, "x", Duration::from_secs(5))).err().unwrap();
    assert!(matches!(err, UpdateError::InsecureRedirect(_)));
    assert_eq!(http.urls().len(), 1);
  }

  #[test]
  fn redirect_loop_is_bounded() {
    let http = FakeHttp::new();
    let a = GithubSource::<FakeHttp>::asset_url(13);
    http.route(&a, redirect(&a));
    let f = Fetcher::new(&http, token());
    let err = rt().block_on(f.open(&a, "x", Duration::from_secs(5))).err().unwrap();
    assert_eq!(err, UpdateError::TooManyRedirects);
    assert_eq!(http.urls().len(), 6);
  }

  #[test]
  fn body_size_limit() {
    let http = FakeHttp::new();
    let a = GithubSource::<FakeHttp>::asset_url(13);
    let mut r = ok(&[0u8; 50]);
    r.content_length = None;
    http.route(&a, r);
    let f = Fetcher::new(&http, token());
    let err = rt().block_on(f.get_bytes(&a, "x", 10, Duration::from_secs(5))).unwrap_err();
    assert_eq!(err, UpdateError::TooLarge);
  }

  #[test]
  fn status_mapping() {
    let http = FakeHttp::new();
    let a = GithubSource::<FakeHttp>::asset_url(13);
    for (code, want) in [(401, UpdateError::Unauthorized), (404, UpdateError::NotFound), (500, UpdateError::HttpStatus(500))] {
      let http2 = FakeHttp::new();
      http2.route(&a, status(code));
      let f = Fetcher::new(&http2, token());
      assert_eq!(rt().block_on(f.open(&a, "x", Duration::from_secs(5))).err().unwrap(), want);
    }
    drop(http);
  }

  #[test]
  fn debug_never_contains_token() {
    let http = FakeHttp::new();
    http.route(LATEST, status(401));
    let src = GithubSource::new(&http, token()).unwrap();
    let err = rt().block_on(src.latest()).unwrap_err();
    let reqs = http.requests.lock().unwrap();
    let dump = format!("{err:?} {err} {reqs:?} {:?}", token());
    assert!(!dump.contains("secret_TOKEN_value_123"), "{dump}");
  }
}
