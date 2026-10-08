//! Ход установки: проверки, проверка целостности payload, распаковка, запуск NSIS `/S`, итог.
//!
//! Ничего не запускается, кроме извлечённого NSIS-установщика с проверенным SHA-256
//! (и, по желанию пользователя, установленного Sennit). Сети нет.

use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::io::AsRawHandle;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU8, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::preflight::{self, Cause};
use crate::progress::{self, format_mb, InstallProgress, Stage, StallDetector};
use crate::tail::{self, Tail};
use crate::util::{self, Log};
use crate::win;

pub const PRODUCT_DIR_NAME: &str = "Egoist Relay";
pub const MAIN_EXE: &str = "Egoist Relay.exe";
const UNINSTALL_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall\Egoist Relay";
const STAGES_TOTAL: u32 = 4;
const CHUNK: usize = 4 * 1024 * 1024;
/// Сколько секунд NSIS может ничего не писать, прежде чем разрешить прервать (WebView2 и антивирус бывают медленными).
const STALL_SECS: f64 = StallDetector::DEFAULT_SECS;

/// Подсказка про WebView2: при Runtime старше требуемого NSIS ставит его сам, это дольше и чаще падает.
fn webview_note() -> String {
    match win::webview2_version() {
        Some(v) if preflight::compare_versions(&v, "143.0.0.0") == std::cmp::Ordering::Less => {
            format!(" Установлен Microsoft Edge WebView2 {v}, нужна 143 или новее: установщик обновляет его сам, это долго и может не получиться. Обновите Edge WebView2 Runtime и повторите.")
        }
        _ => String::new(),
    }
}

pub trait Sink: Send + Sync {
    fn emit(&self, event: Value);
}

/// Фаза для окна: можно ли закрыть/отменить.
pub const PHASE_IDLE: u8 = 0;
pub const PHASE_CANCELABLE: u8 = 1;
/// NSIS уже пишет файлы: закрывать нельзя, пока он не завершится.
pub const PHASE_LOCKED: u8 = 2;

pub struct Shared {
    pub cancel: AtomicBool,
    pub phase: AtomicU8,
    pub running: AtomicBool,
    /// NSIS не продвигается дольше порога: окно разблокирует «Прервать».
    pub stalled: AtomicBool,
    /// Код выхода процесса по последнему исходу (0 успех, 1 отмена/не начинали, иначе код ошибки).
    pub last_exit: AtomicI32,
    /// Каталог, куда установлен Sennit (после успеха; для кнопки «Запустить»).
    pub final_dir: std::sync::Mutex<Option<PathBuf>>,
}

impl Shared {
    pub fn new() -> Arc<Shared> {
        Arc::new(Shared {
            cancel: AtomicBool::new(false),
            phase: AtomicU8::new(PHASE_IDLE),
            running: AtomicBool::new(false),
            stalled: AtomicBool::new(false),
            last_exit: AtomicI32::new(1),
            final_dir: std::sync::Mutex::new(None),
        })
    }
}

#[derive(Clone)]
pub struct Options {
    pub silent: bool,
    pub launch_after: bool,
    /// Запасной режим без WebView2: штатный мастер NSIS вместо `/S`.
    pub nsis_gui: bool,
}

pub struct Context {
    pub exe_path: PathBuf,
    pub tail: Tail,
    pub sink: Arc<dyn Sink>,
    pub log: Arc<Log>,
    pub shared: Arc<Shared>,
}

#[derive(Debug, Clone)]
pub struct Failure {
    pub code: &'static str,
    pub title: String,
    pub message: String,
    pub hint: String,
    pub exit: i32,
    pub retry: bool,
}

pub const EXIT_PAYLOAD: i32 = 10;
pub const EXIT_SPACE: i32 = 11;
pub const EXIT_APP_RUNNING: i32 = 12;
pub const EXIT_NSIS: i32 = 13;
pub const EXIT_PREFLIGHT: i32 = 14;
pub const EXIT_INTERNAL: i32 = 15;

