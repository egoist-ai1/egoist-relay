use std::{
  collections::{HashMap, HashSet, VecDeque},
  hash::{Hash, Hasher},
  sync::{LazyLock, Mutex},
  time::{Duration, Instant},
};

use serde_json::{Value, json};
#[cfg(not(windows))]
use tauri::webview::PageLoadEvent;
use tauri::{
  AppHandle, LogicalPosition, LogicalSize, Manager, Webview, WebviewBuilder, WebviewUrl,
  WindowBuilder, webview::NewWindowResponse,
};
use url::Url;

const SCRIPT: &str = include_str!("../../runtime/research/social-read.js");
const MAX_FRAME: usize = 262_144;
const MAX_FILE: u64 = 1_073_741_824;
const MAX_MEDIA: u64 = 2_147_483_648;
const MAX_MEDIA_FILES: usize = 500;
const OPERATIONS_X: &[&str] = &[
  "discover",
  "profile",
  "read",
  "search",
  "channel_history",
  "chat_export",
  "download",
  "article",
  "read_thread",
];
const OPERATIONS_IG: &[&str] = &[
  "discover",
  "profile",
  "read",
  "search",
  "channel_history",
  "chat_export",
  "download",
  "read_thread",
];

#[derive(Clone, Copy, PartialEq)]
enum Phase {
  Probe,
  Read,
}

#[derive(Clone)]
struct Media {
  declared: u64,
  received: u64,
  sequence: u64,
}

#[derive(Clone)]
struct PublishContext {
  id: String,
  nonce: String,
  binding: Option<Value>,
}

impl From<&Job> for PublishContext {
  fn from(job: &Job) -> Self {
    Self {
      id: job.id.clone(),
      nonce: job.nonce.clone(),
      binding: job.binding.clone(),
    }
  }
}

#[derive(Clone, Default)]
struct TextPartState {
  next: u64,
  final_part: bool,
  bytes: usize,
  utf16: usize,
  fields: Option<Vec<(usize, usize)>>,
}

#[derive(Clone)]
struct Job {
  id: String,
  nonce: String,
  operation: String,
  input: Value,
  job_id: String,
  expires: Instant,
  targets: Vec<Url>,
  target_index: usize,
  source_key: String,
  phase: Phase,
  probe_only: bool,
  canceled: bool,
  closing: bool,
  expected_account: Option<Value>,
  binding: Option<Value>,
  records: HashSet<String>,
  cursor_anchors: HashSet<String>,
  text_parts: HashMap<String, TextPartState>,
  observed_media: HashSet<String>,
  open_media: HashMap<String, Media>,
  media_bytes: u64,
  media_files: usize,
  limit: usize,
  page_start_count: usize,
  pages_read: usize,
  sources_read: HashSet<usize>,
  partial: bool,
  gaps: HashSet<String>,
  next_cursor: Option<String>,
  cursor: Option<Value>,
}

#[derive(Clone, PartialEq)]
struct DocumentDispatch {
  id: String,
  nonce: String,
  phase: Phase,
  document_epoch: u64,
}

#[derive(Clone)]
struct NavigationOwner {
  id: String,
  nonce: String,
  phase: Phase,
  account_epoch: String,
  target_index: usize,
  page_index: usize,
}

#[derive(Clone)]
struct DocumentGuard {
  generation: u64,
  navigation_id: u64,
  document_epoch: u64,
  request_id: String,
  request_nonce: String,
  phase: Phase,
  account_epoch: String,
  target_index: usize,
  page_index: usize,
  source: Url,
}

struct Provider {
  state: &'static str,
  reason: &'static str,
  identity: Option<String>,
  account_ref: Option<String>,
  epoch: u64,
  salt: String,
  document_epoch: u64,
  view_generation: u64,
  navigation_id: u64,
  document_navigation_id: u64,
  navigation_owner: Option<NavigationOwner>,
  navigation_observers_ready: bool,
  dispatched: Option<DocumentDispatch>,
  active: Option<Job>,
  queue: VecDeque<Job>,
  last_probe: Option<Instant>,
}

impl Provider {
  fn new() -> Self {
    Self {
      state: "initializing",
      reason: "DOM_ACCOUNT_PROOF_PENDING",
      identity: None,
      account_ref: None,
      epoch: 1,
      salt: uuid::Uuid::new_v4().to_string(),
      document_epoch: 0,
      view_generation: 0,
      navigation_id: 0,
      document_navigation_id: 0,
      navigation_owner: None,
      navigation_observers_ready: false,
      dispatched: None,
      active: None,
      queue: VecDeque::new(),
      last_probe: None,
    }
  }
  fn epoch_value(&self) -> String {
    format!("{}:{}", self.salt, self.epoch)
  }
  fn binding(&self) -> Option<Value> {
    self
      .account_ref
      .as_ref()
      .map(|account| json!({"accountRef":account,"accountEpoch":self.epoch_value()}))
  }
}

static PROVIDERS: LazyLock<Mutex<HashMap<&'static str, Provider>>> = LazyLock::new(|| {
  Mutex::new(HashMap::from([
    ("x", Provider::new()),
    ("instagram", Provider::new()),
  ]))
});

fn provider_name(value: &str) -> Result<&'static str, String> {
  match value {
    "x" => Ok("x"),
    "instagram" => Ok("instagram"),
    _ => Err("UNSUPPORTED_PROVIDER".into()),
  }
}

fn label(provider: &str) -> &'static str {
  if provider == "x" {
    "relay-research-x"
  } else {
    "relay-research-instagram"
  }
}

fn window_label(provider: &str) -> &'static str {
  if provider == "x" {
    "relay-research-window-x"
  } else {
    "relay-research-window-instagram"
  }
}

fn home(provider: &str) -> Url {
  Url::parse(if provider == "x" {
    "https://x.com/home"
  } else {
    "https://www.instagram.com/"
  })
  .expect("fixed URL")
}

fn first_party(provider: &str, url: &Url) -> bool {
  url.scheme() == "https"
    && url.port_or_known_default() == Some(443)
    && url.username().is_empty()
    && url.password().is_none()
    && match (provider, url.host_str()) {
      ("x", Some("x.com" | "www.x.com" | "twitter.com" | "www.twitter.com")) => true,
      ("instagram", Some("instagram.com" | "www.instagram.com")) => true,
      _ => false,
    }
}

fn canonical(provider: &str, text: &str) -> Result<Url, String> {
  if text.len() > 2048 || text.chars().any(char::is_control) {
    return Err("INVALID_SOURCE".into());
  }
  let mut url = Url::parse(text).map_err(|_| "INVALID_SOURCE")?;
  if !first_party(provider, &url) {
    return Err("INVALID_SOURCE".into());
  }
  url
    .set_host(Some(if provider == "x" {
      "x.com"
    } else {
      "www.instagram.com"
    }))
    .map_err(|_| "INVALID_SOURCE")?;
  url.set_fragment(None);
  url.set_query(None);
  if provider == "instagram" {
    if let Some(path) = instagram_post_path(url.path()) {
      url.set_path(&path);
    }
  }
  let path = url.path().trim_end_matches('/').to_string();
  url.set_path(if path.is_empty() { "/" } else { &path });
  Ok(url)
}

fn handle_valid(provider: &str, value: &str) -> bool {
  let limit = if provider == "x" { 15 } else { 30 };
  !value.is_empty()
    && value.len() <= limit
    && value
      .chars()
      .all(|c| c.is_ascii_alphanumeric() || c == '_' || provider == "instagram" && c == '.')
    && ![
      "home", "search", "explore", "reels", "accounts", "direct", "messages", "i", "settings",
      "login",
    ]
    .contains(&value)
}

fn channel_url(provider: &str, channel: &str) -> Result<Url, String> {
  if provider == "instagram" && channel.starts_with('#') {
    let tag = &channel[1..];
    if tag.is_empty()
      || tag.chars().count() > 100
      || !tag.chars().all(|c| c.is_alphanumeric() || c == '_')
    {
      return Err("INVALID_SOURCE".into());
    }
    let mut url = home(provider);
    url.set_path(&format!("/explore/tags/{tag}"));
    return Ok(url);
  }
  if channel.starts_with("https://") {
    let url = canonical(provider, channel)?;
    let parts: Vec<_> = url.path().trim_matches('/').split('/').collect();
    if parts.len() == 1 && handle_valid(provider, parts[0])
      || provider == "instagram"
        && parts.len() == 3
        && parts[..2] == ["explore", "tags"]
        && parts[2]
          .chars()
          .all(|c| c.is_alphanumeric() || c == '_' || c == '%')
    {
      return Ok(url);
    }
    return Err("UNSUPPORTED_SOURCE_PATH".into());
  }
  let handle = channel.trim_start_matches('@');
  if !handle_valid(provider, handle) {
    return Err("INVALID_SOURCE".into());
  }
  let mut url = home(provider);
  url.set_path(&format!("/{handle}"));
  Ok(url)
}

fn instagram_post_path(path: &str) -> Option<String> {
  let parts: Vec<_> = path.trim_matches('/').split('/').collect();
  let post = match parts.as_slice() {
    [kind, shortcode] => Some((*kind, *shortcode)),
    [handle, kind, shortcode]
      if handle_valid("instagram", &handle.to_ascii_lowercase())
        && !["p", "reel", "reels"].contains(&handle.to_ascii_lowercase().as_str()) =>
    {
      Some((*kind, *shortcode))
    }
    _ => None,
  }?;
  if !["p", "reel", "reels"].contains(&post.0)
    || post.1.is_empty()
    || post.1.len() > 128
    || !post
      .1
      .bytes()
      .all(|value| value.is_ascii_alphanumeric() || value == b'_' || value == b'-')
  {
    return None;
  }
  Some(format!(
    "/{}/{}",
    if post.0 == "reels" { "reel" } else { post.0 },
    post.1
  ))
}

fn source_url(provider: &str, operation: &str, value: &str) -> Result<Url, String> {
  let url = canonical(provider, value)?;
  let parts: Vec<_> = url.path().trim_matches('/').split('/').collect();
  let digits = |value: &str| {
    !value.is_empty() && value.len() <= 64 && value.bytes().all(|c| c.is_ascii_digit())
  };
  let valid = if operation == "read_thread" {
    if provider == "x" {
      (parts.len() == 2 && parts[0] == "messages"
        || parts.len() == 3 && parts[..2] == ["i", "chat"])
        && parts
          .last()
          .is_some_and(|part| !part.is_empty() && part.len() <= 128 && part.split('-').all(digits))
    } else {
      parts.len() == 3 && parts[..2] == ["direct", "t"] && digits(parts[2])
    }
  } else if provider == "x" {
    let post = parts.len() == 3
      && parts[1] == "status"
      && (parts[0] == "i" || handle_valid(provider, parts[0]))
      && digits(parts[2]);
    let article = parts.len() == 3
      && (["i", "articles"].as_slice() == &parts[..2]
        || ["i", "article"].as_slice() == &parts[..2]
        || handle_valid(provider, parts[0]) && parts[1] == "article")
      && digits(parts[2]);
    post || operation == "article" && article
  } else {
    parts.len() == 2
      && ["p", "reel", "reels"].contains(&parts[0])
      && !parts[1].is_empty()
      && parts[1].len() <= 128
      && parts[1]
        .bytes()
        .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
  };
  if valid {
    Ok(url)
  } else {
    Err("UNSUPPORTED_SOURCE_PATH".into())
  }
}

fn bounded_integer(input: &Value, key: &str, fallback: u64, maximum: u64) -> Result<u64, String> {
  match input.get(key) {
    None => Ok(fallback),
    Some(value) => value
      .as_u64()
      .filter(|v| *v > 0 && *v <= maximum)
      .ok_or_else(|| "INVALID_INPUT".into()),
  }
}

