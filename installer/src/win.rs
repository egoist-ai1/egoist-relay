//! Тонкие обёртки над Win32 (windows-sys): реестр, мьютекс, диск, процессы, ACL, DWM.

use std::ffi::{c_void, OsStr, OsString};
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::path::{Path, PathBuf};
use std::ptr::{null, null_mut};

use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, LocalFree, ERROR_ALREADY_EXISTS, INVALID_HANDLE_VALUE};
use windows_sys::Win32::Security::Authorization::{ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1};
use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
use windows_sys::Win32::Storage::FileSystem::{CreateDirectoryW, GetDiskFreeSpaceExW};
use windows_sys::Win32::System::Console::{AttachConsole, ATTACH_PARENT_PROCESS};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};
use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ};
use windows_sys::Win32::System::Threading::{CreateMutexW, GetProcessIoCounters, OpenProcess, QueryFullProcessImageNameW, IO_COUNTERS, PROCESS_QUERY_LIMITED_INFORMATION};
use windows_sys::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryExW, SetDefaultDllDirectories};
use windows_sys::Win32::System::SystemInformation::GetSystemDirectoryW;
use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, IDRETRY, MB_ICONEXCLAMATION, MB_ICONINFORMATION, MB_OK, MB_RETRYCANCEL};

const LOAD_LIBRARY_SEARCH_SYSTEM32: u32 = 0x0000_0800;

/// Первым действием процесса: библиотеки, загружаемые позже, ищутся только в System32 (не рядом с exe и не в текущей папке).
pub fn restrict_dll_search() {
    // SAFETY: простой вызов без указателей.
    unsafe {
        SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32);
    }
}

/// Системный каталог (System32).
pub fn system_dir() -> PathBuf {
    let mut buf = vec![0u16; 512];
    // SAFETY: буфер достаточного размера, длина возвращается.
    let n = unsafe { GetSystemDirectoryW(buf.as_mut_ptr(), buf.len() as u32) } as usize;
    if n == 0 || n >= buf.len() {
        return PathBuf::from(r"C:\Windows\System32");
    }
    PathBuf::from(OsString::from_wide(&buf[..n]))
}

/// Окно «Повторить / Отмена». true — Повторить.
pub fn retry_cancel_box(title: &str, text: &str) -> bool {
    let (t, x) = (wide(title), wide(text));
    // SAFETY: валидные NUL-терминированные строки.
    unsafe { MessageBoxW(null_mut(), x.as_ptr(), t.as_ptr(), MB_RETRYCANCEL | MB_ICONEXCLAMATION) == IDRETRY }
}

pub fn wide(s: impl AsRef<OsStr>) -> Vec<u16> {
    s.as_ref().encode_wide().chain(std::iter::once(0)).collect()
}

fn from_wide(buf: &[u16]) -> String {
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    OsString::from_wide(&buf[..end]).to_string_lossy().into_owned()
}

#[derive(Clone, Copy)]
pub enum Hive {
    CurrentUser,
    LocalMachine,
}

pub fn reg_read_string(hive: Hive, subkey: &str, value: &str) -> Option<String> {
    let root: HKEY = match hive {
        Hive::CurrentUser => HKEY_CURRENT_USER,
        Hive::LocalMachine => HKEY_LOCAL_MACHINE,
    };
    let sk = wide(subkey);
    let v = wide(value);
    let mut size: u32 = 0;
    // SAFETY: указатели на живые буферы; размер запрашивается первым вызовом.
    let status = unsafe { RegGetValueW(root, sk.as_ptr(), v.as_ptr(), RRF_RT_REG_SZ, null_mut(), null_mut(), &mut size) };
    if status != 0 || size < 2 {
        return None;
    }
    let mut buf = vec![0u16; (size as usize).div_ceil(2) + 1];
    let mut size2 = (buf.len() * 2) as u32;
    let status = unsafe { RegGetValueW(root, sk.as_ptr(), v.as_ptr(), RRF_RT_REG_SZ, null_mut(), buf.as_mut_ptr() as *mut c_void, &mut size2) };
    if status != 0 {
        return None;
    }
    Some(from_wide(&buf))
}

/// Номер сборки Windows (CurrentBuildNumber).
pub fn windows_build() -> Option<u32> {
    reg_read_string(Hive::LocalMachine, r"SOFTWARE\Microsoft\Windows NT\CurrentVersion", "CurrentBuildNumber")?.trim().parse().ok()
}

/// Версия WebView2 Runtime из реестра (для журнала).
pub fn webview2_version() -> Option<String> {
    const KEY: &str = r"SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
    reg_read_string(Hive::LocalMachine, &format!(r"SOFTWARE\WOW6432Node\{}", &KEY[9..]), "pv")
        .or_else(|| reg_read_string(Hive::LocalMachine, KEY, "pv"))
        .or_else(|| reg_read_string(Hive::CurrentUser, KEY, "pv"))
}

/// Именованный мьютекс на сеанс. `false` — уже запущен другой экземпляр.
pub fn acquire_single_instance(name: &str) -> bool {
    let n = wide(name);
    // SAFETY: имя — валидная NUL-терминированная строка. Дескриптор намеренно не закрывается до конца процесса.
    unsafe {
        let h = CreateMutexW(null(), 0, n.as_ptr());
        if h.is_null() {
            return true; // не смогли проверить — не блокируем
        }
        GetLastError() != ERROR_ALREADY_EXISTS
    }
}

