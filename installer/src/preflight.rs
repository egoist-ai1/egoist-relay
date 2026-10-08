//! Проверки до установки и разбор результатов: чистая логика (без Windows API).

use std::cmp::Ordering;

/// Минимальная сборка Windows 10 1903 (как в tauri/installer.nsh, секция requirements).
pub const MIN_WINDOWS_BUILD: u32 = 18362;
/// Совпадает с RELAY_MAX_INSTALL_DIRECTORY_CHARS в tauri/installer.nsh (его сверяет release-preflight).
pub const MAX_INSTALL_DIR_CHARS: usize = 208;
/// Запас на временные файлы, WebView2 и журнал.
pub const SPACE_MARGIN: u64 = 128 * 1024 * 1024;

/// Сравнение версий «1.7.1» / «1.7.1-rc.1» (пререлиз меньше релиза). Нечисловые части считаются нулём.
pub fn compare_versions(a: &str, b: &str) -> Ordering {
    fn split(v: &str) -> (Vec<u64>, bool) {
        let v = v.trim().trim_start_matches('v');
        let (core, pre) = match v.split_once('-') {
            Some((c, _)) => (c, true),
            None => (v, false),
        };
        let core = core.split('+').next().unwrap_or("");
        (core.split('.').map(|p| p.parse::<u64>().unwrap_or(0)).collect(), pre)
    }
    let (na, pa) = split(a);
    let (nb, pb) = split(b);
    for i in 0..na.len().max(nb.len()).max(3) {
        let (x, y) = (na.get(i).copied().unwrap_or(0), nb.get(i).copied().unwrap_or(0));
        match x.cmp(&y) {
            Ordering::Equal => {}
            o => return o,
        }
    }
    match (pa, pb) {
        (true, false) => Ordering::Less,
        (false, true) => Ordering::Greater,
        _ => Ordering::Equal,
    }
}

/// NSIS пишет InstallLocation в кавычках: `"C:\Users\x\AppData\Local\Egoist Relay"`.
pub fn unquote_install_location(raw: &str) -> String {
    let t = raw.trim();
    t.strip_prefix('"').and_then(|s| s.strip_suffix('"')).unwrap_or(t).trim_end_matches('\\').to_string()
}

pub fn install_dir_too_long(dir: &str) -> bool {
    dir.encode_utf16().count() > MAX_INSTALL_DIR_CHARS
}

#[derive(Debug, PartialEq, Eq)]
pub struct SpaceNeed {
    pub install_volume: u64,
    pub temp_volume: u64,
}

/// Сколько нужно на каждом томе. Если каталог установки и temp на одном томе, требования суммируются.
pub fn space_needed(payload_len: u64, install_bytes: u64, same_volume: bool) -> SpaceNeed {
    // Значения из хвоста недоверенные до проверки: переполнение не должно давать «нужно мало места».
    let temp = payload_len.saturating_add(SPACE_MARGIN);
    let install = install_bytes.saturating_add(install_bytes / 10).saturating_add(SPACE_MARGIN);
    if same_volume {
        let both = install.saturating_add(temp);
        SpaceNeed { install_volume: both, temp_volume: both }
    } else {
        SpaceNeed { install_volume: install, temp_volume: temp }
    }
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Cause {
    /// Сам Sennit запущен (NSIS вернул 2).
    AppRunning,
    /// Скрипт NSIS остановил установку проверками (1): старая Windows, путь, откат версии.
    ScriptAbort,
    /// Антивирус удалил или заблокировал файл (ERROR_VIRUS_INFECTED 225, ERROR_VIRUS_DELETED 226).
    Antivirus,
    AccessDenied,
    /// Недостаточно места (диск полон).
    DiskFull,
    Other,
}

/// Классификация ненулевого кода возврата NSIS. `low_space` — после сбоя свободного места мало.
pub fn classify_exit(code: i32, low_space: bool) -> Cause {
    match code {
        2 => Cause::AppRunning,
        1 => {
            if low_space {
                Cause::DiskFull
            } else {
                Cause::ScriptAbort
            }
        }
        225 | 226 => Cause::Antivirus,
        5 => Cause::AccessDenied,
        _ => {
            if low_space {
                Cause::DiskFull
            } else {
                Cause::Other
            }
        }
    }
}

/// Классификация ошибки запуска/записи по коду Win32.
pub fn classify_os_error(code: i32) -> Cause {
    match code {
        225 | 226 => Cause::Antivirus,
        5 | 32 | 33 | 1260 | 740 => Cause::AccessDenied,
        39 | 112 => Cause::DiskFull,
        _ => Cause::Other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions() {
        assert_eq!(compare_versions("1.7.1", "1.7.1"), Ordering::Equal);
        assert_eq!(compare_versions("1.7.1", "1.7.0"), Ordering::Greater);
        assert_eq!(compare_versions("1.10.0", "1.9.9"), Ordering::Greater);
        assert_eq!(compare_versions("1.7", "1.7.0"), Ordering::Equal);
        assert_eq!(compare_versions("1.7.1-rc.1", "1.7.1"), Ordering::Less);
        assert_eq!(compare_versions("v2.0.0", "1.99.99"), Ordering::Greater);
        assert_eq!(compare_versions("1.7.1+build5", "1.7.1"), Ordering::Equal);
    }

    #[test]
    fn install_location() {
        assert_eq!(unquote_install_location("\"C:\\A B\\Egoist Relay\""), "C:\\A B\\Egoist Relay");
        assert_eq!(unquote_install_location("C:\\A\\"), "C:\\A");
        assert_eq!(unquote_install_location("  \"D:\\x\"  "), "D:\\x");
    }

    #[test]
    fn path_budget() {
        assert!(!install_dir_too_long(&"a".repeat(208)));
        assert!(install_dir_too_long(&"a".repeat(209)));
        assert!(!install_dir_too_long("C:\\Users\\Егор\\AppData\\Local\\Egoist Relay"));
    }

    #[test]
    fn space() {
        let apart = space_needed(500, 800, false);
        let same = space_needed(500, 800, true);
        assert_eq!(same.install_volume, same.temp_volume);
        assert!(same.install_volume > apart.install_volume);
        assert!(same.install_volume > apart.temp_volume);
    }

    #[test]
    fn space_does_not_overflow() {
        let n = space_needed(u64::MAX, u64::MAX, true);
        assert_eq!(n.install_volume, u64::MAX);
        assert_eq!(space_needed(u64::MAX - 5, u64::MAX, false).temp_volume, u64::MAX);
    }

    #[test]
    fn exit_codes() {
        assert_eq!(classify_exit(2, false), Cause::AppRunning);
        assert_eq!(classify_exit(1, false), Cause::ScriptAbort);
        assert_eq!(classify_exit(1, true), Cause::DiskFull);
        assert_eq!(classify_exit(225, false), Cause::Antivirus);
        assert_eq!(classify_exit(5, false), Cause::AccessDenied);
        assert_eq!(classify_exit(-1, false), Cause::Other);
        assert_eq!(classify_exit(-1, true), Cause::DiskFull);
    }

    #[test]
    fn os_errors() {
        assert_eq!(classify_os_error(225), Cause::Antivirus);
        assert_eq!(classify_os_error(226), Cause::Antivirus);
        assert_eq!(classify_os_error(32), Cause::AccessDenied);
        assert_eq!(classify_os_error(112), Cause::DiskFull);
        assert_eq!(classify_os_error(2), Cause::Other);
    }
}
