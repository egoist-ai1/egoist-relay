//! Генератор конфига Xray по схеме контракта `docs/product-cycle-2026-10-13/NETWORK-TUNNEL.md`.
//!
//! Схема: 3 loopback-TCP-inbound (socks, два http для проб) и api-inbound на защищённом unix-сокете, outbounds `proxy` / `direct` / `block`,
//! балансер `active` (selector `proxy`, fallback `direct`), приватный DoH с bootstrap через `https+local`.
//! Вся сеть приложения идёт в балансер; переключение ступеней делает Rust через `xray api bo`.

use super::uri::{Network, Node, Proto, Security, Stream};
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::BTreeMap;

/// Стратегия доменов исходящего `proxy`: Xray сам разрешает имена через DoH владельца и отдаёт серверу IP.
/// Цена — +1 RTT на новый домен. Если на замерах появятся лаги, переключить на `"AsIs"`.
pub const PROXY_DOMAIN_STRATEGY: &str = "UseIPv4";
/// Таймаут приватного DoH, мс: после него запрос уходит на резерв (по умолчанию в Xray 4000).
pub const DOH_TIMEOUT_MS: u32 = 2000;
/// Сколько секунд после истечения TTL кэш DNS отдаёт старый ответ, пока запись обновляется в фоне.
pub const SERVE_EXPIRED_TTL_S: u32 = 300;
/// Публичный DoH как резерв, когда приватный недоступен (иначе истёкший DoH валит обе ступени).
pub const DOH_PUBLIC_FALLBACK: bool = true;
/// Публичные DoH для bootstrap и резерва: `https+local` — запрос идёт напрямую, мимо маршрутизации.
const PUBLIC_DOH_PRIMARY: &str = "https+local://1.1.1.1/dns-query";
const PUBLIC_DOH_SECONDARY: &str = "https+local://8.8.8.8/dns-query";

/// Диапазон, из которого выбираются порты.
pub const PORT_RANGE: (u16, u16) = (20000, 60000);
/// Порты Egoist Lagom — не используются никогда.
pub const LAGOM_EXCLUDED: [(u16, u16); 2] = [(10808, 10909), (10085, 10185)];

/// Частные и служебные сети (содержимое `geoip:private`). Список задан явно: `geoip.dat` в поставку не входит,
/// а правило `geoip:private` без этого файла не даёт Xray запуститься.
pub const PRIVATE_NETS: [&str; 12] = [
  "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12",
  "192.0.0.0/24", "192.168.0.0/16", "198.18.0.0/15", "::1/128", "fc00::/7", "fe80::/10",
];

pub const TAG_SOCKS_IN: &str = "socks-in";
pub const TAG_API_IN: &str = "api";
pub const TAG_PROBE_PROXY_IN: &str = "probe-proxy";
pub const TAG_PROBE_DIRECT_IN: &str = "probe-direct";
pub const TAG_DNS: &str = "dns-internal";
pub const TAG_BALANCER: &str = "active";
pub const TAG_PROXY: &str = "proxy";
pub const TAG_DIRECT: &str = "direct";
pub const TAG_BLOCK: &str = "block";
pub const TAG_PROBE_BALANCER: &str = "probe";

/// Три loopback-порта сессии. API Xray портов не занимает: он слушает unix-сокет в защищённом каталоге.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Ports {
  /// SOCKS5 для всего трафика приложения (`udp:false`).
  pub socks: u16,
  /// HTTP-прокси проб, всегда в `proxy`.
  pub probe_proxy: u16,
  /// HTTP-прокси проб, всегда в `direct`.
  pub probe_direct: u16,
}

impl Ports {
  /// Список портов в порядке inbound'ов.
  pub fn all(&self) -> [u16; 3] {
    [self.socks, self.probe_proxy, self.probe_direct]
  }

