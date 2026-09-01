//! Git Manager tag reads and mutations.

use std::{collections::BTreeMap, path::Path};

use thiserror::Error;
use tokio_util::sync::CancellationToken;

use crate::git::{GitCommandError, GitRepository, ProcessOutput};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitManagerTag {
    pub name: String,
    pub target_sha: String,
}

#[derive(Debug, Error)]
pub enum GitManagerTagError {
    #[error("the tag name is invalid")]
    InvalidName,
    #[error("the tag does not exist")]
    NotFound,
    #[error("Git returned malformed tag state")]
    Malformed,
    #[error("Git could not complete the tag operation")]
    CommandFailed,
    #[error(transparent)]
    Git(#[from] GitCommandError),
}

pub async fn create_tag(
    repository: &GitRepository,
    cwd: &Path,
    name: &str,
    sha: &str,
    cancellation: &CancellationToken,
) -> Result<ProcessOutput, GitManagerTagError> {
    if !valid_tag_name(name) || !valid_object_id(sha) {
        return Err(GitManagerTagError::InvalidName);
    }
    repository
        .run(
            "GitManager.tags.create",
            cwd,
            &[
                "tag".to_owned(),
                "-a".to_owned(),
                "-m".to_owned(),
                String::new(),
                name.to_owned(),
                sha.to_owned(),
            ],
            cancellation,
        )
        .await
        .map_err(Into::into)
}

pub async fn list_tags(
    repository: &GitRepository,
    cwd: &Path,
    cancellation: &CancellationToken,
) -> Result<Vec<GitManagerTag>, GitManagerTagError> {
    let output = repository
        .git_manager_bounded_read(
            "GitManager.tags.list",
            cwd,
            &["show-ref".to_owned(), "--tags".to_owned(), "-d".to_owned()],
            true,
            4 * 1024 * 1024,
            cancellation,
        )
        .await?;
    if output.exit_code == 1 && output.stdout.is_empty() {
        return Ok(Vec::new());
    }
    if output.exit_code != 0 {
        return Err(GitManagerTagError::CommandFailed);
    }

    let mut tags = BTreeMap::<String, (String, bool)>::new();
    for line in output.stdout.lines().filter(|line| !line.is_empty()) {
        let (target_sha, reference) = line.split_once(' ').ok_or(GitManagerTagError::Malformed)?;
        if !valid_object_id(target_sha) {
            return Err(GitManagerTagError::Malformed);
        }
        let reference = reference
            .strip_prefix("refs/tags/")
            .ok_or(GitManagerTagError::Malformed)?;
        let (name, dereferenced) = reference
            .strip_suffix("^{}")
            .map_or((reference, false), |name| (name, true));
        if !valid_tag_name(name) {
            return Err(GitManagerTagError::Malformed);
        }
        match tags.entry(name.to_owned()) {
            std::collections::btree_map::Entry::Vacant(entry) => {
                entry.insert((target_sha.to_owned(), dereferenced));
            }
            std::collections::btree_map::Entry::Occupied(mut entry)
                if dereferenced && !entry.get().1 =>
            {
                entry.insert((target_sha.to_owned(), true));
            }
            std::collections::btree_map::Entry::Occupied(_) => {}
        }
    }
    Ok(tags
        .into_iter()
        .map(|(name, (target_sha, _))| GitManagerTag { name, target_sha })
        .collect())
}

pub async fn delete_tag(
    repository: &GitRepository,
    cwd: &Path,
    name: &str,
    cancellation: &CancellationToken,
) -> Result<ProcessOutput, GitManagerTagError> {
    if !valid_tag_name(name) {
        return Err(GitManagerTagError::InvalidName);
    }
    if !list_tags(repository, cwd, cancellation)
        .await?
        .iter()
        .any(|tag| tag.name == name)
    {
        return Err(GitManagerTagError::NotFound);
    }
    repository
        .run(
            "GitManager.tags.delete",
            cwd,
            &["tag".to_owned(), "-d".to_owned(), name.to_owned()],
            cancellation,
        )
        .await
        .map_err(Into::into)
}

pub async fn push_tag(
    repository: &GitRepository,
    cwd: &Path,
    remote: &str,
    name: &str,
    cancellation: &CancellationToken,
) -> Result<ProcessOutput, GitManagerTagError> {
    if !valid_tag_name(name)
        || remote.is_empty()
        || remote.trim() != remote
        || remote.starts_with('-')
        || remote.chars().any(char::is_control)
    {
        return Err(GitManagerTagError::InvalidName);
    }
    repository
        .run(
            "GitManager.tags.push",
            cwd,
            &[
                "push".to_owned(),
                remote.to_owned(),
                format!("refs/tags/{name}"),
            ],
            cancellation,
        )
        .await
        .map_err(Into::into)
}

fn valid_object_id(value: &str) -> bool {
    matches!(value.len(), 40 | 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn valid_tag_name(name: &str) -> bool {
    if name.is_empty()
        || name.chars().count() > 245
        || name.trim() != name
        || name.starts_with('-')
        || name.starts_with('/')
        || name.ends_with('/')
        || name.ends_with('.')
        || name.contains("..")
        || name.contains("@{")
        || name == "@"
        || name.bytes().any(|byte| {
            byte <= b' '
                || byte == 0x7f
                || matches!(byte, b'~' | b'^' | b':' | b'?' | b'*' | b'[' | b'\\')
        })
    {
        return false;
    }
    name.split('/').all(|component| {
        !component.is_empty() && !component.starts_with('.') && !component.ends_with(".lock")
    })
}

#[cfg(test)]
mod tests {
    use std::{
        ffi::OsString,
        path::Path,
        sync::{Arc, Mutex},
    };

    use super::*;
    use crate::git::{BoxGitProcessFuture, GitProcessRunner, ProcessRequest};

    struct RecordingGitRunner {
        requests: Mutex<Vec<ProcessRequest>>,
        output: ProcessOutput,
    }

    impl Default for RecordingGitRunner {
        fn default() -> Self {
            Self {
                requests: Mutex::new(Vec::new()),
                output: ProcessOutput {
                    exit_code: 0,
                    stdout: String::new(),
                    stderr: String::new(),
                    stdout_truncated: false,
                    stderr_truncated: false,
                },
            }
        }
    }

    impl RecordingGitRunner {
        fn with_stdout(stdout: impl Into<String>) -> Self {
            Self {
                output: ProcessOutput {
                    stdout: stdout.into(),
                    ..Self::default().output
                },
                ..Self::default()
            }
        }
    }

    impl GitProcessRunner for RecordingGitRunner {
        fn run<'a>(
            &'a self,
            request: ProcessRequest,
            _cancellation: &'a CancellationToken,
        ) -> BoxGitProcessFuture<'a> {
            self.requests
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push(request);
            let output = self.output.clone();
            Box::pin(async move { Ok(output) })
        }
    }

    #[tokio::test]
    async fn creating_an_annotated_tag_uses_the_exact_command_and_mutation_environment() {
        let runner = Arc::new(RecordingGitRunner::default());
        let repository = GitRepository::with_runner_for_test(runner.clone());

        create_tag(
            &repository,
            Path::new("/repo"),
            "release/v1",
            "0123456789abcdef0123456789abcdef01234567",
            &CancellationToken::new(),
        )
        .await
        .expect("tag creation succeeds");

        let requests = runner
            .requests
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        assert_eq!(requests.len(), 1);
        assert_eq!(
            requests[0].args,
            [
                "tag",
                "-a",
                "-m",
                "",
                "release/v1",
                "0123456789abcdef0123456789abcdef01234567",
            ]
            .into_iter()
            .map(OsString::from)
            .collect::<Vec<_>>()
        );
        for (key, value) in [
            ("GIT_TERMINAL_PROMPT", "0"),
            ("GIT_ASKPASS", ""),
            ("SSH_ASKPASS_REQUIRE", "never"),
            ("GIT_CONFIG_NOSYSTEM", "1"),
        ] {
            assert!(
                requests[0]
                    .env
                    .iter()
                    .any(|(actual_key, actual_value)| actual_key == key && actual_value == value),
                "missing mutation environment entry {key}={value}"
            );
        }
        assert!(
            requests[0]
                .env
                .iter()
                .all(|(key, _)| key != "GIT_OPTIONAL_LOCKS")
        );
    }

    #[tokio::test]
    async fn invalid_tag_names_are_rejected_before_a_process_is_spawned() {
        let runner = Arc::new(RecordingGitRunner::default());
        let repository = GitRepository::with_runner_for_test(runner.clone());
        let sha = "0123456789abcdef0123456789abcdef01234567";
        let too_long = "x".repeat(246);

        for name in [
            "-release",
            "bad..name",
            "refs/@{bad",
            "topic.lock",
            &too_long,
        ] {
            assert!(matches!(
                create_tag(
                    &repository,
                    Path::new("/repo"),
                    name,
                    sha,
                    &CancellationToken::new(),
                )
                .await,
                Err(GitManagerTagError::InvalidName)
            ));
        }
        assert!(
            runner
                .requests
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .is_empty()
        );
    }

    #[tokio::test]
    async fn listing_tags_normalizes_annotated_suffixes_and_prefers_the_dereferenced_target() {
        let runner = Arc::new(RecordingGitRunner::with_stdout(concat!(
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa refs/tags/release/v1\n",
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb refs/tags/release/v1^{}\n",
            "cccccccccccccccccccccccccccccccccccccccc refs/tags/lightweight\n",
        )));
        let repository = GitRepository::with_runner_for_test(runner.clone());

        let tags = list_tags(&repository, Path::new("/repo"), &CancellationToken::new())
            .await
            .expect("tag list parses");

        assert_eq!(
            tags,
            [
                GitManagerTag {
                    name: "lightweight".to_owned(),
                    target_sha: "cccccccccccccccccccccccccccccccccccccccc".to_owned(),
                },
                GitManagerTag {
                    name: "release/v1".to_owned(),
                    target_sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".to_owned(),
                },
            ]
        );
        let requests = runner
            .requests
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        assert_eq!(
            requests[0].args,
            ["show-ref", "--tags", "-d"]
                .into_iter()
                .map(OsString::from)
                .collect::<Vec<_>>()
        );
        assert!(
            requests[0]
                .env
                .iter()
                .any(|(key, value)| key == "GIT_OPTIONAL_LOCKS" && value == "0")
        );
    }

    #[tokio::test]
    async fn deleting_an_existing_tag_uses_the_exact_delete_command() {
        let runner = Arc::new(RecordingGitRunner::with_stdout(
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa refs/tags/release/v1\n",
        ));
        let repository = GitRepository::with_runner_for_test(runner.clone());

        delete_tag(
            &repository,
            Path::new("/repo"),
            "release/v1",
            &CancellationToken::new(),
        )
        .await
        .expect("existing tag deletes");

        let requests = runner
            .requests
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        assert_eq!(requests.len(), 2);
        assert_eq!(
            requests[1].args,
            ["tag", "-d", "release/v1"]
                .into_iter()
                .map(OsString::from)
                .collect::<Vec<_>>()
        );
        assert!(
            requests[1]
                .args
                .iter()
                .all(|argument| argument != "--force" && argument != "-f")
        );
    }

    #[tokio::test]
    async fn pushing_a_tag_uses_one_explicit_non_force_refspec() {
        let runner = Arc::new(RecordingGitRunner::default());
        let repository = GitRepository::with_runner_for_test(runner.clone());

        push_tag(
            &repository,
            Path::new("/repo"),
            "origin",
            "release/v1",
            &CancellationToken::new(),
        )
        .await
        .expect("tag push succeeds");

        let requests = runner
            .requests
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        assert_eq!(requests.len(), 1);
        assert_eq!(
            requests[0].args,
            ["push", "origin", "refs/tags/release/v1"]
                .into_iter()
                .map(OsString::from)
                .collect::<Vec<_>>()
        );
        assert!(requests[0].args.iter().all(|argument| {
            argument != "--force" && argument != "-f" && argument != "--force-with-lease"
        }));
    }
}
