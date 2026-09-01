//! Mergeability preview and merge operation primitives.

use std::path::Path;

use thiserror::Error;
use tokio_util::sync::CancellationToken;

use crate::git::{GitCommandError, GitRepository, ProcessOutput};

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
    #[error("the current HEAD is unavailable")]
    CurrentUnavailable,
    #[error("Git returned malformed merge comparison state")]
    MalformedComparison,
    #[error(transparent)]
    Git(#[from] GitCommandError),
}

#[must_use]
pub fn parse_merge_tree_preview(exit_code: i32, stdout: &str) -> GitManagerMergePreview {
    match exit_code {
        0 => GitManagerMergePreview::Clean,
        1 => GitManagerMergePreview::Conflicted {
            file_count: stdout.matches('\0').count().saturating_sub(1) as u64,
        },
        _ => GitManagerMergePreview::UnrelatedHistories,
    }
}

pub async fn preview(
    repository: &GitRepository,
    cwd: &Path,
    source: &str,
    cancellation: &CancellationToken,
) -> Result<GitManagerMergePreviewResult, GitManagerMergeError> {
    if source.is_empty() || source.trim() != source || source.starts_with('-') {
        return Err(GitManagerMergeError::InvalidSource);
    }
    let (ours, theirs, current_ref) = tokio::try_join!(
        repository.git_manager_resolve_merge_tip(cwd, "HEAD", cancellation),
        repository.git_manager_resolve_merge_tip(cwd, source, cancellation),
        repository.git_manager_head_ref(cwd, cancellation),
    )?;
    let ours_tip = successful_tip(&ours).ok_or(GitManagerMergeError::CurrentUnavailable)?;
    let theirs_tip = successful_tip(&theirs).ok_or(GitManagerMergeError::InvalidSource)?;
    let (merge_tree, counts) = tokio::try_join!(
        repository.git_manager_merge_tree(cwd, ours_tip, theirs_tip, cancellation),
        repository.git_manager_merge_ahead_behind(cwd, ours_tip, theirs_tip, cancellation),
    )?;
    let (behind, ahead) = parse_ahead_behind(&counts.stdout)?;
    let current = (current_ref.exit_code == 0)
        .then(|| current_ref.stdout.trim().to_owned())
        .filter(|current| !current.is_empty())
        .unwrap_or_else(|| ours_tip.to_owned());
    Ok(GitManagerMergePreviewResult {
        preview: parse_merge_tree_preview(merge_tree.exit_code, &merge_tree.stdout),
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
        .git_manager_squash_merge_commit(cwd, cancellation)
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
    use super::*;

    #[test]
    fn parses_clean_merge_tree_exit() {
        assert_eq!(
            parse_merge_tree_preview(0, "0123456789abcdef\0"),
            GitManagerMergePreview::Clean
        );
    }

    #[test]
    fn conflicted_file_count_excludes_the_tree_record() {
        assert_eq!(
            parse_merge_tree_preview(1, "0123456789abcdef\0first.txt\0second.txt\0"),
            GitManagerMergePreview::Conflicted { file_count: 2 }
        );
    }

    #[test]
    fn unexpected_merge_tree_exit_is_unrelated_histories() {
        assert_eq!(
            parse_merge_tree_preview(128, ""),
            GitManagerMergePreview::UnrelatedHistories
        );
    }
}