  /// Порт допустим: в рабочем диапазоне и вне диапазонов Lagom.
  pub fn is_allowed(port: u16) -> bool {
    (PORT_RANGE.0..=PORT_RANGE.1).contains(&port)
      && !LAGOM_EXCLUDED.iter().any(|(from, to)| (*from..=*to).contains(&port))
  }

  /// Все три порта допустимы и различны.
  pub fn validate(&self) -> Result<(), String> {
    let all = self.all();
    if !all.iter().all(|port| Self::is_allowed(*port)) { return Err("TUNNEL_PORT_NOT_ALLOWED".into()); }
    for (i, a) in all.iter().enumerate() {
      if all[i + 1..].contains(a) { return Err("TUNNEL_PORT_DUPLICATE".into()); }
    }
    Ok(())
  }
}

/// Вход генератора.
pub struct ConfigInput<'a> {
  pub ports: Ports,
  /// Абсолютный путь unix-сокета API Xray (каталог с защищённым DACL создаёт `tunnel::start`).
  pub api_socket: &'a str,
  /// Узел VPN. `None` — outbound `proxy` не создаётся, балансер сразу падает в `direct` (ступень 2).
  pub node: Option<&'a Node>,
  /// Приватный DoH: `https://host[:port]/dns-query`.
  pub doh: &'a str,
  /// Кэш IP по именам хостов (хост VPN, хост DoH): попадает в `dns.hosts`, минуя bootstrap.
  pub host_ips: &'a BTreeMap<String, Vec<String>>,
  /// Хосты всех узлов подписки: чтобы после смены узла его имя тоже разрешалось в обход туннеля.
  pub node_hosts: &'a [String],
}

/// Собирает полный конфиг Xray. Ошибка — только при недопустимых портах или адресе DoH.
pub fn build(input: &ConfigInput) -> Result<Value, String> {
  input.ports.validate()?;
  let api_listen = api_listen(input.api_socket)?;
  let doh_host = doh_host(input.doh)?;
  let ports = input.ports;
  let has_proxy = input.node.is_some();

  let mut outbounds = Vec::new();
  if let Some(node) = input.node { outbounds.push(outbound(node)); }
  // domainStrategy у freedom устарел (Xray 26): задаётся через sockopt
  outbounds.push(json!({ "tag": TAG_DIRECT, "protocol": "freedom", "settings": {},
    "streamSettings": { "sockopt": { "domainStrategy": "UseIPv4" } } }));
  outbounds.push(json!({ "tag": TAG_BLOCK, "protocol": "blackhole", "settings": {} }));

  // Проба туннеля идёт через свой балансер: при смене узла (`proxy-r1`, …) правило не ломается,
  // а принудительный выбор `direct` в балансере `active` на неё не влияет
  let probe_rule = if has_proxy {
    json!({ "type": "field", "inboundTag": [TAG_PROBE_PROXY_IN], "balancerTag": TAG_PROBE_BALANCER })
  } else {
    json!({ "type": "field", "inboundTag": [TAG_PROBE_PROXY_IN], "outboundTag": TAG_BLOCK })
  };
  // Без узла балансер не нужен (селектору нечего выбирать): весь трафик сразу идёт в `direct`
  let route_to = |inbound: &str| if has_proxy {
    json!({ "type": "field", "inboundTag": [inbound], "balancerTag": TAG_BALANCER })
  } else {
    json!({ "type": "field", "inboundTag": [inbound], "outboundTag": TAG_DIRECT })
  };
  let rules = json!([
    { "type": "field", "inboundTag": [TAG_API_IN], "outboundTag": TAG_API_IN },
    probe_rule,
    { "type": "field", "inboundTag": [TAG_PROBE_DIRECT_IN], "outboundTag": TAG_DIRECT },
    { "type": "field", "ip": PRIVATE_NETS, "outboundTag": TAG_BLOCK },
    route_to(TAG_DNS),
    route_to(TAG_SOCKS_IN),
  ]);

  // fallbackTag не используется: в этой сборке Xray он требует observatory ("not all dependencies are resolved").
  // Ступень 2 включается принудительно: `xray api bo -b active direct`
  let mut balancers = Vec::new();
  if has_proxy {
    balancers.push(json!({ "tag": TAG_BALANCER, "selector": [TAG_PROXY] }));
    balancers.push(json!({ "tag": TAG_PROBE_BALANCER, "selector": [TAG_PROXY] }));
  }

  Ok(json!({
    "log": { "loglevel": "warning", "access": "none", "dnsLog": false },
    "api": { "tag": TAG_API_IN, "services": ["HandlerService", "RoutingService"] },
    "dns": dns_section(input, &doh_host),
    "inbounds": [
      { "tag": TAG_SOCKS_IN, "listen": "127.0.0.1", "port": ports.socks, "protocol": "socks",
        "settings": { "auth": "noauth", "udp": false } },
      // Поле `port` у unix-сокета ставить нельзя: Xray падает с panic strconv.Atoi при первом подключении.
      // Порт в `settings` формальный: dokodemo-door требует адрес назначения, а API его не использует.
      { "tag": TAG_API_IN, "listen": api_listen, "protocol": "dokodemo-door",
        "settings": { "address": "127.0.0.1", "port": 1 } },
      { "tag": TAG_PROBE_PROXY_IN, "listen": "127.0.0.1", "port": ports.probe_proxy, "protocol": "http",
        "settings": {} },
      { "tag": TAG_PROBE_DIRECT_IN, "listen": "127.0.0.1", "port": ports.probe_direct, "protocol": "http",
        "settings": {} },
    ],
    "outbounds": outbounds,
    "routing": {
      "domainStrategy": "AsIs",
      "rules": rules,
      "balancers": balancers,
    },
  }))
}

