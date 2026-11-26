//! Разбор ссылок VPN и подписок: vless, vmess, trojan, ss (SIP002 и старый base64).
//!
//! Образец полей — Egoist Lagom (`UriParsers.cs`, `OutboundBuilder.cs`). Отличия намеренные:
//! небезопасный TLS (`allowInsecure`) не поддерживается, а в тексты ошибок не попадают значения
//! из ссылки (ключи, пароли, идентификаторы, адреса) — только схема и имя поля.
//! hy2, tuic, wg, ssr и прочее не работает на Xray: такие ссылки пропускаются с причиной.

use std::collections::{BTreeMap, HashSet};
use std::fmt;

/// Предел длины одной ссылки.
const MAX_LINK_LEN: usize = 8192;
/// Предел размера всего входа (подписка).
const MAX_INPUT_LEN: usize = 5 * 1024 * 1024;
/// Предел числа узлов из одной подписки.
const MAX_NODES: usize = 500;

/// Причина, по которой ссылка не стала узлом. Значения из ссылки в текст не попадают.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UriError {
  /// Протокол не работает на Xray или не поддерживается приложением (схема, безопасная для вывода).
  UnsupportedProtocol(String),
  /// Транспорт, который приложение не собирает или который убран из Xray (kcp, quic, h2).
  UnsupportedTransport(String),
  /// Не хватает обязательного поля (имя поля).
  MissingField(&'static str),
  /// Ссылка повреждена или слишком длинная (описание без значений).
  Malformed(&'static str),
}

impl fmt::Display for UriError {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    match self {
      Self::UnsupportedProtocol(scheme) => write!(f, "протокол {scheme} не поддерживается"),
      Self::UnsupportedTransport(name) => write!(f, "транспорт {name} не поддерживается"),
      Self::MissingField(field) => write!(f, "нет обязательного поля {field}"),
      Self::Malformed(what) => write!(f, "ссылка повреждена: {what}"),
    }
  }
}

/// Транспорт потока.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Network { Tcp, Ws, Grpc, Xhttp, HttpUpgrade }

impl Network {
  /// Имя транспорта в конфиге Xray.
  pub fn xray_name(self) -> &'static str {
    match self {
      Self::Tcp => "tcp",
      Self::Ws => "ws",
      Self::Grpc => "grpc",
      Self::Xhttp => "xhttp",
      Self::HttpUpgrade => "httpupgrade",
    }
  }
}

/// Защита транспорта.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Security { None, Tls, Reality }

/// Параметры потока (`streamSettings`).
#[derive(Clone, PartialEq, Eq)]
pub struct Stream {
  pub network: Network,
  pub security: Security,
  /// SNI (serverName); пусто — подставляется адрес сервера.
  pub sni: String,
  /// Отпечаток uTLS, по умолчанию `chrome`.
  pub fingerprint: String,
  pub alpn: Vec<String>,
  /// Reality: публичный ключ.
  pub public_key: String,
  /// Reality: короткий идентификатор.
  pub short_id: String,
  /// Reality: spiderX.
  pub spider_x: String,
  /// ws / xhttp / httpupgrade: путь.
  pub path: String,
  /// ws / xhttp / httpupgrade: заголовок Host.
  pub host: String,
  /// xhttp: режим (по умолчанию `auto`).
  pub mode: String,
  /// grpc: имя сервиса.
  pub service_name: String,
  /// xhttp: дополнительные параметры (`extra`), если заданы объектом JSON.
  pub extra: Option<serde_json::Value>,
}

impl Stream {
  fn plain() -> Self {
    Self {
      network: Network::Tcp,
      security: Security::None,
      sni: String::new(),
      fingerprint: "chrome".into(),
      alpn: Vec::new(),
      public_key: String::new(),
      short_id: String::new(),
      spider_x: String::new(),
      path: String::new(),
      host: String::new(),
      mode: String::new(),
      service_name: String::new(),
      extra: None,
    }
  }
}

/// Протокол узла вместе с секретами.
#[derive(Clone, PartialEq, Eq)]
pub enum Proto {
  Vless { id: String, flow: String, encryption: String },
  Vmess { id: String, alter_id: u32, security: String },
  Trojan { password: String },
  Shadowsocks { method: String, password: String },
}

