//! Repository-state probes for externally started Git operations.

use std::{
    io,
    path::{Path, PathBuf},
};

use thiserror::Error;
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
        sequencer_todo,
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
        sequencer_todo,
    ) = tokio::try_join!(
        path_exists(merge_head),
        path_exists(cherry_pick_head),
        path_exists(revert_head),
        path_exists(squash_msg),
        path_exists(rebase_merge),
        path_exists(rebase_apply),
        path_exists(sequencer_todo),
    )?;
    Ok(classify_probe_results(ProbeResults {
        merge_head,
        cherry_pick_head,
        revert_head,
        squash_msg,
        rebase_merge,
        rebase_apply,
        sequencer_todo,
    }))
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

#[cfg(test)]
mod tests {
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
}
