//! The AppImage launcher (AppImageKit's `AppRun`, shipped as `AppRun.wrapped`) sets
//! `GST_PLUGIN_SYSTEM_PATH_1_0` to `$APPDIR/usr/lib/gstreamer-1.0:` and `GST_PLUGIN_SYSTEM_PATH`
//! to `$APPDIR/usr/lib/gstreamer:`, each followed by the launch's `QT_PLUGIN_PATH` (an upstream
//! slip: it reuses that variable's old value), and drops any GStreamer value the user had. The
//! bundle ships no GStreamer plugins, so GStreamer scans none, finds no `autoaudiosink`, and
//! WebKitGTK's web process dies on the first audio element. Removing such a value lets
//! GStreamer use the system's default plugin path; the web processes inherit the result.

use std::ffi::OsStr;
use std::path::Path;

/// The plugin path variables GStreamer 1.x reads, each with the folder the launcher puts first.
#[cfg(target_os = "linux")]
const PLUGIN_SYSTEM_PATH_VARIABLES: [(&str, &str); 2] = [
    ("GST_PLUGIN_SYSTEM_PATH_1_0", "usr/lib/gstreamer-1.0"),
    ("GST_PLUGIN_SYSTEM_PATH", "usr/lib/gstreamer"),
];

/// Whether one plugin path variable should be removed. A value the launcher wrote (it starts
/// with `launcher_entry`) is removed when that folder is missing: the rest of it is a copy of
/// `QT_PLUGIN_PATH`, never a GStreamer setting. Any other value is removed only when it names
/// directories and every one is missing. Unset, empty and entry-less values are kept.
pub(crate) fn should_remove_plugin_path(
    value: Option<&OsStr>,
    launcher_entry: Option<&Path>,
    exists: impl Fn(&Path) -> bool,
) -> bool {
    let Some(value) = value else {
        return false;
    };
    let entries: Vec<_> = std::env::split_paths(value)
        .filter(|entry| !entry.as_os_str().is_empty())
        .collect();
    if let (Some(first), Some(launcher_entry)) = (entries.first(), launcher_entry)
        && first == launcher_entry
    {
        return !exists(first);
    }
    !entries.is_empty() && !entries.iter().any(|entry| exists(entry))
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
    }

    #[test]
    fn removes_any_value_whose_directories_are_all_missing() {
        assert!(decide(Some("/missing/one:/missing/two:"), false, &[]));
        assert!(decide(Some("/missing/one"), true, &[]));
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
        let raw = OsStr::from_bytes(b"/missing:/opt/\xff");
        assert!(!should_remove_plugin_path(Some(raw), None, |path| {
            path.as_os_str().as_bytes() == b"/opt/\xff"
        }));
        assert!(should_remove_plugin_path(Some(raw), None, |_| false));
    }
}
