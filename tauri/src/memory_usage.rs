//! Память приложения для плашки в заголовке: сумма рабочих наборов процесса и всех его потомков
//! (WebView2 каждого сервиса, Node, Xray, tg-ws-proxy). Отдельные процессы с общими страницами
//! дают небольшое завышение — как в диспетчере задач, по которому сверялась базовая линия цикла.
use serde::Serialize;

#[derive(Serialize, Default, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MemoryUsage {
  /// Рабочий набор всех процессов приложения, байт
  pub bytes: u64,
  /// Сколько процессов учтено (само приложение и потомки)
  pub processes: u32,
}

/// PID приложения и всех потомков по таблице «PID -> PID родителя». Обход идёт только вниз от `root`;
/// множество `seen` защищает от циклов (Windows не обнуляет PID родителя после его выхода,
/// а номера переиспользуются).
pub(crate) fn descendants(parents: &std::collections::HashMap<u32, u32>, root: u32) -> Vec<u32> {
  let mut seen = std::collections::HashSet::from([root]);
  let mut order = vec![root];
  let mut index = 0;
  while index < order.len() {
    let current = order[index];
    index += 1;
    for (&pid, &parent) in parents {
      if parent == current && pid != current && seen.insert(pid) {
        order.push(pid);
      }
    }
  }
  order
}

#[tauri::command]
pub(crate) async fn relay_memory_usage(webview: tauri::Webview) -> Result<MemoryUsage, String> {
  if webview.label() != "main" {
    return Err("MEMORY_USAGE_DENIED".into());
  }
  tauri::async_runtime::spawn_blocking(measure)
    .await
    .map_err(|_| "MEMORY_USAGE_UNAVAILABLE".to_string())?
}

#[cfg(not(windows))]
fn measure() -> Result<MemoryUsage, String> {
  Ok(MemoryUsage::default())
}

#[cfg(windows)]
fn measure() -> Result<MemoryUsage, String> {
  let parents = crate::telegram_transport::process_parents().ok_or("MEMORY_USAGE_UNAVAILABLE")?;
  let mut usage = MemoryUsage::default();
  for pid in descendants(&parents, std::process::id()) {
    // Процесс мог завершиться между снимком и запросом — такой просто пропускаем
    if let Some(bytes) = working_set(pid) {
      usage.bytes += bytes;
      usage.processes += 1;
    }
  }
  Ok(usage)
}

#[cfg(windows)]
fn working_set(pid: u32) -> Option<u64> {
  // PROCESS_QUERY_LIMITED_INFORMATION
  const ACCESS: u32 = 0x1000;
  #[repr(C)]
  struct Counters {
    size: u32,
    page_faults: u32,
    peak_working_set: usize,
    working_set: usize,
    quota_peak_paged: usize,
    quota_paged: usize,
    quota_peak_nonpaged: usize,
    quota_nonpaged: usize,
    pagefile: usize,
    peak_pagefile: usize,
  }
  unsafe {
    let handle = OpenProcess(ACCESS, 0, pid);
    if handle.is_null() {
      return None;
    }
    let mut counters: Counters = std::mem::zeroed();
    counters.size = std::mem::size_of::<Counters>() as u32;
    let ok = K32GetProcessMemoryInfo(handle, (&mut counters as *mut Counters).cast(), counters.size);
    CloseHandle(handle);
    (ok != 0).then_some(counters.working_set as u64)
  }
}

#[cfg(windows)]
unsafe extern "system" {
  fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut std::ffi::c_void;
  fn K32GetProcessMemoryInfo(process: *mut std::ffi::c_void, counters: *mut std::ffi::c_void, size: u32) -> i32;
  fn CloseHandle(object: *mut std::ffi::c_void) -> i32;
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::collections::HashMap;

  #[test]
  fn walks_only_down_the_tree() {
    let parents = HashMap::from([(10, 1), (11, 10), (12, 11), (20, 2), (21, 20)]);
    let mut found = descendants(&parents, 10);
    found.sort();
    assert_eq!(found, vec![10, 11, 12]);
  }

  #[test]
  fn survives_cycles_and_self_parent() {
    let parents = HashMap::from([(5, 5), (6, 7), (7, 6), (8, 6)]);
    let mut found = descendants(&parents, 6);
    found.sort();
    assert_eq!(found, vec![6, 7, 8]);
    assert_eq!(descendants(&parents, 5), vec![5]);
  }

  #[cfg(windows)]
  #[test]
  fn measures_own_process() {
    let usage = measure().expect("замер");
    assert!(usage.processes >= 1);
    assert!(usage.bytes > 1_000_000);
  }
}