impl Failure {
    fn new(code: &'static str, exit: i32, title: &str, message: String, hint: &str) -> Failure {
        Failure { code, title: title.into(), message, hint: hint.into(), exit, retry: true }
    }
    pub fn no_payload() -> Failure {
        Failure {
            code: "SETUP-NO-PAYLOAD",
            exit: EXIT_PAYLOAD,
            title: "В этом файле нет установочных данных".into(),
            message: "Это сборка установщика для разработки: встроенного пакета нет.".into(),
            hint: "Для просмотра интерфейса запустите с ключом --demo. Рабочий установщик собирает scripts/build-installer.mjs.".into(),
            retry: false,
        }
    }
    fn internal(text: &str) -> Failure {
        Failure::new("SETUP-INTERNAL", EXIT_INTERNAL, "Внутренняя ошибка установщика", text.into(), "Нажмите «Показать журнал» и сохраните его. Повторная попытка безопасна.")
    }
    fn io(code: &'static str, what: &str, err: &std::io::Error) -> Failure {
        let os = err.raw_os_error().unwrap_or(0);
        match preflight::classify_os_error(os) {
            Cause::Antivirus => Failure::new(
                "SETUP-ANTIVIRUS",
                EXIT_NSIS,
                "Антивирус заблокировал файл",
                format!("{what}: Windows сообщила о заражённом или удалённом файле (код {os})."),
                "Добавьте установщик Sennit в исключения антивируса или временно отключите проверку, затем нажмите «Повторить».",
            ),
            Cause::AccessDenied => Failure::new(
                "SETUP-ACCESS",
                EXIT_NSIS,
                "Нет доступа к файлу",
                format!("{what}: отказано в доступе (код {os})."),
                "Файл занят другой программой или защищён. Закройте программы, которые могут им пользоваться (в том числе антивирус), и нажмите «Повторить».",
            ),
            Cause::DiskFull => Failure::new("SETUP-DISK", EXIT_SPACE, "Закончилось место на диске", format!("{what}: на диске нет свободного места (код {os})."), "Освободите место и нажмите «Повторить»."),
            _ => Failure::new(code, EXIT_INTERNAL, "Не удалось подготовить установку", format!("{what}: {err} (код {os})."), "Нажмите «Показать журнал» и сохраните его. Повторная попытка безопасна."),
        }
    }
}

pub enum Outcome {
    Done { install_dir: PathBuf, version: String, updated: bool, launched: bool },
    Canceled,
}

/// Состояние существующей установки.
#[derive(Debug, Clone, Default)]
pub struct Existing {
    pub dir: Option<PathBuf>,
    pub version: Option<String>,
}

pub fn existing_install() -> Existing {
    let dir = win::reg_read_string(win::Hive::CurrentUser, UNINSTALL_KEY, "InstallLocation")
        .map(|s| preflight::unquote_install_location(&s))
        .filter(|s| !s.is_empty())
        .map(PathBuf::from);
    let version = win::reg_read_string(win::Hive::CurrentUser, UNINSTALL_KEY, "DisplayVersion").filter(|v| !v.trim().is_empty());
    Existing { dir, version }
}

/// Куда NSIS будет ставить: прежняя папка либо `%LOCALAPPDATA%\Egoist Relay` (режим currentUser).
pub fn target_dir(existing: &Existing) -> PathBuf {
    if let Some(d) = &existing.dir {
        return d.clone();
    }
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(|| std::env::temp_dir());
    base.join(PRODUCT_DIR_NAME)
}

struct Runner<'a> {
    ctx: &'a Context,
    opts: &'a Options,
    last_emit: Instant,
}

impl<'a> Runner<'a> {
    fn log(&self, s: &str) {
        self.ctx.log.line(s);
    }
    fn emit(&self, v: Value) {
        self.ctx.sink.emit(v);
    }
    fn canceled(&self) -> bool {
        self.ctx.shared.cancel.load(Ordering::SeqCst)
    }
    fn stage(&self, index: u32, label: &str, detail: &str) {
        self.log(&format!("этап {index}/{STAGES_TOTAL}: {label}. {detail}"));
        self.emit(json!({"t":"stage","i":index,"n":STAGES_TOTAL,"label":label,"detail":detail}));
    }
    fn progress(&mut self, v: f64, detail: &str, force: bool) {
        if !force && self.last_emit.elapsed() < Duration::from_millis(90) {
            return;
        }
        self.last_emit = Instant::now();
        self.emit(json!({"t":"progress","v":v,"detail":detail}));
    }
}

