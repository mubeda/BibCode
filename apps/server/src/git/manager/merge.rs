//! Mergeability preview and merge operation primitives.

use std::path::Path;

use thiserror::Error;
use tokio_util::sync::CancellationToken;

use crate::git::{GitCommandError, GitRepository, GitVersion, ProcessOutput};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GitManagerMergePreview {
    Clean,
    Conflicted { file_count: u64 },
    UnrelatedHistories,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitManagerMergePreviewResult {
    pub preview: GitManagerMergePreview,
    pub source: String,
    pub current: String,
    pub ahead: u64,
    pub behind: u64,
}

#[derive(Debug, Error)]
pub enum GitManagerMergeError {
    #[error("the merge source is invalid")]
    InvalidSource,
    #[error("the merge target is invalid")]
    InvalidTarget,
    #[error("the current HEAD is unavailable")]
    CurrentUnavailable,
    #[error("Git returned malformed merge comparison state")]
    MalformedComparison,
    #[error("Git {found} cannot compute merges without a checkout")]
    GitTooOld { found: GitVersion },
    /// First non-empty stderr line, shown to the user so the failure can be diagnosed.
    #[error("git merge-tree failed: {detail}")]
    MergeTreeFailed { detail: String },
    #[error(transparent)]
    Git(#[from] GitCommandError),
}

/// The first `-z` record of `merge-tree --write-tree` output, when it is an object id.
#[must_use]
pub fn merge_tree_tree_oid(stdout: &str) -> Option<&str> {
    let first = stdout.split(['\0', '\n']).next()?.trim();
    (matches!(first.len(), 40 | 64) && first.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .then_some(first)
}

/// Exit 1 means conflicts only when Git still printed the merged tree; an unknown ref
/// also exits 1. Only Git's own refusal is reported as unrelated histories.
pub fn classify_merge_tree(
    exit_code: i32,
    stdout: &str,
    stderr: &str,
) -> Result<GitManagerMergePreview, GitManagerMergeError> {
    match exit_code {
        0 if merge_tree_tree_oid(stdout).is_some() => Ok(GitManagerMergePreview::Clean),
        1 if merge_tree_tree_oid(stdout).is_some() => Ok(GitManagerMergePreview::Conflicted {
            file_count: stdout.matches('\0').count().saturating_sub(1) as u64,
        }),
        128 if stderr.contains("refusing to merge unrelated histories") => {
            Ok(GitManagerMergePreview::UnrelatedHistories)
        }
        _ => Err(GitManagerMergeError::MergeTreeFailed {
            detail: stderr
                .lines()
                .map(str::trim)
                .find(|line| !line.is_empty())
                .map_or_else(
                    || format!("merge-tree exited with {exit_code}"),
                    str::to_owned,
                ),
        }),
    }
}

/// Fails with `GitTooOld` below 2.38; an unparseable version is allowed through and the
/// merge-tree classifier reports any failure.
pub async fn ensure_merge_tree_supported(
    repository: &GitRepository,
    cwd: &Path,
    cancellation: &CancellationToken,
) -> Result<Option<GitVersion>, GitManagerMergeError> {
    let version = repository
        .git_manager_git_version(cwd, cancellation)
        .await?;
    match version {
        Some(found) if found < GitVersion::MERGE_TREE_WRITE => {
            Err(GitManagerMergeError::GitTooOld { found })
        }
        _ => Ok(version),
    }
}

fn valid_revision(value: &str) -> bool {
    !value.is_empty() && value.trim() == value && !value.starts_with('-')
}

/// A target names one local branch. Git refuses the revision syntax below inside a ref
/// name, but `rev-parse` evaluates it after `refs/heads/` (`main~1` is main's parent).
fn valid_target_branch(name: &str) -> bool {
    valid_revision(name)
        && !name.contains("@{")
        && !name.contains("..")
        && !name.chars().any(|character| {
            character.is_control()
                || matches!(character, ' ' | '~' | '^' | ':' | '?' | '*' | '[' | '\\')
        })
}

pub async fn preview(
    repository: &GitRepository,
    cwd: &Path,
    source: &str,
    target: Option<&str>,
    cancellation: &CancellationToken,
) -> Result<GitManagerMergePreviewResult, GitManagerMergeError> {
    if !valid_revision(source) {
        return Err(GitManagerMergeError::InvalidSource);
    }
    if target.is_some_and(|target| !valid_target_branch(target)) {
        return Err(GitManagerMergeError::InvalidTarget);
    }
    let version = ensure_merge_tree_supported(repository, cwd, cancellation).await?;
    // A tag named like the branch must not shadow the target.
    let ours_revision =
        target.map_or_else(|| "HEAD".to_owned(), |name| format!("refs/heads/{name}"));
    let (ours, theirs, current_ref) = tokio::try_join!(
        repository.git_manager_resolve_merge_tip(cwd, &ours_revision, cancellation),
        repository.git_manager_resolve_merge_tip(cwd, source, cancellation),
        repository.git_manager_head_ref(cwd, cancellation),
    )?;
    let ours_tip = successful_tip(&ours).ok_or(if target.is_some() {
        GitManagerMergeError::InvalidTarget
    } else {
        GitManagerMergeError::CurrentUnavailable
    })?;
    let theirs_tip = successful_tip(&theirs).ok_or(GitManagerMergeError::InvalidSource)?;
    let attr_source = (target.is_some()
        && version.is_some_and(|version| version >= GitVersion::MERGE_TREE_ATTR_SOURCE))
    .then_some(ours_tip);
    let (merge_tree, counts) = tokio::try_join!(
        repository.git_manager_merge_tree(cwd, ours_tip, theirs_tip, attr_source, cancellation),
        repository.git_manager_merge_ahead_behind(cwd, ours_tip, theirs_tip, cancellation),
    )?;
    let (behind, ahead) = parse_ahead_behind(&counts.stdout)?;
    let current = match target {
        Some(name) => name.to_owned(),
        None => (current_ref.exit_code == 0)
            .then(|| current_ref.stdout.trim().to_owned())
            .filter(|current| !current.is_empty())
            .unwrap_or_else(|| ours_tip.to_owned()),
    };
    Ok(GitManagerMergePreviewResult {
        preview: classify_merge_tree(merge_tree.exit_code, &merge_tree.stdout, &merge_tree.stderr)?,
        source: source.to_owned(),
        current,
        ahead,
        behind,
    })
}

pub async fn merge(
    repository: &GitRepository,
    cwd: &Path,
    source: &str,
    no_verify: bool,
    cancellation: &CancellationToken,
) -> Result<Vec<ProcessOutput>, GitCommandError> {
    repository
        .git_manager_merge(cwd, source, no_verify, false, cancellation)
        .await
        .map(|output| vec![output])
}

pub async fn squash_merge(
    repository: &GitRepository,
    cwd: &Path,
    source: &str,
    no_verify: bool,
    cancellation: &CancellationToken,
) -> Result<Vec<ProcessOutput>, GitCommandError> {
    let merge = repository
        .git_manager_merge(cwd, source, no_verify, true, cancellation)
        .await?;
    if merge.exit_code != 0 || is_already_up_to_date(&merge) {
        return Ok(vec![merge]);
    }
    let commit = repository
        .git_manager_squash_merge_commit(cwd, no_verify, cancellation)
        .await?;
    Ok(vec![merge, commit])
}

#[must_use]
pub fn is_already_up_to_date(output: &ProcessOutput) -> bool {
    output.stdout.trim() == "Already up to date."
}

fn successful_tip(output: &ProcessOutput) -> Option<&str> {
    (output.exit_code == 0)
        .then(|| output.stdout.trim())
        .filter(|tip| !tip.is_empty())
}

fn parse_ahead_behind(stdout: &str) -> Result<(u64, u64), GitManagerMergeError> {
    let mut fields = stdout.split_whitespace();
    let left = fields
        .next()
        .and_then(|value| value.parse().ok())
        .ok_or(GitManagerMergeError::MalformedComparison)?;
    let right = fields
        .next()
        .and_then(|value| value.parse().ok())
        .ok_or(GitManagerMergeError::MalformedComparison)?;
    if fields.next().is_some() {
        return Err(GitManagerMergeError::MalformedComparison);
    }
    Ok((left, right))
}

#[cfg(test)]
mod tests {
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    use super::*;
    use crate::git::{BoxGitProcessFuture, GitProcessRunner, ProcessRequest};

    /// Answers every Git invocation with a fixed `git --version` line and counts the calls.
    struct VersionRunner {
        stdout: &'static str,
        calls: AtomicUsize,
    }

    impl GitProcessRunner for VersionRunner {
        fn run<'a>(
            &'a self,
            _request: ProcessRequest,
            _cancellation: &'a CancellationToken,
        ) -> BoxGitProcessFuture<'a> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let stdout = self.stdout.to_owned();
            Box::pin(async move {
                Ok(ProcessOutput {
                    exit_code: 0,
                    stdout,
                    stderr: String::new(),
                    stdout_truncated: false,
                    stderr_truncated: false,
                })
            })
        }
    }

    fn version_runner(stdout: &'static str) -> (Arc<VersionRunner>, GitRepository) {
        let runner = Arc::new(VersionRunner {
            stdout,
            calls: AtomicUsize::new(0),
        });
        let repository = GitRepository::with_runner_for_test(runner.clone());
        (runner, repository)
    }

    #[tokio::test]
    async fn git_older_than_2_38_cannot_compute_merges() {
        let (_, repository) = version_runner("git version 2.34.1\n");
        let error =
            ensure_merge_tree_supported(&repository, Path::new("."), &CancellationToken::new())
                .await
                .expect_err("2.34.1 is too old");
        assert!(matches!(
            error,
            GitManagerMergeError::GitTooOld { found }
                if found == (GitVersion { major: 2, minor: 34, patch: 1 })
        ));
    }

    #[tokio::test]
    async fn supported_versions_are_read_once_per_repository() {
        let (runner, repository) = version_runner("git version 2.38.0\n");
        let cancellation = CancellationToken::new();
        for _ in 0..2 {
            assert_eq!(
                ensure_merge_tree_supported(&repository, Path::new("."), &cancellation)
                    .await
                    .expect("2.38 is supported"),
                Some(GitVersion::MERGE_TREE_WRITE)
            );
        }
        assert_eq!(runner.calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn an_unparseable_version_is_allowed_through_and_not_cached() {
        let (runner, repository) = version_runner("not a git version\n");
        let cancellation = CancellationToken::new();
        for _ in 0..2 {
            assert_eq!(
                ensure_merge_tree_supported(&repository, Path::new("."), &cancellation)
                    .await
                    .expect("unparseable versions defer to the classifier"),
                None
            );
        }
        assert_eq!(runner.calls.load(Ordering::SeqCst), 2);
    }

    const TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

    #[test]
    fn a_target_is_a_literal_branch_name() {
        for name in ["main", "feature/x", "release-1.2", "user@host", "a.b"] {
            assert!(valid_target_branch(name), "{name}");
        }
        for name in [
            "",
            " main",
            "-main",
            "main~1",
            "main^",
            "main^{tree}",
            "main@{1}",
            "main@{-1}",
            "main:path",
            "a..b",
            "a b",
            "a\tb",
            "a?b",
            "a*b",
            "a[b",
            "a\\b",
        ] {
            assert!(!valid_target_branch(name), "{name:?}");
        }
    }

    #[test]
    fn classifies_a_clean_merge_tree() {
        assert_eq!(
            classify_merge_tree(0, &format!("{TREE}\0"), "").expect("clean"),
            GitManagerMergePreview::Clean
        );
        assert_eq!(merge_tree_tree_oid(&format!("{TREE}\0")), Some(TREE));
    }

    #[test]
    fn counts_conflicted_files_after_the_tree_record() {
        assert_eq!(
            classify_merge_tree(1, &format!("{TREE}\0first.txt\0second.txt\0"), "")
                .expect("conflicted"),
            GitManagerMergePreview::Conflicted { file_count: 2 }
        );
    }

    #[test]
    fn exit_one_without_a_tree_is_a_failure_not_a_conflict() {
        assert!(matches!(
            classify_merge_tree(1, "", "fatal: unknown ref"),
            Err(GitManagerMergeError::MergeTreeFailed { detail }) if detail == "fatal: unknown ref"
        ));
    }

    #[test]
    fn only_gits_unrelated_histories_refusal_is_unrelated() {
        assert_eq!(
            classify_merge_tree(128, "", "fatal: refusing to merge unrelated histories\n")
                .expect("unrelated"),
            GitManagerMergePreview::UnrelatedHistories
        );
        assert!(matches!(
            classify_merge_tree(129, "", "usage: git merge-tree [--write-tree]"),
            Err(GitManagerMergeError::MergeTreeFailed { .. })
        ));
    }
}
