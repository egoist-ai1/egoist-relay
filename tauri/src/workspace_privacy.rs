use std::sync::Mutex;

#[derive(Clone, Copy, Debug)]
struct WorkspaceVisibility {
  generation: u64,
  locked: bool,
  covered: bool,
}

impl WorkspaceVisibility {
  const fn new() -> Self {
    Self { generation: 0, locked: true, covered: true }
  }

  fn set(&mut self, generation: u64, locked: bool, visible: bool) -> bool {
    if generation <= self.generation {
      return false;
    }
    *self = Self { generation, locked, covered: locked || !visible };
    true
  }

  fn allows_native_content(self) -> bool {
    !self.covered
  }
}

static VISIBILITY: Mutex<WorkspaceVisibility> = Mutex::new(WorkspaceVisibility::new());

pub(crate) fn set_visibility(generation: u64, locked: bool, visible: bool) -> bool {
  VISIBILITY.lock().unwrap_or_else(|error| error.into_inner()).set(generation, locked, visible)
}

pub(crate) fn allows_native_content() -> bool {
  VISIBILITY.lock().unwrap_or_else(|error| error.into_inner()).allows_native_content()
}

pub(crate) fn is_locked() -> bool {
  VISIBILITY.lock().unwrap_or_else(|error| error.into_inner()).locked
}

pub(crate) fn keep_covered() {
  VISIBILITY.lock().unwrap_or_else(|error| error.into_inner()).covered = true;
}

#[cfg(test)]
mod tests {
  use super::WorkspaceVisibility;

  #[test]
  fn locked_start_and_newer_lock_block_a_late_show() {
    let mut state = WorkspaceVisibility::new();
    assert!(!state.allows_native_content());
    assert!(state.set(1, false, true));
    assert!(state.allows_native_content());
    assert!(state.set(3, true, true));
    assert!(!state.set(2, false, true));
    assert!(state.locked);
    assert!(!state.allows_native_content());
    assert!(state.set(4, false, true));
    assert!(state.allows_native_content());
  }

  #[test]
  fn covering_an_unlocked_workspace_preserves_the_privacy_state() {
    let mut state = WorkspaceVisibility::new();
    assert!(state.set(1, false, false));
    assert!(!state.locked);
    assert!(!state.allows_native_content());
  }
}