impl Proto {
  /// Короткое имя протокола (для журнала и статуса).
  pub fn name(&self) -> &'static str {
    match self {
      Self::Vless { .. } => "vless",
      Self::Vmess { .. } => "vmess",
      Self::Trojan { .. } => "trojan",
      Self::Shadowsocks { .. } => "ss",
    }
  }
}

/// Один узел VPN.
#[derive(Clone, PartialEq, Eq)]
pub struct Node {
  /// Имя из фрагмента ссылки (для показа пользователю).
  pub name: String,
  pub server: String,
  pub port: u16,
  pub proto: Proto,
  pub stream: Stream,
}

// Debug без секретов: в журнал и panic-сообщения не должны попасть ключи
impl fmt::Debug for Node {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    write!(f, "Node({} {}:{})", self.proto.name(), self.server, self.port)
  }
}

/// Пропущенная ссылка: схема и причина.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Skipped {
  pub scheme: String,
  pub reason: String,
}

/// Итог разбора текста подписки или набора ссылок.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Parsed {
  pub nodes: Vec<Node>,
  pub skipped: Vec<Skipped>,
  /// Ссылки `http(s)://` из входа — адреса подписок.
  pub subscription_urls: Vec<String>,
}

/// Разбирает текст: одну ссылку, список ссылок по строкам, подписку в base64 целиком или с base64-блоками
/// внутри строк. Не паникует и не возвращает значений ключей в текстах причин.
pub fn parse_text(text: &str) -> Parsed {
  let mut out = Parsed::default();
  if text.len() > MAX_INPUT_LEN {
    out.skipped.push(Skipped { scheme: "?".into(), reason: "вход слишком большой".into() });
    return out;
  }
  let mut seen = HashSet::new();
  collect(text, 0, &mut out, &mut seen);
  out
}

fn collect(text: &str, depth: u8, out: &mut Parsed, seen: &mut HashSet<String>) {
  let text = text.trim_start_matches('\u{feff}').trim();
  let lines: Vec<&str> = text.split(['\r', '\n']).map(str::trim).filter(|line| !line.is_empty()).collect();
  let has_scheme = lines.iter().any(|line| scheme_of(line).is_some());
  if !has_scheme && depth < 2 {
    // Вся подписка — один base64-блок (стандарт v2rayN), возможно с переносами строк
    let compact: String = text.chars().filter(|c| !c.is_whitespace()).collect();
    if looks_like_base64(&compact) {
      if let Some(decoded) = decode_to_text(&compact) {
        if decoded.contains("://") {
          collect(&decoded, depth + 1, out, seen);
          return;
        }
      }
    }
  }
  for line in lines {
    if out.nodes.len() >= MAX_NODES { return; }
    match scheme_of(line) {
      Some(scheme) if scheme == "http" || scheme == "https" => {
        if !out.subscription_urls.iter().any(|known| known == line) { out.subscription_urls.push(line.to_string()); }
      }
      Some(scheme) => {
        if !seen.insert(line.to_string()) { continue; }
        match parse_link(line) {
          Ok(node) => out.nodes.push(node),
          Err(error) => out.skipped.push(Skipped { scheme, reason: error.to_string() }),
        }
      }
      None if depth < 2 && looks_like_base64(line) => {
        match decode_to_text(line) {
          Some(decoded) if decoded.contains("://") => collect(&decoded, depth + 1, out, seen),
          _ => out.skipped.push(Skipped { scheme: "?".into(), reason: "строка не распознана".into() }),
        }
      }
      None => out.skipped.push(Skipped { scheme: "?".into(), reason: "строка не распознана".into() }),
    }
  }
}

/// Разбирает одну ссылку на узел.
pub fn parse_link(raw: &str) -> Result<Node, UriError> {
  let raw = raw.trim();
  if raw.len() > MAX_LINK_LEN { return Err(UriError::Malformed("слишком длинная")); }
  let scheme = scheme_of(raw).ok_or(UriError::Malformed("нет схемы"))?;
  match scheme.as_str() {
    "vless" => parse_vless(raw),
    "vmess" => parse_vmess(raw),
    "trojan" => parse_trojan(raw),
    "ss" => parse_ss(raw),
    other => Err(UriError::UnsupportedProtocol(other.to_string())),
  }
}

/// Схема до `://` — только буквы, цифры и `+-.`, до 16 символов, в нижнем регистре.
fn scheme_of(raw: &str) -> Option<String> {
  let index = raw.find("://")?;
  if index == 0 || index > 16 { return None; }
  let scheme = &raw[..index];
  if !scheme.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.')) { return None; }
  Some(scheme.to_ascii_lowercase())
}

