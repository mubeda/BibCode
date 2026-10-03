use std::{
    collections::BTreeMap,
    ffi::{OsStr, OsString},
    path::PathBuf,
    process::Command,
};

/// Explicit configuration for the private recovery-test child boundary.
/// Stdio and Unix group ownership belong to the helper, never the caller.
pub(super) struct ChildCommandSpec {
    pub(super) program: OsString,
    pub(super) args: Vec<OsString>,
    pub(super) current_dir: Option<PathBuf>,
    pub(super) inherit_environment: bool,
    pub(super) env: BTreeMap<OsString, Option<OsString>>,
}

impl ChildCommandSpec {
    pub(super) fn new(program: impl AsRef<OsStr>) -> Self {
        Self {
            program: program.as_ref().to_owned(),
            args: Vec::new(),
            current_dir: None,
            inherit_environment: true,
            env: BTreeMap::new(),
        }
    }

    #[cfg(unix)]
    pub(super) fn arg(&mut self, arg: impl AsRef<OsStr>) -> &mut Self {
        self.args.push(arg.as_ref().to_owned());
        self
    }

    pub(super) fn args<I, S>(&mut self, args: I) -> &mut Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        self.args
            .extend(args.into_iter().map(|arg| arg.as_ref().to_owned()));
        self
    }

    pub(super) fn env(&mut self, key: impl AsRef<OsStr>, value: impl AsRef<OsStr>) -> &mut Self {
        self.env
            .insert(key.as_ref().to_owned(), Some(value.as_ref().to_owned()));
        self
    }

    #[cfg(unix)]
    pub(super) fn env_remove(&mut self, key: impl AsRef<OsStr>) -> &mut Self {
        self.env.insert(key.as_ref().to_owned(), None);
        self
    }

    #[cfg(unix)]
    pub(super) fn env_clear(&mut self) -> &mut Self {
        self.inherit_environment = false;
        self.env.clear();
        self
    }

    #[cfg(unix)]
    pub(super) fn current_dir(&mut self, path: impl Into<PathBuf>) -> &mut Self {
        self.current_dir = Some(path.into());
        self
    }

    pub(super) fn command(&self) -> Command {
        let mut command = Command::new(&self.program);
        command.args(&self.args);
        if !self.inherit_environment {
            command.env_clear();
        }
        for (key, value) in &self.env {
            if let Some(value) = value {
                command.env(key, value);
            } else {
                command.env_remove(key);
            }
        }
        if let Some(path) = &self.current_dir {
            command.current_dir(path);
        }
        command
    }
}
