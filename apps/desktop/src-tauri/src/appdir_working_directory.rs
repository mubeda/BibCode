//! Linux AppDir: start the same way whatever the caller's working folder (#412).
//! The AppImage bundler rewrites the bundled WebKitGTK's helper paths to
//! `././/lib/...`, so WebKit finds `WebKitNetworkProcess` and its injected
//! bundle relative to the working folder, and its release build ignores
//! `WEBKIT_EXEC_PATH`. `AppRun` changes to `<AppDir>/usr` first; the generated
//! `bibcode://` handler of an extracted AppDir starts the binary directly and
//! skips that, so `main` does the same change itself. See
//! `docs/plans/2026-11-21-linux-software-rendering-design.md`.
#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// `<AppDir>/usr` when `exe` is `<AppDir>/usr/bin/<name>` next to an `AppRun`. A system
/// install such as `/usr/bin/bibcode-desktop` has no `AppRun` and keeps its folder.
pub(crate) fn appdir_usr(exe: &Path, exists: impl Fn(&Path) -> bool) -> Option<PathBuf> {
    let bin = exe.parent()?;
    let usr = bin.parent()?;
    if bin.file_name()? != "bin" || usr.file_name()? != "usr" {
        return None;
    }
    exists(&usr.parent()?.join("AppRun")).then(|| usr.to_path_buf())
}

/// `Ok(true)` when `main` changed the working folder, or the reason it could not.
static STARTUP: OnceLock<Result<bool, String>> = OnceLock::new();

/// Moves an AppDir launch into `<AppDir>/usr`, where `AppRun` launches already run, so
/// terminals and providers see the same base folder on every route. Call it from `main`
/// before any webview.
#[cfg(target_os = "linux")]
pub fn enter_appdir_usr() {
    let usr = std::env::current_exe()
        .ok()
        .and_then(|exe| appdir_usr(&exe, Path::exists));
    let outcome = match usr {
        Some(usr) if std::env::current_dir().ok().as_deref() != Some(usr.as_path()) => {
            std::env::set_current_dir(&usr)
                .map(|()| true)
                .map_err(|error| error.to_string())
        }
        _ => Ok(false),
    };
    let _ = STARTUP.set(outcome);
}

/// Logs what `enter_appdir_usr` did; called from `setup`, once the log sink exists.
pub(crate) fn record_startup() {
    match STARTUP.get() {
        Some(Ok(true)) => tracing::info!(
            "started outside AppRun; working folder moved to the AppDir's usr folder for WebKit"
        ),
        Some(Err(error)) => tracing::warn!(
            %error,
            "could not move to the AppDir's usr folder; WebKit may not find its helper processes"
        ),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appdir_working_directory_is_usr_of_an_appdir() {
        let exe = Path::new("/opt/squashfs-root/usr/bin/bibcode-desktop");
        let usr = appdir_usr(exe, |path| path == Path::new("/opt/squashfs-root/AppRun"));
        assert_eq!(usr.as_deref(), Some(Path::new("/opt/squashfs-root/usr")));
    }

    #[test]
    fn appdir_working_directory_is_kept_without_apprun() {
        let exe = Path::new("/usr/bin/bibcode-desktop");
        assert_eq!(appdir_usr(exe, |_| false), None);
    }

    #[test]
    fn appdir_working_directory_is_kept_outside_usr_bin() {
        let apprun_everywhere = |_: &Path| true;
        for exe in [
            "/opt/app/bin/bibcode-desktop",
            "/opt/app/usr/libexec/bibcode-desktop",
            "/target/release/bibcode-desktop",
            "bibcode-desktop",
        ] {
            assert_eq!(appdir_usr(Path::new(exe), apprun_everywhere), None, "{exe}");
        }
    }
}
