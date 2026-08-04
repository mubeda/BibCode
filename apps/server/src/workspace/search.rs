use std::collections::{BTreeMap, HashSet, VecDeque};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;
use tokio_util::sync::CancellationToken;

use crate::git::{OutputPolicy, ProcessError, ProcessRequest, ProcessRunner};

use super::WorkspaceError;
use super::paths::to_posix;

const ENTRY_OVERHEAD_BYTES: usize = 24;
const GIT_SCAN_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    File,
    Directory,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceEntry {
    pub path: String,
    pub kind: EntryKind,
    #[serde(default, skip_serializing_if = "is_false")]
    pub ignored: bool,
}

fn is_false(value: &bool) -> bool {
    !value
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SearchResult {
    pub entries: Vec<WorkspaceEntry>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Copy)]
pub struct SearchLimits {
    pub max_entries: usize,
    pub max_memory_bytes: usize,
    pub max_path_bytes: usize,
}

impl Default for SearchLimits {
    fn default() -> Self {
        Self {
            max_entries: 25_000,
            max_memory_bytes: 16 * 1024 * 1024,
            max_path_bytes: 4096,
        }
    }
}

#[derive(Default)]
struct SearchSnapshot {
    entries: Vec<WorkspaceEntry>,
    memory_bytes: usize,
    truncated: bool,
}

#[derive(Clone)]
pub struct WorkspaceSearchIndex {
    root: PathBuf,
    limits: SearchLimits,
    snapshot: Arc<RwLock<SearchSnapshot>>,
}

impl WorkspaceSearchIndex {
    pub fn new(root: PathBuf, limits: SearchLimits) -> Self {
        Self {
            root,
            limits,
            snapshot: Arc::new(RwLock::new(SearchSnapshot::default())),
        }
    }

    pub async fn refresh(&self, cancellation: CancellationToken) -> Result<(), WorkspaceError> {
        if cancellation.is_cancelled() {
            return Err(WorkspaceError::Cancelled);
        }
        let root = self.root.clone();
        let limits = self.limits;
        let scan_cancel = cancellation.clone();
        let scanned = if let Some(snapshot) = scan_git(&root, limits, &scan_cancel).await? {
            snapshot
        } else {
            tokio::task::spawn_blocking(move || scan(&root, limits, &scan_cancel))
                .await
                .map_err(|error| {
                    WorkspaceError::operation("scan", &self.root, std::io::Error::other(error))
                })??
        };
        if cancellation.is_cancelled() {
            return Err(WorkspaceError::Cancelled);
        }
        *self.snapshot.write().await = scanned;
        Ok(())
    }

    pub async fn list(&self, limit: Option<usize>) -> SearchResult {
        let snapshot = self.snapshot.read().await;
        let effective_limit = limit.unwrap_or(snapshot.entries.len());
        SearchResult {
            truncated: snapshot.truncated || snapshot.entries.len() > effective_limit,
            entries: snapshot
                .entries
                .iter()
                .take(effective_limit)
                .cloned()
                .collect(),
        }
    }

    pub async fn search(&self, query: &str, limit: usize) -> SearchResult {
        let normalized = query
            .trim()
            .trim_start_matches(['@', '.', '/'])
            .to_lowercase();
        let snapshot = self.snapshot.read().await;
        let mut matches = snapshot
            .entries
            .iter()
            .filter_map(|entry| fuzzy_score(&entry.path, &normalized).map(|score| (score, entry)))
            .collect::<Vec<_>>();
        matches.sort_by(|(left_score, left), (right_score, right)| {
            left_score
                .cmp(right_score)
                .then_with(|| entry_kind_rank(left.kind).cmp(&entry_kind_rank(right.kind)))
                .then_with(|| left.path.cmp(&right.path))
        });
        let effective_limit = limit.max(1);
        SearchResult {
            truncated: snapshot.truncated || matches.len() > effective_limit,
            entries: matches
                .into_iter()
                .take(effective_limit)
                .map(|(_, entry)| entry.clone())
                .collect(),
        }
    }

    pub async fn memory_bytes(&self) -> usize {
        self.snapshot.read().await.memory_bytes
    }
}

