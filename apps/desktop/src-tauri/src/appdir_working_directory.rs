//! Linux AppDir: start the same way whatever the caller's working folder (#412).
//! The AppImage bundler rewrites the bundled WebKitGTK's helper paths to
//! `././/lib/...`, so WebKit finds `WebKitNetworkProcess` and its injected
//! bundle relative to the working folder, and its release build ignores
//! `WEBKIT_EXEC_PATH`. `AppRun` changes to `<AppDir>/usr` and sets up the bundled
//! GTK environment; the generated `bibcode://` handler of an extracted AppDir starts
//! the binary directly and skips both, and in a Hyprland VM its page then stayed
//! blank. So `main` hands such a launch to this bundle's `AppRun` once, and if that
//! fails, at least changes to `usr` itself. See
//! `docs/plans/2026-11-21-linux-software-rendering-design.md`.
// Also compiled for tests on other Unix hosts; only Linux applies it.
#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

/// Set only on the handoff to `AppRun` and removed by the process it starts, so a launcher
/// that comes straight back to the binary ends in one handoff, not a loop.
pub(crate) const HANDOFF_GUARD: &str = "BIBCODE_APPRUN_HANDOFF";

/// `<root>` of an executable at `<root>/usr/bin/<name>` whose `<root>/AppRun` passes
/// `launcher_ok`. Mirrors `extracted_appdir` in `apps/server/src/process/appimage.rs`
/// (private to that crate), including its refusal of `/` as a root, so a system install
/// at `/usr/bin` never qualifies.
pub(crate) fn bundle_root(exe: &Path, launcher_ok: impl Fn(&Path) -> bool) -> Option<PathBuf> {
    let bin = exe.parent()?;
    let usr = bin.parent()?;
    let root = usr.parent()?;
    (bin.ends_with("bin") && usr.ends_with("usr") && root.parent().is_some() && launcher_ok(root))
        .then(|| root.to_path_buf())
}

/// Whether `<root>/AppRun` looks like this bundle's launcher: a regular executable file, or a
/// symlink that resolves to a file inside the bundle.
#[cfg(unix)]
pub(crate) fn launcher_belongs_to(root: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    let launcher = root.join("AppRun");
    let Ok(metadata) = std::fs::symlink_metadata(&launcher) else {
        return false;
    };
    if metadata.file_type().is_symlink() {
        return match (
            std::fs::canonicalize(&launcher),
            std::fs::canonicalize(root),
        ) {
            (Ok(target), Ok(root)) => target.starts_with(&root) && target.is_file(),
            _ => false,
        };
    }
    metadata.is_file() && metadata.permissions().mode() & 0o111 != 0
}

/// The AppImage runtime's markers besides `APPDIR`. Only this bundle's own mount may keep
/// them: inherited from another AppImage application, `APPIMAGE` would make a restart start
/// that application (Tauri restarts `APPIMAGE` when it is set).
pub(crate) const APPIMAGE_MARKERS: [&str; 3] = ["APPIMAGE", "ARGV0", "OWD"];

/// Whether `APPDIR` names this very bundle: its own `AppRun`, or its mounted AppImage, started
/// this process. An empty `APPDIR` or another application's AppDir (a link clicked inside
/// another AppImage) does not count.
pub(crate) fn launched_by_this_bundle(
    root: &Path,
    appdir: Option<&OsStr>,
    canonical: impl Fn(&Path) -> Option<PathBuf>,
) -> bool {
    match (
        appdir
            .filter(|value| !value.is_empty())
            .and_then(|value| canonical(Path::new(value))),
        canonical(root),
    ) {
        (Some(appdir), Some(root)) => appdir == root,
        _ => false,
    }
}

/// Whether to hand this launch to the bundle's `AppRun`: never after a handoff, and
/// otherwise unless this bundle launched it.
pub(crate) fn needs_handoff(
    root: &Path,
    appdir: Option<&OsStr>,
    guard: bool,
    canonical: impl Fn(&Path) -> Option<PathBuf>,
) -> bool {
    !guard && !launched_by_this_bundle(root, appdir, canonical)
}

