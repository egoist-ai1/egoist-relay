//! Собственный туннель Egoist Social: один `xray.exe` на сессию, четыре loopback-порта, лестница маршрутов.
//!
//! Контракт — `docs/product-cycle-2026-10-13/NETWORK-TUNNEL.md`. Модуль не трогает систему (DNS, маршруты,
//! системный прокси, TUN, драйверы) и права администратора не требует.
//!
//! Публичный API для подключения:
//! - [`start`] / [`stop`] — жизненный цикл; `start` вызывается до создания окон;
//! - [`browser_args`] — аргументы WebView2 для каждого окружения; [`media_proxy_url`] — прокси для медиа;
//! - [`status`] / [`subscribe`] — статус (событие `relay-network-status`) и подписка на его смену;
//! - [`apply`], [`reset`], [`refresh_subscription`], [`set_service_enabled`] — команды `relay_network_*`;
//! - [`wake`] — внеочередная серия проб после сна или смены сети.
//!
//! Упрощения и известные границы описаны в комментариях к [`apply`] и [`refresh_subscription`].
#![allow(dead_code)] // Модуль подключается к приложению следующим заданием; до тех пор публичный API не вызывается.

pub mod config;
pub mod ladder;
pub mod store;
pub mod supervisor;
pub mod uri;

pub use config::Ports;

use ladder::{Event, NetProber, Prober, Route, Runner, SystemClock};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, LazyLock, Mutex, OnceLock, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use store::{Profile, Provisioning, Store, VpnSource};
use supervisor::{Api, EventSink, Spec, Supervisor, SupervisorEvent, TempXray};
use uri::Node;

/// Как часто подписка скачивается заново.
const SUBSCRIPTION_REFRESH: Duration = Duration::from_secs(12 * 3600);
/// Повтор скачивания, пока в подписке нет ни одного узла.
const SUBSCRIPTION_RETRY: Duration = Duration::from_secs(60);
/// Бюджет проверки нового ключа перед заменой.
const PROBE_BUDGET: Duration = Duration::from_secs(10);
/// Сколько ждать готовности основного Xray после перезапуска с новым конфигом.
const RESTART_WAIT: Duration = Duration::from_secs(8);
/// Проверка достижимости DoH раз в N тиков проб (около минуты).
const DOH_CHECK_EVERY: u32 = 12;
/// Порт «в никуда» для аргументов браузера, пока туннель не запущен: соединение отклоняется (fail closed).
const DEAD_PORT: u16 = 9;

// ---------- типы статуса (JSON — ровно `NetworkStatus` из контракта) ----------

/// Состояние сети.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum State { Starting, Tunnel, DnsOnly, Down, RestartRequired, NotConfigured }

/// Откуда действующие значения.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Source { Embedded, Override, None }

/// Вид ключа VPN.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum VpnKind { Link, Subscription, None }

/// Состояние DoH: приватный, резервный публичный, недоступен, не настроен.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DohState { Private, Fallback, Down, None }

/// Маршрут сервиса.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ServiceRoute { Tunnel, Direct, Unavailable, Disabled, Unknown }

/// Статус сети для интерфейса. Ключи, полные URL подписки и DoH сюда не попадают.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkStatus {
  pub state: State,
  pub source: Source,
  pub vpn_kind: VpnKind,
  /// Имя узла из `#fragment` ссылки.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub node_label: Option<String>,
  pub node_count: usize,
  pub doh_state: DohState,
  /// Только хост DoH.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub doh_host: Option<String>,
  pub has_mtproxy: bool,
  /// `telegram`, `x`, `instagram`.
  pub services: BTreeMap<String, ServiceRoute>,
  /// Unix-время последней загрузки подписки, мс.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub subscription_updated_at: Option<u64>,
  /// Код последней ошибки, без секретов.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub last_error: Option<String>,
}

/// Ошибка команд сети; сериализуется кодом из контракта.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NetworkError {
  InvalidVpn,
  InvalidDoh,
  InvalidMtproxy,
  ProbeFailed,
  ApplyFailed,
  SubscriptionFailed,
  InvalidService,
}

impl NetworkError {
  /// Код ошибки для интерфейса.
  pub fn code(self) -> &'static str {
    match self {
      Self::InvalidVpn => "INVALID_VPN",
      Self::InvalidDoh => "INVALID_DOH",
      Self::InvalidMtproxy => "INVALID_MTPROXY",
      Self::ProbeFailed => "PROBE_FAILED",
      Self::ApplyFailed => "APPLY_FAILED",
      Self::SubscriptionFailed => "SUBSCRIPTION_FAILED",
      Self::InvalidService => "INVALID_SERVICE",
    }
  }
}

impl std::fmt::Display for NetworkError {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { f.write_str(self.code()) }
}

impl Serialize for NetworkError {
  fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
    serializer.serialize_str(self.code())
  }
}

/// Аргументы команды `relay_network_apply`. `None` — поле не менять; пустая строка — вернуть встроенное значение.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ApplyRequest {
  pub vpn: Option<String>,
  pub doh: Option<String>,
  pub mtproxy: Option<String>,
}

/// Разобранная ссылка MTProxy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MtProxy {
  pub server: String,
  pub port: u16,
  pub secret: String,
}

/// Разбирает `tg://proxy?server=…&port=…&secret=…` или `https://t.me/proxy?…`.
pub fn parse_mtproxy(link: &str) -> Option<MtProxy> {
  let url = url::Url::parse(link.trim()).ok()?;
  let is_tg = url.scheme() == "tg" && url.host_str() == Some("proxy");
  let is_web = url.scheme() == "https" && matches!(url.host_str(), Some("t.me" | "telegram.me")) && url.path() == "/proxy";
  if !is_tg && !is_web { return None; }
  let get = |key: &str| url.query_pairs().find(|(name, _)| name == key).map(|(_, value)| value.into_owned());
  let server = get("server").filter(|v| !v.is_empty() && v.len() <= 255)?;
  let port: u16 = get("port")?.parse().ok().filter(|p| *p > 0)?;
  let secret = get("secret").filter(|v| !v.is_empty() && v.len() <= 256)?;
  Some(MtProxy { server, port, secret })
}

