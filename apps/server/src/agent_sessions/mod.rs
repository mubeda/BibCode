//! Claude Code and Codex CLI sessions recorded on the server host, read for import into a
//! project's threads. Parsing and its skip rules follow the upstream reference scanner.
//!
//! Every read is bounded: discovery stats at most [`MAX_FILES_PER_SOURCE`] files, a session's
//! working directory comes from its first [`CWD_PREFIX_BYTES`], a transcript is read line by
//! line with lines over [`MAX_RECORD_BYTES`] skipped, and only the last
//! [`MAX_IMPORTED_THREAD_MESSAGES`] messages (each at most [`MAX_MESSAGE_BYTES`]) are kept.

use std::{
    collections::{HashMap, HashSet, VecDeque},
    fs::File,
    io::{BufRead, BufReader, ErrorKind, Read},
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use tokio_util::sync::CancellationToken;

use crate::{
    orchestration::engine::MAX_IMPORTED_THREAD_MESSAGES,
    provider::environment::ClaudeProjectDirectoryName,
};

/// Sessions whose transcript changed longer ago than this are not offered.
pub(crate) const RECENT_WINDOW: Duration = Duration::from_secs(30 * 24 * 60 * 60);
/// The most candidates one scan returns.
pub(crate) const MAX_CANDIDATES: usize = 200;
/// Files stat'ed per source during discovery; the scan reports truncation beyond it.
const MAX_FILES_PER_SOURCE: usize = 20_000;
const CWD_PREFIX_BYTES: u64 = 1024 * 1024;
const CWD_PREFIX_RECORDS: usize = 1_000;
/// Longer JSONL records (large tool output, screenshots) are skipped without being parsed.
const MAX_RECORD_BYTES: usize = 16 * 1024 * 1024;
const MAX_TRANSCRIPT_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const MAX_TRANSCRIPT_RECORDS: usize = 100_000;
/// Transcript bytes one scan parses in total before it reports truncation.
const MAX_SCAN_PARSE_BYTES: u64 = 4 * 1024 * 1024 * 1024;
/// An imported message longer than this keeps its beginning and a truncation note.
pub(crate) const MAX_MESSAGE_BYTES: usize = 100 * 1024;
const TRUNCATION_NOTE: &str = "\n\n[Message truncated on import]";
const MAX_TITLE_CHARS: usize = 100;
const FALLBACK_TITLE: &str = "Imported thread";

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
pub enum AgentSessionProvider {
    #[serde(rename = "claudeAgent")]
    ClaudeAgent,
    #[serde(rename = "codex")]
    Codex,
}

impl AgentSessionProvider {
    pub(crate) fn kind(self) -> &'static str {
        match self {
            Self::ClaudeAgent => "claudeAgent",
            Self::Codex => "codex",
        }
    }
}

/// Where one provider instance writes its sessions on this host.
#[derive(Clone, Debug)]
pub(crate) struct SessionSource {
    pub(crate) provider: AgentSessionProvider,
    /// The Claude config directory or the Codex home.
    pub(crate) home: PathBuf,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SessionMessage {
    pub(crate) role: &'static str,
    pub(crate) text: String,
    pub(crate) created_at: String,
}

#[derive(Clone, Debug)]
pub(crate) struct ParsedSession {
    pub(crate) session_id: String,
    pub(crate) title: String,
    pub(crate) model: Option<String>,
    /// The first `entrypoint` a Claude transcript records; see [`is_terminal_entrypoint`].
    pub(crate) entrypoint: Option<String>,
    /// Visible messages in the whole transcript.
    pub(crate) message_count: usize,
    /// The first user message and the last messages, at most [`MAX_IMPORTED_THREAD_MESSAGES`].
    pub(crate) messages: Vec<SessionMessage>,
}

#[derive(Clone, Debug)]
pub(crate) struct ScanCandidate {
    pub(crate) provider: AgentSessionProvider,
    pub(crate) session: ParsedSession,
    pub(crate) last_active_at: String,
    modified: SystemTime,
}

#[derive(Debug, Default)]
pub(crate) struct ScanResult {
    pub(crate) candidates: Vec<ScanCandidate>,
    pub(crate) truncated: bool,
}

/// Why a requested session was not imported.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum LoadFailure {
    NotFound,
    DifferentDirectory,
    Unreadable,
    NotResumable,
}

impl LoadFailure {
    pub(crate) fn reason(self) -> &'static str {
        match self {
            Self::NotFound => {
                "The session was not found in the last 30 days of CLI history on the server."
            }
            Self::DifferentDirectory => "The session was not run in this project's folder.",
            Self::Unreadable => "The session transcript could not be read.",
            Self::NotResumable => "The session has no resumable ID.",
        }
    }
}

/// Lists the sessions run in `workspace_root` (canonical) whose transcripts changed since
/// `now - RECENT_WINDOW`, newest first, leaving out the `owned` session IDs. Stops reading
/// transcripts once `cancellation` fires.
pub(crate) fn scan(
    sources: &[SessionSource],
    workspace_root: &Path,
    now: SystemTime,
    owned: &HashSet<String>,
    cancellation: &CancellationToken,
) -> ScanResult {
    let since = now
        .checked_sub(RECENT_WINDOW)
        .unwrap_or(SystemTime::UNIX_EPOCH);
    let mut result = ScanResult::default();
    let mut parse_budget = MAX_SCAN_PARSE_BYTES;
    let mut directories = DirectoryMatcher::new(workspace_root);
    for source in sources {
        let (files, truncated) = discover(source, since);
        result.truncated |= truncated;
        let mut seen = HashSet::new();
        let mut found = 0;
        for file in files {
            if cancellation.is_cancelled() {
                return ScanResult::default();
            }
            if found > MAX_CANDIDATES {
                result.truncated = true;
                break;
            }
            if !read_cwd(&file.path).is_some_and(|cwd| directories.matches(&cwd)) {
                continue;
            }
            if file.size > parse_budget {
                result.truncated = true;
                break;
            }
            parse_budget -= file.size;
            let Some(session) = read_session(source.provider, &file, Some(cancellation)) else {
                continue;
            };
            if !is_resumable(source.provider, &session.session_id)
                || owned.contains(&session.session_id)
                || !seen.insert(session.session_id.clone())
            {
                continue;
            }
            found += 1;
            result.candidates.push(ScanCandidate {
                provider: source.provider,
                // The scan reports metadata; an import reads the transcript again.
                session: ParsedSession {
                    messages: Vec::new(),
                    ..session
                },
                last_active_at: iso(file.modified),
                modified: file.modified,
            });
        }
    }
    result
        .candidates
        .sort_by_key(|candidate| std::cmp::Reverse(candidate.modified));
    if result.candidates.len() > MAX_CANDIDATES {
        result.candidates.truncate(MAX_CANDIDATES);
        result.truncated = true;
    }
    result
}