fn targets(provider: &str, operation: &str, input: &Value) -> Result<Vec<Url>, String> {
  if ["profile", "channel_history", "chat_export"].contains(&operation) {
    return Ok(vec![channel_url(
      provider,
      input
        .get("channel")
        .and_then(Value::as_str)
        .ok_or("INVALID_INPUT")?,
    )?]);
  }
  if ["search", "discover"].contains(&operation) {
    let query = input
      .get("query")
      .and_then(Value::as_str)
      .filter(|v| !v.trim().is_empty() && v.len() <= 2048)
      .ok_or("INVALID_INPUT")?;
    let scope = input
      .get("scope")
      .and_then(Value::as_str)
      .unwrap_or(if operation == "discover" {
        "profiles"
      } else {
        "posts"
      });
    if provider == "instagram" {
      return match scope {
        "profiles" => Ok(vec![channel_url(provider, query)?]),
        "tags" => Ok(vec![channel_url(
          provider,
          &format!("#{}", query.trim_start_matches('#')),
        )?]),
        _ => Err("UNSUPPORTED_INSTAGRAM_KEYWORD_SEARCH_USE_PROFILES_OR_TAGS".into()),
      };
    }
    if !["profiles", "posts"].contains(&scope) {
      return Err("UNSUPPORTED_SEARCH_SCOPE".into());
    }
    let mut value = query.to_string();
    if let Some(channel) = input.get("channel").and_then(Value::as_str) {
      let profile = channel_url(provider, channel)?;
      value.push_str(&format!(" from:{}", profile.path().trim_matches('/')));
    }
    let mut url = home(provider);
    url.set_path("/search");
    url
      .query_pairs_mut()
      .append_pair("q", &value)
      .append_pair("f", if scope == "profiles" { "user" } else { "live" });
    return Ok(vec![url]);
  }
  if let Some(value) = input.get("url").and_then(Value::as_str) {
    if input.get("urls").is_some() {
      return Err("INVALID_INPUT".into());
    }
    return Ok(vec![source_url(provider, operation, value)?]);
  }
  let list = input
    .get("urls")
    .and_then(Value::as_array)
    .filter(|v| !v.is_empty() && v.len() <= 1000)
    .ok_or("INVALID_INPUT")?;
  if operation == "read_thread" {
    return Err("EXACT_THREAD_URL_REQUIRED".into());
  }
  list
    .iter()
    .map(|item| source_url(provider, operation, item.as_str().ok_or("INVALID_INPUT")?))
    .collect()
}

fn build_job(
  provider: &str,
  id: &str,
  nonce: &str,
  operation: &str,
  input: Value,
  job_id: &str,
  deadline: u64,
) -> Result<Job, String> {
  if id.is_empty()
    || id.len() > 128
    || nonce.len() < 16
    || nonce.len() > 128
    || job_id.len() > 128
    || deadline == 0
    || deadline > 300000
  {
    return Err("INVALID_INPUT".into());
  }
  let allowed = if provider == "x" {
    OPERATIONS_X
  } else {
    OPERATIONS_IG
  };
  if !allowed.contains(&operation) {
    return Err("UNSUPPORTED_OPERATION".into());
  }
  let object = input.as_object().ok_or("INVALID_INPUT")?;
  let keys = [
    "query",
    "channel",
    "scope",
    "url",
    "urls",
    "limit",
    "pageSize",
    "deadlineMs",
    "cursor",
    "includeMedia",
    "includeReplies",
    "exportFormats",
    "after",
    "before",
    "expectedAccount",
  ];
  if object.keys().any(|key| !keys.contains(&key.as_str())) {
    return Err("INVALID_INPUT".into());
  }
  let limit = bounded_integer(&input, "limit", 100, 1000)? as usize;
  bounded_integer(&input, "pageSize", 50, 100)?;
  bounded_integer(&input, "deadlineMs", deadline, 300000)?;
  for field in ["includeMedia", "includeReplies"] {
    if input.get(field).is_some_and(|v| !v.is_boolean()) {
      return Err("INVALID_INPUT".into());
    }
  }
  for field in ["after", "before"] {
    if input
      .get(field)
      .is_some_and(|v| v.as_u64().is_none_or(|time| time > 253402300799))
    {
      return Err("INVALID_INPUT".into());
    }
  }
  let targets = targets(provider, operation, &input)?;
  let mut key = input.clone();
  if let Some(object) = key.as_object_mut() {
    for field in [
      "limit",
      "pageSize",
      "deadlineMs",
      "cursor",
      "expectedAccount",
      "exportFormats",
      "includeMedia",
    ] {
      object.remove(field);
    }
  }
  let mut hasher = std::collections::hash_map::DefaultHasher::new();
  provider.hash(&mut hasher);
  operation.hash(&mut hasher);
  key.to_string().hash(&mut hasher);
  let source_key = format!("{:016x}", hasher.finish());
  let cursor = input
    .get("cursor")
    .map(|value| {
      let value = value
        .as_str()
        .filter(|v| v.len() <= 4096)
        .ok_or("INVALID_CURSOR")?;
      let cursor: Value = serde_json::from_str(value).map_err(|_| "INVALID_CURSOR")?;
      let object = cursor.as_object().ok_or("INVALID_CURSOR")?;
      if object.keys().any(|key| {
        ![
          "schemaVersion",
          "provider",
          "operation",
          "sourceKey",
          "accountEpoch",
          "targetIndex",
          "anchor",
          "offset",
        ]
        .contains(&key.as_str())
      }) || cursor
        .get("targetIndex")
        .is_some_and(|v| v.as_u64().is_none())
        || cursor
          .get("offset")
          .is_some_and(|v| v.as_u64().is_none_or(|v| v > 1000000))
        || cursor
          .get("accountEpoch")
          .and_then(Value::as_str)
          .is_none_or(|v| v.is_empty() || v.len() > 128)
      {
        return Err("INVALID_CURSOR");
      }
      if cursor.get("schemaVersion").and_then(Value::as_u64) != Some(1)
        || cursor.get("provider").and_then(Value::as_str) != Some(provider)
        || cursor.get("operation").and_then(Value::as_str) != Some(operation)
        || cursor.get("sourceKey").and_then(Value::as_str) != Some(source_key.as_str())
        || cursor
          .get("anchor")
          .is_some_and(|value| value.as_str().is_none_or(|v| v.len() > 2048))
      {
        return Err("CURSOR_SOURCE_MISMATCH");
      }
      Ok(cursor)
    })
    .transpose()
    .map_err(str::to_string)?;
  let target_index = cursor
    .as_ref()
    .and_then(|v| v.get("targetIndex"))
    .and_then(Value::as_u64)
    .unwrap_or(0) as usize;
  if target_index >= targets.len() {
    return Err("CURSOR_SOURCE_MISMATCH".into());
  }
  let expected_account = input.get("expectedAccount").cloned();
  if let Some(value) = &expected_account {
    if value.as_object().is_none_or(|map| map.len() != 2)
      || value
        .get("accountRef")
        .and_then(Value::as_str)
        .is_none_or(|v| v.is_empty() || v.len() > 128)
      || value
        .get("accountEpoch")
        .and_then(Value::as_str)
        .is_none_or(|v| v.is_empty() || v.len() > 128)
    {
      return Err("INVALID_ACCOUNT_BINDING".into());
    }
  }
  Ok(Job {
    id: id.into(),
    nonce: nonce.into(),
    operation: operation.into(),
    input,
    job_id: job_id.into(),
    expires: Instant::now() + Duration::from_millis(deadline),
    targets,
    target_index,
    source_key,
    phase: Phase::Probe,
    probe_only: false,
    canceled: false,
    closing: false,
    expected_account,
    binding: None,
    records: HashSet::new(),
    cursor_anchors: HashSet::new(),
    text_parts: HashMap::new(),
    observed_media: HashSet::new(),
    open_media: HashMap::new(),
    media_bytes: 0,
    media_files: 0,
    limit,
    page_start_count: 0,
    pages_read: 0,
    sources_read: HashSet::new(),
    partial: false,
    gaps: HashSet::new(),
    next_cursor: None,
    cursor,
  })
}

fn same_source(provider: &str, expected: &Url, actual: &Url) -> bool {
  if !first_party(provider, actual) {
    return false;
  }
  let normalized = canonical(provider, actual.as_str());
  let normalized_expected = canonical(provider, expected.as_str());
  let Ok(normalized_expected) = normalized_expected else {
    return false;
  };
  let expected_path = normalized_expected.path().trim_end_matches('/');
  let actual_path = normalized
    .as_ref()
    .map(|url| url.path().trim_end_matches('/'));
  if provider == "x"
    && ["/home", ""].contains(&expected_path)
    && actual_path.is_ok_and(|p| p == "/home" || p.is_empty())
  {
    return true;
  }
  if let Ok(path) = actual_path {
    let expected_parts: Vec<_> = expected_path.trim_matches('/').split('/').collect();
    let actual_parts: Vec<_> = path.trim_matches('/').split('/').collect();
    if provider == "x"
      && expected_parts.len() == 3
      && actual_parts.len() == 3
      && expected_parts[1] == "status"
      && actual_parts[1] == "status"
      && expected_parts[2] == actual_parts[2]
    {
      return true;
    }
    if provider == "instagram"
      && expected_parts.len() == 2
      && actual_parts.len() == 2
      && ["reel", "reels"].contains(&expected_parts[0])
      && ["reel", "reels"].contains(&actual_parts[0])
      && expected_parts[1] == actual_parts[1]
    {
      return true;
    }
  }
  if actual_path != Ok(expected_path) {
    return false;
  }
  if expected_path == "/search" {
    let get = |url: &Url, key: &str| {
      url
        .query_pairs()
        .find(|(name, _)| name == key)
        .map(|(_, value)| value.into_owned())
    };
    return get(expected, "q") == get(actual, "q") && get(expected, "f") == get(actual, "f");
  }
  true
}

fn valid_no_progress_cursor(
  provider: &str,
  operation: &str,
  source_key: &str,
  account_epoch: &str,
  target_index: usize,
  original: Option<&Value>,
  event: &Value,
) -> bool {
  let Some(original) = original else {
    return false;
  };
  let Some(anchor) = original
    .get("anchor")
    .and_then(Value::as_str)
    .filter(|anchor| !anchor.is_empty() && anchor.len() <= 2048)
  else {
    return false;
  };
  let Some(offset) = original
    .get("offset")
    .and_then(Value::as_u64)
    .filter(|offset| *offset <= 1_000_000)
  else {
    return false;
  };
  let next = event
    .get("nextCursor")
    .and_then(Value::as_str)
    .filter(|cursor| cursor.len() <= 4096)
    .and_then(|cursor| serde_json::from_str::<Value>(cursor).ok());
  next.as_ref() == Some(original)
    && original.get("schemaVersion").and_then(Value::as_u64) == Some(1)
    && original.get("provider").and_then(Value::as_str) == Some(provider)
    && original.get("operation").and_then(Value::as_str) == Some(operation)
    && original.get("sourceKey").and_then(Value::as_str) == Some(source_key)
    && original.get("accountEpoch").and_then(Value::as_str) == Some(account_epoch)
    && original.get("targetIndex").and_then(Value::as_u64) == Some(target_index as u64)
    && original.get("offset").and_then(Value::as_u64) == Some(offset)
    && event.get("accessible").and_then(Value::as_bool) == Some(true)
    && event.get("count").and_then(Value::as_u64) == Some(0)
    && event.get("partial").and_then(Value::as_bool) == Some(true)
    && event.get("emptyProof").and_then(Value::as_bool) == Some(false)
    && event
      .get("resumeProof")
      .and_then(|proof| proof.get("anchor"))
      .and_then(Value::as_str)
      == Some(anchor)
    && event
      .get("resumeProof")
      .and_then(|proof| proof.get("anchorReached"))
      .and_then(Value::as_bool)
      == Some(true)
    && event
      .get("resumeProof")
      .and_then(|proof| proof.get("recordsObserved"))
      .and_then(Value::as_u64)
      .is_some_and(|count| count > 0 && count <= 20_000)
    && event
      .get("coverage")
      .and_then(|coverage| coverage.get("completeness"))
      .and_then(Value::as_str)
      == Some("partial")
    && event
      .get("coverage")
      .and_then(|coverage| coverage.get("unresolved"))
      .and_then(Value::as_array)
      .is_some_and(|gaps| {
        gaps
          .iter()
          .any(|gap| gap.as_str() == Some("cursor_no_progress"))
      })
}

fn allowed_navigation(provider: &str, url: &Url) -> bool {
  if url.as_str() == "about:blank" {
    return true;
  }
  if !first_party(provider, url) {
    return false;
  }
  if [
    "/i/flow/login",
    "/accounts/login",
    "/challenge",
    "/checkpoint",
  ]
  .iter()
  .any(|path| url.path().starts_with(path))
  {
    return true;
  }
  PROVIDERS
    .lock()
    .ok()
    .and_then(|states| {
      states
        .get(provider)
        .and_then(|state| state.active.as_ref())
        .map(|job| {
          let expected = if job.phase == Phase::Probe {
            home(provider)
          } else {
            job.targets[job.target_index].clone()
          };
          same_source(provider, &expected, url)
        })
    })
    .unwrap_or(false)
}

fn start_navigation(
  state: &mut Provider,
  generation: u64,
  navigation_id: u64,
  canceled: bool,
  redirected: bool,
) -> bool {
  if state.view_generation != generation
    || navigation_id == 0
    || canceled
    || redirected && state.navigation_id != navigation_id
  {
    return false;
  }
  // Redirects share NavigationId; they must not invalidate the same document twice.
  if state.navigation_id != navigation_id {
    state.navigation_id = navigation_id;
    state.navigation_owner = state
      .active
      .as_ref()
      .filter(|job| !job.canceled && !job.closing && Instant::now() < job.expires)
      .map(|job| NavigationOwner {
        id: job.id.clone(),
        nonce: job.nonce.clone(),
        phase: job.phase,
        account_epoch: state.epoch_value(),
        target_index: job.target_index,
        page_index: job.pages_read,
      });
    state.document_navigation_id = 0;
    state.dispatched = None;
  }
  true
}

