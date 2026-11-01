/// Whether a standard/Tokio command inherits the parent environment.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EnvironmentInheritance {
    Inherit,
    Cleared,
}

/// Adapts the supported command builders without owning or spawning a process.
/// PTYs already hold their complete environment, so inheritance only applies to
/// standard/Tokio commands.
pub enum ChildCommand<'a> {
    Process {
        command: &'a mut std::process::Command,
        inheritance: EnvironmentInheritance,
    },
    Pty(&'a mut portable_pty::CommandBuilder),
}

/// Uses `Inherit`; see the warning on [`isolate_appimage_environment`].
impl<'a> From<&'a mut std::process::Command> for ChildCommand<'a> {
    fn from(command: &'a mut std::process::Command) -> Self {
        Self::Process {
            command,
            inheritance: EnvironmentInheritance::Inherit,
        }
    }
}

/// Uses `Inherit`; see the warning on [`isolate_appimage_environment`].
impl<'a> From<&'a mut tokio::process::Command> for ChildCommand<'a> {
    fn from(command: &'a mut tokio::process::Command) -> Self {
        Self::Process {
            command: command.as_std_mut(),
            inheritance: EnvironmentInheritance::Inherit,
        }
    }
}

impl<'a> From<&'a mut portable_pty::CommandBuilder> for ChildCommand<'a> {
    fn from(command: &'a mut portable_pty::CommandBuilder) -> Self {
        Self::Pty(command)
    }
}

/// Isolate a user-facing child from AppImage launcher state, after configuring
/// its environment. Never call for BiBCode binaries or the desktop/WebKitGTK
/// process itself. A no-op off Linux; does not change process-global state.
///
/// # Warning
///
/// After `env_clear()`, pass `ChildCommand::Process` with
/// `inheritance: EnvironmentInheritance::Cleared` and the standard command builder
/// (`command.as_std_mut()` for Tokio). The default `Inherit` conversion would
/// evaluate the parent environment.
pub fn isolate_appimage_environment<'a>(command: impl Into<ChildCommand<'a>>) {
    #[cfg(target_os = "linux")]
    linux::isolate(command.into());
    #[cfg(not(target_os = "linux"))]
    let _ = command;
}

#[cfg(target_os = "linux")]
mod linux {
    use super::{ChildCommand, EnvironmentInheritance};
    use std::{
        collections::BTreeMap,
        ffi::{OsStr, OsString},
        os::unix::ffi::OsStrExt,
        path::{Path, PathBuf},
    };

    /// Launcher markers and forced settings removed from user-facing children.
    ///
    /// These children do not consume AppImage markers: Git disables askpass, and
    /// desktop SSH askpass is a temporary script, not the AppImage binary. The gate
    /// reads the pre-isolation environment, so child marker removal leaves the
    /// parent environment and future spawn decisions unchanged.
    ///
    /// linuxdeploy's AppRun.wrapped C runtime forces PYTHONDONTWRITEBYTECODE; its
    /// packaged GTK hook (apprun-hooks/linuxdeploy-plugin-gtk.sh) overwrites
    /// GDK_BACKEND, but exports GTK_THEME only for a nonempty user-supplied
    /// APPIMAGE_GTK_THEME. An inherited GTK_THEME otherwise passes through.
    /// GTK_PATH is also overwritten with bundled and host paths, not
    /// appended to the user value: even its surviving host directories must be removed.
    /// Remove these settings, including inherited or overridden GTK_THEME, from
    /// user-facing children so shells can reapply their rc settings as in SSH.
    const LAUNCHER_VARIABLES: [&str; 8] = [
        "APPDIR",
        "APPIMAGE",
        "ARGV0",
        "OWD",
        "GTK_PATH",
        "GTK_THEME",
        "GDK_BACKEND",
        "PYTHONDONTWRITEBYTECODE",
    ];