fn is_cancel_phase(shared: &Shared) {
    shared.phase.store(PHASE_CANCELABLE, Ordering::SeqCst);
}

pub fn run(ctx: &Context, opts: &Options) -> Result<Outcome, Failure> {
    let mut r = Runner { ctx, opts, last_emit: Instant::now() - Duration::from_secs(1) };
    ctx.shared.cancel.store(false, Ordering::SeqCst);
    ctx.shared.stalled.store(false, Ordering::SeqCst);
    is_cancel_phase(&ctx.shared);
    let result = r.run_inner();
    ctx.shared.phase.store(PHASE_IDLE, Ordering::SeqCst);
    result
}

impl<'a> Runner<'a> {
    fn run_inner(&mut self) -> Result<Outcome, Failure> {
        let tail = &self.ctx.tail;
        let payload_len = tail.payload_len;
        self.log(&format!("Sennit Setup {}: payload {} байт, ожидаемый размер установки {} байт", tail.meta.version, payload_len, tail.install_bytes));

        // ---- Этап 1: система и целостность ----
        self.stage(1, "Проверка системы", "Windows, свободное место, запущенное приложение");
        self.progress(0.0, "", true);
        let existing = existing_install();
        let install_dir = target_dir(&existing);
        let app_exe = install_dir.join(MAIN_EXE);
        self.log(&format!("каталог установки: {} (существующая версия: {:?})", install_dir.display(), existing.version));
        self.log(&format!("WebView2: {:?}; Windows build: {:?}", win::webview2_version(), win::windows_build()));
        self.preflight(&existing, &install_dir)?;
        if self.canceled() {
            return Ok(Outcome::Canceled);
        }
        if !self.wait_app_closed(&app_exe)? {
            return Ok(Outcome::Canceled);
        }

        self.stage(1, "Проверка целостности", "Сверяем контрольную сумму встроенного пакета");
        let mut src = File::open(&self.ctx.exe_path).map_err(|e| Failure::io("SETUP-OPEN", "Не удалось открыть файл установщика", &e))?;
        src.seek(SeekFrom::Start(tail.payload_offset)).map_err(|e| Failure::io("SETUP-OPEN", "Не удалось прочитать файл установщика", &e))?;
        let total = payload_len;
        let mut done = 0u64;
        let mut cancel = false;
        let hash = hash_stream(&mut src, total, |n| {
            done = n;
            let w = progress::overall(Stage::Verify, n as f64 / total as f64);
            self.progress(w, &format!("{} из {}", format_mb(n), format_mb(total)), false);
            cancel = self.canceled();
            !cancel
        })
        .map_err(|e| Failure::io("SETUP-READ", "Не удалось прочитать встроенный пакет", &e))?;
        if cancel {
            return Ok(Outcome::Canceled);
        }
        if hash != tail.payload_sha256 {
            self.log(&format!("SHA-256 не совпал: ожидалось {}, получено {}", tail::hex(&tail.payload_sha256), tail::hex(&hash)));
            return Err(Failure::new(
                "SETUP-HASH",
                EXIT_PAYLOAD,
                "Установщик повреждён",
                "Контрольная сумма встроенного пакета не совпала. Файл скачан не полностью или изменён.".into(),
                "Скачайте установщик заново. Ничего не было установлено.",
            )
            .no_retry());
        }
        self.log("целостность payload подтверждена");
        self.progress(progress::overall(Stage::Verify, 1.0), "", true);

        // ---- Этап 2: распаковка во временную папку ----
        self.stage(2, "Подготовка файлов", "Распаковка во временную папку");
        let temp_root = std::env::temp_dir();
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let tmp_dir = temp_root.join(format!("Sennit-Setup-{}-{:x}", std::process::id(), nanos));
        win::create_private_dir(&tmp_dir).map_err(|e| Failure::io("SETUP-TEMP", "Не удалось создать временную папку", &e))?;
        self.log(&format!("временная папка: {}", tmp_dir.display()));
        let mut guard = TempGuard { dir: tmp_dir.clone(), lock: None, child: None };
        let payload_path = tmp_dir.join(&tail.meta.payload_name);

        src.seek(SeekFrom::Start(tail.payload_offset)).map_err(|e| Failure::io("SETUP-READ", "Не удалось прочитать встроенный пакет", &e))?;
        let mut out = OpenOptions::new().write(true).create_new(true).open(&payload_path).map_err(|e| Failure::io("SETUP-TEMP", "Не удалось создать файл установщика", &e))?;
        let mut written_hash = Sha256::new();
        let mut buf = vec![0u8; CHUNK];
        let mut left = total;
        let mut copied = 0u64;
        while left > 0 {
            if self.canceled() {
                return Ok(Outcome::Canceled);
            }
            let want = left.min(CHUNK as u64) as usize;
            src.read_exact(&mut buf[..want]).map_err(|e| Failure::io("SETUP-READ", "Не удалось прочитать встроенный пакет", &e))?;
            out.write_all(&buf[..want]).map_err(|e| Failure::io("SETUP-WRITE", "Не удалось записать файл во временную папку", &e))?;
            written_hash.update(&buf[..want]);
            left -= want as u64;
            copied += want as u64;
            let w = progress::overall(Stage::Prepare, 0.92 * copied as f64 / total as f64);
            self.progress(w, &format!("{} из {}", format_mb(copied), format_mb(total)), false);
        }
        out.flush().map_err(|e| Failure::io("SETUP-WRITE", "Не удалось записать файл во временную папку", &e))?;
        drop(out);
        let written: [u8; 32] = written_hash.finalize().into();
        if written != tail.payload_sha256 {
            self.log("хэш записанного файла не совпал с хэшем payload");
            return Err(Failure::internal("Записанный во временную папку файл не совпал с проверенным пакетом."));
        }
        // Читающий дескриптор без права записи/удаления для других: файл нельзя подменить, пока он у нас.
        let mut lock = OpenOptions::new().read(true).share_mode(1).open(&payload_path).map_err(|e| Failure::io("SETUP-TEMP", "Не удалось открыть распакованный файл (возможно, его проверяет антивирус)", &e))?;
        let relock = hash_stream(&mut lock, total, |_| true).map_err(|e| Failure::io("SETUP-READ", "Не удалось перечитать распакованный файл", &e))?;
        if relock != tail.payload_sha256 {
            self.log("распакованный файл изменился между записью и блокировкой");
            return Err(Failure::new("SETUP-TAMPER", EXIT_PAYLOAD, "Временный файл изменён", "Распакованный файл не совпал с проверенным.".into(), "Закройте программы, которые могут менять временные файлы (антивирус), и нажмите «Повторить»."));
        }
        guard.lock = Some(lock);
        drop(src);
        self.log("payload распакован и заблокирован от изменений");
        self.progress(progress::overall(Stage::Prepare, 1.0), "", true);
        if self.canceled() {
            return Ok(Outcome::Canceled);
        }
        // Последняя возможность закрыть Sennit до записи файлов.
        if !self.wait_app_closed(&app_exe)? {
            return Ok(Outcome::Canceled);
        }

        // ---- Этап 3: NSIS ----
        self.ctx.shared.phase.store(PHASE_LOCKED, Ordering::SeqCst);
        self.stage(3, "Установка файлов", "Запись файлов, ярлыки, запись в «Приложения и возможности»");
        let mut cmd = Command::new(&payload_path);
        if !self.opts.nsis_gui {
            cmd.arg("/S");
        }
        cmd.current_dir(&tmp_dir).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).creation_flags(0);
        // Ребёнок живёт в TempGuard: при любом выходе (ошибка, паника) guard дождётся NSIS и только потом удалит папку.
        let spawned = cmd.spawn().map_err(|e| Failure::io("SETUP-SPAWN", "Не удалось запустить установщик NSIS", &e))?;
        self.log(&format!("NSIS запущен (pid {}), аргументы: {}", spawned.id(), if self.opts.nsis_gui { "(штатный мастер)" } else { "/S" }));
        guard.child = Some(spawned);
        let mut tracker = InstallProgress::new(tail.install_bytes);
        let mut stall = StallDetector::new(STALL_SECS);
        let mut last_dir_check = Instant::now() - Duration::from_secs(2);
        let mut dir_bytes = 0u64;
        let started = Instant::now();
        let mut stall_reported = false;
        let code = loop {
            let child = guard.child.as_mut().expect("NSIS запущен");
            match child.try_wait() {
                Ok(Some(status)) => break status.code().unwrap_or(-1),
                Ok(None) => {}
                Err(e) => return Err(Failure::io("SETUP-WAIT", "Не удалось дождаться установщика NSIS", &e)),
            }
            if last_dir_check.elapsed() >= Duration::from_millis(1000) {
                dir_bytes = util::dir_size(&install_dir);
                last_dir_check = Instant::now();
            }
            let written_io = win::process_bytes_written(child.as_raw_handle()).unwrap_or(0);
            if stall.update(written_io, dir_bytes, started.elapsed().as_secs_f64()) {
                if !stall_reported {
                    stall_reported = true;
                    self.log("NSIS не продвигается: разблокируем «Прервать»");
                    self.ctx.shared.stalled.store(true, Ordering::SeqCst);
                    self.emit(json!({"t":"stalled"}));
                }
                if self.canceled() {
                    self.log("пользователь прервал зависший NSIS: завершаем процесс");
                    let _ = child.kill();
                    let _ = child.wait();
                    guard.child = None;
                    return Err(Failure::new(
                        "SETUP-NSIS-STALL",
                        EXIT_NSIS,
                        "Установка прервана: не продвигалась",
                        "Установщик не записывал данные дольше пяти минут, процесс завершён по вашей просьбе.".into(),
                        "Файлы могли быть записаны частично. Нажмите «Повторить»: установка поверх безопасна и данные не затрагивает. Если повторяется, откройте журнал.",
                    ));
                }
            } else if stall_reported {
                stall_reported = false;
                self.ctx.shared.stalled.store(false, Ordering::SeqCst);
                self.emit(json!({"t":"unstalled"}));
            }
            let within = tracker.update(written_io, dir_bytes);
            let detail = if within <= 0.0 {
                "Запускаем установщик".to_string()
            } else {
                format!("Записано {} из ~{}", format_mb((within * tail.install_bytes as f64) as u64), format_mb(tail.install_bytes))
            };
            self.progress(progress::overall(Stage::Install, within), &detail, false);
            std::thread::sleep(Duration::from_millis(120));
        };
        self.log(&format!("NSIS завершился с кодом {code} за {:.1} с", started.elapsed().as_secs_f64()));
        // NSIS завершился; payload больше не нужен
        guard.child = None;
        drop(guard);