async fn scan_git(
    root: &Path,
    limits: SearchLimits,
    cancellation: &CancellationToken,
) -> Result<Option<SearchSnapshot>, WorkspaceError> {
    let Some(listed) = run_git_ls_files(
        root,
        ["--cached", "--others", "--exclude-standard"],
        limits.max_memory_bytes,
        cancellation,
    )
    .await?
    else {
        return Ok(None);
    };
    let Some(deleted) =
        run_git_ls_files(root, ["--deleted"], limits.max_memory_bytes, cancellation).await?
    else {
        return Ok(None);
    };
    let deleted = deleted
        .split('\0')
        .filter(|path| !path.is_empty())
        .collect::<HashSet<_>>();
    let ignored_roots = run_git_ls_files(
        root,
        ["--others", "--ignored", "--exclude-standard", "--directory"],
        limits.max_memory_bytes,
        cancellation,
    )
    .await?
    .unwrap_or_default();
    let mut ignored_directories = ignored_roots
        .split('\0')
        .filter(|path| path.ends_with('/'))
        .map(|path| path.trim_end_matches('/').to_owned())
        .collect::<Vec<_>>();
    ignored_directories.sort();
    let mut candidates = BTreeMap::new();
    for path in listed
        .split('\0')
        .filter(|path| !path.is_empty() && !deleted.contains(path))
    {
        for (separator, _) in path.match_indices('/') {
            candidates
                .entry(path[..separator].to_owned())
                .or_insert((EntryKind::Directory, false));
        }
        candidates.insert(path.to_owned(), (EntryKind::File, false));
    }
    for ignored_path in ignored_roots.split('\0').filter(|path| !path.is_empty()) {
        let path = ignored_path.trim_end_matches('/');
        for (separator, _) in path.match_indices('/') {
            candidates
                .entry(path[..separator].to_owned())
                .or_insert((EntryKind::Directory, false));
        }
        candidates
            .entry(path.to_owned())
            .and_modify(|candidate| candidate.1 = true)
            .or_insert((
                if ignored_path.ends_with('/') {
                    EntryKind::Directory
                } else {
                    EntryKind::File
                },
                true,
            ));
    }
    let remaining = limits.max_entries.saturating_sub(candidates.len());
    let scan_root = root.to_path_buf();
    let scan_cancellation = cancellation.clone();
    let ignored_contents = tokio::task::spawn_blocking(move || {
        scan_ignored_directory_contents(
            &scan_root,
            ignored_directories,
            remaining,
            &scan_cancellation,
        )
    })
    .await
    .map_err(|error| {
        WorkspaceError::operation(
            "scan-ignored-directories",
            root,
            std::io::Error::other(error),
        )
    })?;
    if cancellation.is_cancelled() {
        return Err(WorkspaceError::Cancelled);
    }
    for (path, kind) in ignored_contents {
        candidates
            .entry(path)
            .and_modify(|candidate| candidate.1 = true)
            .or_insert((kind, true));
    }
    let mut entries = BTreeMap::new();
    let mut memory_bytes = 0;
    let mut truncated = false;
    for (path, (kind, ignored)) in candidates {
        insert_bounded_entry(
            &mut entries,
            &mut memory_bytes,
            &mut truncated,
            path,
            kind,
            ignored,
            limits,
        );
    }
    Ok(Some(SearchSnapshot {
        entries: entries.into_values().collect(),
        memory_bytes,
        truncated,
    }))
}

fn scan_ignored_directory_contents(
    root: &Path,
    ignored_directories: Vec<String>,
    limit: usize,
    cancellation: &CancellationToken,
) -> Vec<(String, EntryKind)> {
    let mut entries = Vec::new();
    let mut queue = VecDeque::from(ignored_directories);
    while let Some(relative_directory) = queue.pop_front() {
        if cancellation.is_cancelled() || entries.len() >= limit {
            break;
        }
        let Ok(children) = std::fs::read_dir(root.join(&relative_directory)) else {
            continue;
        };
        let mut children = children
            .filter_map(Result::ok)
            .filter_map(|entry| entry.file_type().ok().map(|file_type| (entry, file_type)))
            .filter(|(_, file_type)| !file_type.is_symlink())
            .collect::<Vec<_>>();
        children.sort_by(|(left, left_type), (right, right_type)| {
            left_type
                .is_file()
                .cmp(&right_type.is_file())
                .then_with(|| left.file_name().cmp(&right.file_name()))
        });
        for (child, file_type) in children {
            if cancellation.is_cancelled() || entries.len() >= limit {
                break;
            }
            let path = child.path();
            let Ok(relative) = path.strip_prefix(root) else {
                continue;
            };
            let relative = to_posix(relative);
            let kind = if file_type.is_dir() {
                queue.push_back(relative.clone());
                EntryKind::Directory
            } else if file_type.is_file() {
                EntryKind::File
            } else {
                continue;
            };
            entries.push((relative, kind));
        }
    }
    entries
}