    /// Child-only overrides for user-facing commands, evaluated from their effective
    /// environment. Never mutate std::env: the desktop and its WebKitGTK children,
    /// and BiBCode's own binaries, need the bundled environment.
    pub(crate) fn child_environment_overrides(
        environment: &BTreeMap<OsString, OsString>,
        roots: &[PathBuf],
    ) -> Vec<(OsString, Option<OsString>)> {
        // Both launcher layers keep adding paths (Python, Qt, GStreamer, GTK), so
        // inspect every value instead of maintaining a name list.
        let mut overrides = Vec::new();
        for (name, value) in environment {
            if name
                .to_str()
                .is_some_and(|name| LAUNCHER_VARIABLES.contains(&name))
            {
                overrides.push((name.clone(), None));
                continue;
            }
            let mut removed = false;
            let host_paths: Vec<_> = value
                .as_bytes()
                .split(|byte| {
                    // glibc accepts semicolons in library paths, and spaces in
                    // preloads. Other path lists use colons, preserving spaces.
                    *byte == b':'
                        || (name == "LD_LIBRARY_PATH" && *byte == b';')
                        || (name == "LD_PRELOAD" && *byte == b' ')
                })
                .map(|entry| Path::new(OsStr::from_bytes(entry)))
                .filter(|path| {
                    // Include extracted AppDirs and stale mounts from prior versions,
                    // but keep host paths that only share the AppDir's name prefix.
                    let bundled = roots.iter().any(|root| path.starts_with(root))
                        || (path.is_absolute()
                            && path.components().any(|component| {
                                component.as_os_str().as_bytes().starts_with(b".mount_")
                            }));
                    removed |= bundled;
                    !bundled
                })
                .collect();
            if !removed {
                continue;
            }
            // AppRun appends an empty original as a trailing separator. Remove
            // empty-only survivors so children neither search cwd for libraries
            // nor disable system plugins with an empty GStreamer search path.
            let value = if host_paths.iter().all(|path| path.as_os_str().is_empty()) {
                None
            } else {
                Some(std::env::join_paths(host_paths).expect("split Unix paths can be rejoined"))
            };
            overrides.push((name.clone(), value));
        }
        overrides
    }

    /// AppDir roots whose paths user-facing children must not inherit, or `None`
    /// outside an AppImage or AppDir.
    fn appimage_roots(
        variable: impl Fn(&str) -> Option<OsString>,
        current_executable: impl FnOnce() -> Option<PathBuf>,
    ) -> Option<Vec<PathBuf>> {
        if variable("APPIMAGE").is_some_and(|marker| !marker.is_empty()) {
            let appdir = PathBuf::from(variable("APPDIR")?);
            if !(appdir.is_absolute() && appdir.parent().is_some()) {
                return None;
            }
            // An extracted AppDir launched from a mounted AppImage inherits its
            // APPIMAGE and APPDIR, so also strip the executable's own AppDir. A
            // normal mounted launch runs under APPDIR and needs no stat.
            let extra = current_executable()
                .filter(|executable| !executable.starts_with(&appdir))
                .and_then(|executable| extracted_appdir(&executable));
            return Some([appdir].into_iter().chain(extra).collect());
        }
        // Extracted AppDirs have no APPIMAGE. AppRun keeps an inherited APPDIR and
        // a launcher may exec the binary without one, while AppRun.wrapped roots
        // loader paths in its own directory. So trust only the executable's
        // `<root>/usr/bin/<name>` layout beside `<root>/AppRun`: one stat per command,
        // plus one when gated with an `APPDIR` naming another directory.
        let root = extracted_appdir(&current_executable()?)?;
        let mut roots = vec![root.clone()];
        // Launched from another extracted AppDir, AppRun.wrapped prepends its own
        // paths to the outer AppDir's and the GTK hook keeps the outer APPDIR.
        // Strip that root too, but only once gated and only for a real AppDir.
        if let Some(outer) = variable("APPDIR").map(PathBuf::from)
            && outer.is_absolute()
            && outer.parent().is_some()
            && outer != root
            && outer.join("AppRun").exists()
        {
            roots.push(outer);
        }
        Some(roots)
    }

    /// `<root>` of an executable at `<root>/usr/bin/<name>` beside `<root>/AppRun`.
    fn extracted_appdir(executable: &Path) -> Option<PathBuf> {
        let bin = executable.parent()?;
        let usr = bin.parent()?;
        let root = usr.parent()?;
        (bin.ends_with("bin")
            && usr.ends_with("usr")
            && root.parent().is_some()
            && root.join("AppRun").exists())
        .then(|| root.to_path_buf())
    }

