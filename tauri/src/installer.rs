use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

const REQUIRED_RUNTIME_FILES: &[&str] = &[
  "node.exe", "NODE-LICENSE.txt", "yt-dlp.exe",
  "transcription/whisper-cli.exe", "transcription/whisper.dll", "transcription/ggml.dll",
  "transcription/ggml-base.dll", "transcription/ggml-cpu-x64.dll", "transcription/ggml-small-q5_1.bin",
  "transcription/msvcp140.dll", "transcription/vcomp140.dll", "transcription/vcruntime140.dll",
  "transcription/vcruntime140_1.dll", "transcription/WHISPER-LICENSE.txt", "transcription/MODEL-LICENSE.txt",
  "transcription/MSVC-RUNTIME-LICENSE.txt", "transcription/MSVC-BUILD-TOOLS-LICENSE.txt",
  "transcription/ggml-silero-v6.2.0.bin", "transcription/VAD-LICENSE.txt",
  "YT-DLP-LICENSE.txt", "YT-DLP-THIRD-PARTY-LICENSES.txt",
  "media/ffmpeg.exe", "media/ffprobe.exe", "media/FFMPEG-LICENSE.txt", "media/FFMPEG-BUILD-README.txt",
];

const SHORTCUT_SCRIPT: &str = r#"
  $ErrorActionPreference = 'Stop'
  [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
  $targetPath = [Environment]::GetEnvironmentVariable('EGOIST_RELAY_SHORTCUT_TARGET', [EnvironmentVariableTarget]::Process)
  $workingDirectory = [Environment]::GetEnvironmentVariable('EGOIST_RELAY_SHORTCUT_WORKDIR', [EnvironmentVariableTarget]::Process)
  if ([string]::IsNullOrWhiteSpace($targetPath) -or [string]::IsNullOrWhiteSpace($workingDirectory)) {
    throw 'Shortcut target is not configured'
  }

  $shell = New-Object -ComObject WScript.Shell
  $desktopPath = [Environment]::GetFolderPath('Desktop')
  $desktopShortcut = $shell.CreateShortcut((Join-Path -Path $desktopPath -ChildPath 'Egoist Relay.lnk'))
  $desktopShortcut.TargetPath = $targetPath
  $desktopShortcut.WorkingDirectory = $workingDirectory
  $desktopShortcut.IconLocation = "$targetPath,0"
  $desktopShortcut.Description = 'Egoist Relay - Modern Telegram Client'
  $desktopShortcut.Save()

  $programsPath = [Environment]::GetFolderPath('Programs')
  $egoistPrograms = Join-Path -Path $programsPath -ChildPath 'Egoist Relay'
  [IO.Directory]::CreateDirectory($egoistPrograms) | Out-Null
  $menuShortcut = $shell.CreateShortcut((Join-Path -Path $egoistPrograms -ChildPath 'Egoist Relay.lnk'))
  $menuShortcut.TargetPath = $targetPath
  $menuShortcut.WorkingDirectory = $workingDirectory
  $menuShortcut.IconLocation = "$targetPath,0"
  $menuShortcut.Description = 'Egoist Relay'
  $menuShortcut.Save()
"#;

#[derive(serde::Serialize, Clone)]
pub struct InstallProgress {
  pub percent: f64,
  pub message: String,
  pub detail: String,
}

#[tauri::command]
pub fn get_default_install_dir() -> String {
  let local_appdata = std::env::var_os("LOCALAPPDATA")
    .map(PathBuf::from)
    .or_else(|| {
      std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .map(|path| path.join("AppData").join("Local"))
    })
    .unwrap_or_else(std::env::temp_dir);
  local_appdata
    .join("Programs")
    .join("Egoist Relay")
    .to_string_lossy()
    .into_owned()
}

#[tauri::command]
pub async fn choose_install_dir() -> Result<Option<String>, String> {
  #[cfg(windows)]
  {
    use std::os::windows::process::CommandExt;

    let script = r#"
      $ErrorActionPreference = 'Stop'
      [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
      Add-Type -AssemblyName System.Windows.Forms
      $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
      $dialog.Description = 'Выберите папку для установки Egoist Relay'
      $dialog.ShowNewFolderButton = $true
      if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
        Write-Output $dialog.SelectedPath
      }
    "#;
    let output = std::process::Command::new("powershell.exe")
      .args(["-NoProfile", "-NonInteractive", "-Command", script])
      .creation_flags(0x08000000)
      .output()
      .map_err(|e| format!("Не удалось открыть выбор папки: {}", e))?;

    ensure_command_succeeded("Не удалось выбрать папку установки", &output)?;
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if path.is_empty() {
      Ok(None)
    } else {
      Ok(Some(path))
    }
  }
  #[cfg(not(windows))]
  {
    Ok(None)
  }
}

#[tauri::command]
pub fn minimize_installer(window: WebviewWindow) {
  let _ = window.minimize();
}

#[tauri::command]
pub fn close_installer() {
  std::process::exit(0);
}

#[tauri::command]
pub fn launch_installed_app(target_dir: String) -> Result<(), String> {
  let exe_path = Path::new(&target_dir).join("Egoist Relay.exe");
  if !exe_path.is_file() {
    return Err(format!("Исполняемый файл не найден: {:?}", exe_path));
  }
  std::process::Command::new(exe_path)
    .spawn()
    .map_err(|e| e.to_string())?;
  std::process::exit(0);
}

#[tauri::command]
pub async fn perform_install(
  app: AppHandle,
  target_dir: String,
  create_shortcut: bool,
) -> Result<(), String> {
  let target_path = PathBuf::from(&target_dir);
  let current_exe = std::env::current_exe()
    .map_err(|e| format!("Не удалось определить файл установщика: {}", e))?;
  let runtime_source = get_bundled_runtime_dir(&app)?;
  validate_install_target(&target_path, &runtime_source)?;

  let emit = |percent: f64, message: &str, detail: &str| {
    let _ = app.emit(
      "install-progress",
      InstallProgress {
        percent,
        message: message.to_string(),
        detail: detail.to_string(),
      },
    );
  };

  emit(10.0, "Подготовка к установке...", &target_dir);
  terminate_existing_processes(&target_path)?;
  std::thread::sleep(std::time::Duration::from_millis(200));
  std::fs::create_dir_all(&target_path)
    .map_err(|e| format!("Не удалось создать папку установки: {}", e))?;

  emit(30.0, "Копирование файлов программы...", "Egoist Relay.exe");
  let dest_exe = target_path.join("Egoist Relay.exe");
  copy_file_if_needed(&current_exe, &dest_exe)
    .map_err(|e| format!("Не удалось скопировать Egoist Relay.exe: {}", e))?;

  let runtime_destination = target_path.join("runtime");
  copy_directory_contents(&runtime_source, &runtime_destination)?;
  std::thread::sleep(std::time::Duration::from_millis(250));

  emit(80.0, "Локальное распознавание установлено", "Движок и модель готовы к работе без загрузки зависимостей");

  std::thread::sleep(std::time::Duration::from_millis(250));

  if create_shortcut {
    emit(
      88.0,
      "Создание ярлыков в системе...",
      "Рабочий стол и меню Пуск",
    );
    create_shortcuts(&dest_exe, &target_path)?;
  }

  emit(
    100.0,
    "Установка успешно завершена!",
    "Egoist Relay готов к использованию",
  );
  Ok(())
}

fn validate_install_target(target: &Path, runtime_source: &Path) -> Result<(), String> {
  if !target.is_absolute() || target.parent().is_none()
    || target.components().any(|component| matches!(component, std::path::Component::ParentDir))
    || (target.exists() && !target.is_dir()) {
    return Err("Выберите отдельную папку для установки приложения".into());
  }
  let mut existing = target;
  let mut missing = Vec::new();
  while !existing.exists() {
    missing.push(existing.file_name().ok_or("Некорректная папка установки")?);
    existing = existing.parent().ok_or("Некорректная папка установки")?;
  }
  let mut resolved = existing.canonicalize().map_err(|_| "Не удалось проверить папку установки")?;
  for component in missing.into_iter().rev() { resolved.push(component); }
  let source = runtime_source.canonicalize().map_err(|_| "Не удалось проверить папку ресурсов")?;
  #[cfg(windows)]
  let is_inside_runtime = {
    let source = source.to_string_lossy().replace('/', "\\").to_lowercase();
    let target = resolved.to_string_lossy().replace('/', "\\").to_lowercase();
    target == source || target.starts_with(&format!("{}\\", source.trim_end_matches('\\')))
  };
  #[cfg(not(windows))]
  let is_inside_runtime = resolved.starts_with(source);
  if is_inside_runtime || resolved.parent().is_none() {
    return Err("Папка установки не может находиться внутри ресурсов приложения".into());
  }
  Ok(())
}

fn get_bundled_runtime_dir(app: &AppHandle) -> Result<PathBuf, String> {
  let resource_dir = app
    .path()
    .resource_dir()
    .map_err(|e| format!("Не удалось определить папку ресурсов установщика: {}", e))?;
  let runtime_dir = resource_dir.join("runtime");
  if !runtime_dir.is_dir() {
    return Err(format!(
      "Папка runtime отсутствует в ресурсах установщика: {:?}",
      runtime_dir
    ));
  }

  for file_name in REQUIRED_RUNTIME_FILES {
    let file_path = runtime_dir.join(file_name);
    if !file_path.is_file() {
      return Err(format!(
        "Обязательный файл runtime отсутствует в ресурсах установщика: {:?}",
        file_path
      ));
    }
  }

  Ok(runtime_dir)
}

fn copy_directory_contents(source: &Path, destination: &Path) -> Result<(), String> {
  if paths_refer_to_same_location(source, destination) {
    return Ok(());
  }

  std::fs::create_dir_all(destination)
    .map_err(|e| format!("Не удалось создать папку {:?}: {}", destination, e))?;
  let entries = std::fs::read_dir(source)
    .map_err(|e| format!("Не удалось прочитать папку ресурсов {:?}: {}", source, e))?;

  for entry in entries {
    let entry = entry.map_err(|e| format!("Не удалось прочитать ресурс: {}", e))?;
    let file_type = entry.file_type().map_err(|e| {
      format!(
        "Не удалось определить тип ресурса {:?}: {}",
        entry.path(),
        e
      )
    })?;
    let destination_path = destination.join(entry.file_name());
    if file_type.is_dir() {
      copy_directory_contents(&entry.path(), &destination_path)?;
    } else if file_type.is_file() {
      copy_file_if_needed(&entry.path(), &destination_path)
        .map_err(|e| format!("Не удалось скопировать ресурс {:?}: {}", entry.path(), e))?;
    } else {
      return Err(format!("Неподдерживаемый тип ресурса: {:?}", entry.path()));
    }
  }

  Ok(())
}

fn copy_file_if_needed(source: &Path, destination: &Path) -> std::io::Result<()> {
  if paths_refer_to_same_location(source, destination) {
    return Ok(());
  }
  std::fs::copy(source, destination).map(|_| ())
}

fn paths_refer_to_same_location(first: &Path, second: &Path) -> bool {
  if first == second {
    return true;
  }
  match (first.canonicalize(), second.canonicalize()) {
    (Ok(first), Ok(second)) => first == second,
    _ => false,
  }
}

#[cfg(windows)]
fn create_shortcuts(target_exe: &Path, working_directory: &Path) -> Result<(), String> {
  use std::os::windows::process::CommandExt;

  let output = std::process::Command::new("powershell.exe")
    .args([
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      SHORTCUT_SCRIPT,
    ])
    .env("EGOIST_RELAY_SHORTCUT_TARGET", target_exe)
    .env("EGOIST_RELAY_SHORTCUT_WORKDIR", working_directory)
    .creation_flags(0x08000000)
    .output()
    .map_err(|e| format!("Не удалось запустить создание ярлыков: {}", e))?;
  ensure_command_succeeded("Не удалось создать ярлыки", &output)
}

#[cfg(not(windows))]
fn create_shortcuts(_target_exe: &Path, _working_directory: &Path) -> Result<(), String> {
  Err("Создание системных ярлыков поддерживается только в Windows".to_string())
}

#[cfg(windows)]
fn ensure_command_succeeded(context: &str, output: &std::process::Output) -> Result<(), String> {
  if output.status.success() {
    return Ok(());
  }

  let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
  let status = output
    .status
    .code()
    .map(|code| code.to_string())
    .unwrap_or_else(|| "нет кода завершения".to_string());
  if stderr.is_empty() {
    Err(format!("{} (код: {})", context, status))
  } else {
    Err(format!("{} (код: {}): {}", context, status, stderr))
  }
}

#[cfg(windows)]
fn terminate_existing_processes(target_dir: &Path) -> Result<(), String> {
  use std::os::windows::process::CommandExt;
  let output = std::process::Command::new("powershell.exe")
    .args(["-NoProfile", "-NonInteractive", "-Command", include_str!("../installer-processes.ps1")])
    .env("EGOIST_RELAY_INSTALL_DIRECTORY", target_dir)
    .env("EGOIST_RELAY_INSTALLER_PID", std::process::id().to_string())
    .creation_flags(0x08000000)
    .output()
    .map_err(|err| format!("Не удалось проверить процессы установки: {err}"))?;
  ensure_command_succeeded("Не удалось завершить процессы этой установки", &output)
}

#[cfg(not(windows))]
fn terminate_existing_processes(_target_dir: &Path) -> Result<(), String> {
  Ok(())
}
