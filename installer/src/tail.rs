//! Формат хвоста self-extracting установщика.
//!
//! Файл: `[stub exe][payload][meta JSON][trailer 128 байт]`. Всё числа little-endian.
//!
//! Trailer (128 байт):
//! ```text
//!   0  8  магия "SENNITSX"
//!   8  4  версия формата (1)
//!  12  4  флаги (0)
//!  16  8  payload_offset  (= длина stub)
//!  24  8  payload_len
//!  32  8  install_bytes   (ожидаемый размер установленного каталога, для прогресса)
//!  40  4  meta_len
//!  44  4  резерв (0)
//!  48 32  SHA-256 payload
//!  80 32  SHA-256(meta || trailer[0..80])  — защита хвоста от порчи
//! 112  8  резерв (0)
//! 120  8  магия конца "XSTINNES"
//! ```
//! Строго: `payload_offset + payload_len + meta_len + 128 == длина файла`.
//! SHA-256 защищает от порчи и подмены без злого умысла; подлинность гарантирует только
//! подпись Authenticode (в этой версии установщик не подписан).

use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fmt;
use std::io::{Read, Seek, SeekFrom};

pub const MAGIC: &[u8; 8] = b"SENNITSX";
pub const END_MAGIC: &[u8; 8] = b"XSTINNES";
pub const TRAILER_LEN: usize = 128;
pub const FORMAT_VERSION: u32 = 1;
/// Верхняя граница meta: защита от разбора мусора.
pub const MAX_META_LEN: u32 = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TailError {
    /// Нет сигнатуры: exe собран без payload (разработка).
    NoTail,
    Truncated,
    UnsupportedVersion(u32),
    BadCheck,
    BadBounds,
    BadMeta,
    Io(String),
}

impl fmt::Display for TailError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            TailError::NoTail => write!(f, "в файле нет встроенного установщика"),
            TailError::Truncated => write!(f, "файл установщика обрезан"),
            TailError::UnsupportedVersion(v) => write!(f, "неизвестная версия формата ({v})"),
            TailError::BadCheck => write!(f, "хвост установщика повреждён (контрольная сумма)"),
            TailError::BadBounds => write!(f, "размеры в хвосте не совпадают с размером файла"),
            TailError::BadMeta => write!(f, "описание установщика повреждено"),
            TailError::Io(e) => write!(f, "ошибка чтения: {e}"),
        }
    }
}

