use std::process::Child;

/// Код выхода для журнала: десятичный и в виде NTSTATUS (0x40010004 — завершение сеанса Windows,
/// 1 — `TerminateProcess` извне или обычный `exit(1)`), чтобы отличать убийство извне от своего падения.
pub(crate) fn exit_code_text(code: Option<i32>) -> String {
  match code {
    Some(code) if code as u32 == OWNED_EXIT_CODE => format!("code={code} (0x{:08X}, завершён приложением)", code as u32),
    Some(code) => format!("code={code} (0x{:08X})", code as u32),
    None => "code=unknown".to_string(),
  }
}

/// Код, которым приложение завершает свои процессы (`TerminateJobObject`). Отличается от 1, который
/// дают `taskkill /F`, `TerminateProcess` извне и `exit(1)`: код 1 в журнале значит «не мы».
pub(crate) const OWNED_EXIT_CODE: u32 = 0xE601_0001;

#[cfg(windows)]
pub(crate) struct WorkerJob(*mut std::ffi::c_void);
#[cfg(windows)]
impl WorkerJob {
  pub(crate) fn attach(child: &Child) -> Result<Self, String> {
    use std::os::windows::io::AsRawHandle;
    #[repr(C)]
    struct Basic {
      process_time: i64,
      job_time: i64,
      flags: u32,
      min_working: usize,
      max_working: usize,
      active_limit: u32,
      affinity: usize,
      priority: u32,
      scheduling: u32,
    }
    #[repr(C)]
    struct Counters {
      read_count: u64,
      write_count: u64,
      other_count: u64,
      read_bytes: u64,
      write_bytes: u64,
      other_bytes: u64,
    }
    #[repr(C)]
    struct Extended {
      basic: Basic,
      io: Counters,
      process_memory: usize,
      job_memory: usize,
      peak_process: usize,
      peak_job: usize,
    }
    unsafe {
      let handle = CreateJobObjectW(std::ptr::null_mut(), std::ptr::null());
      if handle.is_null() {
        return Err("MEDIA_OWNERSHIP_FAILED".into());
      }
      let job = Self(handle);
      let mut info: Extended = std::mem::zeroed();
      info.basic.flags = 0x2000;
      if SetInformationJobObject(
        handle,
        9,
        &mut info as *mut _ as *mut std::ffi::c_void,
        std::mem::size_of::<Extended>() as u32,
      ) == 0
        || AssignProcessToJobObject(handle, child.as_raw_handle() as *mut std::ffi::c_void) == 0
      {
        return Err("MEDIA_OWNERSHIP_FAILED".into());
      }
      Ok(job)
    }
  }
  pub(crate) fn terminate(&self) {
    unsafe {
      let _ = TerminateJobObject(self.0, OWNED_EXIT_CODE);
    }
  }
}
#[cfg(windows)]
impl Drop for WorkerJob {
  fn drop(&mut self) {
    unsafe {
      let _ = CloseHandle(self.0);
    }
  }
}
#[cfg(windows)]
unsafe extern "system" {
  fn CreateJobObjectW(attributes: *mut std::ffi::c_void, name: *const u16)
  -> *mut std::ffi::c_void;
  fn SetInformationJobObject(
    job: *mut std::ffi::c_void,
    class: i32,
    information: *mut std::ffi::c_void,
    size: u32,
  ) -> i32;
  fn AssignProcessToJobObject(job: *mut std::ffi::c_void, process: *mut std::ffi::c_void) -> i32;
  fn TerminateJobObject(job: *mut std::ffi::c_void, exit: u32) -> i32;
  fn CloseHandle(object: *mut std::ffi::c_void) -> i32;
}
#[cfg(not(windows))]
pub(crate) struct WorkerJob;
#[cfg(not(windows))]
impl WorkerJob {
  pub(crate) fn attach(_child: &Child) -> Result<Self, String> {
    Err("MEDIA_RUNTIME_UNAVAILABLE".into())
  }
  pub(crate) fn terminate(&self) {}
}

#[cfg(test)]
mod tests {
  use super::{OWNED_EXIT_CODE, exit_code_text};

  #[test]
  fn exit_code_text_shows_decimal_and_ntstatus() {
    assert_eq!(exit_code_text(Some(1)), "code=1 (0x00000001)");
    assert_eq!(exit_code_text(Some(0x4001_0004)), "code=1073807364 (0x40010004)");
    assert_eq!(exit_code_text(Some(-1)), "code=-1 (0xFFFFFFFF)");
    assert_eq!(exit_code_text(None), "code=unknown");
    assert!(exit_code_text(Some(OWNED_EXIT_CODE as i32)).contains("завершён приложением"));
  }
}