// ---------- vless / trojan ----------

struct Parts {
  user: String,
  password: Option<String>,
  host: String,
  port: Option<u16>,
  query: BTreeMap<String, String>,
  fragment: String,
}

fn split_url(raw: &str) -> Result<Parts, UriError> {
  let url = url::Url::parse(raw).map_err(|_| UriError::Malformed("адрес"))?;
  let host = url.host_str().unwrap_or("").trim_start_matches('[').trim_end_matches(']').to_string();
  if host.is_empty() { return Err(UriError::MissingField("host")); }
  let mut query = BTreeMap::new();
  for (key, value) in url.query_pairs() {
    query.entry(key.into_owned()).or_insert_with(|| value.into_owned());
  }
  Ok(Parts {
    user: percent_decode(url.username()),
    password: url.password().map(percent_decode),
    host,
    port: url.port(),
    query,
    fragment: percent_decode(url.fragment().unwrap_or("")),
  })
}

fn parse_vless(raw: &str) -> Result<Node, UriError> {
  let parts = split_url(raw)?;
  if parts.user.is_empty() { return Err(UriError::MissingField("id")); }
  let stream = build_stream(&parts.query, "none", &parts.host)?;
  let query = &parts.query;
  Ok(Node {
    name: parts.fragment.clone(),
    server: parts.host.clone(),
    port: parts.port.unwrap_or(443),
    proto: Proto::Vless {
      id: parts.user.clone(),
      flow: param(query, &["flow"]).to_string(),
      encryption: Some(param(query, &["encryption"])).filter(|v| !v.is_empty()).unwrap_or("none").to_string(),
    },
    stream,
  })
}

fn parse_trojan(raw: &str) -> Result<Node, UriError> {
  let parts = split_url(raw)?;
  let password = match &parts.password {
    Some(pass) => format!("{}:{}", parts.user, percent_decode(pass)),
    None => parts.user.clone(),
  };
  if password.is_empty() { return Err(UriError::MissingField("password")); }
  let stream = build_stream(&parts.query, "tls", &parts.host)?;
  Ok(Node {
    name: parts.fragment.clone(),
    server: parts.host.clone(),
    port: parts.port.unwrap_or(443),
    proto: Proto::Trojan { password },
    stream,
  })
}

fn param<'a>(query: &'a BTreeMap<String, String>, keys: &[&str]) -> &'a str {
  for key in keys {
    if let Some(value) = query.get(*key) { return value; }
  }
  ""
}

/// Общий разбор транспорта и защиты из query (vless, trojan).
fn build_stream(query: &BTreeMap<String, String>, default_security: &str, host: &str) -> Result<Stream, UriError> {
  let mut stream = Stream::plain();
  stream.network = network_of(param(query, &["type", "network"]))?;
  let security = match param(query, &["security"]) {
    "" => default_security,
    other => other,
  };
  stream.security = match security.to_ascii_lowercase().as_str() {
    "none" => Security::None,
    "tls" | "xtls" => Security::Tls,
    "reality" => Security::Reality,
    _ => return Err(UriError::Malformed("защита транспорта")),
  };
  stream.sni = param(query, &["sni", "peer", "serverName"]).to_string();
  if let Some(fp) = Some(param(query, &["fp", "fingerprint"])).filter(|v| !v.is_empty()) { stream.fingerprint = fp.to_string(); }
  stream.alpn = param(query, &["alpn"]).split(',').map(str::trim).filter(|v| !v.is_empty()).map(String::from).collect();
  stream.public_key = param(query, &["pbk", "publicKey"]).to_string();
  stream.short_id = param(query, &["sid", "shortId"]).to_string();
  stream.spider_x = param(query, &["spx", "spiderX"]).to_string();
  stream.path = param(query, &["path"]).to_string();
  stream.host = param(query, &["host"]).to_string();
  stream.mode = param(query, &["mode"]).to_string();
  stream.service_name = param(query, &["serviceName", "servicename"]).to_string();
  if let Ok(extra) = serde_json::from_str::<serde_json::Value>(param(query, &["extra"])) {
    if extra.is_object() { stream.extra = Some(extra); }
  }
  if stream.security == Security::Reality && stream.public_key.is_empty() { return Err(UriError::MissingField("pbk")); }
  if stream.security != Security::None && stream.sni.is_empty() { stream.sni = host.to_string(); }
  Ok(stream)
}

