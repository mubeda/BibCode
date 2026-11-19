//! Tip-pinned Git Manager commit graph reads.

use std::{collections::HashSet, path::Path};

use serde::Serialize;
use thiserror::Error;
use tokio_util::sync::CancellationToken;

use crate::{
    git::{GitCommandError, GitRepository},
    json_size::encoded_json_len,
};

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
/// History pages hold at most 1 MiB of serialized commit JSON. A page always
/// keeps one commit so pagination never stalls, and that commit is cut down to
/// fit the target on its own (see `fit_first_commit`).
pub const COMMIT_PAGE_TARGET_BYTES: usize = 1024 * 1024;
/// Room left for `,"changedFilesOmitted":<count>` when changed files are cut.
const OMITTED_MARKER_BYTES: usize = 48;
/// A first commit cut to fit leaves this much of the target for the page around it (pinned
/// tips, offsets) and the RPC envelope, under the 1 MiB logical message a remote client accepts.
const FIRST_COMMIT_HEADROOM_BYTES: usize = 64 * 1024;

/// The entry's exact JSON size, escaping, field names and numbers included.
/// It is counted, not built, so the response encoding is the only place the
/// page's JSON text is produced. Counting fails only when the size would
/// overflow `usize`; such an entry never fits, which `usize::MAX` records, so
/// it can only appear as a page's first commit.
fn encoded_entry_bytes(entry: &GitManagerCommitEntry) -> usize {
    encoded_json_len(entry).unwrap_or(usize::MAX)
}

#[cfg(test)]
thread_local! {
    /// Bytes the first-commit fitter measured on this thread, for its cost test.
    static FIT_BYTES_MEASURED: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// `encoded_json_len` for the first-commit fitter, counted in tests.
fn fit_measure<T: Serialize + ?Sized>(value: &T) -> usize {
    let bytes = encoded_json_len(value).unwrap_or(usize::MAX);
    #[cfg(test)]
    FIT_BYTES_MEASURED.with(|measured| measured.set(measured.get().saturating_add(bytes)));
    bytes
}

/// How many leading commits fit the page target; always at least one.
fn commits_within_target(commits: &[GitManagerCommitEntry], target: usize) -> usize {
    let mut total = 2_usize; // JSON array brackets
    for (index, entry) in commits.iter().enumerate() {
        total = total
            .saturating_add(encoded_entry_bytes(entry))
            .saturating_add(usize::from(index > 0));
        if total > target && index > 0 {
            return index;
        }
    }
    commits.len()
}

/// How many leading commits the page keeps. With `fit_first` (a client that shows
/// `changedFilesOmitted`) its first commit is cut to fit, and the whole page, cut or not, keeps
/// the headroom free for the page wrapper. Without it the first commit is sent whole and the page
/// uses the full target, as older clients expect.
fn fit_page(commits: &mut [GitManagerCommitEntry], fit_first: bool) -> usize {
    if !fit_first {
        return commits_within_target(commits, COMMIT_PAGE_TARGET_BYTES);
    }
    if let Some(first) = commits.first_mut() {
        fit_first_commit(first, COMMIT_PAGE_TARGET_BYTES);
    }
    commits_within_target(
        commits,
        COMMIT_PAGE_TARGET_BYTES - FIRST_COMMIT_HEADROOM_BYTES,
    )
}

/// Cuts `entry` until it fits `target` less `FIRST_COMMIT_HEADROOM_BYTES` (#390), and says
/// whether it cut anything. Changed files go first, from the end, and are counted in
/// `changed_files_omitted`; then text fields, longest first; then decorations, from the end. The
/// cut is computed from the sizes of the parts it removes, so the entry is measured whole once.
/// Only the SHAs and parents, which the graph needs, are never cut.
fn fit_first_commit(entry: &mut GitManagerCommitEntry, target: usize) -> bool {
    let budget = target.saturating_sub(FIRST_COMMIT_HEADROOM_BYTES);
    let size = fit_measure(entry);
    if size <= budget {
        return false;
    }
    // Each removed array item also frees its comma; the marker room covers the one fewer comma
    // than items an emptied array frees.
    let mut excess = size
        .saturating_sub(budget)
        .saturating_add(OMITTED_MARKER_BYTES);
    while excess > 0 {
        let Some(path) = entry.changed_files.pop() else {
            break;
        };
        excess = excess.saturating_sub(fit_measure(&path).saturating_add(1));
        entry.changed_files_omitted += 1;
    }
    let mut texts = [
        &mut entry.body,
        &mut entry.subject,
        &mut entry.author_name,
        &mut entry.author_email,
        &mut entry.committer_name,
        &mut entry.committer_email,
    ];
    texts.sort_by_key(|text| std::cmp::Reverse(text.len()));
    for text in texts {
        if excess == 0 {
            break;
        }
        // The text's encoded size without its quotes.
        let bytes = fit_measure(text.as_str()).saturating_sub(2);
        if bytes <= excess {
            excess -= bytes;
            text.clear();
            continue;
        }
        let keep = bytes - excess;
        let boundaries = text
            .char_indices()
            .map(|(index, _)| index)
            .chain([text.len()])
            .collect::<Vec<_>>();
        let fitting =
            boundaries.partition_point(|&end| fit_measure(&text[..end]).saturating_sub(2) <= keep);
        let end = boundaries[fitting.saturating_sub(1)];
        text.truncate(end);
        excess = 0;
    }
    while excess > 0 {
        let Some(decoration) = entry.decorations.pop() else {
            break;
        };
        excess = excess.saturating_sub(fit_measure(&decoration).saturating_add(1));
    }
    true
}

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
    /// How many changed files `changed_files` leaves out to keep the entry within a page.
    #[serde(skip_serializing_if = "is_zero")]
    pub changed_files_omitted: usize,
}

