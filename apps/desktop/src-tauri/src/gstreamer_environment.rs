//! The AppImage launcher (`AppRun.wrapped`) prepends `$APPDIR/usr/lib/gstreamer-1.0:` to
//! `GST_PLUGIN_SYSTEM_PATH_1_0` (and `$APPDIR/usr/lib/gstreamer:` to `GST_PLUGIN_SYSTEM_PATH`),
//! but the bundle ships no GStreamer plugins. GStreamer then scans no plugin at all, finds no
//! `autoaudiosink`, and WebKitGTK's web process dies on the first audio element. Dropping the
//! missing folders, or the whole variable when nothing it names exists, lets GStreamer use the
//! system's default plugin path again. Child web processes inherit the repaired environment.

use std::ffi::{OsStr, OsString};
use std::path::Path;

/// The plugin path variables GStreamer 1.x reads, in its own order of precedence.
#[cfg(target_os = "linux")]
const PLUGIN_SYSTEM_PATH_VARIABLES: [&str; 2] =
    ["GST_PLUGIN_SYSTEM_PATH_1_0", "GST_PLUGIN_SYSTEM_PATH"];

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum PluginPathRepair {
    Keep,
    Remove,
    Replace(OsString),
}

/// Decides what to do with one plugin path variable. Unset, empty or entry-less values are kept:
/// only a value that names directories, all of them missing, is removed.
pub(crate) fn repair_plugin_path(
    value: Option<&OsStr>,
    exists: impl Fn(&Path) -> bool,
) -> PluginPathRepair {
    let Some(value) = value else {
        return PluginPathRepair::Keep;
    };
    let entries: Vec<_> = std::env::split_paths(value)
        .filter(|entry| !entry.as_os_str().is_empty())
        .collect();
    if entries.is_empty() {
        return PluginPathRepair::Keep;
    }
    let existing: Vec<_> = entries.iter().filter(|entry| exists(entry)).collect();
    if existing.is_empty() {
        return PluginPathRepair::Remove;
    }
    match std::env::join_paths(existing) {
        Ok(joined) if joined != value => PluginPathRepair::Replace(joined),
        _ => PluginPathRepair::Keep,
    }
}

/// Repairs both plugin path variables in this process. Call it only while the process is
/// single-threaded: `main` does, right after the crash hook.
#[cfg(target_os = "linux")]
pub fn repair_process_environment() {
    for name in PLUGIN_SYSTEM_PATH_VARIABLES {
        let repair = repair_plugin_path(std::env::var_os(name).as_deref(), Path::is_dir);
        // SAFETY: `main` calls this before Tauri, Tokio, GTK or WebKit start, and on Linux the
        // crash hook attached just before installs signal handlers without spawning a thread,
        // so no other thread can read or write the environment concurrently.
        match repair {
            PluginPathRepair::Keep => {}
            PluginPathRepair::Remove => unsafe { std::env::remove_var(name) },
            PluginPathRepair::Replace(value) => unsafe { std::env::set_var(name, value) },
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn decide(value: Option<&str>, existing: &[&str]) -> PluginPathRepair {
        repair_plugin_path(value.map(OsStr::new), |path| {
            existing.iter().any(|existing| Path::new(existing) == path)
        })
    }

    #[test]
    fn removes_a_value_whose_directories_are_all_missing() {
        assert_eq!(
            decide(Some("/tmp/.mount_bibcodX/usr/lib/gstreamer-1.0:"), &[]),
            PluginPathRepair::Remove
        );
        assert_eq!(
            decide(Some("/missing/one:/missing/two"), &[]),
            PluginPathRepair::Remove
        );
    }

    #[test]
    fn keeps_existing_directories_and_drops_missing_ones() {
        assert_eq!(
            decide(
                Some("/tmp/.mount_bibcodX/usr/lib/gstreamer-1.0::/opt/host/gstreamer-1.0"),
                &["/opt/host/gstreamer-1.0"]
            ),
            PluginPathRepair::Replace("/opt/host/gstreamer-1.0".into())
        );
    }

    #[test]
    fn keeps_a_value_whose_directories_all_exist() {
        assert_eq!(
            decide(Some("/opt/a:/opt/b"), &["/opt/a", "/opt/b"]),
            PluginPathRepair::Keep
        );
    }

    #[test]
    fn leaves_unset_empty_and_entry_less_values_untouched() {
        assert_eq!(decide(None, &[]), PluginPathRepair::Keep);
        assert_eq!(decide(Some(""), &[]), PluginPathRepair::Keep);
        assert_eq!(decide(Some(":"), &[]), PluginPathRepair::Keep);
    }

    #[test]
    fn ignores_the_launchers_trailing_empty_entry() {
        assert_eq!(
            decide(
                Some("/opt/host/gstreamer-1.0:"),
                &["/opt/host/gstreamer-1.0"]
            ),
            PluginPathRepair::Replace("/opt/host/gstreamer-1.0".into())
        );
    }

    #[test]
    fn keeps_raw_byte_entries_that_exist() {
        use std::os::unix::ffi::{OsStrExt, OsStringExt};
        let raw = OsStr::from_bytes(b"/opt/\xff:/missing");
        assert_eq!(
            repair_plugin_path(Some(raw), |path| path.as_os_str().as_bytes()
                == b"/opt/\xff"),
            PluginPathRepair::Replace(OsString::from_vec(b"/opt/\xff".to_vec()))
        );
    }
}