/// Re-reads one session for import, requiring that it still records `folder`. A Claude
/// transcript is looked up in the folder's own project directories first, so unrelated projects
/// cannot exhaust the discovery budget before it is reached; one stored under another directory
/// name is still found by the walk the Import dialog's scan uses.
pub(crate) fn load(
    source: &SessionSource,
    session_id: &str,
    folder: &SessionFolder,
    now: SystemTime,
) -> Result<ParsedSession, LoadFailure> {
    if !is_resumable(source.provider, session_id) {
        return Err(LoadFailure::NotResumable);
    }
    let since = now
        .checked_sub(RECENT_WINDOW)
        .unwrap_or(SystemTime::UNIX_EPOCH);
    let in_folder = match source.provider {
        AgentSessionProvider::ClaudeAgent => folder_directories(&source.home, folder)
            .into_iter()
            .find_map(|directory| {
                recent_file(directory.join(format!("{session_id}.jsonl")), since)
            }),
        AgentSessionProvider::Codex => None,
    };
    let codex_suffix = format!("-{session_id}.jsonl");
    let file = in_folder
        .or_else(|| {
            discover(source, since).0.into_iter().find(|file| {
                let name = file.path.file_name().and_then(|name| name.to_str());
                match source.provider {
                    AgentSessionProvider::ClaudeAgent => {
                        file.path.file_stem().and_then(|stem| stem.to_str()) == Some(session_id)
                    }
                    AgentSessionProvider::Codex => {
                        name.is_some_and(|name| name.ends_with(&codex_suffix))
                    }
                }
            })
        })
        .ok_or(LoadFailure::NotFound)?;
    let cwd = read_cwd(&file.path).ok_or(LoadFailure::DifferentDirectory)?;
    if !DirectoryMatcher::new(folder.canonical()).matches(&cwd) {
        return Err(LoadFailure::DifferentDirectory);
    }
    let session = read_session(source.provider, &file, None).ok_or(LoadFailure::Unreadable)?;
    if session.session_id != session_id {
        return Err(LoadFailure::NotFound);
    }
    Ok(session)
}

/// Claude resumes only UUID sessions (hyphenated, version 1-8, RFC variant);
/// Codex IDs come from the transcript's own metadata.
pub(crate) fn is_resumable(provider: AgentSessionProvider, session_id: &str) -> bool {
    match provider {
        AgentSessionProvider::Codex => {
            !session_id.is_empty()
                && session_id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        }
        AgentSessionProvider::ClaudeAgent => {
            let bytes = session_id.as_bytes();
            bytes.len() == 36
                && bytes.iter().enumerate().all(|(index, byte)| match index {
                    8 | 13 | 18 | 23 => *byte == b'-',
                    14 => (b'1'..=b'8').contains(byte),
                    19 => matches!(byte.to_ascii_lowercase(), b'8' | b'9' | b'a' | b'b'),
                    _ => byte.is_ascii_hexdigit(),
                })
        }
    }
}

/// A folder sessions are matched against: its canonical path, which a recorded cwd must resolve
/// to, and the spellings Claude may have named its project directory after.
#[derive(Clone, Debug)]
pub(crate) struct SessionFolder {
    canonical: PathBuf,
    spellings: Vec<PathBuf>,
}

impl SessionFolder {
    pub(crate) fn new(path: &Path) -> Self {
        let canonical = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        let mut spellings = vec![path.to_path_buf()];
        if canonical != path {
            spellings.push(canonical.clone());
        }
        Self {
            canonical,
            spellings,
        }
    }

    pub(crate) fn canonical(&self) -> &Path {
        &self.canonical
    }
}

/// The directories under `<home>/projects` named after `folder`, found by reading entry names
/// only: Claude keeps a folder's transcripts in its encoded directory.
fn folder_directories(home: &Path, folder: &SessionFolder) -> Vec<PathBuf> {
    let mut names = folder
        .spellings
        .iter()
        .map(|spelling| ClaudeProjectDirectoryName::of(spelling))
        .collect::<Vec<_>>();
    names.dedup();
    let Ok(entries) = std::fs::read_dir(home.join("projects")) else {
        return Vec::new();
    };
    let mut directories = entries
        .flatten()
        .filter(|entry| {
            entry
                .file_name()
                .to_str()
                .is_some_and(|name| names.iter().any(|candidate| candidate.matches(name)))
        })
        .map(|entry| entry.path())
        .collect::<Vec<_>>();
    directories.sort();
    directories
}

/// A session History offers: one started in a terminal (`cli`), or by a Claude Code old enough
/// to record no entrypoint. `-p` and Agent SDK sessions (`sdk-*`, BiBCode's own `sdk-rust`
/// among them), the Desktop app's (`claude-desktop`) and any other are left out.
pub(crate) fn is_terminal_entrypoint(entrypoint: Option<&str>) -> bool {
    matches!(entrypoint, None | Some("cli"))
}

/// The most transcripts one History listing opens, the bytes it reads across every head, tail
/// and title read, and the share of those bytes the title walk may spend.
#[derive(Clone, Copy, Debug)]
pub(crate) struct ListingBudget {
    pub(crate) opens: usize,
    pub(crate) bytes: u64,
    pub(crate) walk_bytes: u64,
}

impl Default for ListingBudget {
    fn default() -> Self {
        Self {
            opens: 1_000,
            bytes: 64 * 1024 * 1024,
            walk_bytes: 16 * 1024 * 1024,
        }
    }
}

/// The end of a transcript read for its latest title and branch.
const TAIL_BYTES: u64 = 64 * 1024;
/// The step of the walk back from the tail toward the head for a buried title.
const WALK_CHUNK_BYTES: u64 = 256 * 1024;
/// A longer line holding a title marker is message text, not a title record.
const MAX_TITLE_LINE_BYTES: usize = 64 * 1024;
const UNTITLED_SESSION: &str = "Untitled session";

/// Whether a session's terminal still has it open, as far as `<config dir>/sessions/` tells.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Liveness {
    Closed,
    Live,
    Unknown,
}

