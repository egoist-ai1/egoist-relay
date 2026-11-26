#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
#[repr(C)]
struct Rect {
  left: i32,
  top: i32,
  right: i32,
  bottom: i32,
}

fn fit_to_work_area(window: Rect, work: Rect) -> Option<Rect> {
  let width = (window.right - window.left).min(work.right - work.left);
  let height = (window.bottom - window.top).min(work.bottom - work.top);
  if width <= 0 || height <= 0 {
    return None;
  }

  let left = window.left.clamp(work.left, work.right - width);
  let top = window.top.clamp(work.top, work.bottom - height);
  Some(Rect { left, top, right: left + width, bottom: top + height })
}

#[cfg(windows)]
mod windows {
  use super::{fit_to_work_area, Rect};
  use std::{ffi::c_void, io, mem::size_of};

  #[repr(C)]
  struct MonitorInfo {
    size: u32,
    monitor: Rect,
    work: Rect,
    flags: u32,
  }

  #[link(name = "user32")]
  unsafe extern "system" {
    fn GetForegroundWindow() -> *mut c_void;
    fn GetWindowRect(window: *mut c_void, rect: *mut Rect) -> i32;
    fn MonitorFromWindow(window: *mut c_void, flags: u32) -> *mut c_void;
    fn GetMonitorInfoW(monitor: *mut c_void, info: *mut MonitorInfo) -> i32;
    fn SetWindowPos(
      window: *mut c_void,
      insert_after: *mut c_void,
      x: i32,
      y: i32,
      width: i32,
      height: i32,
      flags: u32,
    ) -> i32;
  }

  fn get_monitor_info(handle: *mut c_void) -> io::Result<MonitorInfo> {
    const MONITOR_DEFAULTTONEAREST: u32 = 2;
    let mut info = MonitorInfo {
      size: size_of::<MonitorInfo>() as u32,
      monitor: Rect::default(),
      work: Rect::default(),
      flags: 0,
    };
    let monitor = unsafe { MonitorFromWindow(handle, MONITOR_DEFAULTTONEAREST) };
    if monitor.is_null() || unsafe { GetMonitorInfoW(monitor, &mut info) } == 0 {
      return Err(io::Error::last_os_error());
    }
    Ok(info)
  }

  pub(super) fn foreground_monitor_center() -> Option<(f64, f64)> {
    let foreground = unsafe { GetForegroundWindow() };
    if foreground.is_null() {
      return None;
    }
    let monitor = get_monitor_info(foreground).ok()?.monitor;
    Some((
      (f64::from(monitor.left) + f64::from(monitor.right)) / 2.0,
      (f64::from(monitor.top) + f64::from(monitor.bottom)) / 2.0,
    ))
  }

  pub(super) fn fit(handle: *mut c_void) -> io::Result<()> {
    const SWP_NOZORDER: u32 = 0x0004;
    const SWP_NOACTIVATE: u32 = 0x0010;

    let mut bounds = Rect::default();
    // Оба прямоугольника заданы в экранных координатах Windows.
    if unsafe { GetWindowRect(handle, &mut bounds) } == 0 {
      return Err(io::Error::last_os_error());
    }

    let Some(bounds_to_show) = fit_to_work_area(bounds, get_monitor_info(handle)?.work) else {
      return Ok(());
    };
    if bounds == bounds_to_show {
      return Ok(());
    }

    // Сохраняем Z-order и фокус до штатного показа окна.
    let moved = unsafe {
      SetWindowPos(
        handle,
        std::ptr::null_mut(),
        bounds_to_show.left,
        bounds_to_show.top,
        bounds_to_show.right - bounds_to_show.left,
        bounds_to_show.bottom - bounds_to_show.top,
        SWP_NOZORDER | SWP_NOACTIVATE,
      )
    };
    if moved == 0 {
      return Err(io::Error::last_os_error());
    }
    Ok(())
  }
}

#[cfg(windows)]
pub(crate) fn foreground_monitor_center() -> Option<(f64, f64)> {
  windows::foreground_monitor_center()
}

#[cfg(windows)]
pub(crate) fn fit_primary_window(window: &tauri::WebviewWindow) -> Result<(), String> {
  let handle = window.hwnd().map_err(|error| error.to_string())?;
  windows::fit(handle.0).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn fits_a_large_window_above_the_taskbar() {
    let window = Rect { left: 0, top: 0, right: 1652, bottom: 1160 };
    let laptop_work = Rect { left: 0, top: 0, right: 1366, bottom: 728 };
    assert_eq!(fit_to_work_area(window, laptop_work), Some(laptop_work));
  }

  #[test]
  fn keeps_size_and_moves_within_a_monitor_left_of_primary() {
    let window = Rect { left: -1900, top: -50, right: -600, bottom: 950 };
    let work = Rect { left: -1856, top: 10, right: 0, bottom: 1040 };
    let expected = Rect { left: -1856, top: 10, right: -556, bottom: 1010 };
    assert_eq!(fit_to_work_area(window, work), Some(expected));
    assert_eq!(fit_to_work_area(expected, work), Some(expected));
  }

  #[test]
  fn keeps_window_inside_scaled_work_area_in_screen_pixels() {
    let window = Rect { left: 1600, top: 200, right: 4078, bottom: 1940 };
    let work = Rect { left: 1440, top: 120, right: 3600, bottom: 1640 };
    assert_eq!(fit_to_work_area(window, work), Some(work));
    assert_eq!(fit_to_work_area(window, Rect::default()), None);
  }
}
