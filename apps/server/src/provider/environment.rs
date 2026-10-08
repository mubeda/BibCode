use std::{ffi::OsString, path::PathBuf};

/// The value a provider process sees for `name`: the instance environment first (matched
/// case-insensitively, as Windows does), then the server's own environment.
pub(crate) fn effective_environment_value(
    environment: &[(OsString, OsString)],
    name: &str,
) -> Option<OsString> {
    environment
        .iter()
        .find(|(candidate, _)| candidate.to_string_lossy().eq_ignore_ascii_case(name))
        .map(|(_, value)| value.clone())
        .or_else(|| std::env::var_os(name))
}

/// The configuration directory Claude Code uses under `environment`: `CLAUDE_CONFIG_DIR`, else
/// `.claude` in the home directory.
pub(crate) fn claude_config_directory(environment: &[(OsString, OsString)]) -> Option<PathBuf> {
    effective_environment_value(environment, "CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| {
            effective_environment_value(environment, "HOME")
                .map(|home| PathBuf::from(home).join(".claude"))
        })
        .or_else(|| {
            effective_environment_value(environment, "USERPROFILE")
                .map(|home| PathBuf::from(home).join(".claude"))
        })
}

/// Isolate providers from host diagnostics and AppImage launcher paths.
pub(crate) fn sanitize_provider_subprocess_environment(command: &mut tokio::process::Command) {
    // Host diagnostics must not turn provider stderr into a high-volume event stream.
    command.env_remove("RUST_LOG");
    crate::process::isolate_appimage_environment(command);
}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "linux")]
    use std::time::Duration;

    #[test]
    fn provider_commands_do_not_inherit_host_rust_logging() {
        let mut command = tokio::process::Command::new("provider-fixture");
        command.env("RUST_LOG", "info");

        super::sanitize_provider_subprocess_environment(&mut command);

        assert!(
            command
                .as_std()
                .get_envs()
                .any(|(name, value)| { name == "RUST_LOG" && value.is_none() })
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn provider_commands_ignore_appimage_environment() {
        use crate::test_support::appimage_environment::{
            ENVIRONMENT_CASES, assert_child_environment, check_inherited_environment,
        };

        check_inherited_environment(
            "provider::environment::tests::provider_commands_ignore_appimage_environment",
            ENVIRONMENT_CASES,
            |expected| {
                tokio::runtime::Runtime::new().unwrap().block_on(async {
                    let mut command = tokio::process::Command::new("/usr/bin/env");
                    command.arg("-0").kill_on_drop(true);
                    super::sanitize_provider_subprocess_environment(&mut command);
                    let output = tokio::time::timeout(Duration::from_secs(10), command.output())
                        .await
                        .expect("provider probe completed")
                        .expect("provider probe spawned");
                    assert!(output.status.success());
                    assert_child_environment(&output.stdout, expected);

                    // An effective environment must honor explicit removals and
                    // overrides instead of restoring the polluted parent values.
                    let mut command = tokio::process::Command::new("/usr/bin/env");
                    command.arg("-0").kill_on_drop(true);
                    command.env_remove("BIBCODE_TEST_FUTURE_PLUGIN_PATH");
                    command.env("PYTHONHOME", "/host/explicit-python");
                    super::sanitize_provider_subprocess_environment(&mut command);
                    let output = tokio::time::timeout(Duration::from_secs(10), command.output())
                        .await
                        .expect("provider override probe completed")
                        .expect("provider override probe spawned");
                    assert!(output.status.success());
                    let mut overridden = expected.clone();
                    overridden.insert("BIBCODE_TEST_FUTURE_PLUGIN_PATH", None);
                    overridden.insert("PYTHONHOME", Some("/host/explicit-python".into()));
                    assert_child_environment(&output.stdout, &overridden);
                });
            },
        );
    }
}
