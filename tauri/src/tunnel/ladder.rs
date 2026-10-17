//! Лестница маршрутов `Tunnel | DnsOnly | Down` и пробы, которые её двигают.
//!
//! Автомат [`Ladder`] чистый: время и результаты проб приходят снаружи, поэтому тесты идут на виртуальных часах.
//! Реальные пробы ([`NetProber`]) — обычный `std::net::TcpStream` через два локальных HTTP-inbound Xray:
//! `probe_proxy` (всегда `proxy`) и `probe_direct` (всегда `direct`). Новых крейтов нет.
//!
//! Правила переходов:
//! - спуск (Tunnel→DnsOnly, DnsOnly→Down) — сразу после 3 неудачных серий подряд, без выдержки: при
//!   неработающем ключе статус `DnsOnly` появляется через ~15 с после старта;
//! - подъём (→Tunnel, Down→DnsOnly) — после 4 успехов подряд и не раньше чем через 60 с в состоянии;
//! - перед спуском из Tunnel при нескольких узлах подписки автомат просит сменить узел ([`Event::RotateNode`]);
//! - чередование успехов и отказов серий не набирает и состояние не меняет;
//! - плавающий узел: если ≥4 отказов из последних 10 проб — тоже `RotateNode` (не чаще раза в 60 с);
//! - `wake()` (явный выход из сна, смена сети) сбрасывает серии и окно и включает быстрый пакет проб;
//!   `nudge()` (фокус окна) серии не трогает, только просит внеочередную пробу не чаще раза в 60 с.

use serde::Serialize;
use std::collections::{BTreeMap, VecDeque};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::{Duration, Instant};

/// Обычный период проб.
pub const PROBE_INTERVAL: Duration = Duration::from_secs(5);
/// Период проб в быстром пакете после `wake()`.
pub const BURST_INTERVAL: Duration = Duration::from_secs(1);
/// Сколько проб идёт в быстром пакете.
pub const BURST_COUNT: u32 = 3;
/// Отказов подряд для спуска на ступень ниже.
pub const FAIL_THRESHOLD: u32 = 3;
/// Успехов подряд для подъёма.
pub const OK_THRESHOLD: u32 = 4;
/// Минимальное время в состоянии перед подъёмом.
pub const DWELL: Duration = Duration::from_secs(60);
/// Размер скользящего окна проб для детектора плавающего узла.
pub const WINDOW_LEN: usize = 10;
/// Отказов в окне, после которых узел считается плавающим и меняется.
pub const WINDOW_FAILS: usize = 4;
/// Минимальный интервал между сменами узла по окну (после любой смены узла).
pub const ROTATE_COOLDOWN: Duration = Duration::from_secs(60);
/// Не чаще этого `nudge()` (фокус окна) запускает внеочередную пробу.
pub const NUDGE_INTERVAL: Duration = Duration::from_secs(60);
/// Таймаут одной пробы.
const PROBE_TIMEOUT: Duration = Duration::from_secs(4);

/// Адрес контрольной пробы через туннель; ожидается ровно HTTP 204.
pub const PROBE_URL_HOST: &str = "cp.cloudflare.com";
/// Цели прямых проб ступени 2: имя сервиса, хост, порт.
pub const SERVICE_TARGETS: [(&str, &str, u16); 3] = [
  ("telegram", "web.telegram.org", 443),
  ("x", "x.com", 443),
  ("instagram", "www.instagram.com", 443),
];

/// Ступень маршрута.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Route {
  /// VPN + приватный DoH.
  Tunnel,
  /// Напрямую + приватный DoH.
  DnsOnly,
  /// Не работает ни туннель, ни прямой маршрут.
  Down,
}

/// Результат одного тика проб.
#[derive(Debug, Clone, Default)]
pub struct Observation {
  /// Проба 204 через `probe_proxy` прошла.
  pub proxy_ok: bool,
  /// Прямые пробы по включённым сервисам (имя, успех). Пусто в Tunnel и когда сервисов нет.
  pub direct: Vec<(String, bool)>,
}

/// Решение автомата после наблюдения.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Event {
  /// Ничего не изменилось.
  None,
  /// Состояние изменилось.
  Transition { from: Route, to: Route },
  /// Нужно сменить узел подписки (`rmo`/`ado proxy`) до спуска в DnsOnly.
  RotateNode,
}

/// Автомат лестницы.
#[derive(Debug, Clone)]
pub struct Ladder {
  route: Route,
  entered: Duration,
  proxy_fail: u32,
  proxy_ok: u32,
  direct_fail: u32,
  direct_ok: u32,
  burst: u32,
  services: BTreeMap<String, bool>,
  /// Последние результаты проб туннеля: `true` — отказ.
  window: VecDeque<bool>,
  last_rotate: Option<Duration>,
  last_nudge: Option<Duration>,
}