impl Liveness {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Closed => "closed",
            Self::Live => "live",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct HistorySession {
    pub(crate) session_id: String,
    pub(crate) title: String,
    pub(crate) branch: Option<String>,
    pub(crate) last_active_at: String,
    pub(crate) liveness: Liveness,
}

#[derive(Debug, Default)]
pub(crate) struct HistoryListing {
    /// Newest first.
    pub(crate) sessions: Vec<HistorySession>,
    /// More sessions may exist than were listed: the candidate limit or the budget ran out.
    pub(crate) truncated: bool,
    /// Transcripts opened and bytes read, which the budget bounds.
    pub(crate) opened: usize,
    pub(crate) bytes_read: u64,
    /// `sessions/` could not be read completely, so sessions not found live read `unknown`.
    pub(crate) liveness_incomplete: bool,
}

/// The terminal sessions run in `folder` whose transcripts changed since `now - RECENT_WINDOW`,
/// newest first, leaving out the `owned` session IDs. Only the folder's own project directories
/// are listed, and each transcript is read at its head and its last [`TAIL_BYTES`], with a
/// bounded walk for a title buried between them, all under one `budget`. A cancelled listing
/// returns nothing.
pub(crate) fn list_terminal_sessions(
    home: &Path,
    folder: &SessionFolder,
    now: SystemTime,
    owned: &HashSet<String>,
    budget: ListingBudget,
    cancellation: &CancellationToken,
) -> HistoryListing {
    let since = now
        .checked_sub(RECENT_WINDOW)
        .unwrap_or(SystemTime::UNIX_EPOCH);
    let mut listing = HistoryListing::default();
    if cancellation.is_cancelled() {
        return listing;
    }
    let mut files = Vec::new();
    let mut stats = MAX_FILES_PER_SOURCE;
    'directories: for directory in folder_directories(home, folder) {
        for path in sorted_entries(&directory) {
            if path
                .extension()
                .is_none_or(|extension| extension != "jsonl")
            {
                continue;
            }
            if stats == 0 {
                listing.truncated = true;
                break 'directories;
            }
            stats -= 1;
            files.extend(recent_file(path, since));
        }
    }
    files.sort_by_key(|file| std::cmp::Reverse(file.modified));
    let mut reads = BudgetedReads::new(budget);
    let mut directories = DirectoryMatcher::new(folder.canonical());
    let mut seen = HashSet::new();
    let mut found = Vec::new();
    for file in files {
        if cancellation.is_cancelled() {
            return HistoryListing::default();
        }
        if found.len() == MAX_CANDIDATES {
            listing.truncated = true;
            break;
        }
        // Rejected by name, so they cost the `stat` above and nothing more.
        let Some(session_id) = file.path.file_stem().and_then(|stem| stem.to_str()) else {
            continue;
        };
        if !is_resumable(AgentSessionProvider::ClaudeAgent, session_id)
            || owned.contains(session_id)
            || !seen.insert(session_id.to_owned())
        {
            continue;
        }
        if !reads.can_open() {
            listing.truncated = true;
            break;
        }
        match read_terminal_metadata(&file, &mut directories, &mut reads, cancellation) {
            MetadataRead::Listed { title, branch } => found.push(HistorySession {
                session_id: session_id.to_owned(),
                title,
                branch,
                last_active_at: iso(file.modified),
                liveness: Liveness::Unknown,
            }),
            MetadataRead::Excluded => {}
            MetadataRead::OutOfBudget => {
                listing.truncated = true;
                break;
            }
            MetadataRead::Cancelled => return HistoryListing::default(),
        }
    }
    listing.opened = reads.opened;
    listing.bytes_read = reads.bytes_read;
    if !found.is_empty() {
        let live = read_live_sessions(home);
        listing.liveness_incomplete = !live.complete;
        for session in &mut found {
            session.liveness = live.liveness(&session.session_id);
        }
    }
    listing.sessions = found;
    listing
}

/// The opens and bytes a listing has left.
struct BudgetedReads {
    opens_left: usize,
    bytes_left: u64,
    walk_left: u64,
    opened: usize,
    bytes_read: u64,
}

impl BudgetedReads {
    fn new(budget: ListingBudget) -> Self {
        Self {
            opens_left: budget.opens,
            bytes_left: budget.bytes,
            walk_left: budget.walk_bytes.min(budget.bytes),
            opened: 0,
            bytes_read: 0,
        }
    }

    fn can_open(&self) -> bool {
        self.opens_left > 0 && self.bytes_left > 0
    }

    fn open(&mut self, path: &Path) -> Option<File> {
        self.opens_left = self.opens_left.checked_sub(1)?;
        self.opened += 1;
        File::open(path).ok()
    }

    fn charge(&mut self, bytes: u64) {
        self.bytes_left = self.bytes_left.saturating_sub(bytes);
        self.bytes_read += bytes;
    }

    /// Reads `length` bytes at `offset`, or fewer at the end of the file; `None` when the budget
    /// cannot cover the read or the file cannot be read.
    fn read_at(&mut self, file: &mut File, offset: u64, length: u64) -> Option<Vec<u8>> {
        use std::io::{Seek, SeekFrom};
        if length > self.bytes_left {
            return None;
        }
        file.seek(SeekFrom::Start(offset)).ok()?;
        let mut bytes = Vec::with_capacity(usize::try_from(length).unwrap_or(0));
        let read = file.take(length).read_to_end(&mut bytes);
        self.charge(bytes.len() as u64);
        read.ok().map(|_| bytes)
    }
}

/// Counts what a reader pulled from its file, which is what a listing's budget is charged.
struct CountingReader<R> {
    inner: R,
    count: std::rc::Rc<std::cell::Cell<u64>>,
}

impl<R: Read> Read for CountingReader<R> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        let read = self.inner.read(buffer)?;
        self.count.set(self.count.get() + read as u64);
        Ok(read)
    }
}

enum MetadataRead {
    Listed {
        title: String,
        branch: Option<String>,
    },
    Excluded,
    OutOfBudget,
    Cancelled,
}

/// Titles and branch seen in one window of a transcript, the latest of each.
#[derive(Default)]
struct TranscriptMarks {
    custom_title: Option<String>,
    ai_title: Option<String>,
    branch: Option<String>,
}

impl TranscriptMarks {
    fn observe(&mut self, record: &Record) {
        if let Some(name) = custom_title_of(record) {
            self.custom_title = Some(name.to_owned());
        }
        if let Some(title) = trimmed(record.ai_title.as_deref()) {
            self.ai_title = Some(title.to_owned());
        }
        if let Some(branch) = trimmed(record.git_branch.as_deref()) {
            self.branch = Some(branch.to_owned());
        }
    }

    fn has_title(&self) -> bool {
        self.custom_title.is_some() || self.ai_title.is_some()
    }
}

/// The head read of [`list_terminal_sessions`]: the first cwd, which must be the folder, and the
/// first entrypoint, which must be a terminal's, then the first visible prompt. Stops at the
/// first record that excludes the session.
struct Head {
    marks: TranscriptMarks,
    prompt_title: Option<String>,
    /// Where the next unread line starts: the walk covers the bytes from here to the tail.
    end: u64,
}