fn network_of(name: &str) -> Result<Network, UriError> {
  match name.to_ascii_lowercase().as_str() {
    "" | "tcp" | "raw" => Ok(Network::Tcp),
    "ws" | "websocket" => Ok(Network::Ws),
    "grpc" | "gun" => Ok(Network::Grpc),
    "xhttp" | "splithttp" => Ok(Network::Xhttp),
    "httpupgrade" => Ok(Network::HttpUpgrade),
    other => Err(UriError::UnsupportedTransport(other.chars().filter(char::is_ascii_alphanumeric).take(12).collect())),
  }
}

// ---------- vmess ----------

fn parse_vmess(raw: &str) -> Result<Node, UriError> {
  let payload = raw.get("vmess://".len()..).unwrap_or("");
  let payload = payload.split('#').next().unwrap_or("").trim();
  let json = decode_to_text(payload).ok_or(UriError::Malformed("base64"))?;
  let value: serde_json::Value = serde_json::from_str(&json).map_err(|_| UriError::Malformed("json"))?;
  let object = value.as_object().ok_or(UriError::Malformed("json"))?;
  let text = |key: &str| -> String {
    match object.get(key) {
      Some(serde_json::Value::String(s)) => s.trim().to_string(),
      Some(serde_json::Value::Number(n)) => n.to_string(),
      Some(serde_json::Value::Bool(b)) => b.to_string(),
      _ => String::new(),
    }
  };
  let server = text("add");
  if server.is_empty() { return Err(UriError::MissingField("add")); }
  let id = text("id");
  if id.is_empty() { return Err(UriError::MissingField("id")); }
  let port = match text("port").parse::<u16>() {
    Ok(port) if port > 0 => port,
    _ => return Err(UriError::Malformed("порт")),
  };
  let mut stream = Stream::plain();
  stream.network = network_of(&text("net"))?;
  let tls = text("tls");
  if matches!(tls.as_str(), "tls" | "true" | "1") { stream.security = Security::Tls; }
  stream.sni = text("sni");
  stream.host = text("host");
  if stream.security == Security::Tls && stream.sni.is_empty() { stream.sni = server.clone(); }
  let fp = text("fp");
  if !fp.is_empty() { stream.fingerprint = fp; }
  stream.alpn = text("alpn").split(',').map(str::trim).filter(|v| !v.is_empty()).map(String::from).collect();
  if stream.network == Network::Grpc {
    stream.service_name = text("path");
  } else {
    stream.path = text("path");
  }
  let scy = Some(text("scy")).filter(|v| !v.is_empty()).unwrap_or_else(|| "auto".into());
  Ok(Node {
    name: text("ps"),
    server,
    port,
    proto: Proto::Vmess { id, alter_id: text("aid").parse().unwrap_or(0), security: scy },
    stream,
  })
}

// ---------- shadowsocks ----------

fn parse_ss(raw: &str) -> Result<Node, UriError> {
  let payload = raw.get("ss://".len()..).unwrap_or("");
  let (before_hash, name) = match payload.split_once('#') {
    Some((head, tail)) => (head, percent_decode(tail)),
    None => (payload, String::new()),
  };
  let (before_query, query_text) = match before_hash.split_once('?') {
    Some((head, tail)) => (head, tail),
    None => (before_hash, ""),
  };
  let before_query = before_query.trim_end_matches('/');
  // Плагины (obfs, v2ray-plugin) Xray не умеет — такой узел не создаём
  for pair in query_text.split('&') {
    if let Some(("plugin", value)) = pair.split_once('=') {
      if !value.is_empty() { return Err(UriError::UnsupportedTransport("plugin".into())); }
    }
  }
  // Старый формат: base64(method:password@host:port) целиком
  let decoded_whole;
  let host_part: &str = if before_query.contains('@') {
    before_query
  } else {
    decoded_whole = decode_to_text(before_query).ok_or(UriError::Malformed("base64"))?;
    &decoded_whole
  };
  let at = host_part.rfind('@').ok_or(UriError::Malformed("нет адреса"))?;
  let (auth_raw, endpoint) = (&host_part[..at], &host_part[at + 1..]);
  let auth = if auth_raw.contains(':') {
    percent_decode(auth_raw)
  } else {
    decode_to_text(&percent_decode(auth_raw)).ok_or(UriError::Malformed("base64"))?
  };
  let (method, password) = auth.split_once(':').ok_or(UriError::Malformed("метод и пароль"))?;
  if method.is_empty() { return Err(UriError::MissingField("method")); }
  if password.is_empty() { return Err(UriError::MissingField("password")); }
  let (server, port) = split_endpoint(endpoint).ok_or(UriError::Malformed("адрес"))?;
  Ok(Node {
    name,
    server,
    port,
    proto: Proto::Shadowsocks { method: method.to_string(), password: password.to_string() },
    stream: Stream::plain(),
  })
}

