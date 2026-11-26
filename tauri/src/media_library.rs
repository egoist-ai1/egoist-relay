use std::{
  collections::BTreeMap,
  path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

use crate::{
  media_operations::{
    MediaOperation, MediaOperationFile, MediaOperationKind, MediaOperationService,
    canonicalize_source_url,
  },
  media_store,
};

const NAME: &str = "library-v1.dpapi";
const ENTROPY: &[u8] = b"EgoistRelay/MediaLibrary/v1";
const MAX_RECORDS: usize = 20_000;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record {
  service: MediaOperationService,
  source_url: Option<String>,
  saved_at: u64,
  #[serde(skip_serializing_if = "Option::is_none")]
  file: Option<MediaOperationFile>,
}

type Records = BTreeMap<String, Option<Record>>;

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Catalogue {
  version: u8,
  records: Records,
}

pub(crate) struct Library {
  directory: PathBuf,
  records: Records,
  load_error: Option<&'static str>,
  archive_error: Option<&'static str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snapshot {
  entries: Vec<Entry>,
  is_locked: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  error: Option<&'static str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
  id: String,
  service: MediaOperationService,
  #[serde(skip_serializing_if = "Option::is_none")]
  source_url: Option<String>,
  file_name: String,
  mime_type: String,
  size: u64,
  saved_at: u64,
  is_link: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum Action {
  Open,
  Reveal,
  Remove,
  SaveLink,
}

impl Library {
  pub(crate) fn load(directory: &Path) -> Self {
    let (records, load_error) = match media_store::read::<Catalogue>(directory, NAME, ENTROPY) {
      Ok(None) => (Records::new(), None),
      Ok(Some(catalogue)) if catalogue.version == 1 && catalogue.records.len() <= MAX_RECORDS => {
        (catalogue.records, None)
      }
      Ok(Some(_)) => (Records::new(), Some("MEDIA_STORE_CORRUPT")),
      Err(error) => (Records::new(), Some(error)),
    };
    Self {
      directory: directory.to_path_buf(),
      records,
      load_error,
      archive_error: None,
    }
  }

  pub(crate) fn archive(&mut self, operations: &[MediaOperation]) {
    if self.load_error.is_some() {
      return;
    }
    let mut added = Records::new();
    for operation in operations {
      if !matches!(
        operation.kind,
        MediaOperationKind::Save | MediaOperationKind::Download
      ) {
        continue;
      }
      for (index, file) in operation.files.iter().enumerate() {
        let id = format!("{}:{index}", operation.id);
        if self.records.contains_key(&id) {
          continue;
        }
        added.insert(
          id,
          Some(Record {
            service: operation.service,
            source_url: operation.source_url.clone(),
            saved_at: operation.completed_at.unwrap_or(operation.updated_at),
            file: Some(file.clone()),
          }),
        );
      }
    }
    if added.is_empty() {
      return;
    }
    let mut records = self.records.clone();
    records.extend(added);
    self.archive_error = self.commit(records).err();
  }

  pub(crate) fn snapshot(&self, is_locked: bool) -> Snapshot {
    let entries = if is_locked {
      Vec::new()
    } else {
      self
        .records
        .iter()
        .filter_map(|(id, value)| {
          let record = value.as_ref()?;
          Some(Entry {
            id: id.clone(),
            service: record.service,
            source_url: record.source_url.clone(),
            file_name: record
              .file
              .as_ref()
              .map(|file| file.file_name.clone())
              .or_else(|| record.source_url.clone())
              .unwrap_or_default(),
            mime_type: record
              .file
              .as_ref()
              .map(|file| file.mime_type.clone())
              .unwrap_or_default(),
            size: record.file.as_ref().map_or(0, |file| file.size),
            saved_at: record.saved_at,
            is_link: record.file.is_none(),
          })
        })
        .collect()
    };
    Snapshot {
      entries,
      is_locked,
      error: if is_locked {
        None
      } else {
        self.load_error.or(self.archive_error)
      },
    }
  }

  pub(crate) fn file(&self, id: &str) -> Result<&MediaOperationFile, String> {
    self
      .record(id)?
      .file
      .as_ref()
      .ok_or_else(|| "MEDIA_FILE_MISSING".into())
  }

  fn record(&self, id: &str) -> Result<&Record, String> {
    if let Some(error) = self.load_error {
      return Err(error.into());
    }
    self
      .records
      .get(id)
      .and_then(Option::as_ref)
      .ok_or_else(|| "MEDIA_OPERATION_NOT_FOUND".into())
  }

  pub(crate) fn remove(&mut self, id: &str) -> Result<(), String> {
    let is_file = self.record(id)?.file.is_some();
    let mut records = self.records.clone();
    // Пометка сохраняется на случай повторного переноса этой записи из истории загрузок
    if is_file {
      records.insert(id.to_string(), None);
    } else {
      records.remove(id);
    }
    self.commit(records).map_err(str::to_string)
  }

  pub(crate) fn save_link(&mut self, input: &str, now: u64) -> Result<(), String> {
    if let Some(error) = self.load_error {
      return Err(error.into());
    }
    let (service, source_url) = public_post(input)?;
    if self
      .records
      .values()
      .filter_map(Option::as_ref)
      .any(|entry| entry.file.is_none() && entry.source_url.as_deref() == Some(source_url.as_str()))
    {
      return Ok(());
    }
    let mut records = self.records.clone();
    let id = uuid::Uuid::new_v4().to_string();
    records.insert(
      id,
      Some(Record {
        service,
        source_url: Some(source_url),
        saved_at: now,
        file: None,
      }),
    );
    self.commit(records).map_err(str::to_string)
  }

  fn commit(&mut self, records: Records) -> Result<(), &'static str> {
    if records.len() > MAX_RECORDS {
      return Err("MEDIA_STORE_FULL");
    }
    let catalogue = Catalogue {
      version: 1,
      records,
    };
    media_store::write(&self.directory, NAME, ENTROPY, &catalogue)?;
    self.records = catalogue.records;
    Ok(())
  }
}

fn public_post(input: &str) -> Result<(MediaOperationService, String), String> {
  if input.len() > 2048 {
    return Err("MEDIA_SOURCE_DENIED".into());
  }
  let mut url = url::Url::parse(input.trim()).map_err(|_| "MEDIA_SOURCE_DENIED")?;
  if url.scheme() != "https"
    || !url.username().is_empty()
    || url.password().is_some()
    || url.port().is_some()
  {
    return Err("MEDIA_SOURCE_DENIED".into());
  }
  let service = match url.host_str() {
    Some("x.com" | "twitter.com" | "www.x.com" | "www.twitter.com" | "mobile.twitter.com") => {
      MediaOperationService::X
    }
    Some("instagram.com" | "www.instagram.com") => MediaOperationService::Instagram,
    Some("t.me") => {
      let path = url
        .path()
        .strip_prefix("/s/")
        .unwrap_or_else(|| url.path().trim_start_matches('/'));
      let (name, message) = path
        .trim_end_matches('/')
        .split_once('/')
        .ok_or("MEDIA_SOURCE_DENIED")?;
      if !(4..=32).contains(&name.len())
        || !name.as_bytes()[0].is_ascii_alphabetic()
        || !name
          .bytes()
          .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
        || !message.parse::<u32>().is_ok_and(|id| id > 0)
        || !message.bytes().all(|byte| byte.is_ascii_digit())
      {
        return Err("MEDIA_SOURCE_DENIED".into());
      }
      url.set_path(&format!("/{name}/{message}"));
      MediaOperationService::Telegram
    }
    _ => return Err("MEDIA_SOURCE_DENIED".into()),
  };
  url.set_query(None);
  url.set_fragment(None);
  Ok((service, canonicalize_source_url(service, url.as_str())?))
}

#[cfg(all(test, windows))]
mod tests {
  use super::*;

  #[test]
  fn saves_public_post_without_a_file_and_deduplicates_after_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let mut library = Library::load(directory.path());
    library
      .save_link("https://t.me/s/telegram/178?fixture=1", 100)
      .unwrap();
    assert!(library.save_link("https://t.me/c/123456/178", 101).is_err());
    assert!(
      library
        .save_link("https://t.me@untrusted.invalid/telegram/178", 101)
        .is_err()
    );
    let mut reopened = Library::load(directory.path());
    reopened
      .save_link("https://t.me/telegram/178", 101)
      .unwrap();
    let snapshot = reopened.snapshot(false);
    assert_eq!(snapshot.entries.len(), 1);
    let entry = &snapshot.entries[0];
    assert!(entry.is_link);
    assert_eq!(
      entry.source_url.as_deref(),
      Some("https://t.me/telegram/178")
    );
    reopened.remove(&entry.id).unwrap();
    assert!(
      Library::load(directory.path())
        .snapshot(false)
        .entries
        .is_empty()
    );
  }
}
