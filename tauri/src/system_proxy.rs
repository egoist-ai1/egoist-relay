use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use url::Url;

const MAX_TARGET_BYTES: usize = 16 * 1024;
#[cfg(test)]
const DEFAULT_PROXY_TIMEOUT: Duration = Duration::from_secs(125);

/// Reads the active Windows user proxy off the UI thread, with a bounded wait
#[cfg(test)]
fn proxy_for_url(target: &str) -> Result<Option<Url>, String> {
  proxy_for_url_cancellable(target, &AtomicBool::new(false), Instant::now() + DEFAULT_PROXY_TIMEOUT)
}

/// Resolves the Windows route within the caller's operation deadline
pub fn proxy_for_url_cancellable(target: &str, cancel: &AtomicBool, deadline: Instant) -> Result<Option<Url>, String> {
  check_control(cancel, deadline)?;
  let target = validated_target(target)?;
  #[cfg(windows)]
  { windows::proxy_for_target(&target, cancel, deadline) }
  #[cfg(not(windows))]
  { let _ = target; check_control(cancel, deadline)?; Ok(None) }
}

fn check_control(cancel: &AtomicBool, deadline: Instant) -> Result<(), String> {
  if cancel.load(Ordering::Acquire) {
    Err("Windows proxy resolution cancelled".to_string())
  } else if Instant::now() >= deadline {
    Err("Windows proxy resolution timed out".to_string())
  } else { Ok(()) }
}
fn validated_target(value: &str) -> Result<Url, String> {
  if value.len() > MAX_TARGET_BYTES || value.chars().any(char::is_control) {
    return Err("Invalid media URL for Windows proxy resolution".to_string());
  }
  let target = Url::parse(value).map_err(|_| "Invalid media URL for Windows proxy resolution".to_string())?;
  if target.scheme() != "https" || target.host_str().is_none()
    || !target.username().is_empty() || target.password().is_some() {
    return Err("Windows proxy resolution requires an HTTPS URL without credentials".to_string());
  }
  Ok(target)
}

#[cfg(any(windows, test))]
mod parsing {
  use url::Url;

  pub(super) const MAX_CONFIG_UNITS: usize = 8192;
  const MAX_ENDPOINT_BYTES: usize = 2048;
  const MAX_RULES: usize = 256;
  const AUTODETECTION_FAILED: u32 = 12180;

  fn valid_config(value: &str) -> Result<(), String> {
    if value.len() > MAX_CONFIG_UNITS * 4 || value.chars().any(char::is_control) {
      Err("Invalid or oversized Windows proxy configuration".to_string())
    } else { Ok(()) }
  }

  pub(super) fn endpoint(value: &str, socks_hint: bool) -> Result<Url, String> {
    if value.is_empty() || value.len() > MAX_ENDPOINT_BYTES || value.contains(['@', '\\', '?', '#'])
      || value.chars().any(|character| character.is_control() || character.is_whitespace()) {
      return Err("Invalid Windows proxy endpoint; credentials and URL paths are unsupported".to_string());
    }
    let explicit_scheme = value.contains("://");
    if socks_hint && !explicit_scheme {
      return Err("Windows SOCKS proxy must explicitly use socks5://; SOCKS4 is unsupported".to_string());
    }
    let authority = value.split_once("://").map_or(value, |(_, authority)| authority);
    if authority.contains('/') {
      return Err("Windows proxy endpoints cannot contain a URL path".to_string());
    }
    let mut endpoint = Url::parse(&if explicit_scheme { value.to_string() } else { format!("http://{value}") })
      .map_err(|_| "Invalid Windows proxy endpoint".to_string())?;
    if !matches!(endpoint.scheme(), "http" | "https" | "socks5") || endpoint.host_str().is_none()
      || !endpoint.username().is_empty() || endpoint.password().is_some() {
      return Err("Unsupported Windows proxy protocol or credentials".to_string());
    }
    if endpoint.port() == Some(0) {
      return Err("Windows proxy port must be between 1 and 65535".to_string());
    }
    if endpoint.scheme() == "socks5" && endpoint.port().is_none() {
      endpoint.set_port(Some(1080)).map_err(|_| "Invalid Windows SOCKS port".to_string())?;
    }
    Ok(endpoint)
  }