    pub(super) fn isolate(mut command: ChildCommand<'_>) {
        // The single gate does cheap lookups before copying an environment.
        let Some(roots) = appimage_roots(
            |name| command.variable(name),
            || std::env::current_exe().ok(),
        ) else {
            return;
        };
        let environment = command.environment();
        for (name, value) in child_environment_overrides(&environment, &roots) {
            command.apply_override(name, value);
        }
    }

    impl ChildCommand<'_> {
        fn apply_override(&mut self, name: OsString, value: Option<OsString>) {
            match self {
                Self::Process { command, .. } => {
                    match value {
                        Some(value) => command.env(name, value),
                        None => command.env_remove(name),
                    };
                }
                Self::Pty(command) => match value {
                    Some(value) => command.env(name, value),
                    None => command.env_remove(name),
                },
            }
        }

        fn variable(&self, name: &str) -> Option<OsString> {
            match self {
                Self::Process {
                    command,
                    inheritance,
                } => match command.get_envs().find(|(key, _)| *key == name) {
                    Some((_, value)) => value.map(OsStr::to_owned),
                    None if *inheritance == EnvironmentInheritance::Inherit => {
                        std::env::var_os(name)
                    }
                    None => None,
                },
                Self::Pty(command) => command.get_env(name).map(OsStr::to_owned),
            }
        }

