//! A throwaway global Git configuration for tests that must not inherit the
//! developer's settings or discovery environment: commit signing is off,
//! hooks resolve to an empty directory, and inherited Git variables are removed.

use std::{ffi::OsStr, fs, path::PathBuf, process::Command};

pub fn is_git_environment_variable(name: &OsStr) -> bool {
    name.as_encoded_bytes()
        .get(..4)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case(b"GIT_"))
}

pub struct IsolatedGitConfig {
    directory: tempfile::TempDir,
}

impl IsolatedGitConfig {
    pub fn new() -> Self {
        let directory = tempfile::tempdir().expect("isolated Git config fixture");
        let hooks = directory.path().join("hooks");
        fs::create_dir(&hooks).expect("isolated hooks directory");
        let config = Self { directory };
        fs::write(
            config.path(),
            format!(
                "[commit]\n\tgpgSign = false\n[core]\n\thooksPath = {}\n",
                hooks.to_string_lossy().replace('\\', "/")
            ),
        )
        .expect("isolated global config");
        config
    }

    /// The file to pass as `GIT_CONFIG_GLOBAL`.
    pub fn path(&self) -> PathBuf {
        self.directory.path().join("global.gitconfig")
    }

    /// Remove inherited discovery/configuration before setting fixture overrides.
    pub fn apply_to_command(&self, command: &mut Command) {
        for (name, _) in std::env::vars_os() {
            if is_git_environment_variable(&name) {
                command.env_remove(name);
            }
        }
        command
            .env("GIT_CONFIG_GLOBAL", self.path())
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_TERMINAL_PROMPT", "0");
    }
}
