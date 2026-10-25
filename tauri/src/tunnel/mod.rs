//! Собственный туннель Береста: один `xray.exe` на сессию, три loopback-порта и API на защищённом unix-сокете, лестница маршрутов.
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

pub mod config;
pub mod ladder;
pub mod store;
pub mod supervisor;
pub mod uds;
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
/// Штатный повтор после серии неудач, когда рабочий кэш узлов есть.
const SUBSCRIPTION_FAIL_RETRY: Duration = Duration::from_secs(15 * 60);
/// Повторы после первых неудач подряд: единичный сбой не должен ждать 15 минут.
const SUBSCRIPTION_BACKOFF: [Duration; 2] = [Duration::from_secs(30), Duration::from_secs(120)];
/// Автоматические запуски не чаще этого интервала (защита от дублей); явный запрос пользователя не ограничен.
const SUBSCRIPTION_MIN_GAP: Duration = Duration::from_secs(20);
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
pub enum ServiceRoute { Tunnel, Direct, LocalProxy, Unavailable, Disabled, Unknown }

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

/// Во фронтенд уходит только регистрируемая часть хоста DoH (последние два label): персональный
/// поддомен вроде `<id>.dns.nextdns.io` — часть секрета. IP-адрес отдаётся как есть.
fn public_doh_host(host: &str) -> String {
  if host.trim_matches(['[', ']']).parse::<std::net::IpAddr>().is_ok() { return host.to_string(); }
  let labels: Vec<&str> = host.split('.').filter(|label| !label.is_empty()).collect();
  if labels.len() <= 2 { return host.to_string(); }
  labels[labels.len() - 2..].join(".")
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
  /// Загрузка подписки уже идёт (монитор или прошлое нажатие): второй запуск не создан.
  RefreshBusy,
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
      Self::RefreshBusy => "REFRESH_BUSY",
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

/// Первый байт секрета MTProxy. Правило моста `scripts/telegram-transport.mjs`: пары hex-цифр — hex, иначе base64url.
fn secret_first_byte(secret: &str) -> Option<u8> {
  let hex = secret.len() % 2 == 0 && secret.bytes().all(|b| b.is_ascii_hexdigit());
  if hex { return u8::from_str_radix(&secret[..2], 16).ok(); }
  let trimmed = secret.trim_end_matches('=');
  if trimmed.len() < 2 || secret.len() - trimmed.len() > 2 { return None; }
  let value = |c: u8| match c {
    b'A'..=b'Z' => Some(c - b'A'),
    b'a'..=b'z' => Some(c - b'a' + 26),
    b'0'..=b'9' => Some(c - b'0' + 52),
    b'-' => Some(62),
    b'_' => Some(63),
    _ => None,
  };
  let bytes = trimmed.as_bytes();
  Some((value(bytes[0])? << 2) | (value(bytes[1])? >> 4))
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
  // FakeTLS (первый байт `ee`) мост не поддерживает: отказ здесь, а не молчаливый сбой Telegram позже
  if secret_first_byte(&secret) == Some(0xee) { return None; }
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
      doh_host: self.doh_host.as_deref().map(public_doh_host),
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
static NUDGE: AtomicBool = AtomicBool::new(false);
/// Растёт при каждой готовности Xray (в том числе после перезапуска): монитор заново применяет ступень.
static GENERATION: AtomicU64 = AtomicU64::new(0);
static INPUTS: LazyLock<Mutex<Inputs>> = LazyLock::new(|| Mutex::new(Inputs::new()));
static STATUS: LazyLock<RwLock<NetworkStatus>> = LazyLock::new(|| RwLock::new(Inputs::new().compute()));
static LISTENERS: LazyLock<Mutex<Vec<Listener>>> = LazyLock::new(|| Mutex::new(Vec::new()));
static CORE: LazyLock<Mutex<Option<Core>>> = LazyLock::new(|| Mutex::new(None));
/// Расписание и защита от дублей скачивания подписки. Глобальное, а не в мониторе: `configure` создаёт новый
/// монитор, и локальное состояние обнулялось бы, порождая повторные запуски подряд.
static REFRESH: LazyLock<Mutex<RefreshState>> = LazyLock::new(|| Mutex::new(RefreshState::default()));
/// Активный MTProxy: только для Rust-кода (мост Telegram), во фронтенд не отдаётся. Отдельно от `CORE`, чтобы
/// чтение не ждало долгих операций (скачивание подписки).
static MTPROXY: LazyLock<Mutex<Option<String>>> = LazyLock::new(|| Mutex::new(None));

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
  /// Время последнего удачного скачивания подписки, unix мс (0 — не скачивалась).
  subscription_updated_ms: u64,
  /// Всё для пересборки конфига под другой узел; `None`, пока Xray не настроен.
  base: Option<ConfigBase>,
  /// Конфиг надзирателя для перезапуска после падения; `None` на время `configure`.
  slot: Option<supervisor::ConfigSlot>,
}

impl MonitorCtx {
  fn label(&self) -> Option<String> {
    self.nodes.get(self.current).map(|node| node.name.clone()).filter(|name| !name.is_empty())
  }

  /// Рабочий узел сейчас.
  fn active_node(&self) -> Option<&Node> { self.nodes.get(self.current) }

  /// После перезапуска Xray в нём снова узел из конфига.
  fn reset_current(&mut self) {
    self.current = self.config_index;
    self.current_tag = config::TAG_PROXY.to_string();
  }

  /// Делает рабочий узел узлом конфига: Xray, упавший и поднятый надзирателем, останется на нём.
  fn pin_current(&mut self) {
    self.config_index = self.current;
    let (Some(base), Some(slot)) = (&self.base, &self.slot) else { return; };
    match base.build(self.nodes.get(self.current)) {
      Ok(config) => slot.set(config),
      Err(error) => log::warn!("[Tunnel] конфиг под новый узел не собран: {error}"),
    }
  }
}

/// Части конфига Xray, кроме узла: монитор пересобирает конфиг под другой узел без доступа к `Core`.
#[derive(Clone)]
struct ConfigBase {
  /// Сокет API основного процесса (`ipc/api-main.sock`).
  api_socket: PathBuf,
  doh: String,
  host_ips: BTreeMap<String, Vec<String>>,
  node_hosts: Vec<String>,
}

impl ConfigBase {
  fn build(&self, node: Option<&Node>) -> Result<serde_json::Value, String> {
    let ports = *PORTS.get().ok_or("TUNNEL_PORTS_MISSING")?;
    config::build(&config::ConfigInput { ports, api_socket: &self.api_socket.to_string_lossy(), node, doh: &self.doh, host_ips: &self.host_ips, node_hosts: &self.node_hosts })
  }
}

/// Индекс узла `node` в списке `nodes`; узлы сравниваются целиком (адрес, ключ, транспорт).
/// Узел ищется по параметрам подключения: переименование в подписке не требует перезапуска Xray.
fn index_of(nodes: &[Node], node: Option<&Node>) -> Option<usize> {
  let node = node?;
  nodes.iter().position(|candidate| {
    candidate.server == node.server
      && candidate.port == node.port
      && candidate.proto == node.proto
      && candidate.stream == node.stream
  })
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
  /// Каталог сокетов API: `network/ipc` или запасной короткий (см. `pick_ipc_dir`).
  ipc_dir: PathBuf,
  runtime_dir: PathBuf,
  store: Store,
  profile: Profile,
  nodes: Vec<Node>,
  supervisor: Option<Supervisor>,
  monitor: Option<Monitor>,
  ctx: Arc<Mutex<MonitorCtx>>,
}

// ---------- публичный API: жизненный цикл ----------

/// Запускает туннель. Вызывать до создания окон WebView. Импортирует `seed.dpapi`, выбирает три порта и создаёт защищённый каталог IPC для сокета API,
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
  let ipc_dir = match prepare_ipc_dir(&network_dir) {
    Ok(dir) => dir,
    Err(error) => {
      // Без внятного кода в статусе пользователь увидел бы просто «не работает»
      update_inputs(|inputs| inputs.last_error = Some(error.clone()));
      return Err(error);
    }
  };
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
    ipc_dir,
    runtime_dir: runtime_dir.to_path_buf(),
    store,
    profile: Profile::default(),
    nodes: Vec::new(),
    supervisor: None,
    monitor: None,
    ctx: Arc::new(Mutex::new(MonitorCtx {
      api: None, nodes: Vec::new(), config_index: 0, current: 0, current_tag: config::TAG_PROXY.into(),
      tag_seq: 0, targets: Vec::new(), doh_host: None, doh_port: 443, subscription: false, subscription_updated_ms: 0,
      base: None, slot: None,
    })),
  };
  if let Err(error) = configure(&mut core, profile) {
    log::warn!("[Tunnel] запуск не удался: {error}");
    // Код без путей: виден в статусе, пока `configure` не завершился успешно
    update_inputs(|inputs| inputs.last_error = Some(error));
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

fn set_mtproxy(link: &str) {
  *lock(&MTPROXY) = parse_mtproxy(link).map(|_| link.trim().to_string());
}

/// Включён ли сервис в настройках сети (по умолчанию да). Выключенный не создаёт WebView и не пробуется лестницей.
pub(crate) fn service_enabled(service: &str) -> bool {
  lock(&INPUTS).services_enabled.get(service).copied().unwrap_or(true)
}

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

/// Сообщает о пробуждении системы или смене сети: старые серии проб сбрасываются, идёт быстрый пакет проб.
#[allow(dead_code)] // сигнала выхода из сна пока нет; фокус окна идёт через `nudge`
pub fn wake() { WAKE.store(true, Ordering::SeqCst); }

/// Окно показано или получило фокус: внеочередная проба без сброса серий отказов (не чаще раза в 60 с).
pub fn nudge() { NUDGE.store(true, Ordering::SeqCst); }

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

/// Уникальные доменные имена хостов всех узлов (IP-адреса не нужны: их не надо разрешать).
fn node_hosts(nodes: &[Node]) -> Vec<String> {
  let mut hosts: Vec<String> = Vec::new();
  for node in nodes {
    let host = node.server.trim_matches(['[', ']']);
    if host.parse::<std::net::IpAddr>().is_err() && !hosts.iter().any(|known| known == host) { hosts.push(host.to_string()); }
  }
  hosts
}

/// Сокет API основного процесса и пробного: разные файлы, чтобы проба не задела рабочий Xray.
const API_SOCKET_MAIN: &str = "api-main.sock";
const API_SOCKET_PROBE: &str = "api-probe.sock";

fn api_socket_path(core: &Core, name: &str) -> PathBuf {
  core.ipc_dir.join(name)
}

/// Каталоги-кандидаты для сокетов в порядке предпочтения: основной, затем запасной короткий. Берутся только те,
/// где оба сокета (с уникальным суффиксом) влезают в предел AF_UNIX. Ни один не подошёл — `TUNNEL_IPC_PATH_TOO_LONG`.
/// Чистая функция: проверка длины без файловой системы. Флаг — «это запасной каталог».
fn ipc_candidates(primary: PathBuf, fallback: Option<PathBuf>) -> Result<Vec<(PathBuf, bool)>, String> {
  let fits = |dir: &Path| [API_SOCKET_MAIN, API_SOCKET_PROBE].iter()
    .all(|name| config::api_socket_fits(&supervisor::unique_socket(&dir.join(name)).to_string_lossy()));
  let list: Vec<(PathBuf, bool)> = [(Some(primary), false), (fallback, true)].into_iter()
    .filter_map(|(dir, is_fallback)| dir.filter(|dir| fits(dir)).map(|dir| (dir, is_fallback)))
    .collect();
  if list.is_empty() { Err("TUNNEL_IPC_PATH_TOO_LONG".into()) } else { Ok(list) }
}

/// Первый кандидат (используется тестами длины пути).
#[cfg(test)]
fn pick_ipc_dir(primary: PathBuf, fallback: Option<PathBuf>) -> Result<(PathBuf, bool), String> {
  ipc_candidates(primary, fallback)?.into_iter().next().ok_or_else(|| "TUNNEL_IPC_PATH_TOO_LONG".to_string())
}

/// Первый кандидат, где каталог готовится (DACL) и AF_UNIX реально работает. На части машин сокет в профиле
/// пользователя создаётся, но не принимает соединений и не удаляется (ошибка 1920): тогда берём следующий каталог.
fn select_ipc_dir(
  candidates: Vec<(PathBuf, bool)>,
  prepare: impl Fn(&Path, bool) -> Result<(), String>,
  probe: impl Fn(&Path) -> bool,
) -> Result<PathBuf, String> {
  let mut last = "TUNNEL_IPC_UNSUPPORTED".to_string();
  for (dir, is_fallback) in candidates {
    if let Err(error) = prepare(&dir, is_fallback) {
      last = error;
      continue;
    }
    if probe(&dir) {
      if is_fallback { log::warn!("[Tunnel] сокет API в запасном каталоге"); }
      return Ok(dir);
    }
    log::warn!("[Tunnel] AF_UNIX в каталоге сокетов не работает, пробую следующий");
    last = "TUNNEL_IPC_UNSUPPORTED".to_string();
  }
  Err(last)
}

/// Запасной каталог сокета: `%ProgramData%\EgoistRelay\<hash8 от SID>\ipc`.
#[cfg(windows)]
fn fallback_ipc_dir() -> Option<PathBuf> {
  let base = std::env::var_os("ProgramData").map(PathBuf::from).filter(|path| path.is_absolute())?;
  let hash = crate::win_acl::current_user_hash8().ok()?;
  Some(base.join("EgoistRelay").join(hash).join(supervisor::IPC_DIR))
}
#[cfg(not(windows))]
fn fallback_ipc_dir() -> Option<PathBuf> { None }

/// Готовит защищённый каталог IPC: основной, а при длинном пути профиля или неработающем AF_UNIX в нём — запасной
/// в `%ProgramData%`.
fn prepare_ipc_dir(network_dir: &Path) -> Result<PathBuf, String> {
  let primary = network_dir.join(supervisor::IPC_DIR);
  let candidates = ipc_candidates(primary, fallback_ipc_dir())?;
  select_ipc_dir(
    candidates,
    |dir, is_fallback| {
      if !is_fallback { return secure_ipc_dir(dir); }
      secure_fallback_ipc_dir(dir)?;
      // Остатки сокетов после аварийного выхода (основной каталог чистит надзиратель)
      supervisor::purge_leftovers(dir.parent());
      Ok(())
    },
    uds::probe_dir,
  )
}

/// Создаёт цепочку `EgoistRelay\<hash>\ipc`: верхний каталог общий (обычный), нижние два — с явным DACL и
/// проверкой владельца; чужой владелец или ссылка — отказ.
#[cfg(windows)]
fn secure_fallback_ipc_dir(ipc: &Path) -> Result<(), String> {
  let user_dir = ipc.parent().ok_or("TUNNEL_IPC_ACL_FAILED")?;
  let root = user_dir.parent().ok_or("TUNNEL_IPC_ACL_FAILED")?;
  std::fs::create_dir_all(root).map_err(|_| "TUNNEL_IPC_ACL_FAILED".to_string())?;
  let meta = std::fs::symlink_metadata(root).map_err(|_| "TUNNEL_IPC_ACL_FAILED".to_string())?;
  use std::os::windows::fs::MetadataExt;
  if !meta.is_dir() || meta.file_attributes() & 0x400 != 0 { return Err("TUNNEL_IPC_ACL_FAILED".into()); }
  for dir in [user_dir, ipc] {
    crate::win_acl::secure_directory_owned(dir).map_err(|_| "TUNNEL_IPC_ACL_FAILED".to_string())?;
  }
  Ok(())
}
#[cfg(not(windows))]
fn secure_fallback_ipc_dir(_ipc: &Path) -> Result<(), String> { Err("TUNNEL_IPC_ACL_FAILED".into()) }

/// Создаёт каталог IPC и выставляет DACL: только текущий пользователь и SYSTEM. Обратного пути на TCP нет:
/// без защищённого каталога API Xray остался бы доступен любому локальному процессу.
#[cfg(windows)]
fn secure_ipc_dir(dir: &Path) -> Result<(), String> {
  crate::win_acl::secure_directory(dir).map_err(|_| "TUNNEL_IPC_ACL_FAILED".to_string())
}
#[cfg(not(windows))]
fn secure_ipc_dir(_dir: &Path) -> Result<(), String> { Err("TUNNEL_IPC_ACL_FAILED".into()) }

fn make_spec(core: &Core, ports: Ports, nodes: &[Node], doh: &str, config_name: &str, socket_name: &str) -> Spec {
  let mut secrets: Vec<String> = nodes.iter().map(|node| node.server.clone()).collect();
  if let Some((host, _)) = doh_host_port(doh) { secrets.push(host); }
  secrets.sort();
  secrets.dedup();
  Spec {
    xray_exe: core.runtime_dir.join("xray.exe"),
    asset_dir: core.runtime_dir.clone(),
    config_path: core.network_dir.join(config_name),
    api_socket: api_socket_path(core, socket_name),
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
  // Старый монитор может ещё дорабатывать смену узла: без слота он не перепишет новый конфиг надзирателя
  let preferred = {
    let mut ctx = lock(&core.ctx);
    ctx.slot = None;
    ctx.active_node().cloned()
  };
  let Some(prov) = resolved.prov.clone() else {
    // Ключа нет: Xray не нужен, окна остаются с закрытым прокси
    if let Some(mut supervisor) = core.supervisor.take() { supervisor.stop(); }
    READY.store(false, Ordering::SeqCst);
    core.profile = profile;
    core.nodes = Vec::new();
    set_mtproxy("");
    update_inputs(|inputs| {
      *inputs = Inputs { services_enabled: core.profile.services_enabled.clone(), ..Inputs::new() };
    });
    return Ok(());
  };
  let base = ConfigBase {
    api_socket: api_socket_path(core, API_SOCKET_MAIN),
    doh: prov.doh_url().to_string(),
    host_ips: profile.bootstrap_ips.clone(),
    node_hosts: node_hosts(&resolved.nodes),
  };
  // Рабочий узел остаётся рабочим и после пересборки: первый узел подписки мог только что отказать
  let config_index = index_of(&resolved.nodes, preferred.as_ref()).unwrap_or(0);
  let config = base.build(resolved.nodes.get(config_index))?;
  match core.supervisor.as_ref() {
    Some(supervisor) => {
      log::info!("[Tunnel] перезапуск xray с новым конфигом (узел {} из {})", config_index + 1, resolved.nodes.len());
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
      let spec = make_spec(core, ports, &resolved.nodes, prov.doh_url(), "xray.json", API_SOCKET_MAIN);
      core.supervisor = Some(Supervisor::start(spec, config, supervisor_sink())?);
    }
  }
  core.nodes = resolved.nodes.clone();
  core.profile = profile;
  set_mtproxy(&prov.mtproxy);
  let (doh_host, doh_port) = doh_host_port(prov.doh_url()).unzip();
  {
    let mut ctx = lock(&core.ctx);
    ctx.api = core.supervisor.as_ref().map(Supervisor::api);
    ctx.slot = core.supervisor.as_ref().map(Supervisor::config_slot);
    ctx.base = Some(base);
    ctx.nodes = resolved.nodes.clone();
    ctx.config_index = config_index;
    ctx.current = config_index;
    ctx.current_tag = config::TAG_PROXY.to_string();
    ctx.tag_seq = 0;
    ctx.targets = ladder::targets_for(|service| core.profile.service_enabled(service));
    ctx.doh_host = doh_host.clone();
    ctx.doh_port = doh_port.unwrap_or(443);
    ctx.subscription = resolved.subscription;
    ctx.subscription_updated_ms = core.profile.subscription_updated_at_ms;
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
  let (targets, no_nodes) = { let ctx = lock(&ctx); (ctx.targets.clone(), ctx.nodes.is_empty()) };
  // Без узла (подписка ещё не скачана) ждать три отказа проб незачем: сразу ступень 2, трафик идёт напрямую через DoH
  let start_route = if no_nodes { Route::DnsOnly } else { Route::Tunnel };
  let mut runner = Runner::with_route(SystemClock::new(), NetProber { probe_proxy: ports.probe_proxy, probe_direct: ports.probe_direct }, targets, start_route);
  let mut seen_generation = GENERATION.load(Ordering::SeqCst);
  let mut applied_direct = false;
  let mut rotations: usize = 0;
  let mut tick_no: u32 = 0;
  let mut probed = false;
  loop {
    match stop.recv_timeout(runner.ladder.next_delay()) {
      Err(mpsc::RecvTimeoutError::Timeout) => {}
      _ => return,
    }
    if cancelled.load(Ordering::SeqCst) { return; }
    if WAKE.swap(false, Ordering::SeqCst) { runner.ladder.wake(); }
    if NUDGE.swap(false, Ordering::SeqCst) { runner.nudge(); }
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
        // Пока шли пробы, `configure` мог заменить Xray и узлы: отменённый монитор новый конфиг не трогает
        if cancelled.load(Ordering::SeqCst) { return; }
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
    // Без узлов балансера нет (конфиг и так уходит в direct): `xray api bo` упал бы и каждые 5 с спавнил процесс
    if node_count == 0 {
      applied_direct = want_direct;
    } else if want_direct != applied_direct {
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
    // Подписка: сразу после готовности Xray, если кэш пуст или старше 12 часов; дальше раз в 12 часов
    let (subscription, empty, updated_ms) = { let ctx = lock(&ctx); (ctx.subscription, ctx.nodes.is_empty(), ctx.subscription_updated_ms) };
    if subscription && !cancelled.load(Ordering::SeqCst) && lock(&REFRESH).try_begin_auto(now_ms(), updated_ms, empty) {
      // Сеть (до 25 с) не должна задерживать пробы: загрузка в отдельном потоке, неудача кэш не стирает
      refresh_in_background();
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
  ctx.pin_current();
  Ok(())
}

/// Запускает скачивание подписки в отдельном потоке: монитор не ждёт сеть, а `CORE` берётся только
/// на снимок адреса и на короткое применение результата. Расписание уже отмечено `try_begin_auto`.
fn refresh_in_background() {
  let spawned = std::thread::Builder::new().name("relay-tunnel-subscription".into()).spawn(|| {
    // Флаг `in_flight` уже поднят `try_begin_auto`; guard снимет его и при панике
    let guard = RefreshGuard::new();
    let job = match with_core(|core| refresh_job(core)) {
      Ok(job) => job,
      Err(_) => { guard.abort(); return; }
    };
    let result = run_refresh(&job);
    if let Err(error) = &result {
      // Рабочий кэш узлов остаётся как был; код ошибки без адреса подписки
      log::warn!("[Tunnel] обновление подписки: {error}");
    }
    guard.finish(result.is_ok());
  });
  if spawned.is_err() {
    log::warn!("[Tunnel] поток обновления подписки не запущен");
    lock(&REFRESH).abort();
  }
}

/// Владелец поднятого `REFRESH.in_flight`: `Drop` снимает флаг, даже если загрузка запаниковала, иначе
/// автообновление подписки встало бы навсегда. Паника считается неудачей (счётчик растёт, пауза не нулевая).
struct RefreshGuard { settled: bool }

impl RefreshGuard {
  fn new() -> Self { Self { settled: false } }
  fn finish(mut self, ok: bool) { self.settled = true; lock(&REFRESH).finish(ok); }
  fn abort(mut self) { self.settled = true; lock(&REFRESH).abort(); }
}

impl Drop for RefreshGuard {
  fn drop(&mut self) { if !self.settled { lock(&REFRESH).finish(false); } }
}

/// Расписание скачивания подписки по виртуальному времени (миллисекунды unix), без часов и сети.
#[derive(Debug, Default)]
struct RefreshState {
  last_attempt_ms: Option<u64>,
  /// Неудач подряд; сбрасывается после успеха.
  failures: u32,
  /// Загрузка уже идёт: второй запуск не нужен.
  in_flight: bool,
}

impl RefreshState {
  /// Пауза до следующей попытки: сразу после успеха и до первой неудачи — минимальная; после неудач
  /// 30 с, затем 2 мин, дальше штатные 15 минут (минута, пока в подписке нет ни одного узла).
  fn retry_gap(&self, no_nodes: bool) -> Duration {
    match self.failures {
      0 => SUBSCRIPTION_MIN_GAP,
      n if (n as usize) <= SUBSCRIPTION_BACKOFF.len() => SUBSCRIPTION_BACKOFF[n as usize - 1],
      _ if no_nodes => SUBSCRIPTION_RETRY,
      _ => SUBSCRIPTION_FAIL_RETRY,
    }
  }

  /// Пора ли качать: кэш пуст или старше 12 часов, ничего не качается, прошла пауза после прошлой попытки.
  fn due(&self, now_ms: u64, updated_ms: u64, no_nodes: bool) -> bool {
    if self.in_flight { return false; }
    let stale = updated_ms == 0 || now_ms.saturating_sub(updated_ms) >= SUBSCRIPTION_REFRESH.as_millis() as u64;
    if !(no_nodes || stale) { return false; }
    let Some(last) = self.last_attempt_ms else { return true; };
    now_ms.saturating_sub(last) >= self.retry_gap(no_nodes).as_millis() as u64
  }

  /// Автоматический запуск: отмечает начало, если по расписанию пора.
  fn try_begin_auto(&mut self, now_ms: u64, updated_ms: u64, no_nodes: bool) -> bool {
    if !self.due(now_ms, updated_ms, no_nodes) { return false; }
    self.in_flight = true;
    self.last_attempt_ms = Some(now_ms);
    true
  }

  /// Явный запрос пользователя: расписание не мешает, но параллельной загрузки не будет.
  fn try_begin_manual(&mut self, now_ms: u64) -> bool {
    if self.in_flight { return false; }
    self.in_flight = true;
    self.last_attempt_ms = Some(now_ms);
    true
  }

  /// Загрузка закончилась: успех сбрасывает счётчик неудач.
  fn finish(&mut self, ok: bool) {
    self.in_flight = false;
    self.failures = if ok { 0 } else { self.failures.saturating_add(1) };
  }

  /// Попытка не состоялась (ядро остановлено, подписки нет): не неудача сети, счётчик не меняется.
  fn abort(&mut self) { self.in_flight = false; }
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
      set_mtproxy(core.profile.active().map(|p| p.mtproxy.as_str()).unwrap_or(""));
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
/// `SUBSCRIPTION_FAILED`, прежний кэш остаётся. Сеть работает без `CORE`; если загрузка уже идёт (монитор или
/// прошлое нажатие), второй запуск не создаётся и возвращается `REFRESH_BUSY` (интерфейс показывает общую
/// ошибку; на статус и `last_error` код не влияет).
pub fn refresh_subscription() -> Result<NetworkStatus, NetworkError> {
  let job = with_core(|core| refresh_job(core))?;
  if !lock(&REFRESH).try_begin_manual(now_ms()) { return Err(NetworkError::RefreshBusy); }
  let guard = RefreshGuard::new();
  let result = run_refresh(&job);
  guard.finish(result.is_ok());
  result?;
  Ok(status())
}

fn refresh_fail(error: NetworkError) -> NetworkError {
  update_inputs(|inputs| inputs.last_error = Some(error.code().into()));
  error
}

/// Что нужно для загрузки: адрес подписки и порт SOCKS. Снимается под коротким замком.
struct RefreshJob {
  url: String,
  socks: u16,
}

fn refresh_job(core: &Core) -> Result<RefreshJob, NetworkError> {
  let Some(VpnSource::SubscriptionUrl(url)) = core.profile.active().map(Provisioning::source) else {
    return Err(NetworkError::SubscriptionFailed);
  };
  let socks = PORTS.get().map(|p| p.socks).ok_or_else(|| refresh_fail(NetworkError::SubscriptionFailed))?;
  Ok(RefreshJob { url, socks })
}

/// Скачивает (без `CORE`) и коротко применяет результат под замком.
fn run_refresh(job: &RefreshJob) -> Result<(), NetworkError> {
  let body = fetch_subscription(&job.url, job.socks).map_err(|_| refresh_fail(NetworkError::SubscriptionFailed))?;
  with_core(|core| apply_downloaded(core, job, body))
}

/// Что делать с Xray после новой подписки.
#[derive(Debug, PartialEq)]
enum RefreshPlan {
  /// Нужен перезапуск: рабочего узла нет в подписке или конфиг Xray не собран.
  Restart,
  /// Без перезапуска: `nodes` — узлы, которые работающий Xray может использовать, `deferred` — узлы с новыми
  /// хостами, отложенные до ближайшего перезапуска.
  InPlace { nodes: Vec<Node>, active_index: usize, deferred: usize },
}

/// Перезапуск рвёт все соединения окон, поэтому он только по делу. Bootstrap-домены узлов живут только в
/// конфиге работающего Xray (`running_hosts`), поэтому узел с новым доменом без перезапуска недоступен для
/// ротации. Поэтому: рабочий узел на месте — Xray не трогаем, новые хосты не вносим, а узлы с известными
/// хостами обновляем; кэш подписки уже сохранён целиком, и отложенные узлы подхватит любой следующий
/// `configure` (перезапуск, `apply`, `reset`). Перезапуск нужен, лишь когда пропал рабочий узел (его хост и
/// bootstrap нужны именно ему) либо конфиг ещё не собран. DoH подпиской не меняется, поэтому его хост не в счёт.
fn plan_refresh(running_hosts: Option<&[String]>, active: Option<&Node>, parsed: &[Node]) -> RefreshPlan {
  let Some(running) = running_hosts else { return RefreshPlan::Restart; };
  if index_of(parsed, active).is_none() { return RefreshPlan::Restart; }
  let known = |node: &Node| {
    let host = node.server.trim_matches(['[', ']']);
    host.parse::<std::net::IpAddr>().is_ok() || running.iter().any(|known| known == host)
  };
  let nodes: Vec<Node> = parsed.iter().filter(|node| known(node)).cloned().collect();
  // Рабочий узел сам работает на известном хосте; если нет, считаем конфиг нестабильным и перезапускаем
  let Some(active_index) = index_of(&nodes, active) else { return RefreshPlan::Restart; };
  RefreshPlan::InPlace { deferred: parsed.len() - nodes.len(), nodes, active_index }
}

fn apply_downloaded(core: &mut Core, job: &RefreshJob, body: String) -> Result<(), NetworkError> {
  // Пока шла загрузка, пользователь мог сменить ключ: чужой результат не применяем
  match core.profile.active().map(Provisioning::source) {
    Some(VpnSource::SubscriptionUrl(url)) if url == job.url => {}
    _ => {
      log::info!("[Tunnel] подписка сменилась во время загрузки, результат отброшен");
      return Ok(());
    }
  }
  let parsed = uri::parse_text(&body);
  if parsed.nodes.is_empty() { return Err(refresh_fail(NetworkError::SubscriptionFailed)); }
  let mut profile = core.profile.clone();
  profile.subscription_cache = body;
  profile.subscription_updated_at_ms = now_ms();
  core.store.save(&profile).map_err(|_| refresh_fail(NetworkError::SubscriptionFailed))?;
  let (running_hosts, active) = {
    let ctx = lock(&core.ctx);
    (ctx.base.as_ref().map(|base| base.node_hosts.clone()), ctx.active_node().cloned())
  };
  match plan_refresh(running_hosts.as_deref(), active.as_ref(), &parsed.nodes) {
    RefreshPlan::Restart => {
      log::info!("[Tunnel] подписка обновлена: {} узлов, рабочий узел исчез, перезапуск", parsed.nodes.len());
      configure(core, profile).map_err(|_| refresh_fail(NetworkError::SubscriptionFailed))?;
    }
    RefreshPlan::InPlace { nodes, active_index, deferred } => {
      // Рабочий узел на месте: обновляем список запасных, его индекс в новом списке и время
      log::info!("[Tunnel] подписка обновлена без перезапуска: {} узлов, отложено с новыми хостами {deferred}", nodes.len());
      core.profile = profile;
      core.nodes = nodes.clone();
      let mut ctx = lock(&core.ctx);
      ctx.nodes = nodes.clone();
      ctx.current = active_index;
      ctx.pin_current();
      ctx.subscription_updated_ms = core.profile.subscription_updated_at_ms;
      drop(ctx);
      let updated = Some(core.profile.subscription_updated_at_ms);
      update_inputs(|inputs| {
        inputs.node_count = nodes.len();
        inputs.subscription_updated_at = updated;
      });
    }
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
  let hosts = node_hosts(nodes);
  let api_socket = api_socket_path(core, API_SOCKET_PROBE);
  let config = config::build(&config::ConfigInput {
    ports,
    api_socket: &api_socket.to_string_lossy(),
    node: nodes.first(),
    doh: candidate.doh_url(),
    host_ips: &BTreeMap::new(),
    node_hosts: &hosts,
  }).map_err(|_| NetworkError::InvalidDoh)?;
  let spec = make_spec(core, ports, nodes, candidate.doh_url(), "xray-probe.json", API_SOCKET_PROBE);
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
  // Только абсолютный путь к системному curl: поиск по PATH подсунул бы чужой исполняемый файл
  let curl = std::env::var_os("SystemRoot")
    .map(|root| PathBuf::from(root).join("System32").join("curl.exe"))
    .filter(|path| path.is_file())
    .ok_or_else(|| "TUNNEL_CURL_MISSING".to_string())?;
  let mut command = Command::new(curl);
  command.args(["-q", "-sS", "--fail", "--location", "--max-redirs", "5", "--connect-timeout", "10", "--max-time", "25", "--max-filesize", "5242880", "-K", "-"])
    .arg("--proxy").arg(format!("socks5h://127.0.0.1:{socks_port}"))
    .args(["-A", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"])
    .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
  // Свои настройки прокси из окружения curl не нужны: путь задан явно, `-K` читает только stdin
  for name in ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy", "CURL_HOME"] {
    command.env_remove(name);
  }
  #[cfg(windows)]
  {
    use std::os::windows::process::CommandExt;
    command.creation_flags(0x0800_0000);
  }
  let mut child = command.spawn().map_err(|_| "TUNNEL_CURL_MISSING".to_string())?;
  if let Some(mut stdin) = child.stdin.take() {
    stdin.write_all(format!("url = \"{url}\"\n").as_bytes()).map_err(|_| "TUNNEL_CURL_FAILED".to_string())?;
  }
  // stderr читаем отдельным потоком (пайп не должен заполниться); в журнал идёт только код и фиксированная причина
  let stderr_reader = child.stderr.take().map(|stderr| std::thread::spawn(move || read_curl_stderr(stderr)));
  let mut body = Vec::new();
  if let Some(stdout) = child.stdout.take() {
    stdout.take(5 * 1024 * 1024 + 1).read_to_end(&mut body).map_err(|_| "TUNNEL_CURL_FAILED".to_string())?;
  }
  let status = child.wait().map_err(|_| "TUNNEL_CURL_FAILED".to_string())?;
  let stderr_text = stderr_reader.and_then(|reader| reader.join().ok()).unwrap_or_default();
  if !status.success() {
    log::warn!("[Tunnel] загрузка подписки: {}", curl_failure_reason(status.code(), &stderr_text));
  }
  if !status.success() || body.is_empty() || body.len() > 5 * 1024 * 1024 { return Err("TUNNEL_SUBSCRIPTION_FAILED".into()); }
  Ok(String::from_utf8_lossy(&body).into_owned())
}

/// Предел stderr curl, который держим в памяти; остальное читается и выбрасывается.
const CURL_STDERR_LIMIT: u64 = 4096;

fn read_curl_stderr<R: std::io::Read>(reader: R) -> String {
  use std::io::Read;
  let mut reader = reader;
  let mut head = Vec::new();
  let _ = reader.by_ref().take(CURL_STDERR_LIMIT).read_to_end(&mut head);
  let _ = std::io::copy(&mut reader, &mut std::io::sink());
  String::from_utf8_lossy(&head).into_owned()
}

/// Короткая причина отказа curl: код выхода + фиксированный текст. Текст stderr в журнал не идёт
/// (в нём бывают адрес подписки и хосты); из него берётся только HTTP-код вида «returned error: 403».
fn curl_failure_reason(code: Option<i32>, stderr: &str) -> String {
  let Some(code) = code else { return "curl завершён без кода выхода".into() };
  let reason = match code {
    5 | 6 => "не разрешилось имя узла",
    7 => "не удалось подключиться",
    22 => "сервер вернул ошибку HTTP",
    28 => "timeout",
    35 | 51 | 58 | 60 => "ошибка TLS",
    47 => "слишком много редиректов",
    56 => "обрыв при получении",
    63 => "превышен размер ответа",
    97 => "ошибка SOCKS-прокси",
    _ => "прочая ошибка",
  };
  let http = stderr.split("returned error:").nth(1)
    .map(|rest| rest.trim_start().chars().take_while(char::is_ascii_digit).take(3).collect::<String>())
    .filter(|digits| digits.len() == 3);
  match http {
    Some(http) => format!("curl exit {code}: {reason} (HTTP {http})"),
    None => format!("curl exit {code}: {reason}"),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn curl_reason_has_code_and_no_stderr_text() {
    let stderr = "curl: (22) The requested URL returned error: 403
https://sub.example.com/token/abcdef";
    let text = curl_failure_reason(Some(22), stderr);
    assert_eq!(text, "curl exit 22: сервер вернул ошибку HTTP (HTTP 403)");
    assert!(!text.contains("example") && !text.contains("abcdef"));
    assert_eq!(curl_failure_reason(Some(28), "curl: (28) timed out https://x.test/s"), "curl exit 28: timeout");
    assert_eq!(curl_failure_reason(None, ""), "curl завершён без кода выхода");
  }

  #[test]
  fn curl_stderr_is_bounded() {
    let big = "x".repeat(100_000);
    assert_eq!(read_curl_stderr(big.as_bytes()).len(), CURL_STDERR_LIMIT as usize);
  }

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
      "dohHost": "example.net",
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
  fn doh_host_is_reduced_for_frontend() {
    assert_eq!(public_doh_host("dns.nextdns.io"), "nextdns.io");
    assert_eq!(public_doh_host("abc123.dns.nextdns.io"), "nextdns.io");
    assert_eq!(public_doh_host("example.net"), "example.net");
    assert_eq!(public_doh_host("203.0.113.5"), "203.0.113.5");
    assert_eq!(public_doh_host("2001:db8::1"), "2001:db8::1");
  }

  #[test]
  fn node_hosts_are_unique_domains_of_all_nodes() {
    let nodes: Vec<Node> = ["trojan://p@a.example.com:443", "trojan://p@b.example.com:443", "trojan://p@a.example.com:8443", "ss://aes-256-gcm:pw@192.0.2.10:8388"]
      .iter().map(|link| uri::parse_link(link).unwrap()).collect();
    assert_eq!(node_hosts(&nodes), vec!["a.example.com".to_string(), "b.example.com".to_string()]);
  }

  #[test]
  fn mtproxy_links() {
    let parsed = parse_mtproxy("tg://proxy?server=proxy.example.com&port=443&secret=dd00112233445566778899aabbccddeeff").unwrap();
    assert_eq!((parsed.server.as_str(), parsed.port), ("proxy.example.com", 443));
    assert!(parse_mtproxy("tg://proxy?server=proxy.example.com&port=443&secret=00112233445566778899aabbccddeeff").is_some());
    // FakeTLS (ee…): hex и base64url
    assert!(parse_mtproxy("tg://proxy?server=proxy.example.com&port=443&secret=ee00112233445566778899aabbccddeeff6578616d706c652e6f7267").is_none());
    assert!(parse_mtproxy("tg://proxy?server=proxy.example.com&port=443&secret=EE00112233445566778899aabbccddeeff").is_none());
    assert!(parse_mtproxy("tg://proxy?server=proxy.example.com&port=443&secret=7gARIjNEVWZ3iJmqu8zd7_9leGFtcGxlLm9yZw").is_none());
    assert!(parse_mtproxy("tg://proxy?server=proxy.example.com&port=443&secret=3QARIjNEVWZ3iJmqu8zd7_8").is_some());
    assert!(parse_mtproxy("https://t.me/proxy?server=a.example.com&port=8443&secret=abcdef").is_some());
    assert!(parse_mtproxy("tg://proxy?server=a.example.com&port=0&secret=abcdef").is_none());
    assert!(parse_mtproxy("tg://proxy?server=a.example.com&port=443").is_none());
    assert!(parse_mtproxy("https://evil.example.com/proxy?server=a&port=443&secret=ab").is_none());
    assert!(parse_mtproxy("не ссылка").is_none());
  }

  #[test]
  fn long_profile_path_uses_short_fallback_ipc_dir() {
    let short = |len: usize| PathBuf::from(format!("C:/{}", "a".repeat(len)));
    let fallback = PathBuf::from("C:/ProgramData/EgoistRelay/0123abcd/ipc");
    // Короткий основной путь остаётся основным
    let (dir, used) = pick_ipc_dir(short(20), Some(fallback.clone())).unwrap();
    assert!(!used && dir == short(20));
    // Длинное имя пользователя: запасной путь, обе сокета ≤ предела
    let (dir, used) = pick_ipc_dir(short(120), Some(fallback.clone())).unwrap();
    assert!(used && dir == fallback);
    for name in [API_SOCKET_MAIN, API_SOCKET_PROBE] {
      assert!(dir.join(name).to_string_lossy().len() <= config::API_SOCKET_MAX_BYTES);
    }
    // Оба длинные или запасного нет: внятная ошибка без путей
    let long_fallback = PathBuf::from(format!("C:/ProgramData/{}/ipc", "b".repeat(120)));
    assert_eq!(pick_ipc_dir(short(120), Some(long_fallback)).unwrap_err(), "TUNNEL_IPC_PATH_TOO_LONG");
    assert_eq!(pick_ipc_dir(short(120), None).unwrap_err(), "TUNNEL_IPC_PATH_TOO_LONG");
  }

  #[test]
  fn ipc_dir_falls_through_candidates_until_unix_sockets_work() {
    let primary = PathBuf::from("C:/Users/u/AppData/Local/app/network/ipc");
    let fallback = PathBuf::from("C:/ProgramData/EgoistRelay/0123abcd/ipc");
    let candidates = || ipc_candidates(primary.clone(), Some(fallback.clone())).unwrap();
    assert_eq!(candidates(), vec![(primary.clone(), false), (fallback.clone(), true)]);
    let ok = |_: &Path, _: bool| Ok(());
    // AF_UNIX работает в основном каталоге: запасной не нужен
    assert_eq!(select_ipc_dir(candidates(), ok, |_| true).unwrap(), primary);
    // В профиле сокет не принимает соединений (1920): берётся запасной
    assert_eq!(select_ipc_dir(candidates(), ok, |dir| dir != primary).unwrap(), fallback);
    // Основной не удалось защитить: тоже запасной
    let acl = |dir: &Path, _: bool| if dir == primary { Err("TUNNEL_IPC_ACL_FAILED".to_string()) } else { Ok(()) };
    assert_eq!(select_ipc_dir(candidates(), acl, |_| true).unwrap(), fallback);
    // Нигде не работает: внятный код, а не бесконечные повторы запуска
    assert_eq!(select_ipc_dir(candidates(), ok, |_| false).unwrap_err(), "TUNNEL_IPC_UNSUPPORTED");
    let acl_all = |_: &Path, _: bool| Err("TUNNEL_IPC_ACL_FAILED".to_string());
    assert_eq!(select_ipc_dir(candidates(), acl_all, |_| true).unwrap_err(), "TUNNEL_IPC_ACL_FAILED");
    // Длинный основной путь: остаётся только запасной
    let long = PathBuf::from(format!("C:/{}", "a".repeat(120)));
    assert_eq!(ipc_candidates(long, Some(fallback.clone())).unwrap(), vec![(fallback, true)]);
  }

  #[cfg(windows)]
  #[test]
  fn real_ipc_dir_is_prepared_and_unix_sockets_work_in_it() {
    let base = std::env::var_os("EGOIST_RELAY_TEST_WORK").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    let network = base.join(format!("tn-{}", &uuid::Uuid::new_v4().simple().to_string()[..8]));
    std::fs::create_dir_all(&network).unwrap();
    let dir = prepare_ipc_dir(&network).expect("каталог сокетов");
    assert!(uds::probe_dir(&dir));
    let _ = std::fs::remove_dir_all(&network);
  }

  #[test]
  fn refresh_flag_is_released_after_panic() {
    assert!(lock(&REFRESH).try_begin_manual(now_ms()), "флаг свободен до теста");
    let failures_before = lock(&REFRESH).failures;
    let handle = std::thread::spawn(|| {
      let _guard = RefreshGuard::new();
      panic!("проверка: паника во время загрузки");
    });
    assert!(handle.join().is_err());
    let state = lock(&REFRESH);
    assert!(!state.in_flight, "после паники флаг снят");
    assert_eq!(state.failures, failures_before + 1, "паника считается неудачей");
    drop(state);
    lock(&REFRESH).finish(true);
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
  fn refresh_schedule_on_virtual_time() {
    const HOUR: u64 = 3_600_000;
    const MINUTE: u64 = 60_000;
    const SECOND: u64 = 1_000;
    let now = 100 * HOUR;
    // пустой кэш: качаем сразу
    let mut state = RefreshState::default();
    assert!(state.try_begin_auto(now, 0, true));
    // после первого отказа: 30 с, затем 2 минуты, затем минута (узлов нет)
    state.finish(false);
    assert!(!state.due(now + 29 * SECOND, 0, true));
    assert!(state.due(now + 30 * SECOND, 0, true));
    assert!(state.try_begin_auto(now + 30 * SECOND, 0, true));
    state.finish(false);
    assert!(!state.due(now + 30 * SECOND + 119 * SECOND, 0, true));
    assert!(state.due(now + 30 * SECOND + 2 * MINUTE, 0, true));
    assert!(state.try_begin_auto(now + 150 * SECOND, 0, true));
    state.finish(false);
    assert!(!state.due(now + 150 * SECOND + 59 * SECOND, 0, true));
    assert!(state.due(now + 150 * SECOND + MINUTE, 0, true));
    // свежий кэш с узлами: не качаем
    let mut state = RefreshState::default();
    assert!(!state.due(now, now - HOUR, false));
    // старше 12 часов на старте: качаем сразу
    assert!(state.try_begin_auto(now, now - 12 * HOUR, false));
    // единичный сбой при рабочем кэше: повтор через 30 с, а не 15 минут
    state.finish(false);
    assert!(!state.due(now + 29 * SECOND, now - 12 * HOUR, false));
    assert!(state.due(now + 30 * SECOND, now - 12 * HOUR, false));
    // вторая неудача: 2 минуты; третья и дальше: штатные 15 минут
    assert!(state.try_begin_auto(now + 30 * SECOND, now - 12 * HOUR, false));
    state.finish(false);
    assert!(!state.due(now + 30 * SECOND + MINUTE, now - 12 * HOUR, false));
    assert!(state.due(now + 30 * SECOND + 2 * MINUTE, now - 12 * HOUR, false));
    let t = now + 30 * SECOND + 2 * MINUTE;
    assert!(state.try_begin_auto(t, now - 12 * HOUR, false));
    state.finish(false);
    assert!(!state.due(t + 14 * MINUTE, now - 12 * HOUR, false));
    assert!(state.due(t + 15 * MINUTE, now - 12 * HOUR, false));
    // успех сбрасывает счётчик, отсчёт 12 часов идёт от нового времени обновления
    assert!(state.try_begin_auto(t + 15 * MINUTE, now - 12 * HOUR, false));
    state.finish(true);
    assert_eq!(state.failures, 0);
    assert!(!state.due(t + 16 * MINUTE, t + 15 * MINUTE, false));
    assert!(state.due(t + 12 * HOUR + 15 * MINUTE, t + 15 * MINUTE, false));
    // кэш никогда не скачивался (0), но узлы есть из ссылки-файла: тоже качаем
    assert!(RefreshState::default().due(now, 0, false));
  }

  #[test]
  fn refresh_never_runs_twice_at_once() {
    const SECOND: u64 = 1_000;
    let now = 1_000_000;
    let mut state = RefreshState::default();
    assert!(state.try_begin_auto(now, 0, true));
    // идёт загрузка: ни монитор, ни кнопка второй запуск не создают
    assert!(!state.try_begin_auto(now + 60 * SECOND, 0, true));
    assert!(!state.try_begin_manual(now + 1));
    state.finish(true);
    // автоматический запуск не чаще минимального интервала, даже при пустом кэше
    assert!(!state.try_begin_auto(now + 5 * SECOND, 0, true));
    // явный запрос пользователя интервалом не ограничен
    assert!(state.try_begin_manual(now + 5 * SECOND));
    state.finish(true);
    // отказ без попытки (ядро остановлено) освобождает защиту и не копит неудачи
    assert!(state.try_begin_manual(now + 100 * SECOND));
    state.abort();
    assert_eq!(state.failures, 0);
    assert!(state.try_begin_manual(now + 101 * SECOND));
  }

  fn nodes_of(links: &[&str]) -> Vec<Node> {
    links.iter().map(|link| uri::parse_link(link).unwrap()).collect()
  }

  #[test]
  fn new_hosts_do_not_restart_while_active_node_stays() {
    let running = vec!["a.example.com".to_string(), "b.example.com".to_string()];
    let current = nodes_of(&["trojan://p@a.example.com:443", "trojan://p@b.example.com:443"]);
    // подписка принесла новый домен c.example.com и переставила узлы: рабочий узел a на месте
    let parsed = nodes_of(&["trojan://p@c.example.com:443", "trojan://p@b.example.com:443", "trojan://p@a.example.com:443", "ss://aes-256-gcm:pw@192.0.2.10:8388"]);
    match plan_refresh(Some(&running), current.first(), &parsed) {
      RefreshPlan::InPlace { nodes, active_index, deferred } => {
        assert_eq!(deferred, 1, "узел с новым доменом откладывается");
        assert_eq!(nodes.len(), 3);
        assert_eq!(nodes[active_index].server, "a.example.com");
        assert!(nodes.iter().all(|node| node.server != "c.example.com"));
      }
      other => panic!("перезапуск не нужен: {other:?}"),
    }
    // исчезнувший хост тоже не повод для перезапуска
    let shrunk = nodes_of(&["trojan://p@a.example.com:443"]);
    assert!(matches!(plan_refresh(Some(&running), current.first(), &shrunk), RefreshPlan::InPlace { deferred: 0, .. }));
  }

  #[test]
  fn restart_only_when_active_node_is_gone_or_config_missing() {
    let running = vec!["a.example.com".to_string()];
    let current = nodes_of(&["trojan://p@a.example.com:443"]);
    let other = nodes_of(&["trojan://p@z.example.com:443"]);
    assert_eq!(plan_refresh(Some(&running), current.first(), &other), RefreshPlan::Restart);
    assert_eq!(plan_refresh(None, current.first(), &current), RefreshPlan::Restart);
    // конфиг был без узла
    assert_eq!(plan_refresh(Some(&[]), None, &current), RefreshPlan::Restart);
  }

  #[test]
  fn set_service_enabled_rejects_unknown_services() {
    assert_eq!(set_service_enabled("telegram", false).unwrap_err(), NetworkError::InvalidService);
    assert_eq!(set_service_enabled("tiktok", true).unwrap_err(), NetworkError::InvalidService);
  }
}