impl Ladder {
  /// Новый автомат в состоянии `Tunnel`; `now` — текущее время часов.
  #[cfg(test)]
  pub fn new(now: Duration) -> Self { Self::with_route(now, Route::Tunnel) }

  /// Автомат сразу на заданной ступени: без узла VPN нечего ждать три отказа подряд, старт идёт в `DnsOnly`.
  pub fn with_route(now: Duration, route: Route) -> Self {
    Self {
      route,
      entered: now,
      proxy_fail: 0,
      proxy_ok: 0,
      direct_fail: 0,
      direct_ok: 0,
      burst: 0,
      services: BTreeMap::new(),
      window: VecDeque::with_capacity(WINDOW_LEN),
      last_rotate: None,
      last_nudge: None,
    }
  }

  /// Текущая ступень.
  pub fn route(&self) -> Route { self.route }

  /// Последние результаты прямых проб по сервисам.
  pub fn services(&self) -> &BTreeMap<String, bool> { &self.services }

  /// Сколько проб туннеля подряд прошло успешно.
  pub fn proxy_ok_streak(&self) -> u32 { self.proxy_ok }

  /// Нужны ли прямые пробы (все состояния, кроме Tunnel).
  pub fn wants_direct_probes(&self) -> bool { self.route != Route::Tunnel }

  /// Пауза до следующего тика.
  pub fn next_delay(&self) -> Duration {
    if self.burst > 0 { BURST_INTERVAL } else { PROBE_INTERVAL }
  }

  /// Явный выход из сна или смена сети: старые серии и окно недействительны, идёт быстрый пакет проб.
  /// В проекте нет сигнала выхода из сна (WM_POWERBROADCAST) и смены адреса (NotifyAddrChange), поэтому
  /// пока `wake()` никто не вызывает; фокус окна идёт через [`Ladder::nudge`].
  pub fn wake(&mut self) {
    self.proxy_fail = 0;
    self.proxy_ok = 0;
    self.direct_fail = 0;
    self.direct_ok = 0;
    self.window.clear();
    self.burst = BURST_COUNT;
  }

  /// Показ или фокус окна: серии отказов и окно НЕ сбрасываются (иначе фокус каждые 10 с стирал бы
  /// накопленные отказы плавающего узла). Только внеочередная проба, не чаще раза в `NUDGE_INTERVAL`.
  pub fn nudge(&mut self, now: Duration) {
    if self.last_nudge.is_some_and(|last| now.saturating_sub(last) < NUDGE_INTERVAL) { return; }
    self.last_nudge = Some(now);
    self.burst = self.burst.max(1);
  }

  fn transition(&mut self, now: Duration, to: Route) -> Event {
    let from = self.route;
    self.route = to;
    self.entered = now;
    self.proxy_fail = 0;
    self.proxy_ok = 0;
    self.direct_fail = 0;
    self.direct_ok = 0;
    self.window.clear();
    Event::Transition { from, to }
  }

  fn dwelled(&self, now: Duration) -> bool {
    now.saturating_sub(self.entered) >= DWELL
  }

  fn rotate(&mut self, now: Duration) -> Event {
    self.proxy_fail = 0;
    self.window.clear();
    self.last_rotate = Some(now);
    // Новый узел проверяется быстрым пакетом: мёртвый заменяется за секунды, а не за 15 с
    self.burst = BURST_COUNT;
    Event::RotateNode
  }

  /// Учитывает результат тика. `can_rotate` — есть ещё непроверенные узлы подписки.
  pub fn observe(&mut self, now: Duration, observation: &Observation, can_rotate: bool) -> Event {
    self.burst = self.burst.saturating_sub(1);
    if self.window.len() == WINDOW_LEN { self.window.pop_front(); }
    self.window.push_back(!observation.proxy_ok);
    if observation.proxy_ok {
      self.proxy_ok += 1;
      self.proxy_fail = 0;
    } else {
      self.proxy_fail += 1;
      self.proxy_ok = 0;
    }
    if !observation.direct.is_empty() {
      for (service, ok) in &observation.direct {
        self.services.insert(service.clone(), *ok);
      }
      if observation.direct.iter().any(|(_, ok)| *ok) {
        self.direct_ok += 1;
        self.direct_fail = 0;
      } else {
        self.direct_fail += 1;
        self.direct_ok = 0;
      }
    }
    match self.route {
      Route::Tunnel => {
        if self.proxy_fail >= FAIL_THRESHOLD {
          if can_rotate { return self.rotate(now); }
          return self.transition(now, Route::DnsOnly);
        }
        // Узел отвечает через раз: серия из 3 подряд не наберётся, но окно покажет ≥4 отказов из 10.
        // Охлаждение не даёт менять узлы чаще раза в минуту; спуск в DnsOnly остаётся только за 3 подряд.
        let cooled = self.last_rotate.is_none_or(|last| now.saturating_sub(last) >= ROTATE_COOLDOWN);
        if can_rotate && cooled && self.window.iter().filter(|failed| **failed).count() >= WINDOW_FAILS {
          return self.rotate(now);
        }
        // Первый отказ: остальные пробы серии идут через секунду, обрыв подтверждается быстрее
        if self.proxy_fail > 0 {
          self.burst = self.burst.max(FAIL_THRESHOLD - self.proxy_fail);
        }
      }
      Route::DnsOnly => {
        if self.proxy_ok >= OK_THRESHOLD && self.dwelled(now) {
          return self.transition(now, Route::Tunnel);
        }
        if self.direct_fail >= FAIL_THRESHOLD && self.proxy_fail >= FAIL_THRESHOLD {
          return self.transition(now, Route::Down);
        }
      }
      Route::Down => {
        if self.dwelled(now) {
          if self.proxy_ok >= OK_THRESHOLD {
            return self.transition(now, Route::Tunnel);
          }
          if self.direct_ok >= OK_THRESHOLD {
            return self.transition(now, Route::DnsOnly);
          }
        }
      }
    }
    Event::None
  }
}

