//! Установка Бересты: фирменный установщик Бересты.
//!
//! Self-extracting оболочка: exe + payload (готовый NSIS-установщик Tauri) + хвост (см. `tail.rs`).
//! Окно — tao + wry (WebView2), без стандартных окон NSIS. Установку выполняет проверенный
//! NSIS-установщик в тихом режиме `/S`; здесь — интерфейс, проверки, прогресс и итог.
//!
//! Ключи: `--silent` (без окна), `--launch` (с --silent: запустить после установки),
//! `--no-launch` (в окне: опция «Запустить после установки» выключена), `--verify` (проверить payload и выйти),
//! `--demo[=full|fail|running-flow|welcome|verify|prepare|progress|error|running|done]` (интерфейс без payload),
//! `--theme=dark|light`, `--exit-after=<сек>`, `--autostart` (с --demo: сразу «Установить») — для автоматических проверок.

#![cfg_attr(not(test), windows_subsystem = "windows")]

mod demo;
mod engine;
mod preflight;
mod progress;
mod tail;
mod ui;
mod util;
mod win;

use std::fs::File;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;

use serde_json::Value;

use engine::{Context, Options, Outcome, Shared, Sink};

#[derive(Debug, Default, PartialEq, Eq)]
struct Args {
    silent: bool,
    verify: bool,
    demo: Option<String>,
    theme: Option<String>,
    exit_after: Option<u64>,
    launch: Option<bool>,
    /// `--wait-app=<сек>`: в тихом режиме ждать закрытия работающей Бересты (0 — не ждать).
    wait_app: u64,
    autostart: bool,
    unknown: Vec<String>,
}

/// Предел `--wait-app`: дольше ждать установщику незачем.
const MAX_WAIT_APP_SECS: u64 = 600;

fn parse_args<I: IntoIterator<Item = String>>(iter: I) -> Args {
    let mut a = Args::default();
    for raw in iter {
        let lower = raw.to_lowercase();
        match lower.as_str() {
            "--silent" | "/s" | "-s" | "--quiet" => a.silent = true,
            "--verify" => a.verify = true,
            "--launch" => a.launch = Some(true),
            "--no-launch" => a.launch = Some(false),
            "--demo" => a.demo = Some(String::new()),
            "--autostart" => a.autostart = true,
            _ => {
                if let Some(v) = lower.strip_prefix("--demo=") {
                    a.demo = Some(v.to_string());
                } else if let Some(v) = lower.strip_prefix("--theme=") {
                    a.theme = Some(v.to_string());
                } else if let Some(v) = lower.strip_prefix("--wait-app=") {
                    // Без числа ключ считается неизвестным, а не молча нулевым.
                    match v.parse::<u64>() {
                        Ok(n) => a.wait_app = n.min(MAX_WAIT_APP_SECS),
                        Err(_) => a.unknown.push(raw),
                    }
                } else if let Some(v) = lower.strip_prefix("--exit-after=") {
                    a.exit_after = v.parse().ok();
                } else {
                    a.unknown.push(raw);
                }
            }
        }
    }
    a
}

fn main() {
    // Первым делом: дальнейшие загрузки DLL только из System32 (exe лежит в Загрузках, рядом может быть что угодно).
    win::restrict_dll_search();
    std::process::exit(real_main());
}

struct ConsoleSink {
    out: std::sync::Mutex<Option<File>>,
    log: Arc<util::Log>,
    last_pct: std::sync::atomic::AtomicI64,
}

impl Sink for ConsoleSink {
    fn emit(&self, e: Value) {
        let kind = e.get("t").and_then(Value::as_str).unwrap_or("");
        let line = match kind {
            "stage" => Some(format!("[{}/{}] {}", e["i"], e["n"], e["label"].as_str().unwrap_or(""))),
            "progress" => {
                let pct = (e["v"].as_f64().unwrap_or(0.0) * 100.0) as i64;
                let last = self.last_pct.load(std::sync::atomic::Ordering::Relaxed);
                if pct / 10 != last / 10 {
                    self.last_pct.store(pct, std::sync::atomic::Ordering::Relaxed);
                    Some(format!("    {pct}%"))
                } else {
                    None
                }
            }
            "need_close" => Some("Закройте Бересту через значок в трее".to_string()),
            _ => None,
        };
        if let Some(l) = line {
            self.log.line(&l);
            if let Ok(mut g) = self.out.lock() {
                if let Some(f) = g.as_mut() {
                    let _ = writeln!(f, "{l}");
                }
            }
        }
    }
}

