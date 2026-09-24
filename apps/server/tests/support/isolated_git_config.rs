//! A throwaway global Git configuration for tests that must not inherit the
//! developer's settings: commit signing is off and hooks resolve to an empty
//! directory.

use std::{fs, path::PathBuf};

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
}
