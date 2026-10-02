use std::path::PathBuf;
use std::process::{Command, Stdio};

use tauri::Manager;

pub(crate) fn find_node_binary(app: &tauri::AppHandle) -> Result<PathBuf, String> {
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
  candidates.into_iter().find(|candidate| {
    if !candidate.is_file() { return false; }
    let mut command = Command::new(candidate);
    command.arg("--version").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    hide_command_window(&mut command);
    command.status().is_ok_and(|status| status.success())
  }).ok_or_else(|| "Bundled Node runtime is unavailable".to_string())
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