fn real_main() -> i32 {
    let args = parse_args(std::env::args().skip(1));
    let exe_path = match std::env::current_exe() {
        Ok(p) => p,
        Err(_) => return engine::EXIT_INTERNAL,
    };
    let console = if args.silent || args.verify { win::attach_parent_console() } else { None };
    let say = |text: &str| {
        if let Some(c) = &console {
            let mut c = c;
            let _ = writeln!(c, "{text}");
        }
    };

    let tail_result = File::open(&exe_path).map_err(|e| tail::TailError::Io(e.to_string())).and_then(|mut f| tail::read(&mut f));

    if args.verify {
        return match engine::verify_only(&exe_path) {
            Ok((t, true)) => {
                say(&format!("OK: Береста {} payload {} байт, SHA-256 {}", t.meta.version, t.payload_len, tail::hex(&t.payload_sha256)));
                0
            }
            Ok((_, false)) => {
                say("ОШИБКА: контрольная сумма встроенного пакета не совпала");
                engine::EXIT_PAYLOAD
            }
            Err(e) => {
                say(&format!("ОШИБКА: {e}"));
                engine::EXIT_PAYLOAD
            }
        };
    }

    if args.demo.is_none() && !win::acquire_single_instance("Local\\SennitSetup-2c9d6b1e-7f34-4d1a-9a52-1e0c1b7d51aa") {
        if !args.silent {
            win::info_box("Установка Бересты", "Установщик Бересты уже запущен.");
        }
        return 3;
    }

    let temp = std::env::temp_dir();
    util::cleanup_stale(&temp);
    let version = match &tail_result {
        Ok(t) => t.meta.version.clone(),
        Err(_) => env!("CARGO_PKG_VERSION").to_string(),
    };
    let log = Arc::new(util::Log::create(&temp, &version));
    log.line(&format!("запуск установщика Бересты {} ({}), аргументы: {:?}", env!("CARGO_PKG_VERSION"), exe_path.display(), std::env::args().skip(1).collect::<Vec<_>>()));
    if !args.unknown.is_empty() {
        log.line(&format!("неизвестные аргументы проигнорированы: {:?}", args.unknown));
    }

    if args.silent {
        let sink_console = console.as_ref().and_then(|f| f.try_clone().ok());
        return run_silent(&args, exe_path, tail_result, log, sink_console, &say);
    }

    let tail = tail_result.as_ref().ok().cloned();
    if tail.is_none() && args.demo.is_none() {
        log.line(&format!("встроенных данных нет: {}", tail_result.as_ref().err().map(|e| e.to_string()).unwrap_or_default()));
    }
    if let Err(e) = &tail_result {
        if !matches!(e, tail::TailError::NoTail) && args.demo.is_none() {
            // хвост есть, но повреждён: окно покажет общую ошибку целостности
            log.line(&format!("хвост повреждён: {e}"));
        }
    }
    let cfg = ui::UiConfig {
        exe_path: exe_path.clone(),
        tail,
        demo: args.demo.clone(),
        theme: args.theme.clone(),
        exit_after: args.exit_after,
        autostart: args.autostart,
        launch_default: args.launch.unwrap_or(true),
        log: Arc::clone(&log),
    };
    match ui::run(cfg) {
        Ok(code) => code,
        Err(e) => {
            log.line(&format!("окно не создано: {e}"));
            // Запасной путь: нет WebView2 или он не запустился. Показываем штатный мастер NSIS: он сам поставит WebView2.
            match tail_result {
                Ok(t) => run_fallback(exe_path, t, log),
                Err(_) => {
                    win::info_box("Установка Бересты", "Не удалось открыть окно установщика (WebView2). Установите Microsoft Edge WebView2 Runtime и запустите установщик снова.");
                    engine::EXIT_INTERNAL
                }
            }
        }
    }
}

