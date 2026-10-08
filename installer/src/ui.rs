//! Окно установщика: tao + wry (WebView2), один встроенный HTML без внешних ресурсов.

use std::borrow::Cow;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tao::dpi::{LogicalSize, PhysicalPosition};
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy};
use tao::platform::run_return::EventLoopExtRunReturn;
use tao::platform::windows::{WindowBuilderExtWindows, WindowExtWindows};
use tao::window::{Theme, WindowBuilder};
use wry::http::{header, Response};
use wry::{WebContext, WebViewBuilder};

use crate::demo;
use crate::engine::{self, Context, Failure, Options, Outcome, Shared, Sink, PHASE_CANCELABLE, PHASE_LOCKED};
use crate::progress::format_mb;
use crate::tail::Tail;
use crate::util::Log;
use crate::win;

const WINDOW_W: f64 = 720.0;
const WINDOW_H: f64 = 460.0;
const ORIGIN: &str = "http://setup.localhost/";

pub struct UiConfig {
    pub exe_path: PathBuf,
    /// None — exe без payload (разработка).
    pub tail: Option<Tail>,
    pub demo: Option<String>,
    pub theme: Option<String>,
    pub exit_after: Option<u64>,
    /// Только с --demo: сразу нажать «Установить» (автоматические проверки).
    pub autostart: bool,
    pub launch_default: bool,
    pub log: Arc<Log>,
}

#[derive(Debug)]
enum UserEvent {
    Js(String),
    Ipc(String),
    EngineDone,
    Exit,
}

struct ProxySink(Mutex<EventLoopProxy<UserEvent>>);

impl Sink for ProxySink {
    fn emit(&self, event: Value) {
        if let Ok(p) = self.0.lock() {
            let _ = p.send_event(UserEvent::Js(event.to_string()));
        }
    }
}

fn asset(path: &str) -> Option<(&'static str, Cow<'static, [u8]>)> {
    macro_rules! file {
        ($mime:expr, $p:expr) => {
            Some(($mime, Cow::Borrowed(&include_bytes!($p)[..])))
        };
    }
    match path {
        "/" | "/index.html" => file!("text/html; charset=utf-8", "../ui/index.html"),
        "/license.txt" => file!("text/plain; charset=utf-8", "../ui/license.txt"),
        "/mark.svg" => file!("image/svg+xml", "../ui/mark.svg"),
        "/mark-light.svg" => file!("image/svg+xml", "../ui/mark-light.svg"),
        "/wordmark.svg" => file!("image/svg+xml", "../ui/wordmark.svg"),
        "/wordmark-light.svg" => file!("image/svg+xml", "../ui/wordmark-light.svg"),
        "/fonts/onest-cyrillic-wght-normal.woff2" => file!("font/woff2", "../ui/fonts/onest-cyrillic-wght-normal.woff2"),
        "/fonts/onest-latin-wght-normal.woff2" => file!("font/woff2", "../ui/fonts/onest-latin-wght-normal.woff2"),
        "/fonts/unbounded-cyrillic.woff2" => file!("font/woff2", "../ui/fonts/unbounded-cyrillic.woff2"),
        "/fonts/unbounded-latin.woff2" => file!("font/woff2", "../ui/fonts/unbounded-latin.woff2"),
        "/fonts/jetbrains-mono-cyrillic-wght-normal.woff2" => file!("font/woff2", "../ui/fonts/jetbrains-mono-cyrillic-wght-normal.woff2"),
        "/fonts/jetbrains-mono-latin-wght-normal.woff2" => file!("font/woff2", "../ui/fonts/jetbrains-mono-latin-wght-normal.woff2"),
        _ => None,
    }
}

fn failure_event(f: &Failure) -> Value {
    json!({"t":"error","code":f.code,"title":f.title,"message":f.message,"hint":f.hint,"retry":f.retry})
}