/// The handoff: this bundle's `AppRun` with the same arguments (the `bibcode://` URL among
/// them), the guard set, and the inherited `APPDIR` and AppImage markers removed: they belong
/// to whatever launched this process, so `AppRun`'s GTK hook uses this bundle's paths and a
/// restart starts this bundle.
pub(crate) fn handoff_command(root: &Path, args: impl IntoIterator<Item = OsString>) -> Command {
    let mut command = Command::new(root.join("AppRun"));
    command
        .args(args)
        .env(HANDOFF_GUARD, "1")
        .env_remove("APPDIR");
    for marker in APPIMAGE_MARKERS {
        command.env_remove(marker);
    }
    command
}

struct Startup {
    /// `Ok(true)` when `main` changed the working folder, or the reason it could not.
    moved: Result<bool, String>,
    handoff_error: Option<String>,
}

static STARTUP: OnceLock<Startup> = OnceLock::new();

/// Hands an AppDir launch that skipped this bundle's `AppRun` to it once, so every route gets
/// the same working folder and environment; if that fails, moves into `<AppDir>/usr`.
///
/// # Safety
///
/// It removes the handoff guard from the process environment, so no other thread may exist
/// yet: `main` calls it before Tauri, Tokio, GTK or WebKit start.
#[cfg(target_os = "linux")]
pub unsafe fn enter_appdir_usr() {
    use std::os::unix::process::CommandExt;
    let guard = std::env::var_os(HANDOFF_GUARD).is_some();
    if guard {
        // SAFETY: the caller guarantees the process is still single-threaded. Removed so
        // terminals, providers and a later restart never inherit it.
        unsafe { std::env::remove_var(HANDOFF_GUARD) };
    }
    let Some(root) = std::env::current_exe()
        .ok()
        .and_then(|exe| bundle_root(&exe, launcher_belongs_to))
    else {
        return;
    };
    let appdir = std::env::var_os("APPDIR");
    let canonical = |path: &Path| std::fs::canonicalize(path).ok();
    let handoff_error = needs_handoff(&root, appdir.as_deref(), guard, canonical)
        // `exec` returns only when it failed.
        .then(|| {
            handoff_command(&root, std::env::args_os().skip(1))
                .exec()
                .to_string()
        });
    // Still here without this bundle's launch: another AppImage's markers would make Tauri's
    // restart (and the AppImage checks) target that application.
    if !launched_by_this_bundle(&root, appdir.as_deref(), canonical) {
        for marker in APPIMAGE_MARKERS {
            // SAFETY: the caller guarantees the process is still single-threaded.
            unsafe { std::env::remove_var(marker) };
        }
    }
    let usr = root.join("usr");
    let moved = if std::env::current_dir().ok().as_deref() == Some(usr.as_path()) {
        Ok(false)
    } else {
        std::env::set_current_dir(&usr)
            .map(|()| true)
            .map_err(|error| error.to_string())
    };
    let _ = STARTUP.set(Startup {
        moved,
        handoff_error,
    });
}