// ---------- внутреннее состояние ----------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SupState { Starting, Running, RestartRequired }

struct Inputs {
  configured: bool,
  source: Source,
  vpn_kind: VpnKind,
  node_label: Option<String>,
  node_count: usize,
  doh_host: Option<String>,
  doh_state: DohState,
  has_mtproxy: bool,
  services_enabled: BTreeMap<String, bool>,
  direct: BTreeMap<String, bool>,
  sup: SupState,
  route: Route,
  probed: bool,
  subscription_updated_at: Option<u64>,
  last_error: Option<String>,
}

impl Inputs {
  fn new() -> Self {
    Self {
      configured: false,
      source: Source::None,
      vpn_kind: VpnKind::None,
      node_label: None,
      node_count: 0,
      doh_host: None,
      doh_state: DohState::None,
      has_mtproxy: false,
      services_enabled: BTreeMap::new(),
      direct: BTreeMap::new(),
      sup: SupState::Starting,
      route: Route::Tunnel,
      probed: false,
      subscription_updated_at: None,
      last_error: None,
    }
  }

  fn compute(&self) -> NetworkStatus {
    let state = if !self.configured {
      State::NotConfigured
    } else {
      match self.sup {
        SupState::RestartRequired => State::RestartRequired,
        SupState::Starting => State::Starting,
        SupState::Running => match self.route {
          Route::Tunnel if !self.probed => State::Starting,
          Route::Tunnel => State::Tunnel,
          Route::DnsOnly => State::DnsOnly,
          Route::Down => State::Down,
        },
      }
    };
    let mut services = BTreeMap::new();
    for (service, _, _) in ladder::SERVICE_TARGETS {
      let enabled = self.services_enabled.get(service).copied().unwrap_or(true);
      let route = if !enabled {
        ServiceRoute::Disabled
      } else {
        match state {
          State::Tunnel => ServiceRoute::Tunnel,
          State::DnsOnly => match self.direct.get(service) {
            Some(true) => ServiceRoute::Direct,
            Some(false) => ServiceRoute::Unavailable,
            None => ServiceRoute::Unknown,
          },
          State::Down => ServiceRoute::Unavailable,
          _ => ServiceRoute::Unknown,
        }
      };
      services.insert(service.to_string(), route);
    }
    NetworkStatus {
      state,
      source: self.source,
      vpn_kind: self.vpn_kind,
      node_label: self.node_label.clone(),
      node_count: self.node_count,
      doh_state: self.doh_state,
      doh_host: self.doh_host.clone(),
      has_mtproxy: self.has_mtproxy,
      services,
      subscription_updated_at: self.subscription_updated_at,
      last_error: self.last_error.clone(),
    }
  }
}

type Listener = Arc<dyn Fn(&NetworkStatus) + Send + Sync>;

static PORTS: OnceLock<Ports> = OnceLock::new();
static READY: AtomicBool = AtomicBool::new(false);
static WAKE: AtomicBool = AtomicBool::new(false);
/// Растёт при каждой готовности Xray (в том числе после перезапуска): монитор заново применяет ступень.
static GENERATION: AtomicU64 = AtomicU64::new(0);
static INPUTS: LazyLock<Mutex<Inputs>> = LazyLock::new(|| Mutex::new(Inputs::new()));
static STATUS: LazyLock<RwLock<NetworkStatus>> = LazyLock::new(|| RwLock::new(Inputs::new().compute()));
static LISTENERS: LazyLock<Mutex<Vec<Listener>>> = LazyLock::new(|| Mutex::new(Vec::new()));
static CORE: LazyLock<Mutex<Option<Core>>> = LazyLock::new(|| Mutex::new(None));

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
  mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn update_inputs(change: impl FnOnce(&mut Inputs)) {
  change(&mut lock(&INPUTS));
  publish();
}

/// Пересчитывает статус и, если он изменился, сообщает подписчикам (вне блокировок).
fn publish() {
  let status = lock(&INPUTS).compute();
  {
    let mut current = STATUS.write().unwrap_or_else(|poisoned| poisoned.into_inner());
    if *current == status { return; }
    *current = status.clone();
  }
  let listeners: Vec<Listener> = lock(&LISTENERS).clone();
  for listener in listeners { listener(&status); }
}

struct MonitorCtx {
  api: Option<Api>,
  nodes: Vec<Node>,
  /// Узел, с которым запущен конфиг.
  config_index: usize,
  current: usize,
  current_tag: String,
  tag_seq: u32,
  targets: Vec<ladder::Target>,
  doh_host: Option<String>,
  doh_port: u16,
  subscription: bool,
}

impl MonitorCtx {
  fn label(&self) -> Option<String> {
    self.nodes.get(self.current).map(|node| node.name.clone()).filter(|name| !name.is_empty())
  }

  /// После перезапуска Xray в нём снова узел из конфига.
  fn reset_current(&mut self) {
    self.current = self.config_index;
    self.current_tag = config::TAG_PROXY.to_string();
  }
}

struct Monitor {
  stop: Sender<()>,
  cancelled: Arc<AtomicBool>,
}

impl Monitor {
  /// Останавливает поток без ожидания: он может ждать `CORE`, который держит вызывающий.
  fn cancel(&self) {
    self.cancelled.store(true, Ordering::SeqCst);
    let _ = self.stop.send(());
  }
}

struct Core {
  network_dir: PathBuf,
  runtime_dir: PathBuf,
  store: Store,
  profile: Profile,
  nodes: Vec<Node>,
  supervisor: Option<Supervisor>,
  monitor: Option<Monitor>,
  ctx: Arc<Mutex<MonitorCtx>>,
}

// ---------- публичный API: жизненный цикл ----------