fn is_zero(value: &usize) -> bool {
    *value == 0
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
        changed_files_omitted: 0,
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
    fit_first: bool,
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
    let kept = fit_page(&mut commits, fit_first);
    let trimmed = kept < commits.len();
    commits.truncate(kept);
    let returned = commits.len();
    let more = has_more || trimmed;
    Ok(GitManagerCommitPage {
        generation,
        pinned_tips: selection.pinned_tips,
        commits,
        next_offset: more.then_some(offset.saturating_add(returned)),
        exhausted: !more,
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
            true,
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
            true,
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
            true,
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
            true,
            &CancellationToken::new(),
        )
        .await
        .expect("second history page");

        assert_eq!(second.commits[0].sha, expected_second);
    }

    fn entry_with_body(bytes: usize) -> GitManagerCommitEntry {
        GitManagerCommitEntry {
            sha: "a".repeat(40),
            short_sha: "a".repeat(7),
            parents: Vec::new(),
            decorations: Vec::new(),
            subject: "subject".to_owned(),
            body: "b".repeat(bytes),
            author_name: "Ann".to_owned(),
            author_email: "ann@example.test".to_owned(),
            authored_at_ms: 0,
            committer_name: "Cara".to_owned(),
            committer_email: "cara@example.test".to_owned(),
            committed_at_ms: 0,
            changed_files: Vec::new(),
            changed_files_omitted: 0,
        }
    }

    #[test]
    fn pages_keep_commits_up_to_the_byte_target_and_at_least_one() {
        let large: Vec<_> = (0..10).map(|_| entry_with_body(300 * 1024)).collect();
        assert_eq!(commits_within_target(&large, COMMIT_PAGE_TARGET_BYTES), 3);
        let huge = vec![entry_with_body(5 * 1024 * 1024), entry_with_body(10)];
        assert_eq!(commits_within_target(&huge, COMMIT_PAGE_TARGET_BYTES), 1);
        let small: Vec<_> = (0..100).map(|_| entry_with_body(100)).collect();
        assert_eq!(commits_within_target(&small, COMMIT_PAGE_TARGET_BYTES), 100);
    }

    /// After a cut first commit, the rest of the page shares its budget, so the whole page with
    /// its wrapper stays within the target (#390 review).
    #[test]
    fn a_page_after_a_cut_first_commit_stays_within_the_target() {
        let mut first = entry_with_body(0);
        first.changed_files = (0..27_000)
            .map(|index| format!("generated/path/{index:05}/file-name.txt"))
            .collect();
        // Whole, it fits 1 MiB alone but not the 960 KiB a cut leaves, as in the review.
        let whole = encoded_entry_bytes(&first);
        assert!(whole > COMMIT_PAGE_TARGET_BYTES - FIRST_COMMIT_HEADROOM_BYTES);
        assert!(whole < COMMIT_PAGE_TARGET_BYTES);
        let mut alone = first.clone();
        assert!(fit_first_commit(&mut alone, COMMIT_PAGE_TARGET_BYTES));
        let first_bytes = encoded_entry_bytes(&alone);
        // A second commit that would just fit the full target after the cut first one.
        let base = encoded_entry_bytes(&entry_with_body(0));
        let room = COMMIT_PAGE_TARGET_BYTES - 2 - first_bytes - 1 - 20;
        let second = entry_with_body(room - base);
        assert_eq!(encoded_entry_bytes(&second), room);
        let mut commits = vec![first, second];
        let kept = fit_page(&mut commits, true);
        let page = GitManagerCommitPage {
            generation: 1,
            pinned_tips: vec!["c".repeat(40)],
            commits: commits[..kept].to_vec(),
            next_offset: Some(kept),
            exhausted: false,
            degraded_to_all_paging: false,
        };
        let bytes = serde_json::to_vec(&page).expect("page JSON").len();
        assert!(bytes <= COMMIT_PAGE_TARGET_BYTES, "{bytes} bytes");
    }

    /// With the flag the page keeps the headroom for its wrapper even when no commit needs a
    /// cut: two commits that each fit leave the serialized page within the target.
    #[test]
    fn an_opted_in_page_without_a_cut_stays_within_the_target() {
        let base = encoded_entry_bytes(&entry_with_body(0));
        let half = entry_with_body(524_284 - base);
        assert_eq!(encoded_entry_bytes(&half), 524_284);
        let mut commits = vec![half.clone(), half];
        let kept = fit_page(&mut commits, true);
        let page = GitManagerCommitPage {
            generation: 1,
            pinned_tips: vec!["c".repeat(40)],
            commits: commits[..kept].to_vec(),
            next_offset: Some(kept),
            exhausted: false,
            degraded_to_all_paging: false,
        };
        let bytes = serde_json::to_vec(&page).expect("page JSON").len();
        assert!(bytes <= COMMIT_PAGE_TARGET_BYTES, "{bytes} bytes");
        // A client without the flag keeps the base behaviour: both commits, the full target.
        let mut base_commits = vec![entry_with_body(524_284 - base); 2];
        assert_eq!(fit_page(&mut base_commits, false), 2);
    }

    /// Fitting a commit with 20,000 decorations measures a bounded number of bytes instead of
    /// re-encoding the entry once per dropped decoration (#390 review).
    #[test]
    fn fitting_a_heavily_decorated_commit_measures_a_bounded_number_of_bytes() {
        let mut entry = entry_with_body(0);
        entry.decorations = (0..20_000)
            .map(|index| format!("tag: refs/tags/release-{index:05}-{}", "x".repeat(50)))
            .collect();
        assert!(encoded_entry_bytes(&entry) > COMMIT_PAGE_TARGET_BYTES);
        FIT_BYTES_MEASURED.with(|measured| measured.set(0));
        fit_first_commit(&mut entry, COMMIT_PAGE_TARGET_BYTES);
        let measured = FIT_BYTES_MEASURED.with(std::cell::Cell::get);
        assert!(measured < 64 * 1024 * 1024, "measured {measured} bytes");
        assert!(
            encoded_entry_bytes(&entry) <= COMMIT_PAGE_TARGET_BYTES - FIRST_COMMIT_HEADROOM_BYTES
        );
    }

    /// Text that only fits after escaping is cut too, and the SHA and parents stay (#390).
    #[test]
    fn a_first_commit_over_the_target_without_files_cuts_its_text() {
        let mut entry = entry_with_body(0);
        entry.body = "\u{0001}".repeat(COMMIT_TEXT_LIMIT);
        entry.subject = "\u{0001}".repeat(COMMIT_TEXT_LIMIT);
        entry.parents = vec!["b".repeat(40)];
        assert!(encoded_entry_bytes(&entry) > COMMIT_PAGE_TARGET_BYTES);
        let sha = entry.sha.clone();
        fit_first_commit(&mut entry, COMMIT_PAGE_TARGET_BYTES);
        let bytes = serde_json::to_vec(std::slice::from_ref(&entry))
            .expect("page JSON")
            .len();
        assert!(bytes <= COMMIT_PAGE_TARGET_BYTES, "{bytes} bytes");
        assert_eq!(entry.sha, sha);
        assert_eq!(entry.parents, vec!["b".repeat(40)]);
        assert_eq!(entry.changed_files_omitted, 0);
        // A commit within the target is left as it was.
        let small = entry_with_body(100);
        let mut fitted = small.clone();
        fit_first_commit(&mut fitted, COMMIT_PAGE_TARGET_BYTES);
        assert_eq!(fitted, small);
    }

    #[test]
    fn history_budget_counts_json_escaping_instead_of_raw_string_lengths() {
        let mut entry = entry_with_body(0);
        entry.body = "\u{0001}".repeat(80 * 1024);
        entry.subject = "\\\"\\".repeat(1024);
        let encoded = serde_json::to_vec(&entry).expect("entry JSON").len();
        assert!(
            encoded > entry.body.len() * 5,
            "control characters expand in JSON"
        );
        let entries = vec![entry.clone(), entry.clone(), entry];
        let kept = commits_within_target(&entries, COMMIT_PAGE_TARGET_BYTES);
        assert_eq!(kept, 2);
        let bytes = serde_json::to_vec(&entries[..kept])
            .expect("page JSON")
            .len();
        assert!(bytes <= COMMIT_PAGE_TARGET_BYTES);
        assert!(serde_json::to_vec(&entries).expect("all JSON").len() > COMMIT_PAGE_TARGET_BYTES);
    }

    /// Forty commits of varied sizes; commit 23 alone is larger than a page.
    /// Every fifth subject holds characters that JSON escapes, and some
    /// commits list changed files.
    fn boundary_fixture() -> Vec<GitManagerCommitEntry> {
        (0..40)
            .map(|index| {
                let body = if index == 23 {
                    10_000
                } else {
                    173 * (index % 7) + 59 * (index % 4)
                };
                let mut entry = entry_with_body(body);
                entry.sha = format!("{index:040x}");
                if index % 5 == 0 {
                    entry.subject = "tab\t\"quote\" back\\slash \u{1}".repeat(index / 5 + 1);
                }
                entry.changed_files = (0..index % 4)
                    .map(|file| format!("src/{index}/{file}.rs"))
                    .collect();
                entry
            })
            .collect()
    }

    #[test]
    fn page_boundaries_on_a_fixture_are_the_longest_prefix_that_fits() {
        let commits = boundary_fixture();
        let encoded = |entries: &[GitManagerCommitEntry]| {
            serde_json::to_vec(entries).expect("page JSON").len()
        };
        // Five commits fill this target exactly, so the fifth stays; one
        // byte less and it moves to the next page.
        let target = encoded(&commits[..5]);
        assert_eq!(commits_within_target(&commits, target), 5);
        assert_eq!(commits_within_target(&commits, target - 1), 4);

        let mut pages = Vec::new();
        let mut rest = commits.as_slice();
        while !rest.is_empty() {
            let kept = commits_within_target(rest, target);
            assert!(
                kept == 1 || encoded(&rest[..kept]) <= target,
                "page {} is over the target",
                pages.len()
            );
            if kept < rest.len() {
                assert!(
                    encoded(&rest[..=kept]) > target,
                    "page {} had room for one more commit",
                    pages.len()
                );
            }
            pages.push(kept);
            rest = &rest[kept..];
        }
        // Commit 22 cannot share a page with commit 23, and commit 23 fills
        // a page on its own.
        assert_eq!(pages, vec![5, 3, 4, 3, 4, 3, 1, 1, 3, 4, 3, 4, 2]);
    }

    /// A first commit whose changed files alone pass the page target still fits it, and says how
    /// many files it leaves out (#390).
    #[tokio::test]
    async fn a_first_commit_with_a_huge_file_list_stays_within_the_page_target() {
        let repository = repository_with_one_commit();
        const FILES: usize = 8_000;
        // The paths go straight into the index, so no file on disk meets a path length limit.
        let blob = git_stdout(repository.path(), &["hash-object", "-w", "README.md"]);
        let index_info = (0..FILES)
            .map(|index| {
                format!(
                    "100644 {} 0\tgenerated/module-{:03}/{}file-{index:05}.txt\n",
                    blob.trim(),
                    index / 100,
                    "nested-directory-name/".repeat(24)
                )
            })
            .collect::<String>();
        let mut update = Command::new("git")
            .args(["update-index", "--index-info"])
            .current_dir(repository.path())
            .stdin(std::process::Stdio::piped())
            .spawn()
            .expect("git update-index starts");
        std::io::Write::write_all(
            update.stdin.as_mut().expect("update-index stdin"),
            index_info.as_bytes(),
        )
        .expect("index info written");
        assert!(update.wait().expect("update-index ends").success());
        git(repository.path(), &["commit", "-q", "-m", "many files"]);
        // A client that does not ask for a fitted first commit gets it whole, as before.
        let whole = page(
            &GitRepository::default(),
            repository.path(),
            None,
            0,
            COMMIT_PAGE_SIZE,
            false,
            &CancellationToken::new(),
        )
        .await
        .expect("whole history page");
        assert_eq!(whole.commits[0].changed_files.len(), FILES);
        assert_eq!(whole.commits[0].changed_files_omitted, 0);
        let first = page(
            &GitRepository::default(),
            repository.path(),
            None,
            0,
            COMMIT_PAGE_SIZE,
            true,
            &CancellationToken::new(),
        )
        .await
        .expect("first history page");
        let commits_bytes = serde_json::to_vec(&first.commits).expect("page JSON").len();
        let page_bytes = serde_json::to_vec(&first).expect("page JSON").len();
        let listed = first.commits[0].changed_files.len();
        eprintln!(
            "getCommits first page: {} commits, commits {commits_bytes} bytes, page {page_bytes} bytes, {listed} of {FILES} files listed",
            first.commits.len()
        );
        assert!(
            commits_bytes <= COMMIT_PAGE_TARGET_BYTES,
            "{commits_bytes} bytes"
        );
        assert!(page_bytes <= COMMIT_PAGE_TARGET_BYTES, "{page_bytes} bytes");
        assert_eq!(listed + first.commits[0].changed_files_omitted, FILES);
        assert!(first.commits[0].changed_files_omitted > 0);
        assert!(listed > 0, "the files that fit stay listed");
    }

    #[tokio::test]
    async fn a_page_of_large_commits_stops_near_one_mebibyte_and_pages_on() {
        let repository = repository_with_one_commit();
        for index in 0..14 {
            fs::write(repository.path().join("counter.txt"), format!("{index}\n"))
                .expect("fixture file");
            git(repository.path(), &["add", "counter.txt"]);
            let message = repository.path().join("message.txt");
            fs::write(
                &message,
                format!("large {index}\n\n{}", "b".repeat(90 * 1024)),
            )
            .expect("commit message");
            git(
                repository.path(),
                &["commit", "-q", "-F", message.to_str().expect("utf-8 path")],
            );
        }
        let first = page(
            &GitRepository::default(),
            repository.path(),
            None,
            0,
            COMMIT_PAGE_SIZE,
            true,
            &CancellationToken::new(),
        )
        .await
        .expect("first history page");
        // The client opted in, so the page keeps the wrapper's headroom: 960 KiB.
        assert_eq!(first.commits.len(), 10, "ten 90 KiB commits fit 960 KiB");
        assert_eq!(first.next_offset, Some(10));
        assert!(!first.exhausted);
        let second = page(
            &GitRepository::default(),
            repository.path(),
            Some(first.pinned_tips.as_slice()),
            10,
            COMMIT_PAGE_SIZE,
            true,
            &CancellationToken::new(),
        )
        .await
        .expect("second history page");
        assert_eq!(
            second.commits.len(),
            5,
            "four large commits and the first one"
        );
        assert!(second.exhausted);
    }
}