// ---------- пробы ----------

/// Часы автомата; в тестах виртуальные.
pub trait Clock {
  /// Монотонное время от произвольной точки отсчёта.
  fn now(&self) -> Duration;
}

/// Реальные монотонные часы.
pub struct SystemClock(Instant);

impl SystemClock {
  /// Часы, отсчитывающие от момента создания.
  pub fn new() -> Self { Self(Instant::now()) }
}

impl Default for SystemClock {
  fn default() -> Self { Self::new() }
}

impl Clock for SystemClock {
  fn now(&self) -> Duration { self.0.elapsed() }
}

/// Цель прямой пробы.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
  pub service: String,
  pub host: String,
  pub port: u16,
}

/// Цели проб для включённых сервисов; выключенные сетевой нагрузки не создают.
pub fn targets_for(is_enabled: impl Fn(&str) -> bool) -> Vec<Target> {
  SERVICE_TARGETS.iter().filter(|(service, _, _)| is_enabled(service))
    .map(|(service, host, port)| Target { service: (*service).into(), host: (*host).into(), port: *port }).collect()
}

/// Источник результатов проб.
pub trait Prober {
  /// `GET http://cp.cloudflare.com/generate_204` через туннель вернул ровно 204.
  fn proxy_ok(&self) -> bool;
  /// Прямые пробы по целям (параллельно); порядок результатов совпадает с порядком целей.
  fn direct(&self, targets: &[Target]) -> Vec<(String, bool)>;
}

/// Соединяет автомат, часы и пробы: один вызов `tick` — одна серия.
pub struct Runner<C: Clock, P: Prober> {
  pub ladder: Ladder,
  clock: C,
  prober: P,
  targets: Vec<Target>,
}

impl<C: Clock, P: Prober> Runner<C, P> {
  /// Новый исполнитель; автомат стартует в Tunnel.
  #[cfg(test)]
  pub fn new(clock: C, prober: P, targets: Vec<Target>) -> Self {
    Self::with_route(clock, prober, targets, Route::Tunnel)
  }

  /// Исполнитель, стартующий на заданной ступени (без узлов VPN — сразу `DnsOnly`).
  pub fn with_route(clock: C, prober: P, targets: Vec<Target>, route: Route) -> Self {
    let ladder = Ladder::with_route(clock.now(), route);
    Self { ladder, clock, prober, targets }
  }

  /// Заменяет список целей (сервис включён или выключен в настройках).
  pub fn set_targets(&mut self, targets: Vec<Target>) { self.targets = targets; }

  /// Показ или фокус окна: внеочередная проба без сброса серий (см. [`Ladder::nudge`]).
  pub fn nudge(&mut self) { self.ladder.nudge(self.clock.now()); }

  /// Выполняет серию проб и возвращает решение автомата.
  pub fn tick(&mut self, can_rotate: bool) -> Event {
    let proxy_ok = self.prober.proxy_ok();
    let direct = if self.ladder.wants_direct_probes() && !self.targets.is_empty() {
      self.prober.direct(&self.targets)
    } else {
      Vec::new()
    };
    let now = self.clock.now();
    self.ladder.observe(now, &Observation { proxy_ok, direct }, can_rotate)
  }
}

/// Реальные пробы через локальные HTTP-inbound Xray.
pub struct NetProber {
  pub probe_proxy: u16,
  pub probe_direct: u16,
}

impl Prober for NetProber {
  fn proxy_ok(&self) -> bool {
    http_204(self.probe_proxy)
  }

  fn direct(&self, targets: &[Target]) -> Vec<(String, bool)> {
    let handles: Vec<_> = targets.iter().cloned().map(|target| {
      let port = self.probe_direct;
      std::thread::spawn(move || {
        let ok = connect_tls_reachable(port, &target.host, target.port);
        (target.service, ok)
      })
    }).collect();
    handles.into_iter().filter_map(|handle| handle.join().ok()).collect()
  }
}