/// Предел длины пути сокета: у `sockaddr_un` 108 байт, берём запас на служебные символы.
pub const API_SOCKET_MAX_BYTES: usize = 100;

/// Путь сокета в формате Xray: абсолютный, с `/` вместо `\\`. Недопустимый путь — ошибка старта, не тихая поломка.
fn api_listen(path: &str) -> Result<String, String> {
  let normalized = path.replace('\\', "/");
  let drive = normalized.as_bytes();
  let absolute = (drive.len() > 2 && drive[0].is_ascii_alphabetic() && drive[1] == b':' && drive[2] == b'/')
    || normalized.starts_with('/');
  if !absolute || normalized.len() > API_SOCKET_MAX_BYTES || normalized.contains('"') || normalized.contains('\0') {
    return Err("TUNNEL_API_SOCKET_INVALID".into());
  }
  Ok(normalized)
}

/// Хост из адреса приватного DoH; допускается только `https` с путём.
fn doh_host(doh: &str) -> Result<String, String> {
  let url = url::Url::parse(doh).map_err(|_| "TUNNEL_DOH_INVALID")?;
  if url.scheme() != "https" || url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() {
    return Err("TUNNEL_DOH_INVALID".into());
  }
  Ok(url.host_str().unwrap_or("").to_string())
}

fn is_ip_literal(host: &str) -> bool {
  host.trim_matches(['[', ']']).parse::<std::net::IpAddr>().is_ok()
}

