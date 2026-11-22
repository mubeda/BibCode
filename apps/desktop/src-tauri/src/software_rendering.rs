//! Linux: run WebKitGTK without GPU compositing (#411). On some Intel GPUs the
//! driver hangs in WebKitGTK's compositor thread and takes the whole desktop
//! session down. When the user turns this on, `main` sets the two WebKit
//! variables below before any thread or webview exists, so every launch route
//! (menu, binary, `bibcode://` link) gets them. See
//! `docs/plans/2026-11-21-linux-software-rendering-design.md`.
// Compiled everywhere so its tests run on every host; only Linux applies it.
#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

use serde_json::Value;
use std::ffi::{OsStr, OsString};
use std::path::Path;
use std::sync::OnceLock;

/// The key in `desktop-settings.json`, decoded on its own so a bad value cannot
/// reset the other settings.
pub(crate) const SETTING_KEY: &str = "linuxSoftwareRendering";
/// `1` turns the setting on for one launch, `0` makes BiBCode set nothing.
pub(crate) const OVERRIDE_VARIABLE: &str = "BIBCODE_SOFTWARE_RENDERING";
pub(crate) const WEBKIT_VARIABLES: [&str; 2] = [
    "WEBKIT_DISABLE_COMPOSITING_MODE",
    "WEBKIT_DISABLE_DMABUF_RENDERER",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Override {
    On,
    Off,
}

impl Override {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::On => "on",
            Self::Off => "off",
        }
    }
}

/// What one launch does: the variables BiBCode sets itself, and why.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Decision {
    pub(crate) stored: bool,
    pub(crate) override_value: Option<Override>,
    /// The override variable held a value other than `0` or `1`.
    pub(crate) ignored_override: bool,
    pub(crate) set: Vec<&'static str>,
}

/// Decides which variables to set. A variable already present, with any value,
/// is the user's and is never touched.
pub(crate) fn decide(
    stored: bool,
    override_raw: Option<&OsStr>,
    present: impl Fn(&str) -> bool,
    linux: bool,
) -> Decision {
    if !linux {
        return Decision::default();
    }
    let override_value = match override_raw.and_then(OsStr::to_str) {
        Some("1") => Some(Override::On),
        Some("0") => Some(Override::Off),
        _ => None,
    };
    let on = override_value.map_or(stored, |value| value == Override::On);
    Decision {
        stored,
        override_value,
        ignored_override: override_raw.is_some() && override_value.is_none(),
        set: if on {
            WEBKIT_VARIABLES
                .into_iter()
                .filter(|name| !present(name))
                .collect()
        } else {
            Vec::new()
        },
    }
}

/// Whether restarting from Settings would change what BiBCode sets: never while
/// the override decides, else when the setting wants a variable that is still
/// missing, or no longer wants one BiBCode set.
pub(crate) fn restart_applies(
    enabled: bool,
    decision: &Decision,
    present: impl Fn(&str) -> bool,
) -> bool {
    if decision.override_value.is_some() {
        return false;
    }
    if enabled {
        WEBKIT_VARIABLES.into_iter().any(|name| !present(name))
    } else {
        !decision.set.is_empty()
    }
}

/// Whether WebKit runs without its GPU compositor: either variable present and not `0`. On
/// WebKitGTK 2.50 either one alone removes the `ThreadedCompositor` thread (checked in a
/// Hyprland VM), and `WEBKIT_DISABLE_COMPOSITING_MODE=0` alone keeps it.
pub(crate) fn gpu_compositing_disabled(value_of: impl Fn(&str) -> Option<OsString>) -> bool {
    WEBKIT_VARIABLES
        .into_iter()
        .any(|name| value_of(name).is_some_and(|value| value != "0"))
}

