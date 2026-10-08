use std::{
  collections::{HashMap, HashSet},
  fs::{self, File, OpenOptions},
  io::{Read, Write},
  path::{Path, PathBuf},
  sync::{Mutex, OnceLock},
  time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Webview};

const EVENT_NAME: &str = "relay-media-operation";
const JOURNAL_NAME: &str = "journal-v1.dpapi";
const QUARANTINE_INFIX: &str = ".corrupt-";
const MAX_QUARANTINED_JOURNALS: usize = 3;
const JOURNAL_HEADER: &[u8] = b"ERMO\x01\0\0\0";
const JOURNAL_ENTROPY: &[u8] = b"EgoistRelay/MediaJournal/v1";
const MAX_JOURNAL_BYTES: usize = 4 * 1024 * 1024;
const MAX_ENCRYPTED_BYTES: usize = MAX_JOURNAL_BYTES + 64 * 1024;
const RETENTION_MS: u64 = 30 * 24 * 60 * 60 * 1000;
const MAX_TERMINAL_OPERATIONS: usize = 500;
const MAX_ACTIVE_DOWNLOADS: usize = 64;
const MAX_RELAY_OPERATIONS: usize = 9;
const MAX_MEDIA_ITEMS: usize = 10;
const MAX_SEND_ITEMS: usize = 16;
const MAX_SEND_FILE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_SEND_SET_BYTES: u64 = 128 * 1024 * 1024;
const MAX_FILE_BYTES: u64 = 1 << 50;
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