fn load_document(state: &mut Provider, generation: u64, navigation_id: u64) -> bool {
  if state.view_generation != generation
    || navigation_id == 0
    || state.navigation_id != navigation_id
  {
    return false;
  }
  if state.document_navigation_id != navigation_id {
    state.document_epoch = state.document_epoch.wrapping_add(1);
    state.document_navigation_id = navigation_id;
    state.dispatched = None;
  }
  true
}

fn navigation_job(state: &Provider, generation: u64, navigation_id: u64) -> Option<&Job> {
  if state.view_generation != generation
    || navigation_id == 0
    || state.navigation_id != navigation_id
  {
    return None;
  }
  let owner = state.navigation_owner.as_ref()?;
  let job = state.active.as_ref()?;
  (job.id == owner.id
    && job.nonce == owner.nonce
    && job.phase == owner.phase
    && job.target_index == owner.target_index
    && job.pages_read == owner.page_index
    && state.epoch_value() == owner.account_epoch
    && !job.canceled
    && !job.closing
    && Instant::now() < job.expires)
    .then_some(job)
}

fn document_guard(
  state: &Provider,
  generation: u64,
  navigation_id: u64,
  source: Url,
) -> Option<DocumentGuard> {
  if state.view_generation != generation
    || navigation_id == 0
    || state.navigation_id != navigation_id
    || state.document_navigation_id != navigation_id
  {
    return None;
  }
  let job = navigation_job(state, generation, navigation_id)?;
  Some(DocumentGuard {
    generation,
    navigation_id,
    document_epoch: state.document_epoch,
    request_id: job.id.clone(),
    request_nonce: job.nonce.clone(),
    phase: job.phase,
    account_epoch: state.epoch_value(),
    target_index: job.target_index,
    page_index: job.pages_read,
    source,
  })
}

#[cfg(windows)]
fn install_document_observers(
  view: &Webview,
  provider: &'static str,
  generation: u64,
) -> Result<(), String> {
  use webview2_com::{
    ContentLoadingEventHandler, DOMContentLoadedEventHandler,
    Microsoft::Web::WebView2::Win32::{
      COREWEBVIEW2_WEB_ERROR_STATUS_OPERATION_CANCELED, ICoreWebView2_2,
    },
    NavigationCompletedEventHandler, NavigationStartingEventHandler,
  };
  use windows_core::Interface;
  let (acknowledge, registered) = std::sync::mpsc::sync_channel(1);
  let app = view.app_handle().clone();
  view
    .with_webview(move |platform| {
      let install = || -> windows_core::Result<()> {
        unsafe {
          let core = platform.controller().CoreWebView2()?;
          let mut registration = 0;
          core.add_NavigationStarting(
            &NavigationStartingEventHandler::create(Box::new(move |_, args| {
              let Some(args) = args else {
                return Ok(());
              };
              let mut canceled = false.into();
              args.Cancel(&mut canceled)?;
              let mut redirected = false.into();
              args.IsRedirected(&mut redirected)?;
              let mut navigation_id = 0;
              args.NavigationId(&mut navigation_id)?;
              if let Ok(mut states) = PROVIDERS.lock() {
                if let Some(state) = states.get_mut(provider) {
                  start_navigation(
                    state,
                    generation,
                    navigation_id,
                    canceled.as_bool(),
                    redirected.as_bool(),
                  );
                }
              }
              Ok(())
            })),
            &mut registration,
          )?;
          core.add_ContentLoading(
            &ContentLoadingEventHandler::create(Box::new(move |_, args| {
              let Some(args) = args else {
                return Ok(());
              };
              let mut navigation_id = 0;
              args.NavigationId(&mut navigation_id)?;
              if let Ok(mut states) = PROVIDERS.lock() {
                if let Some(state) = states.get_mut(provider) {
                  load_document(state, generation, navigation_id);
                }
              }
              Ok(())
            })),
            &mut registration,
          )?;
          let dom_app = app.clone();
          core.cast::<ICoreWebView2_2>()?.add_DOMContentLoaded(
            &DOMContentLoadedEventHandler::create(Box::new(move |sender, args| {
              let (Some(sender), Some(args)) = (sender, args) else {
                return Ok(());
              };
              let mut navigation_id = 0;
              args.NavigationId(&mut navigation_id)?;
              let mut source = windows_core::PWSTR::null();
              sender.Source(&mut source)?;
              if let Ok(source) = Url::parse(&webview2_com::take_pwstr(source)) {
                let guard = PROVIDERS.lock().ok().and_then(|states| {
                  document_guard(states.get(provider)?, generation, navigation_id, source)
                });
                if let (Some(guard), Some(view)) = (guard, dom_app.get_webview(label(provider))) {
                  // Only proof begins here. Collection retains the finished-document gate.
                  begin_document(&view, provider, &guard, true);
                }
              }
              Ok(())
            })),
            &mut registration,
          )?;
          core.add_NavigationCompleted(
            &NavigationCompletedEventHandler::create(Box::new(move |sender, args| {
              let (Some(sender), Some(args)) = (sender, args) else {
                return Ok(());
              };
              let mut navigation_id = 0;
              args.NavigationId(&mut navigation_id)?;
              let current = PROVIDERS.lock().ok().is_some_and(|states| {
                states.get(provider).is_some_and(|state| {
                  state.view_generation == generation
                    && navigation_id != 0
                    && state.navigation_id == navigation_id
                })
              });
              if !current {
                return Ok(());
              }
              let mut success = false.into();
              args.IsSuccess(&mut success)?;
              if !success.as_bool() {
                let mut error_status = Default::default();
                args.WebErrorStatus(&mut error_status)?;
                if error_status != COREWEBVIEW2_WEB_ERROR_STATUS_OPERATION_CANCELED {
                  let owned = PROVIDERS.lock().ok().and_then(|states| {
                    let state = states.get(provider)?;
                    navigation_job(state, generation, navigation_id)
                      .map(|job| (job.id.clone(), job.nonce.clone()))
                  });
                  if let Some((id, nonce)) = owned {
                    finish_error(&app, provider, &id, &nonce, "RESEARCH_NAVIGATION_FAILED");
                  }
                }
                return Ok(());
              }
              let mut source = windows_core::PWSTR::null();
              sender.Source(&mut source)?;
              if let Ok(source) = Url::parse(&webview2_com::take_pwstr(source)) {
                let guard = PROVIDERS.lock().ok().and_then(|states| {
                  document_guard(states.get(provider)?, generation, navigation_id, source)
                });
                if let (Some(guard), Some(view)) = (guard, app.get_webview(label(provider))) {
                  begin_document(&view, provider, &guard, false);
                }
              }
              Ok(())
            })),
            &mut registration,
          )?;
          Ok(())
        }
      };
      let installed = install().map_err(|_| "RESEARCH_DISPATCH_UNAVAILABLE".to_string());
      if installed.is_ok() {
        if let Ok(mut states) = PROVIDERS.lock() {
          if let Some(state) = states
            .get_mut(provider)
            .filter(|state| state.view_generation == generation)
          {
            state.navigation_observers_ready = true;
          }
        }
      }
      let _ = acknowledge.send(installed);
    })
    .map_err(|_| "RESEARCH_DISPATCH_UNAVAILABLE")?;
  // This runs on the existing bounded navigation worker, never on the main loop.
  registered
    .recv_timeout(Duration::from_secs(2))
    .map_err(|_| "RESEARCH_DISPATCH_UNAVAILABLE".to_string())?
}

fn ensure_view(app: &AppHandle, provider: &'static str, target: &Url) -> Result<bool, String> {
  if app.get_webview(label(provider)).is_some() {
    return Ok(false);
  }
  let window = if let Some(window) = app.get_window(window_label(provider)) {
    window
  } else {
    WindowBuilder::new(app, window_label(provider))
      .title("Relay research")
      .visible(false)
      .focused(false)
      .skip_taskbar(true)
      .decorations(false)
      .inner_size(1280.0, 900.0)
      .build()
      .map_err(|_| "RESEARCH_WINDOW_UNAVAILABLE")?
  };
  let data = crate::multi_app::get_service_data_directory(app, provider)
    .map_err(|_| "SERVICE_ENVIRONMENT_UNAVAILABLE")?;
  if !data.is_dir() {
    return Err("EXISTING_SERVICE_ENVIRONMENT_REQUIRED".into());
  }
  let generation = {
    let mut states = PROVIDERS
      .lock()
      .map_err(|_| "RESEARCH_DISPATCH_UNAVAILABLE")?;
    let state = states.get_mut(provider).ok_or("UNSUPPORTED_PROVIDER")?;
    state.view_generation = state.view_generation.wrapping_add(1);
    state.navigation_id = 0;
    state.document_navigation_id = 0;
    state.navigation_owner = None;
    state.navigation_observers_ready = false;
    state.dispatched = None;
    state.view_generation
  };
  #[cfg(windows)]
  let _ = target;
  #[cfg(windows)]
  let initial = Url::parse("about:blank").map_err(|_| "RESEARCH_NAVIGATION_FAILED")?;
  #[cfg(not(windows))]
  let initial = target.clone();
  let builder = WebviewBuilder::new(label(provider), WebviewUrl::External(initial))
    .focused(false)
    .data_directory(data)
    .disable_drag_drop_handler()
    .initialization_script(SCRIPT);
  let builder = crate::multi_app::apply_service_network_profile(builder, provider)
    .on_navigation(move |url| allowed_navigation(provider, url))
    .on_new_window(|_, _| NewWindowResponse::Deny)
    .on_download(|_, _| false)
    .on_page_load(move |view, payload| {
      // Windows dispatch uses SDK callbacks with NavigationId, not a Tauri
      // Finished callback that could belong to an older same-URL document.
      #[cfg(windows)]
      let _ = (view, payload, generation);
      #[cfg(not(windows))]
      {
        let guard = view.url().ok().and_then(|source| {
          let mut states = PROVIDERS.lock().ok()?;
          let state = states.get_mut(provider)?;
          if state.view_generation != generation {
            return None;
          }
          if payload.event() == PageLoadEvent::Started {
            let next = state.navigation_id.wrapping_add(1).max(1);
            start_navigation(state, generation, next, false, false);
            load_document(state, generation, next);
          }
          document_guard(state, generation, state.navigation_id, source)
        });
        if let Some(guard) = guard {
          begin_document(
            &view,
            provider,
            &guard,
            payload.event() == PageLoadEvent::Started,
          );
        }
      }
    });
  let view = window
    .add_child(
      builder,
      LogicalPosition::new(0.0, 0.0),
      LogicalSize::new(1280.0, 900.0),
    )
    .map_err(|_| "SERVICE_ENVIRONMENT_SHARING_UNAVAILABLE")?;
  view.hide().map_err(|_| "RESEARCH_VIEW_HIDE_FAILED")?;
  #[cfg(windows)]
  install_document_observers(&view, provider, generation)?;
  Ok(true)
}

fn prepare_document_envelope(
  state: &mut Provider,
  provider: &'static str,
  actual: &Url,
  guard: &DocumentGuard,
  probe_only: bool,
) -> Option<Value> {
  if state.view_generation != guard.generation
    || state.navigation_id != guard.navigation_id
    || state.document_navigation_id != guard.navigation_id
    || state.document_epoch != guard.document_epoch
    || actual != &guard.source
    || !first_party(provider, actual)
  {
    return None;
  }
  let job = state.active.as_ref()?;
  if job.id != guard.request_id
    || job.nonce != guard.request_nonce
    || job.phase != guard.phase
    || state.epoch_value() != guard.account_epoch
    || job.target_index != guard.target_index
    || job.pages_read != guard.page_index
    || navigation_job(state, guard.generation, guard.navigation_id).is_none()
    || job.canceled
    || job.closing
    || Instant::now() >= job.expires
    || probe_only && job.phase != Phase::Probe
  {
    return None;
  }
  let expected = if job.phase == Phase::Probe {
    home(provider)
  } else {
    job.targets[job.target_index].clone()
  };
  if !same_source(provider, &expected, actual)
    && ![
      "/i/flow/login",
      "/accounts/login",
      "/challenge",
      "/checkpoint",
    ]
    .iter()
    .any(|path| actual.path().starts_with(path))
  {
    return None;
  }
  let dispatch = DocumentDispatch {
    id: job.id.clone(),
    nonce: job.nonce.clone(),
    phase: job.phase,
    document_epoch: state.document_epoch,
  };
  if state.dispatched.as_ref() == Some(&dispatch) {
    return None;
  }
  let mut input = job.input.clone();
  if let Some(map) = input.as_object_mut() {
    map.remove("expectedAccount");
  }
  let envelope = json!({"requestId":job.id,"nonce":job.nonce,"jobId":job.job_id,"provider":provider,
    "operation":job.operation,"phase":if job.phase == Phase::Probe {"probe"} else {"read"},
    "input":input,"target":expected.as_str(),"scope":job.input.get("scope").and_then(Value::as_str).unwrap_or(if job.operation == "discover" {"profiles"} else {"posts"}),"sourceKey":job.source_key,
    "accountEpoch":state.epoch_value(),"targetIndex":job.target_index,"pageIndex":job.pages_read,"documentEpoch":state.document_epoch,
    "limit":job.limit.saturating_sub(job.records.len()).max(1),"mediaFilesRemaining":MAX_MEDIA_FILES.saturating_sub(job.media_files),
    "deadlineMs":job.expires.saturating_duration_since(Instant::now()).as_millis().min(300000) as u64});
  state.dispatched = Some(dispatch);
  Some(envelope)
}

