//! The AppImage launcher (AppImageKit's `AppRun`, shipped as `AppRun.wrapped`) sets
//! `GST_PLUGIN_SYSTEM_PATH_1_0` to `$APPDIR/usr/lib/gstreamer-1.0:` and `GST_PLUGIN_SYSTEM_PATH`
//! to `$APPDIR/usr/lib/gstreamer:`, each followed by the launch's `QT_PLUGIN_PATH` (an upstream
//! slip: it reuses that variable's old value), and drops any GStreamer value the user had.
//! Release AppImages ship their GStreamer plugins in `usr/lib/gstreamer-1.0`, so the first
//! value is kept and the second, whose folder never exists, is removed. This repair is the
//! safety net for a build made without plugins: there GStreamer would scan none, find no
//! `autoaudiosink`, and WebKitGTK's web process would die on the first audio element.
//! Removing such a value lets GStreamer use the system's default plugin path; the web
//! processes inherit the result.

use std::ffi::OsStr;
use std::path::Path;

/// The plugin path variables GStreamer 1.x reads, each with the folder the launcher puts first.
#[cfg(target_os = "linux")]
const PLUGIN_SYSTEM_PATH_VARIABLES: [(&str, &str); 2] = [
    ("GST_PLUGIN_SYSTEM_PATH_1_0", "usr/lib/gstreamer-1.0"),
    ("GST_PLUGIN_SYSTEM_PATH", "usr/lib/gstreamer"),
];

/// Whether one plugin path variable should be removed: only a value the launcher wrote (it
/// starts with `launcher_entry`, which needs `APPDIR`) whose folder the bundle lacks. The rest of
/// such a value is a copy of `QT_PLUGIN_PATH`, never a GStreamer setting. Any other value may be
/// the user's own, so it is kept even when its folders are missing.
pub(crate) fn should_remove_plugin_path(
    value: Option<&OsStr>,
    launcher_entry: Option<&Path>,
    exists: impl Fn(&Path) -> bool,
) -> bool {
    let (Some(value), Some(launcher_entry)) = (value, launcher_entry) else {
        return false;
    };
    std::env::split_paths(value)
        .find(|entry| !entry.as_os_str().is_empty())
        .is_some_and(|first| first == launcher_entry && !exists(&first))
}

/// Repairs both plugin path variables in this process. Call it only while the process is
/// single-threaded: `main` does, right after the crash hook.
#[cfg(target_os = "linux")]
pub fn repair_process_environment() {
    let appdir = std::env::var_os("APPDIR").filter(|appdir| !appdir.is_empty());
    for (name, launcher_folder) in PLUGIN_SYSTEM_PATH_VARIABLES {
        let launcher_entry = appdir
            .as_ref()
            .map(|appdir| Path::new(appdir).join(launcher_folder));
        let value = std::env::var_os(name);
        if should_remove_plugin_path(value.as_deref(), launcher_entry.as_deref(), Path::is_dir) {
            // SAFETY: `main` calls this before Tauri, Tokio, GTK or WebKit start, and on Linux
            // the crash hook attached just before installs signal handlers without spawning a
            // thread, so no other thread can read or write the environment concurrently.
            unsafe { std::env::remove_var(name) };
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    const LAUNCHER_ENTRY: &str = "/tmp/.mount_bibcodX/usr/lib/gstreamer-1.0";

    fn decide(value: Option<&str>, launched: bool, existing: &[&str]) -> bool {
        should_remove_plugin_path(
            value.map(OsStr::new),
            launched.then(|| Path::new(LAUNCHER_ENTRY)),
            |path| existing.iter().any(|existing| Path::new(existing) == path),
        )
    }

    #[test]
    fn removes_the_launchers_value_when_its_folder_is_missing() {
        // The real launcher value, with an empty and with a set QT_PLUGIN_PATH after the colon.
        assert!(decide(Some(&format!("{LAUNCHER_ENTRY}:")), true, &[]));
        assert!(decide(
            Some(&format!("{LAUNCHER_ENTRY}:/usr/lib/qt5/plugins")),
            true,
            &["/usr/lib/qt5/plugins"]
        ));
    }

    #[test]
    fn keeps_the_launchers_value_when_the_bundle_has_the_folder() {
        assert!(!decide(
            Some(&format!("{LAUNCHER_ENTRY}:")),
            true,
            &[LAUNCHER_ENTRY]
        ));
        // A QT_PLUGIN_PATH suffix that names a missing folder does not matter.
        assert!(!decide(
            Some(&format!("{LAUNCHER_ENTRY}:/missing/qt5/plugins")),
            true,
            &[LAUNCHER_ENTRY]
        ));
    }

    #[test]
    fn keeps_a_value_the_launcher_did_not_write_even_when_its_folders_are_missing() {
        // Without APPDIR nothing identifies a launcher value: the user may have set it on purpose.
        assert!(!decide(Some("/missing/one:/missing/two:"), false, &[]));
        assert!(!decide(Some(&format!("{LAUNCHER_ENTRY}:")), false, &[]));
        // With APPDIR, a value that does not start with the launcher's folder is not its value.
        assert!(!decide(Some("/missing/one"), true, &[]));
        assert!(!decide(
            Some(&format!("/missing/one:{LAUNCHER_ENTRY}")),
            true,
            &[]
        ));
    }

    #[test]
    fn keeps_a_value_with_one_existing_directory_outside_the_launcher() {
        assert!(!decide(
            Some("/missing/one:/opt/host/gstreamer-1.0"),
            false,
            &["/opt/host/gstreamer-1.0"]
        ));
        assert!(!decide(
            Some("/missing/one:/opt/host/gstreamer-1.0"),
            true,
            &["/opt/host/gstreamer-1.0"]
        ));
    }

    #[test]
    fn leaves_unset_empty_and_entry_less_values_untouched() {
        for launched in [false, true] {
            assert!(!decide(None, launched, &[]));
            assert!(!decide(Some(""), launched, &[]));
            assert!(!decide(Some(":"), launched, &[]));
        }
    }

    #[test]
    fn reads_raw_byte_entries() {
        use std::os::unix::ffi::OsStrExt;
        let launcher = Path::new(OsStr::from_bytes(b"/tmp/.mount_\xff/usr/lib/gstreamer-1.0"));
        let value = OsStr::from_bytes(b"/tmp/.mount_\xff/usr/lib/gstreamer-1.0:/opt/\xff");
        assert!(should_remove_plugin_path(
            Some(value),
            Some(launcher),
            |_| false
        ));
        assert!(!should_remove_plugin_path(
            Some(value),
            Some(launcher),
            |path| { path == launcher }
        ));
        assert!(!should_remove_plugin_path(Some(value), None, |_| false));
    }
}
