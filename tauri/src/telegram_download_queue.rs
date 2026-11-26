use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Webview};

use crate::{media_operations, media_store};

const NAME: &str = "telegram-downloads-v1.dpapi";
const ENTROPY: &[u8] = b"EgoistRelay/TelegramDownloadQueue/v1";
const MAX_PENDING: usize = 64;
const RETENTION_MS: u64 = 7 * 24 * 60 * 60 * 1000;
static QUEUE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Request {
  id: String,
  chat_id: String,
  message_id: i32,
  media_hash: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PendingDownload {
  account_id: String,
  request: Request,
  created_at: u64,
  operation_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(
  tag = "type",
  rename_all = "kebab-case",
  rename_all_fields = "camelCase",
  deny_unknown_fields
)]
pub(crate) enum Action {
  List,
  Remember { request: Request },
  Associate { id: String, operation_id: String },
  Forget { id: String },
}

#[tauri::command(async)]
pub(crate) fn relay_telegram_download_queue(
  webview: Webview,
  app: AppHandle,
  account_id: String,
  action: Action,
) -> Result<Vec<Request>, String> {
  crate::social_share::require_main(&webview)?;
  validate_account(&account_id)?;
  let completed = media_operations::completed_downloads_for_recovery(&app)?;
  let directory = crate::multi_app::get_service_data_directory(&app, "media-operations")?;
  let _guard = QUEUE_LOCK.lock().map_err(|_| "MEDIA_QUEUE_BUSY")?;
  let mut queue =
    media_store::read::<Vec<PendingDownload>>(&directory, NAME, ENTROPY)?.unwrap_or_default();
  if queue.len() > MAX_PENDING {
    return Err("MEDIA_QUEUE_CORRUPT".into());
  }
  let now = media_operations::now_ms();
  let before = queue.len();
  queue.retain(|entry| {
    now.saturating_sub(entry.created_at) <= RETENTION_MS
      && !entry
        .operation_id
        .as_ref()
        .is_some_and(|id| completed.contains(id))
  });
  let changed = queue.len() != before;
  if apply(&mut queue, &account_id, action, now)? || changed {
    media_store::write(&directory, NAME, ENTROPY, &queue)?;
  }
  Ok(
    queue
      .into_iter()
      .filter(|entry| entry.account_id == account_id)
      .map(|entry| entry.request)
      .collect(),
  )
}

fn apply(
  queue: &mut Vec<PendingDownload>,
  account_id: &str,
  action: Action,
  now: u64,
) -> Result<bool, String> {
  match action {
    Action::List => Ok(false),
    Action::Remember { request } => {
      validate_request(&request)?;
      if let Some(entry) = queue.iter_mut().find(|entry| {
        entry.account_id == account_id && entry.request.media_hash == request.media_hash
      }) {
        if entry.request.id == request.id {
          return Ok(false);
        }
        *entry = PendingDownload {
          account_id: account_id.into(),
          request,
          created_at: now,
          operation_id: None,
        };
      } else {
        if queue.len() == MAX_PENDING {
          return Err("MEDIA_QUEUE_FULL".into());
        }
        queue.push(PendingDownload {
          account_id: account_id.into(),
          request,
          created_at: now,
          operation_id: None,
        });
      }
      Ok(true)
    }
    Action::Associate { id, operation_id } => {
      validate_id(&id)?;
      validate_id(&operation_id)?;
      if let Some(entry) = queue
        .iter_mut()
        .find(|entry| entry.account_id == account_id && entry.request.id == id)
      {
        if entry.operation_id.as_deref() == Some(operation_id.as_str()) {
          return Ok(false);
        }
        entry.operation_id = Some(operation_id);
        return Ok(true);
      }
      Ok(false)
    }
    Action::Forget { id } => {
      validate_id(&id)?;
      let before = queue.len();
      queue.retain(|entry| !(entry.account_id == account_id && entry.request.id == id));
      Ok(queue.len() != before)
    }
  }
}

fn validate_id(id: &str) -> Result<(), String> {
  if id.len() == 36 && uuid::Uuid::parse_str(id).is_ok() {
    Ok(())
  } else {
    Err("MEDIA_INPUT_DENIED".into())
  }
}

fn validate_account(id: &str) -> Result<(), String> {
  if id.len() <= 20
    && id.parse::<u64>().is_ok_and(|id| id > 0)
    && id.bytes().all(|byte| byte.is_ascii_digit())
  {
    Ok(())
  } else {
    Err("MEDIA_INPUT_DENIED".into())
  }
}

fn validate_request(request: &Request) -> Result<(), String> {
  validate_id(&request.id)?;
  let document = request
    .media_hash
    .strip_prefix("document")
    .ok_or("MEDIA_INPUT_DENIED")?;
  let document = document.strip_suffix("?download").unwrap_or(document);
  if request.message_id <= 0
    || request.chat_id.len() > 24
    || !request.chat_id.parse::<i64>().is_ok_and(|id| id != 0)
    || !document.parse::<i64>().is_ok_and(|id| id != 0)
    || document.len() > 20
  {
    return Err("MEDIA_INPUT_DENIED".into());
  }
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  fn request() -> Request {
    Request {
      id: uuid::Uuid::new_v4().to_string(),
      chat_id: "-100780".into(),
      message_id: 52,
      media_hash: "document789?download".into(),
    }
  }

  #[test]
  fn removing_an_old_attempt_leaves_the_new_attempt_and_other_accounts_intact() {
    let mut entries = Vec::new();
    let old = request();
    let next = request();
    apply(
      &mut entries,
      "1",
      Action::Remember {
        request: old.clone(),
      },
      10,
    )
    .unwrap();
    apply(
      &mut entries,
      "1",
      Action::Remember {
        request: next.clone(),
      },
      20,
    )
    .unwrap();
    apply(
      &mut entries,
      "2",
      Action::Remember {
        request: old.clone(),
      },
      20,
    )
    .unwrap();
    assert!(!apply(&mut entries, "1", Action::Forget { id: old.id.clone() }, 21).unwrap());
    assert_eq!(entries[0].request.id, next.id);
    assert_eq!(entries[1].request.id, old.id);
  }

  #[test]
  fn rejects_untrusted_media_and_copying_another_accounts_receipt() {
    let mut entries = Vec::new();
    let mut invalid = request();
    invalid.media_hash = "https://untrusted.invalid/file".into();
    assert!(apply(&mut entries, "1", Action::Remember { request: invalid }, 10).is_err());
    let known = request();
    apply(
      &mut entries,
      "2",
      Action::Remember {
        request: known.clone(),
      },
      10,
    )
    .unwrap();
    assert!(
      !apply(
        &mut entries,
        "1",
        Action::Associate {
          id: known.id,
          operation_id: uuid::Uuid::new_v4().to_string()
        },
        11
      )
      .unwrap()
    );
    assert!(entries[0].operation_id.is_none());
  }
}