/// The stored setting from a parsed `desktop-settings.json`; anything but `true` is off.
pub(crate) fn setting_from_document(document: &Value) -> bool {
    document
        .get(SETTING_KEY)
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

/// Reads the stored setting. A missing file is off; an unreadable or malformed
/// one is off too, with the reason to log once the log sink is ready.
pub(crate) fn read_stored_setting(path: &Path) -> (bool, Option<String>) {
    match crate::config::read_json_file(path) {
        Ok(Some(document)) => (setting_from_document(&document), None),
        Ok(None) => (false, None),
        Err(error) => (false, Some(error)),
    }
}

struct Startup {
    decision: Decision,
    settings_problem: Option<String>,
}

static STARTUP: OnceLock<Startup> = OnceLock::new();

/// Applies the setting to this process. Call it only while the process is
/// single-threaded: `main` does, right before `run()`.
#[cfg(target_os = "linux")]
pub fn apply_process_environment() {
    let (stored, settings_problem) = match crate::config::state_dir_from_environment() {
        Ok(state_dir) => {
            read_stored_setting(&state_dir.join(crate::bridge::DESKTOP_SETTINGS_FILE_NAME))
        }
        Err(error) => (false, Some(error)),
    };
    let decision = decide(
        stored,
        std::env::var_os(OVERRIDE_VARIABLE).as_deref(),
        |name| std::env::var_os(name).is_some(),
        true,
    );
    for name in &decision.set {
        // SAFETY: `main` calls this before Tauri, Tokio, GTK or WebKit start, and the crash
        // hook attached earlier spawns no thread on Linux, so nothing else can read or write
        // the environment concurrently.
        unsafe { std::env::set_var(name, "1") };
    }
    let _ = STARTUP.set(Startup {
        decision,
        settings_problem,
    });
}

/// This launch's decision; empty off Linux.
pub(crate) fn startup_decision() -> Decision {
    STARTUP
        .get()
        .map(|startup| startup.decision.clone())
        .unwrap_or_default()
}

/// The variables BiBCode set itself, which a relaunch must not pass on.
pub(crate) fn variables_set_by_bibcode() -> &'static [&'static str] {
    STARTUP
        .get()
        .map_or(&[], |startup| startup.decision.set.as_slice())
}