fn begin_document(view: &Webview, provider: &'static str, guard: &DocumentGuard, probe_only: bool) {
  let Ok(actual) = view.url() else {
    return;
  };
  let envelope = PROVIDERS.lock().ok().and_then(|mut states| {
    prepare_document_envelope(
      states.get_mut(provider)?,
      provider,
      &actual,
      guard,
      probe_only,
    )
  });
  let Some(envelope) = envelope else {
    return;
  };
  let expression = format!("window.__egoistSocialResearch?.start({envelope});");
  if view.eval(&expression).is_err() {
    if let (Some(id), Some(nonce)) = (envelope["requestId"].as_str(), envelope["nonce"].as_str()) {
      finish_error(
        view.app_handle(),
        provider,
        id,
        nonce,
        "RESEARCH_SCRIPT_UNAVAILABLE",
      );
    }
  }
}

fn can_navigate_active(provider: &str, id: &str, nonce: &str, target: &Url) -> bool {
  PROVIDERS
    .lock()
    .ok()
    .and_then(|states| {
      states
        .get(provider)
        .and_then(|state| state.active.as_ref())
        .map(|job| {
          job.id == id
            && job.nonce == nonce
            && !job.canceled
            && !job.closing
            && Instant::now() < job.expires
            && if job.phase == Phase::Probe {
              target == &home(provider)
            } else {
              target == &job.targets[job.target_index]
            }
        })
    })
    .unwrap_or(false)
}

fn navigate_active(app: &AppHandle, provider: &'static str) {
  let navigation = PROVIDERS.lock().ok().and_then(|states| {
    states
      .get(provider)
      .and_then(|state| state.active.as_ref())
      .filter(|job| !job.canceled && !job.closing && Instant::now() < job.expires)
      .map(|job| {
        let target = if job.phase == Phase::Probe {
          home(provider)
        } else {
          job.targets[job.target_index].clone()
        };
        (job.id.clone(), job.nonce.clone(), target)
      })
  });
  let Some((id, nonce, target)) = navigation else {
    return;
  };
  let fallback_id = id.clone();
  let fallback_nonce = nonce.clone();
  let cloned = app.clone();
  // WebView2 creation needs the main event loop to remain available
  if std::thread::Builder::new()
    .name(format!("relay-research-navigate-{provider}"))
    .spawn(move || {
      if !can_navigate_active(provider, &id, &nonce, &target) {
        return;
      }
      let created = match ensure_view(&cloned, provider, &target) {
        Ok(created) => created,
        Err(code) => {
          finish_error(&cloned, provider, &id, &nonce, &code);
          return;
        }
      };
      if !can_navigate_active(provider, &id, &nonce, &target) {
        return;
      }
      #[cfg(not(windows))]
      if created {
        return;
      }
      #[cfg(windows)]
      let _ = created;
      if let Some(view) = cloned.get_webview(label(provider)) {
        #[cfg(windows)]
        {
          let state = PROVIDERS.lock().ok().and_then(|states| {
            states
              .get(provider)
              .map(|state| (state.view_generation, state.navigation_observers_ready))
          });
          let Some((generation, ready)) = state else {
            return;
          };
          if !ready {
            if let Err(code) = install_document_observers(&view, provider, generation) {
              finish_error(&cloned, provider, &id, &nonce, &code);
              return;
            }
          }
          if !can_navigate_active(provider, &id, &nonce, &target) {
            return;
          }
        }
        if view.navigate(target).is_err() {
          finish_error(&cloned, provider, &id, &nonce, "RESEARCH_NAVIGATION_FAILED");
        }
      }
    })
    .is_err()
  {
    finish_error(
      app,
      provider,
      &fallback_id,
      &fallback_nonce,
      "RESEARCH_DISPATCH_UNAVAILABLE",
    );
  }
}

fn pump(app: &AppHandle, provider: &'static str) {
  let (active_id, active_nonce) = {
    let Ok(mut states) = PROVIDERS.lock() else {
      return;
    };
    let Some(state) = states.get_mut(provider) else {
      return;
    };
    if state.active.is_some() {
      return;
    }
    let Some(job) = state.queue.pop_front() else {
      return;
    };
    let owner = (job.id.clone(), job.nonce.clone());
    state.active = Some(job);
    owner
  };
  navigate_active(app, provider);
  let app = app.clone();
  std::thread::spawn(move || {
    loop {
      let deadline = PROVIDERS.lock().ok().and_then(|states| {
        states
          .get(provider)
          .and_then(|state| state.active.as_ref())
          .filter(|job| job.id == active_id && job.nonce == active_nonce)
          .map(|job| job.expires)
      });
      let Some(deadline) = deadline else {
        return;
      };
      if Instant::now() >= deadline {
        close_owned(&app, provider, &active_id, &active_nonce, "DEADLINE");
        return;
      }
      std::thread::sleep(Duration::from_millis(100));
    }
  });
}

fn publish_bound(job: &PublishContext, event: &mut Value) -> Result<(), String> {
  let map = event.as_object_mut().ok_or("INVALID_EVENT")?;
  map.remove("pageUrl");
  map.remove("documentEpoch");
  map.remove("identityProof");
  map.remove("identity");
  if let Some(binding) = &job.binding {
    map.insert("accountRef".into(), binding["accountRef"].clone());
    map.insert("accountEpoch".into(), binding["accountEpoch"].clone());
  }
  crate::research_bridge::publish(&job.id, &job.nonce, event.clone())
}

fn page_error(value: &Value) -> &'static str {
  match value.get("code").and_then(Value::as_str) {
    Some("CANCELLED") => "CANCELLED",
    Some("DEADLINE") => "DEADLINE",
    Some("STALE_ACCOUNT") => "STALE_ACCOUNT",
    Some("SOURCE_CHANGED") => "SOURCE_CHANGED",
    Some("FRAME_TOO_LARGE") => "FRAME_TOO_LARGE",
    Some("REPLY_TRANSPORT_UNAVAILABLE") => "REPLY_TRANSPORT_UNAVAILABLE",
    Some("DOM_SOURCE_UNAVAILABLE") => "DOM_SOURCE_UNAVAILABLE",
    Some("DOM_SOURCE_UNSUPPORTED") => "DOM_SOURCE_UNSUPPORTED",
    Some("RATE_LIMITED") => "RATE_LIMITED",
    Some("ACCESS_DENIED") => "ACCESS_DENIED",
    Some("SOURCE_UNAVAILABLE") => "SOURCE_UNAVAILABLE",
    Some("THREAD_DOM_UNSUPPORTED") => "THREAD_DOM_UNSUPPORTED",
    Some("ARTICLE_DOM_UNSUPPORTED") => "ARTICLE_DOM_UNSUPPORTED",
    Some("MEDIA_SIZE_CHANGED") => "MEDIA_SIZE_CHANGED",
    Some("TIMESTAMP_FILTER_UNSUPPORTED") => "TIMESTAMP_FILTER_UNSUPPORTED",
    Some("CURSOR_ANCHOR_NOT_FOUND") => "CURSOR_ANCHOR_NOT_FOUND",
    Some("TEXT_LIMIT") => "TEXT_LIMIT",
    _ => "EXTRACTION_FAILED",
  }
}

fn coverage_scope(operation: &str) -> &'static str {
  match operation {
    "discover" | "search" => "platform_search",
    "profile" => "profile",
    "read_thread" => "thread",
    "article" => "article",
    "channel_history" | "chat_export" => "channel",
    _ => "post",
  }
}

fn owns_active(provider: &str, id: &str, nonce: &str) -> bool {
  PROVIDERS
    .lock()
    .ok()
    .and_then(|states| {
      states
        .get(provider)
        .and_then(|state| state.active.as_ref())
        .map(|job| job.id == id && job.nonce == nonce)
    })
    .unwrap_or(false)
}

fn probe_failure_reason(code: &str) -> &'static str {
  match code {
    "DEADLINE" | "DEADLINE_EXCEEDED" => "DOM_ACCOUNT_PROBE_TIMEOUT",
    "RESEARCH_WINDOW_UNAVAILABLE" => "RESEARCH_WINDOW_UNAVAILABLE",
    "SERVICE_ENVIRONMENT_UNAVAILABLE" => "SERVICE_ENVIRONMENT_UNAVAILABLE",
    "EXISTING_SERVICE_ENVIRONMENT_REQUIRED" => "EXISTING_SERVICE_ENVIRONMENT_REQUIRED",
    "SERVICE_ENVIRONMENT_SHARING_UNAVAILABLE" => "SERVICE_ENVIRONMENT_SHARING_UNAVAILABLE",
    "RESEARCH_VIEW_HIDE_FAILED" => "RESEARCH_VIEW_HIDE_FAILED",
    "RESEARCH_NAVIGATION_FAILED" => "RESEARCH_NAVIGATION_FAILED",
    "RESEARCH_SCRIPT_UNAVAILABLE" => "RESEARCH_SCRIPT_UNAVAILABLE",
    "RESEARCH_DISPATCH_UNAVAILABLE" => "RESEARCH_DISPATCH_UNAVAILABLE",
    "REPLY_TRANSPORT_UNAVAILABLE" => "REPLY_TRANSPORT_UNAVAILABLE",
    _ => "DOM_ACCOUNT_PROBE_FAILED",
  }
}

fn finish_error(app: &AppHandle, provider: &'static str, id: &str, nonce: &str, code: &str) {
  let job = PROVIDERS.lock().ok().and_then(|mut states| {
    let state = states.get_mut(provider)?;
    if state
      .active
      .as_ref()
      .is_none_or(|job| job.id != id || job.nonce != nonce)
    {
      return None;
    }
    if code == "STALE_ACCOUNT" {
      state.epoch = state.epoch.wrapping_add(1);
      state.identity = None;
      state.account_ref = None;
      state.last_probe = None;
      state.state = "initializing";
      state.reason = "DOM_ACCOUNT_PROOF_PENDING";
    }
    state.active.take()
  });
  if let Some(job) = job {
    if job.probe_only {
      if let Ok(mut states) = PROVIDERS.lock() {
        if let Some(state) = states.get_mut(provider) {
          if state.state == "initializing" {
            state.state = "unavailable";
            state.reason = probe_failure_reason(code);
            log::warn!(
              "[EgoistRelay] Research probe unavailable: {provider} {}",
              state.reason
            );
          }
          state.last_probe = Some(Instant::now());
        }
      }
    }
    if !job.probe_only {
      let stable = if code.len() <= 80 && code.bytes().all(|c| c.is_ascii_uppercase() || c == b'_')
      {
        code
      } else {
        "RESEARCH_FAILED"
      };
      let _ = publish_bound(
        &PublishContext::from(&job),
        &mut json!({"kind":"error","code":stable,"reason":stable}),
      );
    }
    pump(app, provider);
  }
}