fn open_local(port: u16) -> Option<TcpStream> {
  let address = SocketAddr::from(([127, 0, 0, 1], port));
  let stream = TcpStream::connect_timeout(&address, Duration::from_secs(2)).ok()?;
  stream.set_read_timeout(Some(PROBE_TIMEOUT)).ok()?;
  stream.set_write_timeout(Some(PROBE_TIMEOUT)).ok()?;
  stream.set_nodelay(true).ok();
  Some(stream)
}

/// Читает заголовки HTTP до пустой строки (не более 4 КБ); возвращает строку статуса.
fn read_status_line(stream: &mut TcpStream) -> Option<String> {
  let mut buffer = Vec::with_capacity(512);
  let mut byte = [0u8; 1];
  while buffer.len() < 4096 {
    if stream.read(&mut byte).ok()? == 0 { break; }
    buffer.push(byte[0]);
    if buffer.ends_with(b"\r\n\r\n") { break; }
  }
  let text = String::from_utf8_lossy(&buffer);
  text.lines().next().map(str::to_string)
}

/// Код статуса из строки `HTTP/1.x NNN ...`.
fn status_code(line: &str) -> Option<u16> {
  let mut parts = line.split_whitespace();
  if !parts.next()?.starts_with("HTTP/1.") { return None; }
  parts.next()?.parse().ok()
}

fn http_204(proxy_port: u16) -> bool {
  let Some(mut stream) = open_local(proxy_port) else { return false; };
  let request = format!(
    "GET http://{PROBE_URL_HOST}/generate_204 HTTP/1.1\r\nHost: {PROBE_URL_HOST}\r\nConnection: close\r\nUser-Agent: Mozilla/5.0\r\n\r\n");
  if stream.write_all(request.as_bytes()).is_err() { return false; }
  let ok = read_status_line(&mut stream).and_then(|line| status_code(&line)) == Some(204);
  close_gracefully(stream);
  ok
}

/// Корректное закрытие пробы: `shutdown(Write)` и чтение до EOF (≤4 КБ, ≤1 с). Резкий разрыв сокета
/// давал в журнале Xray «failed to write response… aborted» на каждую пробу.
fn close_gracefully(mut stream: TcpStream) {
  let _ = stream.shutdown(std::net::Shutdown::Write);
  let deadline = Instant::now() + Duration::from_secs(1);
  let mut buffer = [0u8; 1024];
  let mut total = 0usize;
  while total < 4096 {
    let left = deadline.saturating_duration_since(Instant::now());
    if left.is_zero() || stream.set_read_timeout(Some(left)).is_err() { break; }
    match stream.read(&mut buffer) {
      Ok(0) | Err(_) => break,
      Ok(n) => total += n,
    }
  }
}

/// CONNECT через прямой inbound и начало TLS-рукопожатия: любой ответ уровня TLS (ServerHello или alert)
/// доказывает, что TCP до сервиса дошёл. Одного `200 Connection established` мало: Xray отвечает им до дозвона.
fn connect_tls_reachable(direct_port: u16, host: &str, port: u16) -> bool {
  let Some(mut stream) = open_local(direct_port) else { return false; };
  let request = format!("CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\n\r\n");
  if stream.write_all(request.as_bytes()).is_err() { return false; }
  if read_status_line(&mut stream).and_then(|line| status_code(&line)) != Some(200) { return false; }
  if stream.write_all(&client_hello(host)).is_err() { return false; }
  let mut first = [0u8; 1];
  let ok = matches!(stream.read(&mut first), Ok(1)) && matches!(first[0], 0x15 | 0x16);
  close_gracefully(stream);
  ok
}

/// Достижим ли `host:port` через прямой inbound `probe_direct` (CONNECT и ответ уровня TLS).
/// Используется для проверки приватного DoH.
pub fn reachable_direct(direct_port: u16, host: &str, port: u16) -> bool {
  connect_tls_reachable(direct_port, host, port)
}

