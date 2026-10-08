//! Режим `--demo`: имитация шагов для просмотра интерфейса без payload.
//! События те же, что у настоящего движка, поэтому проверяется весь путь Rust -> окно.

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use serde_json::json;

use crate::engine::{Shared, Sink, PHASE_CANCELABLE, PHASE_IDLE, PHASE_LOCKED};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Mode {
    /// Полный прогон до «Готово» (по кнопке «Установить»).
    Full,
    /// Прогон, который падает на середине установки.
    Fail,
    /// Прогон с просьбой закрыть Sennit.
    Running,
    /// Сразу показать экран и остановиться (для снимков): progress | error | done | running.
    Static(String),
}

pub fn parse(arg: &str) -> Mode {
    match arg {
        "" | "full" => Mode::Full,
        "fail" => Mode::Fail,
        "running-flow" => Mode::Running,
        "welcome" => Mode::Static("welcome".into()),
        other => Mode::Static(other.to_string()),
    }
}

fn nap(ms: u64) {
    std::thread::sleep(Duration::from_millis(ms));
}

fn stage(sink: &dyn Sink, i: u32, label: &str, detail: &str) {
    sink.emit(json!({"t":"stage","i":i,"n":4,"label":label,"detail":detail}));
}

fn progress(sink: &dyn Sink, v: f64, detail: &str) {
    sink.emit(json!({"t":"progress","v":v,"detail":detail}));
}

fn error(sink: &dyn Sink) {
    sink.emit(json!({
        "t":"error","code":"SETUP-ACCESS","retry":true,
        "title":"Нет доступа к папке установки",
        "message":"Не удалось записать файлы в C:\\Users\\Demo\\AppData\\Local\\Egoist Relay (отказано в доступе).",
        "hint":"Закройте программы, которые используют файлы Sennit, и нажмите «Повторить»."
    }));
}

fn done(sink: &dyn Sink, launched: bool) {
    sink.emit(json!({"t":"done","dir":"C:\\Users\\Demo\\AppData\\Local\\Egoist Relay","version":"1.7.1","updated":false,"launched":launched}));
}

/// Запускает сценарий в отдельном потоке. `launch_after` — как в настоящем движке.
pub fn spawn(sink: Arc<dyn Sink>, shared: Arc<Shared>, mode: Mode, launch_after: bool, finished: Box<dyn Fn() + Send>) {
    shared.running.store(true, Ordering::SeqCst);
    shared.cancel.store(false, Ordering::SeqCst);
    std::thread::spawn(move || {
        run(&*sink, &shared, &mode, launch_after);
        shared.phase.store(PHASE_IDLE, Ordering::SeqCst);
        shared.running.store(false, Ordering::SeqCst);
        finished();
    });
}

fn cancelled(shared: &Shared) -> bool {
    shared.cancel.load(Ordering::SeqCst)
}

fn run(sink: &dyn Sink, shared: &Shared, mode: &Mode, launch_after: bool) {
    shared.phase.store(PHASE_CANCELABLE, Ordering::SeqCst);
    if let Mode::Static(kind) = mode {
        match kind.as_str() {
            "progress" => {
                stage(sink, 3, "Установка файлов", "Запись файлов, ярлыки, запись в «Приложения и возможности»");
                shared.phase.store(PHASE_LOCKED, Ordering::SeqCst);
                progress(sink, 0.62, "Записано 312 МБ из ~540 МБ");
            }
            "prepare" => {
                stage(sink, 2, "Подготовка файлов", "Распаковка во временную папку");
                progress(sink, 0.17, "212 МБ из 540 МБ");
            }
            "verify" => {
                stage(sink, 1, "Проверка целостности", "Сверяем контрольную сумму встроенного пакета");
                progress(sink, 0.04, "230 МБ из 540 МБ");
            }
            "error" => error(sink),
            "done" => done(sink, launch_after),
            "running" => {
                stage(sink, 1, "Проверка системы", "Windows, свободное место, запущенное приложение");
                sink.emit(json!({"t":"need_close","running":true}));
                // держим экран, пока не отменят
                while !cancelled(shared) {
                    nap(100);
                }
                sink.emit(json!({"t":"canceled"}));
            }
            _ => {}
        }
        // статический экран: поток остаётся «занятым» только для running
        return;
    }

    stage(sink, 1, "Проверка системы", "Windows, свободное место, запущенное приложение");
    progress(sink, 0.0, "");
    nap(500);
    if *mode == Mode::Running {
        sink.emit(json!({"t":"need_close","running":true}));
        for _ in 0..40 {
            if cancelled(shared) {
                sink.emit(json!({"t":"canceled"}));
                return;
            }
            nap(100);
        }
        sink.emit(json!({"t":"need_close","running":false}));
    }
    stage(sink, 1, "Проверка целостности", "Сверяем контрольную сумму встроенного пакета");
    for k in 0..=20 {
        if cancelled(shared) {
            sink.emit(json!({"t":"canceled"}));
            return;
        }
        progress(sink, 0.08 * k as f64 / 20.0, &format!("{} из 540 МБ", 27 * k));
        nap(50);
    }
    stage(sink, 2, "Подготовка файлов", "Распаковка во временную папку");
    for k in 0..=30 {
        if cancelled(shared) {
            sink.emit(json!({"t":"canceled"}));
            return;
        }
        progress(sink, 0.08 + 0.17 * k as f64 / 30.0, &format!("{} из 540 МБ", 18 * k));
        nap(50);
    }
    shared.phase.store(PHASE_LOCKED, Ordering::SeqCst);
    stage(sink, 3, "Установка файлов", "Запись файлов, ярлыки, запись в «Приложения и возможности»");
    progress(sink, 0.25, "Запускаем установщик");
    nap(700);
    for k in 1..=60 {
        let within = k as f64 / 60.0;
        if *mode == Mode::Fail && within > 0.55 {
            error(sink);
            return;
        }
        progress(sink, 0.25 + 0.75 * within * 0.99, &format!("Записано {} МБ из ~540 МБ", (540.0 * within) as u32));
        nap(110);
    }
    progress(sink, 1.0, "");
    stage(sink, 4, "Готово", "Sennit установлен");
    done(sink, launch_after);
}