fn read_terminal_metadata(
    file: &SessionFile,
    directories: &mut DirectoryMatcher<'_>,
    reads: &mut BudgetedReads,
    cancellation: &CancellationToken,
) -> MetadataRead {
    let Some(mut handle) = reads.open(&file.path) else {
        return MetadataRead::Excluded;
    };
    let head = match read_head(&handle, directories, reads, cancellation) {
        Ok(head) => head,
        Err(outcome) => return outcome,
    };
    let Some(tail) = read_tail(&mut handle, file.size, head.end, reads) else {
        return MetadataRead::OutOfBudget;
    };
    let mut walked = TranscriptMarks::default();
    if !tail.marks.has_title() {
        walked = walk_for_title(&mut handle, head.end, tail.start, reads, cancellation);
        if cancellation.is_cancelled() {
            return MetadataRead::Cancelled;
        }
    }
    let title = [&tail.marks, &walked, &head.marks]
        .iter()
        .find_map(|marks| marks.custom_title.clone())
        .or_else(|| {
            [&tail.marks, &walked, &head.marks]
                .iter()
                .find_map(|marks| marks.ai_title.clone())
        })
        .or(head.prompt_title)
        .unwrap_or_else(|| UNTITLED_SESSION.to_owned());
    MetadataRead::Listed {
        title,
        branch: tail.marks.branch.or(head.marks.branch),
    }
}

fn read_head(
    handle: &File,
    directories: &mut DirectoryMatcher<'_>,
    reads: &mut BudgetedReads,
    cancellation: &CancellationToken,
) -> Result<Head, MetadataRead> {
    let limit = CWD_PREFIX_BYTES.min(reads.bytes_left);
    let count = std::rc::Rc::new(std::cell::Cell::new(0));
    let mut records = RecordReader::new(CountingReader {
        inner: handle.take(limit),
        count: count.clone(),
    })
    .with_cancellation(cancellation);
    let mut marks = TranscriptMarks::default();
    let mut cwd_matched = false;
    let mut entrypoint_seen = false;
    let mut first_prompt = None;
    let mut decided = false;
    for record in records.by_ref().take(CWD_PREFIX_RECORDS) {
        let Some(record) = record else { continue };
        marks.observe(&record);
        if !cwd_matched && let Some(cwd) = record_cwd(&record) {
            if !directories.matches(cwd) {
                reads.charge(count.get());
                return Err(MetadataRead::Excluded);
            }
            cwd_matched = true;
        }
        if !entrypoint_seen && let Some(entrypoint) = trimmed(record.entrypoint.as_deref()) {
            if !is_terminal_entrypoint(Some(entrypoint)) {
                reads.charge(count.get());
                return Err(MetadataRead::Excluded);
            }
            entrypoint_seen = true;
        }
        if first_prompt.is_none() {
            first_prompt = visible_prompt(&record).as_deref().and_then(prompt_title);
        }
        if cwd_matched && first_prompt.is_some() {
            decided = true;
            break;
        }
    }
    reads.charge(count.get());
    if cancellation.is_cancelled() {
        return Err(MetadataRead::Cancelled);
    }
    if records.failed {
        return Err(MetadataRead::Excluded);
    }
    let window_full = count.get() >= limit || records.lines >= CWD_PREFIX_RECORDS;
    if !decided && window_full && limit < CWD_PREFIX_BYTES {
        // The budget, not the head's own bound, cut the read short.
        return Err(MetadataRead::OutOfBudget);
    }
    // No cwd in the head (as for the Import dialog), or a transcript that ends without a prompt:
    // nothing here to continue.
    if !cwd_matched || (first_prompt.is_none() && !window_full) {
        return Err(MetadataRead::Excluded);
    }
    Ok(Head {
        marks,
        prompt_title: first_prompt,
        end: records.position,
    })
}

struct Tail {
    marks: TranscriptMarks,
    /// Where the tail's first whole line starts.
    start: u64,
}

/// The last [`TAIL_BYTES`] after `head_end`, its first partial line dropped. `None` when the
/// budget cannot cover the read.
fn read_tail(
    handle: &mut File,
    size: u64,
    head_end: u64,
    reads: &mut BudgetedReads,
) -> Option<Tail> {
    if size <= head_end {
        return Some(Tail {
            marks: TranscriptMarks::default(),
            start: size,
        });
    }
    let from = size.saturating_sub(TAIL_BYTES).max(head_end);
    // From the byte before, so a tail that starts on a line boundary keeps its first line.
    let read_from = if from > head_end { from - 1 } else { from };
    let bytes = reads.read_at(handle, read_from, size - read_from)?;
    let skip = if read_from < from {
        bytes
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(bytes.len(), |index| index + 1)
    } else {
        0
    };
    let mut marks = TranscriptMarks::default();
    for record in RecordReader::new(&bytes[skip..]).flatten() {
        marks.observe(&record);
    }
    Some(Tail {
        marks,
        start: read_from + skip as u64,
    })
}

/// Walks back from `end` toward `start` in [`WALK_CHUNK_BYTES`] steps for the last
/// `custom-title` (or, failing that, the last `aiTitle`), parsing only the lines whose raw bytes
/// name one. Stops when the walk's share of the budget is spent; the row then keeps its head
/// title or first prompt.
fn walk_for_title(
    handle: &mut File,
    start: u64,
    end: u64,
    reads: &mut BudgetedReads,
    cancellation: &CancellationToken,
) -> TranscriptMarks {
    let mut marks = TranscriptMarks::default();
    // The end of the line that starts before the chunk read last, which the next read completes;
    // dropped once it outgrows a title record.
    let mut carry: Vec<u8> = Vec::new();
    let mut carry_oversized = false;
    let mut chunk_end = end;
    while chunk_end > start && !cancellation.is_cancelled() {
        let chunk_start = chunk_end.saturating_sub(WALK_CHUNK_BYTES).max(start);
        let length = chunk_end - chunk_start;
        if length > reads.walk_left {
            break;
        }
        let Some(mut bytes) = reads.read_at(handle, chunk_start, length) else {
            break;
        };
        reads.walk_left -= length;
        chunk_end = chunk_start;
        bytes.extend_from_slice(&carry);
        // `start` is a line boundary; elsewhere the bytes before the first newline belong to a
        // line that starts in an earlier chunk.
        let whole_from = if chunk_start == start {
            0
        } else if let Some(index) = bytes.iter().position(|byte| *byte == b'\n') {
            index + 1
        } else {
            if !carry_oversized && bytes.len() <= MAX_TITLE_LINE_BYTES {
                carry = bytes;
            } else {
                carry = Vec::new();
                carry_oversized = true;
            }
            continue;
        };
        let mut lines = bytes[whole_from..]
            .split(|byte| *byte == b'\n')
            .collect::<Vec<_>>();
        if carry_oversized {
            // The last line continues into the carry that outgrew a title record.
            lines.pop();
        }
        for line in lines.iter().rev() {
            if let Some(found) = title_line(line) {
                if found.custom_title.is_some() {
                    marks.custom_title = found.custom_title;
                    return marks;
                }
                if marks.ai_title.is_none() {
                    marks.ai_title = found.ai_title;
                }
            }
        }
        let partial = whole_from.saturating_sub(1);
        carry_oversized = partial > MAX_TITLE_LINE_BYTES;
        carry = if carry_oversized {
            Vec::new()
        } else {
            bytes[..partial].to_vec()
        };
    }
    marks
}