async fn run_git_ls_files<const N: usize>(
    root: &Path,
    modes: [&str; N],
    max_output_bytes: usize,
    cancellation: &CancellationToken,
) -> Result<Option<String>, WorkspaceError> {
    let mut args = vec![OsString::from("-c"), OsString::from("core.quotePath=false")];
    args.extend([OsString::from("ls-files"), OsString::from("-z")]);
    args.extend(modes.into_iter().map(OsString::from));
    args.push(OsString::from("--"));
    match ProcessRunner
        .run(
            ProcessRequest {
                operation: "WorkspaceSearchIndex.gitSnapshot".to_owned(),
                command: PathBuf::from("git"),
                args,
                cwd: root.to_path_buf(),
                env: vec![(OsString::from("GIT_OPTIONAL_LOCKS"), OsString::from("0"))],
                stdin: None,
                timeout: GIT_SCAN_TIMEOUT,
                max_output_bytes,
                output_policy: OutputPolicy::Error,
                append_truncation_marker: false,
                allow_non_zero_exit: true,
            },
            cancellation,
        )
        .await
    {
        Ok(output) if output.exit_code == 0 => Ok(Some(output.stdout)),
        Ok(_) => Ok(None),
        Err(ProcessError::Cancelled { .. }) => Err(WorkspaceError::Cancelled),
        Err(_) => Ok(None),
    }
}

fn insert_bounded_entry(
    entries: &mut BTreeMap<String, WorkspaceEntry>,
    memory_bytes: &mut usize,
    truncated: &mut bool,
    path: String,
    kind: EntryKind,
    ignored: bool,
    limits: SearchLimits,
) -> bool {
    let entry_bytes = path.len().saturating_add(ENTRY_OVERHEAD_BYTES);
    if path.len() > limits.max_path_bytes
        || memory_bytes.saturating_add(entry_bytes) > limits.max_memory_bytes
    {
        *truncated = true;
        return false;
    }
    if entries.len() >= limits.max_entries {
        *truncated = true;
        if kind != EntryKind::File {
            return false;
        }
        let Some(directory_path) = entries
            .iter()
            .find_map(|(path, entry)| (entry.kind == EntryKind::Directory).then_some(path.clone()))
        else {
            return false;
        };
        if let Some(removed) = entries.remove(&directory_path) {
            *memory_bytes = memory_bytes
                .saturating_sub(removed.path.len().saturating_add(ENTRY_OVERHEAD_BYTES));
        }
    }
    *memory_bytes += entry_bytes;
    entries.insert(
        path.clone(),
        WorkspaceEntry {
            path,
            kind,
            ignored,
        },
    );
    true
}

fn entry_kind_rank(kind: EntryKind) -> u8 {
    match kind {
        EntryKind::File => 0,
        EntryKind::Directory => 1,
    }
}

