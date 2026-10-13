//! Запись seed.dpapi: встроенные VPN/DoH из хвоста установщика, зашифрованные DPAPI текущего пользователя.
//!
//! Приложение при первом старте читает файл, переносит в свой профиль и удаляет. Содержимое
//! нигде не логируется: наружу идут только размеры и причины ошибок.

use std::path::{Path, PathBuf};

use crate::win;

/// Каталог данных приложения: `%LOCALAPPDATA%\com.egoist.relay\network`.
pub fn network_dir() -> Option<PathBuf> {
    let base = std::env::var_os("LOCALAPPDATA").filter(|v| !v.is_empty())?;
    Some(PathBuf::from(base).join("com.egoist.relay").join("network"))
}

/// Шифрует `json` DPAPI и атомарно (tmp + rename) кладёт в `dir\seed.dpapi`. Каталог создаётся.
/// Возвращает размер зашифрованного файла.
pub fn write_seed(dir: &Path, json: &[u8]) -> std::io::Result<usize> {
    let blob = win::dpapi_protect(json)?;
    std::fs::create_dir_all(dir)?;
    let tmp = dir.join("seed.dpapi.tmp");
    let target = dir.join("seed.dpapi");
    let write = || -> std::io::Result<()> {
        std::fs::write(&tmp, &blob)?;
        std::fs::rename(&tmp, &target)
    };
    if let Err(e) = write() {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(blob.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seed_is_encrypted_and_decryptable_by_current_user() {
        let dir = std::env::temp_dir().join(format!("egoist-social-test-seed-{}", std::process::id())).join("network");
        let json = br#"{"schema":1,"vpn":"vless://fake@example.invalid:443","doh":"https://doh.example.invalid/dns-query","mtproxy":""}"#;
        let n = write_seed(&dir, json).unwrap();
        let on_disk = std::fs::read(dir.join("seed.dpapi")).unwrap();
        assert_eq!(on_disk.len(), n);
        assert!(!on_disk.windows(7).any(|w| w == b"example"), "в файле открытый текст");
        assert_eq!(win::dpapi_unprotect(&on_disk).unwrap(), json);
        assert!(!dir.join("seed.dpapi.tmp").exists());
        // повторная запись заменяет файл
        write_seed(&dir, b"{\"schema\":1}").unwrap();
        assert_eq!(win::dpapi_unprotect(&std::fs::read(dir.join("seed.dpapi")).unwrap()).unwrap(), b"{\"schema\":1}");
        let _ = std::fs::remove_dir_all(dir.parent().unwrap());
    }

    #[test]
    fn network_dir_is_under_local_appdata() {
        if let Some(d) = network_dir() {
            assert!(d.ends_with(Path::new("com.egoist.relay").join("network")));
        }
    }
}