fn run_silent(args: &Args, exe_path: PathBuf, tail_result: Result<tail::Tail, tail::TailError>, log: Arc<util::Log>, console: Option<File>, say: &dyn Fn(&str)) -> i32 {
    let tail = match tail_result {
        Ok(t) => t,
        Err(e) => {
            say(&format!("ОШИБКА: {e}"));
            log.line(&format!("ОШИБКА: {e}"));
            return engine::EXIT_PAYLOAD;
        }
    };
    let sink: Arc<dyn Sink> = Arc::new(ConsoleSink { out: std::sync::Mutex::new(console), log: Arc::clone(&log), last_pct: std::sync::atomic::AtomicI64::new(-100) });
    let ctx = Context { exe_path, tail, sink, log: Arc::clone(&log), shared: Shared::new() };
    let opts = Options { silent: true, launch_after: args.launch.unwrap_or(false), nsis_gui: false, wait_app_secs: args.wait_app };
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| engine::run(&ctx, &opts)));
    match result {
        Ok(Ok(Outcome::Done { install_dir, version, .. })) => {
            say(&format!("Готово: Береста {version} установлена в {}", install_dir.display()));
            0
        }
        Ok(Ok(Outcome::Canceled)) => 1,
        Ok(Err(f)) => {
            log.line(&format!("ОШИБКА {}: {} — {}", f.code, f.title, f.message));
            say(&format!("ОШИБКА {}: {}. {} {}", f.code, f.title, f.message, f.hint));
            // Автообновление закрыло Бересту ради установки: при сбое поднимаем прежнюю, код ошибки сохраняем.
            restore_old_app(opts.wait_app_secs, opts.launch_after, &engine::existing_install(), &win::is_exe_running, &engine::launch_app, &|m| log.line(m));
            f.exit
        }
        Err(_) => {
            log.line("ОШИБКА: внутренний сбой (panic)");
            engine::EXIT_INTERNAL
        }
    }
}

/// После неудачной тихой установки запускает уже установленную Бересту. Только если установщик ждал закрытия
/// приложения (`wait_app_secs > 0`, то есть его запустило автообновление) и просили запуск (`launch_after`);
/// уже работающую копию не дублирует. Возвращает, запускали ли.
fn restore_old_app(
    wait_app_secs: u64,
    launch_after: bool,
    existing: &engine::Existing,
    running: &dyn Fn(&std::path::Path) -> bool,
    launch: &dyn Fn(&std::path::Path, &std::path::Path) -> std::io::Result<()>,
    log: &dyn Fn(&str),
) -> bool {
    if wait_app_secs == 0 || !launch_after {
        return false;
    }
    let Some(dir) = &existing.dir else {
        log("сбой установки: прежняя установка не найдена, запускать нечего");
        return false;
    };
    let exe = dir.join(engine::MAIN_EXE);
    if !exe.is_file() {
        log("сбой установки: прежний exe Бересты не найден, запускать нечего");
        return false;
    }
    if running(&exe) {
        return false;
    }
    match launch(&exe, dir) {
        Ok(()) => {
            log("сбой установки: прежняя Береста запущена снова");
            true
        }
        Err(e) => {
            log(&format!("сбой установки: не удалось запустить прежнюю Бересту: {e}"));
            false
        }
    }
}