        fn environment(&self) -> BTreeMap<OsString, OsString> {
            match self {
                Self::Process {
                    command,
                    inheritance,
                } => {
                    let mut environment = if *inheritance == EnvironmentInheritance::Inherit {
                        std::env::vars_os().collect::<BTreeMap<_, _>>()
                    } else {
                        BTreeMap::new()
                    };
                    for (name, value) in command.get_envs() {
                        match value {
                            Some(value) => environment.insert(name.to_owned(), value.to_owned()),
                            None => environment.remove(name),
                        };
                    }
                    environment
                }
                Self::Pty(command) => command
                    .iter_full_env()
                    .map(|(name, value)| (name.to_owned(), value.to_owned()))
                    .collect(),
            }
        }
    }
    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn pty_isolation_includes_non_utf8_command_overrides() {
            use std::os::unix::ffi::OsStringExt;

            let mut command = portable_pty::CommandBuilder::new("/usr/bin/env");
            command.env_clear();
            command.env("APPDIR", "/tmp/bibcode-raw-appdir");
            command.env("APPIMAGE", "/opt/bibcode.AppImage");
            let name = OsString::from_vec(b"BIBCODE_RAW_\xff".to_vec());
            command.env(
                &name,
                OsString::from_vec(b"/tmp/bibcode-raw-appdir/usr/lib:/host/\xff".to_vec()),
            );
            super::super::isolate_appimage_environment(&mut command);
            assert_eq!(
                command.get_env(&name),
                Some(OsStr::from_bytes(b"/host/\xff"))
            );
        }

        fn gated_overrides(
            environment: &BTreeMap<OsString, OsString>,
            executable: Option<&Path>,
        ) -> Vec<(OsString, Option<OsString>)> {
            appimage_roots(
                |name| environment.get(OsStr::new(name)).cloned(),
                || executable.map(Path::to_path_buf),
            )
            .map(|roots| child_environment_overrides(environment, &roots))
            .unwrap_or_default()
        }

        fn environment(appdir: &Path, appimage: Option<&str>) -> BTreeMap<OsString, OsString> {
            let mut environment = BTreeMap::from([
                ("APPDIR".into(), appdir.as_os_str().to_owned()),
                ("PYTHONHOME".into(), appdir.join("usr").into_os_string()),
            ]);
            if let Some(appimage) = appimage {
                environment.insert("APPIMAGE".into(), appimage.into());
            }
            environment
        }

        #[test]
        fn extracted_appdir_isolation_requires_launcher_and_executable_identity() {
            let fixture = tempfile::tempdir().unwrap();
            let appdir = fixture.path().join("squashfs-root");
            std::fs::create_dir(&appdir).unwrap();
            std::fs::write(appdir.join("AppRun"), "launcher").unwrap();
            let executable = appdir.join("usr/bin/bibcode-desktop");
            for marker in [None, Some("")] {
                let environment = environment(&appdir, marker);
                let overrides = gated_overrides(&environment, Some(&executable));
                assert!(
                    overrides
                        .iter()
                        .any(|(name, value)| name == "PYTHONHOME" && value.is_none()),
                    "extracted AppRun must isolate Python without APPIMAGE"
                );
                for outside in [
                    fixture.path().join("bibcode"),
                    fixture.path().join("squashfs-root-host/bin/bibcode"),
                ] {
                    assert!(gated_overrides(&environment, Some(&outside)).is_empty());
                }
                assert!(gated_overrides(&environment, None).is_empty());
            }
            std::fs::remove_file(appdir.join("AppRun")).unwrap();
            assert!(
                gated_overrides(&environment(&appdir, None), Some(&executable)).is_empty(),
                "an executable without AppRun beside its usr/bin must not strip paths"
            );
        }

        #[test]
        fn extracted_appdir_root_comes_from_the_executable_not_appdir() {
            let fixture = tempfile::tempdir().unwrap();
            let appdir = fixture.path().join("BiBCode.AppDir");
            let other = fixture.path().join("Other.AppDir");
            for directory in [&appdir, &other] {
                std::fs::create_dir(directory).unwrap();
                std::fs::write(directory.join("AppRun"), "launcher").unwrap();
            }
            let executable = appdir.join("usr/bin/bibcode-desktop");
            let library_path = OsString::from(format!("{}/usr/lib:/host/keep", appdir.display()));
            // AppRun keeps an inherited APPDIR, and a launcher may exec the binary
            // without one, while AppRun.wrapped roots loader paths in the real AppDir.
            for stray in [None, Some(fixture.path().join("stale")), Some(other)] {
                let mut environment =
                    BTreeMap::from([("LD_LIBRARY_PATH".into(), library_path.clone())]);
                if let Some(stray) = &stray {
                    environment.insert("APPDIR".into(), stray.clone().into_os_string());
                }
                let overrides = gated_overrides(&environment, Some(&executable));
                assert!(
                    overrides.contains(&("LD_LIBRARY_PATH".into(), Some("/host/keep".into()))),
                    "APPDIR {stray:?} must not hide the running AppDir"
                );
                assert_eq!(
                    overrides.contains(&("APPDIR".into(), None)),
                    stray.is_some()
                );
            }
            // An ordinary install whose environment names a real AppDir keeps it.
            let environment = BTreeMap::from([
                ("APPDIR".into(), appdir.clone().into_os_string()),
                ("LD_LIBRARY_PATH".into(), library_path),
            ]);
            for outside in [
                PathBuf::from("/usr/bin/bibcode"),
                fixture.path().join("usr/bin/bibcode"),
                appdir.join("bibcode"),
                appdir.join("usr/lib/bibcode"),
            ] {
                assert!(
                    gated_overrides(&environment, Some(&outside)).is_empty(),
                    "{}",
                    outside.display()
                );
            }
        }

        #[test]
        fn extracted_appdir_launched_from_another_appdir_strips_both_roots() {
            let fixture = tempfile::tempdir().unwrap();
            let outer = fixture.path().join("Outer.AppDir");
            let inner = fixture.path().join("BiBCode.AppDir");
            let not_appdir = fixture.path().join("NotAnAppDir");
            for directory in [&outer, &inner, &not_appdir] {
                std::fs::create_dir(directory).unwrap();
            }
            for directory in [&outer, &inner] {
                std::fs::write(directory.join("AppRun"), "launcher").unwrap();
            }
            let executable = inner.join("usr/bin/bibcode-desktop");
            // AppRun.wrapped prepends its own paths and keeps the outer AppDir's.
            let library_path = |outer: &Path| {
                OsString::from(format!(
                    "{}/usr/lib:{}/usr/lib:/host/keep",
                    inner.display(),
                    outer.display()
                ))
            };
            let overrides = |appdir: &Path| {
                let environment = BTreeMap::from([
                    ("APPDIR".into(), appdir.as_os_str().to_owned()),
                    ("LD_LIBRARY_PATH".into(), library_path(appdir)),
                ]);
                gated_overrides(&environment, Some(&executable))
            };
            assert!(
                overrides(&outer).contains(&("LD_LIBRARY_PATH".into(), Some("/host/keep".into()))),
                "an inherited APPDIR naming another AppDir must not leave its libraries"
            );
            // Only a validated AppDir adds a root; otherwise its entries are host paths.
            let kept = format!("{}/usr/lib:/host/keep", not_appdir.display());
            assert!(
                overrides(&not_appdir).contains(&("LD_LIBRARY_PATH".into(), Some(kept.into())))
            );
            // An ordinary install with the same inherited state strips nothing.
            let environment = BTreeMap::from([
                ("APPDIR".into(), outer.clone().into_os_string()),
                ("LD_LIBRARY_PATH".into(), library_path(&outer)),
            ]);
            assert!(gated_overrides(&environment, Some(Path::new("/usr/bin/bibcode"))).is_empty());
        }

        #[test]
        fn extracted_appdir_launched_from_mounted_appimage_strips_its_own_root() {
            let fixture = tempfile::tempdir().unwrap();
            let mount = fixture.path().join(".mount_OtherAB12");
            let inner = fixture.path().join("BiBCode.AppDir");
            for directory in [&mount, &inner] {
                std::fs::create_dir(directory).unwrap();
            }
            std::fs::write(inner.join("AppRun"), "launcher").unwrap();
            // B inherits A's APPIMAGE and APPDIR; AppRun.wrapped prepends B's paths.
            let environment = BTreeMap::from([
                ("APPIMAGE".into(), "/opt/Other.AppImage".into()),
                ("APPDIR".into(), mount.clone().into_os_string()),
                (
                    "LD_LIBRARY_PATH".into(),
                    format!(
                        "{}/usr/lib:{}/usr/lib:/host/keep",
                        inner.display(),
                        mount.display()
                    )
                    .into(),
                ),
            ]);
            let overrides =
                gated_overrides(&environment, Some(&inner.join("usr/bin/bibcode-desktop")));
            assert!(
                overrides.contains(&("LD_LIBRARY_PATH".into(), Some("/host/keep".into()))),
                "an AppDir launched from a mounted AppImage must not keep its own libraries"
            );
            // Without AppRun beside usr/bin the executable adds no root.
            std::fs::remove_file(inner.join("AppRun")).unwrap();
            let kept = format!("{}/usr/lib:/host/keep", inner.display());
            assert!(
                gated_overrides(&environment, Some(&inner.join("usr/bin/bibcode-desktop")))
                    .contains(&("LD_LIBRARY_PATH".into(), Some(kept.into())))
            );
        }

        #[test]
        fn appimage_marker_keeps_existing_gate_independent_of_executable_location() {
            let fixture = tempfile::tempdir().unwrap();
            let environment = environment(fixture.path(), Some("/opt/bibcode.AppImage"));
            assert!(!gated_overrides(&environment, None).is_empty());
            assert!(!gated_overrides(&environment, Some(Path::new("/usr/bin/bibcode"))).is_empty());
            for invalid in ["", "/", "relative/AppDir"] {
                let mut environment = environment.clone();
                environment.insert("APPDIR".into(), invalid.into());
                assert!(
                    gated_overrides(&environment, Some(Path::new("/usr/bin/bibcode"))).is_empty()
                );
            }
        }

        #[test]
        fn cleared_command_does_not_reintroduce_ambient_variables() {
            use crate::test_support::appimage_environment::check_inherited_environment;
            const TEST: &str = "process::appimage::linux::tests::cleared_command_does_not_reintroduce_ambient_variables";
            check_inherited_environment(TEST, &["mixed"], |_| {
                let mut command = std::process::Command::new("/usr/bin/env");
                command.env_clear().arg("-0");
                // Keep the gate ON from explicit values, while every other
                // inherited fixture variable must stay out of this command.
                command.env("APPDIR", std::env::var_os("APPDIR").unwrap());
                command.env("APPIMAGE", std::env::var_os("APPIMAGE").unwrap());
                command.env("BIBCODE_EXPLICIT_ONLY", "yes");
                super::super::isolate_appimage_environment(ChildCommand::Process {
                    command: &mut command,
                    inheritance: EnvironmentInheritance::Cleared,
                });
                let output = command.output().unwrap();
                assert!(output.status.success());
                assert_eq!(output.stdout, b"BIBCODE_EXPLICIT_ONLY=yes\0");
            });
        }
    }
}