/// Запускает туннель. Вызывать до создания окон WebView. Импортирует `seed.dpapi`, выбирает четыре порта,
/// поднимает Xray (ждёт не дольше 1,5 с) и запускает монитор проб. `app_data_dir` — каталог данных приложения
/// (`%LOCALAPPDATA%\com.egoist.relay`), настройки лежат в его подкаталоге `network`; `runtime_dir` — каталог
/// с `xray.exe`. Повторный вызов возвращает уже выбранные порты. Если ключа нет, Xray не запускается,
/// статус `notConfigured`, а порты всё равно выбраны (окна получат закрытый прокси).
pub fn start(app_data_dir: &Path, runtime_dir: &Path) -> Result<Ports, String> {
  let mut guard = lock(&CORE);
  if guard.is_some() {
    return PORTS.get().copied().ok_or_else(|| "TUNNEL_PORTS_MISSING".to_string());
  }
  let network_dir = app_data_dir.join("network");
  std::fs::create_dir_all(&network_dir).map_err(|_| "TUNNEL_STORE_WRITE_FAILED".to_string())?;
  let store = Store::new(&network_dir);
  match store.import_seed() {
    Ok(true) => log::info!("[Tunnel] данные установщика импортированы"),
    Ok(false) => {}
    Err(error) => log::warn!("[Tunnel] seed не импортирован: {error}"),
  }
  let profile = store.load();
  let ports = match PORTS.get() {
    Some(ports) => *ports,
    None => {
      let ports = supervisor::pick_ports()?;
      let _ = PORTS.set(ports);
      ports
    }
  };
  let mut core = Core {
    network_dir,
    runtime_dir: runtime_dir.to_path_buf(),
    store,
    profile: Profile::default(),
    nodes: Vec::new(),
    supervisor: None,
    monitor: None,
    ctx: Arc::new(Mutex::new(MonitorCtx {
      api: None, nodes: Vec::new(), config_index: 0, current: 0, current_tag: config::TAG_PROXY.into(),
      tag_seq: 0, targets: Vec::new(), doh_host: None, doh_port: 443, subscription: false,
    })),
  };
  if let Err(error) = configure(&mut core, profile) {
    log::warn!("[Tunnel] запуск не удался: {error}");
  }
  *guard = Some(core);
  Ok(ports)
}

/// Останавливает монитор и Xray. После `stop` можно снова вызвать [`start`] (порты сохранятся).
pub fn stop() {
  let mut guard = lock(&CORE);
  if let Some(core) = guard.as_mut() {
    if let Some(monitor) = core.monitor.take() { monitor.cancel(); }
    if let Some(mut supervisor) = core.supervisor.take() { supervisor.stop(); }
  }
  *guard = None;
  READY.store(false, Ordering::SeqCst);
  update_inputs(|inputs| { inputs.sup = SupState::Starting; inputs.probed = false; });
}

/// Порты сессии, если туннель уже запускался.
pub fn ports() -> Option<Ports> { PORTS.get().copied() }

/// Аргументы командной строки WebView2 для окружения `service`: весь трафик в SOCKS5 туннеля, без QUIC и
/// без утечек UDP через WebRTC. Пока туннель не запущен, прокси указывает на закрытый порт: соединения
/// отклоняются, прямого выхода в сеть у окна нет (fail closed).
pub fn browser_args(service: &str) -> String {
  let _ = service; // сейчас набор одинаков для всех окружений; параметр оставлен для различий по сервисам
  let port = PORTS.get().map(|ports| ports.socks).unwrap_or(DEAD_PORT);
  format!(
    "--proxy-server=socks5://127.0.0.1:{port} --disable-quic --force-webrtc-ip-handling-policy=disable_non_proxied_udp --dns-prefetch-disable"
  )
}

/// Прокси для медиа из Rust и Node (`socks5h://127.0.0.1:P_socks`, имена разрешает туннель). `None`, пока Xray
/// не готов: вызывающий возвращает `MEDIA_TUNNEL_UNAVAILABLE`.
pub fn media_proxy_url() -> Option<String> {
  if !READY.load(Ordering::SeqCst) { return None; }
  PORTS.get().map(|ports| format!("socks5h://127.0.0.1:{}", ports.socks))
}

/// Текущий статус сети.
pub fn status() -> NetworkStatus {
  STATUS.read().unwrap_or_else(|poisoned| poisoned.into_inner()).clone()
}

/// Подписывается на смену статуса. Колбэк вызывается из рабочих потоков туннеля, не под блокировками модуля;
/// обычно в нём эмитится событие `relay-network-status`. Отписки нет: подписчик живёт до конца процесса.
pub fn subscribe(listener: impl Fn(&NetworkStatus) + Send + Sync + 'static) {
  lock(&LISTENERS).push(Arc::new(listener));
}

/// Подписка через канал: удобно, когда колбэк нельзя держать в замыкании. Сразу присылает текущий статус.
pub fn subscribe_channel() -> Receiver<NetworkStatus> {
  let (sender, receiver) = mpsc::channel();
  let _ = sender.send(status());
  let sender = Mutex::new(sender);
  subscribe(move |status| { let _ = lock(&sender).send(status.clone()); });
  receiver
}

/// Сообщает о пробуждении системы или смене сети: старые серии проб сбрасываются, идёт быстрый пакет проб.
pub fn wake() { WAKE.store(true, Ordering::SeqCst); }

// ---------- конфигурация ----------

struct Resolved {
  prov: Option<Provisioning>,
  source: Source,
  vpn_kind: VpnKind,
  nodes: Vec<Node>,
  subscription: bool,
}

fn resolve(profile: &Profile) -> Resolved {
  let source = if profile.override_.is_some() { Source::Override } else if profile.embedded.is_some() { Source::Embedded } else { Source::None };
  let Some(prov) = profile.active().cloned() else {
    return Resolved { prov: None, source, vpn_kind: VpnKind::None, nodes: Vec::new(), subscription: false };
  };
  let (nodes, vpn_kind, subscription) = match prov.source() {
    VpnSource::Links(text) => (uri::parse_text(&text).nodes, VpnKind::Link, false),
    VpnSource::SubscriptionUrl(_) => (uri::parse_text(&profile.subscription_cache).nodes, VpnKind::Subscription, true),
  };
  Resolved { prov: Some(prov), source, vpn_kind, nodes, subscription }
}