fn split_endpoint(endpoint: &str) -> Option<(String, u16)> {
  let endpoint = endpoint.trim_end_matches('/');
  let (host, port) = if let Some(rest) = endpoint.strip_prefix('[') {
    let (host, tail) = rest.split_once(']')?;
    (host, tail.strip_prefix(':')?)
  } else {
    endpoint.rsplit_once(':')?
  };
  let port: u16 = port.parse().ok().filter(|p| *p > 0)?;
  if host.is_empty() { return None; }
  Some((host.to_string(), port))
}

// ---------- base64 и проценты ----------

/// Похоже на base64-блок: допустимые символы, длина от 16.
fn looks_like_base64(text: &str) -> bool {
  text.len() >= 16
    && text.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '-' | '_' | '='))
}

/// Мягкое декодирование base64 (обычный и URL-алфавит, без обязательных `=`), результат — UTF-8.
pub(crate) fn decode_to_text(value: &str) -> Option<String> {
  let bytes = decode_base64(value);
  if bytes.is_empty() { return None; }
  String::from_utf8(bytes).ok()
}

/// Декодер base64: пропускает неизвестные символы; `=` закрывает блок (склеенные блоки допустимы).
pub(crate) fn decode_base64(value: &str) -> Vec<u8> {
  let mut out = Vec::with_capacity(value.len() * 3 / 4 + 3);
  let (mut acc, mut bits) = (0u32, 0u32);
  for c in value.chars() {
    let v = match c {
      'A'..='Z' => c as u32 - 'A' as u32,
      'a'..='z' => c as u32 - 'a' as u32 + 26,
      '0'..='9' => c as u32 - '0' as u32 + 52,
      '+' | '-' => 62,
      '/' | '_' => 63,
      '=' => { acc = 0; bits = 0; continue; }
      _ => continue,
    };
    acc = (acc << 6) | v;
    bits += 6;
    if bits >= 8 {
      bits -= 8;
      out.push(((acc >> bits) & 0xFF) as u8);
      acc &= (1 << bits) - 1;
    }
  }
  out
}