/// Logs the start-up decision; called from `setup`, once the log sink exists.
pub(crate) fn record_startup() {
    let Some(startup) = STARTUP.get() else {
        return;
    };
    if let Some(problem) = &startup.settings_problem {
        tracing::warn!(
            %problem,
            "could not read the software rendering setting; GPU compositing stays on"
        );
    }
    if startup.decision.ignored_override {
        tracing::warn!(
            "{OVERRIDE_VARIABLE} must be 0 or 1; the stored software rendering setting applies"
        );
    }
    tracing::info!(
        stored = startup.decision.stored,
        override_value = startup.decision.override_value.map(Override::as_str),
        set = ?startup.decision.set,
        gpu_compositing_disabled = gpu_compositing_disabled(|name| std::env::var_os(name)),
        "software rendering start-up decision"
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const COMPOSITING: &str = "WEBKIT_DISABLE_COMPOSITING_MODE";
    const DMABUF: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";

    fn decide_with(stored: bool, override_raw: Option<&str>, present: &[&str]) -> Decision {
        decide(
            stored,
            override_raw.map(OsStr::new),
            |name| present.contains(&name),
            true,
        )
    }

    #[test]
    fn software_rendering_on_sets_both_variables() {
        assert_eq!(decide_with(true, None, &[]).set, vec![COMPOSITING, DMABUF]);
    }

    #[test]
    fn software_rendering_off_sets_nothing() {
        assert!(decide_with(false, None, &[]).set.is_empty());
    }

    #[test]
    fn software_rendering_keeps_a_value_the_user_exported() {
        // Per variable: the user's one is kept, the other is still set.
        assert_eq!(decide_with(true, None, &[COMPOSITING]).set, vec![DMABUF]);
        assert!(
            decide_with(true, None, &[COMPOSITING, DMABUF])
                .set
                .is_empty()
        );
    }

    #[test]
    fn software_rendering_override_wins_in_both_directions() {
        let on = decide_with(false, Some("1"), &[]);
        assert_eq!(on.set, vec![COMPOSITING, DMABUF]);
        assert_eq!(on.override_value, Some(Override::On));
        let off = decide_with(true, Some("0"), &[]);
        assert!(off.set.is_empty());
        assert_eq!(off.override_value, Some(Override::Off));
    }

    #[test]
    fn software_rendering_ignores_an_unknown_override_value() {
        for raw in ["", "true", "yes", "2"] {
            let decision = decide_with(true, Some(raw), &[]);
            assert_eq!(decision.set, vec![COMPOSITING, DMABUF], "{raw:?}");
            assert!(decision.ignored_override, "{raw:?}");
            assert_eq!(decision.override_value, None, "{raw:?}");
        }
    }

    #[test]
    fn software_rendering_changes_nothing_off_linux() {
        let decision = decide(true, Some(OsStr::new("1")), |_| false, false);
        assert_eq!(decision, Decision::default());
    }

    #[test]
    fn software_rendering_restart_applies_only_when_it_changes_something() {
        let off_now = decide_with(false, None, &[]);
        assert!(restart_applies(true, &off_now, |_| false));
        assert!(!restart_applies(false, &off_now, |_| false));

        let on_now = decide_with(true, None, &[]);
        let all_present = |_: &str| true;
        assert!(!restart_applies(true, &on_now, all_present));
        assert!(restart_applies(false, &on_now, all_present));

        // The user exported both: a restart cannot change anything.
        let exported = decide_with(true, None, &[COMPOSITING, DMABUF]);
        assert!(!restart_applies(true, &exported, all_present));
        assert!(!restart_applies(false, &exported, all_present));

        // The override decides this launch and the next one started the same way.
        let overridden = decide_with(false, Some("1"), &[]);
        assert!(!restart_applies(false, &overridden, all_present));
        assert!(!restart_applies(
            true,
            &decide_with(true, Some("0"), &[]),
            |_| false
        ));
    }

    #[test]
    fn software_rendering_reports_compositing_off_only_for_a_value_other_than_zero() {
        let with = |values: &[(&str, &str)]| {
            let values: Vec<(String, OsString)> = values
                .iter()
                .map(|(name, value)| ((*name).to_owned(), OsString::from(value)))
                .collect();
            gpu_compositing_disabled(move |name| {
                values
                    .iter()
                    .find(|(key, _)| key == name)
                    .map(|(_, value)| value.clone())
            })
        };
        assert!(with(&[(COMPOSITING, "1"), (DMABUF, "1")]));
        assert!(with(&[(DMABUF, "1")]));
        // A user's `0` for one variable does not hide the other.
        assert!(with(&[(COMPOSITING, "0"), (DMABUF, "1")]));
        assert!(!with(&[(COMPOSITING, "0")]));
        assert!(!with(&[]));
    }

    #[test]
    fn software_rendering_setting_decodes_only_a_boolean() {
        assert!(setting_from_document(&json!({ SETTING_KEY: true })));
        assert!(!setting_from_document(&json!({ SETTING_KEY: false })));
        assert!(!setting_from_document(&json!({ SETTING_KEY: "yes" })));
        assert!(!setting_from_document(&json!({})));
        assert!(!setting_from_document(&json!([])));
    }

    #[test]
    fn software_rendering_reads_the_stored_setting_from_a_file() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("desktop-settings.json");
        assert_eq!(read_stored_setting(&path), (false, None));

        std::fs::write(&path, r#"{"linuxSoftwareRendering":true,"wslOnly":"bad"}"#).unwrap();
        assert_eq!(read_stored_setting(&path), (true, None));

        std::fs::write(&path, "{not json").unwrap();
        let (stored, problem) = read_stored_setting(&path);
        assert!(!stored);
        assert!(problem.is_some());
    }
}
