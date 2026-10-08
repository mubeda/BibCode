//! Claude Code and Codex CLI sessions recorded on the server host, read for import into a
//! project's threads. Parsing and its skip rules follow T3 Code's `AgentSessionScanner`.
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

use crate::orchestration::engine::MAX_IMPORTED_THREAD_MESSAGES;

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
            let Some(session) = read_session(source.provider, &file) else {
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

/// Re-reads one session for import, requiring that it still records `workspace_root`.
pub(crate) fn load(
    source: &SessionSource,
    session_id: &str,
    workspace_root: &Path,
    now: SystemTime,
) -> Result<ParsedSession, LoadFailure> {
    if !is_resumable(source.provider, session_id) {
        return Err(LoadFailure::NotResumable);
    }
    let since = now
        .checked_sub(RECENT_WINDOW)
        .unwrap_or(SystemTime::UNIX_EPOCH);
    let codex_suffix = format!("-{session_id}.jsonl");
    let file = discover(source, since)
        .0
        .into_iter()
        .find(|file| {
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
        .ok_or(LoadFailure::NotFound)?;
    let cwd = read_cwd(&file.path).ok_or(LoadFailure::DifferentDirectory)?;
    if !DirectoryMatcher::new(workspace_root).matches(&cwd) {
        return Err(LoadFailure::DifferentDirectory);
    }
    let session = read_session(source.provider, &file).ok_or(LoadFailure::Unreadable)?;
    if session.session_id != session_id {
        return Err(LoadFailure::NotFound);
    }
    Ok(session)
}

/// Claude resumes only UUID sessions (T3 Code's pattern: hyphenated, version 1-8, RFC variant);
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
        let Ok(metadata) = std::fs::metadata(&path) else {
            return;
        };
        let Ok(modified) = metadata.modified() else {
            return;
        };
        if metadata.is_file() && modified >= since {
            files.push(SessionFile {
                path,
                modified,
                size: metadata.len(),
            });
        }
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
        .find_map(|record| {
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
            .map(str::to_owned)
        })
}

fn read_session(provider: AgentSessionProvider, file: &SessionFile) -> Option<ParsedSession> {
    if file.size > MAX_TRANSCRIPT_BYTES {
        return None;
    }
    let open = || {
        File::open(&file.path)
            .ok()
            .map(|file| file.take(MAX_TRANSCRIPT_BYTES))
    };
    let fallback_session_id = file
        .path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or_default();
    let canonical = match provider {
        AgentSessionProvider::ClaudeAgent => HashSet::new(),
        AgentSessionProvider::Codex => {
            let mut records = RecordReader::new(open()?);
            let canonical = codex_canonical_response_users(&mut records);
            if records.failed {
                return None;
            }
            canonical
        }
    };
    let mut records = RecordReader::new(open()?);
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
    let derived_title = first_message
        .text
        .trim()
        .split('\n')
        .next()
        .map(|line| line.chars().take(MAX_TITLE_CHARS).collect::<String>())
        .map(|line| line.trim().to_owned())
        .filter(|line| !line.is_empty());
    Some(ParsedSession {
        session_id,
        title: title
            .or(derived_title)
            .unwrap_or_else(|| FALLBACK_TITLE.to_owned()),
        model,
        message_count,
        messages: retained,
    })
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
    failed: bool,
}

impl<R: Read> RecordReader<R> {
    fn new(reader: R) -> Self {
        Self {
            reader: BufReader::with_capacity(64 * 1024, reader),
            buffer: Vec::new(),
            lines: 0,
            failed: false,
        }
    }
}

impl<R: Read> Iterator for RecordReader<R> {
    type Item = Option<Record>;

    fn next(&mut self) -> Option<Self::Item> {
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
            self.reader.consume(newline.map_or(end, |index| index + 1));
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