        if code != 0 {
            let low = win::free_space(&install_dir).map(|f| f < 64 * 1024 * 1024).unwrap_or(false);
            let cause = preflight::classify_exit(code, low);
            return Err(self.nsis_failure(code, cause, &install_dir));
        }

        // Проверка результата: NSIS мог вернуть 0, не поставив файлы.
        let after = existing_install();
        let final_dir = target_dir(&after);
        let exe = final_dir.join(MAIN_EXE);
        let version_ok = after.version.as_deref().map(|v| preflight::compare_versions(v, &tail.meta.version) != std::cmp::Ordering::Less).unwrap_or(false);
        if !exe.is_file() || !version_ok {
            self.log(&format!("проверка результата не прошла: exe={} версия в реестре={:?}", exe.is_file(), after.version));
            return Err(Failure::new(
                "SETUP-VERIFY",
                EXIT_NSIS,
                "Установка не подтвердилась",
                "Установщик сообщил об успехе, но файлы или запись о версии не найдены.".into(),
                &format!("Нажмите «Повторить». Если повторяется, откройте журнал: возможно, файлы удалил антивирус.{}", webview_note()),
            ));
        }
        self.progress(1.0, "", true);
        let updated = existing.version.is_some();

        // ---- Этап 4 ----
        self.stage(4, "Готово", "Sennit установлен");
        let mut launched = false;
        if self.opts.launch_after {
            match launch_app(&exe, &final_dir) {
                Ok(()) => {
                    launched = true;
                    self.log("Sennit запущен");
                }
                Err(e) => self.log(&format!("не удалось запустить Sennit: {e}")),
            }
        }
        Ok(Outcome::Done { install_dir: final_dir, version: tail.meta.version.clone(), updated, launched })
    }

    fn preflight(&self, existing: &Existing, install_dir: &Path) -> Result<(), Failure> {
        let tail = &self.ctx.tail;
        if let Some(build) = win::windows_build() {
            if build < preflight::MIN_WINDOWS_BUILD {
                return Err(Failure::new(
                    "SETUP-OS",
                    EXIT_PREFLIGHT,
                    "Windows слишком старая",
                    format!("Sennit требует Windows 10 версии 1903 (сборка {}) или новее. У вас сборка {build}.", preflight::MIN_WINDOWS_BUILD),
                    "Обновите Windows и запустите установщик снова.",
                )
                .no_retry());
            }
        }
        if let Some(v) = &existing.version {
            if preflight::compare_versions(v, &tail.meta.version) == std::cmp::Ordering::Greater {
                return Err(Failure::new(
                    "SETUP-DOWNGRADE",
                    EXIT_PREFLIGHT,
                    "Уже установлена более новая версия",
                    format!("Установлена версия {v}, этот установщик — {}.", tail.meta.version),
                    "Установка старой версии поверх новой остановлена, чтобы не повредить данные. Используйте установщик не ниже установленной версии.",
                )
                .no_retry());
            }
        }
        if preflight::install_dir_too_long(&install_dir.to_string_lossy()) {
            return Err(Failure::new(
                "SETUP-PATH",
                EXIT_PREFLIGHT,
                "Папка установки слишком длинная",
                format!("Путь длиннее {} символов: {}", preflight::MAX_INSTALL_DIR_CHARS, install_dir.display()),
                "Удалите текущую установку в «Приложениях и возможностях» и запустите установщик снова: он выберет стандартную папку.",
            )
            .no_retry());
        }
        let temp = std::env::temp_dir();
        let same = win::volume_root(&temp) == win::volume_root(install_dir);
        let need = preflight::space_needed(tail.payload_len, tail.install_bytes, same);
        for (path, need_bytes, what) in [(install_dir.to_path_buf(), need.install_volume, "для установки"), (temp.clone(), need.temp_volume, "для временных файлов")] {
            if let Some(free) = win::free_space(&path) {
                if free < need_bytes {
                    return Err(Failure::new(
                        "SETUP-SPACE",
                        EXIT_SPACE,
                        "Недостаточно места на диске",
                        format!("Нужно около {} {what} на диске {}, свободно {}.", format_mb(need_bytes), win::volume_root(&path), format_mb(free)),
                        "Освободите место и нажмите «Повторить».",
                    ));
                }
            }
        }
        Ok(())
    }

    /// Ждёт, пока не закроется Sennit из каталога установки. false — отмена.
    /// Принудительно не завершаем: активные аккаунты, как и в логике NSIS (installer-processes.ps1).
    fn wait_app_closed(&self, app_exe: &Path) -> Result<bool, Failure> {
        if !win::is_exe_running(app_exe) {
            return Ok(true);
        }
        if self.opts.silent {
            return Err(Failure::new(
                "SETUP-APP-RUNNING",
                EXIT_APP_RUNNING,
                "Sennit запущен",
                format!("Запущен {}.", app_exe.display()),
                "Закройте Sennit через меню значка в трее и запустите установщик снова.",
            ));
        }
        if self.opts.nsis_gui {
            // Запасной режим без окна: окно сообщения «Повторить / Отмена», без вечного ожидания.
            while win::is_exe_running(app_exe) {
                self.log("Sennit запущен (запасной режим): спрашиваем пользователя");
                if !win::retry_cancel_box("Sennit Setup", "Sennit запущен. Закройте его через меню значка в трее и нажмите «Повторить». Активные аккаунты не закрываются принудительно.") {
                    return Err(Failure::new(
                        "SETUP-APP-RUNNING",
                        EXIT_APP_RUNNING,
                        "Sennit запущен",
                        format!("Запущен {}.", app_exe.display()),
                        "Закройте Sennit через меню значка в трее и запустите установщик снова.",
                    ));
                }
            }
            return Ok(true);
        }
        self.log("Sennit запущен: ждём закрытия");
        self.emit(json!({"t":"need_close","running":true}));
        while win::is_exe_running(app_exe) {
            if self.canceled() {
                self.emit(json!({"t":"need_close","running":false}));
                return Ok(false);
            }
            std::thread::sleep(Duration::from_millis(500));
        }
        self.log("Sennit закрыт, продолжаем");
        self.emit(json!({"t":"need_close","running":false}));
        Ok(true)
    }

    fn nsis_failure(&self, code: i32, cause: Cause, install_dir: &Path) -> Failure {
        let tail_hint = "Нажмите «Показать журнал», чтобы сохранить подробности.";
        match cause {
            Cause::AppRunning => Failure::new("SETUP-APP-RUNNING", EXIT_APP_RUNNING, "Sennit запущен", "Установщик не смог заменить файлы работающего приложения.".into(), "Закройте Sennit через меню значка в трее и нажмите «Повторить»."),
            Cause::ScriptAbort => Failure::new(
                "SETUP-NSIS-1",
                EXIT_NSIS,
                "Установка остановлена проверками",
                "Установщик остановился на проверках: версия Windows, длина пути или более новая версия уже установлена.".into(),
                tail_hint,
            ),
            Cause::Antivirus => Failure::new("SETUP-ANTIVIRUS", EXIT_NSIS, "Антивирус заблокировал файл", format!("Установщик завершился с кодом {code}: Windows сообщила о заражённом или удалённом файле."), "Добавьте установщик Sennit в исключения антивируса и нажмите «Повторить»."),
            Cause::AccessDenied => Failure::new("SETUP-ACCESS", EXIT_NSIS, "Нет доступа к папке установки", format!("Не удалось записать файлы в {} (отказано в доступе).", install_dir.display()), "Закройте программы, которые используют файлы Sennit, и нажмите «Повторить»."),
            Cause::DiskFull => Failure::new("SETUP-DISK", EXIT_SPACE, "Закончилось место на диске", format!("Установщик завершился с кодом {code}, на диске почти нет места."), "Освободите место и нажмите «Повторить»."),
            Cause::Other => Failure::new("SETUP-NSIS", EXIT_NSIS, "Установщик завершился с ошибкой", format!("Код возврата NSIS: {code}."), &format!("{tail_hint}{}", webview_note())),
        }
    }
}