  pub(super) fn manual_proxy(target: &Url, proxy: Option<&str>, bypass: Option<&str>) -> Result<Option<Url>, String> {
    let Some(proxy) = proxy else { return Ok(None); };
    valid_config(proxy)?;
    let mut global = None;
    let mut https = None;
    let mut socks = None;
    let mut seen_protocols = Vec::new();
    let mut count = 0;
    for token in proxy.split(|character: char| character == ';' || character.is_ascii_whitespace()).filter(|token| !token.is_empty()) {
      count += 1;
      if count > MAX_RULES { return Err("Too many Windows proxy entries".to_string()); }
      if let Some((protocol, value)) = token.split_once('=') {
        let protocol = protocol.to_ascii_lowercase();
        if !matches!(protocol.as_str(), "http" | "https" | "ftp" | "socks") || seen_protocols.contains(&protocol) {
          return Err("Unsupported or duplicate Windows proxy protocol entry".to_string());
        }
        seen_protocols.push(protocol.clone());
        // The key selects the destination protocol; https=host:port is an HTTP proxy.
        let parsed = endpoint(value, protocol == "socks")?;
        match protocol.as_str() {
          "https" => https = Some(parsed),
          "socks" => socks = Some(parsed),
          _ => {},
        }
      } else {
        let parsed = endpoint(token, false)?;
        if global.is_none() { global = Some(parsed); }
      }
    }
    if count == 0 { return Err("Windows enabled proxy configuration is empty".to_string()); }
    if bypass_matches(target, bypass.unwrap_or_default())? { return Ok(None); }
    Ok(https.or(global).or(socks))
  }

  fn wildcard_matches(pattern: &[u8], value: &[u8]) -> bool {
    let (mut pattern_index, mut value_index) = (0, 0);
    let (mut star, mut retry) = (None, 0);
    while value_index < value.len() {
      if pattern_index < pattern.len() && (pattern[pattern_index] == b'?' || pattern[pattern_index] == value[value_index]) {
        pattern_index += 1;
        value_index += 1;
      } else if pattern_index < pattern.len() && pattern[pattern_index] == b'*' {
        star = Some(pattern_index);
        pattern_index += 1;
        retry = value_index;
      } else if let Some(star_index) = star {
        retry += 1;
        value_index = retry;
        pattern_index = star_index + 1;
      } else { return false; }
    }
    while pattern.get(pattern_index) == Some(&b'*') { pattern_index += 1; }
    pattern_index == pattern.len()
  }

  pub(super) fn bypass_matches(target: &Url, bypass: &str) -> Result<bool, String> {
    valid_config(bypass)?;
    let host = target.host_str().unwrap_or_default().trim_matches(['[', ']']).to_ascii_lowercase();
    let mut matched = false;
    for (index, raw_rule) in bypass.split(|character: char| character == ';' || character.is_ascii_whitespace())
      .filter(|rule| !rule.is_empty()).enumerate() {
      if index >= MAX_RULES { return Err("Too many Windows proxy bypass entries".to_string()); }
      let rule = raw_rule.to_ascii_lowercase();
      if rule == "<local>" {
        matched |= !host.contains('.');
        continue;
      }
      if rule.contains(['<', '>', '@', '\\', '#']) { return Err("Unsupported Windows proxy bypass rule".to_string()); }
      let (scheme, authority) = rule.split_once("://").map_or((None, rule.as_str()), |(scheme, authority)| (Some(scheme), authority));
      if authority.contains('/') || authority.is_empty() || scheme.is_some_and(|scheme| !matches!(scheme, "http" | "https")) {
        return Err("Unsupported Windows proxy bypass rule".to_string());
      }
      let (pattern, port) = if authority.starts_with('[') {
        let (pattern, suffix) = authority.split_once(']').ok_or("Invalid IPv6 Windows proxy bypass rule")?;
        let port = if suffix.is_empty() { None } else {
          Some(suffix.strip_prefix(':').ok_or("Invalid Windows proxy bypass port")?)
        };
        (&pattern[1..], port)
      } else if authority.bytes().filter(|byte| *byte == b':').count() == 1 {
        let (pattern, port) = authority.rsplit_once(':').unwrap();
        (pattern, Some(port))
      } else { (authority, None) };
      let port = port.map(|port| port.parse::<u16>().ok().filter(|port| *port > 0)
        .ok_or("Invalid Windows proxy bypass port")).transpose()?;
      let applies = scheme.is_none_or(|scheme| target.scheme() == scheme)
        && port.is_none_or(|port| target.port_or_known_default() == Some(port));
      matched |= applies && wildcard_matches(pattern.as_bytes(), host.as_bytes());
    }
    Ok(matched)
  }