/// Logs what `enter_appdir_usr` did, once the log sink exists.
pub(crate) fn record_startup() {
    let Some(startup) = STARTUP.get() else {
        return;
    };
    if let Some(error) = &startup.handoff_error {
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
        Ok(false) => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{PermissionsExt, symlink};

    #[test]
    fn appdir_working_directory_finds_the_bundle_root() {
        let exe = Path::new("/opt/squashfs-root/usr/bin/bibcode-desktop");
        assert_eq!(
            bundle_root(exe, |root| root == Path::new("/opt/squashfs-root")).as_deref(),
            Some(Path::new("/opt/squashfs-root"))
        );
        assert_eq!(bundle_root(exe, |_| false), None);
    }

    #[test]
    fn appdir_working_directory_refuses_a_system_install_beside_a_stray_apprun() {
        // `/usr/bin/bibcode-desktop` with a `/AppRun`: the root would be `/`.
        assert_eq!(
            bundle_root(Path::new("/usr/bin/bibcode-desktop"), |_| true),
            None
        );
        for exe in [
            "/opt/app/bin/bibcode-desktop",
            "/opt/app/usr/libexec/bibcode-desktop",
            "bibcode-desktop",
        ] {
            assert_eq!(bundle_root(Path::new(exe), |_| true), None, "{exe}");
        }
    }

    #[test]
    fn appdir_working_directory_accepts_only_the_bundles_own_launcher() {
        let directory = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(directory.path()).unwrap();
        std::fs::create_dir_all(root.join("usr/bin")).unwrap();
        let binary = root.join("usr/bin/bibcode-desktop");
        std::fs::write(&binary, "").unwrap();
        let launcher = root.join("AppRun");
        let set_mode = |path: &Path, mode| {
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap()
        };
        assert!(!launcher_belongs_to(&root), "missing");

        std::fs::create_dir(&launcher).unwrap();
        assert!(!launcher_belongs_to(&root), "a directory");
        std::fs::remove_dir(&launcher).unwrap();

        std::fs::write(&launcher, "#!/bin/sh\n").unwrap();
        set_mode(&launcher, 0o644);
        assert!(!launcher_belongs_to(&root), "not executable");
        set_mode(&launcher, 0o755);
        assert!(launcher_belongs_to(&root), "an executable file");
        std::fs::remove_file(&launcher).unwrap();

        symlink("/bin/sh", &launcher).unwrap();
        assert!(!launcher_belongs_to(&root), "a symlink out of the bundle");
        std::fs::remove_file(&launcher).unwrap();

        symlink("usr/bin/bibcode-desktop", &launcher).unwrap();
        assert!(launcher_belongs_to(&root), "a symlink inside the bundle");
    }

    #[test]
    fn appdir_working_directory_hands_off_unless_this_bundles_launcher_ran() {
        let root = Path::new("/opt/BiBCode.AppDir");
        let canonical = |path: &Path| Some(path.to_path_buf());
        let handoff = |appdir: Option<&str>, guard| {
            needs_handoff(root, appdir.map(OsStr::new), guard, canonical)
        };
        assert!(handoff(None, false), "no APPDIR");
        assert!(handoff(Some(""), false), "empty APPDIR");
        assert!(
            handoff(Some("/tmp/.mount_OtherApp"), false),
            "another app's APPDIR"
        );
        assert!(
            !handoff(Some("/opt/BiBCode.AppDir"), false),
            "this bundle's AppRun ran"
        );
        // After one handoff the guard wins, whatever APPDIR says.
        assert!(!handoff(None, true));
        assert!(!handoff(Some("/tmp/.mount_OtherApp"), true));
    }

    #[test]
    fn appdir_working_directory_keeps_appimage_markers_only_for_this_bundles_launch() {
        let canonical = |path: &Path| Some(path.to_path_buf());
        // A mounted BiBCode AppImage: its runtime set APPDIR to the mount the binary runs from.
        let mount = Path::new("/tmp/.mount_BiBCodeX1");
        assert!(launched_by_this_bundle(
            mount,
            Some(OsStr::new("/tmp/.mount_BiBCodeX1")),
            canonical
        ));
        // An extracted AppDir started from inside another AppImage application.
        let extracted = Path::new("/opt/squashfs-root");
        for appdir in [Some("/tmp/.mount_OtherApp"), Some(""), None] {
            assert!(
                !launched_by_this_bundle(extracted, appdir.map(OsStr::new), canonical),
                "{appdir:?}"
            );
        }
    }

    #[test]
    fn appdir_working_directory_handoff_forwards_the_link_and_sets_the_guard() {
        let command = handoff_command(
            Path::new("/opt/BiBCode.AppDir"),
            [OsString::from("bibcode://open?x=1")],
        );
        assert_eq!(command.get_program(), "/opt/BiBCode.AppDir/AppRun");
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            vec![OsStr::new("bibcode://open?x=1")]
        );
        let envs: Vec<_> = command.get_envs().collect();
        assert!(envs.contains(&(OsStr::new(HANDOFF_GUARD), Some(OsStr::new("1")))));
        assert!(envs.contains(&(OsStr::new("APPDIR"), None)));
        // Another AppImage's markers do not reach the handoff, so its restart starts BiBCode.
        for marker in APPIMAGE_MARKERS {
            assert!(envs.contains(&(OsStr::new(marker), None)), "{marker}");
        }
        // The process the handoff starts sees the guard and does not hand off again.
        assert!(!needs_handoff(
            Path::new("/opt/BiBCode.AppDir"),
            None,
            envs.iter().any(|(name, _)| *name == HANDOFF_GUARD),
            |path| Some(path.to_path_buf())
        ));
    }
}
