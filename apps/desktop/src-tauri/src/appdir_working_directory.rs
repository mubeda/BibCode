//! Linux AppDir: start the same way whatever the caller's working folder (#412).
//! The AppImage bundler rewrites the bundled WebKitGTK's helper paths to
//! `././/lib/...`, so WebKit finds `WebKitNetworkProcess` and its injected
//! bundle relative to the working folder, and its release build ignores
//! `WEBKIT_EXEC_PATH`. `AppRun` changes to `<AppDir>/usr` and sets up the bundled
//! GTK environment; the generated `bibcode://` handler of an extracted AppDir starts
//! the binary directly and skips both, and in a Hyprland VM its page then stayed
//! blank. So `main` restarts such a launch through `AppRun`, and if that fails, at
//! least changes to `usr` itself. See
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

/// The `AppRun` to restart through: only when this launch did not come from it, which
/// exports `APPDIR`, so the restarted process cannot loop.
pub(crate) fn apprun_to_reexec(usr: &Path, appdir_set: bool) -> Option<PathBuf> {
    (!appdir_set).then(|| usr.parent().unwrap_or(usr).join("AppRun"))
}

struct Startup {
    /// `Ok(true)` when `main` changed the working folder, or the reason it could not.
    moved: Result<bool, String>,
    reexec_error: Option<String>,
}

static STARTUP: OnceLock<Startup> = OnceLock::new();

/// Restarts an AppDir launch that skipped `AppRun` through it, so every route gets the same
/// working folder and environment. If that fails, moves into `<AppDir>/usr`. Call it from
/// `main` before any thread, and before BiBCode changes its own environment.
#[cfg(target_os = "linux")]
pub fn enter_appdir_usr() {
    use std::os::unix::process::CommandExt;
    let Some(usr) = std::env::current_exe()
        .ok()
        .and_then(|exe| appdir_usr(&exe, Path::exists))
    else {
        return;
    };
    let reexec_error = apprun_to_reexec(&usr, std::env::var_os("APPDIR").is_some()).map(|apprun| {
        // `exec` returns only when it failed.
        let error = std::process::Command::new(apprun)
            .args(std::env::args_os().skip(1))
            .exec();
        error.to_string()
    });
    let moved = if std::env::current_dir().ok().as_deref() == Some(usr.as_path()) {
        Ok(false)
    } else {
        std::env::set_current_dir(&usr)
            .map(|()| true)
            .map_err(|error| error.to_string())
    };
    let _ = STARTUP.set(Startup {
        moved,
        reexec_error,
    });
}

/// Logs what `enter_appdir_usr` did; called from `setup`, once the log sink exists.
pub(crate) fn record_startup() {
    let Some(startup) = STARTUP.get() else {
        return;
    };
    if let Some(error) = &startup.reexec_error {
        tracing::warn!(%error, "could not restart through the AppDir's AppRun");
    }
    match &startup.moved {
        Ok(true) => tracing::info!(
            "started outside AppRun; working folder moved to the AppDir's usr folder for WebKit"
        ),
        Err(error) => tracing::warn!(
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
    fn appdir_working_directory_restarts_through_apprun_only_once() {
        let usr = Path::new("/opt/squashfs-root/usr");
        assert_eq!(
            apprun_to_reexec(usr, false).as_deref(),
            Some(Path::new("/opt/squashfs-root/AppRun"))
        );
        // AppRun exports APPDIR, so the process it starts does not restart again.
        assert_eq!(apprun_to_reexec(usr, true), None);
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