fn doh_host_port(doh: &str) -> Option<(String, u16)> {
  let url = url::Url::parse(doh).ok()?;
  Some((url.host_str()?.trim_matches(['[', ']']).to_string(), url.port_or_known_default().unwrap_or(443)))
}

fn make_spec(core: &Core, ports: Ports, nodes: &[Node], doh: &str, config_name: &str) -> Spec {
  let mut secrets: Vec<String> = nodes.iter().map(|node| node.server.clone()).collect();
  if let Some((host, _)) = doh_host_port(doh) { secrets.push(host); }
  secrets.sort();
  secrets.dedup();
  Spec {
    xray_exe: core.runtime_dir.join("xray.exe"),
    asset_dir: core.runtime_dir.clone(),
    config_path: core.network_dir.join(config_name),
    ports,
    secrets,
    restart_required_after: supervisor::RESTART_REQUIRED_AFTER,
  }
}

fn supervisor_sink() -> EventSink {
  Arc::new(|event| {
    match event {
      SupervisorEvent::Ready => {
        READY.store(true, Ordering::SeqCst);
        GENERATION.fetch_add(1, Ordering::SeqCst);
        update_inputs(|inputs| inputs.sup = SupState::Running);
      }
      SupervisorEvent::Exited => {
        READY.store(false, Ordering::SeqCst);
        update_inputs(|inputs| inputs.sup = SupState::Starting);
      }
      SupervisorEvent::RestartRequired => {
        update_inputs(|inputs| inputs.sup = SupState::RestartRequired);
      }
    }
  })
}

/// Применяет профиль к работающей системе: разбирает узлы, собирает конфиг, запускает или перезапускает Xray
/// на тех же портах, перезапускает монитор и обновляет статус.
fn configure(core: &mut Core, profile: Profile) -> Result<(), String> {
  let ports = *PORTS.get().ok_or("TUNNEL_PORTS_MISSING")?;
  let resolved = resolve(&profile);
  if let Some(monitor) = core.monitor.take() { monitor.cancel(); }
  let Some(prov) = resolved.prov.clone() else {
    // Ключа нет: Xray не нужен, окна остаются с закрытым прокси
    if let Some(mut supervisor) = core.supervisor.take() { supervisor.stop(); }
    READY.store(false, Ordering::SeqCst);
    core.profile = profile;
    core.nodes = Vec::new();
    update_inputs(|inputs| {
      *inputs = Inputs { services_enabled: core.profile.services_enabled.clone(), ..Inputs::new() };
    });
    return Ok(());
  };
  let config = config::build(&config::ConfigInput {
    ports,
    node: resolved.nodes.first(),
    doh: prov.doh_url(),
    host_ips: &profile.bootstrap_ips,
  })?;
  match core.supervisor.as_ref() {
    Some(supervisor) => {
      let before = GENERATION.load(Ordering::SeqCst);
      supervisor.restart_with(config)?;
      let deadline = Instant::now() + RESTART_WAIT;
      while Instant::now() < deadline && !(GENERATION.load(Ordering::SeqCst) > before && READY.load(Ordering::SeqCst)) {
        std::thread::sleep(Duration::from_millis(50));
      }
      if !(GENERATION.load(Ordering::SeqCst) > before && READY.load(Ordering::SeqCst)) {
        return Err("TUNNEL_RESTART_TIMEOUT".into());
      }
    }
    None => {
      let spec = make_spec(core, ports, &resolved.nodes, prov.doh_url(), "xray.json");
      core.supervisor = Some(Supervisor::start(spec, config, supervisor_sink())?);
    }
  }
  core.nodes = resolved.nodes.clone();
  core.profile = profile;
  let (doh_host, doh_port) = doh_host_port(prov.doh_url()).unzip();
  {
    let mut ctx = lock(&core.ctx);
    ctx.api = core.supervisor.as_ref().map(Supervisor::api);
    ctx.nodes = resolved.nodes.clone();
    ctx.config_index = 0;
    ctx.current = 0;
    ctx.current_tag = config::TAG_PROXY.to_string();
    ctx.tag_seq = 0;
    ctx.targets = ladder::targets_for(|service| core.profile.service_enabled(service));
    ctx.doh_host = doh_host.clone();
    ctx.doh_port = doh_port.unwrap_or(443);
    ctx.subscription = resolved.subscription;
  }
  let label = lock(&core.ctx).label();
  update_inputs(|inputs| {
    inputs.configured = true;
    inputs.source = resolved.source;
    inputs.vpn_kind = resolved.vpn_kind;
    inputs.node_label = label;
    inputs.node_count = resolved.nodes.len();
    inputs.doh_host = doh_host;
    inputs.doh_state = DohState::Private;
    inputs.has_mtproxy = parse_mtproxy(&prov.mtproxy).is_some();
    inputs.services_enabled = core.profile.services_enabled.clone();
    inputs.direct.clear();
    inputs.route = Route::Tunnel;
    inputs.probed = false;
    inputs.subscription_updated_at = Some(core.profile.subscription_updated_at_ms).filter(|ms| *ms > 0);
    inputs.last_error = None;
  });
  core.monitor = Some(spawn_monitor(core.ctx.clone()));
  Ok(())
}

// ---------- монитор: пробы, ступени, ротация узлов ----------

fn spawn_monitor(ctx: Arc<Mutex<MonitorCtx>>) -> Monitor {
  let (stop, receiver) = mpsc::channel();
  let cancelled = Arc::new(AtomicBool::new(false));
  let flag = cancelled.clone();
  let spawned = std::thread::Builder::new().name("relay-tunnel-monitor".into()).spawn(move || monitor_loop(ctx, receiver, flag));
  if spawned.is_err() { log::warn!("[Tunnel] поток монитора не запущен"); }
  Monitor { stop, cancelled }
}

