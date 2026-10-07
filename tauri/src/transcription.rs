use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{
  Arc, LazyLock, Mutex,
  atomic::{AtomicBool, Ordering},
};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager, Webview};

const SAMPLE_RATE: u32 = 16000;
const MAX_AUDIO_BYTES: usize = 64 * 1024 * 1024;
const MAX_DURATION_SECONDS: u32 = 1800;
const MAX_RESULT_BYTES: u64 = 2 * 1024 * 1024;
const JOB_TIMEOUT: Duration = Duration::from_secs(900);
const CANCELED_TTL: Duration = Duration::from_secs(30);

struct ActiveJob {
  request_id: String,
  cancel: Arc<AtomicBool>,
}

static ACTIVE_JOB: LazyLock<Mutex<Option<ActiveJob>>> = LazyLock::new(|| Mutex::new(None));
static CANCELED: LazyLock<Mutex<Vec<(String, Instant)>>> = LazyLock::new(|| Mutex::new(Vec::new()));

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionResult {
  text: String,
  language: Option<String>,
}

struct JobLease(String);

impl Drop for JobLease {
  fn drop(&mut self) {
    if let Ok(mut slot) = ACTIVE_JOB.lock() {
      if slot.as_ref().is_some_and(|job| job.request_id == self.0) {
        *slot = None;
      }
    }
  }
}

struct AudioDirectory(PathBuf);

impl AudioDirectory {
  fn create(base: &Path, request_id: &str) -> Result<Self, String> {
    fs::create_dir_all(base).map_err(|_| "TRANSCRIPTION_STORAGE_FAILED")?;
    let directory = base.join(request_id);
    fs::create_dir(&directory).map_err(|_| "TRANSCRIPTION_STORAGE_FAILED")?;
    let directory = Self(directory);
    fs::write(
      directory.0.join("owner.pid"),
      std::process::id().to_le_bytes(),
    )
    .map_err(|_| "TRANSCRIPTION_STORAGE_FAILED")?;
    Ok(directory)
  }
}

impl Drop for AudioDirectory {
  fn drop(&mut self) {
    let _ = fs::remove_dir_all(&self.0);
  }
}

fn require_main(webview: &Webview) -> Result<(), String> {
  let url = webview.url().map_err(|_| "TRANSCRIPTION_SOURCE_DENIED")?;
  let is_local = (matches!(url.scheme(), "http" | "https")
    && matches!(
      url.host_str(),
      Some("tauri.localhost" | "localhost" | "127.0.0.1")
    ))
    || (url.scheme() == "tauri" && url.host_str() == Some("localhost"));
  if webview.label() != "main" || !is_local {
    return Err("TRANSCRIPTION_SOURCE_DENIED".into());
  }
  Ok(())
}

fn validate_request_id(request_id: &str) -> Result<(), String> {
  if uuid::Uuid::parse_str(request_id).is_err() || request_id.len() != 36 {
    return Err("TRANSCRIPTION_INPUT_INVALID".into());
  }
  Ok(())
}

fn validate_audio(audio: &[u8]) -> Result<(), String> {
  if audio.len() > MAX_AUDIO_BYTES {
    return Err("TRANSCRIPTION_AUDIO_TOO_LARGE".into());
  }
  if audio.len() <= 44
    || &audio[0..4] != b"RIFF"
    || &audio[8..12] != b"WAVE"
    || &audio[12..16] != b"fmt "
    || &audio[36..40] != b"data"
    || u32::from_le_bytes(audio[4..8].try_into().unwrap()) as usize != audio.len() - 8
    || u32::from_le_bytes(audio[16..20].try_into().unwrap()) != 16
    || u16::from_le_bytes(audio[20..22].try_into().unwrap()) != 1
    || u16::from_le_bytes(audio[22..24].try_into().unwrap()) != 1
    || u32::from_le_bytes(audio[24..28].try_into().unwrap()) != SAMPLE_RATE
    || u32::from_le_bytes(audio[28..32].try_into().unwrap()) != SAMPLE_RATE * 2
    || u16::from_le_bytes(audio[32..34].try_into().unwrap()) != 2
    || u16::from_le_bytes(audio[34..36].try_into().unwrap()) != 16
    || u32::from_le_bytes(audio[40..44].try_into().unwrap()) as usize != audio.len() - 44
    || (audio.len() - 44) % 2 != 0
  {
    return Err("TRANSCRIPTION_INPUT_INVALID".into());
  }
  if (audio.len() - 44) / 2 > SAMPLE_RATE as usize * MAX_DURATION_SECONDS as usize {
    return Err("TRANSCRIPTION_AUDIO_TOO_LONG".into());
  }
  if !audio[44..]
    .chunks_exact(2)
    .any(|sample| i16::from_le_bytes([sample[0], sample[1]]).unsigned_abs() > 16)
  {
    return Err("TRANSCRIPTION_NO_SPEECH".into());
  }
  Ok(())
}