  pub(super) fn pac_route(is_proxy: bool, scheme: u32, host: Option<&str>, port: u16) -> Result<Option<Url>, String> {
    if !is_proxy { return Ok(None); }
    let protocol = match scheme {
      1 => "http",
      2 => "https",
      // WinHTTP's SOCKS result does not distinguish SOCKS4 from SOCKS5
      4 => return Err("Windows PAC selected an ambiguous SOCKS protocol; use an explicit socks5:// manual proxy".to_string()),
      _ => return Err("Windows PAC selected an unsupported proxy protocol".to_string()),
    };
    let host = host.ok_or("Windows PAC selected an empty proxy endpoint")?;
    if port == 0 { return Err("Windows PAC selected an invalid proxy port".to_string()); }
    let host = if host.contains(':') && !host.starts_with('[') {
      host.parse::<std::net::Ipv6Addr>().map_err(|_| "Invalid Windows PAC proxy hostname")?;
      format!("[{host}]")
    } else { host.to_string() };
    endpoint(&format!("{protocol}://{host}:{port}"), false).map(Some)
  }
  pub(super) fn after_auto_error(target: &Url, code: u32, explicit_pac: bool, proxy: Option<&str>, bypass: Option<&str>) -> Result<Option<Url>, String> {
    if code == AUTODETECTION_FAILED && !explicit_pac {
      // No WPAD configuration was discovered. The active manual policy, or its
      // absence, is the Windows route; a downloaded/explicit PAC failure is not.
      manual_proxy(target, proxy, bypass)
    } else {
      Err(format!("Windows proxy auto-configuration failed (code {code}); check Windows/Lagom network settings"))
    }
  }
}

#[cfg(windows)]
mod windows {
  use std::ffi::c_void;
  use std::ptr;
  use std::sync::{Arc, Condvar, Mutex};
  use super::{AtomicBool, Duration, Instant, check_control, parsing};
  use url::Url;

  const WINHTTP_FLAG_ASYNC: u32 = 0x10000000;
  const WINHTTP_OPTION_CONTEXT_VALUE: u32 = 45;
  const REQUEST_ERROR: u32 = 0x00200000;
  const PROXY_COMPLETE: u32 = 0x01000000;
  const HANDLE_CLOSING: u32 = 0x00000800;
  const CALLBACK_FLAGS: u32 = REQUEST_ERROR | PROXY_COMPLETE | 0x00000c00;
  const ERROR_IO_PENDING: u32 = 997;
  const ERROR_CANCELLED: u32 = 12017;
  const MAX_PROXY_RESULTS: u32 = 256;
  const CANCEL_POLL: Duration = Duration::from_millis(20);
  const PHASE_TIMEOUT_MS: i32 = 2000;

  #[repr(C)]
  #[derive(Default)]
  struct CurrentUserConfig { auto_detect: i32, auto_config_url: *mut u16, proxy: *mut u16, bypass: *mut u16 }
  #[repr(C)]
  struct AutoProxyOptions { flags: u32, detect_flags: u32, config_url: *const u16, reserved: *mut c_void, reserved_value: u32, auto_logon: i32 }
  #[repr(C)]
  #[derive(Default)]
  struct ProxyResult { count: u32, entries: *mut ProxyEntry }
  #[repr(C)]
  struct ProxyEntry { is_proxy: i32, is_bypass: i32, scheme: u32, host: *mut u16, port: u16 }
  #[repr(C)]
  struct AsyncResult { operation: usize, error: u32 }
  type StatusCallback = unsafe extern "system" fn(*mut c_void, usize, u32, *mut c_void, u32);

  #[link(name = "winhttp")]
  unsafe extern "system" {
    fn WinHttpGetIEProxyConfigForCurrentUser(config: *mut CurrentUserConfig) -> i32;
    fn WinHttpOpen(agent: *const u16, access: u32, proxy: *const u16, bypass: *const u16, flags: u32) -> *mut c_void;
    fn WinHttpSetTimeouts(session: *mut c_void, resolve: i32, connect: i32, send: i32, receive: i32) -> i32;
    fn WinHttpSetStatusCallback(handle: *mut c_void, callback: Option<StatusCallback>, flags: u32, reserved: usize) -> usize;
    fn WinHttpSetOption(handle: *mut c_void, option: u32, value: *mut c_void, size: u32) -> i32;
    fn WinHttpCreateProxyResolver(session: *mut c_void, resolver: *mut *mut c_void) -> u32;
    fn WinHttpGetProxyForUrlEx(resolver: *mut c_void, url: *const u16, options: *mut AutoProxyOptions, context: usize) -> u32;
    fn WinHttpGetProxyResult(resolver: *mut c_void, result: *mut ProxyResult) -> u32;
    fn WinHttpFreeProxyResult(result: *mut ProxyResult);
    fn WinHttpCloseHandle(handle: *mut c_void) -> i32;
  }
  #[link(name = "kernel32")]
  unsafe extern "system" { fn GlobalFree(pointer: *mut c_void) -> *mut c_void; fn GetLastError() -> u32; }

  fn free_string(pointer: *mut u16) { if !pointer.is_null() { unsafe { GlobalFree(pointer.cast()); } } }
  impl Drop for CurrentUserConfig { fn drop(&mut self) { free_string(self.auto_config_url); free_string(self.proxy); free_string(self.bypass); } }
  impl Drop for ProxyResult { fn drop(&mut self) { if !self.entries.is_null() { unsafe { WinHttpFreeProxyResult(self); } } } }
  struct Handle(*mut c_void);
  impl Drop for Handle { fn drop(&mut self) { unsafe { WinHttpCloseHandle(self.0); } } }