fn close_owned(app: &AppHandle, provider: &'static str, id: &str, nonce: &str, code: &str) {
  let acquired = PROVIDERS
    .lock()
    .ok()
    .and_then(|mut states| {
      let job = states.get_mut(provider)?.active.as_mut()?;
      if job.id != id || job.nonce != nonce || job.closing {
        return None;
      }
      job.closing = true;
      job.canceled = true;
      Some(())
    })
    .is_some();
  if !acquired {
    return;
  }
  let id = id.to_string();
  let nonce = nonce.to_string();
  let code = code.to_string();
  let fallback_id = id.clone();
  let fallback_nonce = nonce.clone();
  let app_clone = app.clone();
  let scheduled = app.run_on_main_thread(move || {
    if !owns_active(provider, &id, &nonce) {
      return;
    }
    let close_requested = app_clone
      .get_webview(label(provider))
      .is_none_or(|view| view.close().is_ok());
    if !close_requested {
      if let Ok(mut states) = PROVIDERS.lock() {
        if let Some(state) = states.get_mut(provider).filter(|state| {
          state
            .active
            .as_ref()
            .is_some_and(|job| job.id == id && job.nonce == nonce)
        }) {
          state.state = "unavailable";
          state.reason = "RESEARCH_CANCEL_SETTLEMENT_UNCONFIRMED";
        }
      }
    }
    std::thread::spawn(move || {
      loop {
        let owned = PROVIDERS
          .lock()
          .ok()
          .and_then(|states| {
            states
              .get(provider)?
              .active
              .as_ref()
              .filter(|job| job.id == id && job.nonce == nonce)
              .map(|_| ())
          })
          .is_some();
        if !owned {
          return;
        }
        if app_clone.get_webview(label(provider)).is_none() {
          if let Ok(mut states) = PROVIDERS.lock() {
            if let Some(state) = states.get_mut(provider).filter(|state| {
              state
                .active
                .as_ref()
                .is_some_and(|job| job.id == id && job.nonce == nonce)
            }) {
              state.last_probe = None;
              state.state = "initializing";
              state.reason = "DOM_ACCOUNT_PROOF_PENDING";
            }
          }
          finish_error(&app_clone, provider, &id, &nonce, &code);
          return;
        }
        std::thread::sleep(Duration::from_millis(100));
      }
    });
  });
  if scheduled.is_err() {
    if let Ok(mut states) = PROVIDERS.lock() {
      if let Some(job) = states
        .get_mut(provider)
        .and_then(|state| state.active.as_mut())
        .filter(|job| job.id == fallback_id && job.nonce == fallback_nonce)
      {
        job.closing = false;
      }
    }
  }
}

pub(crate) fn dispatch(
  app: &AppHandle,
  request_id: &str,
  nonce: &str,
  provider: &str,
  operation: &str,
  input: Value,
  job_id: &str,
  deadline_ms: u64,
) -> Result<(), String> {
  let provider = provider_name(provider)?;
  if input.get("expectedAccount").is_none() {
    return Err("EXPECTED_ACCOUNT_REQUIRED".into());
  }
  if let Ok(mut slot) = SOCIAL_APP.lock() {
    *slot = Some(app.clone());
  }
  let job = build_job(
    provider,
    request_id,
    nonce,
    operation,
    input,
    job_id,
    deadline_ms,
  )?;
  {
    let mut states = PROVIDERS.lock().map_err(|_| "SOCIAL_STATE_UNAVAILABLE")?;
    let state = states.get_mut(provider).ok_or("UNSUPPORTED_PROVIDER")?;
    if state.queue.len() >= 64 {
      return Err("PROVIDER_QUEUE_FULL".into());
    }
    if state
      .active
      .as_ref()
      .is_some_and(|job| job.id == request_id)
      || state.queue.iter().any(|job| job.id == request_id)
    {
      return Err("DUPLICATE_REQUEST".into());
    }
    state.queue.push_back(job);
  }
  pump(app, provider);
  Ok(())
}

pub(crate) fn cancel(request_id: &str, nonce: &str) {
  let mut close = Vec::new();
  let mut queued = Vec::new();
  if let Ok(mut states) = PROVIDERS.lock() {
    for (name, state) in states.iter_mut() {
      if let Some(index) = state
        .queue
        .iter()
        .position(|job| job.id == request_id && job.nonce == nonce)
      {
        if let Some(job) = state.queue.remove(index) {
          queued.push(PublishContext::from(&job));
        }
      }
      if let Some(job) = state
        .active
        .as_mut()
        .filter(|job| job.id == request_id && job.nonce == nonce)
      {
        job.canceled = true;
        close.push((*name, job.id.clone(), job.nonce.clone()));
      }
    }
  }
  for job in queued {
    let _ = publish_bound(
      &job,
      &mut json!({"kind":"error","code":"CANCELLED","reason":"CANCELLED"}),
    );
  }
  for (provider, id, nonce) in close {
    if let Some(app) = SOCIAL_APP.lock().ok().and_then(|app| app.clone()) {
      close_owned(&app, provider, &id, &nonce, "CANCELLED");
    }
  }
}

static SOCIAL_APP: LazyLock<Mutex<Option<AppHandle>>> = LazyLock::new(|| Mutex::new(None));

pub(crate) fn status(app: &AppHandle) -> Vec<Value> {
  if let Ok(mut slot) = SOCIAL_APP.lock() {
    *slot = Some(app.clone());
  }
  let mut warmups = Vec::new();
  let mut result = Vec::new();
  if let Ok(mut states) = PROVIDERS.lock() {
    for provider in ["x", "instagram"] {
      let Some(state) = states.get_mut(provider) else {
        continue;
      };
      if state.active.is_none()
        && state
          .last_probe
          .is_none_or(|time| time.elapsed() > Duration::from_secs(15))
      {
        let mut job = build_job(
          provider,
          &format!("probe-{}", uuid::Uuid::new_v4()),
          &uuid::Uuid::new_v4().to_string(),
          "profile",
          json!({"channel":"relay_probe","limit":1}),
          "probe",
          20000,
        )
        .expect("fixed probe input");
        job.probe_only = true;
        state.queue.push_front(job);
        state.state = "initializing";
        state.reason = "DOM_ACCOUNT_PROOF_PENDING";
        warmups.push(provider);
      }
      let operations = if provider == "x" {
        OPERATIONS_X
      } else {
        OPERATIONS_IG
      };
      let mut entry = json!({"provider":provider,"state":state.state,"reason":state.reason,"operations":operations,
        "limitations":if provider == "x" {"DOM-only bounded reads; exact requested threads"} else {"Exact profile/tag search; no global keyword search; DOM-only bounded reads"}});
      if state.active.as_ref().is_some_and(|job| !job.probe_only) {
        entry["state"] = json!("unavailable");
        entry["reason"] = json!("PROVIDER_BUSY");
      }
      if let Some(binding) = state.binding() {
        entry["accountRef"] = binding["accountRef"].clone();
        entry["accountEpoch"] = binding["accountEpoch"].clone();
      }
      result.push(entry);
    }
  }
  for provider in warmups {
    pump(app, provider);
  }
  result
}

fn media_allowed(provider: &str, source: &str) -> bool {
  let Ok(url) = Url::parse(source) else {
    return false;
  };
  if url.scheme() != "https"
    || url.port_or_known_default() != Some(443)
    || !url.username().is_empty()
    || url.password().is_some()
  {
    return false;
  }
  let Some(host) = url.host_str() else {
    return false;
  };
  if provider == "x" {
    ["pbs.twimg.com", "video.twimg.com"].contains(&host)
  } else {
    host.ends_with(".cdninstagram.com") || host.ends_with(".fbcdn.net")
  }
}

fn decoded_size(value: &str) -> Result<u64, String> {
  if value.is_empty() || value.len() > 65536 || value.len() % 4 != 0 {
    return Err("INVALID_MEDIA_CHUNK".into());
  }
  let padding = value.bytes().rev().take_while(|c| *c == b'=').count();
  if padding > 2
    || !value[..value.len() - padding]
      .bytes()
      .all(|c| c.is_ascii_alphanumeric() || c == b'+' || c == b'/')
  {
    return Err("INVALID_MEDIA_CHUNK".into());
  }
  Ok((value.len() / 4 * 3 - padding) as u64)
}

fn text_field_ranges(value: &Value) -> Result<Vec<(usize, usize)>, String> {
  let fields = value
    .as_object()
    .filter(|v| !v.is_empty() && v.len() <= 5)
    .ok_or("INVALID_TEXT_FIELDS")?;
  let mut ranges = Vec::new();
  for (field, range) in fields {
    if !["text", "caption", "description", "observedText", "title"].contains(&field.as_str()) {
      return Err("INVALID_TEXT_FIELDS".into());
    }
    let range = range
      .as_object()
      .filter(|v| v.len() == 2)
      .ok_or("INVALID_TEXT_FIELDS")?;
    let offset = range
      .get("offset")
      .and_then(Value::as_u64)
      .filter(|v| *v <= 4 * 1024 * 1024)
      .ok_or("INVALID_TEXT_FIELDS")? as usize;
    let length = range
      .get("length")
      .and_then(Value::as_u64)
      .filter(|v| *v <= 4 * 1024 * 1024)
      .ok_or("INVALID_TEXT_FIELDS")? as usize;
    if offset + length > 4 * 1024 * 1024 {
      return Err("INVALID_TEXT_FIELDS".into());
    }
    ranges.push((offset, offset + length));
  }
  ranges.sort_unstable();
  ranges.dedup();
  let mut end = 0;
  for &(start, next) in &ranges {
    if start < end || start - end > 1 || end == 0 && start != 0 {
      return Err("INVALID_TEXT_FIELDS".into());
    }
    end = next;
  }
  Ok(ranges)
}

// UTF16 descriptors mirror JavaScript string offsets; only scalar boundaries are valid.
// Track at most five ranges, without retaining another copy of a multi-MiB payload.
fn validate_text_ranges(
  ranges: &[(usize, usize)],
  text: &str,
  offset: usize,
  final_part: bool,
) -> Result<usize, String> {
  let mut position = offset;
  for ch in text.chars() {
    let length = ch.len_utf16();
    if length == 2
      && ranges
        .iter()
        .any(|&(start, end)| start == position + 1 || end == position + 1)
    {
      return Err("INVALID_TEXT_FIELDS".into());
    }
    let mut previous_end = 0;
    for &(start, end) in ranges {
      if start > previous_end && position == previous_end && ch != '\n' {
        return Err("INVALID_TEXT_FIELDS".into());
      }
      previous_end = end;
    }
    position += length;
  }
  if final_part && ranges.last().map(|range| range.1) != Some(position) {
    return Err("INVALID_TEXT_FIELDS".into());
  }
  Ok(position)
}

