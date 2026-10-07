use std::process::Child;
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
      let _ = TerminateJobObject(self.0, 1);
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
