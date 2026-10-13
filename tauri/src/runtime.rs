use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::Manager;

const NODE_PROBE_TIMEOUT: Duration = Duration::from_secs(2);
const NODE_PROBE_POLL_INTERVAL: Duration = Duration::from_millis(25);

static NODE_BINARY: Mutex<Option<PathBuf>> = Mutex::new(None);

/// Путь к Node запоминается: `node --version` на каждую операцию стоил до 2 с.
pub(crate) fn find_node_binary(app: &tauri::AppHandle) -> Result<PathBuf, String> {
  if let Some(cached) = cached_node_binary() {
    return Ok(cached);
  }
  let found = probe_node_candidates(app)?;
  *NODE_BINARY.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(found.clone());
  Ok(found)
}

fn cached_node_binary() -> Option<PathBuf> {
  let cached = NODE_BINARY.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone()?;
  if cached.is_file() {
    return Some(cached);
  }
  forget_node_binary();
  None
}

/// Сбросить кэш: вызывать, когда запуск найденного Node завершился ошибкой.
#[allow(dead_code)]
pub(crate) fn forget_node_binary() {
  *NODE_BINARY.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
}

fn probe_node_candidates(app: &tauri::AppHandle) -> Result<PathBuf, String> {
  let mut candidates = Vec::new();
  if let Ok(directory) = app.path().resource_dir() {
    candidates.push(directory.join("runtime/node.exe"));
    candidates.push(directory.join("node.exe"));
  }
  if let Ok(executable) = std::env::current_exe()
    && let Some(directory) = executable.parent() {
    candidates.push(directory.join("runtime/node.exe"));
    candidates.push(directory.join("resources/runtime/node.exe"));
  }
  #[cfg(debug_assertions)]
  candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../runtime/node.exe"));
  let mut checked = Vec::new();
  candidates.into_iter().find(|candidate| {
    if checked.contains(candidate) { return false; }
    checked.push(candidate.clone());
    candidate.is_file() && probe_node_binary(candidate)
  }).ok_or_else(|| "Bundled Node runtime is unavailable".to_string())
}

fn probe_node_binary(candidate: &std::path::Path) -> bool {
  let mut command = Command::new(candidate);
  command.arg("--version").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
  hide_command_window(&mut command);
  let deadline = Instant::now() + NODE_PROBE_TIMEOUT;
  let Ok(mut child) = command.spawn() else { return false; };
  loop {
    match child.try_wait() {
      Ok(Some(status)) => return status.success(),
      Ok(None) if Instant::now() < deadline => {
        std::thread::sleep(NODE_PROBE_POLL_INTERVAL.min(deadline.saturating_duration_since(Instant::now())));
      },
      _ => {
        let _ = child.kill();
        let _ = child.wait();
        return false;
      },
    }
  }
}

#[cfg(windows)]
pub(crate) fn hide_command_window(command: &mut Command) {
  use std::os::windows::process::CommandExt;
  const CREATE_NO_WINDOW: u32 = 0x08000000;
  const BELOW_NORMAL_PRIORITY_CLASS: u32 = 0x00004000;
  command.creation_flags(CREATE_NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS);
}

#[cfg(not(windows))]
pub(crate) fn hide_command_window(_command: &mut Command) {}