fn dns_section(input: &ConfigInput, doh_host: &str) -> Value {
  // Bootstrap: имена хоста DoH и хоста VPN разрешаются публичным DoH напрямую (без них нет ни DoH, ни туннеля)
  let mut bootstrap_domains: Vec<String> = Vec::new();
  let mut push_host = |host: &str| {
    let entry = format!("full:{host}");
    if !is_ip_literal(host) && !bootstrap_domains.contains(&entry) { bootstrap_domains.push(entry); }
  };
  push_host(doh_host);
  if let Some(node) = input.node { push_host(&node.server); }
  for host in input.node_hosts { push_host(host); }

  let mut servers = Vec::new();
  if !bootstrap_domains.is_empty() {
    // Два независимых публичных резолвера: падение одного не оставляет хост VPN без адреса
    servers.push(json!({ "address": PUBLIC_DOH_PRIMARY, "domains": bootstrap_domains, "skipFallback": true }));
    servers.push(json!({ "address": PUBLIC_DOH_SECONDARY, "domains": bootstrap_domains, "skipFallback": true }));
  }
  // Приватный DoH идёт через туннель: зависший пул HTTP/2 не должен держать новое соединение 4 с (по умолчанию)
  servers.push(json!({ "address": input.doh, "timeoutMs": DOH_TIMEOUT_MS }));
  if DOH_PUBLIC_FALLBACK {
    servers.push(json!(PUBLIC_DOH_PRIMARY));
    servers.push(json!(PUBLIC_DOH_SECONDARY));
  }

  let mut hosts = serde_json::Map::new();
  let mut cached = |host: &str| {
    if let Some(ips) = input.host_ips.get(host).filter(|ips| !ips.is_empty()) {
      hosts.insert(host.to_string(), json!(ips));
    }
  };
  cached(doh_host);
  if let Some(node) = input.node { cached(&node.server); }
  for host in input.node_hosts { cached(host); }

  json!({ "tag": TAG_DNS, "servers": servers, "hosts": hosts, "queryStrategy": "UseIPv4",
    "serveStale": true, "serveExpiredTTL": SERVE_EXPIRED_TTL_S })
}

/// Исходящее `proxy` из узла, uTLS по умолчанию chrome.
pub fn outbound(node: &Node) -> Value {
  outbound_with_tag(node, TAG_PROXY)
}

/// То же с другим тегом: при смене узла новый outbound добавляется под тегом `proxy-rN` (селектор балансера
/// выбирает по префиксу `proxy`), затем удаляется старый, и окна без туннеля не возникает.
pub fn outbound_with_tag(node: &Node, tag: &str) -> Value {
  let address = node.server.as_str();
  let settings = match &node.proto {
    Proto::Vless { id, flow, encryption } => {
      let mut user = json!({ "id": id, "encryption": encryption });
      if !flow.is_empty() { user["flow"] = json!(flow); }
      json!({ "vnext": [ { "address": address, "port": node.port, "users": [user] } ] })
    }
    Proto::Vmess { id, alter_id, security } => json!({
      "vnext": [ { "address": address, "port": node.port,
        "users": [ { "id": id, "alterId": alter_id, "security": security } ] } ]
    }),
    Proto::Trojan { password } => json!({
      "servers": [ { "address": address, "port": node.port, "password": password } ]
    }),
    Proto::Shadowsocks { method, password } => json!({
      "servers": [ { "address": address, "port": node.port, "method": method, "password": password } ]
    }),
  };
  json!({
    "tag": tag,
    "protocol": match node.proto {
      Proto::Vless { .. } => "vless",
      Proto::Vmess { .. } => "vmess",
      Proto::Trojan { .. } => "trojan",
      Proto::Shadowsocks { .. } => "shadowsocks",
    },
    "settings": settings,
    "streamSettings": stream_settings(&node.stream, address),
  })
}

fn non_empty(value: &str) -> Option<&str> {
  Some(value).filter(|v| !v.is_empty())
}