/// The title a raw line records, parsed only when its bytes name one.
fn title_line(line: &[u8]) -> Option<TranscriptMarks> {
    if line.len() > MAX_TITLE_LINE_BYTES
        || !(contains(line, b"custom-title") || contains(line, b"aiTitle"))
    {
        return None;
    }
    let record = serde_json::from_slice::<Record>(line).ok()?;
    let mut marks = TranscriptMarks::default();
    marks.observe(&record);
    marks.branch = None;
    marks.has_title().then_some(marks)
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}

fn record_cwd(record: &Record) -> Option<&str> {
    [
        record.cwd.as_deref(),
        record
            .payload
            .as_ref()
            .and_then(|payload| payload.cwd.as_deref()),
    ]
    .into_iter()
    .flatten()
    .map(str::trim)
    .find(|cwd| !cwd.is_empty())
}

/// A Claude user prompt as the import shows it: not a subagent's, meta or compaction record.
fn visible_prompt(record: &Record) -> Option<String> {
    if record.kind.as_deref() != Some("user")
        || record.is_sidechain == Some(true)
        || record.is_meta == Some(true)
        || record.is_compact_summary == Some(true)
    {
        return None;
    }
    let text = extract_text(
        record
            .message
            .as_ref()
            .and_then(|message| message.content.as_ref()),
    );
    (!text.is_empty()).then_some(text)
}

/// Sessions `<home>/sessions/` names whose process is alive, and whether that directory was
/// read completely.
#[derive(Debug, Default)]
struct LiveSessions {
    live: HashSet<String>,
    complete: bool,
}

impl LiveSessions {
    fn liveness(&self, session_id: &str) -> Liveness {
        if self.live.contains(session_id) {
            Liveness::Live
        } else if self.complete {
            Liveness::Closed
        } else {
            Liveness::Unknown
        }
    }
}

/// One session's liveness, read as [`list_terminal_sessions`] reads it, for a resume to check it
/// again.
pub(crate) fn session_liveness(home: &Path, session_id: &str) -> Liveness {
    read_live_sessions(home).liveness(session_id)
}

const MAX_LIVE_SESSION_FILES: usize = 256;
const MAX_LIVE_SESSION_FILE_BYTES: u64 = 64 * 1024;

#[derive(Deserialize)]
struct LiveSessionEntry {
    #[serde(rename = "sessionId")]
    session_id: String,
    pid: u32,
    entrypoint: Option<String>,
}

/// Reads Claude's running-session files once: a `<pid>.json` naming a session whose process is
/// alive makes it live. The fields are undocumented, so anything short of a complete read
/// (no directory, which Claude keeps once it has created it; an unreadable directory; more than
/// [`MAX_LIVE_SESSION_FILES`] files; one file unreadable, unparsable or over
/// [`MAX_LIVE_SESSION_FILE_BYTES`]) leaves every session not found live unknown. A reused PID
/// reads as live, which only forces a copy.
fn read_live_sessions(home: &Path) -> LiveSessions {
    let mut live = LiveSessions::default();
    let entries = match std::fs::read_dir(home.join("sessions")) {
        Ok(entries) => entries,
        // A Claude Code that writes no running-session files.
        Err(error) if error.kind() == ErrorKind::NotFound => return live,
        Err(_) => {
            tracing::warn!(
                "Claude's running-session directory could not be read; History offers a copy of \
                 every session"
            );
            return live;
        }
    };
    let mut complete = true;
    let mut paths = Vec::new();
    for entry in entries {
        match entry {
            Ok(entry) => {
                let path = entry.path();
                if path
                    .extension()
                    .is_some_and(|extension| extension == "json")
                {
                    paths.push(path);
                }
            }
            Err(_) => complete = false,
        }
    }
    let listed = paths.len();
    if listed > MAX_LIVE_SESSION_FILES {
        complete = false;
        paths.sort();
        paths.truncate(MAX_LIVE_SESSION_FILES);
    }
    let mut claimed = Vec::new();
    for path in paths {
        let file = match File::open(&path) {
            Ok(file) => file,
            // Its session exited between the listing and the read.
            Err(error) if error.kind() == ErrorKind::NotFound => continue,
            Err(_) => {
                complete = false;
                continue;
            }
        };
        let mut bytes = Vec::new();
        if file
            .take(MAX_LIVE_SESSION_FILE_BYTES + 1)
            .read_to_end(&mut bytes)
            .is_err()
            || bytes.len() as u64 > MAX_LIVE_SESSION_FILE_BYTES
        {
            complete = false;
            continue;
        }
        let Ok(entry) = serde_json::from_slice::<LiveSessionEntry>(&bytes) else {
            complete = false;
            continue;
        };
        // BiBCode's own Claude processes.
        if entry.entrypoint.as_deref() == Some("sdk-rust") {
            continue;
        }
        claimed.push(entry);
    }
    let running = crate::process::running_processes(claimed.iter().map(|entry| entry.pid));
    live.live = claimed
        .into_iter()
        .filter(|entry| running.contains(&entry.pid))
        .map(|entry| entry.session_id)
        .collect();
    live.complete = complete;
    if !complete {
        tracing::warn!(
            files = listed,
            "Claude's running-session files could not be read completely; History offers a copy \
             of sessions it cannot place"
        );
    }
    live
}

struct SessionFile {
    path: PathBuf,
    modified: SystemTime,
    size: u64,
}