fn reserve_job(request_id: &str) -> Result<(JobLease, Arc<AtomicBool>), String> {
  let mut canceled = CANCELED.lock().map_err(|_| "TRANSCRIPTION_UNAVAILABLE")?;
  canceled.retain(|(_, created)| created.elapsed() < CANCELED_TTL);
  if canceled.iter().any(|(id, _)| id == request_id) {
    return Err("TRANSCRIPTION_CANCELED".into());
  }
  let mut slot = ACTIVE_JOB.lock().map_err(|_| "TRANSCRIPTION_UNAVAILABLE")?;
  if slot.is_some() {
    return Err("TRANSCRIPTION_BUSY".into());
  }
  let cancel = Arc::new(AtomicBool::new(false));
  *slot = Some(ActiveJob {
    request_id: request_id.to_owned(),
    cancel: cancel.clone(),
  });
  Ok((JobLease(request_id.to_owned()), cancel))
}

fn find_assets(app: &AppHandle) -> Result<PathBuf, String> {
  let mut candidates = Vec::new();
  if let Ok(resource_dir) = app.path().resource_dir() {
    candidates.push(resource_dir.join("runtime").join("transcription"));
  }
  if let Ok(executable) = std::env::current_exe() {
    if let Some(directory) = executable.parent() {
      candidates.push(directory.join("runtime").join("transcription"));
      candidates.push(
        directory
          .join("resources")
          .join("runtime")
          .join("transcription"),
      );
    }
  }
  #[cfg(debug_assertions)]
  candidates.push(
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
      .join("..")
      .join("runtime")
      .join("transcription"),
  );
  candidates
    .into_iter()
    .find(|directory| {
      directory.join("whisper-cli.exe").is_file()
        && directory.join("ggml-small-q5_1.bin").is_file()
        && directory.join("ggml-silero-v6.2.0.bin").is_file()
    })
    .ok_or_else(|| "TRANSCRIPTION_UNAVAILABLE".to_string())
}

fn cleanup_stale_audio(base: &Path) {
  let Ok(entries) = fs::read_dir(base) else {
    return;
  };
  let active_id = ACTIVE_JOB
    .lock()
    .ok()
    .and_then(|slot| slot.as_ref().map(|job| job.request_id.clone()));
  let mut removed = 0;
  for entry in entries.take(128).flatten() {
    if removed >= 16 {
      break;
    }
    if validate_request_id(&entry.file_name().to_string_lossy()).is_err() {
      continue;
    }
    if active_id.as_deref() == entry.file_name().to_str() {
      continue;
    }
    let Ok(metadata) = fs::symlink_metadata(entry.path()) else {
      continue;
    };
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
      continue;
    }
    #[cfg(windows)]
    {
      use std::os::windows::fs::MetadataExt;
      if metadata.file_attributes() & 0x400 != 0 {
        continue;
      }
    }
    let owner = fs::read(entry.path().join("owner.pid"))
      .ok()
      .and_then(|bytes| <[u8; 4]>::try_from(bytes).ok())
      .map(u32::from_le_bytes);
    let owner_exited = owner.and_then(is_process_alive) == Some(false);
    if (owner_exited
      || metadata
        .modified()
        .ok()
        .and_then(|modified| modified.elapsed().ok())
        .is_some_and(|age| age > JOB_TIMEOUT + Duration::from_secs(60)))
      && fs::remove_dir_all(entry.path()).is_ok()
    {
      removed += 1;
    }
  }
}

