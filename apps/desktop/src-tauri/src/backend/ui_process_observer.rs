use std::sync::Arc;

use bibcode_server::diagnostics::DesktopUiProcessObserver;
#[cfg(not(target_os = "macos"))]
use bibcode_server::diagnostics::UnavailableDesktopUiProcessObserver;
#[cfg(windows)]
use bibcode_server::diagnostics::WebView2DesktopUiProcessObserver;
use tauri::{AppHandle, Runtime};

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
use self::macos::MacosDesktopUiProcessObserver;

pub(super) fn for_app<R: Runtime>(app: &AppHandle<R>) -> Arc<dyn DesktopUiProcessObserver> {
    #[cfg(target_os = "macos")]
    return Arc::new(MacosDesktopUiProcessObserver::new(app.clone()));

    #[cfg(windows)]
    if let Some(executable_name) = std::env::current_exe().ok().and_then(|path| {
        path.file_name()
            .map(|name| name.to_string_lossy().into_owned())
    }) {
        return Arc::new(WebView2DesktopUiProcessObserver::new(executable_name));
    }

    #[cfg(not(target_os = "macos"))]
    let _ = app;

    #[cfg(not(target_os = "macos"))]
    Arc::new(UnavailableDesktopUiProcessObserver)
}
