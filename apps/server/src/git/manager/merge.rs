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
            detail: first_stderr_line(stderr).map_or_else(
                || format!("merge-tree exited with {exit_code}"),
                str::to_owned,
            ),
        }),
    }
}

/// The first non-empty stderr line; a `--quiet` command can fail without printing any.
pub(super) fn first_stderr_line(stderr: &str) -> Option<&str> {
    stderr.lines().map(str::trim).find(|line| !line.is_empty())
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

#[derive(Debug, Eq, PartialEq)]
pub enum PublishFailure {
    InUse { path: Option<String> },
    Other,
}

/// Recognises Git's own "branch in use by a worktree" refusal (checked out, mid-rebase,
/// bisecting) in the stderr of a failed `git fetch . <commit>:refs/heads/<target>`. The
/// publish runs with `--quiet`, which also hides the "[rejected] ... (non-fast-forward)"
/// line, so a lost race exits 1 with empty stderr and arrives here as `Other`;
/// `merge_into` re-reads the target to tell it apart from a genuine publish failure.
#[must_use]
pub fn classify_publish_failure(stderr: &str) -> PublishFailure {
    if let Some(rest) = stderr.split("checked out at '").nth(1) {
        return PublishFailure::InUse {
            path: rest.split('\'').next().map(str::to_owned),
        };
    }
    if stderr.contains("refusing to fetch into branch") {
        return PublishFailure::InUse { path: None };
    }
    PublishFailure::Other
}

#[must_use]
pub fn merge_into_message(source: &str, target: &str) -> String {
    match source.strip_prefix("refs/remotes/") {
        Some(remote) => format!("Merge remote-tracking branch '{remote}' into {target}"),
        None => format!(
            "Merge branch '{}' into {target}",
            source.strip_prefix("refs/heads/").unwrap_or(source)
        ),
    }
}

#[derive(Debug)]
pub enum MergeIntoError {
    Merge(GitManagerMergeError),
    TargetMissing,
    /// `fetch .` checks occupancy against the alias but writes through it, so a symbolic
    /// target could move a branch that a worktree has checked out.
    TargetIsSymbolic {
        destination: String,
    },
    Conflicts {
        file_count: u64,
    },
    UnrelatedHistories,
    CommitFailed(ProcessOutput),
    TargetMoved,
    InUse {
        path: Option<String>,
    },
    PublishFailed(ProcessOutput),
}

impl From<GitCommandError> for MergeIntoError {
    fn from(error: GitCommandError) -> Self {
        Self::Merge(GitManagerMergeError::Git(error))
    }
}

#[derive(Debug)]
pub struct MergeIntoOutcome {
    pub outputs: Vec<ProcessOutput>,
    pub up_to_date: bool,
}

/// Merges `source` into the local branch `target` without touching any worktree: both
/// tips are resolved once, the merge is computed with `merge-tree`, committed with
/// `commit-tree`, and published by a fast-forward-only `fetch .` so Git itself refuses a
/// branch that any worktree holds. Before the publish only an unreachable commit object
/// exists; no ref, index, or file changes.
pub async fn merge_into(
    repository: &GitRepository,
    cwd: &Path,
    source: &str,
    target: &str,
    cancellation: &CancellationToken,
) -> Result<MergeIntoOutcome, MergeIntoError> {
    // `refs/heads/<target>` below is evaluated by `rev-parse`, so revision syntax such as
    // `main~1` must never reach it.
    if !valid_target_branch(target) {
        return Err(MergeIntoError::Merge(GitManagerMergeError::InvalidTarget));
    }
    let version = ensure_merge_tree_supported(repository, cwd, cancellation)
        .await
        .map_err(MergeIntoError::Merge)?;
    let target_ref = format!("refs/heads/{target}");
    let (target_tip, source_tip, symbolic) = tokio::try_join!(
        repository.git_manager_resolve_merge_tip(cwd, &target_ref, cancellation),
        repository.git_manager_resolve_merge_tip(cwd, source, cancellation),
        repository.git_manager_symbolic_ref(cwd, &target_ref, cancellation),
    )?;
    let target_tip = successful_tip(&target_tip)
        .ok_or(MergeIntoError::TargetMissing)?
        .to_owned();
    if symbolic.exit_code == 0 {
        return Err(MergeIntoError::TargetIsSymbolic {
            destination: symbolic.stdout.trim().to_owned(),
        });
    }
    let source_tip = successful_tip(&source_tip)
        .ok_or(MergeIntoError::Merge(GitManagerMergeError::InvalidSource))?
        .to_owned();
    if repository
        .git_manager_is_ancestor(cwd, &source_tip, &target_tip, cancellation)
        .await?
        .exit_code
        == 0
    {
        return Ok(MergeIntoOutcome {
            outputs: Vec::new(),
            up_to_date: true,
        });
    }
    let attr_source = version
        .is_some_and(|version| version >= GitVersion::MERGE_TREE_ATTR_SOURCE)
        .then_some(target_tip.as_str());
    let merge_tree = repository
        .git_manager_merge_tree(cwd, &target_tip, &source_tip, attr_source, cancellation)
        .await?;
    let tree =
        match classify_merge_tree(merge_tree.exit_code, &merge_tree.stdout, &merge_tree.stderr)
            .map_err(MergeIntoError::Merge)?
        {
            GitManagerMergePreview::Clean => merge_tree_tree_oid(&merge_tree.stdout)
                .ok_or_else(|| {
                    MergeIntoError::Merge(GitManagerMergeError::MergeTreeFailed {
                        detail: "merge-tree printed no tree".to_owned(),
                    })
                })?
                .to_owned(),
            GitManagerMergePreview::Conflicted { file_count } => {
                return Err(MergeIntoError::Conflicts { file_count });
            }
            GitManagerMergePreview::UnrelatedHistories => {
                return Err(MergeIntoError::UnrelatedHistories);
            }
        };
    let signing = repository
        .git_manager_commit_gpg_sign(cwd, cancellation)
        .await?;
    let sign = match signing.exit_code {
        0 => signing.stdout.trim() == "true",
        1 => false,
        _ => return Err(MergeIntoError::CommitFailed(signing)),
    };
    let commit = repository
        .git_manager_commit_tree(
            cwd,
            &tree,
            [&target_tip, &source_tip],
            &merge_into_message(source, target),
            sign,
            cancellation,
        )
        .await?;
    if commit.exit_code != 0 {
        return Err(MergeIntoError::CommitFailed(commit));
    }
    let merge_commit = commit.stdout.trim().to_owned();
    let reread = repository
        .git_manager_resolve_merge_tip(cwd, &target_ref, cancellation)
        .await?;
    if successful_tip(&reread) != Some(target_tip.as_str()) {
        return Err(MergeIntoError::TargetMoved);
    }
    let publish = repository
        .git_manager_publish_merge(cwd, &merge_commit, target, source, cancellation)
        .await?;
    if publish.exit_code != 0 {
        if let PublishFailure::InUse { path } = classify_publish_failure(&publish.stderr) {
            return Err(MergeIntoError::InUse { path });
        }
        // A lost race (non-fast-forward, or "cannot lock ref ... expected") fails the
        // `--quiet` fetch with little or no stderr; only the ref itself says whether it moved.
        let current = repository
            .git_manager_resolve_merge_tip(cwd, &target_ref, cancellation)
            .await?;
        return Err(if successful_tip(&current) == Some(target_tip.as_str()) {
            MergeIntoError::PublishFailed(publish)
        } else {
            MergeIntoError::TargetMoved
        });
    }
    Ok(MergeIntoOutcome {
        outputs: vec![commit, publish],
        up_to_date: false,
    })
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

    #[test]
    fn merge_into_message_names_local_and_remote_sources() {
        assert_eq!(
            merge_into_message("refs/heads/feature", "release"),
            "Merge branch 'feature' into release"
        );
        assert_eq!(
            merge_into_message("refs/remotes/origin/feature", "release"),
            "Merge remote-tracking branch 'origin/feature' into release"
        );
    }

    #[test]
    fn classifies_publish_refusals() {
        assert_eq!(
            classify_publish_failure(
                "fatal: refusing to fetch into branch 'refs/heads/t' checked out at '/w/t'\n"
            ),
            PublishFailure::InUse {
                path: Some("/w/t".into())
            }
        );
        assert_eq!(
            classify_publish_failure("fatal: refusing to fetch into branch 'refs/heads/t'\n"),
            PublishFailure::InUse { path: None }
        );
        // `--quiet` leaves a non-fast-forward rejection with no stderr at all.
        assert_eq!(classify_publish_failure(""), PublishFailure::Other);
        assert_eq!(
            classify_publish_failure(
                "error: cannot lock ref 'refs/heads/t': is at abc but expected def\n"
            ),
            PublishFailure::Other
        );
        assert_eq!(
            classify_publish_failure(
                "fatal: in 'prepared' phase, update aborted by the reference-transaction hook\n"
            ),
            PublishFailure::Other
        );
    }

    /// Fixture Git isolated from the developer's system and global configuration.
    fn fixture_git(cwd: &Path, args: &[&str]) -> std::process::Output {
        std::process::Command::new("git")
            .args(args)
            .current_dir(cwd)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env(
                "GIT_CONFIG_GLOBAL",
                if cfg!(windows) { "NUL" } else { "/dev/null" },
            )
            .env("GIT_AUTHOR_NAME", "Git Manager Test")
            .env("GIT_AUTHOR_EMAIL", "git-manager@example.test")
            .env("GIT_COMMITTER_NAME", "Git Manager Test")
            .env("GIT_COMMITTER_EMAIL", "git-manager@example.test")
            .output()
            .expect("git fixture starts")
    }

    fn git(cwd: &Path, args: &[&str]) {
        let output = fixture_git(cwd, args);
        assert!(
            output.status.success(),
            "git fixture failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    /// Drives the real publish command with a commit that does not descend from the target.
    #[tokio::test]
    async fn a_real_non_fast_forward_publish_exits_one_quietly_and_leaves_the_target() {
        let directory = tempfile::tempdir().expect("fixture directory");
        let cwd = directory.path();
        git(cwd, &["init", "-q", "-b", "main"]);
        git(cwd, &["commit", "-q", "--allow-empty", "-m", "base"]);
        git(cwd, &["switch", "-q", "-c", "release"]);
        git(cwd, &["commit", "-q", "--allow-empty", "-m", "release"]);
        git(cwd, &["switch", "-q", "-c", "rival", "main"]);
        git(cwd, &["commit", "-q", "--allow-empty", "-m", "rival"]);
        git(cwd, &["switch", "-q", "main"]);
        let release_tip = rev_parse(cwd, "release");
        let rival_tip = rev_parse(cwd, "rival");

        let publish = GitRepository::default()
            .git_manager_publish_merge(
                cwd,
                &rival_tip,
                "release",
                "refs/heads/rival",
                &CancellationToken::new(),
            )
            .await
            .expect("publish runs");

        assert_eq!(publish.exit_code, 1, "{publish:?}");
        assert_eq!(publish.stderr.trim(), "");
        assert_eq!(
            classify_publish_failure(&publish.stderr),
            PublishFailure::Other
        );
        assert_eq!(rev_parse(cwd, "release"), release_tip);
    }

    fn rev_parse(cwd: &Path, revision: &str) -> String {
        let output = fixture_git(cwd, &["rev-parse", revision]);
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    }

    #[tokio::test]
    async fn merge_into_refuses_a_revision_expression_target_before_running_git() {
        let (runner, repository) = version_runner("git version 2.55.0\n");
        for target in [
            "release~1",
            "release^",
            "release@{1}",
            "a..b",
            "release^{tree}",
        ] {
            let error = merge_into(
                &repository,
                Path::new("."),
                "refs/heads/feature",
                target,
                &CancellationToken::new(),
            )
            .await
            .expect_err("a revision expression is not a branch name");
            assert!(
                matches!(
                    error,
                    MergeIntoError::Merge(GitManagerMergeError::InvalidTarget)
                ),
                "{target}: {error:?}"
            );
        }
        assert_eq!(runner.calls.load(Ordering::SeqCst), 0);
    }

    const TARGET_TIP: &str = "1111111111111111111111111111111111111111";
    const SOURCE_TIP: &str = "2222222222222222222222222222222222222222";
    const MERGE_COMMIT: &str = "3333333333333333333333333333333333333333";
    const RIVAL_TIP: &str = "4444444444444444444444444444444444444444";

    /// Answers every Git invocation `merge_into` makes with a fixed script. The target ref
    /// reads return `TARGET_TIP` twice (the initial read and the re-read before the publish)
    /// and `after_publish_tip` afterwards; the `--quiet` publish fails with empty stderr.
    struct QuietPublishRunner {
        target_reads: AtomicUsize,
        after_publish_tip: &'static str,
    }

    impl GitProcessRunner for QuietPublishRunner {
        fn run<'a>(
            &'a self,
            request: ProcessRequest,
            _cancellation: &'a CancellationToken,
        ) -> BoxGitProcessFuture<'a> {
            let args = request
                .args
                .iter()
                .map(|argument| argument.to_string_lossy().into_owned())
                .collect::<Vec<_>>();
            let has = |value: &str| args.iter().any(|argument| argument == value);
            let (exit_code, stdout) = if has("--version") {
                (0, "git version 2.55.0\n".to_owned())
            } else if has("refs/heads/release^{commit}") {
                let tip = if self.target_reads.fetch_add(1, Ordering::SeqCst) < 2 {
                    TARGET_TIP
                } else {
                    self.after_publish_tip
                };
                (0, format!("{tip}\n"))
            } else if has("refs/heads/feature^{commit}") {
                (0, format!("{SOURCE_TIP}\n"))
            } else if has("symbolic-ref") || has("merge-base") || has("config") || has("fetch") {
                (1, String::new())
            } else if has("merge-tree") {
                (0, format!("{TREE}\0"))
            } else if has("commit-tree") {
                (0, format!("{MERGE_COMMIT}\n"))
            } else {
                panic!("unexpected Git invocation: {args:?}");
            };
            Box::pin(async move {
                Ok(ProcessOutput {
                    exit_code,
                    stdout,
                    stderr: String::new(),
                    stdout_truncated: false,
                    stderr_truncated: false,
                })
            })
        }
    }

    async fn merge_into_with_a_quietly_failing_publish(
        after_publish_tip: &'static str,
    ) -> MergeIntoError {
        let repository = GitRepository::with_runner_for_test(Arc::new(QuietPublishRunner {
            target_reads: AtomicUsize::new(0),
            after_publish_tip,
        }));
        merge_into(
            &repository,
            Path::new("."),
            "refs/heads/feature",
            "release",
            &CancellationToken::new(),
        )
        .await
        .expect_err("the publish fails")
    }

    #[tokio::test]
    async fn a_quiet_publish_failure_after_the_target_moved_is_a_moved_target() {
        assert!(matches!(
            merge_into_with_a_quietly_failing_publish(RIVAL_TIP).await,
            MergeIntoError::TargetMoved
        ));
    }

    #[tokio::test]
    async fn a_quiet_publish_failure_with_an_unmoved_target_is_a_publish_failure() {
        assert!(matches!(
            merge_into_with_a_quietly_failing_publish(TARGET_TIP).await,
            MergeIntoError::PublishFailed(output) if output.exit_code == 1
        ));
    }
}