#[cfg(windows)]
fn is_process_alive(process_id: u32) -> Option<bool> {
  unsafe extern "system" {
    fn OpenProcess(access: u32, inherit: i32, process_id: u32) -> *mut std::ffi::c_void;
    fn WaitForSingleObject(handle: *mut std::ffi::c_void, milliseconds: u32) -> u32;
    fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
  }
  unsafe {
    let handle = OpenProcess(0x00100000, 0, process_id);
    if handle.is_null() {
      return if std::io::Error::last_os_error().raw_os_error() == Some(87) {
        Some(false)
      } else {
        None
      };
    }
    let status = WaitForSingleObject(handle, 0);
    let _ = CloseHandle(handle);
    match status {
      0 => Some(false),
      0x102 => Some(true),
      _ => None,
    }
  }
}

#[cfg(not(windows))]
fn is_process_alive(_process_id: u32) -> Option<bool> {
  None
}

fn audio_cache_base(app: &AppHandle) -> Result<PathBuf, String> {
  let root = if std::env::var("EGOIST_RELAY_SMOKE_TEST").as_deref() == Ok("1") {
    std::env::var_os("EGOIST_RELAY_TEST_PROFILE")
      .map(PathBuf::from)
      .filter(|path| path.is_absolute() && path.is_dir())
      .ok_or("TRANSCRIPTION_STORAGE_FAILED")?
  } else {
    app
      .path()
      .app_cache_dir()
      .map_err(|_| "TRANSCRIPTION_STORAGE_FAILED")?
  };
  Ok(root.join("transcription"))
}

pub fn initialize(app: &AppHandle) {
  if let Ok(base) = audio_cache_base(app) {
    cleanup_stale_audio(&base);
  }
}

pub fn shutdown() {
  if let Ok(slot) = ACTIVE_JOB.lock() {
    if let Some(job) = slot.as_ref() {
      job.cancel.store(true, Ordering::Release);
    }
  }
  let started = Instant::now();
  while started.elapsed() < Duration::from_secs(2) {
    if ACTIVE_JOB.lock().is_ok_and(|slot| slot.is_none()) {
      break;
    }
    std::thread::sleep(Duration::from_millis(25));
  }
}

#[tauri::command]
pub async fn transcribe_voice(
  webview: Webview,
  app_handle: AppHandle,
  request: tauri::ipc::Request<'_>,
) -> Result<TranscriptionResult, String> {
  require_main(&webview)?;
  let request_id = request
    .headers()
    .get("x-relay-transcription-id")
    .and_then(|header| header.to_str().ok())
    .ok_or("TRANSCRIPTION_INPUT_INVALID")?
    .to_owned();
  validate_request_id(&request_id)?;
  let tauri::ipc::InvokeBody::Raw(audio) = request.body() else {
    return Err("TRANSCRIPTION_INPUT_INVALID".into());
  };
  validate_audio(audio)?;
  let assets = find_assets(&app_handle)?;
  let base = audio_cache_base(&app_handle)?;
  cleanup_stale_audio(&base);
  let (lease, cancel) = reserve_job(&request_id)?;
  let audio = audio.to_owned();
  let progress_id = request_id.clone();
  let _ = app_handle.emit_to(
    "main",
    "relay-transcription-progress",
    serde_json::json!({ "requestId": progress_id, "state": "recognizing" }),
  );
  let result = tauri::async_runtime::spawn_blocking(move || {
    let _lease = lease;
    run_transcription(&assets, &base, &request_id, &audio, &cancel, JOB_TIMEOUT)
  })
  .await
  .map_err(|_| "TRANSCRIPTION_FAILED".to_string())
  .and_then(|result| result);
  let _ = app_handle.emit_to("main", "relay-transcription-progress", serde_json::json!({
    "requestId": progress_id,
    "state": if result.is_ok() { "ready" } else if result.as_ref().is_err_and(|error| error == "TRANSCRIPTION_CANCELED") { "canceled" } else { "error" },
    "code": result.as_ref().err()
  }));
  result
}

#[tauri::command]
pub fn cancel_voice_transcription(webview: Webview, request_id: String) -> Result<bool, String> {
  require_main(&webview)?;
  validate_request_id(&request_id)?;
  let mut canceled = CANCELED.lock().map_err(|_| "TRANSCRIPTION_UNAVAILABLE")?;
  canceled.retain(|(_, created)| created.elapsed() < CANCELED_TTL);
  if canceled.len() >= 64 {
    canceled.remove(0);
  }
  canceled.push((request_id.clone(), Instant::now()));
  let slot = ACTIVE_JOB.lock().map_err(|_| "TRANSCRIPTION_UNAVAILABLE")?;
  if let Some(job) = slot.as_ref().filter(|job| job.request_id == request_id) {
    job.cancel.store(true, Ordering::Release);
    return Ok(true);
  }
  Ok(false)
}