/// Свободно байт для текущего пользователя на томе, содержащем `path` (берётся ближайший существующий предок).
pub fn free_space(path: &Path) -> Option<u64> {
    let mut p: PathBuf = path.to_path_buf();
    while !p.exists() {
        if !p.pop() {
            return None;
        }
    }
    let w = wide(p.as_os_str());
    let mut avail = 0u64;
    let mut total = 0u64;
    let mut free = 0u64;
    // SAFETY: валидные указатели на локальные переменные.
    let ok = unsafe { GetDiskFreeSpaceExW(w.as_ptr(), &mut avail, &mut total, &mut free) };
    (ok != 0).then_some(avail)
}

/// Буква/корень тома: для сравнения «один ли том».
pub fn volume_root(path: &Path) -> String {
    use std::path::Component;
    path.components()
        .find_map(|c| match c {
            Component::Prefix(p) => Some(p.as_os_str().to_string_lossy().to_uppercase()),
            _ => None,
        })
        .unwrap_or_default()
}

/// Каталог только для текущего пользователя (владелец + SYSTEM для антивируса), без наследования прав.
pub fn create_private_dir(path: &Path) -> std::io::Result<()> {
    let sddl = wide("D:P(A;OICI;FA;;;OW)(A;OICI;FA;;;SY)");
    let mut sd: *mut c_void = null_mut();
    // SAFETY: SDDL — валидная строка; результат освобождается LocalFree.
    let ok = unsafe { ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.as_ptr(), SDDL_REVISION_1, &mut sd, null_mut()) };
    if ok == 0 {
        return Err(std::io::Error::last_os_error());
    }
    let attrs = SECURITY_ATTRIBUTES { nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: sd, bInheritHandle: 0 };
    let w = wide(path.as_os_str());
    let created = unsafe { CreateDirectoryW(w.as_ptr(), &attrs) };
    let err = std::io::Error::last_os_error();
    unsafe { LocalFree(sd) };
    if created == 0 {
        Err(err)
    } else {
        Ok(())
    }
}

/// Полный путь к exe процесса (None, если нет доступа).
fn process_image_path(pid: u32) -> Option<String> {
    // SAFETY: OpenProcess/Query* с валидными аргументами, дескриптор закрывается.
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() {
            return None;
        }
        let mut buf = vec![0u16; 1024];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(h, 0, buf.as_mut_ptr(), &mut len);
        CloseHandle(h);
        (ok != 0).then(|| from_wide(&buf[..len as usize]))
    }
}

/// Запущен ли `exe_path` (точное совпадение полного пути без учёта регистра).
pub fn is_exe_running(exe_path: &Path) -> bool {
    let want = exe_path.to_string_lossy().to_lowercase();
    let file_name = exe_path.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
    // SAFETY: стандартный перебор процессов через ToolHelp; снимок закрывается.
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE {
            return false;
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut found = false;
        let mut more = Process32FirstW(snap, &mut entry) != 0;
        while more {
            if from_wide(&entry.szExeFile).to_lowercase() == file_name {
                if let Some(p) = process_image_path(entry.th32ProcessID) {
                    if p.to_lowercase() == want {
                        found = true;
                        break;
                    }
                }
            }
            more = Process32NextW(snap, &mut entry) != 0;
        }
        CloseHandle(snap);
        found
    }
}

/// Сколько байт записал процесс за всё время (WriteTransferCount).
pub fn process_bytes_written(handle: *mut c_void) -> Option<u64> {
    let mut c: IO_COUNTERS = unsafe { std::mem::zeroed() };
    // SAFETY: handle принадлежит живому std::process::Child.
    let ok = unsafe { GetProcessIoCounters(handle, &mut c) };
    (ok != 0).then_some(c.WriteTransferCount)
}

/// Скруглённые углы окна на Windows 11 (DWMWA_WINDOW_CORNER_PREFERENCE = round). На Windows 10 вызов безвреден.
pub fn round_window_corners(hwnd: isize) {
    const DWMWA_WINDOW_CORNER_PREFERENCE: u32 = 33;
    const DWMWCP_ROUND: u32 = 2;
    let pref = DWMWCP_ROUND;
    type SetAttr = unsafe extern "system" fn(*mut c_void, u32, *const c_void, u32) -> i32;
    let name = wide("dwmapi.dll");
    // SAFETY: библиотека берётся только из System32; сигнатура DwmSetWindowAttribute известна.
    unsafe {
        let lib = LoadLibraryExW(name.as_ptr(), null_mut(), LOAD_LIBRARY_SEARCH_SYSTEM32);
        if lib.is_null() {
            return;
        }
        if let Some(f) = GetProcAddress(lib, b"DwmSetWindowAttribute\0".as_ptr()) {
            let f: SetAttr = std::mem::transmute(f);
            f(hwnd as *mut c_void, DWMWA_WINDOW_CORNER_PREFERENCE, &pref as *const u32 as *const c_void, 4);
        }
    }
}

/// Подключает вывод к консоли родителя (для `--silent` из терминала). Возвращает писатель или None.
pub fn attach_parent_console() -> Option<std::fs::File> {
    // SAFETY: простой вызов.
    if unsafe { AttachConsole(ATTACH_PARENT_PROCESS) } == 0 {
        return None;
    }
    std::fs::OpenOptions::new().write(true).open("CONOUT$").ok()
}

/// Единственное «стандартное» окно: сообщение, что установщик уже запущен (до создания своего окна).
pub fn info_box(title: &str, text: &str) {
    let (t, x) = (wide(title), wide(text));
    unsafe {
        MessageBoxW(null_mut(), x.as_ptr(), t.as_ptr(), MB_OK | MB_ICONINFORMATION);
    }
}