  struct ProxyContext {
    completion: Mutex<Option<Result<(), u32>>>,
    wake: Condvar,
    target: Vec<u16>,
    _pac: Option<Vec<u16>>,
    options: AutoProxyOptions,
  }

  // The FFI options are read-only inputs. Their pointers refer to immutable
  // allocations owned by this context until the final HANDLE_CLOSING callback.
  unsafe impl Send for ProxyContext {}
  unsafe impl Sync for ProxyContext {}

  impl ProxyContext {
    fn new(target: &Url, pac: Option<&str>) -> Self {
      let target = target.as_str().encode_utf16().chain(Some(0)).collect();
      let pac = pac.map(|value| value.encode_utf16().chain(Some(0)).collect::<Vec<u16>>());
      let options = AutoProxyOptions {
        flags: (if pac.is_some() { 2 } else { 1 }) | 0x00080000 | 0x00100000,
        detect_flags: if pac.is_some() { 0 } else { 3 },
        config_url: pac.as_ref().map_or(ptr::null(), |value| value.as_ptr()),
        reserved: ptr::null_mut(), reserved_value: 0, auto_logon: 0,
      };
      Self { completion: Mutex::new(None), wake: Condvar::new(), target, _pac: pac, options }
    }

    fn complete(&self, result: Result<(), u32>) {
      let mut completion = self.completion.lock().unwrap_or_else(|poison| poison.into_inner());
      if completion.is_none() { *completion = Some(result); }
      self.wake.notify_all();
    }

    fn wait(&self, cancel: &AtomicBool, deadline: Instant) -> Result<Result<(), u32>, String> {
      let mut completion = self.completion.lock().unwrap_or_else(|poison| poison.into_inner());
      loop {
        check_control(cancel, deadline)?;
        if let Some(result) = *completion { return Ok(result); }
        let remaining = deadline.saturating_duration_since(Instant::now()).min(CANCEL_POLL);
        let (next, _) = self.wake.wait_timeout(completion, remaining).unwrap_or_else(|poison| poison.into_inner());
        completion = next;
      }
    }
  }

  unsafe extern "system" fn proxy_callback(_handle: *mut c_void, context: usize, status: u32, information: *mut c_void, length: u32) {
    if context == 0 { return; }
    let context = context as *const ProxyContext;
    if status == HANDLE_CLOSING {
      // HANDLE_CLOSING is the last callback, with no concurrent callbacks for
      // this handle. It releases the strong reference transferred to WinHTTP.
      let context = unsafe { Arc::from_raw(context) };
      context.complete(Err(ERROR_CANCELLED));
      return;
    }
    let context = unsafe { &*context };
    if status == PROXY_COMPLETE {
      context.complete(Ok(()));
    } else if status == REQUEST_ERROR {
      let error = if !information.is_null() && length as usize >= std::mem::size_of::<AsyncResult>() {
        unsafe { ptr::read_unaligned(information.cast::<AsyncResult>()) }.error
      } else { ERROR_CANCELLED };
      context.complete(Err(error));
    }
  }

  fn read_string(pointer: *const u16) -> Result<Option<String>, String> {
    if pointer.is_null() { return Ok(None); }
    // WinHTTP supplies a terminated allocation, with a bounded prefix read
    for size in 0..=parsing::MAX_CONFIG_UNITS {
      if unsafe { *pointer.add(size) } == 0 {
        return String::from_utf16(unsafe { std::slice::from_raw_parts(pointer, size) })
          .map(Some).map_err(|_| "Invalid UTF-16 Windows proxy configuration".to_string());
      }
    }
    Err("Oversized Windows proxy configuration".to_string())
  }

  pub(super) fn proxy_for_target(target: &Url, cancel: &AtomicBool, deadline: Instant) -> Result<Option<Url>, String> {
    check_control(cancel, deadline)?;
    let mut config = CurrentUserConfig::default();
    if unsafe { WinHttpGetIEProxyConfigForCurrentUser(&mut config) } == 0 {
      let code = unsafe { GetLastError() };
      check_control(cancel, deadline)?;
      return if code == 2 { Ok(None) } else { Err(format!("Cannot read current Windows proxy settings (code {code})")) };
    }
    let proxy = read_string(config.proxy)?;
    let bypass = read_string(config.bypass)?;
    let pac = read_string(config.auto_config_url)?;
    proxy_for_config(target, config.auto_detect != 0, pac.as_deref(), proxy.as_deref(), bypass.as_deref(), cancel, deadline)
  }