fn run_transcription(
  assets: &Path,
  base: &Path,
  request_id: &str,
  audio: &[u8],
  cancel: &AtomicBool,
  timeout: Duration,
) -> Result<TranscriptionResult, String> {
  if cancel.load(Ordering::Acquire) {
    return Err("TRANSCRIPTION_CANCELED".into());
  }
  let directory = AudioDirectory::create(base, request_id)?;
  let input = directory.0.join("audio.wav");
  let output = directory.0.join("result");
  fs::write(&input, audio).map_err(|_| "TRANSCRIPTION_STORAGE_FAILED")?;
  let threads = std::thread::available_parallelism()
    .map_or(1, |count| count.get().saturating_sub(1).clamp(1, 6));
  let mut command = Command::new(assets.join("whisper-cli.exe"));
  command
    .current_dir(assets)
    .arg("-m")
    .arg(assets.join("ggml-small-q5_1.bin"))
    .arg("-f")
    .arg(&input)
    .args(["-l", "auto", "-ng", "-oj", "-np"])
    .arg("--vad")
    .arg("-vm")
    .arg(assets.join("ggml-silero-v6.2.0.bin"))
    .arg("-t")
    .arg(threads.to_string())
    .arg("-of")
    .arg(&output)
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null());
  #[cfg(windows)]
  {
    use std::os::windows::process::CommandExt;
    command.creation_flags(0x08000000 | 0x00004000);
  }
  let mut child = command.spawn().map_err(|_| "TRANSCRIPTION_UNAVAILABLE")?;
  let _ownership = match crate::worker_job::WorkerJob::attach(&child) {
    Ok(job) => job,
    Err(_) => {
      let _ = child.kill();
      let _ = child.wait();
      return Err("TRANSCRIPTION_UNAVAILABLE".into());
    }
  };
  let started = Instant::now();
  loop {
    let error = if cancel.load(Ordering::Acquire) {
      Some("TRANSCRIPTION_CANCELED")
    } else if started.elapsed() >= timeout {
      Some("TRANSCRIPTION_TIMEOUT")
    } else {
      None
    };
    if let Some(error) = error {
      let _ = child.kill();
      let _ = child.wait();
      return Err(error.into());
    }
    match child.try_wait() {
      Ok(Some(status)) => {
        if !status.success() {
          return Err("TRANSCRIPTION_FAILED".into());
        }
        break;
      }
      Ok(None) => std::thread::sleep(Duration::from_millis(50)),
      Err(_) => {
        let _ = child.kill();
        let _ = child.wait();
        return Err("TRANSCRIPTION_FAILED".into());
      }
    }
  }
  if cancel.load(Ordering::Acquire) {
    return Err("TRANSCRIPTION_CANCELED".into());
  }
  let result_path = output.with_extension("json");
  if fs::metadata(&result_path)
    .map_err(|_| "TRANSCRIPTION_FAILED")?
    .len()
    > MAX_RESULT_BYTES
  {
    return Err("TRANSCRIPTION_FAILED".into());
  }
  let result: serde_json::Value =
    serde_json::from_slice(&fs::read(&result_path).map_err(|_| "TRANSCRIPTION_FAILED")?)
      .map_err(|_| "TRANSCRIPTION_FAILED")?;
  let segments = result
    .get("transcription")
    .and_then(|value| value.as_array())
    .ok_or("TRANSCRIPTION_FAILED")?;
  let text = segments
    .iter()
    .filter_map(|segment| segment.get("text").and_then(|value| value.as_str()))
    .map(str::trim)
    .filter(|text| !text.is_empty())
    .collect::<Vec<_>>()
    .join(" ");
  if text.is_empty() {
    return Err("TRANSCRIPTION_NO_SPEECH".into());
  }
  if cancel.load(Ordering::Acquire) {
    return Err("TRANSCRIPTION_CANCELED".into());
  }
  Ok(TranscriptionResult {
    text,
    language: result
      .get("result")
      .and_then(|value| value.get("language"))
      .and_then(|value| value.as_str())
      .map(str::to_owned),
  })
}