impl Failure {
    fn no_retry(mut self) -> Failure {
        self.retry = false;
        self
    }
}

/// Удаляет временную папку, когда объект уничтожается (в том числе при ошибке и панике).
struct TempGuard {
    dir: PathBuf,
    lock: Option<File>,
    /// Запущенный NSIS. Если guard уничтожается раньше его завершения (ошибка, паника), ждём процесс,
    /// а не удаляем файлы из-под него и не позволяем «Повторить» стартовать второй NSIS параллельно.
    /// Принудительно завершается только по явной отмене зависшего этапа (см. цикл ожидания).
    child: Option<std::process::Child>,
}

impl Drop for TempGuard {
    fn drop(&mut self) {
        if let Some(mut c) = self.child.take() {
            let _ = c.wait();
        }
        self.lock.take();
        util::remove_dir_retry(&self.dir);
    }
}

/// SHA-256 потока длиной `len`. `tick(n)` вызывается после каждого блока; `false` прерывает.
pub fn hash_stream<R: Read>(r: &mut R, len: u64, mut tick: impl FnMut(u64) -> bool) -> std::io::Result<[u8; 32]> {
    let mut h = Sha256::new();
    let mut buf = vec![0u8; CHUNK];
    let mut left = len;
    let mut done = 0u64;
    while left > 0 {
        let want = left.min(CHUNK as u64) as usize;
        r.read_exact(&mut buf[..want])?;
        h.update(&buf[..want]);
        left -= want as u64;
        done += want as u64;
        if !tick(done) {
            break;
        }
    }
    Ok(h.finalize().into())
}