/// Без окна и без `/S`: штатный мастер NSIS (русский интерфейс), если WebView2 недоступен.
fn run_fallback(exe_path: PathBuf, t: tail::Tail, log: Arc<util::Log>) -> i32 {
    struct Quiet;
    impl Sink for Quiet {
        fn emit(&self, _e: Value) {}
    }
    let ctx = Context { exe_path, tail: t, sink: Arc::new(Quiet), log: Arc::clone(&log), shared: Shared::new() };
    let opts = Options { silent: false, launch_after: false, nsis_gui: true, wait_app_secs: 0 };
    match engine::run(&ctx, &opts) {
        Ok(_) => 0,
        Err(f) => {
            log.line(&format!("ОШИБКА {}: {} — {}", f.code, f.title, f.message));
            win::info_box("Установка Бересты", &format!("{}\n\n{}\n\n{}", f.title, f.message, f.hint));
            f.exit
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(v: &[&str]) -> Args {
        parse_args(v.iter().map(|s| s.to_string()))
    }

    #[test]
    fn silent_aliases() {
        for a in ["--silent", "/S", "/s", "-s", "--quiet"] {
            assert!(p(&[a]).silent, "{a}");
        }
        assert!(!p(&[]).silent);
    }

    #[test]
    fn wait_app_parsing() {
        assert_eq!(p(&[]).wait_app, 0);
        assert_eq!(p(&["--silent", "--wait-app=120"]).wait_app, 120);
        assert_eq!(p(&["--WAIT-APP=5"]).wait_app, 5);
        assert_eq!(p(&["--wait-app=99999"]).wait_app, MAX_WAIT_APP_SECS);
        for bad in ["--wait-app=", "--wait-app=abc", "--wait-app=-1"] {
            let a = p(&[bad]);
            assert_eq!(a.wait_app, 0, "{bad}");
            assert_eq!(a.unknown, vec![bad.to_string()], "{bad}");
        }
        let a = p(&["--silent", "--launch", "--wait-app=120"]);
        assert!(a.silent && a.launch == Some(true) && a.unknown.is_empty());
    }

    #[test]
    fn failed_silent_install_relaunches_old_app() {
        use std::cell::{Cell, RefCell};
        let dir = std::env::temp_dir().join(format!("egoist-relay-restore-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(engine::MAIN_EXE), b"x").unwrap();
        let existing = engine::Existing { dir: Some(dir.clone()), version: Some("1.0.0".into()) };
        let launched = RefCell::new(Vec::new());
        let launch = |exe: &std::path::Path, d: &std::path::Path| {
            launched.borrow_mut().push((exe.to_path_buf(), d.to_path_buf()));
            Ok(())
        };
        let nolog = |_: &str| {};
        // Автообновление (--wait-app=120 --launch): прежняя Береста запускается.
        assert!(restore_old_app(120, true, &existing, &|_| false, &launch, &nolog));
        assert_eq!(launched.borrow().len(), 1);
        assert_eq!(launched.borrow()[0], (dir.join(engine::MAIN_EXE), dir.clone()));
        // Ручной тихий запуск без ожидания или без --launch: ничего не запускаем.
        assert!(!restore_old_app(0, true, &existing, &|_| false, &launch, &nolog));
        assert!(!restore_old_app(120, false, &existing, &|_| false, &launch, &nolog));
        // Береста уже работает: дубль не нужен.
        assert!(!restore_old_app(120, true, &existing, &|_| true, &launch, &nolog));
        // Нет прежней установки или exe.
        assert!(!restore_old_app(120, true, &engine::Existing::default(), &|_| false, &launch, &nolog));
        let gone = Cell::new(false);
        std::fs::remove_file(dir.join(engine::MAIN_EXE)).unwrap();
        gone.set(!restore_old_app(120, true, &existing, &|_| false, &launch, &nolog));
        assert!(gone.get());
        assert_eq!(launched.borrow().len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn demo_and_theme() {
        let a = p(&["--demo=progress", "--theme=light", "--exit-after=5"]);
        assert_eq!(a.demo.as_deref(), Some("progress"));
        assert_eq!(a.theme.as_deref(), Some("light"));
        assert_eq!(a.exit_after, Some(5));
        assert_eq!(p(&["--demo"]).demo.as_deref(), Some(""));
    }

    #[test]
    fn launch_flags_and_unknown() {
        assert_eq!(p(&["--launch"]).launch, Some(true));
        assert_eq!(p(&["--no-launch"]).launch, Some(false));
        let a = p(&["--bogus", "x"]);
        assert_eq!(a.unknown, vec!["--bogus".to_string(), "x".to_string()]);
    }
}