/// Запускает движок в потоке и превращает итог в событие для окна.
fn spawn_engine(ctx: Arc<Context>, opts: Options, shared: Arc<Shared>, proxy: EventLoopProxy<UserEvent>) {
    if shared.running.swap(true, Ordering::SeqCst) {
        return;
    }
    let sink = Arc::clone(&ctx.sink);
    std::thread::spawn(move || {
        let result = catch_unwind(AssertUnwindSafe(|| engine::run(&ctx, &opts)));
        match result {
            Ok(Ok(Outcome::Done { install_dir, version, updated, launched })) => {
                if let Ok(mut d) = shared.final_dir.lock() {
                    *d = Some(install_dir.clone());
                }
                shared.last_exit.store(0, Ordering::SeqCst);
                sink.emit(json!({"t":"done","dir":install_dir.to_string_lossy(),"version":version,"updated":updated,"launched":launched}));
            }
            Ok(Ok(Outcome::Canceled)) => {
                ctx.log.line("установка отменена пользователем");
                shared.last_exit.store(1, Ordering::SeqCst);
                sink.emit(json!({"t":"canceled"}));
            }
            Ok(Err(f)) => {
                ctx.log.line(&format!("ОШИБКА {}: {} — {}", f.code, f.title, f.message));
                shared.last_exit.store(f.exit, Ordering::SeqCst);
                sink.emit(failure_event(&f));
            }
            Err(_) => {
                ctx.log.line("ОШИБКА: внутренний сбой (panic)");
                shared.last_exit.store(engine::EXIT_INTERNAL, Ordering::SeqCst);
                sink.emit(json!({"t":"error","code":"SETUP-PANIC","retry":true,"title":"Внутренняя ошибка установщика","message":"Установщик неожиданно остановился.","hint":"Нажмите «Показать журнал» и повторите попытку."}));
            }
        }
        shared.running.store(false, Ordering::SeqCst);
        let _ = proxy.send_event(UserEvent::EngineDone);
    });
}