  fn proxy_for_config(target: &Url, auto_detect: bool, pac: Option<&str>, proxy: Option<&str>, bypass: Option<&str>, cancel: &AtomicBool, deadline: Instant) -> Result<Option<Url>, String> {
    check_control(cancel, deadline)?;
    if pac.is_none() && !auto_detect {
      let route = parsing::manual_proxy(target, proxy, bypass)?;
      check_control(cancel, deadline)?;
      return Ok(route);
    }
    if let Some(pac) = pac {
      let pac = Url::parse(pac).map_err(|_| "Invalid Windows PAC URL".to_string())?;
      if !matches!(pac.scheme(), "http" | "https") || pac.host_str().is_none()
        || !pac.username().is_empty() || pac.password().is_some() {
        return Err("Windows PAC must use HTTP(S) without embedded credentials".to_string());
      }
    }
    match resolve_auto(target, pac, cancel, deadline)? {
      Ok(route) => Ok(route),
      Err(code) => {
        check_control(cancel, deadline)?;
        parsing::after_auto_error(target, code, pac.is_some(), proxy, bypass)
      },
    }
  }

  struct ProxyResolver { handle: Handle, _session: Handle, context: Arc<ProxyContext> }

  fn open_resolver(target: &Url, pac: Option<&str>) -> Result<ProxyResolver, String> {
    let agent: Vec<u16> = "Egoist Relay\0".encode_utf16().collect();
    let session = Handle(unsafe { WinHttpOpen(agent.as_ptr(), 1, ptr::null(), ptr::null(), WINHTTP_FLAG_ASYNC) });
    if session.0.is_null() { return Err(format!("Cannot open Windows proxy resolver (code {})", unsafe { GetLastError() })); }
    if unsafe { WinHttpSetTimeouts(session.0, PHASE_TIMEOUT_MS, PHASE_TIMEOUT_MS, PHASE_TIMEOUT_MS, PHASE_TIMEOUT_MS) } == 0 {
      return Err(format!("Cannot set Windows proxy resolver timeouts (code {})", unsafe { GetLastError() }));
    }
    if unsafe { WinHttpSetStatusCallback(session.0, Some(proxy_callback), CALLBACK_FLAGS, 0) } == usize::MAX {
      return Err(format!("Cannot observe Windows proxy resolver (code {})", unsafe { GetLastError() }));
    }
    let mut resolver = ptr::null_mut();
    let code = unsafe { WinHttpCreateProxyResolver(session.0, &mut resolver) };
    if code != 0 { return Err(format!("Cannot create Windows proxy resolver (code {code})")); }
    if resolver.is_null() { return Err("Windows returned an empty proxy resolver".to_string()); }
    let resolver = Handle(resolver);
    let context = Arc::new(ProxyContext::new(target, pac));
    let callback_context = Arc::into_raw(context.clone());
    let mut context_value = callback_context as usize;
    if unsafe { WinHttpSetOption(resolver.0, WINHTTP_OPTION_CONTEXT_VALUE, ptr::addr_of_mut!(context_value).cast(), std::mem::size_of::<usize>() as u32) } == 0 {
      // The handle has no context, so there is no callback owner to release it
      let code = unsafe { GetLastError() };
      unsafe { drop(Arc::from_raw(callback_context)); }
      return Err(format!("Cannot bind Windows proxy resolver (code {code})"));
    }
    Ok(ProxyResolver { handle: resolver, _session: session, context })
  }

  fn resolve_auto(target: &Url, pac: Option<&str>, cancel: &AtomicBool, deadline: Instant) -> Result<Result<Option<Url>, u32>, String> {
    check_control(cancel, deadline)?;
    let resolver = open_resolver(target, pac)?;
    let context = &resolver.context;
    check_control(cancel, deadline)?;
    let code = unsafe { WinHttpGetProxyForUrlEx(resolver.handle.0, context.target.as_ptr(), ptr::addr_of!(context.options).cast_mut(), Arc::as_ptr(context) as usize) };
    if code != ERROR_IO_PENDING {
      check_control(cancel, deadline)?;
      return Ok(Err(code));
    }
    if let Err(code) = context.wait(cancel, deadline)? { return Ok(Err(code)); }
    check_control(cancel, deadline)?;
    let mut result = ProxyResult::default();
    let code = unsafe { WinHttpGetProxyResult(resolver.handle.0, &mut result) };
    if code != 0 { return Ok(Err(code)); }
    if result.count == 0 || result.count > MAX_PROXY_RESULTS || result.entries.is_null() {
      return Err("Windows PAC returned an empty or oversized proxy list".to_string());
    }
    // Relay uses the first selected route; it does not silently fail over to
    // later proxies or DIRECT when that route is unavailable.
    let entry = unsafe { &*result.entries };
    let host = read_string(entry.host)?;
    let route = parsing::pac_route(entry.is_proxy != 0, entry.scheme, host.as_deref(), entry.port)?;
    check_control(cancel, deadline)?;
    Ok(Ok(route))
  }

  #[cfg(test)]
  mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::atomic::Ordering;
    use std::sync::mpsc;
    use std::thread;

    struct PacFixture {
      url: String,
      requested: mpsc::Receiver<()>,
      stop: Arc<AtomicBool>,
      worker: Option<thread::JoinHandle<()>>,
    }