fn scan(
    root: &Path,
    limits: SearchLimits,
    cancellation: &CancellationToken,
) -> Result<SearchSnapshot, WorkspaceError> {
    if !root.is_dir() {
        return Err(WorkspaceError::RootNotDirectory {
            path: root.to_path_buf(),
        });
    }
    let ignore_rules = read_ignore_rules(root);
    let mut entries: BTreeMap<String, WorkspaceEntry> = BTreeMap::new();
    let mut memory_bytes: usize = 0;
    let mut truncated = false;
    let mut stack = vec![root.to_path_buf()];
    while let Some(directory) = stack.pop() {
        if cancellation.is_cancelled() {
            return Err(WorkspaceError::Cancelled);
        }
        let mut children = std::fs::read_dir(&directory)
            .map_err(|error| WorkspaceError::operation("read-directory", &directory, error))?
            .filter_map(Result::ok)
            .collect::<Vec<_>>();
        children.sort_by_key(std::fs::DirEntry::file_name);
        for child in children.into_iter().rev() {
            if cancellation.is_cancelled() {
                return Err(WorkspaceError::Cancelled);
            }
            let path = child.path();
            let relative = path
                .strip_prefix(root)
                .map_err(|error| WorkspaceError::InvalidRequest(error.to_string()))?;
            let relative = to_posix(relative);
            let file_type = child
                .file_type()
                .map_err(|error| WorkspaceError::operation("stat", &path, error))?;
            if should_ignore(&relative, file_type.is_dir(), &ignore_rules) || file_type.is_symlink()
            {
                continue;
            }
            let kind = if file_type.is_dir() {
                EntryKind::Directory
            } else if file_type.is_file() {
                EntryKind::File
            } else {
                continue;
            };
            let inserted = insert_bounded_entry(
                &mut entries,
                &mut memory_bytes,
                &mut truncated,
                relative,
                kind,
                false,
                limits,
            );
            if inserted && file_type.is_dir() {
                stack.push(path);
            }
        }
    }
    Ok(SearchSnapshot {
        entries: entries.into_values().collect(),
        memory_bytes,
        truncated,
    })
}

fn read_ignore_rules(root: &Path) -> HashSet<String> {
    std::fs::read_to_string(root.join(".gitignore"))
        .unwrap_or_default()
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#') && !line.starts_with('!'))
        .map(|line| line.trim_end_matches('/').to_owned())
        .collect()
}

fn should_ignore(relative: &str, is_directory: bool, rules: &HashSet<String>) -> bool {
    let first = relative.split('/').next().unwrap_or(relative);
    if matches!(first, ".git" | "node_modules" | ".convex") {
        return true;
    }
    rules.iter().any(|rule| {
        let root_only = rule.starts_with('/');
        let rule = rule.trim_start_matches('/');
        let directory_rule = relative == rule || relative.starts_with(&format!("{rule}/"));
        let basename_rule = !root_only
            && !rule.contains('/')
            && relative.rsplit('/').next().is_some_and(|name| name == rule);
        directory_rule || basename_rule || (is_directory && relative == rule)
    })
}

fn fuzzy_score(path: &str, query: &str) -> Option<(u8, usize)> {
    if query.is_empty() {
        return Some((3, 0));
    }
    let lower = path.to_lowercase();
    let basename = lower.rsplit('/').next().unwrap_or(&lower);
    if basename == query {
        return Some((0, 0));
    }
    if let Some(index) = basename.find(query) {
        return Some((1, index));
    }
    if let Some(index) = lower.find(query) {
        return Some((2, index));
    }
    if let Some(offset) = subsequence_offset(basename, query) {
        return Some((3, offset));
    }
    subsequence_offset(&lower, query).map(|offset| (4, offset))
}

