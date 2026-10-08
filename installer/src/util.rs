//! Журнал установки и мелкие помощники без внешних зависимостей.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

pub fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// UTC в виде `2026-10-08T14:30:00Z` (алгоритм civil_from_days Говарда Хиннанта).
pub fn utc_iso(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

/// Имя файла журнала: `Sennit-Setup-1.7.1-20261008-143000.log` (UTC).
pub fn log_file_name(version: &str, secs: u64) -> String {
    let iso = utc_iso(secs);
    let compact: String = iso.chars().filter(|c| c.is_ascii_digit()).collect();
    format!("Sennit-Setup-{version}-{}-{}.log", &compact[..8], &compact[8..14])
}

pub struct Log {
    file: Mutex<Option<File>>,
    pub path: PathBuf,
}

impl Log {
    pub fn create(dir: &Path, version: &str) -> Log {
        let path = dir.join(log_file_name(version, now_secs()));
        let file = OpenOptions::new().create(true).append(true).open(&path).ok();
        Log { file: Mutex::new(file), path }
    }

    pub fn line(&self, text: &str) {
        if let Ok(mut guard) = self.file.lock() {
            if let Some(f) = guard.as_mut() {
                let _ = writeln!(f, "{} {}", utc_iso(now_secs()), text);
            }
        }
    }
}

/// Размер каталога (рекурсивно, ссылки и точки повторной обработки не разворачиваются).
pub fn dir_size(root: &Path) -> u64 {
    fn walk(p: &Path, depth: u32) -> u64 {
        if depth > 12 {
            return 0;
        }
        let Ok(rd) = std::fs::read_dir(p) else { return 0 };
        let mut sum = 0;
        for e in rd.flatten() {
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_symlink() {
                continue;
            }
            if ft.is_dir() {
                sum += walk(&e.path(), depth + 1);
            } else if let Ok(m) = e.metadata() {
                sum += m.len();
            }
        }
        sum
    }
    walk(root, 0)
}

/// Удаляет каталог с повторами (антивирус может ещё держать файл).
pub fn remove_dir_retry(path: &Path) -> bool {
    for _ in 0..8 {
        match std::fs::remove_dir_all(path) {
            Ok(()) => return true,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return true,
            Err(_) => std::thread::sleep(std::time::Duration::from_millis(400)),
        }
    }
    false
}

/// Старые временные каталоги и журналы прежних запусков (только наши имена, только старше суток / двух недель).
pub fn cleanup_stale(temp_root: &Path) {
    let now = SystemTime::now();
    let Ok(rd) = std::fs::read_dir(temp_root) else { return };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if !name.starts_with("Sennit-Setup-") {
            continue;
        }
        let Ok(ft) = e.file_type() else { continue };
        let Ok(modified) = e.metadata().and_then(|m| m.modified()) else { continue };
        let age = now.duration_since(modified).map(|d| d.as_secs()).unwrap_or(0);
        if ft.is_symlink() {
            continue;
        }
        if ft.is_dir() && age > 86_400 {
            let _ = std::fs::remove_dir_all(e.path());
        } else if ft.is_file() && name.ends_with(".log") && age > 14 * 86_400 {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_time() {
        assert_eq!(utc_iso(0), "1970-01-01T00:00:00Z");
        assert_eq!(utc_iso(1_791_469_800), "2026-10-08T14:30:00Z");
        assert_eq!(utc_iso(951_782_400), "2000-02-29T00:00:00Z");
    }

    #[test]
    fn log_name() {
        assert_eq!(log_file_name("1.7.1", 1_791_469_800), "Sennit-Setup-1.7.1-20261008-143000.log");
    }

    #[test]
    fn dir_size_counts_nested_files() {
        let root = std::env::temp_dir().join(format!("sennit-test-dirsize-{}", std::process::id()));
        std::fs::create_dir_all(root.join("a/b")).unwrap();
        std::fs::write(root.join("x"), [0u8; 10]).unwrap();
        std::fs::write(root.join("a/b/y"), [0u8; 25]).unwrap();
        assert_eq!(dir_size(&root), 35);
        assert_eq!(dir_size(&root.join("missing")), 0);
        std::fs::remove_dir_all(&root).unwrap();
    }
}
