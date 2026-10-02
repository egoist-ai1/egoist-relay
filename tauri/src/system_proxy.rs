use url::Url;

const MAX_TARGET_BYTES: usize = 16 * 1024;

/// Reads the active Windows user proxy for this operation. Call off the UI thread:
/// PAC discovery is synchronous and WinHTTP phase timeouts are not a total deadline.
pub fn proxy_for_url(target: &str) -> Result<Option<Url>, String> {
  let target = validated_target(target)?;
  #[cfg(windows)]
  { windows::proxy_for_target(&target) }
  #[cfg(not(windows))]
  { let _ = target; Ok(None) }
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
  use url::Url;
  use super::parsing;

  #[repr(C)]
  #[derive(Default)]
  struct CurrentUserConfig { auto_detect: i32, auto_config_url: *mut u16, proxy: *mut u16, bypass: *mut u16 }
  #[repr(C)]
  #[derive(Default)]
  struct ProxyInfo { access_type: u32, proxy: *mut u16, bypass: *mut u16 }
  #[repr(C)]
  struct AutoProxyOptions { flags: u32, detect_flags: u32, config_url: *const u16, reserved: *mut c_void, reserved_value: u32, auto_logon: i32 }

  #[link(name = "winhttp")]
  unsafe extern "system" {
    fn WinHttpGetIEProxyConfigForCurrentUser(config: *mut CurrentUserConfig) -> i32;
    fn WinHttpOpen(agent: *const u16, access: u32, proxy: *const u16, bypass: *const u16, flags: u32) -> *mut c_void;
    fn WinHttpSetTimeouts(session: *mut c_void, resolve: i32, connect: i32, send: i32, receive: i32) -> i32;
    fn WinHttpGetProxyForUrl(session: *mut c_void, url: *const u16, options: *mut AutoProxyOptions, info: *mut ProxyInfo) -> i32;
    fn WinHttpCloseHandle(handle: *mut c_void) -> i32;
  }
  #[link(name = "kernel32")]
  unsafe extern "system" { fn GlobalFree(pointer: *mut c_void) -> *mut c_void; fn GetLastError() -> u32; }

  fn free_string(pointer: *mut u16) { if !pointer.is_null() { unsafe { GlobalFree(pointer.cast()); } } }
  impl Drop for CurrentUserConfig { fn drop(&mut self) { free_string(self.auto_config_url); free_string(self.proxy); free_string(self.bypass); } }
  impl Drop for ProxyInfo { fn drop(&mut self) { free_string(self.proxy); free_string(self.bypass); } }
  struct Session(*mut c_void);
  impl Drop for Session { fn drop(&mut self) { unsafe { WinHttpCloseHandle(self.0); } } }

  fn read_string(pointer: *const u16) -> Result<Option<String>, String> {
    if pointer.is_null() { return Ok(None); }
    // WinHTTP guarantees a terminated allocated UTF-16 string. Read only its
    // bounded prefix; all API allocations are released by their owners above.
    for size in 0..=parsing::MAX_CONFIG_UNITS {
      if unsafe { *pointer.add(size) } == 0 {
        return String::from_utf16(unsafe { std::slice::from_raw_parts(pointer, size) })
          .map(Some).map_err(|_| "Invalid UTF-16 Windows proxy configuration".to_string());
      }
    }
    Err("Oversized Windows proxy configuration".to_string())
  }

  pub(super) fn proxy_for_target(target: &Url) -> Result<Option<Url>, String> {
    let mut config = CurrentUserConfig::default();
    if unsafe { WinHttpGetIEProxyConfigForCurrentUser(&mut config) } == 0 {
      let code = unsafe { GetLastError() };
      return if code == 2 { Ok(None) } else { Err(format!("Cannot read current Windows proxy settings (code {code})")) };
    }
    let proxy = read_string(config.proxy)?;
    let bypass = read_string(config.bypass)?;
    let pac = read_string(config.auto_config_url)?;
    if pac.is_none() && config.auto_detect == 0 {
      return parsing::manual_proxy(target, proxy.as_deref(), bypass.as_deref());
    }
    if let Some(pac) = &pac {
      let pac = Url::parse(pac).map_err(|_| "Invalid Windows PAC URL".to_string())?;
      if !matches!(pac.scheme(), "http" | "https") || pac.host_str().is_none()
        || !pac.username().is_empty() || pac.password().is_some() {
        return Err("Windows PAC must use HTTP(S) without embedded credentials".to_string());
      }
    }
    let agent: Vec<u16> = "Egoist Relay\0".encode_utf16().collect();
    let session = Session(unsafe { WinHttpOpen(agent.as_ptr(), 1, ptr::null(), ptr::null(), 0) });
    if session.0.is_null() { return Err(format!("Cannot open Windows proxy resolver (code {})", unsafe { GetLastError() })); }
    if unsafe { WinHttpSetTimeouts(session.0, 2000, 2000, 2000, 2000) } == 0 {
      return Err(format!("Cannot set Windows proxy resolver timeouts (code {})", unsafe { GetLastError() }));
    }
    let mut options = AutoProxyOptions {
      flags: if pac.is_some() { 2 } else { 1 } | 0x00080000 | 0x00100000,
      detect_flags: if pac.is_some() { 0 } else { 3 },
      config_url: if pac.is_some() { config.auto_config_url } else { ptr::null() },
      reserved: ptr::null_mut(), reserved_value: 0, auto_logon: 0,
    };
    let target_utf16: Vec<u16> = target.as_str().encode_utf16().chain(Some(0)).collect();
    let mut result = ProxyInfo::default();
    if unsafe { WinHttpGetProxyForUrl(session.0, target_utf16.as_ptr(), &mut options, &mut result) } == 0 {
      return parsing::after_auto_error(target, unsafe { GetLastError() }, pac.is_some(), proxy.as_deref(), bypass.as_deref());
    }
    match result.access_type {
      1 => Ok(None),
      3 => {
        let proxy = read_string(result.proxy)?.ok_or("Windows PAC selected an empty proxy endpoint")?;
        let bypass = read_string(result.bypass)?;
        parsing::manual_proxy(target, Some(&proxy), bypass.as_deref())
      },
      _ => Err("Windows PAC returned an unsupported access policy".to_string()),
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use super::parsing::*;

  fn target() -> Url { Url::parse("https://video.example/media").unwrap() }

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