/// Transcript files changed since `since`, newest first, and whether the stat budget ran out.
fn discover(source: &SessionSource, since: SystemTime) -> (Vec<SessionFile>, bool) {
    let mut files = Vec::new();
    let mut budget = MAX_FILES_PER_SOURCE;
    let mut truncated = false;
    let mut consider = |path: PathBuf, files: &mut Vec<SessionFile>| {
        if budget == 0 {
            truncated = true;
            return;
        }
        budget -= 1;
        files.extend(recent_file(path, since));
    };
    match source.provider {
        AgentSessionProvider::ClaudeAgent => {
            for directory in sorted_entries(&source.home.join("projects")) {
                for path in sorted_entries(&directory) {
                    if path
                        .extension()
                        .is_some_and(|extension| extension == "jsonl")
                    {
                        consider(path, &mut files);
                    }
                }
            }
        }
        AgentSessionProvider::Codex => {
            // Date folders sort chronologically, so the budget goes to recent sessions first.
            for year in sorted_entries(&source.home.join("sessions"))
                .into_iter()
                .rev()
            {
                for month in sorted_entries(&year).into_iter().rev() {
                    for day in sorted_entries(&month).into_iter().rev() {
                        for path in sorted_entries(&day).into_iter().rev() {
                            let name = path.file_name().and_then(|name| name.to_str());
                            if name.is_some_and(|name| {
                                name.starts_with("rollout-") && name.ends_with(".jsonl")
                            }) {
                                consider(path, &mut files);
                            }
                        }
                    }
                }
            }
        }
    }
    files.sort_by_key(|file| std::cmp::Reverse(file.modified));
    (files, truncated)
}

/// `path` when it is a file changed since `since`, after one `stat`.
fn recent_file(path: PathBuf, since: SystemTime) -> Option<SessionFile> {
    let metadata = std::fs::metadata(&path).ok()?;
    let modified = metadata.modified().ok()?;
    (metadata.is_file() && modified >= since).then_some(SessionFile {
        path,
        modified,
        size: metadata.len(),
    })
}

fn sorted_entries(directory: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return Vec::new();
    };
    let mut paths = entries
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .collect::<Vec<_>>();
    paths.sort();
    paths
}

/// Compares recorded working directories with the workspace root as the same directory,
/// resolving each recorded spelling once.
struct DirectoryMatcher<'a> {
    workspace_root: &'a Path,
    resolved: HashMap<String, bool>,
}

impl<'a> DirectoryMatcher<'a> {
    fn new(workspace_root: &'a Path) -> Self {
        Self {
            workspace_root,
            resolved: HashMap::new(),
        }
    }

    fn matches(&mut self, cwd: &str) -> bool {
        if let Some(matches) = self.resolved.get(cwd) {
            return *matches;
        }
        let path = Path::new(cwd);
        let matches = std::fs::canonicalize(path).map_or_else(
            |_| path == self.workspace_root,
            |canonical| canonical == self.workspace_root,
        );
        self.resolved.insert(cwd.to_owned(), matches);
        matches
    }
}

/// The working directory the session recorded first.
fn read_cwd(path: &Path) -> Option<String> {
    let file = File::open(path).ok()?;
    let records = RecordReader::new(file.take(CWD_PREFIX_BYTES));
    records
        .take(CWD_PREFIX_RECORDS)
        .flatten()
        .find_map(|record| record_cwd(&record).map(str::to_owned))
}

fn read_session(
    provider: AgentSessionProvider,
    file: &SessionFile,
    cancellation: Option<&CancellationToken>,
) -> Option<ParsedSession> {
    if file.size > MAX_TRANSCRIPT_BYTES {
        return None;
    }
    let open = || {
        File::open(&file.path).ok().map(|file| {
            let records = RecordReader::new(file.take(MAX_TRANSCRIPT_BYTES));
            match cancellation {
                Some(cancellation) => records.with_cancellation(cancellation),
                None => records,
            }
        })
    };
    let fallback_session_id = file
        .path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or_default();
    let canonical = match provider {
        AgentSessionProvider::ClaudeAgent => HashSet::new(),
        AgentSessionProvider::Codex => {
            let mut records = open()?;
            let canonical = codex_canonical_response_users(&mut records);
            if records.failed {
                return None;
            }
            canonical
        }
    };
    let mut records = open()?;
    let session = build_session(
        provider,
        &mut records,
        &canonical,
        fallback_session_id,
        &iso(file.modified),
    );
    (!records.failed).then_some(session).flatten()
}

fn iso(time: SystemTime) -> String {
    iso_millis(OffsetDateTime::from(time))
}

/// `YYYY-MM-DDTHH:MM:SS.mmmZ`, as JavaScript writes it, so imported timestamps sort with the
/// thread's other timestamps.
fn iso_millis(time: OffsetDateTime) -> String {
    let time = time.to_offset(time::UtcOffset::UTC);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        time.year(),
        u8::from(time.month()),
        time.day(),
        time.hour(),
        time.minute(),
        time.second(),
        time.millisecond()
    )
}

#[derive(Debug, Default, Deserialize)]
struct Record {
    #[serde(rename = "type")]
    kind: Option<String>,
    timestamp: Option<String>,
    cwd: Option<String>,
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
    #[serde(rename = "aiTitle")]
    ai_title: Option<String>,
    /// On `custom-title` records: the `/rename` name, or the title Claude generated.
    #[serde(rename = "customTitle")]
    custom_title: Option<String>,
    /// How the session was started (`cli`, `claude-desktop`, `sdk-*`); undocumented.
    entrypoint: Option<String>,
    #[serde(rename = "gitBranch")]
    git_branch: Option<String>,
    #[serde(rename = "isSidechain")]
    is_sidechain: Option<bool>,
    #[serde(rename = "isMeta")]
    is_meta: Option<bool>,
    #[serde(rename = "isCompactSummary")]
    is_compact_summary: Option<bool>,
    message: Option<RecordMessage>,
    payload: Option<RecordPayload>,
}

