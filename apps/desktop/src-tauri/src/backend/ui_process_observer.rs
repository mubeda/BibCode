use std::sync::Arc;

#[cfg(windows)]
use bibcode_server::diagnostics::WebView2DesktopUiProcessObserver;
use bibcode_server::diagnostics::{DesktopUiProcessObserver, UnavailableDesktopUiProcessObserver};
use tauri::{AppHandle, Runtime};

pub(super) fn for_app<R: Runtime>(_app: &AppHandle<R>) -> Arc<dyn DesktopUiProcessObserver> {
    #[cfg(windows)]
    if let Some(executable_name) = std::env::current_exe().ok().and_then(|path| {
        path.file_name()
            .map(|name| name.to_string_lossy().into_owned())
    }) {
        return Arc::new(WebView2DesktopUiProcessObserver::new(executable_name));
    }

    Arc::new(UnavailableDesktopUiProcessObserver)
}