fn stream_settings(stream: &Stream, server: &str) -> Value {
  let mut out = json!({
    "network": stream.network.xray_name(),
    "security": match stream.security { Security::None => "none", Security::Tls => "tls", Security::Reality => "reality" },
    "sockopt": { "domainStrategy": PROXY_DOMAIN_STRATEGY },
  });
  let server_name = non_empty(&stream.sni).unwrap_or(server);
  match stream.security {
    Security::None => {}
    Security::Tls => {
      let mut tls = json!({ "serverName": server_name, "fingerprint": stream.fingerprint });
      if !stream.alpn.is_empty() { tls["alpn"] = json!(stream.alpn); }
      out["tlsSettings"] = tls;
    }
    Security::Reality => {
      let mut reality = json!({
        "serverName": server_name,
        "fingerprint": stream.fingerprint,
        "publicKey": stream.public_key,
        "shortId": stream.short_id,
      });
      if let Some(spx) = non_empty(&stream.spider_x) { reality["spiderX"] = json!(spx); }
      out["realitySettings"] = reality;
    }
  }
  match stream.network {
    Network::Tcp => {}
    Network::Ws => {
      let mut ws = json!({ "path": non_empty(&stream.path).unwrap_or("/") });
      if let Some(host) = non_empty(&stream.host) { ws["headers"] = json!({ "Host": host }); }
      out["wsSettings"] = ws;
    }
    Network::Grpc => out["grpcSettings"] = json!({ "serviceName": stream.service_name }),
    Network::Xhttp => {
      let mut xhttp = json!({
        "path": non_empty(&stream.path).unwrap_or("/"),
        "mode": non_empty(&stream.mode).unwrap_or("auto"),
      });
      if let Some(host) = non_empty(&stream.host) { xhttp["host"] = json!(host); }
      if let Some(extra) = &stream.extra { xhttp["extra"] = extra.clone(); }
      out["xhttpSettings"] = xhttp;
    }
    Network::HttpUpgrade => {
      let mut upgrade = json!({ "path": non_empty(&stream.path).unwrap_or("/") });
      if let Some(host) = non_empty(&stream.host) { upgrade["host"] = json!(host); }
      out["httpupgradeSettings"] = upgrade;
    }
  }
  out
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::tunnel::uri::parse_link;

  const UUID: &str = "00000000-0000-0000-0000-000000000000";
  const PORTS: Ports = Ports { socks: 31001, probe_proxy: 31003, probe_direct: 31004 };
  const SOCK: &str = "C:/Users/test/network/ipc/api-main.sock";
  const DOH: &str = "https://dns.example.net/dns-query";

  /// Сравнение со снимком `src/tunnel/snapshots/<имя>.json`; `UPDATE_SNAPSHOTS=1` перезаписывает снимок.
  fn assert_snapshot(name: &str, value: &Value) {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/tunnel/snapshots").join(format!("{name}.json"));
    let rendered = serde_json::to_string_pretty(value).unwrap() + "\n";
    if std::env::var_os("UPDATE_SNAPSHOTS").is_some() {
      std::fs::create_dir_all(path.parent().unwrap()).unwrap();
      std::fs::write(&path, &rendered).unwrap();
      return;
    }
    let expected = std::fs::read_to_string(&path).unwrap_or_else(|_| panic!("нет снимка {name}: запустите с UPDATE_SNAPSHOTS=1"));
    assert_eq!(rendered, expected.replace("\r\n", "\n"), "снимок {name} разошёлся");
  }

  fn config_for(link: &str) -> Value {
    let node = parse_link(link).unwrap();
    build(&ConfigInput { ports: PORTS, api_socket: SOCK, node: Some(&node), doh: DOH, host_ips: &BTreeMap::new(), node_hosts: &[] }).unwrap()
  }

  fn sample_links() -> Vec<String> {
    vec![
      format!("vless://{UUID}@vpn.example.com:443?type=tcp&security=reality&flow=xtls-rprx-vision&fp=chrome&sni=www.example.org&pbk=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&sid=ab12&spx=%2F#r"),
      format!("vless://{UUID}@vpn.example.com:443?type=xhttp&security=tls&path=%2Fxh&host=cdn.example.org&mode=auto&alpn=h2#x"),
      format!("vless://{UUID}@vpn.example.com:443?type=ws&security=tls&path=%2Fw&host=h.example.org#w"),
      format!("vless://{UUID}@vpn.example.com:443?type=grpc&security=tls&serviceName=svc#g"),
      "trojan://pw@vpn.example.com:443?sni=t.example.org#t".to_string(),
      "ss://aes-256-gcm:pw@192.0.2.10:8388#s".to_string(),
      format!("vless://{UUID}@vpn.example.com:443?type=httpupgrade&security=tls&path=%2Fu&host=h.example.org#hu"),
    ]
  }

  #[test]
  fn snapshot_vless_reality() { assert_snapshot("vless-reality-tcp", &config_for(&sample_links()[0])); }

  #[test]
  fn snapshot_vless_xhttp_tls() { assert_snapshot("vless-xhttp-tls", &config_for(&sample_links()[1])); }

  #[test]
  fn snapshot_shadowsocks_ip_server() { assert_snapshot("ss-ip", &config_for(&sample_links()[5])); }

  #[test]
  fn snapshot_other_transports() {
    let links = sample_links();
    for (name, index) in [("vless-ws-tls", 2), ("vless-grpc-tls", 3), ("trojan-tls", 4), ("vless-httpupgrade", 6)] {
      assert_snapshot(name, &config_for(&links[index]));
    }
  }

  #[test]
  fn snapshot_without_node() {
    let config = build(&ConfigInput { ports: PORTS, api_socket: SOCK, node: None, doh: DOH, host_ips: &BTreeMap::new(), node_hosts: &[] }).unwrap();
    assert_snapshot("no-node", &config);
  }

  #[test]
  fn invariants_hold_for_every_transport() {
    for link in sample_links() {
      let config = config_for(&link);
      // Единственный freedom — direct; proxy ни при каких настройках не freedom
      let freedoms: Vec<&str> = config["outbounds"].as_array().unwrap().iter()
        .filter(|o| o["protocol"] == "freedom").map(|o| o["tag"].as_str().unwrap()).collect();
      assert_eq!(freedoms, vec!["direct"], "{link}");
      assert_ne!(config["outbounds"][0]["protocol"], "freedom");
      // geoip:private -> block
      let rule = config["routing"]["rules"].as_array().unwrap().iter()
        .find(|r| r["ip"] == json!(PRIVATE_NETS)).expect("правило частных сетей");
      assert_eq!(rule["outboundTag"], "block");
      // Все inbounds только на loopback, порты вне Lagom
      let inbounds = config["inbounds"].as_array().unwrap();
      assert_eq!(inbounds.len(), 4);
      let tcp: Vec<&Value> = inbounds.iter().filter(|i| i["tag"] != "api").collect();
      assert_eq!(tcp.len(), 3);
      for inbound in tcp {
        assert_eq!(inbound["listen"], "127.0.0.1");
        let port = inbound["port"].as_u64().unwrap() as u16;
        assert!(!(10808..=10909).contains(&port) && !(10085..=10185).contains(&port));
      }
      // API только на unix-сокете: без поля `port` (иначе panic Xray), с формальным портом назначения 1
      let api = inbounds.iter().find(|i| i["tag"] == "api").unwrap();
      assert!(api["listen"].as_str().unwrap().ends_with(".sock"));
      assert!(api.get("port").is_none());
      assert_eq!(api["settings"]["port"], 1);
      assert_eq!(config["inbounds"][0]["settings"]["udp"], false);
      // Балансер и логи
      assert_eq!(config["routing"]["balancers"][0]["selector"], json!(["proxy"]));
      assert!(config["routing"]["balancers"][0].get("fallbackTag").is_none());
      assert_eq!(config["log"]["loglevel"], "warning");
      assert_eq!(config["log"]["access"], "none");
      assert_eq!(config["api"]["services"], json!(["HandlerService", "RoutingService"]));
      // Правило геозапрета стоит раньше общих правил в балансер
      let rules = config["routing"]["rules"].as_array().unwrap();
      let private = rules.iter().position(|r| r["ip"] == json!(PRIVATE_NETS)).unwrap();
      let first_balancer = rules.iter().position(|r| r["inboundTag"] == json!(["socks-in"])).unwrap();
      assert!(private < first_balancer);
      // Секрета ключа нет нигде, кроме outbound proxy
      let text = serde_json::to_string(&config["inbounds"]).unwrap() + &serde_json::to_string(&config["dns"]).unwrap();
      assert!(!text.contains(UUID));
    }
  }

  #[test]
  fn dns_bootstrap_and_fallback() {
    let config = config_for(&sample_links()[0]);
    let servers = config["dns"]["servers"].as_array().unwrap();
    assert_eq!(servers[0]["address"], PUBLIC_DOH_PRIMARY);
    assert_eq!(servers[0]["skipFallback"], true);
    assert_eq!(servers[0]["domains"], json!(["full:dns.example.net", "full:vpn.example.com"]));
    assert_eq!(servers[1]["address"], PUBLIC_DOH_SECONDARY);
    assert_eq!(servers[1]["skipFallback"], true);
    assert_eq!(servers[1]["domains"], servers[0]["domains"]);
    assert_eq!(servers[2]["address"], DOH);
    assert_eq!(servers[2]["timeoutMs"], DOH_TIMEOUT_MS);
    assert_eq!(config["dns"]["serveStale"], true);
    assert_eq!(config["dns"]["serveExpiredTTL"], SERVE_EXPIRED_TTL_S);
    assert_eq!(servers[3], json!(PUBLIC_DOH_PRIMARY));
    assert_eq!(servers[4], json!(PUBLIC_DOH_SECONDARY));
    assert_eq!(config["dns"]["queryStrategy"], "UseIPv4");
    assert_eq!(config["outbounds"][0]["streamSettings"]["sockopt"]["domainStrategy"], PROXY_DOMAIN_STRATEGY);
  }

  #[test]
  fn bootstrap_covers_hosts_of_all_nodes() {
    let nodes = [
      parse_link("trojan://pw@a.example.com:443#a").unwrap(),
      parse_link("trojan://pw@b.example.com:443#b").unwrap(),
      parse_link("trojan://pw@c.example.com:443#c").unwrap(),
      parse_link("ss://aes-256-gcm:pw@192.0.2.10:8388").unwrap(),
    ];
    let mut hosts: Vec<String> = nodes.iter().map(|n| n.server.clone()).collect();
    hosts.push("a.example.com".into());
    let config = build(&ConfigInput { ports: PORTS, api_socket: SOCK, node: nodes.first(), doh: DOH, host_ips: &BTreeMap::new(), node_hosts: &hosts }).unwrap();
    let domains = config["dns"]["servers"][0]["domains"].clone();
    assert_eq!(domains, json!(["full:dns.example.net", "full:a.example.com", "full:b.example.com", "full:c.example.com"]));
    assert_eq!(config["dns"]["servers"][1]["domains"], domains);
  }

  #[test]
  fn ip_literals_are_not_bootstrapped_and_cached_ips_become_hosts() {
    let node = parse_link("ss://aes-256-gcm:pw@192.0.2.10:8388").unwrap();
    let mut ips = BTreeMap::new();
    ips.insert("dns.example.net".to_string(), vec!["198.51.100.7".to_string()]);
    let config = build(&ConfigInput { ports: PORTS, api_socket: SOCK, node: Some(&node), doh: DOH, host_ips: &ips, node_hosts: &[] }).unwrap();
    assert_eq!(config["dns"]["servers"][0]["domains"], json!(["full:dns.example.net"]));
    assert_eq!(config["dns"]["hosts"]["dns.example.net"], json!(["198.51.100.7"]));
    let doh_ip = build(&ConfigInput { ports: PORTS, api_socket: SOCK, node: Some(&node), doh: "https://203.0.113.5/dns-query", host_ips: &BTreeMap::new(), node_hosts: &[] }).unwrap();
    assert_eq!(doh_ip["dns"]["servers"][0]["address"], "https://203.0.113.5/dns-query");
  }

  #[test]
  fn rejects_bad_ports_and_doh() {
    let node = parse_link("ss://aes-256-gcm:pw@192.0.2.10:8388").unwrap();
    let with = |ports: Ports, doh: &str| build(&ConfigInput { ports, api_socket: SOCK, node: Some(&node), doh, host_ips: &BTreeMap::new(), node_hosts: &[] });
    assert!(with(Ports { socks: 10808, ..PORTS }, DOH).is_err());
    assert!(with(Ports { probe_proxy: 10100, ..PORTS }, DOH).is_err());
    assert!(with(Ports { probe_proxy: PORTS.socks, ..PORTS }, DOH).is_err());
    assert!(with(Ports { probe_direct: 70, ..PORTS }, DOH).is_err());
    assert!(with(PORTS, "http://dns.example.net/dns-query").is_err());
    assert!(with(PORTS, "не адрес").is_err());
    assert!(with(PORTS, DOH).is_ok());
  }

  #[test]
  fn api_socket_path_is_validated_and_normalized() {
    let node = parse_link("ss://aes-256-gcm:pw@192.0.2.10:8388").unwrap();
    let with = |socket: &str| build(&ConfigInput { ports: PORTS, api_socket: socket, node: Some(&node), doh: DOH, host_ips: &BTreeMap::new(), node_hosts: &[] });
    let config = with("C:\\Users\\Имя Фамилия\\ipc\\api-main.sock").unwrap();
    let api = config["inbounds"].as_array().unwrap().iter().find(|i| i["tag"] == "api").unwrap().clone();
    assert_eq!(api["listen"], "C:/Users/Имя Фамилия/ipc/api-main.sock");
    assert!(with("ipc/api.sock").is_err());
    assert!(with("").is_err());
    assert!(with("C:/a\"b/api.sock").is_err());
    assert!(with(&format!("C:/{}/api.sock", "a".repeat(API_SOCKET_MAX_BYTES))).is_err());
    assert!(with(&format!("C:/{}/s.sock", "a".repeat(API_SOCKET_MAX_BYTES - 12))).is_ok());
  }

  #[test]
  fn no_node_routes_probe_proxy_to_block() {
    let config = build(&ConfigInput { ports: PORTS, api_socket: SOCK, node: None, doh: DOH, host_ips: &BTreeMap::new(), node_hosts: &[] }).unwrap();
    let rule = config["routing"]["rules"].as_array().unwrap().iter()
      .find(|r| r["inboundTag"] == json!(["probe-proxy"])).unwrap();
    assert_eq!(rule["outboundTag"], "block");
    assert!(config["outbounds"].as_array().unwrap().iter().all(|o| o["tag"] != "proxy"));
    // без узла балансеров нет, весь трафик сразу в direct
    assert!(config["routing"]["balancers"].as_array().unwrap().is_empty());
    let socks = config["routing"]["rules"].as_array().unwrap().iter()
      .find(|r| r["inboundTag"] == json!(["socks-in"])).unwrap();
    assert_eq!(socks["outboundTag"], "direct");
  }

  #[test]
  fn doh_with_arbitrary_path_is_accepted_as_is() {
    let node = parse_link("ss://aes-256-gcm:pw@192.0.2.10:8388").unwrap();
    for doh in ["https://dns.nextdns.io/id-fixture", "https://dns.example.net:8443/some/path?x=1"] {
      let config = build(&ConfigInput { ports: PORTS, api_socket: SOCK, node: Some(&node), doh, host_ips: &BTreeMap::new(), node_hosts: &[] }).unwrap();
      assert!(config["dns"]["servers"].as_array().unwrap().iter().any(|s| s["address"] == doh));
    }
    let config = build(&ConfigInput { ports: PORTS, api_socket: SOCK, node: Some(&node), doh: "https://dns.nextdns.io/id-fixture", host_ips: &BTreeMap::new(), node_hosts: &[] }).unwrap();
    assert_eq!(config["dns"]["servers"][0]["domains"], json!(["full:dns.nextdns.io"]));
    assert!(build(&ConfigInput { ports: PORTS, api_socket: SOCK, node: Some(&node), doh: "https://user:pw@dns.example.net/x", host_ips: &BTreeMap::new(), node_hosts: &[] }).is_err());
  }
}
