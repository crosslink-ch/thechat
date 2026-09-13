#[cfg(any(windows, test))]
mod policy;
#[cfg(windows)]
mod windows;

#[cfg(windows)]
pub fn init() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    windows::init()
}