/// Декодирует `%XX`; некорректные последовательности остаются как есть.
pub(crate) fn percent_decode(value: &str) -> String {
  let bytes = value.as_bytes();
  let mut out = Vec::with_capacity(bytes.len());
  let mut i = 0;
  while i < bytes.len() {
    if bytes[i] == b'%' && i + 2 < bytes.len() {
      let hex = |b: u8| (b as char).to_digit(16);
      if let (Some(high), Some(low)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
        out.push((high * 16 + low) as u8);
        i += 3;
        continue;
      }
    }
    out.push(bytes[i]);
    i += 1;
  }
  String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
  use super::*;

  const UUID: &str = "00000000-0000-0000-0000-000000000000";

  fn encode_base64(data: &[u8], url_safe: bool, pad: bool) -> String {
    let alphabet: &[u8] = if url_safe {
      b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    } else {
      b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
    };
    let mut out = String::new();
    for chunk in data.chunks(3) {
      let n = (u32::from(chunk[0]) << 16) | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8) | u32::from(*chunk.get(2).unwrap_or(&0));
      for i in 0..4 {
        if i <= chunk.len() {
          out.push(alphabet[((n >> (18 - 6 * i)) & 63) as usize] as char);
        } else if pad {
          out.push('=');
        }
      }
    }
    out
  }

  #[test]
  fn vless_reality_tcp_with_flow() {
    let link = format!("vless://{UUID}@example.com:443?type=tcp&security=reality&flow=xtls-rprx-vision&fp=firefox&sni=www.example.org&pbk=FAKEPUBLICKEY&sid=ab12&spx=%2F#My%20Node");
    let node = parse_link(&link).unwrap();
    assert_eq!((node.server.as_str(), node.port, node.name.as_str()), ("example.com", 443, "My Node"));
    match &node.proto {
      Proto::Vless { id, flow, encryption } => {
        assert_eq!(id, UUID);
        assert_eq!(flow, "xtls-rprx-vision");
        assert_eq!(encryption, "none");
      }
      _ => panic!("ожидался vless"),
    }
    let s = &node.stream;
    assert_eq!((s.network, s.security), (Network::Tcp, Security::Reality));
    assert_eq!((s.fingerprint.as_str(), s.sni.as_str(), s.public_key.as_str(), s.short_id.as_str(), s.spider_x.as_str()),
      ("firefox", "www.example.org", "FAKEPUBLICKEY", "ab12", "/"));
  }

  #[test]
  fn vless_reality_requires_public_key() {
    let link = format!("vless://{UUID}@example.com:443?security=reality&sni=a.example.org");
    assert_eq!(parse_link(&link), Err(UriError::MissingField("pbk")));
  }

  #[test]
  fn vless_xhttp_tls_and_splithttp_alias() {
    let link = format!("vless://{UUID}@example.com:8443?type=splithttp&security=tls&path=%2Fxh&host=cdn.example.org&mode=packet-up&alpn=h2,http/1.1&extra=%7B%22xPaddingBytes%22%3A%22100-200%22%7D");
    let node = parse_link(&link).unwrap();
    let s = &node.stream;
    assert_eq!((s.network, s.security), (Network::Xhttp, Security::Tls));
    assert_eq!((s.path.as_str(), s.host.as_str(), s.mode.as_str()), ("/xh", "cdn.example.org", "packet-up"));
    assert_eq!(s.alpn, vec!["h2", "http/1.1"]);
    assert_eq!(s.sni, "example.com");
    assert_eq!(s.extra.as_ref().unwrap()["xPaddingBytes"], "100-200");
  }

  #[test]
  fn vless_ws_grpc_and_ipv6() {
    let ws = parse_link(&format!("vless://{UUID}@[2001:db8::1]:2053?type=ws&path=/w&host=h.example.org&security=tls")).unwrap();
    assert_eq!((ws.server.as_str(), ws.stream.network), ("2001:db8::1", Network::Ws));
    let grpc = parse_link(&format!("vless://{UUID}@example.com:443?type=grpc&serviceName=svc&security=tls")).unwrap();
    assert_eq!((grpc.stream.network, grpc.stream.service_name.as_str()), (Network::Grpc, "svc"));
  }

  #[test]
  fn vless_rejects_kcp_h2_and_missing_id() {
    // h2 убран из Xray 26 (перенесён в xhttp stream-one) и узел с ним не заработает
    assert!(matches!(parse_link(&format!("vless://{UUID}@example.com:443?type=h2&security=tls")), Err(UriError::UnsupportedTransport(_))));
    assert!(matches!(parse_link(&format!("vless://{UUID}@example.com:443?type=kcp")), Err(UriError::UnsupportedTransport(_))));
    assert_eq!(parse_link("vless://@example.com:443"), Err(UriError::MissingField("id")));
  }

  #[test]
  fn vmess_from_base64_json() {
    let json = format!(r#"{{"v":"2","ps":"vm","add":"example.com","port":"443","id":"{UUID}","aid":"0","scy":"auto","net":"ws","host":"h.example.org","path":"/p","tls":"tls","sni":"s.example.org"}}"#);
    let link = format!("vmess://{}", encode_base64(json.as_bytes(), false, true));
    let node = parse_link(&link).unwrap();
    assert_eq!((node.name.as_str(), node.server.as_str(), node.port), ("vm", "example.com", 443));
    assert_eq!((node.stream.network, node.stream.security), (Network::Ws, Security::Tls));
    assert_eq!((node.stream.sni.as_str(), node.stream.path.as_str(), node.stream.host.as_str()), ("s.example.org", "/p", "h.example.org"));
    assert!(matches!(node.proto, Proto::Vmess { alter_id: 0, .. }));
  }

  #[test]
  fn trojan_default_tls_and_password_with_colon() {
    let node = parse_link("trojan://user:p%40ss@example.com:443?sni=t.example.org#tj").unwrap();
    assert_eq!(node.stream.security, Security::Tls);
    assert_eq!(node.stream.sni, "t.example.org");
    assert!(matches!(&node.proto, Proto::Trojan { password } if password == "user:p@ss"));
  }

  #[test]
  fn shadowsocks_sip002_plain_and_legacy() {
    let sip = format!("ss://{}@example.com:8388#ss1", encode_base64(b"aes-256-gcm:pw1", true, false));
    let node = parse_link(&sip).unwrap();
    assert_eq!((node.server.as_str(), node.port, node.name.as_str()), ("example.com", 8388, "ss1"));
    assert!(matches!(&node.proto, Proto::Shadowsocks { method, password } if method == "aes-256-gcm" && password == "pw1"));

    let plain = parse_link("ss://chacha20-ietf-poly1305:pw2@example.com:1234/?#p").unwrap();
    assert!(matches!(&plain.proto, Proto::Shadowsocks { method, password } if method == "chacha20-ietf-poly1305" && password == "pw2"));

    let legacy = format!("ss://{}#old", encode_base64(b"aes-128-gcm:pw3@example.net:4443", false, true));
    let node = parse_link(&legacy).unwrap();
    assert_eq!((node.server.as_str(), node.port), ("example.net", 4443));

    let with_plugin = format!("ss://{}@example.com:8388/?plugin=obfs-local", encode_base64(b"aes-256-gcm:pw", true, false));
    assert!(matches!(parse_link(&with_plugin), Err(UriError::UnsupportedTransport(_))));
  }

  #[test]
  fn subscription_forms() {
    let a = format!("vless://{UUID}@a.example.com:443?security=none#a");
    let b = "trojan://pw@b.example.com:443#b";
    let skip = "hy2://pw@c.example.com:443#c";
    let text = format!("{a}\n{b}\n{skip}\nssr://abc\nhttps://sub.example.com/x\n");

    let plain = parse_text(&text);
    assert_eq!(plain.nodes.len(), 2);
    assert_eq!(plain.skipped.len(), 2);
    assert_eq!(plain.skipped[0].scheme, "hy2");
    assert_eq!(plain.subscription_urls, vec!["https://sub.example.com/x"]);

    let whole = parse_text(&encode_base64(text.as_bytes(), false, true));
    assert_eq!(whole.nodes.len(), 2);

    let wrapped: String = encode_base64(text.as_bytes(), false, true).as_bytes().chunks(20)
      .map(|c| std::str::from_utf8(c).unwrap()).collect::<Vec<_>>().join("\n");
    assert_eq!(parse_text(&wrapped).nodes.len(), 2);

    let inline = format!("{a}\n{}\n", encode_base64(b"trojan://pw@d.example.com:443#d", true, false));
    assert_eq!(parse_text(&inline).nodes.len(), 2);

    assert_eq!(parse_text(&format!("{a}\n{a}")).nodes.len(), 1);
    assert!(parse_text("").nodes.is_empty());
    assert!(parse_text("просто текст").nodes.is_empty());
  }

  #[test]
  fn errors_and_debug_do_not_leak_secrets() {
    let secret = "SECRETKEYVALUE123456";
    let link = format!("vless://{secret}@leak.example.com:443?security=reality&sni=x.example.org");
    let error = parse_link(&link).unwrap_err().to_string();
    assert!(!error.contains(secret) && !error.contains("leak.example.com"), "{error}");
    let ok = parse_link(&format!("vless://{secret}@leak.example.com:443?security=none")).unwrap();
    assert!(!format!("{ok:?}").contains(secret));
    let parsed = parse_text(&format!("hy2://{secret}@leak.example.com:443\nvmess://%%%{secret}"));
    for skipped in &parsed.skipped {
      assert!(!skipped.reason.contains(secret) && !skipped.scheme.contains(secret));
    }
  }

  #[test]
  fn percent_decode_edge_cases() {
    assert_eq!(percent_decode("a%20b%2"), "a b%2");
    assert_eq!(percent_decode("%"), "%");
    assert_eq!(percent_decode("%zz"), "%zz");
    assert_eq!(percent_decode("%D0%AF"), "Я");
  }

  #[test]
  fn oversized_input_is_rejected() {
    assert!(parse_link(&format!("vless://{UUID}@example.com:443?x={}", "a".repeat(MAX_LINK_LEN))).is_err());
  }
}