fn subsequence_offset(candidate: &str, query: &str) -> Option<usize> {
    let mut offset = 0;
    for character in query.chars() {
        let found = candidate[offset..].find(character)?;
        offset += found + character.len_utf8();
    }
    Some(offset)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn repository_snapshot_exposes_ignored_roots_and_their_contents() {
        let root = tempfile::tempdir().unwrap();
        let init = std::process::Command::new("git")
            .args(["init", "--quiet"])
            .current_dir(root.path())
            .status()
            .unwrap();
        assert!(init.success());
        std::fs::write(root.path().join(".gitignore"), "ignored-*/\n").unwrap();
        std::fs::write(root.path().join("tracked.txt"), "tracked").unwrap();
        std::fs::write(root.path().join("untracked.txt"), "untracked").unwrap();
        std::fs::create_dir(root.path().join("ignored-cache")).unwrap();
        std::fs::write(root.path().join("ignored-cache/generated.txt"), "generated").unwrap();
        let add = std::process::Command::new("git")
            .args(["add", ".gitignore", "tracked.txt"])
            .current_dir(root.path())
            .status()
            .unwrap();
        assert!(add.success());

        let index = WorkspaceSearchIndex::new(root.path().to_path_buf(), SearchLimits::default());
        index.refresh(CancellationToken::new()).await.unwrap();
        let entries = index.list(None).await.entries;
        let paths = entries
            .iter()
            .map(|entry| entry.path.as_str())
            .collect::<Vec<_>>();

        assert!(paths.contains(&"tracked.txt"));
        assert!(paths.contains(&"untracked.txt"));
        let ignored = entries
            .iter()
            .find(|entry| entry.path == "ignored-cache")
            .expect("ignored directory should be listed");
        assert_eq!(serde_json::to_value(ignored).unwrap()["ignored"], true);
        let ignored_file = entries
            .iter()
            .find(|entry| entry.path == "ignored-cache/generated.txt")
            .expect("ignored directory contents should be listed");
        assert_eq!(serde_json::to_value(ignored_file).unwrap()["ignored"], true);
    }

    #[tokio::test]
    async fn repository_snapshot_keeps_bounded_ignored_directory_children() {
        let root = tempfile::tempdir().unwrap();
        let init = std::process::Command::new("git")
            .args(["init", "--quiet"])
            .current_dir(root.path())
            .status()
            .unwrap();
        assert!(init.success());
        std::fs::write(root.path().join(".gitignore"), "/packages/\n").unwrap();
        for directory in ["packages/alpha", "packages/bravo"] {
            std::fs::create_dir_all(root.path().join(directory)).unwrap();
            std::fs::write(root.path().join(directory).join("generated.txt"), "").unwrap();
        }
        let add = std::process::Command::new("git")
            .args(["add", ".gitignore"])
            .current_dir(root.path())
            .status()
            .unwrap();
        assert!(add.success());

        let index = WorkspaceSearchIndex::new(
            root.path().to_path_buf(),
            SearchLimits {
                max_entries: 4,
                max_memory_bytes: usize::MAX,
                max_path_bytes: usize::MAX,
            },
        );
        index.refresh(CancellationToken::new()).await.unwrap();
        let paths = index
            .list(None)
            .await
            .entries
            .into_iter()
            .map(|entry| entry.path)
            .collect::<Vec<_>>();

        assert!(paths.contains(&"packages".to_owned()));
        assert!(paths.contains(&"packages/alpha".to_owned()));
        assert!(paths.contains(&"packages/bravo".to_owned()));
    }

    #[tokio::test]
    async fn filesystem_snapshot_preserves_nested_directory_excluded_only_at_root() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join(".gitignore"), "/prps/\n").unwrap();
        for directory in ["prps", "docs/prps"] {
            std::fs::create_dir_all(root.path().join(directory)).unwrap();
            std::fs::write(root.path().join(directory).join("plan.md"), "").unwrap();
        }

        let index = WorkspaceSearchIndex::new(root.path().to_path_buf(), SearchLimits::default());
        index.refresh(CancellationToken::new()).await.unwrap();
        let paths = index
            .list(None)
            .await
            .entries
            .into_iter()
            .map(|entry| entry.path)
            .collect::<Vec<_>>();

        assert!(!paths.iter().any(|path| path.starts_with("prps")));
        assert!(paths.contains(&"docs/prps".to_owned()));
        assert!(paths.contains(&"docs/prps/plan.md".to_owned()));
    }

    #[tokio::test]
    async fn list_returns_only_the_requested_prefix_and_reports_truncation() {
        let root = tempfile::tempdir().unwrap();
        for path in ["alpha.txt", "bravo.txt", "charlie.txt"] {
            std::fs::write(root.path().join(path), "").unwrap();
        }
        let index = WorkspaceSearchIndex::new(root.path().to_path_buf(), SearchLimits::default());
        index.refresh(CancellationToken::new()).await.unwrap();

        let full = index.list(None).await;
        assert_eq!(full.entries.len(), 3);
        assert!(!full.truncated);

        let bounded = index.list(Some(2)).await;
        assert_eq!(bounded.entries, full.entries[..2]);
        assert!(bounded.truncated);

        let within_snapshot = index.list(Some(200)).await;
        assert_eq!(within_snapshot.entries, full.entries);
        assert!(!within_snapshot.truncated);

        let snapshot_limited = WorkspaceSearchIndex::new(
            root.path().to_path_buf(),
            SearchLimits {
                max_entries: 2,
                max_memory_bytes: usize::MAX,
                max_path_bytes: usize::MAX,
            },
        );
        snapshot_limited
            .refresh(CancellationToken::new())
            .await
            .unwrap();
        let snapshot_truncated = snapshot_limited.list(Some(200)).await;
        assert_eq!(snapshot_truncated.entries.len(), 2);
        assert!(snapshot_truncated.truncated);
    }

    #[tokio::test]
    async fn search_index_covers_ignores_scoring_limits_and_cancellation() {
        let root = tempfile::tempdir().unwrap();
        for directory in ["src", "node_modules", ".git", "ignored"] {
            std::fs::create_dir(root.path().join(directory)).unwrap();
        }
        std::fs::write(
            root.path().join(".gitignore"),
            "ignored\n*.tmp\n!important\n",
        )
        .unwrap();
        std::fs::write(root.path().join("src/main.rs"), "fn main() {}").unwrap();
        std::fs::write(root.path().join("src/map_renderer.rs"), "").unwrap();
        std::fs::write(root.path().join("ignored/secret.rs"), "").unwrap();
        std::fs::write(root.path().join("node_modules/package.js"), "").unwrap();

        let index = WorkspaceSearchIndex::new(root.path().to_path_buf(), SearchLimits::default());
        index.refresh(CancellationToken::new()).await.unwrap();
        let listed = index.list(None).await;
        assert!(
            listed
                .entries
                .iter()
                .any(|entry| entry.path == "src/main.rs")
        );
        assert!(
            !listed
                .entries
                .iter()
                .any(|entry| entry.path.contains("ignored"))
        );
        assert!(index.memory_bytes().await > 0);
        assert_eq!(
            index.search("main.rs", 10).await.entries[0].path,
            "src/main.rs"
        );
        assert_eq!(
            index.search("renderer", 10).await.entries[0].path,
            "src/map_renderer.rs"
        );
        assert_eq!(
            index.search("@smr", 10).await.entries[0].path,
            "src/map_renderer.rs"
        );
        assert!(index.search("does-not-exist", 0).await.entries.is_empty());

        let limited = WorkspaceSearchIndex::new(
            root.path().to_path_buf(),
            SearchLimits {
                max_entries: 1,
                max_memory_bytes: usize::MAX,
                max_path_bytes: usize::MAX,
            },
        );
        limited.refresh(CancellationToken::new()).await.unwrap();
        assert!(limited.list(None).await.truncated);

        let memory_limited = WorkspaceSearchIndex::new(
            root.path().to_path_buf(),
            SearchLimits {
                max_entries: usize::MAX,
                max_memory_bytes: 1,
                max_path_bytes: 1,
            },
        );
        memory_limited
            .refresh(CancellationToken::new())
            .await
            .unwrap();
        assert!(memory_limited.list(None).await.truncated);

        let cancelled = CancellationToken::new();
        cancelled.cancel();
        assert!(matches!(
            index.refresh(cancelled).await,
            Err(WorkspaceError::Cancelled)
        ));
        let file = root.path().join("not-directory");
        std::fs::write(&file, "file").unwrap();
        let invalid = WorkspaceSearchIndex::new(file, SearchLimits::default());
        assert!(matches!(
            invalid.refresh(CancellationToken::new()).await,
            Err(WorkspaceError::RootNotDirectory { .. })
        ));
    }

    #[test]
    fn search_helpers_cover_ranking_ignore_and_subsequence_edges() {
        let rules = HashSet::from(["build".to_owned(), "secret.txt".to_owned()]);
        assert!(should_ignore(".git/config", false, &rules));
        assert!(should_ignore("build/output.js", false, &rules));
        assert!(should_ignore("src/secret.txt", false, &rules));
        assert!(!should_ignore("src/public.txt", false, &rules));

        assert_eq!(fuzzy_score("src/main.rs", ""), Some((3, 0)));
        assert_eq!(fuzzy_score("src/main.rs", "main.rs"), Some((0, 0)));
        assert_eq!(fuzzy_score("src/main.rs", "main"), Some((1, 0)));
        assert_eq!(fuzzy_score("source/main.rs", "source"), Some((2, 0)));
        assert!(fuzzy_score("src/map_renderer.rs", "mpr").is_some());
        assert_eq!(fuzzy_score("src/main.rs", "zzz"), None);
        assert_eq!(subsequence_offset("renderer", "rer"), Some(6));
        assert_eq!(subsequence_offset("renderer", "zzz"), None);
        assert!(entry_kind_rank(EntryKind::File) < entry_kind_rank(EntryKind::Directory));
    }
}
