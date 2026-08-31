//! Git Manager ref and worktree snapshot construction.

use std::{
    collections::HashMap,
    io,
    path::{Path, PathBuf},
};

use serde::Serialize;
use thiserror::Error;
use tokio::io::AsyncReadExt;
use tokio_util::sync::CancellationToken;

use crate::git::{
    GitCommandError, GitRepository, GitWorktreeRecord, WorktreeParseError, parse_worktree_porcelain,
};

use super::generation::{
    RepositoryHeadState, RepositoryStateObservation, observe_repository_state,
};

const ZERO_SHA: &str = "0000000000000000000000000000000000000000";

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitManagerWorktreeEntry {
    pub path: String,
    pub head_sha: String,
    pub branch: Option<String>,
    pub is_primary: bool,
    pub is_bare: bool,
    pub is_detached: bool,
    pub locked: bool,
    pub lock_reason: Option<String>,
    pub prunable: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitManagerRefEntry {
    pub name: String,
    pub tip_sha: String,
    pub upstream: Option<String>,
    pub ahead: u64,
    pub behind: u64,
    pub current: bool,
    pub is_default: bool,
    pub worktree_path: Option<String>,
    pub blocked: Vec<GitManagerBlockedReason>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct GitManagerBlockedReason {
    pub operation: String,
    pub code: String,
    pub message: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum GitManagerInProgressKind {
    Merge,
    Rebase,
    CherryPick,
    Revert,
    Squash,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitManagerInProgressOperation {
    pub kind: GitManagerInProgressKind,
    pub current: Option<u64>,
    pub total: Option<u64>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitManagerRefsSnapshot {
    pub generation: u64,
    pub head_ref: Option<String>,
    pub detached_sha: Option<String>,
    pub is_dirty: bool,
    pub default_branch: Option<String>,
    pub remotes: Vec<String>,
    pub local_branches: Vec<GitManagerRefEntry>,
    pub remote_branches: Vec<GitManagerRefEntry>,
    pub tags: Vec<GitManagerRefEntry>,
    pub worktrees: Vec<GitManagerWorktreeEntry>,
    pub in_progress_operation: Option<GitManagerInProgressOperation>,
    pub conflicted_paths: Vec<String>,
}

#[derive(Debug, Error)]
pub enum GitManagerRefsError {
    #[error("Git returned malformed ref state")]
    MalformedRefs,
    #[error("Git repository state could not be inspected")]
    RepositoryState(#[source] io::Error),
    #[error(transparent)]
    Worktrees(#[from] WorktreeParseError),
    #[error(transparent)]
    Git(#[from] GitCommandError),
}

#[derive(Clone, Debug)]
struct RawRef {
    name: String,
    tip_sha: String,
    upstream: Option<String>,
    worktree_path: Option<String>,
    current: bool,
}

pub async fn build_refs_snapshot(
    repository: &GitRepository,
    cwd: &Path,
    cancellation: &CancellationToken,
) -> Result<GitManagerRefsSnapshot, GitManagerRefsError> {
    let (refs, tag_names, worktrees, head_ref, status, conflicts, remotes, git_dir) = tokio::try_join!(
        repository.git_manager_refs(cwd, cancellation),
        repository.git_manager_tag_names(cwd, cancellation),
        repository.git_manager_worktrees(cwd, cancellation),
        repository.git_manager_head_ref(cwd, cancellation),
        repository.git_manager_status(cwd, cancellation),
        repository.git_manager_conflicted_paths(cwd, cancellation),
        repository.git_manager_remotes(cwd, cancellation),
        repository.git_manager_git_dir(cwd, cancellation),
    )?;

    let worktree_records = parse_worktree_porcelain(&worktrees.stdout, false)?;
    let worktree_occupancy = worktree_records
        .iter()
        .filter_map(|record| {
            record
                .branch
                .as_ref()
                .map(|branch| (branch.clone(), display_path(&record.path)))
        })
        .collect::<HashMap<_, _>>();
    let raw_refs = parse_refs(&refs.stdout)?;
    let tag_counts = tag_names
        .stdout
        .lines()
        .filter(|name| !name.is_empty())
        .fold(HashMap::<String, usize>::new(), |mut counts, name| {
            *counts.entry(name.to_owned()).or_default() += 1;
            counts
        });
    let mut remaining_counts =
        raw_refs
            .iter()
            .fold(HashMap::<String, usize>::new(), |mut counts, reference| {
                *counts.entry(reference.name.clone()).or_default() += 1;
                counts
            });
    let mut remaining_tags = tag_counts;

    let head_ref_value = (head_ref.exit_code == 0)
        .then(|| head_ref.stdout.trim().to_owned())
        .filter(|value| !value.is_empty());
    let detached_sha = if head_ref_value.is_none() {
        let output = repository.git_manager_head_sha(cwd, cancellation).await?;
        (output.exit_code == 0)
            .then(|| output.stdout.trim().to_owned())
            .filter(|value| !value.is_empty())
    } else {
        None
    };
    let default_branch = repository
        .git_manager_default_ref(cwd, head_ref_value.as_deref(), cancellation)
        .await?;
    let head_state = match (&head_ref_value, &detached_sha) {
        (Some(head_ref), _) => RepositoryHeadState::Symbolic(head_ref.clone()),
        (None, Some(detached_sha)) => RepositoryHeadState::Detached(detached_sha.clone()),
        (None, None) => RepositoryHeadState::Missing,
    };
    let state_observation = RepositoryStateObservation::from_tip_shas(
        raw_refs.iter().map(|reference| reference.tip_sha.as_str()),
    )
    .with_head(head_state);
    let remote_names = remotes
        .stdout
        .lines()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
        .collect::<Vec<_>>();

    let mut local_branches = Vec::new();
    let mut remote_branches = Vec::new();
    let mut tags = Vec::new();
    for mut reference in raw_refs {
        let remaining = remaining_counts
            .get_mut(&reference.name)
            .ok_or(GitManagerRefsError::MalformedRefs)?;
        let tags_left = remaining_tags.get(&reference.name).copied().unwrap_or(0);
        let is_tag = tags_left != 0 && *remaining <= tags_left;
        *remaining = remaining.saturating_sub(1);
        if is_tag && let Some(count) = remaining_tags.get_mut(&reference.name) {
            *count = count.saturating_sub(1);
        }
        let is_remote = !is_tag
            && remote_names
                .iter()
                .any(|remote| reference.name.starts_with(&format!("{remote}/")));
        if !is_tag && !is_remote && reference.worktree_path.is_none() {
            reference.worktree_path = worktree_occupancy.get(&reference.name).cloned();
        }
        let is_default =
            !is_tag && !is_remote && default_branch.as_deref() == Some(reference.name.as_str());
        let mut entry = GitManagerRefEntry {
            name: reference.name,
            tip_sha: reference.tip_sha,
            upstream: (!is_tag && !is_remote)
                .then_some(reference.upstream)
                .flatten(),
            ahead: 0,
            behind: 0,
            current: !is_tag && !is_remote && reference.current,
            is_default,
            worktree_path: (!is_tag && !is_remote)
                .then_some(reference.worktree_path)
                .flatten(),
            blocked: Vec::new(),
        };
        if let Some(upstream) = entry.upstream.as_deref() {
            let counts = repository
                .git_manager_ahead_behind(cwd, &entry.name, upstream, cancellation)
                .await?;
            let (ahead, behind) = parse_ahead_behind(&counts.stdout)?;
            entry.ahead = ahead;
            entry.behind = behind;
        }
        if is_tag {
            tags.push(entry);
        } else if is_remote {
            if !entry.name.ends_with("/HEAD") {
                remote_branches.push(entry);
            }
        } else {
            local_branches.push(entry);
        }
    }
    local_branches.sort_by(|left, right| left.name.cmp(&right.name));
    remote_branches.sort_by(|left, right| left.name.cmp(&right.name));
    tags.sort_by(|left, right| left.name.cmp(&right.name));

    let git_dir = resolve_git_dir(cwd, git_dir.stdout.trim())?;
    let in_progress_operation = probe_in_progress_operation(&git_dir).await?;
    let generation = observe_repository_state(cwd, state_observation).await;
    Ok(GitManagerRefsSnapshot {
        generation,
        head_ref: head_ref_value,
        detached_sha,
        is_dirty: !status.stdout.is_empty(),
        default_branch,
        remotes: remote_names,
        local_branches,
        remote_branches,
        tags,
        worktrees: worktree_records
            .iter()
            .map(worktree_entry)
            .collect::<Vec<_>>(),
        in_progress_operation,
        conflicted_paths: conflicts
            .stdout
            .split('\0')
            .filter(|path| !path.is_empty())
            .map(str::to_owned)
            .collect(),
    })
}

fn parse_refs(output: &str) -> Result<Vec<RawRef>, GitManagerRefsError> {
    output
        .lines()
        .map(|line| {
            let fields = line.split('\t').collect::<Vec<_>>();
            let [name, tip_sha, upstream, worktree_path, head] = fields.as_slice() else {
                return Err(GitManagerRefsError::MalformedRefs);
            };
            if name.is_empty() || !valid_object_id(tip_sha) {
                return Err(GitManagerRefsError::MalformedRefs);
            }
            Ok(RawRef {
                name: (*name).to_owned(),
                tip_sha: (*tip_sha).to_owned(),
                upstream: (!upstream.is_empty()).then(|| (*upstream).to_owned()),
                worktree_path: (!worktree_path.is_empty())
                    .then(|| display_path(Path::new(worktree_path))),
                current: head.trim() == "*",
            })
        })
        .collect()
}

fn parse_ahead_behind(output: &str) -> Result<(u64, u64), GitManagerRefsError> {
    let mut fields = output.split_whitespace();
    let ahead = fields
        .next()
        .and_then(|value| value.parse().ok())
        .ok_or(GitManagerRefsError::MalformedRefs)?;
    let behind = fields
        .next()
        .and_then(|value| value.parse().ok())
        .ok_or(GitManagerRefsError::MalformedRefs)?;
    if fields.next().is_some() {
        return Err(GitManagerRefsError::MalformedRefs);
    }
    Ok((ahead, behind))
}

fn worktree_entry(record: &GitWorktreeRecord) -> GitManagerWorktreeEntry {
    let head_sha = record.head.clone().unwrap_or_else(|| ZERO_SHA.to_owned());
    GitManagerWorktreeEntry {
        path: display_path(&record.path),
        head_sha: head_sha.clone(),
        branch: record.branch.clone(),
        is_primary: record.is_primary,
        is_bare: record.is_bare,
        is_detached: !record.is_bare
            && record.branch.is_none()
            && head_sha != ZERO_SHA
            && valid_object_id(&head_sha),
        locked: record.locked,
        lock_reason: record.lock_reason.clone(),
        prunable: record.is_prunable,
    }
}

async fn probe_in_progress_operation(
    git_dir: &Path,
) -> Result<Option<GitManagerInProgressOperation>, GitManagerRefsError> {
    let rebase = git_dir.join("rebase-merge");
    if path_exists(&rebase).await? {
        return Ok(Some(GitManagerInProgressOperation {
            kind: GitManagerInProgressKind::Rebase,
            current: read_counter(&rebase.join("msgnum")).await?,
            total: read_counter(&rebase.join("end")).await?,
        }));
    }
    if path_exists(&git_dir.join("MERGE_HEAD")).await? {
        return Ok(Some(operation(GitManagerInProgressKind::Merge)));
    }
    if path_exists(&git_dir.join("CHERRY_PICK_HEAD")).await? {
        return Ok(Some(operation(GitManagerInProgressKind::CherryPick)));
    }
    if path_exists(&git_dir.join("REVERT_HEAD")).await? {
        return Ok(Some(operation(GitManagerInProgressKind::Revert)));
    }
    let sequencer_todo = git_dir.join("sequencer").join("todo");
    if path_exists(&sequencer_todo).await? {
        let todo = read_bounded(&sequencer_todo).await?;
        let kind = if todo.lines().any(|line| line.starts_with("revert ")) {
            GitManagerInProgressKind::Revert
        } else {
            GitManagerInProgressKind::CherryPick
        };
        let total = todo
            .lines()
            .filter(|line| !line.trim().is_empty() && !line.starts_with('#'))
            .count() as u64;
        return Ok(Some(GitManagerInProgressOperation {
            kind,
            current: None,
            total: Some(total),
        }));
    }
    if path_exists(&git_dir.join("SQUASH_MSG")).await? {
        return Ok(Some(operation(GitManagerInProgressKind::Squash)));
    }
    Ok(None)
}

fn operation(kind: GitManagerInProgressKind) -> GitManagerInProgressOperation {
    GitManagerInProgressOperation {
        kind,
        current: None,
        total: None,
    }
}

async fn read_counter(path: &Path) -> Result<Option<u64>, GitManagerRefsError> {
    if !path_exists(path).await? {
        return Ok(None);
    }
    Ok(read_bounded(path).await?.trim().parse().ok())
}

async fn read_bounded(path: &Path) -> Result<String, GitManagerRefsError> {
    let file = tokio::fs::File::open(path)
        .await
        .map_err(GitManagerRefsError::RepositoryState)?;
    let mut value = String::new();
    file.take(64 * 1024)
        .read_to_string(&mut value)
        .await
        .map_err(GitManagerRefsError::RepositoryState)?;
    Ok(value)
}

async fn path_exists(path: &Path) -> Result<bool, GitManagerRefsError> {
    match tokio::fs::metadata(path).await {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(GitManagerRefsError::RepositoryState(error)),
    }
}

fn resolve_git_dir(cwd: &Path, value: &str) -> Result<PathBuf, GitManagerRefsError> {
    if value.is_empty() {
        return Err(GitManagerRefsError::MalformedRefs);
    }
    let path = PathBuf::from(value);
    Ok(if path.is_absolute() {
        path
    } else {
        cwd.join(path)
    })
}

fn valid_object_id(value: &str) -> bool {
    matches!(value.len(), 40 | 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn display_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::Path,
        process::{Command, Output},
    };

    use tempfile::TempDir;
    use tokio_util::sync::CancellationToken;

    use super::*;
    use crate::git::GitRepository;

    fn git_output(cwd: &Path, args: &[&str]) -> Output {
        Command::new("git")
            .args(args)
            .current_dir(cwd)
            .output()
            .expect("git test fixture starts")
    }

    fn git(cwd: &Path, args: &[&str]) {
        let output = git_output(cwd, args);
        assert!(
            output.status.success(),
            "git fixture command failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn repository_with_one_commit() -> TempDir {
        let repository = TempDir::new().expect("temporary repository");
        git(repository.path(), &["init", "-q", "-b", "main"]);
        git(
            repository.path(),
            &["config", "user.name", "Git Manager Test"],
        );
        git(
            repository.path(),
            &["config", "user.email", "git-manager@example.test"],
        );
        fs::write(repository.path().join("tracked.txt"), "base\n").expect("fixture file");
        git(repository.path(), &["add", "tracked.txt"]);
        git(repository.path(), &["commit", "-q", "-m", "base"]);
        repository
    }

    async fn snapshot(repository: &TempDir) -> GitManagerRefsSnapshot {
        build_refs_snapshot(
            &GitRepository::default(),
            repository.path(),
            &CancellationToken::new(),
        )
        .await
        .expect("refs snapshot")
    }

    #[tokio::test]
    async fn occupied_branch_reports_its_worktree_path() {
        let repository = repository_with_one_commit();
        let worktree = repository.path().join("linked");
        git(
            repository.path(),
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "feature",
                worktree.to_str().expect("UTF-8 fixture path"),
            ],
        );

        let snapshot = snapshot(&repository).await;
        let branch = snapshot
            .local_branches
            .iter()
            .find(|branch| branch.name == "feature")
            .expect("feature branch");
        assert_eq!(
            branch.worktree_path.as_deref(),
            Some(worktree.to_str().expect("UTF-8 fixture path"))
        );
    }

    #[tokio::test]
    async fn registered_but_missing_worktree_still_occupies_its_branch() {
        let repository = repository_with_one_commit();
        let worktree = repository.path().join("linked");
        git(
            repository.path(),
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "feature",
                worktree.to_str().expect("UTF-8 fixture path"),
            ],
        );
        fs::remove_dir_all(&worktree).expect("remove temporary linked worktree");

        let snapshot = snapshot(&repository).await;
        let branch = snapshot
            .local_branches
            .iter()
            .find(|branch| branch.name == "feature")
            .expect("feature branch");
        assert_eq!(
            branch.worktree_path.as_deref(),
            Some(worktree.to_str().expect("UTF-8 fixture path"))
        );
        assert!(
            snapshot
                .worktrees
                .iter()
                .any(|entry| entry.path == worktree.to_string_lossy() && entry.prunable)
        );
    }

    #[tokio::test]
    async fn detached_head_sets_sha_without_a_head_ref() {
        let repository = repository_with_one_commit();
        git(repository.path(), &["checkout", "-q", "--detach"]);
        let expected =
            String::from_utf8(git_output(repository.path(), &["rev-parse", "HEAD"]).stdout)
                .expect("UTF-8 sha")
                .trim()
                .to_owned();

        let snapshot = snapshot(&repository).await;
        assert_eq!(snapshot.head_ref, None);
        assert_eq!(snapshot.detached_sha.as_deref(), Some(expected.as_str()));
    }

    #[tokio::test]
    async fn merge_in_progress_and_conflicted_path_are_reported() {
        let repository = repository_with_one_commit();
        git(repository.path(), &["checkout", "-q", "-b", "feature"]);
        fs::write(repository.path().join("tracked.txt"), "feature\n").expect("feature content");
        git(repository.path(), &["commit", "-qam", "feature"]);
        git(repository.path(), &["checkout", "-q", "main"]);
        fs::write(repository.path().join("tracked.txt"), "main\n").expect("main content");
        git(repository.path(), &["commit", "-qam", "main"]);
        assert!(
            !git_output(repository.path(), &["merge", "feature"])
                .status
                .success()
        );

        let snapshot = snapshot(&repository).await;
        assert_eq!(
            snapshot
                .in_progress_operation
                .as_ref()
                .map(|operation| operation.kind),
            Some(GitManagerInProgressKind::Merge)
        );
        assert_eq!(snapshot.conflicted_paths, vec!["tracked.txt"]);
    }
}