/// Возвращает код выхода процесса по последнему исходу установки.
pub fn run(cfg: UiConfig) -> Result<i32, String> {
    let mut event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();

    let theme = match cfg.theme.as_deref() {
        Some("dark") => Some(Theme::Dark),
        Some("light") => Some(Theme::Light),
        _ => None,
    };
    let window = WindowBuilder::new()
        .with_title("Sennit Setup")
        .with_inner_size(LogicalSize::new(WINDOW_W, WINDOW_H))
        .with_resizable(false)
        .with_maximizable(false)
        .with_decorations(false)
        .with_undecorated_shadow(true)
        .with_visible(false)
        .with_theme(theme)
        .build(&event_loop)
        .map_err(|e| format!("окно: {e}"))?;
    let window = std::rc::Rc::new(window);
    win::round_window_corners(window.hwnd());

    // Центр рабочего монитора.
    if let Some(m) = window.current_monitor().or_else(|| window.primary_monitor()) {
        let size = window.outer_size();
        let (ms, mp) = (m.size(), m.position());
        let x = mp.x + (ms.width as i32 - size.width as i32) / 2;
        let y = mp.y + (ms.height as i32 - size.height as i32) / 2;
        window.set_outer_position(PhysicalPosition::new(x, y));
    }

    // Каталог данных WebView2 — во временной папке, а не рядом с установщиком.
    let data_dir = std::env::temp_dir().join("Sennit-Setup-webview");
    let mut web_context = WebContext::new(Some(data_dir.clone()));

    let ipc_proxy = Mutex::new(proxy.clone());
    let url = match &cfg.theme {
        Some(t) => format!("{ORIGIN}index.html?theme={t}"),
        None => format!("{ORIGIN}index.html"),
    };
    use wry::WebViewBuilderExtWindows;
    let webview = WebViewBuilder::new_with_web_context(&mut web_context)
        .with_background_color((14, 14, 15, 255))
        .with_devtools(false)
        .with_hotkeys_zoom(false)
        .with_browser_accelerator_keys(false)
        .with_default_context_menus(false)
        .with_custom_protocol("setup".into(), |_id, request| {
            let path = request.uri().path().to_string();
            match asset(&path) {
                Some((mime, body)) => Response::builder()
                    .header(header::CONTENT_TYPE, mime)
                    .header(header::CACHE_CONTROL, "no-store")
                    .header("X-Content-Type-Options", "nosniff")
                    .header("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self'; font-src 'self'; connect-src 'self'")
                    .body(body)
                    .unwrap(),
                None => Response::builder().status(404).body(Cow::Borrowed(&b""[..])).unwrap(),
            }
        })
        .with_ipc_handler(move |req| {
            if let Ok(p) = ipc_proxy.lock() {
                let _ = p.send_event(UserEvent::Ipc(req.body().clone()));
            }
        })
        .with_navigation_handler(|u| u.starts_with(ORIGIN))
        .with_new_window_req_handler(|_, _| wry::NewWindowResponse::Deny)
        .with_url(&url)
        .build(&*window)
        .map_err(|e| format!("WebView2: {e}"))?;

    let shared = Shared::new();
    let exit_shared = Arc::clone(&shared);
    let is_demo = cfg.demo.is_some();
    let sink: Arc<dyn Sink> = Arc::new(ProxySink(Mutex::new(proxy.clone())));
    let ctx: Option<Arc<Context>> = cfg.tail.clone().map(|tail| {
        Arc::new(Context { exe_path: cfg.exe_path.clone(), tail, sink: Arc::clone(&sink), log: Arc::clone(&cfg.log), shared: Arc::clone(&shared) })
    });
    let existing = engine::existing_install();
    let install_dir = engine::target_dir(&existing);
    let log = Arc::clone(&cfg.log);
    let demo_arg = cfg.demo.clone();
    let cfg_autostart = cfg.autostart;
    let mut launch_after = cfg.launch_default;
    let mut closing = false;
    let mut window_shown = false;

    if let Some(secs) = cfg.exit_after {
        let p = proxy.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(secs));
            let _ = p.send_event(UserEvent::Exit);
        });
    }

    let version = ctx.as_ref().map(|c| c.tail.meta.version.clone()).unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string());
    let payload_text = ctx.as_ref().map(|c| format_mb(c.tail.payload_len)).unwrap_or_else(|| "540 МБ".into());
    let install_text = ctx.as_ref().map(|c| format_mb(c.tail.install_bytes)).unwrap_or_else(|| "около 1 ГБ".into());

    event_loop.run_return(move |event, _target, control_flow| {
        *control_flow = ControlFlow::Wait;
        let request_close = |closing: &mut bool, control_flow: &mut ControlFlow| {
            match shared.phase.load(Ordering::SeqCst) {
                PHASE_LOCKED if shared.stalled.load(Ordering::SeqCst) => {
                    // NSIS не продвигается: закрытие окна = «Прервать»
                    *closing = true;
                    shared.cancel.store(true, Ordering::SeqCst);
                }
                PHASE_LOCKED => {
                    let _ = webview.evaluate_script("window.setup&&window.setup.event({t:'locked_close'})");
                }
                PHASE_CANCELABLE if shared.running.load(Ordering::SeqCst) => {
                    // остановим работу и выйдем, когда движок уберёт временные файлы
                    *closing = true;
                    shared.cancel.store(true, Ordering::SeqCst);
                }
                _ => *control_flow = ControlFlow::Exit,
            }
        };
        match event {
            Event::WindowEvent { event: WindowEvent::CloseRequested, .. } => request_close(&mut closing, control_flow),
            Event::UserEvent(UserEvent::Exit) => *control_flow = ControlFlow::Exit,
            Event::UserEvent(UserEvent::EngineDone) => {
                if closing {
                    *control_flow = ControlFlow::Exit;
                }
            }
            Event::UserEvent(UserEvent::Js(json)) => {
                let _ = webview.evaluate_script(&format!("window.setup&&window.setup.event({json})"));
            }
            Event::UserEvent(UserEvent::Ipc(body)) => {
                let Ok(v) = serde_json::from_str::<Value>(&body) else { return };
                let cmd = v.get("cmd").and_then(Value::as_str).unwrap_or("");
                match cmd {
                    "ready" => {
                        if !window_shown {
                            window_shown = true;
                            window.set_visible(true);
                            window.set_focus();
                        }
                        log.line("окно готово");
                        let existing_version = existing.version.clone();
                        let mode = match &existing_version {
                            None => "install",
                            Some(v) => match crate::preflight::compare_versions(v, &version) {
                                std::cmp::Ordering::Less => "update",
                                std::cmp::Ordering::Equal => "reinstall",
                                std::cmp::Ordering::Greater => "newer",
                            },
                        };
                        sink.emit(json!({
                            "t":"init","version":version,"installDir":install_dir.to_string_lossy(),
                            "existing":existing_version,"mode":mode,"payload":payload_text,"install":install_text,
                            "demo":demo_arg.is_some(),"launch":launch_after,
                        }));
                        if let Some(arg) = &demo_arg {
                            if let demo::Mode::Static(_) = demo::parse(arg) {
                                let p = proxy.clone();
                                demo::spawn(Arc::clone(&sink), Arc::clone(&shared), demo::parse(arg), launch_after, Box::new(move || {
                                    let _ = p.send_event(UserEvent::EngineDone);
                                }));
                            }
                            if cfg_autostart && !matches!(demo::parse(arg), demo::Mode::Static(_)) {
                                let p = proxy.clone();
                                demo::spawn(Arc::clone(&sink), Arc::clone(&shared), demo::parse(arg), launch_after, Box::new(move || {
                                    let _ = p.send_event(UserEvent::EngineDone);
                                }));
                            }
                        } else if ctx.is_none() {
                            sink.emit(failure_event(&Failure::no_payload()));
                        }
                    }
                    "start" | "retry" => {
                        launch_after = v.get("launch").and_then(Value::as_bool).unwrap_or(launch_after);
                        log.line(&format!("команда {cmd}, запуск после установки: {launch_after}"));
                        if let Some(arg) = &demo_arg {
                            let p = proxy.clone();
                            let mode = demo::parse(arg);
                            let mode = if matches!(mode, demo::Mode::Static(_)) { demo::Mode::Full } else { mode };
                            if !shared.running.load(Ordering::SeqCst) {
                                demo::spawn(Arc::clone(&sink), Arc::clone(&shared), mode, launch_after, Box::new(move || {
                                    let _ = p.send_event(UserEvent::EngineDone);
                                }));
                            }
                        } else if let Some(c) = &ctx {
                            let opts = Options { silent: false, launch_after, nsis_gui: false };
                            spawn_engine(Arc::clone(c), opts, Arc::clone(&shared), proxy.clone());
                        }
                    }
                    "cancel" => shared.cancel.store(true, Ordering::SeqCst),
                    "close" => request_close(&mut closing, control_flow),
                    "minimize" => window.set_minimized(true),
                    "drag" => {
                        let _ = window.drag_window();
                    }
                    "open_log" => {
                        // Блокнот — по абсолютному пути из System32, не по имени (подмена в текущей папке исключена).
                        let _ = std::process::Command::new(win::system_dir().join("notepad.exe")).arg(&log.path).spawn();
                    }
                    "launch" => {
                        let dir = shared.final_dir.lock().ok().and_then(|d| d.clone());
                        if let Some(dir) = dir {
                            let _ = engine::launch_app(&dir.join(engine::MAIN_EXE), &dir);
                        }
                        *control_flow = ControlFlow::Exit;
                    }
                    _ => {}
                }
            }
            Event::LoopDestroyed => {
                let _ = &webview;
            }
            _ => {}
        }
    });
    cleanup_webview_data();
    Ok(if is_demo { 0 } else { exit_shared.last_exit.load(Ordering::SeqCst) })
}

/// Убирает данные WebView2 после закрытия окна (best effort: процессы WebView2 завершаются не мгновенно).
pub fn cleanup_webview_data() {
    let dir = std::env::temp_dir().join("Sennit-Setup-webview");
    std::thread::sleep(std::time::Duration::from_millis(400));
    let _ = std::fs::remove_dir_all(&dir);
}