fn now_ms() -> u64 {
  SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn monitor_loop(ctx: Arc<Mutex<MonitorCtx>>, stop: Receiver<()>, cancelled: Arc<AtomicBool>) {
  let Some(ports) = PORTS.get().copied() else { return; };
  let targets = lock(&ctx).targets.clone();
  let mut runner = Runner::new(SystemClock::new(), NetProber { probe_proxy: ports.probe_proxy, probe_direct: ports.probe_direct }, targets);
  let mut seen_generation = GENERATION.load(Ordering::SeqCst);
  let mut applied_direct = false;
  let mut rotations: usize = 0;
  let mut tick_no: u32 = 0;
  let mut last_refresh = Instant::now();
  let mut probed = false;
  loop {
    match stop.recv_timeout(runner.ladder.next_delay()) {
      Err(mpsc::RecvTimeoutError::Timeout) => {}
      _ => return,
    }
    if cancelled.load(Ordering::SeqCst) { return; }
    if WAKE.swap(false, Ordering::SeqCst) { runner.ladder.wake(); }
    if !READY.load(Ordering::SeqCst) { applied_direct = false; continue; }
    let generation = GENERATION.load(Ordering::SeqCst);
    if generation != seen_generation {
      // Xray перезапустился: он снова на узле из конфига и без принудительного выбора ступени
      seen_generation = generation;
      applied_direct = false;
      lock(&ctx).reset_current();
    }
    let (api, targets, node_count) = {
      let ctx = lock(&ctx);
      (ctx.api.clone(), ctx.targets.clone(), ctx.nodes.len())
    };
    let Some(api) = api else { continue; };
    runner.set_targets(targets);
    let can_rotate = node_count > 1 && rotations + 1 < node_count;
    match runner.tick(can_rotate) {
      Event::None => {}
      Event::RotateNode => {
        rotations += 1;
        let mut ctx = lock(&ctx);
        match rotate(&mut ctx, &api) {
          Ok(()) => {
            log::info!("[Tunnel] узел сменён ({} из {})", ctx.current + 1, ctx.nodes.len());
            let label = ctx.label();
            drop(ctx);
            update_inputs(|inputs| inputs.node_label = label);
          }
          Err(error) => log::warn!("[Tunnel] смена узла не удалась: {error}"),
        }
      }
      Event::Transition { from, to } => {
        rotations = 0;
        log::info!("[Tunnel] маршрут: {from:?} -> {to:?}");
      }
    }
    if runner.ladder.proxy_ok_streak() > 0 {
      rotations = 0;
      probed = true;
    }
    // Ступень применяется в Xray; при сбое API повтор на следующем тике
    let want_direct = runner.ladder.route() != Route::Tunnel;
    if want_direct != applied_direct {
      let result = if want_direct { api.override_balancer(config::TAG_DIRECT) } else { api.clear_override() };
      match result {
        Ok(()) => applied_direct = want_direct,
        Err(error) => log::warn!("[Tunnel] переключение ступени не удалось: {error}"),
      }
    }
    let route = runner.ladder.route();
    let direct: BTreeMap<String, bool> = runner.ladder.services().clone();
    let probed_now = probed;
    update_inputs(|inputs| {
      inputs.route = route;
      inputs.probed = probed_now;
      inputs.direct = direct;
    });
    if tick_no % DOH_CHECK_EVERY == 0 {
      let (host, port) = { let ctx = lock(&ctx); (ctx.doh_host.clone(), ctx.doh_port) };
      if let Some(host) = host {
        let state = if ladder::reachable_direct(ports.probe_direct, &host, port) {
          DohState::Private
        } else if config::DOH_PUBLIC_FALLBACK {
          DohState::Fallback
        } else {
          DohState::Down
        };
        update_inputs(|inputs| inputs.doh_state = state);
      }
    }
    tick_no = tick_no.wrapping_add(1);
    // Подписка: раз в 12 часов, а пока узлов нет, раз в минуту
    let (subscription, empty) = { let ctx = lock(&ctx); (ctx.subscription, ctx.nodes.is_empty()) };
    let due = if empty { SUBSCRIPTION_RETRY } else { SUBSCRIPTION_REFRESH };
    if subscription && last_refresh.elapsed() >= due && !cancelled.load(Ordering::SeqCst) {
      last_refresh = Instant::now();
      refresh_from_monitor();
    }
  }
}

/// Меняет узел без разрыва: новый outbound под новым тегом, затем удаление старого.
fn rotate(ctx: &mut MonitorCtx, api: &Api) -> Result<(), String> {
  if ctx.nodes.len() < 2 { return Err("TUNNEL_NO_SPARE_NODE".into()); }
  let next = (ctx.current + 1) % ctx.nodes.len();
  ctx.tag_seq += 1;
  let tag = format!("proxy-r{}", ctx.tag_seq);
  api.add_outbound(&config::outbound_with_tag(&ctx.nodes[next], &tag))?;
  let previous = std::mem::replace(&mut ctx.current_tag, tag);
  if let Err(error) = api.remove_outbound(&previous) { log::warn!("[Tunnel] старый узел не удалён: {error}"); }
  ctx.current = next;
  Ok(())
}

fn refresh_from_monitor() {
  // try_lock: если идёт apply/reset, не ждём (иначе взаимная блокировка с остановкой монитора)
  let Ok(mut guard) = CORE.try_lock() else { return; };
  if let Some(core) = guard.as_mut() {
    if let Err(error) = refresh_locked(core) { log::warn!("[Tunnel] обновление подписки: {error}"); }
  }
}

// ---------- команды ----------

fn with_core<T>(operation: impl FnOnce(&mut Core) -> Result<T, NetworkError>) -> Result<T, NetworkError> {
  let mut guard = lock(&CORE);
  let core = guard.as_mut().ok_or(NetworkError::ApplyFailed)?;
  operation(core)
}

/// Заменяет ключ VPN, DoH и MTProxy. Поля, которых нет в запросе, остаются; пустая строка возвращает
/// встроенное значение поля. Шаги: разбор и проверка, проба на втором Xray с отдельными портами (204 через
/// туннель и достижимость DoH, не дольше 10 с), атомарная запись профиля, перезапуск основного Xray на тех
/// же портах; при отказе перезапуска профиль и Xray возвращаются к прежним значениям.
///
/// Упрощения: при проверке подписки пробуются до трёх первых узлов; адрес подписки скачивается через
/// `curl.exe` (в проекте нет TLS-клиента для Rust), поэтому без него замена на подписку даст `PROBE_FAILED`;
/// смена только `mtproxy` проб и перезапуска не требует; DoH проверяется на достижимость хоста по TLS, но не
/// запросом DNS, то есть истёкший токен в пути адреса проба не заметит.
pub fn apply(request: ApplyRequest) -> Result<NetworkStatus, NetworkError> {
  with_core(|core| {
    let embedded = core.profile.embedded.clone().unwrap_or_default();
    let base = core.profile.active().cloned().unwrap_or_default();
    let mut candidate = base.clone();
    if let Some(value) = &request.vpn {
      candidate.vpn = if value.trim().is_empty() { embedded.vpn.clone() } else { value.trim().to_string() };
    }
    if let Some(value) = &request.doh {
      candidate.doh = if value.trim().is_empty() { embedded.doh.clone() } else { value.trim().to_string() };
    }
    if let Some(value) = &request.mtproxy {
      candidate.mtproxy = if value.trim().is_empty() { embedded.mtproxy.clone() } else { value.trim().to_string() };
    }
    candidate.schema = store::SCHEMA;
    if candidate.vpn.trim().is_empty() { return Err(NetworkError::InvalidVpn); }
    if candidate.validate().is_err() { return Err(NetworkError::InvalidDoh); }
    if !candidate.mtproxy.is_empty() && parse_mtproxy(&candidate.mtproxy).is_none() { return Err(NetworkError::InvalidMtproxy); }

    let network_changed = candidate.vpn != base.vpn || candidate.doh != base.doh;
    let mut profile = core.profile.clone();
    if network_changed {
      let nodes = match candidate.source() {
        VpnSource::Links(text) => uri::parse_text(&text).nodes,
        VpnSource::SubscriptionUrl(url) => {
          let socks = PORTS.get().map(|p| p.socks).ok_or(NetworkError::ProbeFailed)?;
          let body = fetch_subscription(&url, socks).map_err(|_| NetworkError::ProbeFailed)?;
          let parsed = uri::parse_text(&body);
          profile.subscription_cache = body;
          profile.subscription_updated_at_ms = now_ms();
          parsed.nodes
        }
      };
      if nodes.is_empty() { return Err(NetworkError::InvalidVpn); }
      probe_candidate(core, &candidate, &nodes)?;
    }
    let is_embedded = core.profile.embedded.as_ref() == Some(&candidate);
    profile.override_ = if is_embedded { None } else { Some(candidate) };
    let previous = core.profile.clone();
    core.store.save(&profile).map_err(|_| NetworkError::ApplyFailed)?;
    if network_changed {
      if let Err(error) = configure(core, profile) {
        log::warn!("[Tunnel] применение не удалось, откат: {error}");
        let _ = core.store.save(&previous);
        if configure(core, previous).is_err() { log::error!("[Tunnel] откат тоже не удался"); }
        update_inputs(|inputs| inputs.last_error = Some(NetworkError::ApplyFailed.code().into()));
        return Err(NetworkError::ApplyFailed);
      }
    } else {
      core.profile = profile;
      let has_mtproxy = core.profile.active().map(|p| parse_mtproxy(&p.mtproxy).is_some()).unwrap_or(false);
      let source = if core.profile.override_.is_some() { Source::Override } else { Source::Embedded };
      update_inputs(|inputs| { inputs.has_mtproxy = has_mtproxy; inputs.source = source; inputs.last_error = None; });
    }
    Ok(status())
  })
}

/// Возвращает встроенные значения: убирает пользовательский `override`, кэш подписки и перезапускает Xray.
pub fn reset() -> Result<NetworkStatus, NetworkError> {
  with_core(|core| {
    let profile = core.store.reset_override().map_err(|_| NetworkError::ApplyFailed)?;
    configure(core, profile).map_err(|error| {
      log::warn!("[Tunnel] сброс не удался: {error}");
      NetworkError::ApplyFailed
    })?;
    Ok(status())
  })
}

/// Скачивает подписку заново (по кнопке; автоматически — раз в 12 часов). Загрузка идёт через `P_socks`
/// программой `curl.exe` из Windows: в проекте нет TLS-клиента для Rust, а ключ подписки при этом не попадает
/// в командную строку (адрес передаётся через stdin). Если подписки нет или загрузка не удалась —
/// `SUBSCRIPTION_FAILED`, прежний кэш остаётся.
pub fn refresh_subscription() -> Result<NetworkStatus, NetworkError> {
  with_core(|core| {
    refresh_locked(core)?;
    Ok(status())
  })
}

fn refresh_locked(core: &mut Core) -> Result<(), NetworkError> {
  let fail = |error: NetworkError| {
    update_inputs(|inputs| inputs.last_error = Some(error.code().into()));
    error
  };
  let Some(VpnSource::SubscriptionUrl(url)) = core.profile.active().map(Provisioning::source) else {
    return Err(NetworkError::SubscriptionFailed);
  };
  let socks = PORTS.get().map(|p| p.socks).ok_or_else(|| fail(NetworkError::SubscriptionFailed))?;
  let body = fetch_subscription(&url, socks).map_err(|_| fail(NetworkError::SubscriptionFailed))?;
  let parsed = uri::parse_text(&body);
  if parsed.nodes.is_empty() { return Err(fail(NetworkError::SubscriptionFailed)); }
  let mut profile = core.profile.clone();
  profile.subscription_cache = body;
  profile.subscription_updated_at_ms = now_ms();
  core.store.save(&profile).map_err(|_| fail(NetworkError::SubscriptionFailed))?;
  let config_node_changed = core.nodes.first() != parsed.nodes.first();
  if config_node_changed {
    // Узел в конфиге устарел (или конфиг был без узла): пересборка и перезапуск Xray
    configure(core, profile).map_err(|_| fail(NetworkError::SubscriptionFailed))?;
  } else {
    // Узел тот же: обновляем только список запасных и время
    core.profile = profile;
    core.nodes = parsed.nodes.clone();
    let mut ctx = lock(&core.ctx);
    ctx.nodes = parsed.nodes.clone();
    drop(ctx);
    let updated = Some(core.profile.subscription_updated_at_ms);
    update_inputs(|inputs| {
      inputs.node_count = parsed.nodes.len();
      inputs.subscription_updated_at = updated;
      inputs.last_error = None;
    });
  }
  update_inputs(|inputs| inputs.last_error = None);
  Ok(())
}

/// Включает или выключает сервис (`x` или `instagram`; Telegram скрыть нельзя). Выключенный сервис не
/// пробуется лестницей и показывается как `disabled`; создание окон — дело вызывающего.
pub fn set_service_enabled(service: &str, enabled: bool) -> Result<NetworkStatus, NetworkError> {
  if !matches!(service, "x" | "instagram") { return Err(NetworkError::InvalidService); }
  with_core(|core| {
    let mut profile = core.profile.clone();
    profile.services_enabled.insert(service.to_string(), enabled);
    core.store.save(&profile).map_err(|_| NetworkError::ApplyFailed)?;
    core.profile = profile;
    lock(&core.ctx).targets = ladder::targets_for(|name| core.profile.service_enabled(name));
    let flags = core.profile.services_enabled.clone();
    update_inputs(|inputs| inputs.services_enabled = flags);
    Ok(status())
  })
}

// ---------- проверка нового ключа ----------

fn probe_candidate(core: &Core, candidate: &Provisioning, nodes: &[Node]) -> Result<(), NetworkError> {
  let deadline = Instant::now() + PROBE_BUDGET;
  let main = PORTS.get().copied().ok_or(NetworkError::ProbeFailed)?;
  let ports = loop {
    let picked = supervisor::pick_ports().map_err(|_| NetworkError::ProbeFailed)?;
    if picked.all().iter().all(|port| !main.all().contains(port)) { break picked; }
  };
  let config = config::build(&config::ConfigInput {
    ports,
    node: nodes.first(),
    doh: candidate.doh_url(),
    host_ips: &BTreeMap::new(),
  }).map_err(|_| NetworkError::InvalidDoh)?;
  let spec = make_spec(core, ports, nodes, candidate.doh_url(), "xray-probe.json");
  let remaining = deadline.saturating_duration_since(Instant::now());
  let temp = TempXray::start(spec, &config, remaining.min(Duration::from_secs(5))).map_err(|_| NetworkError::ProbeFailed)?;
  let prober = NetProber { probe_proxy: ports.probe_proxy, probe_direct: ports.probe_direct };
  let api = temp.api();
  let mut current_tag = config::TAG_PROXY.to_string();
  let mut tunnel_ok = false;
  for (index, node) in nodes.iter().take(3).enumerate() {
    if index > 0 {
      // Следующий кандидат: добавить под новым тегом и убрать прежний
      let tag = format!("proxy-p{index}");
      if api.add_outbound(&config::outbound_with_tag(node, &tag)).is_err() { break; }
      let _ = api.remove_outbound(&current_tag);
      current_tag = tag;
    }
    if prober.proxy_ok() { tunnel_ok = true; break; }
    if Instant::now() >= deadline { break; }
  }
  if !tunnel_ok { return Err(NetworkError::ProbeFailed); }
  let (host, port) = doh_host_port(candidate.doh_url()).ok_or(NetworkError::InvalidDoh)?;
  if !ladder::reachable_direct(ports.probe_direct, &host, port) { return Err(NetworkError::ProbeFailed); }
  Ok(())
}

// ---------- загрузка подписки ----------

/// Скачивает подписку через SOCKS туннеля программой `curl.exe`. Адрес уходит в stdin (`-K -`), а не в аргументы.
fn fetch_subscription(url: &str, socks_port: u16) -> Result<String, String> {
  use std::io::{Read, Write};
  use std::process::{Command, Stdio};
  let parsed = url::Url::parse(url).map_err(|_| "TUNNEL_SUBSCRIPTION_URL")?;
  if !matches!(parsed.scheme(), "http" | "https") || url.contains(['"', '\n', '\r', '\\']) {
    return Err("TUNNEL_SUBSCRIPTION_URL".into());
  }
  let curl = std::env::var_os("SystemRoot")
    .map(|root| PathBuf::from(root).join("System32").join("curl.exe"))
    .filter(|path| path.is_file())
    .unwrap_or_else(|| PathBuf::from("curl.exe"));
  let mut command = Command::new(curl);
  command.args(["-sS", "--fail", "--location", "--max-time", "25", "--max-filesize", "5242880", "-K", "-"])
    .arg("--proxy").arg(format!("socks5h://127.0.0.1:{socks_port}"))
    .args(["-A", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"])
    .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
  #[cfg(windows)]
  {
    use std::os::windows::process::CommandExt;
    command.creation_flags(0x0800_0000);
  }
  let mut child = command.spawn().map_err(|_| "TUNNEL_CURL_MISSING".to_string())?;
  if let Some(mut stdin) = child.stdin.take() {
    stdin.write_all(format!("url = \"{url}\"\n").as_bytes()).map_err(|_| "TUNNEL_CURL_FAILED".to_string())?;
  }
  let mut body = Vec::new();
  if let Some(stdout) = child.stdout.take() {
    stdout.take(5 * 1024 * 1024 + 1).read_to_end(&mut body).map_err(|_| "TUNNEL_CURL_FAILED".to_string())?;
  }
  let status = child.wait().map_err(|_| "TUNNEL_CURL_FAILED".to_string())?;
  if !status.success() || body.is_empty() || body.len() > 5 * 1024 * 1024 { return Err("TUNNEL_SUBSCRIPTION_FAILED".into()); }
  Ok(String::from_utf8_lossy(&body).into_owned())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn status_serializes_to_the_frontend_contract() {
    let mut inputs = Inputs::new();
    inputs.configured = true;
    inputs.sup = SupState::Running;
    inputs.probed = true;
    inputs.source = Source::Override;
    inputs.vpn_kind = VpnKind::Subscription;
    inputs.node_label = Some("Нидерланды".into());
    inputs.node_count = 3;
    inputs.doh_host = Some("dns.example.net".into());
    inputs.doh_state = DohState::Fallback;
    inputs.has_mtproxy = true;
    inputs.subscription_updated_at = Some(1_760_000_000_000);
    inputs.last_error = Some("SUBSCRIPTION_FAILED".into());
    inputs.services_enabled.insert("instagram".into(), false);
    inputs.route = Route::DnsOnly;
    inputs.direct.insert("x".into(), true);
    inputs.direct.insert("telegram".into(), false);
    let json = serde_json::to_value(inputs.compute()).unwrap();
    assert_eq!(json, serde_json::json!({
      "state": "dnsOnly",
      "source": "override",
      "vpnKind": "subscription",
      "nodeLabel": "Нидерланды",
      "nodeCount": 3,
      "dohState": "fallback",
      "dohHost": "dns.example.net",
      "hasMtproxy": true,
      "services": { "telegram": "unavailable", "x": "direct", "instagram": "disabled" },
      "subscriptionUpdatedAt": 1_760_000_000_000u64,
      "lastError": "SUBSCRIPTION_FAILED",
    }));
  }

  #[test]
  fn status_states_and_optional_fields() {
    let mut inputs = Inputs::new();
    let json = serde_json::to_value(inputs.compute()).unwrap();
    assert_eq!(json["state"], "notConfigured");
    assert_eq!(json["source"], "none");
    assert_eq!(json["vpnKind"], "none");
    assert_eq!(json["dohState"], "none");
    for absent in ["nodeLabel", "dohHost", "subscriptionUpdatedAt", "lastError"] {
      assert!(json.get(absent).is_none(), "{absent}");
    }
    inputs.configured = true;
    assert_eq!(inputs.compute().state, State::Starting);
    inputs.sup = SupState::Running;
    assert_eq!(inputs.compute().state, State::Starting, "до первой успешной пробы туннель не объявляется");
    inputs.probed = true;
    assert_eq!(inputs.compute().state, State::Tunnel);
    assert_eq!(inputs.compute().services["x"], ServiceRoute::Tunnel);
    inputs.route = Route::Down;
    assert_eq!(inputs.compute().state, State::Down);
    assert_eq!(inputs.compute().services["telegram"], ServiceRoute::Unavailable);
    inputs.sup = SupState::RestartRequired;
    assert_eq!(serde_json::to_value(inputs.compute()).unwrap()["state"], "restartRequired");
    // DnsOnly до первой пробы тоже виден: ключ не работает с самого старта
    inputs.sup = SupState::Running;
    inputs.probed = false;
    inputs.route = Route::DnsOnly;
    assert_eq!(inputs.compute().state, State::DnsOnly);
    assert_eq!(inputs.compute().services["x"], ServiceRoute::Unknown);
  }

  #[test]
  fn error_codes_match_the_contract() {
    for (error, code) in [
      (NetworkError::InvalidVpn, "INVALID_VPN"), (NetworkError::InvalidDoh, "INVALID_DOH"),
      (NetworkError::InvalidMtproxy, "INVALID_MTPROXY"), (NetworkError::ProbeFailed, "PROBE_FAILED"),
      (NetworkError::ApplyFailed, "APPLY_FAILED"), (NetworkError::SubscriptionFailed, "SUBSCRIPTION_FAILED"),
    ] {
      assert_eq!(serde_json::to_value(error).unwrap(), code);
      assert_eq!(error.to_string(), code);
    }
  }

  #[test]
  fn apply_request_accepts_partial_camel_case_json() {
    let request: ApplyRequest = serde_json::from_str(r#"{"vpn":"ss://a","mtproxy":""}"#).unwrap();
    assert_eq!(request.vpn.as_deref(), Some("ss://a"));
    assert_eq!(request.doh, None);
    assert_eq!(request.mtproxy.as_deref(), Some(""));
  }

  #[test]
  fn browser_args_are_fail_closed_and_complete() {
    // Порты в тестах не выбирались: прокси смотрит на закрытый порт
    let args = browser_args("telegram");
    assert!(args.contains("--proxy-server=socks5://127.0.0.1:"));
    for flag in ["--disable-quic", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp", "--dns-prefetch-disable"] {
      assert!(args.contains(flag), "{flag}");
    }
    assert!(!args.contains("host-resolver-rules"));
    assert_eq!(media_proxy_url(), None);
  }

  #[test]
  fn mtproxy_links() {
    let parsed = parse_mtproxy("tg://proxy?server=proxy.example.com&port=443&secret=ee00112233445566778899aabbccddeeff").unwrap();
    assert_eq!((parsed.server.as_str(), parsed.port), ("proxy.example.com", 443));
    assert!(parse_mtproxy("https://t.me/proxy?server=a.example.com&port=8443&secret=abcdef").is_some());
    assert!(parse_mtproxy("tg://proxy?server=a.example.com&port=0&secret=abcdef").is_none());
    assert!(parse_mtproxy("tg://proxy?server=a.example.com&port=443").is_none());
    assert!(parse_mtproxy("https://evil.example.com/proxy?server=a&port=443&secret=ab").is_none());
    assert!(parse_mtproxy("не ссылка").is_none());
  }

  #[test]
  fn listeners_receive_changes_only() {
    let received = Arc::new(Mutex::new(Vec::new()));
    let sink = received.clone();
    subscribe(move |status| sink.lock().unwrap().push(status.state));
    let before = received.lock().unwrap().len();
    update_inputs(|inputs| inputs.last_error = Some("TEST_ONLY".into()));
    update_inputs(|inputs| inputs.last_error = Some("TEST_ONLY".into()));
    assert_eq!(received.lock().unwrap().len(), before + 1, "одинаковый статус второй раз не рассылается");
    update_inputs(|inputs| inputs.last_error = None);
  }

  #[test]
  fn set_service_enabled_rejects_unknown_services() {
    assert_eq!(set_service_enabled("telegram", false).unwrap_err(), NetworkError::InvalidService);
    assert_eq!(set_service_enabled("tiktok", true).unwrap_err(), NetworkError::InvalidService);
  }
}
