//! Repository-state probes for externally started Git operations.

use std::{
    io,
    path::{Path, PathBuf},
};

use thiserror::Error;
use tokio::io::AsyncReadExt;
use tokio_util::sync::CancellationToken;

use crate::git::{
    GitCommandError, GitManagerInProgressKind, GitManagerInProgressOperation, GitRepository,
};

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct ProbeResults {
    pub merge_head: bool,
    pub cherry_pick_head: bool,
    pub revert_head: bool,
    pub squash_msg: bool,
    pub rebase_merge: bool,
    pub rebase_apply: bool,
    pub sequencer_todo: bool,
}

#[derive(Debug, Error)]
pub enum GitManagerInProgressError {
    #[error("Git returned malformed repository-state paths")]
    MalformedPaths,
    #[error("Git repository operation state could not be inspected")]
    Io(#[from] io::Error),
    #[error(transparent)]
    Git(#[from] GitCommandError),
}

#[must_use]
pub fn classify_probe_results(probes: ProbeResults) -> Option<GitManagerInProgressOperation> {
    let kind = if probes.rebase_merge || probes.rebase_apply {
        GitManagerInProgressKind::Rebase
    } else if probes.cherry_pick_head || probes.sequencer_todo {
        GitManagerInProgressKind::CherryPick
    } else if probes.revert_head {
        GitManagerInProgressKind::Revert
    } else if probes.merge_head {
        GitManagerInProgressKind::Merge
    } else if probes.squash_msg {
        GitManagerInProgressKind::Squash
    } else {
        return None;
    };
    Some(GitManagerInProgressOperation {
        kind,
        current: None,
        total: None,
    })
}

#[must_use]
pub fn sequencer_progress(
    completed: u64,
    todo: &str,
) -> Option<(GitManagerInProgressKind, u64, u64)> {
    let commands = todo
        .lines()
        .map(str::trim)
        .filter(|line| line.starts_with("pick ") || line.starts_with("revert "))
        .collect::<Vec<_>>();
    let first = commands.first()?;
    let kind = if first.starts_with("revert ") {
        GitManagerInProgressKind::Revert
    } else {
        GitManagerInProgressKind::CherryPick
    };
    let remaining = u64::try_from(commands.len()).ok()?;
    Some((
        kind,
        completed.saturating_add(1),
        completed.saturating_add(remaining),
    ))
}

pub async fn detect_in_progress_operation(
    repository: &GitRepository,
    cwd: &Path,
    cancellation: &CancellationToken,
) -> Result<Option<GitManagerInProgressOperation>, GitManagerInProgressError> {
    let output = repository
        .git_manager_in_progress_paths(cwd, cancellation)
        .await?;
    let paths = output
        .stdout
        .lines()
        .map(|path| resolve_git_path(cwd, path))
        .collect::<Vec<_>>();
    let [
        merge_head,
        cherry_pick_head,
        revert_head,
        squash_msg,
        rebase_merge,
        rebase_apply,
        rebase_msgnum,
        rebase_end,
        sequencer_abort_safety,
        sequencer_head,
        sequencer_todo_path,
    ] = paths.as_slice()
    else {
        return Err(GitManagerInProgressError::MalformedPaths);
    };
    let (
        merge_head,
        cherry_pick_head,
        revert_head,
        squash_msg,
        rebase_merge,
        rebase_apply,
        sequencer_todo_exists,
    ) = tokio::try_join!(
        path_exists(merge_head),
        path_exists(cherry_pick_head),
        path_exists(revert_head),
        path_exists(squash_msg),
        path_exists(rebase_merge),
        path_exists(rebase_apply),
        path_exists(sequencer_todo_path),
    )?;
    let probes = ProbeResults {
        merge_head,
        cherry_pick_head,
        revert_head,
        squash_msg,
        rebase_merge,
        rebase_apply,
        sequencer_todo: sequencer_todo_exists,
    };
    let Some(mut operation) = classify_probe_results(probes) else {
        return Ok(None);
    };
    if operation.kind == GitManagerInProgressKind::Rebase {
        operation.current = read_counter(rebase_msgnum).await?;
        operation.total = read_counter(rebase_end).await?;
    } else if sequencer_todo_exists {
        let todo = read_bounded(sequencer_todo_path).await?;
        let head = read_bounded(sequencer_head).await?;
        let abort_safety = read_bounded(sequencer_abort_safety).await?;
        let head = head.trim();
        let abort_safety = abort_safety.trim();
        let completed = if head == abort_safety {
            Some(0)
        } else if valid_object_id(head) && valid_object_id(abort_safety) {
            repository
                .git_manager_count_commit_range(cwd, head, abort_safety, cancellation)
                .await?
                .stdout
                .trim()
                .parse()
                .ok()
        } else {
            None
        };
        if let Some(completed) = completed
            && let Some((kind, current, total)) = sequencer_progress(completed, &todo)
        {
            operation.kind = kind;
            operation.current = Some(current);
            operation.total = Some(total);
        }
    } else if operation.kind == GitManagerInProgressKind::CherryPick {
        operation.current = Some(1);
        operation.total = Some(1);
    }
    Ok(Some(operation))
}

fn resolve_git_path(cwd: &Path, value: &str) -> PathBuf {
    let path = PathBuf::from(value);
    if path.is_absolute() {
        path
    } else {
        cwd.join(path)
    }
}

async fn path_exists(path: &Path) -> io::Result<bool> {
    match tokio::fs::metadata(path).await {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

async fn read_counter(path: &Path) -> io::Result<Option<u64>> {
    if !path_exists(path).await? {
        return Ok(None);
    }
    Ok(read_bounded(path).await?.trim().parse().ok())
}

async fn read_bounded(path: &Path) -> io::Result<String> {
    let file = tokio::fs::File::open(path).await?;
    let mut value = String::new();
    file.take(64 * 1024).read_to_string(&mut value).await?;
    Ok(value)
}

fn valid_object_id(value: &str) -> bool {
    matches!(value.len(), 40 | 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use std::{fs, process::Command};

    use tempfile::TempDir;

    use super::*;
    use crate::git::GitManagerInProgressKind;

    #[test]
    fn maps_each_probe_state_to_the_wire_operation() {
        for (probes, expected) in [
            (ProbeResults::default(), None),
            (
                ProbeResults {
                    merge_head: true,
                    ..ProbeResults::default()
                },
                Some(GitManagerInProgressKind::Merge),
            ),
            (
                ProbeResults {
                    cherry_pick_head: true,
                    ..ProbeResults::default()
                },
                Some(GitManagerInProgressKind::CherryPick),
            ),
            (
                ProbeResults {
                    revert_head: true,
                    ..ProbeResults::default()
                },
                Some(GitManagerInProgressKind::Revert),
            ),
            (
                ProbeResults {
                    squash_msg: true,
                    ..ProbeResults::default()
                },
                Some(GitManagerInProgressKind::Squash),
            ),
        ] {
            assert_eq!(
                classify_probe_results(probes)
                    .as_ref()
                    .map(|operation| operation.kind),
                expected
            );
        }
    }

    #[test]
    fn rebase_probe_has_precedence_over_merge() {
        let operation = classify_probe_results(ProbeResults {
            merge_head: true,
            rebase_apply: true,
            ..ProbeResults::default()
        })
        .expect("operation in progress");

        assert_eq!(operation.kind, GitManagerInProgressKind::Rebase);
    }

    #[test]
    fn sequencer_todo_reports_cherry_pick() {
        let operation = classify_probe_results(ProbeResults {
            sequencer_todo: true,
            ..ProbeResults::default()
        })
        .expect("operation in progress");

        assert_eq!(operation.kind, GitManagerInProgressKind::CherryPick);
    }

    #[test]
    fn sequencer_snapshot_combines_completed_and_remaining_commits() {
        assert_eq!(
            sequencer_progress(2, "pick aaaaaaa first\npick bbbbbbb second\n# ignored\n"),
            Some((GitManagerInProgressKind::CherryPick, 3, 4))
        );
        assert_eq!(
            sequencer_progress(0, "revert aaaaaaa first\n"),
            Some((GitManagerInProgressKind::Revert, 1, 1))
        );
        assert_eq!(sequencer_progress(0, "# empty\n"), None);
    }

    fn git(cwd: &Path, args: &[&str], succeeds: bool) {
        let output = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_AUTHOR_NAME", "Git Manager Test")
            .env("GIT_AUTHOR_EMAIL", "git-manager@example.test")
            .env("GIT_COMMITTER_NAME", "Git Manager Test")
            .env("GIT_COMMITTER_EMAIL", "git-manager@example.test")
            .output()
            .expect("git fixture starts");
        assert_eq!(
            output.status.success(),
            succeeds,
            "git fixture result differed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn conflicting_rebase_repository() -> TempDir {
        let repository = TempDir::new().expect("temporary repository");
        git(repository.path(), &["init", "-q", "-b", "main"], true);
        fs::write(repository.path().join("tracked.txt"), "base\n").expect("base file");
        git(repository.path(), &["add", "tracked.txt"], true);
        git(repository.path(), &["commit", "-q", "-m", "base"], true);
        git(repository.path(), &["checkout", "-q", "-b", "topic"], true);
        fs::write(repository.path().join("tracked.txt"), "topic\n").expect("topic file");
        git(repository.path(), &["commit", "-qam", "topic"], true);
        git(repository.path(), &["checkout", "-q", "main"], true);
        fs::write(repository.path().join("tracked.txt"), "main\n").expect("main file");
        git(repository.path(), &["commit", "-qam", "main"], true);
        git(repository.path(), &["checkout", "-q", "topic"], true);
        git(
            repository.path(),
            &["-c", "rebase.backend=merge", "rebase", "main"],
            false,
        );
        repository
    }

    #[tokio::test]
    async fn reports_live_rebase_progress_and_no_clean_progress() {
        let repository = conflicting_rebase_repository();
        let operation = detect_in_progress_operation(
            &GitRepository::default(),
            repository.path(),
            &CancellationToken::new(),
        )
        .await
        .expect("rebase probe")
        .expect("rebase in progress");

        assert_eq!(operation.kind, GitManagerInProgressKind::Rebase);
        assert_eq!((operation.current, operation.total), (Some(1), Some(1)));

        git(repository.path(), &["rebase", "--abort"], true);
        assert_eq!(
            detect_in_progress_operation(
                &GitRepository::default(),
                repository.path(),
                &CancellationToken::new(),
            )
            .await
            .expect("clean probe"),
            None
        );
    }
}
