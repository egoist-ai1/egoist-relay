//! Sennit Setup: фирменный установщик Sennit by Egoist.
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
    autostart: bool,
    unknown: Vec<String>,
}

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
            "need_close" => Some("Закройте Sennit через значок в трее".to_string()),
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
                say(&format!("OK: Sennit {} payload {} байт, SHA-256 {}", t.meta.version, t.payload_len, tail::hex(&t.payload_sha256)));
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
            win::info_box("Sennit Setup", "Установщик Sennit уже запущен.");
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
    log.line(&format!("запуск Sennit Setup {} ({}), аргументы: {:?}", env!("CARGO_PKG_VERSION"), exe_path.display(), std::env::args().skip(1).collect::<Vec<_>>()));
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
                    win::info_box("Sennit Setup", "Не удалось открыть окно установщика (WebView2). Установите Microsoft Edge WebView2 Runtime и запустите установщик снова.");
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
    let opts = Options { silent: true, launch_after: args.launch.unwrap_or(false), nsis_gui: false };
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| engine::run(&ctx, &opts)));
    match result {
        Ok(Ok(Outcome::Done { install_dir, version, .. })) => {
            say(&format!("Готово: Sennit {version} установлен в {}", install_dir.display()));
            0
        }
        Ok(Ok(Outcome::Canceled)) => 1,
        Ok(Err(f)) => {
            log.line(&format!("ОШИБКА {}: {} — {}", f.code, f.title, f.message));
            say(&format!("ОШИБКА {}: {}. {} {}", f.code, f.title, f.message, f.hint));
            f.exit
        }
        Err(_) => {
            log.line("ОШИБКА: внутренний сбой (panic)");
            engine::EXIT_INTERNAL
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
    let opts = Options { silent: false, launch_after: false, nsis_gui: true };
    match engine::run(&ctx, &opts) {
        Ok(_) => 0,
        Err(f) => {
            log.line(&format!("ОШИБКА {}: {} — {}", f.code, f.title, f.message));
            win::info_box("Sennit Setup", &format!("{}\n\n{}\n\n{}", f.title, f.message, f.hint));
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