fn validate_data_event(provider: &str, job: &mut Job, event: &Value) -> Result<(), String> {
  match event.get("kind").and_then(Value::as_str) {
    Some("records") => {
      let records = event
        .get("records")
        .and_then(Value::as_array)
        .filter(|records| !records.is_empty() && records.len() <= 100)
        .ok_or("INVALID_RECORDS")?;
      for record in records {
        if record.get("schemaVersion").and_then(Value::as_u64) != Some(1) {
          return Err("INVALID_RECORDS".into());
        }
        let id = record
          .get("id")
          .and_then(Value::as_str)
          .filter(|id| !id.is_empty() && id.len() <= 4096)
          .ok_or("INVALID_RECORDS")?;
        let record_type = record
          .get("type")
          .and_then(Value::as_str)
          .filter(|kind| ["post", "reel", "profile", "article", "message"].contains(kind))
          .ok_or("INVALID_RECORDS")?;
        let key = format!("{record_type}:{id}");
        let source = record
          .get("source")
          .and_then(Value::as_str)
          .ok_or("INVALID_RECORDS")?;
        let source_url = Url::parse(source).map_err(|_| "INVALID_RECORDS")?;
        if source.len() > 2048
          || !first_party(provider, &source_url)
          || record
            .get("provider")
            .is_some_and(|v| v.as_str() != Some(provider))
        {
          return Err("INVALID_RECORDS".into());
        }
        if provider == "instagram"
          && ["read", "download"].contains(&job.operation.as_str())
          && ["post", "reel"].contains(&record_type)
          && !same_source(provider, &job.targets[job.target_index], &source_url)
        {
          return Err("INVALID_RECORDS".into());
        }
        // Optional provenance is bound to the already verified actual WebView event
        // and exact selected request target, not merely to an equivalent URL alias.
        if let Some(context) = record.get("sourceContext") {
          let page = context.get("pageUrl").and_then(Value::as_str);
          if !context.is_object()
            || page.is_none()
            || page != event.get("pageUrl").and_then(Value::as_str)
            || context.get("requestedSource").and_then(Value::as_str)
              != Some(job.targets[job.target_index].as_str())
            || context.get("collection").and_then(Value::as_str) != Some("visible_dom")
          {
            return Err("INVALID_RECORDS".into());
          }
        }
        if let Some(metadata) = record.get("pageMetadata") {
          let context = record.get("sourceContext").ok_or("INVALID_RECORDS")?;
          if !metadata.is_object()
            || metadata.get("sourceUrl") != context.get("pageUrl")
            || metadata
              .get("descriptionField")
              .is_some_and(|field| field.as_str() != Some("description"))
          {
            return Err("INVALID_RECORDS".into());
          }
        }
        job.cursor_anchors.insert(if record_type == "message" {
          id.to_string()
        } else {
          source.to_string()
        });
        if !job.records.contains(&key) && job.records.len() >= job.limit {
          return Err("RECORD_LIMIT".into());
        }
        if let Some(part) = record.get("textPart") {
          let index = part
            .get("index")
            .and_then(Value::as_u64)
            .ok_or("INVALID_TEXT_PART")?;
          let text = part
            .get("text")
            .and_then(Value::as_str)
            .ok_or("INVALID_TEXT_PART")?;
          let final_part = part
            .get("final")
            .and_then(Value::as_bool)
            .ok_or("INVALID_TEXT_PART")?;
          let previous = job.text_parts.entry(key.clone()).or_default();
          if previous.final_part || previous.next != index || text.len() > 60000 {
            return Err("INVALID_TEXT_PART".into());
          }
          if let Some(fields) = record.get("textFields") {
            if index != 0 {
              return Err("INVALID_TEXT_FIELDS".into());
            }
            previous.fields = Some(text_field_ranges(fields)?);
          }
          let bytes = previous.bytes + text.len();
          if bytes > 4 * 1024 * 1024 {
            return Err("TEXT_LIMIT".into());
          }
          previous.utf16 = if let Some(ranges) = &previous.fields {
            validate_text_ranges(ranges, text, previous.utf16, final_part)?
          } else {
            previous.utf16 + text.encode_utf16().count()
          };
          previous.next = index + 1;
          previous.final_part = final_part;
          previous.bytes = bytes;
        } else if let Some(fields) = record.get("textFields") {
          let text = record
            .get("text")
            .and_then(Value::as_str)
            .ok_or("INVALID_TEXT_FIELDS")?;
          if text.len() > 4 * 1024 * 1024 {
            return Err("TEXT_LIMIT".into());
          }
          validate_text_ranges(&text_field_ranges(fields)?, text, 0, true)?;
        }
        job.records.insert(key);
        if let Some(media) = record.get("media").and_then(Value::as_array) {
          if media.len() > 100 {
            return Err("INVALID_MEDIA_DESCRIPTOR".into());
          }
          for item in media {
            if let Some(source) = item
              .get("sourceUrl")
              .and_then(Value::as_str)
              .filter(|source| media_allowed(provider, source))
            {
              if job.observed_media.len() >= 10000 {
                return Err("MEDIA_DESCRIPTOR_LIMIT".into());
              }
              job.observed_media.insert(source.to_string());
            }
          }
        }
      }
    }
    Some("media_open") => {
      let id = event
        .get("mediaId")
        .and_then(Value::as_str)
        .filter(|value| value.len() <= 256)
        .ok_or("INVALID_MEDIA")?;
      let source = event
        .get("sourceUrl")
        .and_then(Value::as_str)
        .ok_or("INVALID_MEDIA")?;
      let declared = event
        .get("declaredBytes")
        .and_then(Value::as_u64)
        .filter(|v| *v > 0 && *v <= MAX_FILE)
        .ok_or("MEDIA_SIZE_LIMIT")?;
      let mime = event
        .get("mimeType")
        .and_then(Value::as_str)
        .ok_or("INVALID_MEDIA")?;
      let file = event
        .get("fileName")
        .and_then(Value::as_str)
        .ok_or("INVALID_MEDIA")?;
      if !job.observed_media.contains(source)
        || !media_allowed(provider, source)
        || job.open_media.contains_key(id)
        || job.media_files >= MAX_MEDIA_FILES
        || job.media_bytes + declared > MAX_MEDIA
        || ![
          "image/jpeg",
          "image/png",
          "image/webp",
          "image/gif",
          "image/avif",
          "video/mp4",
          "video/webm",
          "audio/mpeg",
          "audio/mp4",
        ]
        .contains(&mime)
        || file.len() > 64
        || file.contains("..")
        || !file.starts_with("media-")
        || !file
          .bytes()
          .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'.')
      {
        return Err("INVALID_MEDIA".into());
      }
      job.open_media.insert(
        id.into(),
        Media {
          declared,
          received: 0,
          sequence: 0,
        },
      );
      job.media_files += 1;
    }
    Some("media_chunk") => {
      let id = event
        .get("mediaId")
        .and_then(Value::as_str)
        .ok_or("INVALID_MEDIA")?;
      let media = job.open_media.get_mut(id).ok_or("INVALID_MEDIA")?;
      let sequence = event
        .get("sequence")
        .and_then(Value::as_u64)
        .ok_or("INVALID_MEDIA_CHUNK")?;
      let bytes = decoded_size(
        event
          .get("base64")
          .and_then(Value::as_str)
          .ok_or("INVALID_MEDIA_CHUNK")?,
      )?;
      if sequence != media.sequence
        || bytes > 49152
        || media.received + bytes > media.declared
        || job.media_bytes + bytes > MAX_MEDIA
      {
        return Err("INVALID_MEDIA_CHUNK".into());
      }
      media.received += bytes;
      media.sequence += 1;
      job.media_bytes += bytes;
    }
    Some("media_close") => {
      let id = event
        .get("mediaId")
        .and_then(Value::as_str)
        .ok_or("INVALID_MEDIA")?;
      let media = job.open_media.remove(id).ok_or("INVALID_MEDIA")?;
      if media.received != media.declared
        || event.get("totalBytes").and_then(Value::as_u64) != Some(media.received)
      {
        return Err("MEDIA_SIZE_CHANGED".into());
      }
    }
    _ => return Err("INVALID_EVENT".into()),
  }
  Ok(())
}

#[tauri::command]
pub async fn relay_research_social_reply(
  webview: Webview,
  request_id: String,
  nonce: String,
  event: Value,
) -> Result<(), String> {
  tauri::async_runtime::spawn_blocking(move || {
    handle_social_reply(webview, request_id, nonce, event)
  })
  .await
  .map_err(|_| "RESEARCH_DISPATCH_UNAVAILABLE".to_string())?
}

fn handle_social_reply(
  webview: Webview,
  request_id: String,
  nonce: String,
  mut event: Value,
) -> Result<(), String> {
  let provider = match webview.label() {
    "relay-research-x" => "x",
    "relay-research-instagram" => "instagram",
    _ => return Err("UNTRUSTED_RESEARCH_VIEW".into()),
  };
  if serde_json::to_vec(&event)
    .map_err(|_| "INVALID_EVENT")?
    .len()
    > MAX_FRAME
  {
    return Err("FRAME_TOO_LARGE".into());
  }
  let actual = webview.url().map_err(|_| "UNTRUSTED_ORIGIN")?;
  let page = Url::parse(
    event
      .get("pageUrl")
      .and_then(Value::as_str)
      .ok_or("UNTRUSTED_ORIGIN")?,
  )
  .map_err(|_| "UNTRUSTED_ORIGIN")?;
  if !first_party(provider, &actual) || actual.as_str() != page.as_str() {
    return Err("UNTRUSTED_ORIGIN".into());
  }
  let app = webview.app_handle().clone();
  let kind = event
    .get("kind")
    .and_then(Value::as_str)
    .ok_or("INVALID_EVENT")?
    .to_string();
  let mut to_publish: Vec<(PublishContext, Value)> = Vec::new();
  let mut navigate = false;
  let mut finished = false;
  let mut failure_code = None;
  {
    let mut states = PROVIDERS.lock().map_err(|_| "SOCIAL_STATE_UNAVAILABLE")?;
    let state = states.get_mut(provider).ok_or("UNSUPPORTED_PROVIDER")?;
    let job = state.active.as_mut().ok_or("STALE_REQUEST")?;
    if job.id != request_id
      || job.nonce != nonce
      || event.get("documentEpoch").and_then(Value::as_u64) != Some(state.document_epoch)
    {
      return Err("STALE_REQUEST".into());
    }
    if job.canceled {
      if kind == "error" {
        drop(states);
        finish_error(&app, provider, &request_id, &nonce, "CANCELLED");
        return Ok(());
      }
      return Err("CANCEL_PENDING_SETTLEMENT".into());
    }
    if Instant::now() >= job.expires {
      return Err("DEADLINE".into());
    }
    let expected = if job.phase == Phase::Probe {
      home(provider)
    } else {
      job.targets[job.target_index].clone()
    };
    let account_epoch = format!("{}:{}", state.salt, state.epoch);
    if kind == "auth" {
      let authentication = event
        .get("state")
        .and_then(Value::as_str)
        .ok_or("INVALID_AUTH_PROOF")?;
      if authentication != "ready" {
        state.state = match authentication {
          "auth_required" => "auth_required",
          "challenge_required" => "challenge_required",
          _ => "unavailable",
        };
        state.reason = match authentication {
          "auth_required" => "SESSION_NOT_AVAILABLE_IN_RESEARCH_VIEW",
          "challenge_required" => "CHALLENGE_REQUIRED",
          _ => match event.get("reason").and_then(Value::as_str) {
            Some("DOM_ACCOUNT_INBOX_NAV_UNAVAILABLE") => "DOM_ACCOUNT_INBOX_NAV_UNAVAILABLE",
            Some("DOM_ACCOUNT_PROFILE_NAV_UNAVAILABLE") => "DOM_ACCOUNT_PROFILE_NAV_UNAVAILABLE",
            Some("DOM_ACCOUNT_IDENTITY_AMBIGUOUS") => "DOM_ACCOUNT_IDENTITY_AMBIGUOUS",
            _ => "DOM_ACCOUNT_PROOF_UNAVAILABLE",
          },
        };
        state.epoch = state.epoch.wrapping_add(1);
        state.identity = None;
        state.account_ref = None;
        failure_code = Some(state.reason.to_string());
      } else if !same_source(provider, &expected, &actual) {
        failure_code = Some("SOURCE_CHANGED".into());
      } else {
        let identity = event
          .get("identity")
          .and_then(Value::as_str)
          .filter(|v| {
            v.strip_prefix(&format!("{provider}:"))
              .is_some_and(|handle| handle_valid(provider, handle))
          })
          .ok_or("INVALID_AUTH_PROOF")?
          .to_string();
        let changed = state
          .identity
          .as_ref()
          .is_some_and(|previous| previous != &identity);
        if changed {
          state.epoch = state.epoch.wrapping_add(1);
          state.account_ref = None;
        }
        state.identity = Some(identity);
        if state.account_ref.is_none() {
          state.account_ref = Some(uuid::Uuid::new_v4().to_string());
        }
        state.state = "ready";
        state.reason = "DOM_ACCOUNT_CONFIRMED";
        state.last_probe = Some(Instant::now());
        let binding = json!({"accountRef":state.account_ref,"accountEpoch":format!("{}:{}", state.salt, state.epoch)});
        if job.expected_account.as_ref().is_some_and(|expected| {
          expected.get("accountRef") != binding.get("accountRef")
            || expected.get("accountEpoch") != binding.get("accountEpoch")
        }) || changed && !job.probe_only
        {
          failure_code = Some("STALE_ACCOUNT".into());
        } else if job
          .cursor
          .as_ref()
          .is_some_and(|cursor| cursor.get("accountEpoch") != binding.get("accountEpoch"))
        {
          failure_code = Some("STALE_ACCOUNT".into());
        } else if job.probe_only {
          finished = true;
        } else if job.phase == Phase::Probe {
          job.binding = Some(binding.clone());
          job.phase = Phase::Read;
          let operations = if provider == "x" {
            OPERATIONS_X
          } else {
            OPERATIONS_IG
          };
          to_publish.push((PublishContext::from(&*job), json!({"kind":"status","providers":[{"provider":provider,"state":"ready","reason":"DOM_ACCOUNT_CONFIRMED",
            "operations":operations,"accountRef":binding["accountRef"],"accountEpoch":binding["accountEpoch"]}]})));
          to_publish.push((PublishContext::from(&*job), json!({"kind":"scope"})));
          navigate = true;
        } else if job.binding.as_ref() != Some(&binding) {
          failure_code = Some("STALE_ACCOUNT".into());
        }
      }
    } else if kind == "error" && job.phase == Phase::Probe {
      failure_code = Some(page_error(&event).to_string());
    } else {
      if job.phase != Phase::Read
        || job.binding.is_none()
        || !same_source(provider, &expected, &actual)
        || event.get("identityProof").and_then(Value::as_str) != state.identity.as_deref()
        || job
          .binding
          .as_ref()
          .and_then(|value| value.get("accountEpoch"))
          .and_then(Value::as_str)
          != Some(account_epoch.as_str())
      {
        failure_code = Some("STALE_ACCOUNT".into());
      } else if kind == "error" {
        failure_code = Some(page_error(&event).to_string());
      } else if kind == "page_done" {
        if !job.open_media.is_empty()
          || job.text_parts.values().any(|part| !part.final_part)
          || event.get("accessible").and_then(Value::as_bool) != Some(true)
          || event.get("count").and_then(Value::as_u64)
            != Some(job.records.len().saturating_sub(job.page_start_count) as u64)
        {
          failure_code = Some("INCOMPLETE_SOURCE_READ".into());
        } else {
          job.pages_read += 1;
          job.sources_read.insert(job.target_index);
          if let Some(unresolved) = event
            .get("coverage")
            .and_then(|v| v.get("unresolved"))
            .and_then(Value::as_array)
          {
            for gap in unresolved.iter().take(100) {
              if let Some(value) = gap.as_str().filter(|v| {
                !v.is_empty()
                  && v.len() <= 128
                  && v
                    .bytes()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_')
              }) {
                job.gaps.insert(value.into());
              }
            }
          }
          job.partial |= event
            .get("partial")
            .and_then(Value::as_bool)
            .unwrap_or(true);
          job.next_cursor = event
            .get("nextCursor")
            .and_then(Value::as_str)
            .filter(|value| value.len() <= 4096)
            .map(str::to_string);
          if job.next_cursor.is_some()
            && job.records.len() < job.limit
            && job.records.len() > job.page_start_count
          {
            let cursor = job.next_cursor.as_ref().expect("continuation checked");
            let value: Value = serde_json::from_str(cursor).map_err(|_| "INVALID_CURSOR")?;
            let anchor = value
              .get("anchor")
              .and_then(Value::as_str)
              .ok_or("INVALID_CURSOR")?;
            let old_offset = job
              .cursor
              .as_ref()
              .and_then(|v| v.get("offset"))
              .and_then(Value::as_u64)
              .unwrap_or(0);
            if value.get("schemaVersion").and_then(Value::as_u64) != Some(1)
              || value.get("provider").and_then(Value::as_str) != Some(provider)
              || value.get("operation").and_then(Value::as_str) != Some(job.operation.as_str())
              || value.get("sourceKey").and_then(Value::as_str) != Some(job.source_key.as_str())
              || value.get("accountEpoch").and_then(Value::as_str) != Some(account_epoch.as_str())
              || value.get("targetIndex").and_then(Value::as_u64) != Some(job.target_index as u64)
              || !job.cursor_anchors.contains(anchor)
              || value.get("offset").and_then(Value::as_u64)
                != Some(old_offset + (job.records.len() - job.page_start_count) as u64)
            {
              failure_code = Some("CURSOR_SOURCE_MISMATCH".into());
            } else {
              job.input["cursor"] = json!(cursor);
              job.cursor = Some(value);
              job.page_start_count = job.records.len();
              navigate = true;
            }
          } else if job.target_index + 1 < job.targets.len() && job.records.len() < job.limit {
            job.target_index += 1;
            job.page_start_count = job.records.len();
            job.input.as_object_mut().map(|map| map.remove("cursor"));
            job.cursor = None;
            navigate = true;
          } else {
            if job.target_index + 1 < job.targets.len() {
              job.partial = true;
              job.next_cursor = Some(json!({"schemaVersion":1,"provider":provider,"operation":job.operation,
                "sourceKey":job.source_key,"accountEpoch":account_epoch,"targetIndex":job.target_index+1}).to_string());
            }
            let no_progress = job.records.is_empty()
              && valid_no_progress_cursor(
                provider,
                &job.operation,
                &job.source_key,
                &account_epoch,
                job.target_index,
                job.cursor.as_ref(),
                &event,
              );
            if job.records.is_empty()
              && event.get("emptyProof").and_then(Value::as_bool) != Some(true)
              && !no_progress
            {
              failure_code = Some("EMPTY_SOURCE_NOT_CONFIRMED".into());
            } else {
              let coverage = json!({"scope":coverage_scope(&job.operation),"extraction":"visible_dom","accessible":true,"sourcesRequested":job.targets.len(),
                "sourcesRead":job.sources_read.len(),"pagesRead":job.pages_read,"recordsObserved":job.records.len(),"completeness":if job.partial {"partial"} else {"complete"}});
              let mut coverage = coverage;
              coverage["unresolved"] = json!(job.gaps);
              let mut done = json!({"kind":"done","outcome":if no_progress {"partial"} else if job.records.is_empty() {"empty"} else if job.partial {"partial"} else {"results"},
                "count":job.records.len(),"partial":job.partial,"coverage":coverage});
              if let Some(cursor) = &job.next_cursor {
                done["nextCursor"] = json!(cursor);
              }
              to_publish.push((PublishContext::from(&*job), done));
              finished = true;
            }
          }
        }
      } else {
        match validate_data_event(provider, job, &event) {
          Ok(()) => {
            state.last_probe = Some(Instant::now());
            to_publish.push((PublishContext::from(&*job), event.take()));
          }
          Err(code) => failure_code = Some(code),
        }
      }
    }
  }
  for (job, mut value) in to_publish {
    if let Err(code) = publish_bound(&job, &mut value) {
      if let Ok(mut states) = PROVIDERS.lock() {
        if let Some(active) = states
          .get_mut(provider)
          .and_then(|state| state.active.as_mut())
          .filter(|active| active.id == request_id && active.nonce == nonce)
        {
          active.canceled = true;
        }
      }
      close_owned(
        &app,
        provider,
        &request_id,
        &nonce,
        "NATIVE_TRANSPORT_REJECTED",
      );
      return Err(code);
    }
  }
  if let Some(code) = failure_code {
    if ["auth", "error", "page_done"].contains(&kind.as_str()) {
      finish_error(&app, provider, &request_id, &nonce, &code);
    } else {
      close_owned(&app, provider, &request_id, &nonce, &code);
    }
    return Err(code);
  }
  if finished {
    if let Ok(mut states) = PROVIDERS.lock() {
      if let Some(state) = states.get_mut(provider).filter(|state| {
        state
          .active
          .as_ref()
          .is_some_and(|job| job.id == request_id && job.nonce == nonce)
      }) {
        state.active = None;
      }
    }
    pump(&app, provider);
  } else if navigate {
    navigate_active(&app, provider);
  }
  Ok(())
}

