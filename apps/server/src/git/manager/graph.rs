//! Tip-pinned Git Manager commit graph reads.

use std::{collections::HashSet, path::Path};

use serde::Serialize;
use thiserror::Error;
use tokio_util::sync::CancellationToken;

use crate::git::{GitCommandError, GitRepository};

use super::generation::{
    RepositoryStateObservation, current_repository_generation, observe_repository_state,
};

pub const MAX_PINNED_TIPS: usize = 512;
pub const COMMIT_PAGE_SIZE: usize = 100;
pub const MAX_DIFF_BUFFER_SIZE: usize = 70_000_000;
pub const MAX_REASONABLE_DIFF_SIZE: usize = MAX_DIFF_BUFFER_SIZE / 16;
pub const MAX_DIFF_LINE_CHARACTERS: usize = 5_000;
const COMMIT_TEXT_LIMIT: usize = 100 * 1024;
const RECORD_SEPARATOR: char = '\u{1e}';

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitManagerCommitEntry {
    pub sha: String,
    pub short_sha: String,
    pub parents: Vec<String>,
    pub decorations: Vec<String>,
    pub subject: String,
    pub body: String,
    pub author_name: String,
    pub author_email: String,
    pub authored_at_ms: u64,
    pub committer_name: String,
    pub committer_email: String,
    pub committed_at_ms: u64,
    pub changed_files: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitManagerCommitPage {
    pub generation: u64,
    pub pinned_tips: Vec<String>,
    pub commits: Vec<GitManagerCommitEntry>,
    pub next_offset: Option<usize>,
    pub exhausted: bool,
    pub degraded_to_all_paging: bool,
}

#[derive(Debug, Error)]
pub enum GitManagerGraphError {
    #[error("the pinned Git history tips can no longer be resolved")]
    TipsUnresolvable,
    #[error("Git returned malformed commit history data")]
    MalformedHistory,
    #[error(transparent)]
    Git(#[from] GitCommandError),
}

struct PagingTipSelection {
    pinned_tips: Vec<String>,
    degraded_to_all_paging: bool,
}

#[must_use]
pub fn parse_commit_record(record: &str) -> Option<GitManagerCommitEntry> {
    let mut fields = record.split('\u{1f}');
    let entry = GitManagerCommitEntry {
        sha: fields.next()?.to_owned(),
        short_sha: fields.next()?.to_owned(),
        subject: truncate_utf8(fields.next()?, COMMIT_TEXT_LIMIT),
        body: truncate_utf8(fields.next()?, COMMIT_TEXT_LIMIT),
        author_name: fields.next()?.to_owned(),
        author_email: fields.next()?.to_owned(),
        authored_at_ms: fields.next()?.parse::<u64>().ok()?.checked_mul(1_000)?,
        committer_name: fields.next()?.to_owned(),
        committer_email: fields.next()?.to_owned(),
        committed_at_ms: fields.next()?.parse::<u64>().ok()?.checked_mul(1_000)?,
        parents: fields
            .next()?
            .split_whitespace()
            .map(str::to_owned)
            .collect(),
        decorations: fields
            .next()?
            .split(',')
            .map(str::trim)
            .filter(|decoration| !decoration.is_empty())
            .map(str::to_owned)
            .collect(),
        changed_files: Vec::new(),
    };
    fields.next().is_none().then_some(entry)
}

fn parse_log_record(record: &str) -> Option<GitManagerCommitEntry> {
    let mut fields = record.trim_end_matches('\0').split('\0');
    let mut entry = parse_commit_record(fields.next()?)?;
    entry.changed_files = fields
        .enumerate()
        .map(|(index, path)| {
            if index == 0 {
                path.strip_prefix('\n').unwrap_or(path)
            } else {
                path
            }
        })
        .filter(|path| !path.is_empty())
        .map(str::to_owned)
        .collect();
    Some(entry)
}

pub async fn resolve_tips(
    repository: &GitRepository,
    cwd: &Path,
    cancellation: &CancellationToken,
) -> Result<Vec<(String, String)>, GitManagerGraphError> {
    let output = repository
        .git_manager_resolve_tips(cwd, cancellation)
        .await?;
    let mut tips = Vec::new();
    for line in output.stdout.lines() {
        let Some((ref_name, sha)) = line.split_once('\t') else {
            return Err(GitManagerGraphError::MalformedHistory);
        };
        if ref_name.is_empty() || !ref_name.starts_with("refs/") || !valid_object_id(sha) {
            return Err(GitManagerGraphError::MalformedHistory);
        }
        tips.push((ref_name.to_owned(), sha.to_owned()));
    }
    Ok(tips)
}

pub async fn page(
    repository: &GitRepository,
    cwd: &Path,
    pinned_tips: Option<&[String]>,
    offset: usize,
    limit: usize,
    cancellation: &CancellationToken,
) -> Result<GitManagerCommitPage, GitManagerGraphError> {
    let (selection, generation) = match pinned_tips {
        Some([]) => (
            PagingTipSelection {
                pinned_tips: Vec::new(),
                degraded_to_all_paging: true,
            },
            current_repository_generation(cwd).await,
        ),
        Some(tips) => {
            if tips.iter().any(|tip| !valid_object_id(tip)) {
                return Err(GitManagerGraphError::TipsUnresolvable);
            }
            let validation = repository
                .git_manager_validate_tips(cwd, tips, cancellation)
                .await?;
            if validation.stdout.lines().count() != tips.len()
                || validation.stdout.lines().any(|line| {
                    let mut fields = line.split_whitespace();
                    !fields.next().is_some_and(valid_object_id)
                        || fields.next() != Some("commit")
                        || fields.next().is_some()
                })
            {
                return Err(GitManagerGraphError::TipsUnresolvable);
            }
            (
                PagingTipSelection {
                    pinned_tips: tips.to_vec(),
                    degraded_to_all_paging: false,
                },
                current_repository_generation(cwd).await,
            )
        }
        None => {
            let resolved = resolve_tips(repository, cwd, cancellation).await?;
            let observation = RepositoryStateObservation::from_tip_shas(
                resolved.iter().map(|(_, sha)| sha.as_str()),
            );
            let generation = observe_repository_state(cwd, observation).await;
            (select_paging_tips(resolved), generation)
        }
    };

    if selection.pinned_tips.is_empty() && !selection.degraded_to_all_paging {
        return Ok(GitManagerCommitPage {
            generation,
            pinned_tips: Vec::new(),
            commits: Vec::new(),
            next_offset: None,
            exhausted: true,
            degraded_to_all_paging: false,
        });
    }

    let limit = limit.clamp(1, COMMIT_PAGE_SIZE);
    let output = repository
        .git_manager_log_page(
            cwd,
            &selection.pinned_tips,
            selection.degraded_to_all_paging,
            offset,
            limit + 1,
            cancellation,
        )
        .await?;
    let mut commits = Vec::new();
    for record in output.stdout.split(RECORD_SEPARATOR) {
        if record.trim_matches('\0').is_empty() {
            continue;
        }
        commits.push(parse_log_record(record).ok_or(GitManagerGraphError::MalformedHistory)?);
    }
    let has_more = commits.len() > limit;
    commits.truncate(limit);
    let returned = commits.len();
    Ok(GitManagerCommitPage {
        generation,
        pinned_tips: selection.pinned_tips,
        commits,
        next_offset: has_more.then_some(offset.saturating_add(returned)),
        exhausted: !has_more,
        degraded_to_all_paging: selection.degraded_to_all_paging,
    })
}

fn select_paging_tips(resolved: Vec<(String, String)>) -> PagingTipSelection {
    if resolved.len() > MAX_PINNED_TIPS {
        return PagingTipSelection {
            pinned_tips: Vec::new(),
            degraded_to_all_paging: true,
        };
    }
    let mut seen = HashSet::new();
    let pinned_tips = resolved
        .into_iter()
        .map(|(_, sha)| sha)
        .filter(|sha| seen.insert(sha.clone()))
        .collect();
    PagingTipSelection {
        pinned_tips,
        degraded_to_all_paging: false,
    }
}

fn valid_object_id(value: &str) -> bool {
    matches!(value.len(), 40 | 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn truncate_utf8(value: &str, limit: usize) -> String {
    if value.len() <= limit {
        return value.to_owned();
    }
    let mut end = limit;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_owned()
}

#[cfg(test)]
mod tests {
    use std::{fs, path::Path, process::Command};

    use tempfile::TempDir;
    use tokio_util::sync::CancellationToken;

    use super::*;
    use crate::git::GitRepository;

    fn git(cwd: &Path, args: &[&str]) {
        let output = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .output()
            .expect("git test fixture starts");
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
        fs::write(repository.path().join("README.md"), "first\n").expect("fixture file");
        git(repository.path(), &["add", "README.md"]);
        git(repository.path(), &["commit", "-q", "-m", "first"]);
        repository
    }

    fn git_stdout(cwd: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .output()
            .expect("git test fixture starts");
        assert!(output.status.success(), "git fixture command failed");
        String::from_utf8(output.stdout).expect("UTF-8 git output")
    }

    #[test]
    fn parses_a_nul_delimited_log_record_into_a_commit_entry() {
        let record = "abc1234def\u{1f}abc1234\u{1f}Subject line\u{1f}Body\u{1f}\
Ann Author\u{1f}ann@example.test\u{1f}1735689600\u{1f}\
Cara Committer\u{1f}cara@example.test\u{1f}1735689660\u{1f}\
parent1 parent2\u{1f}HEAD -> main, origin/main";
        let entry = parse_commit_record(record).expect("record parses");
        assert_eq!(entry.short_sha, "abc1234");
        assert_eq!(entry.parents, vec!["parent1", "parent2"]);
        assert_eq!(entry.decorations, vec!["HEAD -> main", "origin/main"]);
    }

    #[test]
    fn parses_changed_file_names_from_the_same_log_record() {
        let record = "abc1234def\u{1f}abc1234\u{1f}Subject line\u{1f}Body\u{1f}\
Ann Author\u{1f}ann@example.test\u{1f}1735689600\u{1f}\
Cara Committer\u{1f}cara@example.test\u{1f}1735689660\u{1f}\
parent1\u{1f}HEAD -> main\0\nfirst.txt\0nested/second.txt\0";
        let entry = parse_log_record(record).expect("record parses");
        assert_eq!(entry.decorations, vec!["HEAD -> main"]);
        assert_eq!(entry.changed_files, vec!["first.txt", "nested/second.txt"]);
    }

    #[tokio::test]
    async fn offset_past_the_pinned_history_is_exhausted() {
        let repository = repository_with_one_commit();
        let page = page(
            &GitRepository::default(),
            repository.path(),
            None,
            1,
            100,
            &CancellationToken::new(),
        )
        .await
        .expect("history page");

        assert!(page.commits.is_empty());
        assert!(page.exhausted);
        assert_eq!(page.next_offset, None);
    }

    #[tokio::test]
    async fn an_unresolvable_pinned_tip_requests_a_full_reset() {
        let repository = repository_with_one_commit();
        let missing = "0000000000000000000000000000000000000000".to_owned();
        let error = page(
            &GitRepository::default(),
            repository.path(),
            Some(&[missing]),
            0,
            100,
            &CancellationToken::new(),
        )
        .await
        .expect_err("missing tip is distinguishable");

        assert!(matches!(error, GitManagerGraphError::TipsUnresolvable));
    }

    #[test]
    fn repositories_above_the_tip_cap_degrade_explicitly() {
        let tips = (0..=MAX_PINNED_TIPS)
            .map(|index| {
                (
                    format!("refs/heads/branch-{index}"),
                    format!("{index:040x}"),
                )
            })
            .collect();
        let selection = select_paging_tips(tips);

        assert!(selection.degraded_to_all_paging);
        assert!(selection.pinned_tips.is_empty());
    }

    #[tokio::test]
    async fn pinned_second_page_is_stable_after_a_new_commit() {
        let repository = repository_with_one_commit();
        for message in ["second", "third"] {
            git(
                repository.path(),
                &["commit", "-q", "--allow-empty", "-m", message],
            );
        }
        let expected_second = git_stdout(repository.path(), &["rev-parse", "HEAD^"])
            .trim()
            .to_owned();
        let git_repository = GitRepository::default();
        let first = page(
            &git_repository,
            repository.path(),
            None,
            0,
            1,
            &CancellationToken::new(),
        )
        .await
        .expect("first history page");
        git(
            repository.path(),
            &["commit", "-q", "--allow-empty", "-m", "concurrent"],
        );
        let second = page(
            &git_repository,
            repository.path(),
            Some(&first.pinned_tips),
            1,
            1,
            &CancellationToken::new(),
        )
        .await
        .expect("second history page");

        assert_eq!(second.commits[0].sha, expected_second);
    }
}