impl From<std::io::Error> for TailError {
    fn from(e: std::io::Error) -> Self {
        TailError::Io(e.to_string())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Meta {
    pub product: String,
    pub version: String,
    pub payload_name: String,
    pub built_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tail {
    pub payload_offset: u64,
    pub payload_len: u64,
    pub install_bytes: u64,
    pub payload_sha256: [u8; 32],
    pub meta: Meta,
}

fn u32_at(b: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(b[at..at + 4].try_into().unwrap())
}
fn u64_at(b: &[u8], at: usize) -> u64 {
    u64::from_le_bytes(b[at..at + 8].try_into().unwrap())
}

fn check_of(meta: &[u8], trailer_head: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(meta);
    h.update(&trailer_head[..80]);
    h.finalize().into()
}

/// Собирает meta + trailer (то же делает scripts/build-installer.mjs; тест сверяет формат).
#[cfg(test)]
pub fn encode(tail: &Tail) -> Vec<u8> {
    let meta = serde_json::json!({
        "product": tail.meta.product,
        "version": tail.meta.version,
        "payloadName": tail.meta.payload_name,
        "builtAt": tail.meta.built_at,
    });
    let meta_bytes = serde_json::to_vec(&meta).unwrap();
    let mut t = vec![0u8; TRAILER_LEN];
    t[0..8].copy_from_slice(MAGIC);
    t[8..12].copy_from_slice(&FORMAT_VERSION.to_le_bytes());
    t[16..24].copy_from_slice(&tail.payload_offset.to_le_bytes());
    t[24..32].copy_from_slice(&tail.payload_len.to_le_bytes());
    t[32..40].copy_from_slice(&tail.install_bytes.to_le_bytes());
    t[40..44].copy_from_slice(&(meta_bytes.len() as u32).to_le_bytes());
    t[48..80].copy_from_slice(&tail.payload_sha256);
    let check = check_of(&meta_bytes, &t);
    t[80..112].copy_from_slice(&check);
    t[120..128].copy_from_slice(END_MAGIC);
    let mut out = meta_bytes;
    out.extend_from_slice(&t);
    out
}

/// Читает и строго проверяет хвост. Payload здесь не читается.
pub fn read<R: Read + Seek>(r: &mut R) -> Result<Tail, TailError> {
    let file_len = r.seek(SeekFrom::End(0))?;
    let file_len = effective_len(r, file_len);
    if file_len < TRAILER_LEN as u64 {
        return Err(TailError::NoTail);
    }
    r.seek(SeekFrom::Start(file_len - TRAILER_LEN as u64))?;
    let mut t = [0u8; TRAILER_LEN];
    r.read_exact(&mut t)?;
    if &t[120..128] != END_MAGIC || &t[0..8] != MAGIC {
        return Err(TailError::NoTail);
    }
    let version = u32_at(&t, 8);
    if version != FORMAT_VERSION {
        return Err(TailError::UnsupportedVersion(version));
    }
    let payload_offset = u64_at(&t, 16);
    let payload_len = u64_at(&t, 24);
    let install_bytes = u64_at(&t, 32);
    let meta_len = u32_at(&t, 40);
    if meta_len == 0 || meta_len > MAX_META_LEN {
        return Err(TailError::BadMeta);
    }
    let total = payload_offset
        .checked_add(payload_len)
        .and_then(|v| v.checked_add(meta_len as u64))
        .and_then(|v| v.checked_add(TRAILER_LEN as u64))
        .ok_or(TailError::BadBounds)?;
    if payload_len == 0 {
        return Err(TailError::BadBounds);
    }
    if total > file_len {
        return Err(TailError::Truncated);
    }
    if total != file_len {
        return Err(TailError::BadBounds);
    }
    let meta_at = payload_offset + payload_len;
    r.seek(SeekFrom::Start(meta_at))?;
    let mut meta_bytes = vec![0u8; meta_len as usize];
    r.read_exact(&mut meta_bytes)?;
    if check_of(&meta_bytes, &t)[..] != t[80..112] {
        return Err(TailError::BadCheck);
    }
    let v: Value = serde_json::from_slice(&meta_bytes).map_err(|_| TailError::BadMeta)?;
    let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_owned).ok_or(TailError::BadMeta);
    let meta = Meta { product: s("product")?, version: s("version")?, payload_name: s("payloadName")?, built_at: s("builtAt")? };
    // имя payload попадает в путь: только безопасные символы
    if meta.payload_name.is_empty()
        || meta.payload_name.len() > 80
        || !meta.payload_name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        || meta.payload_name.starts_with('.')
    {
        return Err(TailError::BadMeta);
    }
    let mut payload_sha256 = [0u8; 32];
    payload_sha256.copy_from_slice(&t[48..80]);
    Ok(Tail { payload_offset, payload_len, install_bytes, payload_sha256, meta })
}

/// Если файл подписан Authenticode (запись IMAGE_DIRECTORY_ENTRY_SECURITY указывает на сертификат,
/// лежащий строго в конце файла), возвращает смещение начала сертификата: хвост лежит перед ним.
/// При любой неопределённости (не PE, обрезанный заголовок, сертификат не в конце) возвращает `file_len`.
fn effective_len<R: Read + Seek>(r: &mut R, file_len: u64) -> u64 {
    let probe = |r: &mut R| -> Option<u64> {
        let mut dos = [0u8; 64];
        r.seek(SeekFrom::Start(0)).ok()?;
        r.read_exact(&mut dos).ok()?;
        if &dos[0..2] != b"MZ" {
            return None;
        }
        let pe = u32_at(&dos, 0x3C) as u64;
        // сигнатура(4) + COFF(20) + optional PE32+ до каталога 4 (112 + 5*8)
        let mut h = [0u8; 4 + 20 + 112 + 40];
        r.seek(SeekFrom::Start(pe)).ok()?;
        r.read_exact(&mut h).ok()?;
        if h[0..4] != [b'P', b'E', 0, 0] {
            return None;
        }
        let magic = u16::from_le_bytes([h[24], h[25]]);
        let dirs = match magic {
            0x20b => 24 + 112,
            0x10b => 24 + 96,
            _ => return None,
        };
        let at = dirs + 4 * 8;
        if at + 8 > h.len() {
            return None;
        }
        let off = u32_at(&h, at) as u64;
        let size = u32_at(&h, at + 4) as u64;
        (size > 0 && off > 0 && off.checked_add(size) == Some(file_len)).then_some(off)
    };
    probe(r).unwrap_or(file_len)
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn sample(stub: usize, payload: &[u8]) -> (Vec<u8>, Tail) {
        let sha: [u8; 32] = Sha256::digest(payload).into();
        let tail = Tail {
            payload_offset: stub as u64,
            payload_len: payload.len() as u64,
            install_bytes: 123_456_789,
            payload_sha256: sha,
            meta: Meta { product: "Sennit".into(), version: "1.7.1".into(), payload_name: "Sennit-Payload-1.7.1.exe".into(), built_at: "2026-10-08T00:00:00Z".into() },
        };
        let mut file = vec![0x4du8; stub];
        file.extend_from_slice(payload);
        file.extend_from_slice(&encode(&tail));
        (file, tail)
    }

    #[test]
    fn round_trip() {
        let (file, tail) = sample(1000, b"payload bytes here");
        assert_eq!(read(&mut Cursor::new(&file)).unwrap(), tail);
    }

    /// Минимальный PE32+ заголовок с записью каталога безопасности (offset/size).
    fn fake_pe_head(stub_len: usize, cert: Option<(u32, u32)>) -> Vec<u8> {
        let mut s = vec![0u8; stub_len];
        s[0] = b'M';
        s[1] = b'Z';
        let pe = 0x80usize;
        s[0x3C..0x40].copy_from_slice(&(pe as u32).to_le_bytes());
        s[pe..pe + 4].copy_from_slice(&[b'P', b'E', 0, 0]);
        s[pe + 24..pe + 26].copy_from_slice(&0x20bu16.to_le_bytes());
        if let Some((off, size)) = cert {
            let at = pe + 24 + 112 + 4 * 8;
            s[at..at + 4].copy_from_slice(&off.to_le_bytes());
            s[at + 4..at + 8].copy_from_slice(&size.to_le_bytes());
        }
        s
    }

    #[test]
    fn signed_file_with_certificate_after_tail_is_accepted() {
        let payload = b"signed payload";
        let sha: [u8; 32] = Sha256::digest(payload).into();
        let stub_len = 1024usize;
        let tail = Tail {
            payload_offset: stub_len as u64,
            payload_len: payload.len() as u64,
            install_bytes: 7,
            payload_sha256: sha,
            meta: Meta { product: "Sennit".into(), version: "1.7.1".into(), payload_name: "p.exe".into(), built_at: "t".into() },
        };
        let body_len = stub_len + payload.len() + encode(&tail).len();
        let cert = vec![0xC5u8; 56];
        let mut file = fake_pe_head(stub_len, Some((body_len as u32, cert.len() as u32)));
        file.extend_from_slice(payload);
        file.extend_from_slice(&encode(&tail));
        file.extend_from_slice(&cert);
        assert_eq!(read(&mut Cursor::new(&file)).unwrap(), tail);
        // сертификат есть в заголовке, но файл на самом деле короче/длиннее: запись игнорируется, размеры не сходятся
        let mut wrong = fake_pe_head(stub_len, Some((body_len as u32 + 1, cert.len() as u32)));
        wrong.extend_from_slice(payload);
        wrong.extend_from_slice(&encode(&tail));
        wrong.extend_from_slice(&cert);
        assert!(read(&mut Cursor::new(&wrong)).is_err());
        // подписи нет, а мусор после хвоста: отвергается как раньше
        let mut junk = fake_pe_head(stub_len, None);
        junk.extend_from_slice(payload);
        junk.extend_from_slice(&encode(&tail));
        junk.extend_from_slice(&cert);
        assert!(read(&mut Cursor::new(&junk)).is_err());
        // без подписи работает как раньше
        let mut plain = fake_pe_head(stub_len, None);
        plain.extend_from_slice(payload);
        plain.extend_from_slice(&encode(&tail));
        assert_eq!(read(&mut Cursor::new(&plain)).unwrap(), tail);
    }

    #[test]
    fn plain_exe_has_no_tail() {
        let file = vec![0u8; 5000];
        assert_eq!(read(&mut Cursor::new(&file)), Err(TailError::NoTail));
        assert_eq!(read(&mut Cursor::new(&[1u8, 2, 3][..])), Err(TailError::NoTail));
    }

    #[test]
    fn truncated_file_is_rejected() {
        let (file, _) = sample(1000, &[7u8; 4096]);
        // отрезали хвост: сигнатуры больше нет
        assert_eq!(read(&mut Cursor::new(&file[..file.len() - 1])), Err(TailError::NoTail));
        // отрезали голову: хвост цел, но размеры больше файла
        assert_eq!(read(&mut Cursor::new(&file[200..])), Err(TailError::Truncated));
    }

    #[test]
    fn extra_bytes_before_trailer_are_rejected() {
        let (mut file, _) = sample(10, b"abc");
        // вставка байта в payload сдвигает meta и ломает точную арифметику размеров
        file.insert(12, 0);
        assert!(matches!(read(&mut Cursor::new(&file)), Err(TailError::BadBounds | TailError::BadCheck | TailError::BadMeta)));
    }

    #[test]
    fn meta_corruption_is_caught_by_check() {
        let (mut file, tail) = sample(64, b"0123456789");
        let meta_at = (tail.payload_offset + tail.payload_len) as usize;
        file[meta_at + 5] ^= 0x01;
        assert!(matches!(read(&mut Cursor::new(&file)), Err(TailError::BadCheck | TailError::BadMeta)));
    }

    #[test]
    fn trailer_field_corruption_is_caught() {
        let (mut file, _) = sample(64, b"0123456789");
        let n = file.len();
        file[n - TRAILER_LEN + 32] ^= 0x10; // install_bytes
        assert_eq!(read(&mut Cursor::new(&file)), Err(TailError::BadCheck));
    }

    #[test]
    fn unsupported_version() {
        let (mut file, _) = sample(64, b"0123456789");
        let n = file.len();
        file[n - TRAILER_LEN + 8] = 9;
        assert_eq!(read(&mut Cursor::new(&file)), Err(TailError::UnsupportedVersion(9)));
    }

    #[test]
    fn unsafe_payload_name_is_rejected() {
        let mut t = sample(8, b"x").1;
        t.meta.payload_name = "..\\evil.exe".into();
        let mut file = vec![0u8; 8];
        file.extend_from_slice(b"x");
        file.extend_from_slice(&encode(&t));
        assert_eq!(read(&mut Cursor::new(&file)), Err(TailError::BadMeta));
    }

    #[test]
    fn hex_is_lowercase() {
        assert_eq!(hex(&[0, 15, 255]), "000fff");
    }
}