#[cfg(test)]
mod relay_audit_tests {
  use super::*;

  fn dispatch_fixture() -> Provider {
    let mut state = Provider::new();
    state.view_generation = 3;
    state.active = Some(
      build_job(
        "x",
        "synthetic-request",
        "synthetic-nonce-0001",
        "profile",
        json!({"channel":"OpenAI","limit":1,"pageSize":1,"deadlineMs":3000,
        "expectedAccount":{"accountRef":"synthetic-account","accountEpoch":"synthetic-epoch"}}),
        "synthetic-job",
        3000,
      )
      .unwrap(),
    );
    state
  }

  fn attribution_job(source: &str) -> Job {
    build_job(
      "instagram",
      "synthetic-attribution",
      "synthetic-nonce-0001",
      "read",
      json!({"url":source,"limit":1,"pageSize":1,"deadlineMs":3000,
        "expectedAccount":{"accountRef":"synthetic-account","accountEpoch":"synthetic-epoch"}}),
      "synthetic-job",
      3000,
    )
    .unwrap()
  }

  #[test]
  fn attribution_native_exact_provenance_and_legacy_schema_one() {
    let mut job = attribution_job("https://www.instagram.com/reel/SAME");
    let event = json!({"kind":"records","pageUrl":"https://www.instagram.com/owner/reel/SAME/","records":[{
      "schemaVersion":1,"provider":"instagram","type":"reel","id":"instagram:SAME","source":"https://www.instagram.com/owner/reel/SAME",
      "description":"profile metadata","sourceContext":{"pageUrl":"https://www.instagram.com/owner/reel/SAME/","requestedSource":job.targets[0].as_str(),"collection":"visible_dom"},
      "pageMetadata":{"sourceUrl":"https://www.instagram.com/owner/reel/SAME/","descriptionField":"description"}}]});
    assert!(validate_data_event("instagram", &mut job, &event).is_ok());
    for field in ["pageUrl", "requestedSource", "collection"] {
      let mut changed = event.clone();
      changed["records"][0]["sourceContext"][field] = json!("changed");
      assert!(
        validate_data_event(
          "instagram",
          &mut attribution_job("https://www.instagram.com/reel/SAME"),
          &changed
        )
        .is_err(),
        "{field}"
      );
    }
    let mut changed = event.clone();
    changed["records"][0]["pageMetadata"]["sourceUrl"] = json!("https://www.instagram.com/openai/");
    assert!(
      validate_data_event(
        "instagram",
        &mut attribution_job("https://www.instagram.com/reel/SAME"),
        &changed
      )
      .is_err()
    );
    for source in [
      "https://www.instagram.com/p/SAME",
      "https://www.instagram.com/reel/OTHER",
      "https://www.instagram.com/reel//SAME",
    ] {
      let mut changed = event.clone();
      changed["records"][0]["source"] = json!(source);
      assert!(
        validate_data_event(
          "instagram",
          &mut attribution_job("https://www.instagram.com/reel/SAME"),
          &changed
        )
        .is_err(),
        "{source}"
      );
    }
    let mut legacy = event.clone();
    legacy["records"][0]
      .as_object_mut()
      .unwrap()
      .remove("sourceContext");
    legacy["records"][0]
      .as_object_mut()
      .unwrap()
      .remove("pageMetadata");
    assert!(
      validate_data_event(
        "instagram",
        &mut attribution_job("https://www.instagram.com/reel/SAME"),
        &legacy
      )
      .is_ok()
    );
  }

  #[test]
  fn attribution_native_text_roles_validate_ranges_scalar_boundaries_aliases_and_limits() {
    for good in [
      json!({"description":{"offset":0,"length":3}}),
      json!({"text":{"offset":0,"length":3},"description":{"offset":0,"length":3}}),
    ] {
      let ranges = text_field_ranges(&good).unwrap();
      assert_eq!(validate_text_ranges(&ranges, "a🙂", 0, true).unwrap(), 3);
    }
    for bad in [
      json!({}),
      json!({"constructor":{"offset":0,"length":3}}),
      json!({"text":{"offset":-1,"length":3}}),
      json!({"text":{"offset":0.5,"length":3}}),
      json!({"text":{"offset":0,"length":3,"extra":1}}),
      json!({"text":{"offset":0,"length":4194305}}),
      json!({"text":{"offset":0,"length":3},"description":{"offset":2,"length":1}}),
    ] {
      assert!(text_field_ranges(&bad).is_err());
    }
    for bad in [
      json!({"text":{"offset":0,"length":2}}),
      json!({"text":{"offset":0,"length":4}}),
    ] {
      assert!(validate_text_ranges(&text_field_ranges(&bad).unwrap(), "a🙂", 0, true).is_err());
    }
    let split = text_field_ranges(
      &json!({"text":{"offset":0,"length":3},"description":{"offset":4,"length":3}}),
    )
    .unwrap();
    let offset = validate_text_ranges(&split, "a🙂", 0, false).unwrap();
    assert!(validate_text_ranges(&split, "\nb🙂", offset, true).is_ok());
    assert!(validate_text_ranges(&split, "xb🙂", offset, true).is_err());
    let event = json!({"kind":"records","records":[{"schemaVersion":1,"type":"reel","id":"instagram:SAME","source":"https://www.instagram.com/reel/SAME", "textPart":{"index":0,"text":"x".repeat(60001),"final":false}}]});
    assert_eq!(
      validate_data_event(
        "instagram",
        &mut attribution_job("https://www.instagram.com/reel/SAME"),
        &event
      )
      .unwrap_err(),
      "INVALID_TEXT_PART"
    );
    let mut bounded_job = attribution_job("https://www.instagram.com/reel/SAME");
    for index in 0..70 {
      let event = json!({"kind":"records","records":[{"schemaVersion":1,"type":"reel","id":"instagram:SAME","source":"https://www.instagram.com/reel/SAME", "textPart":{"index":index,"text":"x".repeat(60000),"final":false}}]});
      let result = validate_data_event("instagram", &mut bounded_job, &event);
      if index == 69 {
        assert_eq!(result.unwrap_err(), "TEXT_LIMIT");
      } else {
        assert!(result.is_ok());
      }
    }
  }

  #[test]
  fn attribution_actual_helper_wire_native_guards() {
    let Ok(file) = std::env::var("EGOIST_ATTRIBUTION_FIXTURE_FILE") else {
      return;
    };
    let fixtures: Value = serde_json::from_slice(&std::fs::read(file).unwrap()).unwrap();
    let mut tested = 0;
    for fixture in fixtures.as_array().unwrap() {
      let request = &fixture["request"];
      let operation = request["operation"].as_str().unwrap();
      let mut input = request["input"].clone();
      input["limit"] = json!(1);
      input["deadlineMs"] = json!(3000);
      if operation == "read" {
        input["url"] = request["target"].clone();
      } else {
        input["channel"] = json!("openai");
      }
      let mut job = build_job(
        "instagram",
        "synthetic-wire",
        "synthetic-nonce-0001",
        operation,
        input,
        "synthetic-job",
        3000,
      )
      .unwrap();
      assert_eq!(job.targets[0].as_str(), request["target"].as_str().unwrap());
      let mut records = 0;
      for event in fixture["events"].as_array().unwrap() {
        if event["kind"] == "records" {
          validate_data_event("instagram", &mut job, event).unwrap();
          records += 1;
        }
      }
      assert!(records > 0);
      assert_eq!(job.records.len(), 1);
      assert!(job.text_parts.values().all(|part| part.final_part));
      tested += 1;
    }
    assert!(tested >= 7);
  }

