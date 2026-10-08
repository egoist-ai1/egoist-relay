//! Прогресс установки: чистая логика, без Windows API (проверяется юнит-тестами).
//!
//! Общая шкала по этапам (веса — доля шкалы, не времени; этап «Установка» самый длинный):
//! проверка 0–8 %, подготовка 8–25 %, установка 25–100 %.
//! Внутри установки прогресс считается по реальным данным: максимум из
//! (а) байт, записанных процессом NSIS (GetProcessIoCounters), и (б) роста каталога установки
//! относительно минимума, виденного до запуска (чтобы обновление поверх старой установки,
//! где каталог уже полон, не показывало 100 % сразу). Шкала только растёт и не доходит
//! до 100 %, пока NSIS не завершился.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stage {
    Verify,
    Prepare,
    Install,
}

pub fn overall(stage: Stage, within: f64) -> f64 {
    let w = within.clamp(0.0, 1.0);
    match stage {
        Stage::Verify => 0.08 * w,
        Stage::Prepare => 0.08 + 0.17 * w,
        Stage::Install => 0.25 + 0.75 * w,
    }
}

pub struct InstallProgress {
    expected: u64,
    best: f64,
    min_dir: Option<u64>,
}

impl InstallProgress {
    pub const CEILING: f64 = 0.99;

    pub fn new(expected_bytes: u64) -> Self {
        Self { expected: expected_bytes, best: 0.0, min_dir: None }
    }

    /// `written` — байт записано процессом NSIS; `dir_bytes` — текущий размер каталога установки.
    pub fn update(&mut self, written: u64, dir_bytes: u64) -> f64 {
        let min = *self.min_dir.get_or_insert(dir_bytes);
        if dir_bytes < min {
            self.min_dir = Some(dir_bytes);
        }
        if self.expected == 0 {
            return self.best;
        }
        let growth = dir_bytes.saturating_sub(self.min_dir.unwrap_or(dir_bytes));
        let candidate = written.max(growth) as f64 / self.expected as f64;
        let capped = candidate.clamp(0.0, Self::CEILING);
        if capped > self.best {
            self.best = capped;
        }
        self.best
    }
}

/// Сторож этапа NSIS: если ни запись процесса, ни размер каталога не растут дольше порога, этап считается зависшим.
pub struct StallDetector {
    last: Option<(u64, u64)>,
    since: f64,
    threshold: f64,
}

impl StallDetector {
    pub const DEFAULT_SECS: f64 = 300.0;

    pub fn new(threshold_secs: f64) -> Self {
        Self { last: None, since: 0.0, threshold: threshold_secs }
    }

    /// `now` — секунды от начала этапа. true, когда простой достиг порога.
    pub fn update(&mut self, written: u64, dir_bytes: u64, now: f64) -> bool {
        let cur = (written, dir_bytes);
        if self.last != Some(cur) {
            self.last = Some(cur);
            self.since = now;
        }
        now - self.since >= self.threshold
    }
}

/// «123,4 МБ» / «1,1 ГБ» без локалей: 1 МБ = 1 048 576 байт.
pub fn format_mb(bytes: u64) -> String {
    let mb = bytes as f64 / 1_048_576.0;
    if mb >= 1024.0 {
        format!("{:.1} ГБ", mb / 1024.0).replace('.', ",")
    } else if mb >= 100.0 {
        format!("{} МБ", mb.round() as u64)
    } else {
        format!("{:.1} МБ", mb).replace('.', ",")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overall_is_continuous_and_monotone() {
        assert_eq!(overall(Stage::Verify, 0.0), 0.0);
        assert!((overall(Stage::Verify, 1.0) - overall(Stage::Prepare, 0.0)).abs() < 1e-9);
        assert!((overall(Stage::Prepare, 1.0) - overall(Stage::Install, 0.0)).abs() < 1e-9);
        assert!((overall(Stage::Install, 1.0) - 1.0).abs() < 1e-9);
        assert_eq!(overall(Stage::Install, 7.0), 1.0);
        assert_eq!(overall(Stage::Verify, -1.0), 0.0);
    }

    #[test]
    fn fresh_install_follows_writes() {
        let mut p = InstallProgress::new(1000);
        assert_eq!(p.update(0, 0), 0.0);
        assert!((p.update(250, 240) - 0.25).abs() < 1e-9);
        assert!((p.update(500, 500) - 0.5).abs() < 1e-9);
    }

    #[test]
    fn progress_never_goes_back() {
        let mut p = InstallProgress::new(1000);
        p.update(600, 600);
        assert!((p.update(100, 100) - 0.6).abs() < 1e-9);
    }

    #[test]
    fn capped_below_complete() {
        let mut p = InstallProgress::new(1000);
        assert!((p.update(5000, 5000) - InstallProgress::CEILING).abs() < 1e-9);
    }

    #[test]
    fn upgrade_over_full_directory_does_not_jump() {
        // каталог уже 900 из 1000: рост считается от виденного минимума
        let mut p = InstallProgress::new(1000);
        assert_eq!(p.update(0, 900), 0.0);
        assert!((p.update(0, 950) - 0.05).abs() < 1e-9);
    }

    #[test]
    fn directory_shrink_resets_baseline() {
        // NSIS сначала удаляет старое (каталог сжимается), затем пишет новое
        let mut p = InstallProgress::new(1000);
        p.update(0, 900);
        p.update(0, 100);
        assert!((p.update(0, 400) - 0.3).abs() < 1e-9);
    }

    #[test]
    fn stall_detector_fires_only_after_idle_threshold() {
        let mut s = StallDetector::new(300.0);
        assert!(!s.update(0, 0, 0.0));
        assert!(!s.update(100, 0, 200.0)); // рост сбрасывает таймер
        assert!(!s.update(100, 0, 499.0));
        assert!(s.update(100, 0, 500.0));
        assert!(!s.update(100, 50, 501.0)); // оживление каталога
    }

    #[test]
    fn zero_expected_is_safe() {
        let mut p = InstallProgress::new(0);
        assert_eq!(p.update(10, 10), 0.0);
    }

    #[test]
    fn mb_format() {
        assert_eq!(format_mb(0), "0,0 МБ");
        assert_eq!(format_mb(1_572_864), "1,5 МБ");
        assert_eq!(format_mb(566_366_208), "540 МБ");
        assert_eq!(format_mb(1_181_116_006), "1,1 ГБ");
        assert_eq!(format_mb(1_073_741_824), "1,0 ГБ");
    }
}