#[derive(Debug, Default, Deserialize)]
struct RecordMessage {
    content: Option<Content>,
    model: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct RecordPayload {
    id: Option<String>,
    session_id: Option<String>,
    #[serde(rename = "type")]
    kind: Option<String>,
    role: Option<String>,
    message: Option<String>,
    model: Option<String>,
    cwd: Option<String>,
    content: Option<Vec<ContentBlock>>,
    internal_chat_message_metadata_passthrough: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum Content {
    Text(String),
    Blocks(Vec<ContentBlock>),
}

#[derive(Debug, Deserialize)]
struct ContentBlock {
    #[serde(rename = "type")]
    kind: Option<String>,
    text: Option<String>,
}

fn extract_blocks(blocks: &[ContentBlock]) -> String {
    blocks
        .iter()
        .filter(|block| {
            matches!(
                block.kind.as_deref(),
                Some("text" | "input_text" | "output_text")
            )
        })
        .filter_map(|block| block.text.as_deref().map(str::trim))
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn extract_text(content: Option<&Content>) -> String {
    match content {
        Some(Content::Text(text)) => text.trim().to_owned(),
        Some(Content::Blocks(blocks)) => extract_blocks(blocks),
        None => String::new(),
    }
}

fn codex_turn_id(payload: &RecordPayload) -> Option<&str> {
    payload
        .internal_chat_message_metadata_passthrough
        .as_ref()?
        .get("turn_id")?
        .as_str()
        .filter(|turn_id| !turn_id.trim().is_empty())
}

fn is_message_item<'a>(record: &'a Record, role: &str) -> Option<&'a RecordPayload> {
    record.payload.as_ref().filter(|payload| {
        record.kind.as_deref() == Some("response_item")
            && payload.kind.as_deref() == Some("message")
            && payload.role.as_deref() == Some(role)
    })
}

/// Codex can write a response item carrying generated setup text beside the user's real
/// prompt. Response-user records are suppressed only when their shared turn ID and a verbatim
/// `user_message` event in the same turn prove which prompt the user submitted.
fn codex_canonical_response_users(records: impl Iterator<Item = Option<Record>>) -> HashSet<usize> {
    let mut canonical = HashSet::new();
    let mut event_texts = HashSet::new();
    let mut response_users: Vec<(usize, String, String)> = Vec::new();
    let mut finish_turn =
        |event_texts: &mut HashSet<String>, response_users: &mut Vec<(usize, String, String)>| {
            let turn_ids = response_users
                .iter()
                .filter(|(_, _, text)| event_texts.contains(text))
                .map(|(_, turn_id, _)| turn_id.clone())
                .collect::<HashSet<_>>();
            canonical.extend(
                response_users
                    .iter()
                    .filter(|(_, turn_id, _)| turn_ids.contains(turn_id))
                    .map(|(index, _, _)| *index),
            );
            event_texts.clear();
            response_users.clear();
        };
    for (index, record) in records.enumerate() {
        let Some(record) = record else { continue };
        if is_message_item(&record, "assistant").is_some() {
            finish_turn(&mut event_texts, &mut response_users);
        } else if let Some(text) = user_message_event(&record) {
            let text = text.trim();
            if !text.is_empty() {
                event_texts.insert(text.to_owned());
            }
        } else if let Some(payload) = is_message_item(&record, "user") {
            let text = extract_blocks(payload.content.as_deref().unwrap_or_default());
            if let Some(turn_id) = codex_turn_id(payload)
                && !text.is_empty()
            {
                response_users.push((index, turn_id.to_owned(), text));
            }
        }
    }
    finish_turn(&mut event_texts, &mut response_users);
    canonical
}

fn user_message_event(record: &Record) -> Option<&str> {
    let payload = record.payload.as_ref()?;
    (record.kind.as_deref() == Some("event_msg") && payload.kind.as_deref() == Some("user_message"))
        .then(|| payload.message.as_deref().unwrap_or_default())
}

struct RetainedMessage {
    sequence: usize,
    message: SessionMessage,
    /// The trimmed text before truncation, so copies of a long prompt still match.
    identity: u64,
    codex_response_user: bool,
}

fn text_identity(text: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    text.trim().hash(&mut hasher);
    hasher.finish()
}

/// Visible user and assistant text, ignoring tools, reasoning, and malformed records.
fn build_session(
    provider: AgentSessionProvider,
    records: impl Iterator<Item = Option<Record>>,
    canonical_response_users: &HashSet<usize>,
    fallback_session_id: &str,
    fallback_timestamp: &str,
) -> Option<ParsedSession> {
    // Claude names a transcript after its session; a Codex rollout name carries extra text,
    // so only its metadata provides a resumable ID.
    let mut session_id = match provider {
        AgentSessionProvider::ClaudeAgent => fallback_session_id.to_owned(),
        AgentSessionProvider::Codex => String::new(),
    };
    let mut has_codex_session_id = false;
    let mut title: Option<String> = None;
    let mut custom_title: Option<String> = None;
    let mut entrypoint: Option<String> = None;
    let mut model: Option<String> = None;
    let mut messages: VecDeque<RetainedMessage> = VecDeque::new();
    let mut first_user: Option<(usize, SessionMessage)> = None;
    let mut sequence = 0;
    let mut message_count = 0;
    let mut retain = |messages: &mut VecDeque<RetainedMessage>,
                      first_user: &mut Option<(usize, SessionMessage)>,
                      message_count: &mut usize,
                      role: &'static str,
                      text: &str,
                      timestamp: Option<&str>,
                      codex_response_user: bool| {
        sequence += 1;
        let message = SessionMessage {
            role,
            text: truncate_message(text),
            created_at: normalize_timestamp(timestamp, fallback_timestamp),
        };
        if first_user.is_none() && role == "user" {
            *first_user = Some((sequence, message.clone()));
        }
        messages.push_back(RetainedMessage {
            sequence,
            message,
            identity: text_identity(text),
            codex_response_user,
        });
        if messages.len() > MAX_IMPORTED_THREAD_MESSAGES {
            messages.pop_front();
        }
        *message_count += 1;
    };

    for (index, record) in records.enumerate() {
        let Some(record) = record else { continue };
        if provider == AgentSessionProvider::ClaudeAgent {
            if entrypoint.is_none() {
                entrypoint = trimmed(record.entrypoint.as_deref()).map(str::to_owned);
            }
            if record.is_sidechain == Some(true)
                || record.is_meta == Some(true)
                || record.is_compact_summary == Some(true)
            {
                continue;
            }
            if let Some(id) = trimmed(record.session_id.as_deref()) {
                session_id = id.to_owned();
            }
            if let Some(ai_title) = trimmed(record.ai_title.as_deref()) {
                title = Some(ai_title.to_owned());
            }
            if let Some(name) = custom_title_of(&record) {
                custom_title = Some(name.to_owned());
            }
            let message_model = record
                .message
                .as_ref()
                .and_then(|message| trimmed(message.model.as_deref()));
            // Claude uses this sentinel for local error responses; it cannot be resumed with.
            if let Some(message_model) = message_model.filter(|value| *value != "<synthetic>") {
                model = Some(message_model.to_owned());
            }
            let role = match record.kind.as_deref() {
                Some("user") => "user",
                Some("assistant") => "assistant",
                _ => continue,
            };
            let text = extract_text(
                record
                    .message
                    .as_ref()
                    .and_then(|message| message.content.as_ref()),
            );
            if !text.is_empty() {
                retain(
                    &mut messages,
                    &mut first_user,
                    &mut message_count,
                    role,
                    &text,
                    record.timestamp.as_deref(),
                    false,
                );
            }
            continue;
        }

        let payload = record.payload.as_ref();
        if record.kind.as_deref() == Some("session_meta") {
            let id = payload.and_then(|payload| {
                trimmed(payload.id.as_deref()).or_else(|| trimmed(payload.session_id.as_deref()))
            });
            if let Some(id) = id
                && !has_codex_session_id
            {
                session_id = id.to_owned();
                has_codex_session_id = true;
            }
            continue;
        }
        if record.kind.as_deref() == Some("turn_context")
            && let Some(turn_model) = payload.and_then(|payload| trimmed(payload.model.as_deref()))
        {
            model = Some(turn_model.to_owned());
            continue;
        }
        if let Some(text) = user_message_event(&record) {
            if text.trim().is_empty() {
                continue;
            }
            // Codex can write one prompt as both a response item and an event. Remove only the
            // matching response copy so mixed-format logs keep every distinct user message.
            let identity = text_identity(text);
            for position in (0..messages.len()).rev() {
                let candidate = &messages[position];
                if candidate.message.role == "assistant" {
                    break;
                }
                if candidate.codex_response_user && candidate.identity == identity {
                    if first_user
                        .as_ref()
                        .is_some_and(|(first, _)| *first == candidate.sequence)
                    {
                        first_user = None;
                    }
                    messages.remove(position);
                    message_count -= 1;
                    break;
                }
            }
            retain(
                &mut messages,
                &mut first_user,
                &mut message_count,
                "user",
                text,
                record.timestamp.as_deref(),
                false,
            );
            continue;
        }
        let Some((role, payload)) = is_message_item(&record, "user")
            .map(|payload| ("user", payload))
            .or_else(|| {
                is_message_item(&record, "assistant").map(|payload| ("assistant", payload))
            })
        else {
            continue;
        };
        let text = extract_blocks(payload.content.as_deref().unwrap_or_default());
        if text.is_empty() {
            continue;
        }
        if role == "user"
            && (canonical_response_users.contains(&index)
                || has_matching_event_in_turn(&messages, &text))
        {
            continue;
        }
        retain(
            &mut messages,
            &mut first_user,
            &mut message_count,
            role,
            &text,
            record.timestamp.as_deref(),
            role == "user",
        );
    }

    let (first_sequence, first_message) = first_user?;
    if session_id.trim().is_empty() {
        return None;
    }
    let first_retained = messages
        .iter()
        .any(|message| message.sequence == first_sequence);
    let mut retained = messages
        .into_iter()
        .map(|message| message.message)
        .collect::<Vec<_>>();
    if !first_retained {
        let keep_from = retained
            .len()
            .saturating_sub(MAX_IMPORTED_THREAD_MESSAGES - 1);
        retained.drain(..keep_from);
        retained.insert(0, first_message.clone());
    }
    Some(ParsedSession {
        session_id,
        title: custom_title
            .or(title)
            .or_else(|| prompt_title(&first_message.text))
            .unwrap_or_else(|| FALLBACK_TITLE.to_owned()),
        model,
        entrypoint,
        message_count,
        messages: retained,
    })
}

/// The first line of a prompt, at most [`MAX_TITLE_CHARS`] characters.
fn prompt_title(text: &str) -> Option<String> {
    text.trim()
        .split('\n')
        .next()
        .map(|line| line.chars().take(MAX_TITLE_CHARS).collect::<String>())
        .map(|line| line.trim().to_owned())
        .filter(|line| !line.is_empty())
}

fn custom_title_of(record: &Record) -> Option<&str> {
    (record.kind.as_deref() == Some("custom-title"))
        .then(|| trimmed(record.custom_title.as_deref()))
        .flatten()
}

fn has_matching_event_in_turn(messages: &VecDeque<RetainedMessage>, text: &str) -> bool {
    let identity = text_identity(text);
    for message in messages.iter().rev() {
        if message.message.role == "assistant" {
            return false;
        }
        if message.message.role == "user"
            && !message.codex_response_user
            && message.identity == identity
        {
            return true;
        }
    }
    false
}

fn trimmed(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

fn normalize_timestamp(value: Option<&str>, fallback: &str) -> String {
    value
        .and_then(|value| OffsetDateTime::parse(value.trim(), &Rfc3339).ok())
        .map_or_else(|| fallback.to_owned(), iso_millis)
}

fn truncate_message(text: &str) -> String {
    if text.len() <= MAX_MESSAGE_BYTES {
        return text.to_owned();
    }
    let mut end = MAX_MESSAGE_BYTES;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}{TRUNCATION_NOTE}", &text[..end])
}

/// JSONL records one line at a time. A line longer than [`MAX_RECORD_BYTES`] or not a record
/// yields `None`; more than [`MAX_TRANSCRIPT_RECORDS`] lines or a read error ends the
/// iteration with `failed` set.
struct RecordReader<R> {
    reader: BufReader<R>,
    buffer: Vec<u8>,
    lines: usize,
    /// Bytes of the lines returned so far, newlines included: where the next line starts.
    position: u64,
    failed: bool,
    cancellation: Option<CancellationToken>,
}

impl<R: Read> RecordReader<R> {
    fn new(reader: R) -> Self {
        Self {
            reader: BufReader::with_capacity(64 * 1024, reader),
            buffer: Vec::new(),
            lines: 0,
            position: 0,
            failed: false,
            cancellation: None,
        }
    }