  #[test]
  fn document_lifecycle_rejects_old_controls_navigation_and_cancelled_starts() {
    let mut state = dispatch_fixture();
    assert!(!start_navigation(&mut state, 2, 1, false, false));
    assert!(!start_navigation(&mut state, 3, 1, true, false));
    assert!(!load_document(&mut state, 3, 1));
    assert!(start_navigation(&mut state, 3, 1, false, false));
    assert!(load_document(&mut state, 3, 1));
    let epoch = state.document_epoch;
    assert!(start_navigation(&mut state, 3, 1, false, false)); // redirect retains ID
    assert!(load_document(&mut state, 3, 1));
    assert_eq!(state.document_epoch, epoch);
    assert!(start_navigation(&mut state, 3, 1, false, true));
    let old = document_guard(&state, 3, 1, home("x")).unwrap();
    assert!(start_navigation(&mut state, 3, 2, false, false));
    assert!(load_document(&mut state, 3, 2));
    assert!(!start_navigation(&mut state, 3, 1, false, true)); // late redirect cannot replace current owner
    assert_eq!(state.navigation_id, 2);
    assert!(document_guard(&state, 3, 1, home("x")).is_none());
    assert!(prepare_document_envelope(&mut state, "x", &home("x"), &old, false).is_none());
    assert!(!load_document(&mut state, 2, 2));
    assert_eq!(state.document_epoch, epoch + 1);
  }

  #[test]
  fn initialized_probe_starts_once_despite_delayed_finished_and_restarts_only_new_document() {
    let mut state = dispatch_fixture();
    start_navigation(&mut state, 3, 7, false, false);
    load_document(&mut state, 3, 7);
    let guard = document_guard(&state, 3, 7, home("x")).unwrap();
    let envelope = prepare_document_envelope(&mut state, "x", &home("x"), &guard, true).unwrap();
    assert_eq!(envelope["nonce"], "synthetic-nonce-0001");
    assert_eq!(envelope["documentEpoch"], state.document_epoch);
    assert!(envelope["input"].get("expectedAccount").is_none());
    assert!(prepare_document_envelope(&mut state, "x", &home("x"), &guard, true).is_none());
    assert!(prepare_document_envelope(&mut state, "x", &home("x"), &guard, false).is_none());
    start_navigation(&mut state, 3, 8, false, false);
    load_document(&mut state, 3, 8);
    let next = document_guard(&state, 3, 8, home("x")).unwrap();
    assert!(prepare_document_envelope(&mut state, "x", &home("x"), &next, false).is_some());
  }

  #[test]
  fn collection_keeps_finished_gate_and_owned_nonce_phase_source_epoch_binding() {
    let mut state = dispatch_fixture();
    state.active.as_mut().unwrap().phase = Phase::Read;
    let source = state.active.as_ref().unwrap().targets[0].clone();
    start_navigation(&mut state, 3, 1, false, false);
    load_document(&mut state, 3, 1);
    let guard = document_guard(&state, 3, 1, source.clone()).unwrap();
    assert!(prepare_document_envelope(&mut state, "x", &source, &guard, true).is_none());
    for changed in ["https://evil.example/OpenAI", "https://x.com/Other"] {
      assert!(
        prepare_document_envelope(
          &mut state,
          "x",
          &Url::parse(changed).unwrap(),
          &guard,
          false
        )
        .is_none()
      );
    }
    state.active.as_mut().unwrap().nonce = "synthetic-nonce-0002".into();
    assert!(prepare_document_envelope(&mut state, "x", &source, &guard, false).is_none());
    state.active.as_mut().unwrap().nonce = guard.request_nonce.clone();
    state.epoch += 1;
    assert!(prepare_document_envelope(&mut state, "x", &source, &guard, false).is_none());
    state.epoch -= 1;
    assert!(prepare_document_envelope(&mut state, "x", &source, &guard, false).is_some());
  }

  #[test]
  fn document_dispatch_rejects_cancel_deadline_closing_and_replaced_same_source_job() {
    let mut state = dispatch_fixture();
    start_navigation(&mut state, 3, 1, false, false);
    load_document(&mut state, 3, 1);
    let guard = document_guard(&state, 3, 1, home("x")).unwrap();
    state.active.as_mut().unwrap().canceled = true;
    assert!(prepare_document_envelope(&mut state, "x", &home("x"), &guard, true).is_none());
    state.active.as_mut().unwrap().canceled = false;
    state.active.as_mut().unwrap().closing = true;
    assert!(prepare_document_envelope(&mut state, "x", &home("x"), &guard, true).is_none());
    state.active.as_mut().unwrap().closing = false;
    state.active.as_mut().unwrap().expires = Instant::now();
    assert!(prepare_document_envelope(&mut state, "x", &home("x"), &guard, true).is_none());
    state.active.as_mut().unwrap().expires = Instant::now() + Duration::from_secs(1);
    state.active.as_mut().unwrap().id = "synthetic-replacement".into();
    // A delayed callback cannot mint a fresh guard bound to replacement B
    // before B starts its own navigation, even at the same exact source URL.
    assert!(document_guard(&state, 3, 1, home("x")).is_none());
    assert!(navigation_job(&state, 3, 1).is_none());
    assert!(prepare_document_envelope(&mut state, "x", &home("x"), &guard, false).is_none());
    assert!(state.dispatched.is_none());
    start_navigation(&mut state, 3, 2, false, false);
    load_document(&mut state, 3, 2);
    let fresh = document_guard(&state, 3, 2, home("x")).unwrap();
    assert!(prepare_document_envelope(&mut state, "x", &home("x"), &fresh, true).is_some());
  }

  #[test]
  fn selected_instagram_post_routes_preserve_shortcode_and_share_canonical_binding() {
    let expected = source_url(
      "instagram",
      "read",
      "https://www.instagram.com/chatgpt/reel/Dc1ldDJyZDj",
    )
    .unwrap();
    assert_eq!(
      expected.as_str(),
      "https://www.instagram.com/reel/Dc1ldDJyZDj"
    );
    for route in [
      "/reel/Dc1ldDJyZDj",
      "/reels/Dc1ldDJyZDj/",
      "/chatgpt/reel/Dc1ldDJyZDj",
      "/chatgpt/reels/Dc1ldDJyZDj",
    ] {
      let actual = Url::parse(&format!("https://www.instagram.com{route}")).unwrap();
      assert!(same_source("instagram", &expected, &actual), "{route}");
    }
    for route in [
      "/reel/Other",
      "/p/Dc1ldDJyZDj",
      "/direct/t/123",
      "/chatgpt/reel/Dc1ldDJyZDj/extra",
    ] {
      assert!(
        !same_source(
          "instagram",
          &expected,
          &Url::parse(&format!("https://www.instagram.com{route}")).unwrap()
        ),
        "{route}"
      );
    }
    assert_eq!(
      source_url(
        "instagram",
        "download",
        "https://instagram.com/chatgpt/p/Ab_C-123"
      )
      .unwrap()
      .path(),
      "/p/Ab_C-123"
    );
  }

  #[test]
  fn x_search_preserves_query_binding_and_normalized_host() {
    let source = Url::parse("https://x.com/search?q=OpenAI&f=live").unwrap();
    assert!(same_source(
      "x",
      &source,
      &Url::parse("https://twitter.com/search?q=OpenAI&f=live").unwrap()
    ));
    for other in [
      "https://x.com/search?q=Other&f=live",
      "https://x.com/search?q=OpenAI&f=top",
      "https://evil.example/search?q=OpenAI&f=live",
    ] {
      assert!(!same_source("x", &source, &Url::parse(other).unwrap()));
    }
  }

  #[test]
  fn selected_instagram_aliases_reject_untrusted_and_malformed_routes() {
    let mut credential_url =
      Url::parse("https://www.instagram.com/chatgpt/reel/Dc1ldDJyZDj").unwrap();
    credential_url.set_username("synthetic_audit_user").unwrap();
    credential_url
      .set_password(Some("synthetic_audit_password"))
      .unwrap();
    for source in [
      "https://evil.example/chatgpt/reel/Dc1ldDJyZDj",
      "http://www.instagram.com/chatgpt/reel/Dc1ldDJyZDj",
      credential_url.as_str(),
      "https://www.instagram.com:444/chatgpt/reel/Dc1ldDJyZDj",
      "https://www.instagram.com/chatgpt/reel/Dc1ldDJyZDj/extra",
      "https://www.instagram.com/chat%2Fgpt/reel/Dc1ldDJyZDj",
      "https://www.instagram.com/chatgpt/reel/Dc1%2FldDJyZDj",
      "https://www.instagram.com/bad-handle/reel/Dc1ldDJyZDj",
      "https://www.instagram.com/direct/reel/Dc1ldDJyZDj",
      "https://www.instagram.com/chatgpt/reel/",
      "https://www.instagram.com/chatgpt/direct/t/123",
    ] {
      assert!(source_url("instagram", "read", source).is_err(), "{source}");
    }
    assert!(
      source_url(
        "instagram",
        "read_thread",
        "https://www.instagram.com/chatgpt/reel/Dc1ldDJyZDj"
      )
      .is_err()
    );
    assert_eq!(
      source_url(
        "instagram",
        "read_thread",
        "https://www.instagram.com/direct/t/123"
      )
      .unwrap()
      .path(),
      "/direct/t/123"
    );
    assert!(
      source_url(
        "instagram",
        "read",
        &format!("https://www.instagram.com/chatgpt/reel/{}", "A".repeat(129))
      )
      .is_err()
    );
  }

  #[test]
  fn anchored_no_progress_preserves_checked_cursor_without_confirming_empty() {
    let cursor = json!({"schemaVersion":1,"provider":"x","operation":"chat_export","sourceKey":"fixture-source","accountEpoch":"fixture-epoch","targetIndex":0,"anchor":"https://x.com/OpenAI/status/3","offset":3});
    let event = json!({"accessible":true,"count":0,"partial":true,"emptyProof":false,"nextCursor":cursor.to_string(),"resumeProof":{"anchor":cursor["anchor"],"anchorReached":true,"recordsObserved":3},"coverage":{"completeness":"partial","unresolved":["cursor_no_progress"]}});
    let accepted = |original: Option<&Value>, value: &Value| {
      valid_no_progress_cursor(
        "x",
        "chat_export",
        "fixture-source",
        "fixture-epoch",
        0,
        original,
        value,
      )
    };
    assert!(accepted(Some(&cursor), &event));
    assert!(!accepted(None, &event));
    for (field, value) in [
      ("offset", json!(4)),
      ("accountEpoch", json!("other")),
      ("sourceKey", json!("other")),
      ("targetIndex", json!(1)),
      ("provider", json!("instagram")),
      ("operation", json!("search")),
      ("anchor", json!("https://x.com/OpenAI/status/4")),
    ] {
      let mut changed = cursor.clone();
      changed[field] = value;
      let mut forged = event.clone();
      forged["nextCursor"] = json!(changed.to_string());
      assert!(!accepted(Some(&cursor), &forged), "{field}");
    }
    for (path, value) in [
      (vec!["resumeProof", "anchor"], json!("other")),
      (vec!["resumeProof", "anchorReached"], json!(false)),
      (vec!["resumeProof", "recordsObserved"], json!(0)),
      (vec!["resumeProof", "recordsObserved"], json!(20_001)),
      (vec!["coverage", "unresolved"], json!([])),
      (vec!["coverage", "completeness"], json!("complete")),
      (vec!["emptyProof"], json!(true)),
      (vec!["partial"], json!(false)),
      (vec!["count"], json!(1)),
    ] {
      let mut forged = event.clone();
      let mut target = &mut forged;
      for key in &path[..path.len() - 1] {
        target = &mut target[*key];
      }
      target[*path.last().unwrap()] = value;
      assert!(!accepted(Some(&cursor), &forged), "{path:?}");
    }
    for field in ["resumeProof", "nextCursor", "coverage"] {
      let mut forged = event.clone();
      forged.as_object_mut().unwrap().remove(field);
      assert!(!accepted(Some(&cursor), &forged));
    }
  }
}