pub fn launch_app(exe: &Path, dir: &Path) -> std::io::Result<()> {
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    Command::new(exe).current_dir(dir).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP).spawn().map(|_| ())
}

/// Проверка целостности без установки (`--verify`).
pub fn verify_only(exe_path: &Path) -> Result<(Tail, bool), String> {
    let mut f = File::open(exe_path).map_err(|e| e.to_string())?;
    let t = tail::read(&mut f).map_err(|e| e.to_string())?;
    f.seek(SeekFrom::Start(t.payload_offset)).map_err(|e| e.to_string())?;
    let h = hash_stream(&mut f, t.payload_len, |_| true).map_err(|e| e.to_string())?;
    let ok = h == t.payload_sha256;
    Ok((t, ok))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tail::{encode, Meta};
    use std::io::Cursor;

    #[test]
    fn hash_stream_matches_sha256_and_reports_progress() {
        let data: Vec<u8> = (0..(CHUNK * 2 + 123)).map(|i| (i % 251) as u8).collect();
        let mut ticks = Vec::new();
        let h = hash_stream(&mut Cursor::new(&data), data.len() as u64, |n| {
            ticks.push(n);
            true
        })
        .unwrap();
        let want: [u8; 32] = Sha256::digest(&data).into();
        assert_eq!(h, want);
        assert_eq!(ticks, vec![CHUNK as u64, 2 * CHUNK as u64, data.len() as u64]);
    }

    #[test]
    fn hash_stream_can_be_cancelled() {
        let data = vec![1u8; CHUNK * 3];
        let mut calls = 0;
        hash_stream(&mut Cursor::new(&data), data.len() as u64, |_| {
            calls += 1;
            false
        })
        .unwrap();
        assert_eq!(calls, 1);
    }

    #[test]
    fn hash_stream_fails_on_short_input() {
        let data = vec![1u8; 10];
        assert!(hash_stream(&mut Cursor::new(&data), 20, |_| true).is_err());
    }

    fn write_sfx(path: &Path, payload: &[u8], corrupt: bool) -> Tail {
        let stub = vec![0x90u8; 777];
        let sha: [u8; 32] = Sha256::digest(payload).into();
        let t = Tail {
            payload_offset: stub.len() as u64,
            payload_len: payload.len() as u64,
            install_bytes: 4242,
            payload_sha256: sha,
            meta: Meta { product: "Sennit".into(), version: "1.7.1".into(), payload_name: "p.exe".into(), built_at: "2026-10-08T00:00:00Z".into() },
        };
        let mut body = payload.to_vec();
        if corrupt {
            body[3] ^= 0xFF;
        }
        let mut f = File::create(path).unwrap();
        f.write_all(&stub).unwrap();
        f.write_all(&body).unwrap();
        f.write_all(&encode(&t)).unwrap();
        t
    }

    #[test]
    fn verify_only_accepts_good_and_rejects_corrupt_payload() {
        let dir = std::env::temp_dir().join(format!("sennit-test-verify-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let payload: Vec<u8> = (0..100_000).map(|i| (i * 7 % 256) as u8).collect();
        write_sfx(&dir.join("good.exe"), &payload, false);
        write_sfx(&dir.join("bad.exe"), &payload, true);
        let (t, ok) = verify_only(&dir.join("good.exe")).unwrap();
        assert!(ok);
        assert_eq!(t.payload_len, 100_000);
        let (_, ok) = verify_only(&dir.join("bad.exe")).unwrap();
        assert!(!ok);
        std::fs::write(dir.join("plain.exe"), vec![0u8; 5000]).unwrap();
        assert!(verify_only(&dir.join("plain.exe")).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// Файл, открытый нашим «замком» (чтение, без записи/удаления для других), всё равно запускается,
    /// но его нельзя подменить или удалить, пока замок у нас.
    #[test]
    fn locked_payload_runs_but_cannot_be_replaced() {
        let dir = std::env::temp_dir().join(format!("sennit-test-lock-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let system = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
        let target = dir.join("who.exe");
        std::fs::copy(system.join("System32").join("whoami.exe"), &target).unwrap();
        let lock = OpenOptions::new().read(true).share_mode(1).open(&target).unwrap();
        assert!(OpenOptions::new().write(true).open(&target).is_err(), "запись должна быть запрещена");
        assert!(std::fs::remove_file(&target).is_err(), "удаление должно быть запрещено");
        let out = Command::new(&target).arg("/?").output().expect("запуск заблокированного exe");
        assert!(out.status.code().is_some());
        drop(lock);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn private_dir_is_created_once() {
        let dir = std::env::temp_dir().join(format!("sennit-test-acl-{}", std::process::id()));
        win::create_private_dir(&dir).unwrap();
        assert!(dir.is_dir());
        std::fs::write(dir.join("f"), b"x").unwrap();
        assert!(win::create_private_dir(&dir).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