    impl PacFixture {
      fn new(response: Option<&'static str>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://127.0.0.1:{}/relay.pac", listener.local_addr().unwrap().port());
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = stop.clone();
        let (sender, requested) = mpsc::channel();
        let worker = thread::spawn(move || {
          while !stopped.load(Ordering::Acquire) {
            match listener.accept() {
              Ok((mut socket, _)) => {
                socket.set_read_timeout(Some(Duration::from_millis(100))).unwrap();
                let mut request = Vec::new();
                let mut buffer = [0u8; 1024];
                while !request.windows(4).any(|window| window == b"\r\n\r\n") && request.len() < 8192 && !stopped.load(Ordering::Acquire) {
                  match socket.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(length) => request.extend_from_slice(&buffer[..length]),
                    Err(error) if matches!(error.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {},
                    Err(_) => break,
                  }
                }
                let _ = sender.send(());
                if let Some(response) = response {
                  let _ = socket.write_all(response.as_bytes());
                } else {
                  while !stopped.load(Ordering::Acquire) { thread::sleep(Duration::from_millis(5)); }
                }
              },
              Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => thread::sleep(Duration::from_millis(5)),
              Err(_) => break,
            }
          }
        });
        Self { url, requested, stop, worker: Some(worker) }
      }
    }

    impl Drop for PacFixture {
      fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() { worker.join().unwrap(); }
      }
    }

    fn target() -> Url { Url::parse("https://video.example/media").unwrap() }

    #[test]
    fn winhttp_closing_callback_releases_cancelled_request_inputs() {
      let fixture = PacFixture::new(None);
      let resolver = open_resolver(&target(), Some(&fixture.url)).unwrap();
      let weak = Arc::downgrade(&resolver.context);
      let code = unsafe { WinHttpGetProxyForUrlEx(resolver.handle.0, resolver.context.target.as_ptr(), ptr::addr_of!(resolver.context.options).cast_mut(), Arc::as_ptr(&resolver.context) as usize) };
      assert_eq!(code, ERROR_IO_PENDING);
      fixture.requested.recv_timeout(Duration::from_secs(3)).unwrap();
      drop(resolver);
      let deadline = Instant::now() + Duration::from_secs(1);
      while weak.upgrade().is_some() && Instant::now() < deadline { thread::sleep(Duration::from_millis(1)); }
      assert!(weak.upgrade().is_none(), "WinHTTP must release the transferred context after close");
    }
    #[test]
    fn deadline_bounds_an_uncompleted_callback_wait() {
      let context = ProxyContext::new(&target(), None);
      let started = Instant::now();
      let result = context.wait(&AtomicBool::new(false), started + Duration::from_millis(60));
      assert!(result.unwrap_err().contains("timed out"));
      assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn cancellation_interrupts_an_uncompleted_callback_wait() {
      let context = ProxyContext::new(&target(), None);
      let cancel = Arc::new(AtomicBool::new(false));
      let cancelled = cancel.clone();
      let worker = thread::spawn(move || { thread::sleep(Duration::from_millis(30)); cancelled.store(true, Ordering::Release); });
      let started = Instant::now();
      assert!(context.wait(&cancel, started + Duration::from_secs(5)).unwrap_err().contains("cancel"));
      assert!(started.elapsed() < Duration::from_secs(1));
      worker.join().unwrap();
    }

    #[test]
    fn cancellation_and_deadline_win_over_a_racing_completion() {
      let context = ProxyContext::new(&target(), None);
      context.complete(Ok(()));
      assert!(context.wait(&AtomicBool::new(true), Instant::now() + Duration::from_secs(5)).is_err());
      assert!(context.wait(&AtomicBool::new(false), Instant::now()).is_err());
    }

    #[test]
    fn callback_before_wait_is_not_lost_and_late_events_do_not_override_it() {
      let context = ProxyContext::new(&target(), None);
      context.complete(Err(12167));
      context.complete(Ok(()));
      context.complete(Err(ERROR_CANCELLED));
      assert_eq!(context.wait(&AtomicBool::new(false), Instant::now() + Duration::from_secs(5)).unwrap(), Err(12167));
    }

    #[test]
    fn closing_callback_releases_inputs_after_the_caller_returns() {
      let context = Arc::new(ProxyContext::new(&target(), Some("http://127.0.0.1/relay.pac")));
      let weak = Arc::downgrade(&context);
      let callback_context = Arc::into_raw(context.clone()) as usize;
      drop(context);
      assert!(weak.upgrade().is_some());
      unsafe { proxy_callback(ptr::null_mut(), callback_context, PROXY_COMPLETE, ptr::null_mut(), 0); }
      assert!(weak.upgrade().is_some());
      unsafe { proxy_callback(ptr::null_mut(), callback_context, HANDLE_CLOSING, ptr::null_mut(), 0); }
      assert!(weak.upgrade().is_none());
    }

    #[test]
    fn manual_route_and_bypass_are_unchanged_without_autoproxy() {
      let cancel = AtomicBool::new(false);
      let deadline = Instant::now() + Duration::from_secs(5);
      assert_eq!(proxy_for_config(&target(), false, None, Some("https=127.0.0.1:10931"), None, &cancel, deadline).unwrap().unwrap().as_str(), "http://127.0.0.1:10931/");
      assert!(proxy_for_config(&target(), false, None, Some("https=127.0.0.1:10931"), Some("*.example"), &cancel, deadline).unwrap().is_none());
    }

    #[test]
    fn local_pac_selects_first_proxy_without_direct_failover() {
      let fixture = PacFixture::new(Some("HTTP/1.1 200 OK\r\nContent-Type: application/x-ns-proxy-autoconfig\r\nConnection: close\r\n\r\nfunction FindProxyForURL(url, host) { return 'PROXY 127.0.0.1:18763; PROXY 127.0.0.1:18764; DIRECT'; }"));
      let route = proxy_for_config(&target(), false, Some(&fixture.url), None, None, &AtomicBool::new(false), Instant::now() + Duration::from_secs(5)).unwrap().unwrap();
      assert_eq!(route.as_str(), "http://127.0.0.1:18763/");
      fixture.requested.recv_timeout(Duration::from_secs(1)).unwrap();
    }

    #[test]
    fn failed_explicit_local_pac_does_not_use_manual_or_direct_route() {
      let fixture = PacFixture::new(Some("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"));
      let error = proxy_for_config(&target(), false, Some(&fixture.url), Some("127.0.0.1:10931"), Some("*"), &AtomicBool::new(false), Instant::now() + Duration::from_secs(5)).unwrap_err();
      assert!(error.contains("auto-configuration failed"), "{error}");
      fixture.requested.recv_timeout(Duration::from_secs(1)).unwrap();
    }

    #[test]
    fn pending_local_pac_fetch_obeys_absolute_deadline() {
      let fixture = PacFixture::new(None);
      let started = Instant::now();
      let error = proxy_for_config(&target(), false, Some(&fixture.url), None, None, &AtomicBool::new(false), started + Duration::from_millis(200)).unwrap_err();
      assert!(error.contains("timed out"), "{error}");
      assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn pending_local_pac_fetch_can_be_cancelled_after_it_starts() {
      let fixture = PacFixture::new(None);
      let target = target();
      let cancel = Arc::new(AtomicBool::new(false));
      let cancellation = cancel.clone();
      let url = fixture.url.clone();
      let worker = thread::spawn(move || proxy_for_config(&target, false, Some(&url), None, None, &cancellation, Instant::now() + Duration::from_secs(5)));
      let received = fixture.requested.recv_timeout(Duration::from_secs(3));
      let started = Instant::now();
      cancel.store(true, Ordering::Release);
      let result = worker.join().unwrap();
      received.unwrap();
      assert!(result.unwrap_err().contains("cancel"));
      assert!(started.elapsed() < Duration::from_secs(1));
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use super::parsing::*;

  fn target() -> Url { Url::parse("https://video.example/media").unwrap() }
  #[test]
  fn pac_route_preserves_http_https_ipv6_and_direct_without_guessing_socks() {
    assert_eq!(pac_route(true, 1, Some("proxy.example"), 8080).unwrap().unwrap().as_str(), "http://proxy.example:8080/");
    assert_eq!(pac_route(true, 2, Some("proxy.example"), 8443).unwrap().unwrap().as_str(), "https://proxy.example:8443/");
    assert_eq!(pac_route(true, 1, Some("::1"), 8080).unwrap().unwrap().as_str(), "http://[::1]:8080/");
    assert!(pac_route(false, 0, None, 0).unwrap().is_none());
    assert!(pac_route(true, 4, Some("proxy.example"), 1080).is_err());
    assert!(pac_route(true, 1, Some("proxy.example/path"), 80).is_err());
    assert!(pac_route(true, 1, Some("proxy.example"), 0).is_err());
    assert!(pac_route(true, 1, None, 80).is_err());
  }
  #[test]
  fn cancellation_before_entry_does_not_resolve_a_route() {
    let cancel = std::sync::atomic::AtomicBool::new(true);
    let result = proxy_for_url_cancellable("https://video.example/media", &cancel,
      std::time::Instant::now() + std::time::Duration::from_secs(5));
    assert!(result.unwrap_err().to_ascii_lowercase().contains("cancel"));
  }

  #[test]
  fn expired_deadline_does_not_resolve_a_route() {
    let cancel = std::sync::atomic::AtomicBool::new(false);
    let result = proxy_for_url_cancellable("https://video.example/media", &cancel, std::time::Instant::now());
    assert!(result.unwrap_err().to_ascii_lowercase().contains("timed out"));
  }

  #[test]
  fn current_manual_endpoint_is_not_a_fixed_lagom_default() {
    assert_eq!(manual_proxy(&target(), Some("127.0.0.1:10931"), None).unwrap().unwrap().as_str(), "http://127.0.0.1:10931/");
    assert_eq!(manual_proxy(&target(), Some("127.0.0.1:49203"), None).unwrap().unwrap().port(), Some(49203));
    assert!(manual_proxy(&target(), None, None).unwrap().is_none());
  }

  #[test]
  fn https_protocol_key_does_not_mean_tls_to_the_proxy() {
    let proxy = manual_proxy(&target(), Some("http=127.0.0.1:8080;https=127.0.0.1:10809"), None).unwrap().unwrap();
    assert_eq!(proxy.as_str(), "http://127.0.0.1:10809/");
    assert!(manual_proxy(&target(), Some("http=127.0.0.1:8080"), None).unwrap().is_none());
    assert_eq!(manual_proxy(&target(), Some("https=https://proxy.example:8443"), None).unwrap().unwrap().scheme(), "https");
  }

  #[test]
  fn supports_explicit_socks5_without_guessing_windows_socks4() {
    assert_eq!(manual_proxy(&target(), Some("socks=socks5://[::1]:10808"), None).unwrap().unwrap().as_str(), "socks5://[::1]:10808");
    assert_eq!(endpoint("socks5://proxy.example", false).unwrap().port(), Some(1080));
    assert!(manual_proxy(&target(), Some("socks=127.0.0.1:10808"), None).is_err());
  }

  #[test]
  fn respects_exact_wildcard_local_scheme_and_port_bypass_rules() {
    assert!(bypass_matches(&target(), "*.example;127.*;<local>").unwrap());
    assert!(!bypass_matches(&target(), "example;video.example:8443;http://video.example").unwrap());
    assert!(bypass_matches(&target(), "https://video.example:443").unwrap());
    assert!(bypass_matches(&Url::parse("https://intranet/a").unwrap(), "<local>").unwrap());
    assert!(!bypass_matches(&Url::parse("https://intranet.example/a").unwrap(), "<local>").unwrap());
    assert!(bypass_matches(&Url::parse("https://[::1]:8443/a").unwrap(), "[::1]:8443").unwrap());
    assert!(manual_proxy(&target(), Some("127.0.0.1:10809"), Some("video.example")).unwrap().is_none());
  }

  #[test]
  fn rejects_credentials_paths_protocols_ambiguous_ports_and_oversized_configurations() {
    for value in ["", "http://user:secret@proxy.example.invalid:8080", "http://@proxy.example.invalid:8080", "http://proxy/a", "http://proxy/", "http://proxy?token=secret", "http://proxy#fragment", "http://proxy:0", "http://proxy:65536", "socks4://proxy:1080", "file://proxy", "http://proxy\\a", "proxy\n:8080"] {
      assert!(endpoint(value, false).is_err(), "{value}");
    }
    for value in ["https=proxy:80;https=proxy:90", "bad=proxy:80", " ; ", "https="] {
      assert!(manual_proxy(&target(), Some(value), None).is_err(), "{value}");
    }
    assert!(endpoint(&"a".repeat(2049), false).is_err());
    assert!(manual_proxy(&target(), Some(&"a".repeat(MAX_CONFIG_UNITS * 4 + 1)), None).is_err());
    assert!(bypass_matches(&target(), "10.0.0.0/8").is_err());
    assert!(bypass_matches(&target(), "video.example:65536").is_err());
  }

  #[test]
  fn configured_pac_failures_never_become_a_direct_or_manual_fallback() {
    assert!(after_auto_error(&target(), 12180, false, None, None).unwrap().is_none());
    assert_eq!(after_auto_error(&target(), 12180, false, Some("127.0.0.1:10839"), None).unwrap().unwrap().port(), Some(10839));
    for code in [12180, 12166, 12167, 12015, 12002] {
      assert!(after_auto_error(&target(), code, true, Some("127.0.0.1:10839"), None).is_err());
    }
    assert!(after_auto_error(&target(), 12167, false, None, None).is_err());
  }

  #[test]
  fn invalid_configuration_does_not_hide_behind_a_matching_bypass() {
    assert!(manual_proxy(&target(), Some("https=broken:65536"), Some("*")).is_err());
    assert!(manual_proxy(&target(), Some("https=proxy:80"), Some("<unsupported>")).is_err());
  }

  #[test]
  fn rejects_non_https_targets_and_target_credentials_with_sanitized_errors() {
    for value in ["http://video.example", "file:///tmp/a", "https://user:secret@video.example.invalid", "https://video.example/\nsecret"] {
      let error = proxy_for_url(value).unwrap_err();
      assert!(!error.contains("secret"));
    }
  }
}