    /// Stops between records once `cancellation` fires; the partial read counts as failed.
    fn with_cancellation(mut self, cancellation: &CancellationToken) -> Self {
        self.cancellation = Some(cancellation.clone());
        self
    }
}

impl<R: Read> Iterator for RecordReader<R> {
    type Item = Option<Record>;

    fn next(&mut self) -> Option<Self::Item> {
        if self
            .cancellation
            .as_ref()
            .is_some_and(CancellationToken::is_cancelled)
        {
            self.failed = true;
        }
        if self.failed {
            return None;
        }
        self.buffer.clear();
        let mut oversized = false;
        let mut started = false;
        loop {
            let available = match self.reader.fill_buf() {
                Ok(available) => available,
                Err(error) if error.kind() == ErrorKind::Interrupted => continue,
                Err(_) => {
                    self.failed = true;
                    return None;
                }
            };
            if available.is_empty() {
                if !started {
                    return None;
                }
                break;
            }
            started = true;
            let newline = available.iter().position(|byte| *byte == b'\n');
            let end = newline.unwrap_or(available.len());
            if !oversized {
                if self.buffer.len() + end > MAX_RECORD_BYTES {
                    oversized = true;
                    self.buffer = Vec::new();
                } else {
                    self.buffer.extend_from_slice(&available[..end]);
                }
            }
            let consumed = newline.map_or(end, |index| index + 1);
            self.position += consumed as u64;
            self.reader.consume(consumed);
            if newline.is_some() {
                break;
            }
        }
        self.lines += 1;
        if self.lines > MAX_TRANSCRIPT_RECORDS {
            self.failed = true;
            return None;
        }
        Some(
            (!oversized)
                .then(|| serde_json::from_slice(&self.buffer).ok())
                .flatten(),
        )
    }
}

#[cfg(test)]
mod tests;