static REGISTRY: OnceLock<Mutex<Option<Registry>>> = OnceLock::new();

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum MediaOperationKind {
  Save,
  Send,
  Download,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum MediaOperationService {
  X,
  Instagram,
  Telegram,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum MediaOperationMode {
  Link,
  Media,
  File,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum MediaOperationStage {
  Queued,
  Resolving,
  Downloading,
  Writing,
  Preparing,
  Sending,
  Cancelling,
  Completed,
  Failed,
  Cancelled,
  Interrupted,
  Uncertain,
}

impl MediaOperationStage {
  pub(crate) fn is_terminal(self) -> bool {
    matches!(
      self,
      Self::Completed | Self::Failed | Self::Cancelled | Self::Interrupted | Self::Uncertain
    )
  }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MediaOperationFile {
  pub path: PathBuf,
  pub file_name: String,
  pub mime_type: String,
  pub size: u64,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub width: Option<u32>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub height: Option<u32>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MediaMetadata {
  pub file_name: String,
  pub mime_type: String,
  pub size: u64,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub width: Option<u32>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub height: Option<u32>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MediaOperationSend {
  pub account_id: String,
  pub peer_id: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub thread_id: Option<String>,
  pub recipient_name: String,
  pub confirmed: usize,
  pub total: usize,
  #[serde(default, skip_serializing_if = "Vec::is_empty")]
  pub random_ids: Vec<String>,
  #[serde(default, skip_serializing_if = "Vec::is_empty")]
  pub fingerprints: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MediaOperationProgress {
  pub loaded: u64,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub total: Option<u64>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub index: Option<usize>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub count: Option<usize>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MediaOperation {
  pub id: String,
  pub attempt: u32,
  pub revision: u64,
  pub kind: MediaOperationKind,
  pub service: MediaOperationService,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub source_url: Option<String>,
  pub stage: MediaOperationStage,
  pub created_at: u64,
  pub updated_at: u64,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub completed_at: Option<u64>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub file_name: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub item_count: Option<usize>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub mode: Option<MediaOperationMode>,
  pub files: Vec<MediaOperationFile>,
  #[serde(default, skip_serializing_if = "Vec::is_empty")]
  pub media: Vec<MediaMetadata>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub send: Option<MediaOperationSend>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub journal_warning: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub progress: Option<MediaOperationProgress>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NewMediaOperation {
  pub id: String,
  pub kind: MediaOperationKind,
  pub service: MediaOperationService,
  pub source_url: Option<String>,
  pub file_name: Option<String>,
  pub item_count: Option<usize>,
  pub mode: Option<MediaOperationMode>,
  pub send: Option<MediaOperationSend>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MediaOperationPatch {
  pub stage: Option<MediaOperationStage>,
  pub progress: Option<MediaOperationProgress>,
  pub error: Option<String>,
  pub confirmed: Option<usize>,
  pub total: Option<usize>,
  pub random_ids: Option<Vec<String>>,
  pub fingerprints: Option<Vec<String>>,
  pub source_url: Option<String>,
  pub file_name: Option<String>,
  pub media: Option<Vec<MediaMetadata>>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum MediaOperationAction {
  Register {
    operation: NewMediaOperation,
  },
  Update {
    id: String,
    attempt: u32,
    revision: u64,
    patch: MediaOperationPatch,
  },
  Cancel {
    id: String,
  },
  Retry {
    id: String,
    #[serde(rename = "accountId")]
    account_id: Option<String>,
  },
  Remove {
    id: String,
  },
  Clear,
  Lock {
    #[serde(rename = "isLocked")]
    is_locked: bool,
  },
  Open {
    id: String,
    index: Option<usize>,
  },
  Reveal {
    id: String,
    index: Option<usize>,
  },
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaOperationsSnapshot {
  pub operations: Vec<MediaOperation>,
  pub is_locked: bool,
  pub epoch: u64,
  /// Load error code that made the startup move an unreadable journal into quarantine.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub journal_notice: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Journal {
  version: u32,
  operations: Vec<MediaOperation>,
}

struct Registry {
  directory: PathBuf,
  operations: Vec<MediaOperation>,
  is_locked: bool,
  load_error: Option<String>,
  journal_notice: Option<String>,
  cancelled_downloads: Vec<String>,
  cancel_requested: HashSet<String>,
  progress_emitted_at: HashMap<String, Instant>,
  epoch: u64,
}

impl Registry {
  fn load(directory: PathBuf, now: u64) -> Self {
    let (mut operations, load_error, journal_notice) = match load_journal(&directory) {
      Ok(operations) => (operations, None, None),
      // An unreadable journal must not block every download: keep the file aside and start empty.
      Err(error) if is_unreadable_journal_error(&error) => {
        match quarantine_journal(&directory, now) {
          Ok(()) => (Vec::new(), None, Some(error)),
          Err(_) => (Vec::new(), Some(error), None),
        }
      }
      Err(error) => (Vec::new(), Some(error), None),
    };
    let recovered = recover_operations(&mut operations, now);
    let retained = prune_operations(&mut operations, now);
    let mut registry = Self {
      directory,
      operations,
      is_locked: true,
      load_error,
      journal_notice,
      cancelled_downloads: Vec::new(),
      cancel_requested: HashSet::new(),
      progress_emitted_at: HashMap::new(),
      epoch: 0,
    };
    if registry.load_error.is_none() && (recovered || retained) {
      if let Err(error) = persist_journal(&registry.directory, &registry.operations) {
        registry.load_error = Some(error);
      }
    }
    registry
  }

  fn ensure_available(&self) -> Result<(), String> {
    self.load_error.clone().map_or(Ok(()), Err)
  }

  fn snapshot(&self) -> Result<MediaOperationsSnapshot, String> {
    self.ensure_available()?;
    Ok(MediaOperationsSnapshot {
      operations: if self.is_locked {
        Vec::new()
      } else {
        self.operations.clone()
      },
      is_locked: self.is_locked,
      epoch: self.epoch,
      journal_notice: self.journal_notice.clone(),
    })
  }

  fn ensure_unlocked(&self) -> Result<(), String> {
    self.ensure_available()?;
    if self.is_locked {
      return Err("MEDIA_JOURNAL_LOCKED".into());
    }
    Ok(())
  }

  fn set_locked(&mut self, is_locked: bool) -> Result<(), String> {
    let epoch = self
      .epoch
      .checked_add(1)
      .ok_or("MEDIA_JOURNAL_UNAVAILABLE")?;
    self.is_locked = is_locked;
    self.epoch = epoch;
    Ok(())
  }

  fn commit(&mut self, mut operations: Vec<MediaOperation>, now: u64) -> Result<(), String> {
    self.ensure_available()?;
    prune_operations(&mut operations, now);
    for operation in &mut operations {
      operation.journal_warning = None;
    }
    for operation in &operations {
      validate_operation(operation)?;
    }
    let epoch = self
      .epoch
      .checked_add(1)
      .ok_or("MEDIA_JOURNAL_UNAVAILABLE")?;
    persist_journal(&self.directory, &operations)?;
    self.operations = operations;
    self.epoch = epoch;
    let retained: HashSet<_> = self
      .operations
      .iter()
      .map(|operation| operation.id.clone())
      .collect();
    self.cancel_requested.retain(|id| retained.contains(id));
    self.cancelled_downloads.retain(|id| retained.contains(id));
    self.progress_emitted_at.retain(|id, _| {
      self
        .operations
        .iter()
        .any(|operation| operation.id == *id && !operation.stage.is_terminal())
    });
    Ok(())
  }

  fn register(&mut self, input: NewMediaOperation, now: u64, internal: bool) -> Result<(), String> {
    self.ensure_available()?;
    if !internal && input.kind == MediaOperationKind::Send {
      self.ensure_unlocked()?;
    }
    if self
      .operations
      .iter()
      .any(|operation| operation.id == input.id)
    {
      return Err("MEDIA_OPERATION_EXISTS".into());
    }
    let active = self
      .operations
      .iter()
      .filter(|operation| !operation.stage.is_terminal());
    let count = if input.kind == MediaOperationKind::Download {
      active
        .filter(|operation| operation.kind == MediaOperationKind::Download)
        .count()
    } else {
      active
        .filter(|operation| operation.kind != MediaOperationKind::Download)
        .count()
    };
    if count
      >= if input.kind == MediaOperationKind::Download {
        MAX_ACTIVE_DOWNLOADS
      } else {
        MAX_RELAY_OPERATIONS
      }
    {
      return Err("MEDIA_QUEUE_FULL".into());
    }
    let source_url = input
      .source_url
      .as_deref()
      .map(|value| canonicalize_source_url(input.service, value))
      .transpose()?;
    let operation = MediaOperation {
      id: input.id,
      attempt: 1,
      revision: 1,
      kind: input.kind,
      service: input.service,
      source_url,
      stage: MediaOperationStage::Queued,
      created_at: now,
      updated_at: now,
      completed_at: None,
      file_name: input.file_name,
      item_count: input.item_count,
      mode: input.mode,
      files: Vec::new(),
      media: Vec::new(),
      send: input.send,
      error: None,
      journal_warning: None,
      progress: None,
    };
    validate_operation(&operation)?;
    if operation
      .send
      .as_ref()
      .is_some_and(|send| send.confirmed != 0)
    {
      return Err("MEDIA_INPUT_DENIED".into());
    }
    let mut operations = self.operations.clone();
    operations.push(operation);
    self.commit(operations, now)
  }

  fn commit_known_result(
    &mut self,
    mut operations: Vec<MediaOperation>,
    id: &str,
    now: u64,
  ) -> Result<(), String> {
    for operation in &operations {
      validate_operation(operation)?;
    }
    let result = self.commit(operations.clone(), now);
    if let Err(error) = &result {
      find_operation_mut(&mut operations, id)?.journal_warning = Some(error.clone());
      self.operations = operations;
      self.epoch = self
        .epoch
        .checked_add(1)
        .ok_or("MEDIA_JOURNAL_UNAVAILABLE")?;
    }
    result
  }

  fn update(
    &mut self,
    id: &str,
    attempt: u32,
    revision: u64,
    patch: MediaOperationPatch,
    now: u64,
  ) -> Result<bool, String> {
    self.ensure_available()?;
    let mut operations = self.operations.clone();
    let operation = find_operation_mut(&mut operations, id)?;
    if operation.attempt != attempt || operation.revision != revision {
      return Err("MEDIA_OPERATION_STALE".into());
    }
    let is_persistent = patch.stage.is_some()
      || patch.error.is_some()
      || patch.confirmed.is_some()
      || patch.total.is_some()
      || patch.random_ids.is_some()
      || patch.fingerprints.is_some()
      || patch.source_url.is_some()
      || patch.file_name.is_some()
      || patch.media.is_some();
    if let Some(stage) = patch.stage {
      if stage == MediaOperationStage::Sending && self.is_locked {
        return Err("MEDIA_JOURNAL_LOCKED".into());
      }
      if !can_transition(operation.stage, stage) {
        return Err("MEDIA_STAGE_DENIED".into());
      }
      if stage != operation.stage {
        operation.stage = stage;
        operation.progress = None;
        if matches!(
          stage,
          MediaOperationStage::Queued
            | MediaOperationStage::Resolving
            | MediaOperationStage::Completed
        ) {
          operation.error = None;
        }
      }
    }
    if let Some(progress) = patch.progress {
      operation.progress = Some(progress);
    }
    if let Some(error) = patch.error {
      operation.error = Some(error);
    }
    if let Some(source_url) = patch.source_url {
      let source_url = canonicalize_source_url(operation.service, &source_url)?;
      if operation
        .source_url
        .as_ref()
        .is_some_and(|current| current != &source_url)
      {
        return Err("MEDIA_INPUT_DENIED".into());
      }
      operation.source_url = Some(source_url);
    }
    if let Some(file_name) = patch.file_name {
      if operation
        .file_name
        .as_ref()
        .is_some_and(|current| current != &file_name)
      {
        return Err("MEDIA_INPUT_DENIED".into());
      }
      operation.file_name = Some(file_name);
    }
    if let Some(media) = patch.media {
      if operation.kind != MediaOperationKind::Send
        || !matches!(
          operation.stage,
          MediaOperationStage::Queued
            | MediaOperationStage::Resolving
            | MediaOperationStage::Downloading
            | MediaOperationStage::Writing
            | MediaOperationStage::Preparing
        )
      {
        return Err("MEDIA_INPUT_DENIED".into());
      }
      operation.media = media;
    }
    let modifies_send = patch.confirmed.is_some()
      || patch.total.is_some()
      || patch.random_ids.is_some()
      || patch.fingerprints.is_some();
    if modifies_send {
      let send = operation.send.as_mut().ok_or("MEDIA_INPUT_DENIED")?;
      if let Some(total) = patch.total {
        if send.total != total
          && (send.confirmed > 0
            || matches!(
              operation.stage,
              MediaOperationStage::Sending | MediaOperationStage::Cancelling
            ))
        {
          return Err("MEDIA_SOURCE_CHANGED".into());
        }
        send.total = total;
      }
      if let Some(confirmed) = patch.confirmed {
        if confirmed < send.confirmed {
          return Err("MEDIA_CONFIRMATION_DENIED".into());
        }
        send.confirmed = confirmed;
      }
      if let Some(random_ids) = patch.random_ids {
        if !send.random_ids.is_empty() && send.random_ids != random_ids {
          return Err("MEDIA_SOURCE_CHANGED".into());
        }
        send.random_ids = random_ids;
      }
      if let Some(fingerprints) = patch.fingerprints {
        if !send.fingerprints.is_empty() && send.fingerprints != fingerprints {
          return Err("MEDIA_SOURCE_CHANGED".into());
        }
        send.fingerprints = fingerprints;
      }
    }
    if operation.stage.is_terminal() {
      operation.completed_at = Some(
        operation
          .completed_at
          .unwrap_or(now.max(operation.updated_at)),
      );
      operation.progress = None;
    }
    if is_persistent {
      operation.revision = operation
        .revision
        .checked_add(1)
        .ok_or("MEDIA_INPUT_DENIED")?;
      operation.updated_at = now.max(operation.updated_at);
    }
    validate_operation(operation)?;
    if is_persistent {
      if operation.stage.is_terminal() {
        self.commit_known_result(operations, id, now)?;
      } else {
        self.commit(operations, now)?;
      }
    } else {
      self.operations = operations;
      self.epoch = self
        .epoch
        .checked_add(1)
        .ok_or("MEDIA_JOURNAL_UNAVAILABLE")?;
    }
    Ok(is_persistent)
  }

  fn cancel(&mut self, id: &str, now: u64) -> Result<(), String> {
    self.ensure_unlocked()?;
    let mut operations = self.operations.clone();
    let operation = find_operation_mut(&mut operations, id)?;
    if operation.stage.is_terminal() {
      return Err("MEDIA_OPERATION_FINISHED".into());
    }
    let is_download = operation.kind == MediaOperationKind::Download;
    operation.stage = if operation.stage == MediaOperationStage::Queued {
      MediaOperationStage::Cancelled
    } else {
      MediaOperationStage::Cancelling
    };
    operation.progress = None;
    operation.revision = operation
      .revision
      .checked_add(1)
      .ok_or("MEDIA_INPUT_DENIED")?;
    operation.updated_at = now.max(operation.updated_at);
    if operation.stage.is_terminal() {
      operation.completed_at = Some(operation.updated_at);
    }
    self.cancel_requested.insert(id.to_string());
    if is_download && !self.cancelled_downloads.iter().any(|current| current == id) {
      self.cancelled_downloads.push(id.to_string());
    }
    self.commit_known_result(operations, id, now)
  }

  fn retry(&mut self, id: &str, account_id: Option<&str>, now: u64) -> Result<(), String> {
    self.ensure_unlocked()?;
    let mut operations = self.operations.clone();
    let operation = find_operation_mut(&mut operations, id)?;
    if operation.stage == MediaOperationStage::Uncertain {
      return Err("MEDIA_OUTCOME_UNCERTAIN".into());
    }
    if !matches!(
      operation.stage,
      MediaOperationStage::Failed
        | MediaOperationStage::Cancelled
        | MediaOperationStage::Interrupted
    ) {
      return Err("MEDIA_STAGE_DENIED".into());
    }
    if let Some(send) = &operation.send {
      if account_id != Some(send.account_id.as_str()) {
        return Err("MEDIA_ACCOUNT_CHANGED".into());
      }
    }
    if operation.kind == MediaOperationKind::Download && operation.source_url.is_none() {
      return Err("MEDIA_RETRY_FROM_SOURCE".into());
    }
    let active_count = self
      .operations
      .iter()
      .filter(|item| !item.stage.is_terminal() && item.kind != MediaOperationKind::Download)
      .count();
    if operation.kind != MediaOperationKind::Download && active_count >= MAX_RELAY_OPERATIONS {
      return Err("MEDIA_QUEUE_FULL".into());
    }
    operation.attempt = operation
      .attempt
      .checked_add(1)
      .ok_or("MEDIA_INPUT_DENIED")?;
    operation.revision = operation
      .revision
      .checked_add(1)
      .ok_or("MEDIA_INPUT_DENIED")?;
    operation.stage = MediaOperationStage::Queued;
    operation.completed_at = None;
    operation.progress = None;
    operation.error = None;
    operation.updated_at = now.max(operation.updated_at);
    self.commit(operations, now)?;
    self.cancel_requested.remove(id);
    self.progress_emitted_at.remove(id);
    Ok(())
  }

  fn remove(&mut self, id: Option<&str>, now: u64) -> Result<(), String> {
    self.ensure_unlocked()?;
    if let Some(id) = id {
      let operation = self
        .operations
        .iter()
        .find(|item| item.id == id)
        .ok_or("MEDIA_OPERATION_NOT_FOUND")?;
      if !operation.stage.is_terminal() {
        return Err("MEDIA_OPERATION_ACTIVE".into());
      }
    }
    let operations = self
      .operations
      .iter()
      .filter(|operation| {
        if let Some(id) = id {
          operation.id != id
        } else {
          !operation.stage.is_terminal()
        }
      })
      .cloned()
      .collect();
    self.commit(operations, now)
  }

  fn register_file(&mut self, id: &str, file: MediaOperationFile, now: u64) -> Result<(), String> {
    self.ensure_available()?;
    validate_file(&file)?;
    let mut operations = self.operations.clone();
    let operation = find_operation_mut(&mut operations, id)?;
    if operation.stage.is_terminal() {
      return Err("MEDIA_OPERATION_FINISHED".into());
    }
    if operation.files.iter().any(|item| item.path == file.path) {
      return Ok(());
    }
    if operation.files.len() >= MAX_MEDIA_ITEMS {
      return Err("MEDIA_BATCH_TOO_LARGE".into());
    }
    if operation.file_name.is_none() {
      operation.file_name = Some(file.file_name.clone());
    }
    operation.files.push(file);
    operation.revision = operation
      .revision
      .checked_add(1)
      .ok_or("MEDIA_INPUT_DENIED")?;
    operation.updated_at = now.max(operation.updated_at);
    validate_operation(operation)?;
    self.commit_known_result(operations, id, now)
  }

  fn should_emit_progress(&mut self, id: &str) -> bool {
    let now = Instant::now();
    if self
      .progress_emitted_at
      .get(id)
      .is_some_and(|previous| now.duration_since(*previous) < PROGRESS_INTERVAL)
    {
      return false;
    }
    self.progress_emitted_at.insert(id.to_string(), now);
    true
  }
}

pub(crate) fn initialize(app: &AppHandle) -> Result<(), String> {
  let directory = crate::multi_app::get_service_data_directory(app, "media-operations")?;
  let mut registry = REGISTRY
    .get_or_init(|| Mutex::new(None))
    .lock()
    .map_err(|_| "MEDIA_JOURNAL_BUSY")?;
  if registry.is_none() {
    *registry = Some(Registry::load(directory, now_ms()));
  }
  registry
    .as_ref()
    .ok_or("MEDIA_JOURNAL_UNAVAILABLE")?
    .ensure_available()
}

#[tauri::command]
pub(crate) fn relay_media_operations_list(
  webview: Webview,
  app: AppHandle,
) -> Result<MediaOperationsSnapshot, String> {
  crate::social_share::require_main(&webview)?;
  initialize(&app)?;
  let mut guard = REGISTRY
    .get()
    .ok_or("MEDIA_JOURNAL_UNAVAILABLE")?
    .lock()
    .map_err(|_| "MEDIA_JOURNAL_BUSY")?;
  let registry = guard.as_mut().ok_or("MEDIA_JOURNAL_UNAVAILABLE")?;
  let mut operations = registry.operations.clone();
  let now = now_ms();
  if prune_operations(&mut operations, now) {
    registry.commit(operations, now)?;
  }
  registry.snapshot()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaOperationRevision {
  attempt: u32,
  revision: u64,
  stage: MediaOperationStage,
}

#[tauri::command]
pub(crate) fn relay_media_operation_revision(
  webview: Webview,
  app: AppHandle,
  id: String,
) -> Result<MediaOperationRevision, String> {
  crate::social_share::require_main(&webview)?;
  initialize(&app)?;
  let guard = REGISTRY
    .get()
    .ok_or("MEDIA_JOURNAL_UNAVAILABLE")?
    .lock()
    .map_err(|_| "MEDIA_JOURNAL_BUSY")?;
  let registry = guard.as_ref().ok_or("MEDIA_JOURNAL_UNAVAILABLE")?;
  registry.ensure_available()?;
  let operation = registry
    .operations
    .iter()
    .find(|operation| operation.id == id)
    .ok_or("MEDIA_OPERATION_NOT_FOUND")?;
  Ok(MediaOperationRevision {
    attempt: operation.attempt,
    revision: operation.revision,
    stage: operation.stage,
  })
}

#[tauri::command]
pub(crate) fn relay_media_operation_action(
  webview: Webview,
  app: AppHandle,
  action: MediaOperationAction,
) -> Result<MediaOperationsSnapshot, String> {
  crate::social_share::require_main(&webview)?;
  initialize(&app)?;
  let mut registry_guard = REGISTRY
    .get()
    .ok_or("MEDIA_JOURNAL_UNAVAILABLE")?
    .lock()
    .map_err(|_| "MEDIA_JOURNAL_BUSY")?;
  let registry = registry_guard.as_mut().ok_or("MEDIA_JOURNAL_UNAVAILABLE")?;
  let now = now_ms();
  let mut should_emit = true;
  let mut open_path = None;
  let mut cancel_id = None;
  let mut action_error = None;
  match action {
    MediaOperationAction::Register { operation } => registry.register(operation, now, false)?,
    MediaOperationAction::Update {
      id,
      attempt,
      revision,
      patch,
    } => {
      let epoch = registry.epoch;
      match registry.update(&id, attempt, revision, patch, now) {
        Ok(persistent) => should_emit = persistent || registry.should_emit_progress(&id),
        Err(error) => {
          should_emit = registry.epoch != epoch;
          action_error = Some(error);
        }
      }
    }
    MediaOperationAction::Cancel { id } => {
      action_error = registry.cancel(&id, now).err();
      if registry.cancelled_downloads.contains(&id) {
        cancel_id = Some(id);
      }
    }
    MediaOperationAction::Retry { id, account_id } => {
      registry.retry(&id, account_id.as_deref(), now)?
    }
    MediaOperationAction::Remove { id } => registry.remove(Some(&id), now)?,
    MediaOperationAction::Clear => registry.remove(None, now)?,
    MediaOperationAction::Lock { is_locked } => registry.set_locked(is_locked)?,
    MediaOperationAction::Open { id, index } => {
      registry.ensure_unlocked()?;
      open_path = Some((
        find_registered_path(registry, &id, index.unwrap_or(0))?,
        false,
      ));
      should_emit = false;
    }
    MediaOperationAction::Reveal { id, index } => {
      registry.ensure_unlocked()?;
      open_path = Some((
        find_registered_path(registry, &id, index.unwrap_or(0))?,
        true,
      ));
      should_emit = false;
    }
  }
  let snapshot = registry.snapshot()?;
  drop(registry_guard);
  if let Some((path, reveal)) = open_path {
    open_registered_path(&path, reveal)?;
  }
  if should_emit {
    emit_snapshot(&app, &snapshot);
  }
  if let Some(id) = cancel_id {
    let _ = app.emit(
      "relay-media-cancel-download",
      serde_json::json!({ "operationId": id }),
    );
  }
  if let Some(error) = action_error {
    return Err(error);
  }
  Ok(snapshot)
}

pub(crate) fn record_saved_file(
  app: &AppHandle,
  operation_id: &str,
  path: &Path,
  file_name: &str,
  mime_type: &str,
  size: u64,
) -> Result<(), String> {
  let file = inspect_saved_file(path, file_name, mime_type, size)?;
  record_verified_file(app, operation_id, file)
}

pub(crate) fn record_saved_file_with_dimensions(
  app: &AppHandle,
  operation_id: &str,
  path: &Path,
  file_name: &str,
  mime_type: &str,
  size: u64,
  width: Option<u32>,
  height: Option<u32>,
) -> Result<(), String> {
  if width.is_none() && height.is_none() {
    return record_saved_file(app, operation_id, path, file_name, mime_type, size);
  }
  let mut file = inspect_saved_file(path, file_name, mime_type, size)?;
  file.width = width;
  file.height = height;
  validate_file(&file)?;
  record_verified_file(app, operation_id, file)
}

fn record_verified_file(
  app: &AppHandle,
  operation_id: &str,
  file: MediaOperationFile,
) -> Result<(), String> {
  initialize(app)?;
  let mut guard = REGISTRY
    .get()
    .ok_or("MEDIA_JOURNAL_UNAVAILABLE")?
    .lock()
    .map_err(|_| "MEDIA_JOURNAL_BUSY")?;
  let registry = guard.as_mut().ok_or("MEDIA_JOURNAL_UNAVAILABLE")?;
  let result = registry.register_file(operation_id, file, now_ms());
  let snapshot = registry.snapshot()?;
  drop(guard);
  emit_snapshot(app, &snapshot);
  result
}

pub(crate) fn register_download(
  app: &AppHandle,
  service: &str,
  source_url: Option<&str>,
  file_name: &str,
) -> Result<String, String> {
  let service = parse_service(service)?;
  let id = uuid::Uuid::new_v4().to_string();
  let source_url = source_url
    .filter(|value| validate_source_url(service, value).is_ok())
    .map(str::to_string);
  initialize(app)?;
  let snapshot = {
    let mut guard = REGISTRY
      .get()
      .ok_or("MEDIA_JOURNAL_UNAVAILABLE")?
      .lock()
      .map_err(|_| "MEDIA_JOURNAL_BUSY")?;
    let registry = guard.as_mut().ok_or("MEDIA_JOURNAL_UNAVAILABLE")?;
    registry.register(
      NewMediaOperation {
        id: id.clone(),
        kind: MediaOperationKind::Download,
        service,
        source_url,
        file_name: Some(file_name.to_string()),
        item_count: None,
        mode: None,
        send: None,
      },
      now_ms(),
      true,
    )?;
    registry.snapshot()?
  };
  emit_snapshot(app, &snapshot);
  Ok(id)
}

pub(crate) fn start_download(app: &AppHandle, id: &str) -> Result<(), String> {
  initialize(app)?;
  let mut guard = REGISTRY
    .get()
    .ok_or("MEDIA_JOURNAL_UNAVAILABLE")?
    .lock()
    .map_err(|_| "MEDIA_JOURNAL_BUSY")?;
  let registry = guard.as_mut().ok_or("MEDIA_JOURNAL_UNAVAILABLE")?;
  let operation = registry
    .operations
    .iter()
    .find(|operation| operation.id == id)
    .ok_or("MEDIA_OPERATION_NOT_FOUND")?;
  if operation.kind != MediaOperationKind::Download {
    return Err("MEDIA_STAGE_DENIED".into());
  }
  let (attempt, revision) = (operation.attempt, operation.revision);
  registry.update(
    id,
    attempt,
    revision,
    MediaOperationPatch {
      stage: Some(MediaOperationStage::Downloading),
      ..Default::default()
    },
    now_ms(),
  )?;
  let snapshot = registry.snapshot()?;
  drop(guard);
  emit_snapshot(app, &snapshot);
  Ok(())
}

pub(crate) fn update_download_progress(
  app: &AppHandle,
  id: &str,
  loaded: u64,
  total: Option<u64>,
) -> Result<(), String> {
  initialize(app)?;
  let mut guard = REGISTRY
    .get()
    .ok_or("MEDIA_JOURNAL_UNAVAILABLE")?
    .lock()
    .map_err(|_| "MEDIA_JOURNAL_BUSY")?;
  let registry = guard.as_mut().ok_or("MEDIA_JOURNAL_UNAVAILABLE")?;
  let operation = registry
    .operations
    .iter_mut()
    .find(|operation| operation.id == id)
    .ok_or("MEDIA_OPERATION_NOT_FOUND")?;
  if operation.kind != MediaOperationKind::Download || operation.stage.is_terminal() {
    return Err("MEDIA_STAGE_DENIED".into());
  }
  let progress = MediaOperationProgress {
    loaded,
    total: total.filter(|value| *value > 0),
    index: None,
    count: None,
  };
  validate_progress(&progress)?;
  operation.progress = Some(progress);
  registry.epoch = registry
    .epoch
    .checked_add(1)
    .ok_or("MEDIA_JOURNAL_UNAVAILABLE")?;
  let should_emit = registry.should_emit_progress(id);
  let snapshot = registry.snapshot()?;
  drop(guard);
  if should_emit {
    emit_snapshot(app, &snapshot);
  }
  Ok(())
}

pub(crate) fn finish_download(
  app: &AppHandle,
  id: &str,
  path: Option<&Path>,
  success: bool,
) -> Result<(), String> {
  initialize(app)?;
  let file = if success {
    let path = path.ok_or("MEDIA_FILE_MISSING")?;
    let file_name = path
      .file_name()
      .ok_or("MEDIA_FILE_MISSING")?
      .to_string_lossy()
      .into_owned();
    let size = fs::metadata(path).map_err(|_| "MEDIA_FILE_MISSING")?.len();
    Some(inspect_saved_file(
      path,
      &file_name,
      "application/octet-stream",
      size,
    )?)
  } else {
    None
  };
  let mut guard = REGISTRY
    .get()
    .ok_or("MEDIA_JOURNAL_UNAVAILABLE")?
    .lock()
    .map_err(|_| "MEDIA_JOURNAL_BUSY")?;
  let registry = guard.as_mut().ok_or("MEDIA_JOURNAL_UNAVAILABLE")?;
  let mut operations = registry.operations.clone();
  let operation = find_operation_mut(&mut operations, id)?;
  if operation.kind != MediaOperationKind::Download {
    return Err("MEDIA_STAGE_DENIED".into());
  }
  if operation.stage.is_terminal() {
    return Ok(());
  }
  if let Some(file) = file {
    operation.file_name = Some(file.file_name.clone());
    operation.files = vec![file];
    operation.stage = MediaOperationStage::Completed;
    operation.error = None;
  } else if registry.cancel_requested.contains(id) {
    operation.stage = MediaOperationStage::Cancelled;
    operation.error = None;
  } else {
    operation.stage = MediaOperationStage::Failed;
    operation.error = Some("MEDIA_DOWNLOAD_FAILED".into());
  }
  operation.progress = None;
  operation.updated_at = now_ms().max(operation.updated_at);
  operation.completed_at = Some(operation.updated_at);
  operation.revision = operation
    .revision
    .checked_add(1)
    .ok_or("MEDIA_INPUT_DENIED")?;
  let now = operation.updated_at;
  let result = registry.commit_known_result(operations, id, now);
  registry.cancel_requested.remove(id);
  registry.progress_emitted_at.remove(id);
  let snapshot = registry.snapshot()?;
  drop(guard);
  emit_snapshot(app, &snapshot);
  result
}

pub(crate) fn take_cancelled_downloads() -> Vec<String> {
  let Some(lock) = REGISTRY.get() else {
    return Vec::new();
  };
  let Ok(mut guard) = lock.lock() else {
    return Vec::new();
  };
  guard
    .as_mut()
    .map(|registry| std::mem::take(&mut registry.cancelled_downloads))
    .unwrap_or_default()
}

pub(crate) fn is_cancel_requested(id: &str) -> bool {
  REGISTRY
    .get()
    .and_then(|lock| lock.lock().ok())
    .and_then(|guard| {
      guard
        .as_ref()
        .map(|registry| registry.cancel_requested.contains(id))
    })
    .unwrap_or(false)
}

pub(crate) fn restore_social_source(
  app: &AppHandle,
  operation_id: &str,
) -> Result<(String, String, Option<usize>), String> {
  initialize(app)?;
  let guard = REGISTRY
    .get()
    .ok_or("MEDIA_JOURNAL_UNAVAILABLE")?
    .lock()
    .map_err(|_| "MEDIA_JOURNAL_BUSY")?;
  let registry = guard.as_ref().ok_or("MEDIA_JOURNAL_UNAVAILABLE")?;
  registry.ensure_unlocked()?;
  let operation = registry
    .operations
    .iter()
    .find(|operation| operation.id == operation_id)
    .ok_or("MEDIA_OPERATION_NOT_FOUND")?;
  if operation.stage != MediaOperationStage::Queued
    || operation.kind == MediaOperationKind::Download
  {
    return Err("MEDIA_STAGE_DENIED".into());
  }
  let service = match operation.service {
    MediaOperationService::X => "x",
    MediaOperationService::Instagram => "instagram",
    MediaOperationService::Telegram => return Err("MEDIA_SOURCE_DENIED".into()),
  };
  let source = operation.source_url.clone().ok_or("MEDIA_SOURCE_DENIED")?;
  validate_source_url(operation.service, &source)?;
  Ok((service.to_string(), source, operation.item_count))
}

pub(crate) fn operation_source(
  app: &AppHandle,
  operation_id: &str,
) -> Result<(String, String), String> {
  initialize(app)?;
  let guard = REGISTRY
    .get()
    .ok_or("MEDIA_JOURNAL_UNAVAILABLE")?
    .lock()
    .map_err(|_| "MEDIA_JOURNAL_BUSY")?;
  let registry = guard.as_ref().ok_or("MEDIA_JOURNAL_UNAVAILABLE")?;
  registry.ensure_unlocked()?;
  let operation = registry
    .operations
    .iter()
    .find(|operation| operation.id == operation_id)
    .ok_or("MEDIA_OPERATION_NOT_FOUND")?;
  let service = match operation.service {
    MediaOperationService::X => "x",
    MediaOperationService::Instagram => "instagram",
    MediaOperationService::Telegram => "telegram",
  };
  let source = operation.source_url.clone().ok_or("MEDIA_SOURCE_DENIED")?;
  validate_source_url(operation.service, &source)?;
  Ok((service.to_string(), source))
}

pub(crate) fn bind_social_capture(
  app: &AppHandle,
  operation_id: &str,
  service: &str,
  url: &str,
) -> Result<(), String> {
  initialize(app)?;
  let guard = REGISTRY
    .get()
    .ok_or("MEDIA_JOURNAL_UNAVAILABLE")?
    .lock()
    .map_err(|_| "MEDIA_JOURNAL_BUSY")?;
  let registry = guard.as_ref().ok_or("MEDIA_JOURNAL_UNAVAILABLE")?;
  registry.ensure_available()?;
  let operation = registry
    .operations
    .iter()
    .find(|operation| operation.id == operation_id)
    .ok_or("MEDIA_OPERATION_NOT_FOUND")?;
  if operation.kind == MediaOperationKind::Send {
    registry.ensure_unlocked()?;
  }
  if operation.stage != MediaOperationStage::Queued
    || operation.kind == MediaOperationKind::Download
    || operation.service != parse_service(service)?
  {
    return Err("MEDIA_SOURCE_DENIED".into());
  }
  validate_source_url(operation.service, url)?;
  let expected = operation
    .source_url
    .as_deref()
    .ok_or("MEDIA_SOURCE_DENIED")?;
  if crate::inline_media::canonicalize_media_url(expected)?
    != crate::inline_media::canonicalize_media_url(url)?
  {
    return Err("MEDIA_SOURCE_DENIED".into());
  }
  Ok(())
}

fn emit_snapshot(app: &AppHandle, snapshot: &MediaOperationsSnapshot) {
  if let Err(error) = app.emit_to("main", EVENT_NAME, snapshot) {
    log::debug!("Media operation notification unavailable: {error}");
  }
}

fn find_operation_mut<'a>(
  operations: &'a mut [MediaOperation],
  id: &str,
) -> Result<&'a mut MediaOperation, String> {
  operations
    .iter_mut()
    .find(|operation| operation.id == id)
    .ok_or_else(|| "MEDIA_OPERATION_NOT_FOUND".into())
}

fn can_transition(from: MediaOperationStage, to: MediaOperationStage) -> bool {
  use MediaOperationStage::*;
  if from == to {
    return !from.is_terminal();
  }
  if to == Interrupted {
    return !from.is_terminal();
  }
  if to == Cancelled {
    return !from.is_terminal();
  }
  match from {
    Queued => matches!(
      to,
      Resolving | Downloading | Writing | Preparing | Sending | Cancelled | Failed
    ),
    Resolving => matches!(
      to,
      Downloading | Writing | Preparing | Sending | Failed | Cancelling
    ),
    Downloading => matches!(
      to,
      Writing | Preparing | Sending | Completed | Failed | Cancelling
    ),
    Writing => matches!(to, Downloading | Completed | Failed | Cancelling),
    Preparing => matches!(to, Downloading | Sending | Failed | Cancelling),
    Sending => matches!(to, Completed | Failed | Cancelling | Uncertain),
    Cancelling => matches!(to, Completed | Cancelled | Failed | Uncertain),
    Completed | Failed | Cancelled | Interrupted | Uncertain => false,
  }
}

fn recover_operations(operations: &mut [MediaOperation], now: u64) -> bool {
  let mut changed = false;
  for operation in operations {
    if operation.stage.is_terminal() {
      continue;
    }
    operation.stage = if operation.kind == MediaOperationKind::Send
      && matches!(
        operation.stage,
        MediaOperationStage::Sending | MediaOperationStage::Cancelling
      ) {
      MediaOperationStage::Uncertain
    } else {
      MediaOperationStage::Interrupted
    };
    operation.updated_at = now.max(operation.updated_at);
    operation.completed_at = Some(operation.updated_at);
    operation.revision = operation.revision.saturating_add(1);
    operation.progress = None;
    operation.error = Some(if operation.stage == MediaOperationStage::Uncertain {
      "MEDIA_OUTCOME_UNCERTAIN".into()
    } else {
      "MEDIA_OPERATION_INTERRUPTED".into()
    });
    changed = true;
  }
  changed
}

fn prune_operations(operations: &mut Vec<MediaOperation>, now: u64) -> bool {
  let previous = operations.len();
  let cutoff = now.saturating_sub(RETENTION_MS);
  operations.retain(|operation| {
    !operation.stage.is_terminal()
      || operation.completed_at.unwrap_or(operation.updated_at) >= cutoff
  });
  let mut terminal: Vec<_> = operations
    .iter()
    .filter(|operation| operation.stage.is_terminal())
    .map(|operation| (operation.id.clone(), operation.updated_at))
    .collect();
  terminal.sort_by(|left, right| right.1.cmp(&left.1).then_with(|| left.0.cmp(&right.0)));
  let retained: HashSet<_> = terminal
    .into_iter()
    .take(MAX_TERMINAL_OPERATIONS)
    .map(|(id, _)| id)
    .collect();
  operations.retain(|operation| !operation.stage.is_terminal() || retained.contains(&operation.id));
  operations.len() != previous
}

fn validate_operation(operation: &MediaOperation) -> Result<(), String> {
  if uuid::Uuid::parse_str(&operation.id)
    .ok()
    .map(|id| id.to_string())
    .as_deref()
    != Some(operation.id.as_str())
    || operation.attempt == 0
    || operation.revision == 0
    || operation.created_at == 0
    || operation.updated_at < operation.created_at
    || operation
      .completed_at
      .is_some_and(|value| value < operation.created_at)
    || operation.stage.is_terminal() != operation.completed_at.is_some()
    || operation.files.len() > MAX_MEDIA_ITEMS
    || operation
      .item_count
      .is_some_and(|count| count == 0 || count > MAX_MEDIA_ITEMS)
  {
    return Err("MEDIA_INPUT_DENIED".into());
  }
  if let Some(source_url) = &operation.source_url {
    validate_source_url(operation.service, source_url)?;
  }
  if let Some(file_name) = &operation.file_name {
    validate_file_name(file_name)?;
  }
  for error in operation
    .error
    .iter()
    .chain(operation.journal_warning.iter())
  {
    if error.is_empty()
      || error.len() > 96
      || !error.bytes().all(|character| {
        character.is_ascii_uppercase() || character.is_ascii_digit() || character == b'_'
      })
    {
      return Err("MEDIA_INPUT_DENIED".into());
    }
  }
  for file in &operation.files {
    validate_file(file)?;
  }
  if !operation.media.is_empty()
    && (operation.kind != MediaOperationKind::Send
      || operation.mode == Some(MediaOperationMode::Link))
  {
    return Err("MEDIA_INPUT_DENIED".into());
  }
  validate_media_metadata(&operation.media)?;
  if let Some(progress) = &operation.progress {
    validate_progress(progress)?;
  }
  match (&operation.send, operation.kind, operation.mode) {
    (Some(send), MediaOperationKind::Send, Some(_)) => validate_send(send)?,
    (None, MediaOperationKind::Save | MediaOperationKind::Download, None) => {}
    _ => return Err("MEDIA_INPUT_DENIED".into()),
  }
  if operation.kind == MediaOperationKind::Send
    && operation.mode == Some(MediaOperationMode::Link)
    && operation.source_url.is_none()
  {
    return Err("MEDIA_INPUT_DENIED".into());
  }
  if operation.stage == MediaOperationStage::Completed
    && operation
      .send
      .as_ref()
      .is_some_and(|send| send.confirmed != send.total)
  {
    return Err("MEDIA_CONFIRMATION_DENIED".into());
  }
  Ok(())
}

fn validate_send(send: &MediaOperationSend) -> Result<(), String> {
  if !is_decimal(&send.account_id, false)
    || !is_decimal(&send.peer_id, true)
    || send
      .thread_id
      .as_ref()
      .is_some_and(|value| !is_decimal(value, false))
    || send.recipient_name.is_empty()
    || send.recipient_name.len() > 512
    || send.recipient_name.chars().any(char::is_control)
    || send.total == 0
    || send.total > MAX_SEND_ITEMS
    || send.confirmed > send.total
    || !send.random_ids.is_empty() && send.random_ids.len() != send.total
    || !send.fingerprints.is_empty() && send.fingerprints.len() != send.total
  {
    return Err("MEDIA_INPUT_DENIED".into());
  }
  let mut unique = HashSet::new();
  for id in &send.random_ids {
    if id.is_empty()
      || id.len() > 21
      || (!id.starts_with('-') && id.parse::<u64>().is_err())
      || id.starts_with('-') && id.parse::<i64>().is_err()
      || id == "0"
      || !unique.insert(id)
    {
      return Err("MEDIA_INPUT_DENIED".into());
    }
  }
  if send.fingerprints.iter().any(|value| {
    value.len() != 64
      || !value
        .bytes()
        .all(|character| character.is_ascii_digit() || (b'a'..=b'f').contains(&character))
  }) {
    return Err("MEDIA_INPUT_DENIED".into());
  }
  Ok(())
}

fn is_decimal(value: &str, signed: bool) -> bool {
  let digits = if signed {
    value.strip_prefix('-').unwrap_or(value)
  } else {
    value
  };
  !digits.is_empty()
    && digits.len() <= 24
    && !digits.starts_with('0')
    && digits.bytes().all(|character| character.is_ascii_digit())
}

fn validate_progress(progress: &MediaOperationProgress) -> Result<(), String> {
  if progress.loaded > MAX_FILE_BYTES
    || progress
      .total
      .is_some_and(|total| total == 0 || total > MAX_FILE_BYTES || progress.loaded > total)
    || progress
      .count
      .is_some_and(|count| count == 0 || count > MAX_SEND_ITEMS)
    || progress.index.is_some_and(|index| {
      index >= MAX_SEND_ITEMS || progress.count.is_some_and(|count| index >= count)
    })
  {
    return Err("MEDIA_INPUT_DENIED".into());
  }
  Ok(())
}

fn parse_service(value: &str) -> Result<MediaOperationService, String> {
  match value {
    "x" => Ok(MediaOperationService::X),
    "instagram" => Ok(MediaOperationService::Instagram),
    "telegram" => Ok(MediaOperationService::Telegram),
    _ => Err("MEDIA_INPUT_DENIED".into()),
  }
}

fn validate_source_url(service: MediaOperationService, value: &str) -> Result<(), String> {
  let parsed = url::Url::parse(value).map_err(|_| "MEDIA_SOURCE_DENIED")?;
  if value.len() > 2048
    || value
      .chars()
      .any(|character| character <= ' ' || matches!(character, '\\' | '%'))
    || value.split('/').any(|part| part == "." || part == "..")
    || parsed.scheme() != "https"
    || !parsed.username().is_empty()
    || parsed.password().is_some()
    || parsed.port().is_some()
    || parsed.query().is_some()
    || parsed.fragment().is_some()
  {
    return Err("MEDIA_SOURCE_DENIED".into());
  }
  let path = parsed
    .path()
    .strip_prefix('/')
    .ok_or("MEDIA_SOURCE_DENIED")?;
  let segments: Vec<_> = path.strip_suffix('/').unwrap_or(path).split('/').collect();
  let is_slug = |value: &str| {
    !value.is_empty()
      && value.len() <= 128
      && value
        .bytes()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, b'_' | b'-'))
  };
  let is_id = |value: &str| is_decimal(value, false);
  let valid = match service {
    MediaOperationService::X => {
      matches!(
        parsed.host_str(),
        Some("x.com" | "twitter.com" | "www.x.com" | "www.twitter.com" | "mobile.twitter.com")
      ) && segments.len() == 3
        && is_slug(segments[0])
        && segments[1] == "status"
        && is_id(segments[2])
    }
    MediaOperationService::Instagram => {
      matches!(
        parsed.host_str(),
        Some("instagram.com" | "www.instagram.com")
      ) && segments.len() == 2
        && matches!(segments[0], "p" | "reel" | "reels" | "tv")
        && is_slug(segments[1])
    }
    MediaOperationService::Telegram => {
      parsed.host_str() == Some("t.me")
        && ((segments.len() == 2 && is_slug(segments[0]) && is_id(segments[1]))
          || (segments.len() == 3
            && segments[0] == "c"
            && is_id(segments[1])
            && is_id(segments[2])))
    }
  };
  if !valid {
    return Err("MEDIA_SOURCE_DENIED".into());
  }
  Ok(())
}

fn canonicalize_source_url(service: MediaOperationService, value: &str) -> Result<String, String> {
  validate_source_url(service, value)?;
  if service == MediaOperationService::Telegram {
    return Ok(value.to_string());
  }
  let canonical = crate::inline_media::canonicalize_media_url(value)?;
  validate_source_url(service, &canonical)?;
  Ok(canonical)
}

fn validate_file_name(value: &str) -> Result<(), String> {
  if value.is_empty()
    || value.len() > 1024
    || value == "."
    || value == ".."
    || value.ends_with(['.', ' '])
    || value.chars().any(|character| {
      character.is_control()
        || matches!(
          character,
          '/' | '\\' | ':' | '<' | '>' | '"' | '|' | '?' | '*'
        )
    })
  {
    return Err("MEDIA_INPUT_DENIED".into());
  }
  Ok(())
}

fn validate_media_metadata(media: &[MediaMetadata]) -> Result<(), String> {
  if media.len() > MAX_MEDIA_ITEMS {
    return Err("MEDIA_INPUT_DENIED".into());
  }
  let mut total = 0_u64;
  for item in media {
    validate_file_name(&item.file_name)?;
    let parts = item.mime_type.split('/').collect::<Vec<_>>();
    if item.size == 0
      || item.size > MAX_SEND_FILE_BYTES
      || item.mime_type.len() > 127
      || parts.len() != 2
      || parts.iter().any(|part| part.is_empty())
      || !item.mime_type.bytes().all(|character| {
        character.is_ascii_alphanumeric() || matches!(character, b'/' | b'+' | b'.' | b'-' | b'_')
      })
      || item.width.is_some() != item.height.is_some()
      || item
        .width
        .is_some_and(|value| value == 0 || value > 1_000_000)
      || item
        .height
        .is_some_and(|value| value == 0 || value > 1_000_000)
    {
      return Err("MEDIA_INPUT_DENIED".into());
    }
    total = total.checked_add(item.size).ok_or("MEDIA_INPUT_DENIED")?;
    if total > MAX_SEND_SET_BYTES {
      return Err("MEDIA_INPUT_DENIED".into());
    }
  }
  Ok(())
}

fn validate_file(file: &MediaOperationFile) -> Result<(), String> {
  validate_file_name(&file.file_name)?;
  if !file.path.is_absolute()
    || file.path.to_string_lossy().len() > 32768
    || file
      .path
      .file_name()
      .map(|name| name.to_string_lossy())
      .as_deref()
      != Some(file.file_name.as_str())
    || file.size > MAX_FILE_BYTES
    || file.mime_type.is_empty()
    || file.mime_type.len() > 127
    || !file.mime_type.bytes().all(|character| {
      character.is_ascii_alphanumeric() || matches!(character, b'/' | b'+' | b'.' | b'-' | b'_')
    })
    || file.width.is_some() != file.height.is_some()
    || file
      .width
      .is_some_and(|value| value == 0 || value > 1_000_000)
    || file
      .height
      .is_some_and(|value| value == 0 || value > 1_000_000)
  {
    return Err("MEDIA_INPUT_DENIED".into());
  }
  Ok(())
}

fn inspect_saved_file(
  path: &Path,
  file_name: &str,
  mime_type: &str,
  size: u64,
) -> Result<MediaOperationFile, String> {
  let metadata = fs::symlink_metadata(path).map_err(|_| "MEDIA_FILE_MISSING")?;
  if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() != size {
    return Err("MEDIA_FILE_MISSING".into());
  }
  let canonical = fs::canonicalize(path).map_err(|_| "MEDIA_FILE_MISSING")?;
  let file = MediaOperationFile {
    path: canonical,
    file_name: file_name.to_string(),
    mime_type: mime_type.to_string(),
    size,
    width: None,
    height: None,
  };
  validate_file(&file)?;
  Ok(file)
}

fn find_registered_path(registry: &Registry, id: &str, index: usize) -> Result<PathBuf, String> {
  let operation = registry
    .operations
    .iter()
    .find(|operation| operation.id == id)
    .ok_or("MEDIA_OPERATION_NOT_FOUND")?;
  let file = operation.files.get(index).ok_or("MEDIA_FILE_MISSING")?;
  let inspected = inspect_saved_file(&file.path, &file.file_name, &file.mime_type, file.size)?;
  if inspected.path != file.path {
    return Err("MEDIA_FILE_MISSING".into());
  }
  Ok(inspected.path)
}

fn load_journal(directory: &Path) -> Result<Vec<MediaOperation>, String> {
  ensure_private_directory(directory)?;
  let path = directory.join(JOURNAL_NAME);
  let metadata = match fs::symlink_metadata(&path) {
    Ok(metadata) => metadata,
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
      cleanup_journal_parts(directory);
      return Ok(Vec::new());
    }
    Err(_) => return Err("MEDIA_JOURNAL_UNAVAILABLE".into()),
  };
  if !metadata.is_file()
    || metadata.file_type().is_symlink()
    || metadata.len() as usize > MAX_ENCRYPTED_BYTES
  {
    return Err("MEDIA_JOURNAL_CORRUPT".into());
  }
  let mut encrypted = Vec::with_capacity(metadata.len() as usize);
  File::open(&path)
    .map_err(|_| "MEDIA_JOURNAL_UNAVAILABLE")?
    .take((MAX_ENCRYPTED_BYTES + 1) as u64)
    .read_to_end(&mut encrypted)
    .map_err(|_| "MEDIA_JOURNAL_UNAVAILABLE")?;
  if encrypted.len() > MAX_ENCRYPTED_BYTES || !encrypted.starts_with(JOURNAL_HEADER) {
    return Err("MEDIA_JOURNAL_CORRUPT".into());
  }
  let mut plain = unprotect_data(&encrypted[JOURNAL_HEADER.len()..])?;
  let result = (|| {
    if plain.len() > MAX_JOURNAL_BYTES {
      return Err("MEDIA_JOURNAL_CORRUPT".into());
    }
    let journal: Journal = serde_json::from_slice(&plain).map_err(|_| "MEDIA_JOURNAL_CORRUPT")?;
    if journal.version != 1
      || journal.operations.len()
        > MAX_TERMINAL_OPERATIONS + MAX_ACTIVE_DOWNLOADS + MAX_RELAY_OPERATIONS
    {
      return Err("MEDIA_JOURNAL_CORRUPT".into());
    }
    let mut unique = HashSet::new();
    for operation in &journal.operations {
      validate_operation(operation).map_err(|_| "MEDIA_JOURNAL_CORRUPT")?;
      if operation.journal_warning.is_some() {
        return Err("MEDIA_JOURNAL_CORRUPT".into());
      }
      if !unique.insert(&operation.id) {
        return Err("MEDIA_JOURNAL_CORRUPT".into());
      }
    }
    Ok(journal.operations)
  })();
  plain.fill(0);
  if result.is_ok() {
    cleanup_journal_parts(directory);
  }
  result
}

fn is_unreadable_journal_error(error: &str) -> bool {
  matches!(
    error,
    "MEDIA_JOURNAL_CORRUPT" | "MEDIA_JOURNAL_DECRYPT_FAILED"
  )
}

// Renames the unreadable journal to `journal-v1.dpapi.corrupt-<time>` and keeps the newest copies only.
fn quarantine_journal(directory: &Path, now: u64) -> Result<(), String> {
  let source = directory.join(JOURNAL_NAME);
  // The stamp always grows, so a new copy never reuses the name of an older or pruned one.
  let stamp = quarantined_journals(directory)
    .last()
    .map_or(now, |(newest, _)| now.max(newest.saturating_add(1)));
  let target = directory.join(format!("{JOURNAL_NAME}{QUARANTINE_INFIX}{stamp}"));
  if fs::symlink_metadata(&target).is_ok() {
    return Err("MEDIA_JOURNAL_UNAVAILABLE".into());
  }
  fs::rename(&source, &target).map_err(|_| "MEDIA_JOURNAL_UNAVAILABLE")?;
  let copies = quarantined_journals(directory);
  let excess = copies.len().saturating_sub(MAX_QUARANTINED_JOURNALS);
  for (_, path) in copies.into_iter().take(excess) {
    let _ = fs::remove_file(path);
  }
  Ok(())
}

// Regular quarantined copies ordered from the oldest to the newest.
fn quarantined_journals(directory: &Path) -> Vec<(u64, PathBuf)> {
  let Ok(entries) = fs::read_dir(directory) else {
    return Vec::new();
  };
  let prefix = format!("{JOURNAL_NAME}{QUARANTINE_INFIX}");
  let mut copies: Vec<(u64, PathBuf)> = entries
    .flatten()
    .filter_map(|entry| {
      let name = entry.file_name();
      let stamp = name.to_str()?.strip_prefix(prefix.as_str())?.parse().ok()?;
      let metadata = fs::symlink_metadata(entry.path()).ok()?;
      (metadata.is_file() && !metadata.file_type().is_symlink()).then(|| (stamp, entry.path()))
    })
    .collect();
  copies.sort();
  copies
}

fn cleanup_journal_parts(directory: &Path) {
  let Ok(entries) = fs::read_dir(directory) else {
    return;
  };
  for entry in entries.flatten() {
    let name = entry.file_name();
    let Some(name) = name.to_str() else {
      continue;
    };
    let Some(id) = name
      .strip_prefix("journal-")
      .and_then(|name| name.strip_suffix(".part"))
    else {
      continue;
    };
    if uuid::Uuid::parse_str(id)
      .ok()
      .map(|id| id.to_string())
      .as_deref()
      != Some(id)
    {
      continue;
    }
    let Ok(metadata) = fs::symlink_metadata(entry.path()) else {
      continue;
    };
    if metadata.is_file() && !metadata.file_type().is_symlink() {
      let _ = fs::remove_file(entry.path());
    }
  }
}

fn persist_journal(directory: &Path, operations: &[MediaOperation]) -> Result<(), String> {
  ensure_private_directory(directory)?;
  let mut persisted = operations.to_vec();
  for operation in &mut persisted {
    operation.progress = None;
    operation.journal_warning = None;
  }
  let mut plain = serde_json::to_vec(&Journal {
    version: 1,
    operations: persisted,
  })
  .map_err(|_| "MEDIA_JOURNAL_UNAVAILABLE")?;
  if plain.len() > MAX_JOURNAL_BYTES {
    plain.fill(0);
    return Err("MEDIA_JOURNAL_TOO_LARGE".into());
  }
  let encrypted = protect_data(&plain);
  plain.fill(0);
  let encrypted = encrypted?;
  if encrypted.len() + JOURNAL_HEADER.len() > MAX_ENCRYPTED_BYTES {
    return Err("MEDIA_JOURNAL_TOO_LARGE".into());
  }
  let temporary = directory.join(format!("journal-{}.part", uuid::Uuid::new_v4()));
  let target = directory.join(JOURNAL_NAME);
  let result = (|| {
    let mut file = OpenOptions::new()
      .create_new(true)
      .write(true)
      .open(&temporary)
      .map_err(|_| "MEDIA_JOURNAL_WRITE_FAILED")?;
    file
      .write_all(JOURNAL_HEADER)
      .and_then(|_| file.write_all(&encrypted))
      .and_then(|_| file.sync_all())
      .map_err(|_| "MEDIA_JOURNAL_WRITE_FAILED")?;
    drop(file);
    if let Ok(metadata) = fs::symlink_metadata(&target) {
      if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("MEDIA_JOURNAL_CORRUPT".into());
      }
    }
    replace_atomically(&temporary, &target)
  })();
  if result.is_err() {
    let _ = fs::remove_file(&temporary);
  }
  result
}

fn now_ms() -> u64 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|value| value.as_millis().min(u64::MAX as u128) as u64)
    .unwrap_or(1)
}

#[cfg(windows)]
fn ensure_private_directory(directory: &Path) -> Result<(), String> {
  if !directory.is_absolute() {
    return Err("MEDIA_JOURNAL_UNAVAILABLE".into());
  }
  if let Some(parent) = directory.parent() {
    fs::create_dir_all(parent).map_err(|_| "MEDIA_JOURNAL_UNAVAILABLE")?;
  }
  windows_storage::secure_directory(directory)
}
#[cfg(not(windows))]
fn ensure_private_directory(_directory: &Path) -> Result<(), String> {
  Err("MEDIA_JOURNAL_WINDOWS_REQUIRED".into())
}

#[cfg(windows)]
fn protect_data(plain: &[u8]) -> Result<Vec<u8>, String> {
  windows_storage::protect(plain, false)
}
#[cfg(windows)]
fn unprotect_data(encrypted: &[u8]) -> Result<Vec<u8>, String> {
  windows_storage::protect(encrypted, true)
}
#[cfg(not(windows))]
fn protect_data(_plain: &[u8]) -> Result<Vec<u8>, String> {
  Err("MEDIA_JOURNAL_WINDOWS_REQUIRED".into())
}
#[cfg(not(windows))]
fn unprotect_data(_encrypted: &[u8]) -> Result<Vec<u8>, String> {
  Err("MEDIA_JOURNAL_WINDOWS_REQUIRED".into())
}

#[cfg(windows)]
fn replace_atomically(source: &Path, destination: &Path) -> Result<(), String> {
  windows_storage::replace(source, destination)
}
#[cfg(not(windows))]
fn replace_atomically(source: &Path, destination: &Path) -> Result<(), String> {
  fs::rename(source, destination).map_err(|_| "MEDIA_JOURNAL_WRITE_FAILED".into())
}

#[cfg(windows)]
fn open_registered_path(path: &Path, reveal: bool) -> Result<(), String> {
  windows_storage::open(path, reveal)
}
#[cfg(not(windows))]
fn open_registered_path(_path: &Path, _reveal: bool) -> Result<(), String> {
  Err("MEDIA_JOURNAL_WINDOWS_REQUIRED".into())
}

#[cfg(windows)]
mod windows_storage {
  use super::*;
  use std::{
    ffi::c_void,
    os::windows::{ffi::OsStrExt, fs::MetadataExt},
    ptr,
  };

  #[repr(C)]
  struct DataBlob {
    length: u32,
    data: *mut u8,
  }
  #[repr(C)]
  struct SecurityAttributes {
    length: u32,
    descriptor: *mut c_void,
    inherit: i32,
  }
  #[repr(C)]
  struct SidAndAttributes {
    sid: *mut c_void,
    attributes: u32,
  }
  #[repr(C)]
  struct TokenUser {
    user: SidAndAttributes,
  }

  #[link(name = "Crypt32")]
  unsafe extern "system" {
    fn CryptProtectData(
      input: *const DataBlob,
      description: *const u16,
      entropy: *const DataBlob,
      reserved: *const c_void,
      prompt: *const c_void,
      flags: u32,
      output: *mut DataBlob,
    ) -> i32;
    fn CryptUnprotectData(
      input: *const DataBlob,
      description: *mut *mut u16,
      entropy: *const DataBlob,
      reserved: *const c_void,
      prompt: *const c_void,
      flags: u32,
      output: *mut DataBlob,
    ) -> i32;
  }
  #[link(name = "Advapi32")]
  unsafe extern "system" {
    fn OpenProcessToken(process: *mut c_void, access: u32, token: *mut *mut c_void) -> i32;
    fn GetTokenInformation(
      token: *mut c_void,
      class: u32,
      information: *mut c_void,
      length: u32,
      returned: *mut u32,
    ) -> i32;
    fn ConvertSidToStringSidW(sid: *const c_void, output: *mut *mut u16) -> i32;
    fn ConvertStringSecurityDescriptorToSecurityDescriptorW(
      value: *const u16,
      revision: u32,
      output: *mut *mut c_void,
      length: *mut u32,
    ) -> i32;
    fn GetSecurityDescriptorDacl(
      descriptor: *const c_void,
      present: *mut i32,
      dacl: *mut *mut c_void,
      defaulted: *mut i32,
    ) -> i32;
    fn SetNamedSecurityInfoW(
      name: *const u16,
      object_type: u32,
      information: u32,
      owner: *const c_void,
      group: *const c_void,
      dacl: *const c_void,
      sacl: *const c_void,
    ) -> u32;
  }
  #[link(name = "Kernel32")]
  unsafe extern "system" {
    fn GetCurrentProcess() -> *mut c_void;
    fn CloseHandle(handle: *mut c_void) -> i32;
    fn LocalFree(value: *mut c_void) -> *mut c_void;
    fn CreateDirectoryW(path: *const u16, security: *const SecurityAttributes) -> i32;
    fn MoveFileExW(source: *const u16, destination: *const u16, flags: u32) -> i32;
    fn GetLastError() -> u32;
  }
  #[link(name = "Shell32")]
  unsafe extern "system" {
    fn ShellExecuteW(
      window: *const c_void,
      operation: *const u16,
      file: *const u16,
      arguments: *const u16,
      directory: *const u16,
      show: i32,
    ) -> *mut c_void;
    fn SHParseDisplayName(
      name: *const u16,
      binding: *const c_void,
      item: *mut *mut c_void,
      attributes: u32,
      resulting: *mut u32,
    ) -> i32;
    fn SHOpenFolderAndSelectItems(
      item: *const c_void,
      count: u32,
      children: *const *const c_void,
      flags: u32,
    ) -> i32;
  }
  #[link(name = "Ole32")]
  unsafe extern "system" {
    fn CoTaskMemFree(memory: *mut c_void);
  }

  pub(super) fn protect(value: &[u8], decrypt: bool) -> Result<Vec<u8>, String> {
    if value.is_empty() || value.len() > MAX_ENCRYPTED_BYTES || value.len() > u32::MAX as usize {
      return Err("MEDIA_JOURNAL_CORRUPT".into());
    }
    let input = DataBlob {
      length: value.len() as u32,
      data: value.as_ptr().cast_mut(),
    };
    let entropy = DataBlob {
      length: JOURNAL_ENTROPY.len() as u32,
      data: JOURNAL_ENTROPY.as_ptr().cast_mut(),
    };
    let mut output = DataBlob {
      length: 0,
      data: ptr::null_mut(),
    };
    // CurrentUser scope and UI_FORBIDDEN bind the journal to this Windows user without prompts
    let success = unsafe {
      if decrypt {
        CryptUnprotectData(
          &input,
          ptr::null_mut(),
          &entropy,
          ptr::null(),
          ptr::null(),
          1,
          &mut output,
        )
      } else {
        CryptProtectData(
          &input,
          ptr::null(),
          &entropy,
          ptr::null(),
          ptr::null(),
          1,
          &mut output,
        )
      }
    };
    if success == 0 {
      if !output.data.is_null() {
        unsafe {
          LocalFree(output.data.cast());
        }
      }
      return Err(
        if decrypt {
          "MEDIA_JOURNAL_DECRYPT_FAILED"
        } else {
          "MEDIA_JOURNAL_PROTECT_FAILED"
        }
        .into(),
      );
    }
    if output.data.is_null() || output.length as usize > MAX_ENCRYPTED_BYTES {
      if !output.data.is_null() {
        unsafe {
          LocalFree(output.data.cast());
        }
      }
      return Err("MEDIA_JOURNAL_CORRUPT".into());
    }
    let result =
      unsafe { std::slice::from_raw_parts(output.data, output.length as usize) }.to_vec();
    unsafe {
      std::slice::from_raw_parts_mut(output.data, output.length as usize).fill(0);
      LocalFree(output.data.cast());
    }
    Ok(result)
  }

  fn current_user_sid() -> Result<String, String> {
    let mut token = ptr::null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), 8, &mut token) } == 0 {
      return Err("MEDIA_JOURNAL_ACL_FAILED".into());
    }
    let result = (|| {
      let mut length = 0;
      unsafe {
        GetTokenInformation(token, 1, ptr::null_mut(), 0, &mut length);
      }
      if length == 0 || length > 64 * 1024 {
        return Err("MEDIA_JOURNAL_ACL_FAILED".into());
      }
      let mut information = vec![0usize; (length as usize).div_ceil(std::mem::size_of::<usize>())];
      if unsafe {
        GetTokenInformation(
          token,
          1,
          information.as_mut_ptr().cast(),
          length,
          &mut length,
        )
      } == 0
      {
        return Err("MEDIA_JOURNAL_ACL_FAILED".into());
      }
      let user = unsafe { &*information.as_ptr().cast::<TokenUser>() };
      let mut text = ptr::null_mut();
      if unsafe { ConvertSidToStringSidW(user.user.sid, &mut text) } == 0 {
        return Err("MEDIA_JOURNAL_ACL_FAILED".into());
      }
      let mut size = 0;
      while size < 256 && unsafe { *text.add(size) } != 0 {
        size += 1;
      }
      let result = if size < 256 {
        String::from_utf16(unsafe { std::slice::from_raw_parts(text, size) })
          .map_err(|_| "MEDIA_JOURNAL_ACL_FAILED".into())
      } else {
        Err("MEDIA_JOURNAL_ACL_FAILED".into())
      };
      unsafe {
        LocalFree(text.cast());
      }
      result
    })();
    unsafe {
      CloseHandle(token);
    }
    result
  }

  pub(super) fn secure_directory(path: &Path) -> Result<(), String> {
    let name = wide(path)?;
    let sid = current_user_sid()?;
    let sddl: Vec<u16> = format!("O:{sid}D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;{sid})")
      .encode_utf16()
      .chain(Some(0))
      .collect();
    let mut descriptor = ptr::null_mut();
    if unsafe {
      ConvertStringSecurityDescriptorToSecurityDescriptorW(
        sddl.as_ptr(),
        1,
        &mut descriptor,
        ptr::null_mut(),
      )
    } == 0
    {
      return Err("MEDIA_JOURNAL_ACL_FAILED".into());
    }
    let result = (|| {
      let security = SecurityAttributes {
        length: std::mem::size_of::<SecurityAttributes>() as u32,
        descriptor,
        inherit: 0,
      };
      if unsafe { CreateDirectoryW(name.as_ptr(), &security) } == 0
        && unsafe { GetLastError() } != 183
      {
        return Err("MEDIA_JOURNAL_UNAVAILABLE".into());
      }
      let metadata = fs::symlink_metadata(path).map_err(|_| "MEDIA_JOURNAL_UNAVAILABLE")?;
      if !metadata.is_dir() || metadata.file_attributes() & 0x400 != 0 {
        return Err("MEDIA_JOURNAL_UNAVAILABLE".into());
      }
      let mut present = 0;
      let mut defaulted = 0;
      let mut dacl = ptr::null_mut();
      if unsafe { GetSecurityDescriptorDacl(descriptor, &mut present, &mut dacl, &mut defaulted) }
        == 0
        || present == 0
        || dacl.is_null()
      {
        return Err("MEDIA_JOURNAL_ACL_FAILED".into());
      }
      if unsafe {
        SetNamedSecurityInfoW(
          name.as_ptr(),
          1,
          0x80000004,
          ptr::null(),
          ptr::null(),
          dacl,
          ptr::null(),
        )
      } != 0
      {
        return Err("MEDIA_JOURNAL_ACL_FAILED".into());
      }
      Ok(())
    })();
    unsafe {
      LocalFree(descriptor);
    }
    result
  }

  pub(super) fn replace(source: &Path, destination: &Path) -> Result<(), String> {
    let source = wide(source)?;
    let destination = wide(destination)?;
    // Both entries share a protected directory and volume
    if unsafe { MoveFileExW(source.as_ptr(), destination.as_ptr(), 0x1 | 0x8) } == 0 {
      return Err("MEDIA_JOURNAL_WRITE_FAILED".into());
    }
    Ok(())
  }

  pub(super) fn open(path: &Path, reveal: bool) -> Result<(), String> {
    let path = wide(path)?;
    if reveal {
      let mut item = ptr::null_mut();
      if unsafe { SHParseDisplayName(path.as_ptr(), ptr::null(), &mut item, 0, ptr::null_mut()) }
        < 0
        || item.is_null()
      {
        return Err("MEDIA_FILE_OPEN_FAILED".into());
      }
      let result = unsafe { SHOpenFolderAndSelectItems(item, 0, ptr::null(), 0) };
      unsafe {
        CoTaskMemFree(item);
      }
      if result < 0 {
        return Err("MEDIA_FILE_OPEN_FAILED".into());
      }
    } else {
      let operation: Vec<u16> = "open".encode_utf16().chain(Some(0)).collect();
      if unsafe {
        ShellExecuteW(
          ptr::null(),
          operation.as_ptr(),
          path.as_ptr(),
          ptr::null(),
          ptr::null(),
          1,
        )
      } as isize
        <= 32
      {
        return Err("MEDIA_FILE_OPEN_FAILED".into());
      }
    }
    Ok(())
  }

  fn wide(path: &Path) -> Result<Vec<u16>, String> {
    let mut value: Vec<_> = path.as_os_str().encode_wide().collect();
    if value.contains(&0) {
      return Err("MEDIA_INPUT_DENIED".into());
    }
    value.push(0);
    Ok(value)
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  const NOW: u64 = 1_800_000_000_000;
  const SOURCE: &str = "https://x.com/fixture/status/1234567890";

  fn fixture_operation(stage: MediaOperationStage) -> MediaOperation {
    MediaOperation {
      id: uuid::Uuid::new_v4().to_string(),
      attempt: 1,
      revision: 1,
      kind: MediaOperationKind::Save,
      service: MediaOperationService::X,
      source_url: Some(SOURCE.into()),
      stage,
      created_at: NOW,
      updated_at: NOW,
      completed_at: stage.is_terminal().then_some(NOW),
      file_name: None,
      item_count: Some(1),
      mode: None,
      files: Vec::new(),
      media: Vec::new(),
      send: None,
      error: None,
      journal_warning: None,
      progress: None,
    }
  }

  fn fixture_input(kind: MediaOperationKind) -> NewMediaOperation {
    NewMediaOperation {
      id: uuid::Uuid::new_v4().to_string(),
      kind,
      service: MediaOperationService::X,
      source_url: Some(SOURCE.into()),
      file_name: None,
      item_count: Some(1),
      mode: (kind == MediaOperationKind::Send).then_some(MediaOperationMode::File),
      send: (kind == MediaOperationKind::Send).then(|| MediaOperationSend {
        account_id: "123".into(),
        peer_id: "-100456".into(),
        thread_id: None,
        recipient_name: "Fixture recipient".into(),
        confirmed: 0,
        total: 3,
        random_ids: vec!["101".into(), "102".into(), "103".into()],
        fingerprints: vec!["a".repeat(64), "b".repeat(64), "c".repeat(64)],
      }),
    }
  }

  fn fixture_media() -> MediaMetadata {
    MediaMetadata {
      file_name: "fixture.mp4".into(),
      mime_type: "video/mp4".into(),
      size: 1024,
      width: Some(1920),
      height: Some(1080),
    }
  }

  #[cfg(windows)]
  fn native_directory() -> PathBuf {
    let root = std::env::var_os("EGOIST_RELAY_TEST_WORK")
      .or_else(|| std::env::var_os("EGOIST_RELAY_AUDIT_WORK"))
      .map(PathBuf::from)
      .expect("Native journal tests require EGOIST_RELAY_TEST_WORK or EGOIST_RELAY_AUDIT_WORK");
    assert!(root.is_absolute() && root.is_dir());
    root.join(format!("media-journal-{}", uuid::Uuid::new_v4()))
  }

  #[cfg(windows)]
  fn unlocked_registry() -> Registry {
    let mut registry = Registry::load(native_directory(), NOW);
    registry.ensure_available().unwrap();
    registry.is_locked = false;
    registry
  }

  #[test]
  fn recovery_preserves_confirmations_and_never_requeues_send() {
    let mut input = fixture_input(MediaOperationKind::Send);
    input.send.as_mut().unwrap().confirmed = 1;
    let mut send = fixture_operation(MediaOperationStage::Sending);
    send.kind = MediaOperationKind::Send;
    send.mode = input.mode;
    send.send = input.send;
    let mut operations = vec![
      send,
      fixture_operation(MediaOperationStage::Downloading),
      fixture_operation(MediaOperationStage::Completed),
    ];
    assert!(recover_operations(&mut operations, NOW + 1));
    assert_eq!(operations[0].stage, MediaOperationStage::Uncertain);
    assert_eq!(operations[0].send.as_ref().unwrap().confirmed, 1);
    assert_eq!(
      operations[0].send.as_ref().unwrap().random_ids,
      ["101", "102", "103"]
    );
    assert_eq!(operations[1].stage, MediaOperationStage::Interrupted);
    assert_eq!(operations[2].revision, 1);
    for operation in operations {
      validate_operation(&operation).unwrap();
    }
  }

  #[test]
  fn retention_caps_terminal_history_without_dropping_active_jobs() {
    let mut expired = fixture_operation(MediaOperationStage::Failed);
    expired.completed_at = Some(NOW);
    let active = fixture_operation(MediaOperationStage::Downloading);
    let active_id = active.id.clone();
    let mut operations = vec![expired, active];
    for index in 0..510 {
      let mut operation = fixture_operation(MediaOperationStage::Completed);
      operation.updated_at = NOW + RETENTION_MS + index;
      operation.completed_at = Some(operation.updated_at);
      operations.push(operation);
    }
    assert!(prune_operations(&mut operations, NOW + RETENTION_MS + 1));
    assert_eq!(
      operations
        .iter()
        .filter(|operation| operation.stage.is_terminal())
        .count(),
      500
    );
    assert!(operations.iter().any(|operation| operation.id == active_id));
    assert_eq!(operations.len(), 501);
  }

  #[test]
  fn transitions_reject_terminal_replay_and_allow_safe_interruption() {
    assert!(can_transition(
      MediaOperationStage::Sending,
      MediaOperationStage::Interrupted
    ));
    assert!(can_transition(
      MediaOperationStage::Cancelling,
      MediaOperationStage::Completed
    ));
    assert!(!can_transition(
      MediaOperationStage::Uncertain,
      MediaOperationStage::Queued
    ));
    assert!(!can_transition(
      MediaOperationStage::Completed,
      MediaOperationStage::Completed
    ));
    assert!(!can_transition(
      MediaOperationStage::Queued,
      MediaOperationStage::Completed
    ));
  }

  #[test]
  fn journal_accepts_post_sources_and_rejects_cdn_credentials_and_path_aliases() {
    validate_source_url(MediaOperationService::X, SOURCE).unwrap();
    validate_source_url(
      MediaOperationService::Instagram,
      "https://www.instagram.com/reel/AbCd123/",
    )
    .unwrap();
    validate_source_url(MediaOperationService::Telegram, "https://t.me/c/123456/78").unwrap();
    // Synthetic credentials test the real service origin without storing a credential URL literal.
    let mut credential_source = url::Url::parse(SOURCE).unwrap();
    credential_source.set_username("name").unwrap();
    credential_source.set_password(Some("password")).unwrap();
    for source in [
      "https://video.twimg.com/file.mp4",
      "https://x.com/fixture/status/1?token=secret",
      credential_source.as_str(),
      "http://x.com/fixture/status/1",
      "https://x.com/fixture/../fixture/status/1",
      "https://x.com//fixture/status/1",
      "https://x.com/fixture/status/%31",
      "https://x.com:8443/fixture/status/1",
    ] {
      assert!(
        validate_source_url(MediaOperationService::X, source).is_err(),
        "{source}"
      );
    }
  }

  #[test]
  fn public_input_cannot_register_paths_blobs_or_change_recipient() {
    let input = serde_json::json!({
      "id": uuid::Uuid::new_v4().to_string(), "kind": "save", "service": "x",
      "files": [{"path": "C:\\arbitrary.exe"}],
    });
    assert!(serde_json::from_value::<NewMediaOperation>(input).is_err());
    assert!(
      serde_json::from_value::<MediaOperationPatch>(serde_json::json!({"peerId": "123"})).is_err()
    );
    assert!(
      serde_json::from_value::<MediaOperationAction>(
        serde_json::json!({"type": "open", "id": "123", "path": "C:\\arbitrary.exe"})
      )
      .is_err()
    );
    assert!(
      serde_json::from_value::<MediaOperationPatch>(serde_json::json!({"text": "private body"}))
        .is_err()
    );
  }

  #[test]
  fn media_limit_is_independent_of_message_parts() {
    let mut send = fixture_input(MediaOperationKind::Send).send.unwrap();
    send.total = 12;
    send.random_ids = (1..=12).map(|index| index.to_string()).collect();
    send.fingerprints = vec!["a".repeat(64); 12];
    validate_send(&send).unwrap();
    send.confirmed = 13;
    assert_eq!(validate_send(&send).unwrap_err(), "MEDIA_INPUT_DENIED");
  }

  #[test]
  fn send_metadata_obeys_file_set_and_dimension_limits() {
    let media = fixture_media();
    validate_media_metadata(&[media.clone()]).unwrap();
    validate_media_metadata(&vec![media.clone(); MAX_MEDIA_ITEMS]).unwrap();
    assert!(validate_media_metadata(&vec![media.clone(); MAX_MEDIA_ITEMS + 1]).is_err());
    let mut large = media.clone();
    large.size = MAX_SEND_FILE_BYTES;
    validate_media_metadata(&[large.clone(), large.clone()]).unwrap();
    assert!(validate_media_metadata(&[large.clone(), large.clone(), media.clone()]).is_err());
    large.size += 1;
    assert!(validate_media_metadata(&[large]).is_err());
    for (width, height) in [
      (Some(0), Some(1080)),
      (Some(1920), None),
      (None, Some(1080)),
      (Some(1_000_001), Some(1080)),
    ] {
      let mut invalid = media.clone();
      invalid.width = width;
      invalid.height = height;
      assert!(validate_media_metadata(&[invalid]).is_err());
    }
    for value in [
      "",
      "video",
      "video/",
      "/mp4",
      "video/mp4/token",
      "video/mp4;token=secret",
    ] {
      let mut invalid = media.clone();
      invalid.mime_type = value.into();
      assert!(validate_media_metadata(&[invalid]).is_err());
    }
    for value in [
      "https://cdn.invalid/secret.mp4",
      "C:\\private\\fixture.mp4",
      "../fixture.mp4",
    ] {
      let mut invalid = media.clone();
      invalid.file_name = value.into();
      assert!(validate_media_metadata(&[invalid]).is_err());
    }
  }

  #[test]
  fn send_metadata_contract_cannot_contain_paths_urls_or_private_content() {
    let safe = serde_json::to_value(fixture_media()).unwrap();
    for key in ["path", "url", "blobUrl", "text", "cookie", "token"] {
      let mut private = safe.clone();
      private[key] = serde_json::json!("private");
      assert!(
        serde_json::from_value::<MediaMetadata>(private).is_err(),
        "{key}"
      );
    }
    let mut old_record =
      serde_json::to_value(fixture_operation(MediaOperationStage::Completed)).unwrap();
    assert!(old_record.get("media").is_none());
    assert!(
      serde_json::from_value::<MediaOperation>(old_record.clone())
        .unwrap()
        .media
        .is_empty()
    );
    old_record["media"] = serde_json::json!([safe]);
    let invalid_save = serde_json::from_value::<MediaOperation>(old_record).unwrap();
    assert!(validate_operation(&invalid_save).is_err());
  }

  #[test]
  #[cfg(windows)]
  fn file_mode_metadata_is_durable_before_send_and_frozen_during_send() {
    let mut registry = unlocked_registry();
    let input = fixture_input(MediaOperationKind::Send);
    let id = input.id.clone();
    assert_eq!(input.mode, Some(MediaOperationMode::File));
    registry.register(input, NOW, false).unwrap();
    assert!(registry.operations[0].media.is_empty());
    let media = fixture_media();
    registry
      .update(
        &id,
        1,
        1,
        MediaOperationPatch {
          stage: Some(MediaOperationStage::Preparing),
          media: Some(vec![media.clone()]),
          ..Default::default()
        },
        NOW + 1,
      )
      .unwrap();
    let stored = load_journal(&registry.directory).unwrap();
    assert_eq!(stored[0].mode, Some(MediaOperationMode::File));
    assert_eq!(stored[0].media, [media.clone()]);
    registry
      .update(
        &id,
        1,
        2,
        MediaOperationPatch {
          stage: Some(MediaOperationStage::Sending),
          ..Default::default()
        },
        NOW + 2,
      )
      .unwrap();
    assert_eq!(
      registry
        .update(
          &id,
          1,
          3,
          MediaOperationPatch {
            media: Some(Vec::new()),
            ..Default::default()
          },
          NOW + 3
        )
        .unwrap_err(),
      "MEDIA_INPUT_DENIED"
    );
    assert_eq!(registry.operations[0].revision, 3);
    assert_eq!(registry.operations[0].media, [media]);
    let mut link = registry.operations[0].clone();
    link.mode = Some(MediaOperationMode::Link);
    assert!(validate_operation(&link).is_err());
  }

  #[test]
  fn progress_never_fabricates_percentage_or_accepts_invalid_dimensions() {
    validate_progress(&MediaOperationProgress {
      loaded: 42,
      total: None,
      index: Some(1),
      count: Some(3),
    })
    .unwrap();
    assert!(
      validate_progress(&MediaOperationProgress {
        loaded: 42,
        total: Some(20),
        index: None,
        count: None
      })
      .is_err()
    );
    let file = MediaOperationFile {
      path: std::env::current_dir().unwrap().join("fixture.png"),
      file_name: "fixture.png".into(),
      mime_type: "image/png".into(),
      size: 1,
      width: Some(3000),
      height: None,
    };
    assert!(validate_file(&file).is_err());
  }

  #[test]
  #[cfg(windows)]
  fn dpapi_round_trip_is_encrypted_and_integrity_checked() {
    let original = b"Fixture recipient and canonical source";
    let mut encrypted = protect_data(original).unwrap();
    assert_ne!(encrypted, original);
    assert_eq!(unprotect_data(&encrypted).unwrap(), original);
    let last = encrypted.len() - 1;
    encrypted[last] ^= 0x20;
    assert!(unprotect_data(&encrypted).is_err());
  }

  #[test]
  #[cfg(windows)]
  fn journal_atomic_replace_ignores_partial_temporary_files() {
    let directory = native_directory();
    let first = fixture_operation(MediaOperationStage::Failed);
    persist_journal(&directory, &[first.clone()]).unwrap();
    fs::write(
      directory.join("journal-owned-incomplete.part"),
      b"incomplete",
    )
    .unwrap();
    assert_eq!(load_journal(&directory).unwrap()[0].id, first.id);
    let second = fixture_operation(MediaOperationStage::Completed);
    persist_journal(&directory, &[first, second.clone()]).unwrap();
    let loaded = load_journal(&directory).unwrap();
    assert_eq!(loaded.len(), 2);
    assert_eq!(loaded[1].id, second.id);
    let encrypted = fs::read(directory.join(JOURNAL_NAME)).unwrap();
    assert!(
      !encrypted
        .windows(SOURCE.len())
        .any(|bytes| bytes == SOURCE.as_bytes())
    );
  }

  #[test]
  #[cfg(windows)]
  fn corrupt_journal_is_quarantined_and_downloads_keep_working() {
    let directory = native_directory();
    ensure_private_directory(&directory).unwrap();
    let path = directory.join(JOURNAL_NAME);
    let damaged = b"damaged encrypted journal";
    fs::write(&path, damaged).unwrap();
    let mut registry = Registry::load(directory.clone(), NOW);
    registry.is_locked = false;
    let snapshot = registry.snapshot().unwrap();
    assert!(snapshot.operations.is_empty());
    assert_eq!(
      snapshot.journal_notice.as_deref(),
      Some("MEDIA_JOURNAL_CORRUPT")
    );
    assert!(!path.exists());
    let quarantined = directory.join(format!("{JOURNAL_NAME}{QUARANTINE_INFIX}{NOW}"));
    assert_eq!(fs::read(&quarantined).unwrap(), damaged);
    registry
      .register(fixture_input(MediaOperationKind::Download), NOW, true)
      .unwrap();
    let restored = Registry::load(directory, NOW + 1);
    assert!(restored.journal_notice.is_none());
    assert_eq!(restored.operations.len(), 1);
    assert_eq!(fs::read(&quarantined).unwrap(), damaged);
  }

  #[test]
  #[cfg(windows)]
  fn quarantine_keeps_only_the_newest_copies_and_never_overwrites() {
    let directory = native_directory();
    ensure_private_directory(&directory).unwrap();
    for index in 0..(MAX_QUARANTINED_JOURNALS as u64 + 2) {
      fs::write(directory.join(JOURNAL_NAME), format!("damaged-{index}")).unwrap();
      quarantine_journal(&directory, NOW).unwrap();
    }
    let mut copies: Vec<String> = fs::read_dir(&directory)
      .unwrap()
      .flatten()
      .map(|entry| entry.file_name().to_string_lossy().into_owned())
      .filter(|name| name.contains(QUARANTINE_INFIX))
      .collect();
    copies.sort();
    assert_eq!(copies.len(), MAX_QUARANTINED_JOURNALS);
    let newest = fs::read_to_string(directory.join(copies.last().unwrap())).unwrap();
    assert_eq!(newest, format!("damaged-{}", MAX_QUARANTINED_JOURNALS + 1));
    assert!(!directory.join(JOURNAL_NAME).exists());
  }

  #[test]
  #[cfg(windows)]
  fn oversized_journal_is_rejected_before_decryption() {
    let directory = native_directory();
    ensure_private_directory(&directory).unwrap();
    let file = File::create(directory.join(JOURNAL_NAME)).unwrap();
    file.set_len((MAX_ENCRYPTED_BYTES + 1) as u64).unwrap();
    assert_eq!(
      load_journal(&directory).unwrap_err(),
      "MEDIA_JOURNAL_CORRUPT"
    );
  }

  #[test]
  #[cfg(windows)]
  fn partial_send_retry_keeps_ids_and_rejects_old_attempt_and_account() {
    let mut registry = unlocked_registry();
    let input = fixture_input(MediaOperationKind::Send);
    let id = input.id.clone();
    registry.register(input, NOW, false).unwrap();
    registry
      .update(
        &id,
        1,
        1,
        MediaOperationPatch {
          stage: Some(MediaOperationStage::Sending),
          ..Default::default()
        },
        NOW + 1,
      )
      .unwrap();
    registry
      .update(
        &id,
        1,
        2,
        MediaOperationPatch {
          confirmed: Some(1),
          ..Default::default()
        },
        NOW + 2,
      )
      .unwrap();
    registry
      .update(
        &id,
        1,
        3,
        MediaOperationPatch {
          stage: Some(MediaOperationStage::Failed),
          ..Default::default()
        },
        NOW + 3,
      )
      .unwrap();
    assert_eq!(
      registry.retry(&id, Some("999"), NOW + 4).unwrap_err(),
      "MEDIA_ACCOUNT_CHANGED"
    );
    registry.retry(&id, Some("123"), NOW + 4).unwrap();
    let operation = &registry.operations[0];
    assert_eq!(operation.attempt, 2);
    assert_eq!(operation.send.as_ref().unwrap().confirmed, 1);
    assert_eq!(
      operation.send.as_ref().unwrap().random_ids,
      ["101", "102", "103"]
    );
    let revision = operation.revision;
    assert_eq!(
      registry
        .update(
          &id,
          1,
          revision,
          MediaOperationPatch {
            confirmed: Some(2),
            ..Default::default()
          },
          NOW + 5
        )
        .unwrap_err(),
      "MEDIA_OPERATION_STALE"
    );
    assert_eq!(
      registry
        .update(
          &id,
          2,
          revision,
          MediaOperationPatch {
            confirmed: Some(0),
            ..Default::default()
          },
          NOW + 5
        )
        .unwrap_err(),
      "MEDIA_CONFIRMATION_DENIED"
    );
    let restored = Registry::load(registry.directory.clone(), NOW + 6);
    assert_eq!(
      restored.operations[0].stage,
      MediaOperationStage::Interrupted
    );
    assert_eq!(restored.operations[0].send.as_ref().unwrap().confirmed, 1);
  }

  #[test]
  #[cfg(windows)]
  fn in_flight_restart_is_uncertain_and_cannot_be_retried() {
    let mut registry = unlocked_registry();
    let input = fixture_input(MediaOperationKind::Send);
    let id = input.id.clone();
    registry.register(input, NOW, false).unwrap();
    registry
      .update(
        &id,
        1,
        1,
        MediaOperationPatch {
          stage: Some(MediaOperationStage::Sending),
          ..Default::default()
        },
        NOW + 1,
      )
      .unwrap();
    let mut restored = Registry::load(registry.directory.clone(), NOW + 2);
    restored.is_locked = false;
    assert_eq!(restored.operations[0].stage, MediaOperationStage::Uncertain);
    assert_eq!(
      restored.retry(&id, Some("123"), NOW + 3).unwrap_err(),
      "MEDIA_OUTCOME_UNCERTAIN"
    );
  }

  #[test]
  #[cfg(windows)]
  fn lock_redacts_history_allows_ack_but_blocks_next_send() {
    let mut registry = unlocked_registry();
    let input = fixture_input(MediaOperationKind::Send);
    let id = input.id.clone();
    registry.register(input, NOW, false).unwrap();
    registry
      .update(
        &id,
        1,
        1,
        MediaOperationPatch {
          stage: Some(MediaOperationStage::Sending),
          ..Default::default()
        },
        NOW + 1,
      )
      .unwrap();
    registry.is_locked = true;
    assert!(registry.snapshot().unwrap().operations.is_empty());
    registry
      .update(
        &id,
        1,
        2,
        MediaOperationPatch {
          confirmed: Some(1),
          ..Default::default()
        },
        NOW + 2,
      )
      .unwrap();
    assert_eq!(
      registry
        .update(
          &id,
          1,
          3,
          MediaOperationPatch {
            stage: Some(MediaOperationStage::Sending),
            ..Default::default()
          },
          NOW + 3
        )
        .unwrap_err(),
      "MEDIA_JOURNAL_LOCKED"
    );
    assert!(
      registry
        .register(fixture_input(MediaOperationKind::Save), NOW, false)
        .is_ok()
    );
    assert_eq!(
      registry
        .register(fixture_input(MediaOperationKind::Send), NOW, false)
        .unwrap_err(),
      "MEDIA_JOURNAL_LOCKED"
    );
  }

  #[test]
  #[cfg(windows)]
  fn progress_is_transient_and_keeps_confirmation_revision_stable() {
    let mut registry = unlocked_registry();
    let input = fixture_input(MediaOperationKind::Save);
    let id = input.id.clone();
    registry.register(input, NOW, false).unwrap();
    let before = fs::read(registry.directory.join(JOURNAL_NAME)).unwrap();
    assert!(
      !registry
        .update(
          &id,
          1,
          1,
          MediaOperationPatch {
            progress: Some(MediaOperationProgress {
              loaded: 42,
              total: Some(100),
              index: Some(0),
              count: Some(1)
            }),
            ..Default::default()
          },
          NOW + 1
        )
        .unwrap()
    );
    assert_eq!(registry.operations[0].revision, 1);
    assert_eq!(
      fs::read(registry.directory.join(JOURNAL_NAME)).unwrap(),
      before
    );
    assert!(
      load_journal(&registry.directory).unwrap()[0]
        .progress
        .is_none()
    );
  }

  #[test]
  #[cfg(windows)]
  fn clear_removes_only_terminal_records_and_keeps_saved_files() {
    let mut registry = unlocked_registry();
    let input = fixture_input(MediaOperationKind::Save);
    let id = input.id.clone();
    registry.register(input, NOW, false).unwrap();
    let path = registry.directory.join("fixture.png");
    fs::write(&path, b"owned fixture bytes").unwrap();
    let file = inspect_saved_file(&path, "fixture.png", "image/png", 19).unwrap();
    registry.register_file(&id, file, NOW + 1).unwrap();
    registry
      .update(
        &id,
        1,
        2,
        MediaOperationPatch {
          stage: Some(MediaOperationStage::Writing),
          ..Default::default()
        },
        NOW + 2,
      )
      .unwrap();
    registry
      .update(
        &id,
        1,
        3,
        MediaOperationPatch {
          stage: Some(MediaOperationStage::Completed),
          ..Default::default()
        },
        NOW + 3,
      )
      .unwrap();
    registry
      .register(fixture_input(MediaOperationKind::Save), NOW + 4, false)
      .unwrap();
    registry.remove(None, NOW + 5).unwrap();
    assert_eq!(registry.operations.len(), 1);
    assert_eq!(registry.operations[0].stage, MediaOperationStage::Queued);
    assert_eq!(fs::read(&path).unwrap(), b"owned fixture bytes");
  }

  #[test]
  #[cfg(windows)]
  fn source_fingerprint_cannot_change_during_partial_send_retry() {
    let mut registry = unlocked_registry();
    let input = fixture_input(MediaOperationKind::Send);
    let id = input.id.clone();
    registry.register(input, NOW, false).unwrap();
    assert_eq!(
      registry
        .update(
          &id,
          1,
          1,
          MediaOperationPatch {
            fingerprints: Some(vec!["d".repeat(64); 3]),
            ..Default::default()
          },
          NOW + 1
        )
        .unwrap_err(),
      "MEDIA_SOURCE_CHANGED"
    );
    assert_eq!(registry.operations[0].revision, 1);
  }

  #[test]
  #[cfg(windows)]
  fn queued_download_start_failure_retains_failed_result_and_releases_quota() {
    let mut registry = unlocked_registry();
    let input = fixture_input(MediaOperationKind::Download);
    let id = input.id.clone();
    registry.register(input, NOW, true).unwrap();
    assert_eq!(registry.operations[0].stage, MediaOperationStage::Queued);
    assert_eq!(registry.operations[0].revision, 1);
    let mut operations = registry.operations.clone();
    for _ in 1..MAX_ACTIVE_DOWNLOADS {
      let mut operation = operations[0].clone();
      operation.id = uuid::Uuid::new_v4().to_string();
      operations.push(operation);
    }
    registry.commit(operations, NOW).unwrap();
    let next = fixture_input(MediaOperationKind::Download);
    assert_eq!(registry.register(next.clone(), NOW, true).unwrap_err(), "MEDIA_QUEUE_FULL");
    let original = registry.directory.clone();
    let before = fs::read(original.join(JOURNAL_NAME)).unwrap();
    let blocked = original.join("blocked-journal-location");
    fs::write(&blocked, b"file blocks directory creation").unwrap();
    registry.directory = blocked;
    let start_error = registry.update(
      &id, 1, 1,
      MediaOperationPatch { stage: Some(MediaOperationStage::Downloading), ..Default::default() },
      NOW + 1,
    ).unwrap_err();
    assert!(start_error.contains("JOURNAL"));
    assert_eq!(registry.operations[0].stage, MediaOperationStage::Queued);
    assert_eq!(registry.operations[0].revision, 1);
    let epoch = registry.epoch;
    assert!(registry.update(
      &id, 1, 1,
      MediaOperationPatch {
        stage: Some(MediaOperationStage::Failed), error: Some("MEDIA_DOWNLOAD_FAILED".into()),
        ..Default::default()
      },
      NOW + 2,
    ).is_err());
    let failed = &registry.operations[0];
    assert_eq!(failed.stage, MediaOperationStage::Failed);
    assert_eq!(failed.revision, 2);
    assert_eq!(failed.completed_at, Some(NOW + 2));
    assert_eq!(failed.error.as_deref(), Some("MEDIA_DOWNLOAD_FAILED"));
    assert!(failed.journal_warning.as_deref().is_some_and(|warning| warning.contains("JOURNAL")));
    assert!(registry.epoch > epoch);
    assert_eq!(registry.operations.iter().filter(|operation| !operation.stage.is_terminal()).count(), MAX_ACTIVE_DOWNLOADS - 1);
    assert_eq!(fs::read(original.join(JOURNAL_NAME)).unwrap(), before);
    registry.directory = original;
    registry.register(next, NOW + 3, true).unwrap();
    assert_eq!(registry.operations.iter().filter(|operation| !operation.stage.is_terminal()).count(), MAX_ACTIVE_DOWNLOADS);
    assert_eq!(registry.operations[0].stage, MediaOperationStage::Failed);
  }

  #[test]
  #[cfg(windows)]
  fn cancellation_stops_runtime_even_when_journal_cannot_write() {
    let mut registry = unlocked_registry();
    let input = fixture_input(MediaOperationKind::Download);
    let id = input.id.clone();
    registry.register(input, NOW, true).unwrap();
    registry
      .update(
        &id,
        1,
        1,
        MediaOperationPatch {
          stage: Some(MediaOperationStage::Downloading),
          ..Default::default()
        },
        NOW + 1,
      )
      .unwrap();
    let original = registry.directory.clone();
    let before = fs::read(original.join(JOURNAL_NAME)).unwrap();
    let blocked = original.join("blocked-journal-location");
    fs::write(&blocked, b"file blocks directory creation").unwrap();
    registry.directory = blocked;
    assert!(registry.cancel(&id, NOW + 2).is_err());
    assert!(registry.cancel_requested.contains(&id));
    assert_eq!(registry.cancelled_downloads, [id]);
    assert_eq!(
      registry.operations[0].stage,
      MediaOperationStage::Cancelling
    );
    assert_eq!(fs::read(original.join(JOURNAL_NAME)).unwrap(), before);
    assert!(can_transition(
      MediaOperationStage::Downloading,
      MediaOperationStage::Cancelled
    ));
  }

  #[test]
  #[cfg(windows)]
  fn trusted_file_stays_available_in_memory_after_persistence_failure() {
    let mut registry = unlocked_registry();
    let input = fixture_input(MediaOperationKind::Save);
    let id = input.id.clone();
    registry.register(input, NOW, false).unwrap();
    let original = registry.directory.clone();
    let path = original.join("fixture.png");
    fs::write(&path, b"owned fixture bytes").unwrap();
    let file = inspect_saved_file(&path, "fixture.png", "image/png", 19).unwrap();
    let before = fs::read(original.join(JOURNAL_NAME)).unwrap();
    let blocked = original.join("blocked-journal-location");
    fs::write(&blocked, b"file blocks directory creation").unwrap();
    registry.directory = blocked;
    let epoch = registry.epoch;
    assert!(registry.register_file(&id, file, NOW + 1).is_err());
    assert_eq!(registry.operations[0].files.len(), 1);
    assert!(registry.epoch > epoch);
    assert_eq!(
      find_registered_path(&registry, &id, 0).unwrap(),
      fs::canonicalize(&path).unwrap()
    );
    assert_eq!(fs::read(original.join(JOURNAL_NAME)).unwrap(), before);
  }

  #[test]
  #[cfg(windows)]
  fn snapshot_epoch_orders_lock_progress_and_clear_events() {
    let mut registry = unlocked_registry();
    let input = fixture_input(MediaOperationKind::Save);
    let id = input.id.clone();
    registry.register(input, NOW, false).unwrap();
    let before = registry.snapshot().unwrap();
    registry
      .update(
        &id,
        1,
        1,
        MediaOperationPatch {
          progress: Some(MediaOperationProgress {
            loaded: 42,
            total: None,
            index: None,
            count: None,
          }),
          ..Default::default()
        },
        NOW + 1,
      )
      .unwrap();
    let progress = registry.snapshot().unwrap();
    registry.set_locked(true).unwrap();
    let locked = registry.snapshot().unwrap();
    assert!(before.epoch < progress.epoch && progress.epoch < locked.epoch);
    assert!(locked.is_locked && locked.operations.is_empty());
    registry.set_locked(false).unwrap();
    registry.cancel(&id, NOW + 2).unwrap();
    let cancelled = registry.snapshot().unwrap();
    registry.remove(None, NOW + 3).unwrap();
    assert!(registry.snapshot().unwrap().epoch > cancelled.epoch);
  }

  #[test]
  fn provider_host_variants_normalize_to_one_canonical_post() {
    let expected = "https://x.com/i/status/1234567890";
    for value in [
      "https://www.x.com/fixture/status/1234567890",
      "https://www.twitter.com/fixture/status/1234567890",
      "https://mobile.twitter.com/fixture/status/1234567890",
    ] {
      assert_eq!(
        canonicalize_source_url(MediaOperationService::X, value).unwrap(),
        expected
      );
    }
    assert_eq!(
      canonicalize_source_url(
        MediaOperationService::Instagram,
        "https://instagram.com/reels/AbCd123/"
      )
      .unwrap(),
      "https://www.instagram.com/reel/AbCd123/"
    );
  }

  #[test]
  #[cfg(windows)]
  fn recovery_cleans_only_owned_journal_parts_after_valid_read() {
    let directory = native_directory();
    persist_journal(
      &directory,
      &[fixture_operation(MediaOperationStage::Completed)],
    )
    .unwrap();
    let owned = directory.join(format!("journal-{}.part", uuid::Uuid::new_v4()));
    let unrelated = directory.join("user-notes.part");
    fs::write(&owned, b"owned partial encrypted write").unwrap();
    fs::write(&unrelated, b"leave this file alone").unwrap();
    load_journal(&directory).unwrap();
    assert!(!owned.exists());
    assert!(unrelated.exists());
    fs::write(directory.join(JOURNAL_NAME), b"damaged journal").unwrap();
    fs::write(&owned, b"preserve recovery evidence").unwrap();
    assert!(load_journal(&directory).is_err());
    assert!(owned.exists());
  }

  #[test]
  #[cfg(windows)]
  fn terminal_result_is_kept_in_memory_but_failed_pre_send_never_advances() {
    let mut registry = unlocked_registry();
    let save = fixture_input(MediaOperationKind::Save);
    let save_id = save.id.clone();
    registry.register(save, NOW, false).unwrap();
    let original = registry.directory.clone();
    let path = original.join("fixture.png");
    fs::write(&path, b"owned fixture bytes").unwrap();
    registry
      .register_file(
        &save_id,
        inspect_saved_file(&path, "fixture.png", "image/png", 19).unwrap(),
        NOW + 1,
      )
      .unwrap();
    registry
      .update(
        &save_id,
        1,
        2,
        MediaOperationPatch {
          stage: Some(MediaOperationStage::Writing),
          ..Default::default()
        },
        NOW + 2,
      )
      .unwrap();
    let send = fixture_input(MediaOperationKind::Send);
    let send_id = send.id.clone();
    registry.register(send, NOW + 3, false).unwrap();
    let blocked = original.join("blocked-journal-location");
    fs::write(&blocked, b"file blocks directory creation").unwrap();
    registry.directory = blocked;
    assert!(
      registry
        .update(
          &send_id,
          1,
          1,
          MediaOperationPatch {
            stage: Some(MediaOperationStage::Sending),
            ..Default::default()
          },
          NOW + 4
        )
        .is_err()
    );
    assert_eq!(registry.operations[1].stage, MediaOperationStage::Queued);
    assert_eq!(registry.operations[1].revision, 1);
    assert!(
      registry
        .update(
          &save_id,
          1,
          3,
          MediaOperationPatch {
            stage: Some(MediaOperationStage::Completed),
            ..Default::default()
          },
          NOW + 5
        )
        .is_err()
    );
    assert_eq!(registry.operations[0].stage, MediaOperationStage::Completed);
    assert!(registry.operations[0].journal_warning.is_some());
    assert!(registry.operations[0].error.is_none());
    assert!(find_registered_path(&registry, &save_id, 0).is_ok());
    registry.directory = original;
    registry
      .commit(registry.operations.clone(), NOW + 6)
      .unwrap();
    assert!(registry.operations[0].journal_warning.is_none());
    let encrypted = fs::read(registry.directory.join(JOURNAL_NAME)).unwrap();
    let plain = unprotect_data(&encrypted[JOURNAL_HEADER.len()..]).unwrap();
    assert!(!String::from_utf8(plain).unwrap().contains("journalWarning"));
  }

  #[test]
  #[cfg(windows)]
  fn dpapi_decryption_failure_quarantines_journal_and_preserves_recovery_parts() {
    let directory = native_directory();
    persist_journal(
      &directory,
      &[fixture_operation(MediaOperationStage::Completed)],
    )
    .unwrap();
    let path = directory.join(JOURNAL_NAME);
    let mut damaged = fs::read(&path).unwrap();
    let last = damaged.len() - 1;
    damaged[last] ^= 0x20;
    fs::write(&path, &damaged).unwrap();
    let owned = directory.join(format!("journal-{}.part", uuid::Uuid::new_v4()));
    fs::write(&owned, b"preserve recovery evidence").unwrap();
    let mut registry = Registry::load(directory.clone(), NOW);
    registry.is_locked = false;
    let snapshot = registry.snapshot().unwrap();
    assert_eq!(
      snapshot.journal_notice.as_deref(),
      Some("MEDIA_JOURNAL_DECRYPT_FAILED")
    );
    assert!(snapshot.operations.is_empty());
    let quarantined = directory.join(format!("{JOURNAL_NAME}{QUARANTINE_INFIX}{NOW}"));
    assert_eq!(fs::read(&quarantined).unwrap(), damaged);
    assert!(owned.exists());
    registry
      .register(fixture_input(MediaOperationKind::Save), NOW, false)
      .unwrap();
  }
}