/// Минимальный TLS ClientHello с SNI (TLS 1.2/1.3, x25519). Содержимое ключа случайное и не используется.
fn client_hello(host: &str) -> Vec<u8> {
  fn u16_be(value: usize) -> [u8; 2] { (value as u16).to_be_bytes() }
  let random = || -> [u8; 16] { *uuid::Uuid::new_v4().as_bytes() };
  let mut extensions = Vec::new();
  let mut push_ext = |kind: u16, body: &[u8]| {
    extensions.extend_from_slice(&kind.to_be_bytes());
    extensions.extend_from_slice(&u16_be(body.len()));
    extensions.extend_from_slice(body);
  };
  // server_name
  let name = host.as_bytes();
  let mut entry = vec![0u8];
  entry.extend_from_slice(&u16_be(name.len()));
  entry.extend_from_slice(name);
  let mut sni = Vec::new();
  sni.extend_from_slice(&u16_be(entry.len()));
  sni.extend_from_slice(&entry);
  push_ext(0x0000, &sni);
  // supported_groups: x25519
  push_ext(0x000a, &[0x00, 0x02, 0x00, 0x1d]);
  // signature_algorithms: rsa_pss_rsae_sha256, ecdsa_secp256r1_sha256
  push_ext(0x000d, &[0x00, 0x04, 0x08, 0x04, 0x04, 0x03]);
  // supported_versions: TLS 1.3, TLS 1.2
  push_ext(0x002b, &[0x04, 0x03, 0x04, 0x03, 0x03]);
  // key_share: x25519, 32 случайных байт
  let mut share = vec![0x00, 0x24, 0x00, 0x1d, 0x00, 0x20];
  share.extend_from_slice(&random());
  share.extend_from_slice(&random());
  push_ext(0x0033, &share);

  let mut body = vec![0x03, 0x03];
  body.extend_from_slice(&random());
  body.extend_from_slice(&random());
  body.push(0); // пустой session id
  body.extend_from_slice(&[0x00, 0x06, 0x13, 0x01, 0xc0, 0x2f, 0xc0, 0x2b]);
  body.extend_from_slice(&[0x01, 0x00]); // компрессия: без
  body.extend_from_slice(&u16_be(extensions.len()));
  body.extend_from_slice(&extensions);

  let mut handshake = vec![0x01, 0x00];
  handshake.extend_from_slice(&u16_be(body.len()));
  handshake.extend_from_slice(&body);
  let mut record = vec![0x16, 0x03, 0x01];
  record.extend_from_slice(&u16_be(handshake.len()));
  record.extend_from_slice(&handshake);
  record
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::cell::{Cell, RefCell};
  use std::net::TcpListener;
  use std::rc::Rc;

  const TICK: Duration = Duration::from_secs(5);

  fn ok(direct: &[(&str, bool)]) -> Observation {
    Observation { proxy_ok: true, direct: direct.iter().map(|(s, v)| ((*s).to_string(), *v)).collect() }
  }

  fn bad(direct: &[(&str, bool)]) -> Observation {
    Observation { proxy_ok: false, direct: direct.iter().map(|(s, v)| ((*s).to_string(), *v)).collect() }
  }

  /// Прогоняет `count` тиков по 5 с; возвращает время и последнее событие-переход.
  fn run(ladder: &mut Ladder, now: &mut Duration, count: u32, observation: &Observation) -> Event {
    let mut last = Event::None;
    for _ in 0..count {
      *now += TICK;
      let event = ladder.observe(*now, observation, false);
      if event != Event::None { last = event; }
    }
    last
  }

  #[test]
  fn three_failures_drop_to_dns_only_in_fifteen_seconds() {
    let mut now = Duration::ZERO;
    let mut ladder = Ladder::new(now);
    assert_eq!(run(&mut ladder, &mut now, 2, &bad(&[])), Event::None);
    assert_eq!(ladder.route(), Route::Tunnel);
    let event = run(&mut ladder, &mut now, 1, &bad(&[]));
    assert_eq!(event, Event::Transition { from: Route::Tunnel, to: Route::DnsOnly });
    assert_eq!(now, Duration::from_secs(15));
  }

  #[test]
  fn recovery_needs_four_successes_and_sixty_seconds() {
    let mut now = Duration::ZERO;
    let mut ladder = Ladder::new(now);
    run(&mut ladder, &mut now, 3, &bad(&[]));
    assert_eq!(ladder.route(), Route::DnsOnly);
    // 4 успеха на отметке 35 с: серия набрана, выдержка нет
    run(&mut ladder, &mut now, 4, &ok(&[("x", true)]));
    assert_eq!(ladder.route(), Route::DnsOnly);
    // продолжаем успехи: переход ровно на первой отметке >= 60 с от входа в DnsOnly (15 с -> 75 с)
    let mut transitioned_at = None;
    for _ in 0..20 {
      now += TICK;
      if let Event::Transition { to: Route::Tunnel, .. } = ladder.observe(now, &ok(&[("x", true)]), false) {
        transitioned_at = Some(now);
        break;
      }
    }
    assert_eq!(transitioned_at, Some(Duration::from_secs(75)));
  }

  #[test]
  fn alternating_results_never_change_state() {
    let mut now = Duration::ZERO;
    let mut ladder = Ladder::new(now);
    for round in 0..200 {
      now += TICK;
      let event = ladder.observe(now, &if round % 2 == 0 { bad(&[]) } else { ok(&[]) }, false);
      assert_eq!(event, Event::None, "раунд {round}");
    }
    assert_eq!(ladder.route(), Route::Tunnel);
    // и в DnsOnly: чередование не поднимает в Tunnel
    run(&mut ladder, &mut now, 3, &bad(&[]));
    assert_eq!(ladder.route(), Route::DnsOnly);
    for round in 0..200 {
      now += TICK;
      let obs = if round % 3 == 0 { bad(&[("x", true)]) } else { ok(&[("x", true)]) };
      assert_eq!(ladder.observe(now, &obs, false), Event::None, "раунд {round}");
    }
    assert_eq!(ladder.route(), Route::DnsOnly);
  }

  #[test]
  fn dns_only_goes_down_when_nothing_works_and_comes_back() {
    let mut now = Duration::ZERO;
    let mut ladder = Ladder::new(now);
    run(&mut ladder, &mut now, 3, &bad(&[]));
    assert_eq!(ladder.route(), Route::DnsOnly);
    let event = run(&mut ladder, &mut now, 3, &bad(&[("telegram", false), ("x", false)]));
    assert_eq!(event, Event::Transition { from: Route::DnsOnly, to: Route::Down });
    // прямой маршрут ожил: после выдержки Down -> DnsOnly
    let mut reached = None;
    for _ in 0..30 {
      now += TICK;
      if let Event::Transition { to, .. } = ladder.observe(now, &bad(&[("x", true)]), false) {
        reached = Some(to);
        break;
      }
    }
    assert_eq!(reached, Some(Route::DnsOnly));
  }

  #[test]
  fn down_returns_straight_to_tunnel_when_proxy_recovers() {
    let mut now = Duration::ZERO;
    let mut ladder = Ladder::new(now);
    run(&mut ladder, &mut now, 3, &bad(&[]));
    run(&mut ladder, &mut now, 3, &bad(&[("x", false)]));
    assert_eq!(ladder.route(), Route::Down);
    run(&mut ladder, &mut now, 30, &ok(&[("x", false)]));
    assert_eq!(ladder.route(), Route::Tunnel);
  }

  #[test]
  fn no_enabled_services_never_means_down() {
    let mut now = Duration::ZERO;
    let mut ladder = Ladder::new(now);
    run(&mut ladder, &mut now, 3, &bad(&[]));
    run(&mut ladder, &mut now, 50, &bad(&[]));
    assert_eq!(ladder.route(), Route::DnsOnly);
  }

  #[test]
  fn rotation_is_requested_before_dropping() {
    let mut now = Duration::ZERO;
    let mut ladder = Ladder::new(now);
    let mut events = Vec::new();
    for _ in 0..3 {
      now += TICK;
      events.push(ladder.observe(now, &bad(&[]), true));
    }
    assert_eq!(events[2], Event::RotateNode);
    assert_eq!(ladder.route(), Route::Tunnel);
    // серия сброшена: новому узлу даётся полный цикл
    for _ in 0..2 {
      now += TICK;
      assert_eq!(ladder.observe(now, &bad(&[]), true), Event::None);
    }
    now += TICK;
    assert_eq!(ladder.observe(now, &bad(&[]), false), Event::Transition { from: Route::Tunnel, to: Route::DnsOnly });
  }

  #[test]
  fn flapping_node_rotates_within_ten_probes() {
    let mut now = Duration::ZERO;
    let mut ladder = Ladder::new(now);
    let mut rotated_at = None;
    for round in 0..WINDOW_LEN {
      now += TICK;
      let obs = if round % 2 == 0 { bad(&[]) } else { ok(&[]) };
      if ladder.observe(now, &obs, true) == Event::RotateNode { rotated_at = Some(round + 1); break; }
    }
    assert_eq!(rotated_at, Some(7), "4-й отказ при чередовании — на 7-й пробе");
    assert_eq!(ladder.route(), Route::Tunnel);
  }

  #[test]
  fn flapping_without_spare_nodes_does_not_drop() {
    let mut now = Duration::ZERO;
    let mut ladder = Ladder::new(now);
    for round in 0..40 {
      now += TICK;
      let obs = if round % 2 == 0 { bad(&[]) } else { ok(&[]) };
      assert_eq!(ladder.observe(now, &obs, false), Event::None);
    }
  }

  #[test]
  fn window_rotation_respects_cooldown() {
    let mut now = Duration::ZERO;
    let mut ladder = Ladder::new(now);
    let mut rotations = Vec::new();
    for round in 0..60 {
      now += TICK;
      let obs = if round % 2 == 0 { bad(&[]) } else { ok(&[]) };
      if ladder.observe(now, &obs, true) == Event::RotateNode { rotations.push(now); }
    }
    assert!(rotations.len() >= 2);
    for pair in rotations.windows(2) {
      assert!(pair[1] - pair[0] >= ROTATE_COOLDOWN, "смены чаще охлаждения: {pair:?}");
    }
  }

  #[test]
  fn three_in_a_row_still_rotates_regardless_of_window() {
    let mut now = Duration::ZERO;
    let mut ladder = Ladder::new(now);
    run(&mut ladder, &mut now, 2, &bad(&[]));
    now += TICK;
    assert_eq!(ladder.observe(now, &bad(&[]), true), Event::RotateNode);
  }

  #[test]
  fn nudge_keeps_streaks_and_is_throttled() {
    let mut now = Duration::ZERO;
    let mut ladder = Ladder::new(now);
    run(&mut ladder, &mut now, 2, &bad(&[]));
    ladder.nudge(now);
    assert_eq!(ladder.next_delay(), BURST_INTERVAL, "внеочередная проба");
    // серия не сброшена: третий отказ сразу даёт смену узла
    now += BURST_INTERVAL;
    assert_eq!(ladder.observe(now, &bad(&[]), true), Event::RotateNode);
    // повторный nudge раньше 60 с ничего не форсирует
    let mut other = Ladder::new(Duration::ZERO);
    other.nudge(Duration::from_secs(1));
    other.observe(Duration::from_secs(2), &ok(&[]), true);
    assert_eq!(other.next_delay(), PROBE_INTERVAL);
    other.nudge(Duration::from_secs(30));
    assert_eq!(other.next_delay(), PROBE_INTERVAL, "не чаще раза в 60 с");
    other.nudge(Duration::from_secs(62));
    assert_eq!(other.next_delay(), BURST_INTERVAL);
  }

  #[test]
  fn wake_resets_streaks_and_runs_a_burst() {
    let mut now = Duration::ZERO;
    let mut ladder = Ladder::new(now);
    run(&mut ladder, &mut now, 2, &bad(&[]));
    ladder.wake();
    assert_eq!(ladder.next_delay(), BURST_INTERVAL);
    // две накопленные неудачи сброшены: нужны три новых
    for _ in 0..2 {
      now += BURST_INTERVAL;
      assert_eq!(ladder.observe(now, &bad(&[]), false), Event::None);
    }
    assert_eq!(ladder.next_delay(), BURST_INTERVAL);
    now += BURST_INTERVAL;
    assert_eq!(ladder.observe(now, &bad(&[]), false), Event::Transition { from: Route::Tunnel, to: Route::DnsOnly });
    assert_eq!(ladder.next_delay(), PROBE_INTERVAL);
  }

  #[test]
  fn failure_in_tunnel_speeds_up_the_series_and_rotation_checks_the_new_node_fast() {
    let mut now = Duration::ZERO;
    let mut ladder = Ladder::new(now);
    assert_eq!(ladder.next_delay(), PROBE_INTERVAL);
    now += TICK;
    ladder.observe(now, &bad(&[]), true);
    assert_eq!(ladder.next_delay(), BURST_INTERVAL, "после первого отказа серия идёт быстро");
    now += BURST_INTERVAL;
    assert_eq!(ladder.observe(now, &bad(&[]), true), Event::None);
    assert_eq!(ladder.next_delay(), BURST_INTERVAL);
    now += BURST_INTERVAL;
    assert_eq!(ladder.observe(now, &bad(&[]), true), Event::RotateNode);
    assert_eq!(now, Duration::from_secs(7), "узел меняется через 7 с вместо 15 с");
    assert_eq!(ladder.next_delay(), BURST_INTERVAL, "новый узел проверяется быстрым пакетом");
    // Новый узел исправен: пакет кончается, период возвращается к обычному
    for _ in 0..BURST_COUNT {
      now += BURST_INTERVAL;
      assert_eq!(ladder.observe(now, &ok(&[]), true), Event::None);
    }
    assert_eq!(ladder.next_delay(), PROBE_INTERVAL);
    // В DnsOnly отказ туннеля ожидаем и пробы не ускоряет
    run(&mut ladder, &mut now, 3, &bad(&[]));
    assert_eq!(ladder.route(), Route::DnsOnly);
    now += TICK;
    ladder.observe(now, &bad(&[]), false);
    assert_eq!(ladder.next_delay(), PROBE_INTERVAL);
  }

  struct FakeClock(Rc<Cell<Duration>>);
  impl Clock for FakeClock {
    fn now(&self) -> Duration { self.0.get() }
  }

  #[derive(Clone, Default)]
  struct FakeProber {
    proxy: Rc<Cell<bool>>,
    calls: Rc<RefCell<Vec<&'static str>>>,
  }
  impl Prober for FakeProber {
    fn proxy_ok(&self) -> bool {
      self.calls.borrow_mut().push("proxy");
      self.proxy.get()
    }
    fn direct(&self, targets: &[Target]) -> Vec<(String, bool)> {
      self.calls.borrow_mut().push("direct");
      targets.iter().map(|t| (t.service.clone(), true)).collect()
    }
  }

  #[test]
  fn runner_without_nodes_starts_in_dns_only_and_probes_direct_at_once() {
    let time = Rc::new(Cell::new(Duration::ZERO));
    let prober = FakeProber::default();
    prober.proxy.set(false);
    let mut runner = Runner::with_route(FakeClock(time.clone()), prober.clone(), targets_for(|_| true), Route::DnsOnly);
    assert_eq!(runner.ladder.route(), Route::DnsOnly, "ждать три отказа не нужно");
    time.set(time.get() + TICK);
    runner.tick(false);
    assert_eq!(runner.ladder.route(), Route::DnsOnly);
    assert_eq!(prober.calls.borrow().last(), Some(&"direct"), "прямые пробы идут с первого тика");
    assert_eq!(runner.ladder.services().len(), 3);
  }

  #[test]
  fn runner_probes_direct_only_outside_tunnel_and_skips_disabled_services() {
    let time = Rc::new(Cell::new(Duration::ZERO));
    let prober = FakeProber::default();
    let targets = targets_for(|service| service != "instagram");
    assert_eq!(targets.iter().map(|t| t.service.as_str()).collect::<Vec<_>>(), vec!["telegram", "x"]);
    let mut runner = Runner::new(FakeClock(time.clone()), prober.clone(), targets);
    prober.proxy.set(false);
    for _ in 0..3 {
      time.set(time.get() + TICK);
      runner.tick(false);
    }
    assert_eq!(runner.ladder.route(), Route::DnsOnly);
    assert!(!prober.calls.borrow().contains(&"direct"), "в Tunnel прямых проб быть не должно");
    time.set(time.get() + TICK);
    runner.tick(false);
    assert_eq!(prober.calls.borrow().last(), Some(&"direct"));
    assert_eq!(runner.ladder.services().len(), 2);
    // без сервисов прямые пробы не идут вовсе
    runner.set_targets(Vec::new());
    let before = prober.calls.borrow().iter().filter(|c| **c == "direct").count();
    time.set(time.get() + TICK);
    runner.tick(false);
    assert_eq!(prober.calls.borrow().iter().filter(|c| **c == "direct").count(), before);
  }

  #[test]
  fn status_line_parsing() {
    assert_eq!(status_code("HTTP/1.1 204 No Content"), Some(204));
    assert_eq!(status_code("HTTP/1.0 200 Connection established"), Some(200));
    assert_eq!(status_code("garbage"), None);
    assert_eq!(status_code("HTTP/1.1"), None);
  }

  #[test]
  fn client_hello_lengths_are_consistent() {
    let hello = client_hello("web.telegram.org");
    assert_eq!(&hello[..3], &[0x16, 0x03, 0x01]);
    let record_len = u16::from_be_bytes([hello[3], hello[4]]) as usize;
    assert_eq!(record_len, hello.len() - 5);
    assert_eq!(hello[5], 0x01);
    let handshake_len = ((hello[6] as usize) << 16) | ((hello[7] as usize) << 8) | hello[8] as usize;
    assert_eq!(handshake_len, hello.len() - 9);
    assert!(hello.windows(16).any(|w| w == b"web.telegram.org"));
  }

  /// Одноразовый локальный сервер: отвечает заданными байтами на первый запрос.
  fn serve_once(reply: Vec<Vec<u8>>) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
      if let Ok((mut stream, _)) = listener.accept() {
        let mut buffer = [0u8; 2048];
        for chunk in reply {
          let _ = stream.read(&mut buffer);
          let _ = stream.write_all(&chunk);
        }
      }
    });
    port
  }

  #[test]
  fn real_probe_accepts_exactly_204() {
    assert!(http_204(serve_once(vec![b"HTTP/1.1 204 No Content\r\n\r\n".to_vec()])));
    assert!(!http_204(serve_once(vec![b"HTTP/1.1 200 OK\r\n\r\n".to_vec()])));
    assert!(!http_204(serve_once(vec![b"HTTP/1.1 302 Found\r\n\r\n".to_vec()])));
    assert!(!http_204(1)); // порт без слушателя
  }

  #[test]
  fn real_connect_probe_needs_tls_bytes_after_200() {
    let good = serve_once(vec![b"HTTP/1.1 200 Connection established\r\n\r\n".to_vec(), vec![0x16, 0x03, 0x03]]);
    assert!(connect_tls_reachable(good, "example.com", 443));
    let alert = serve_once(vec![b"HTTP/1.1 200 Connection established\r\n\r\n".to_vec(), vec![0x15, 0x03, 0x03]]);
    assert!(connect_tls_reachable(alert, "example.com", 443));
    // 200 есть, дальше закрытие: сервис недостижим
    let closed = serve_once(vec![b"HTTP/1.1 200 Connection established\r\n\r\n".to_vec()]);
    assert!(!connect_tls_reachable(closed, "example.com", 443));
    let refused = serve_once(vec![b"HTTP/1.1 503 Service Unavailable\r\n\r\n".to_vec()]);
    assert!(!connect_tls_reachable(refused, "example.com", 443));
  }
}
