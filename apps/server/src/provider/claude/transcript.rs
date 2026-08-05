use std::{
    fmt,
    fs::{File, OpenOptions},
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
};

#[cfg(unix)]
use std::fs::Metadata;

use serde_json::Value;
use sha2::{Digest, Sha256};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use tokio_util::sync::CancellationToken;

use super::activity::{ClaudeActivityInputSource, ClaudeActivityOutput, ClaudeActivityTracker};
use crate::activity::ProviderActivityMutation;

const MAX_TRANSCRIPT_PATH_SCALARS: usize = 4_096;
pub(crate) const MAX_TRANSCRIPT_TAIL_BYTES: usize = 10 * 1024 * 1024;
pub(crate) const MAX_RECOVERED_ENTRIES_PER_ACTOR: usize = 200;
const READ_CHUNK_BYTES: usize = 64 * 1024;

pub(crate) struct ClaudeTranscriptRecoveryRequest {
    path: PathBuf,
    root_session_id: String,
    agent_id: String,
    agent_type: String,
    generation: u64,
    not_before_unix_nanos: i128,
}

impl fmt::Debug for ClaudeTranscriptRecoveryRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ClaudeTranscriptRecoveryRequest")
            .field("path", &"<redacted>")
            .field("root_session_id", &self.root_session_id)
            .field("agent_id", &self.agent_id)
            .field("agent_type", &self.agent_type)
            .field("generation", &self.generation)
            .finish()
    }
}

impl ClaudeTranscriptRecoveryRequest {
    #[cfg_attr(not(unix), allow(dead_code))]
    pub(crate) fn from_authenticated_hook(value: &Value, correlated_actor: bool) -> Option<Self> {
        Self::from_authenticated_hook_for_epoch(value, correlated_actor, 0, i128::MIN)
    }

    pub(crate) fn from_authenticated_hook_for_epoch(
        value: &Value,
        correlated_actor: bool,
        generation: u64,
        not_before_unix_nanos: i128,
    ) -> Option<Self> {
        if !correlated_actor || field(value, "hook_event_name")? != "SubagentStop" {
            return None;
        }
        let raw_path = field(value, "agent_transcript_path")?;
        if raw_path.chars().count() > MAX_TRANSCRIPT_PATH_SCALARS
            || raw_path.chars().any(char::is_control)
        {
            return None;
        }
        let path = PathBuf::from(raw_path);
        if !path.is_absolute() {
            return None;
        }
        Some(Self {
            path,
            root_session_id: field(value, "session_id")?.to_owned(),
            agent_id: field(value, "agent_id")?.to_owned(),
            agent_type: field(value, "agent_type")?.to_owned(),
            generation,
            not_before_unix_nanos,
        })
    }
}

#[doc(hidden)]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClaudeTranscriptRecoveryRequestMetadata {
    pub root_session_id: String,
    pub agent_id: String,
    pub agent_type: String,
    pub has_child_path: bool,
    pub generation: u64,
    pub not_before_unix_nanos: i128,
}

impl From<&ClaudeTranscriptRecoveryRequest> for ClaudeTranscriptRecoveryRequestMetadata {
    fn from(request: &ClaudeTranscriptRecoveryRequest) -> Self {
        Self {
            root_session_id: request.root_session_id.clone(),
            agent_id: request.agent_id.clone(),
            agent_type: request.agent_type.clone(),
            has_child_path: !request.path.as_os_str().is_empty(),
            generation: request.generation,
            not_before_unix_nanos: request.not_before_unix_nanos,
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) enum ClaudeRecoveredActivity {
    Commentary {
        message_id: String,
        content_index: usize,
        text: String,
        created_at: String,
    },
    ToolUse {
        tool_use_id: String,
        tool_name: String,
        command: Option<String>,
        created_at: String,
    },
    ToolResult {
        tool_use_id: String,
        failed: bool,
        error: Option<String>,
        created_at: String,
    },
}

#[derive(Debug, Default)]
pub(crate) struct ClaudeParsedTranscript {
    pub(crate) correlation_validated: bool,
    pub(crate) records: Vec<ClaudeRecoveredActivity>,
    pub(crate) scanned_bytes: usize,
    cancelled: bool,
}

pub(crate) struct ClaudeRecoveredTranscript {
    pub(crate) root_session_id: String,
    pub(crate) agent_id: String,
    pub(crate) agent_type: String,
    pub(crate) records: Vec<ClaudeRecoveredActivity>,
    pub(crate) native_event_id: String,
    pub(crate) generation: u64,
    pub(crate) not_before_unix_nanos: i128,
}

impl ClaudeRecoveredActivity {
    fn created_at(&self) -> &str {
        match self {
            Self::Commentary { created_at, .. }
            | Self::ToolUse { created_at, .. }
            | Self::ToolResult { created_at, .. } => created_at,
        }
    }
}

pub(crate) fn parse_transcript_tail(
    root_session_id: &str,
    expected_agent_id: &str,
    bytes: &[u8],
) -> ClaudeParsedTranscript {
    parse_transcript_tail_cancellable(root_session_id, expected_agent_id, bytes, None)
}

fn parse_transcript_tail_cancellable(
    root_session_id: &str,
    expected_agent_id: &str,
    bytes: &[u8],
    cancellation: Option<&CancellationToken>,
) -> ClaudeParsedTranscript {
    let tail_start = bytes.len().saturating_sub(MAX_TRANSCRIPT_TAIL_BYTES);
    let start = if tail_start == 0 {
        0
    } else {
        bytes[tail_start..]
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(bytes.len(), |offset| tail_start + offset + 1)
    };
    let tail = &bytes[start..];
    let mut output = ClaudeParsedTranscript {
        scanned_bytes: tail.len(),
        ..ClaudeParsedTranscript::default()
    };
    for line in tail.split(|byte| *byte == b'\n') {
        if cancellation.is_some_and(CancellationToken::is_cancelled) {
            output.cancelled = true;
            break;
        }
        if output.records.len() >= MAX_RECOVERED_ENTRIES_PER_ACTOR {
            break;
        }
        let Ok(value) = serde_json::from_slice::<Value>(line) else {
            continue;
        };
        if value.get("sessionId").and_then(Value::as_str) != Some(root_session_id)
            || value.get("agentId").and_then(Value::as_str) != Some(expected_agent_id)
            || value.get("isSidechain").and_then(Value::as_bool) != Some(true)
        {
            continue;
        }
        output.correlation_validated = true;
        let Some(created_at) = value
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(normalized_timestamp)
        else {
            continue;
        };
        let Some(message) = value.get("message") else {
            continue;
        };
        let Some(content) = message.get("content").and_then(Value::as_array) else {
            continue;
        };
        match (
            value.get("type").and_then(Value::as_str),
            message.get("role").and_then(Value::as_str),
        ) {
            (Some("assistant"), Some("assistant")) => {
                let Some(message_id) = value
                    .get("uuid")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                else {
                    continue;
                };
                for (content_index, item) in content.iter().enumerate() {
                    if cancellation.is_some_and(CancellationToken::is_cancelled) {
                        output.cancelled = true;
                        break;
                    }
                    if output.records.len() >= MAX_RECOVERED_ENTRIES_PER_ACTOR {
                        break;
                    }
                    match item.get("type").and_then(Value::as_str) {
                        Some("text") => {
                            let Some(text) = item
                                .get("text")
                                .and_then(Value::as_str)
                                .map(str::trim)
                                .filter(|value| !value.is_empty())
                            else {
                                continue;
                            };
                            output.records.push(ClaudeRecoveredActivity::Commentary {
                                message_id: message_id.to_owned(),
                                content_index,
                                text: text.to_owned(),
                                created_at: created_at.clone(),
                            });
                        }
                        Some("tool_use") => {
                            let Some(tool_use_id) = item
                                .get("id")
                                .and_then(Value::as_str)
                                .map(str::trim)
                                .filter(|value| !value.is_empty())
                            else {
                                continue;
                            };
                            let Some(tool_name) = item
                                .get("name")
                                .and_then(Value::as_str)
                                .map(str::trim)
                                .filter(|value| !value.is_empty())
                            else {
                                continue;
                            };
                            let command = (tool_name == "Bash")
                                .then(|| item.pointer("/input/command").and_then(Value::as_str))
                                .flatten()
                                .map(str::to_owned);
                            output.records.push(ClaudeRecoveredActivity::ToolUse {
                                tool_use_id: tool_use_id.to_owned(),
                                tool_name: tool_name.to_owned(),
                                command,
                                created_at: created_at.clone(),
                            });
                        }
                        _ => {}
                    }
                }
            }
            (Some("user"), Some("user")) => {
                for item in content {
                    if cancellation.is_some_and(CancellationToken::is_cancelled) {
                        output.cancelled = true;
                        break;
                    }
                    if output.records.len() >= MAX_RECOVERED_ENTRIES_PER_ACTOR {
                        break;
                    }
                    if item.get("type").and_then(Value::as_str) != Some("tool_result") {
                        continue;
                    }
                    let Some(tool_use_id) = item
                        .get("tool_use_id")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                    else {
                        continue;
                    };
                    let failed = item
                        .get("is_error")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    let error = failed
                        .then(|| item.get("content").and_then(Value::as_str))
                        .flatten()
                        .map(str::to_owned);
                    output.records.push(ClaudeRecoveredActivity::ToolResult {
                        tool_use_id: tool_use_id.to_owned(),
                        failed,
                        error,
                        created_at: created_at.clone(),
                    });
                }
            }
            _ => {}
        }
    }
    output
}

#[derive(Debug)]
pub(crate) enum ClaudeTranscriptRead {
    Opened(Vec<u8>),
    Unavailable,
    Cancelled,
}

type BeforeOpen = Box<dyn FnOnce(&Path) + Send + 'static>;

async fn read_transcript_path(
    path: PathBuf,
    cancellation: CancellationToken,
    before_open: Option<BeforeOpen>,
) -> ClaudeTranscriptRead {
    tokio::task::spawn_blocking(move || {
        read_transcript_path_blocking(&path, &cancellation, before_open)
    })
    .await
    .unwrap_or(ClaudeTranscriptRead::Unavailable)
}

pub(crate) async fn recover_transcript(
    request: ClaudeTranscriptRecoveryRequest,
    cancellation: CancellationToken,
) -> Option<ClaudeRecoveredTranscript> {
    let ClaudeTranscriptRecoveryRequest {
        path,
        root_session_id,
        agent_id,
        agent_type,
        generation,
        not_before_unix_nanos,
    } = request;
    let ClaudeTranscriptRead::Opened(bytes) =
        read_transcript_path(path, cancellation.clone(), None).await
    else {
        return None;
    };
    let parsed =
        parse_transcript_tail_cancellable(&root_session_id, &agent_id, &bytes, Some(&cancellation));
    drop(bytes);
    if parsed.cancelled || !parsed.correlation_validated {
        return None;
    }
    let records = records_at_or_after(parsed.records, not_before_unix_nanos);
    Some(ClaudeRecoveredTranscript {
        native_event_id: recovery_native_event_id(&root_session_id, &agent_id),
        root_session_id,
        agent_id,
        agent_type,
        records,
        generation,
        not_before_unix_nanos,
    })
}

pub(crate) fn records_at_or_after(
    records: Vec<ClaudeRecoveredActivity>,
    not_before_unix_nanos: i128,
) -> Vec<ClaudeRecoveredActivity> {
    records
        .into_iter()
        .filter(|record| {
            OffsetDateTime::parse(record.created_at(), &Rfc3339)
                .is_ok_and(|created_at| created_at.unix_timestamp_nanos() >= not_before_unix_nanos)
        })
        .collect()
}

fn recovery_native_event_id(root_session_id: &str, agent_id: &str) -> String {
    let mut digest = Sha256::new();
    for value in [root_session_id, agent_id] {
        digest.update(u64::try_from(value.len()).unwrap_or(u64::MAX).to_be_bytes());
        digest.update(value.as_bytes());
    }
    let mut suffix = String::with_capacity(64);
    use std::fmt::Write as _;
    for byte in digest.finalize() {
        write!(&mut suffix, "{byte:02x}").expect("writing to String cannot fail");
    }
    format!("claude:recovery:{suffix}")
}

fn read_transcript_path_blocking(
    path: &Path,
    cancellation: &CancellationToken,
    before_open: Option<BeforeOpen>,
) -> ClaudeTranscriptRead {
    if cancellation.is_cancelled() {
        return ClaudeTranscriptRead::Cancelled;
    }
    let Ok(canonical_path) = std::fs::canonicalize(path) else {
        return ClaudeTranscriptRead::Unavailable;
    };
    if cancellation.is_cancelled() {
        return ClaudeTranscriptRead::Cancelled;
    }
    let Ok(before_metadata) = std::fs::metadata(&canonical_path) else {
        return ClaudeTranscriptRead::Unavailable;
    };
    if !before_metadata.file_type().is_file() {
        return ClaudeTranscriptRead::Unavailable;
    }
    #[cfg(windows)]
    let Ok(before_file) = open_no_follow(&canonical_path) else {
        return ClaudeTranscriptRead::Unavailable;
    };
    #[cfg(windows)]
    let Ok(before_identity) = windows_file_identity(&before_file) else {
        return ClaudeTranscriptRead::Unavailable;
    };
    if let Some(before_open) = before_open {
        before_open(&canonical_path);
    }
    if cancellation.is_cancelled() {
        return ClaudeTranscriptRead::Cancelled;
    }
    let Ok(mut file) = open_no_follow(&canonical_path) else {
        return ClaudeTranscriptRead::Unavailable;
    };
    let Ok(opened_metadata) = file.metadata() else {
        return ClaudeTranscriptRead::Unavailable;
    };
    #[cfg(unix)]
    let identity_matches = same_file_identity(&before_metadata, &opened_metadata);
    #[cfg(windows)]
    let identity_matches = windows_file_identity(&file)
        .is_ok_and(|opened_identity| opened_identity == before_identity);
    if !opened_metadata.file_type().is_file() || !identity_matches {
        return ClaudeTranscriptRead::Unavailable;
    }
    let length = opened_metadata.len();
    let tail_bytes = u64::try_from(MAX_TRANSCRIPT_TAIL_BYTES).unwrap_or(u64::MAX);
    let start = length.saturating_sub(tail_bytes);
    if file.seek(SeekFrom::Start(start)).is_err() {
        return ClaudeTranscriptRead::Unavailable;
    }
    let mut remaining = usize::try_from(length.saturating_sub(start))
        .unwrap_or(MAX_TRANSCRIPT_TAIL_BYTES)
        .min(MAX_TRANSCRIPT_TAIL_BYTES);
    let mut bytes = Vec::with_capacity(remaining);
    let mut chunk = [0_u8; READ_CHUNK_BYTES];
    while remaining > 0 {
        if cancellation.is_cancelled() {
            return ClaudeTranscriptRead::Cancelled;
        }
        let chunk_length = remaining.min(chunk.len());
        let Ok(read) = file.read(&mut chunk[..chunk_length]) else {
            return ClaudeTranscriptRead::Unavailable;
        };
        if read == 0 {
            break;
        }
        bytes.extend_from_slice(&chunk[..read]);
        remaining -= read;
    }
    if start > 0 {
        let Some(newline) = bytes.iter().position(|byte| *byte == b'\n') else {
            return ClaudeTranscriptRead::Opened(Vec::new());
        };
        bytes.drain(..=newline);
    }
    ClaudeTranscriptRead::Opened(bytes)
}

#[cfg(unix)]
fn open_no_follow(path: &Path) -> std::io::Result<File> {
    use std::os::unix::fs::OpenOptionsExt;

    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
}

#[cfg(unix)]
fn same_file_identity(before: &Metadata, opened: &Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;

    before.dev() == opened.dev() && before.ino() == opened.ino()
}

#[cfg(windows)]
fn open_no_follow(path: &Path) -> std::io::Result<File> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;

    OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
}

#[cfg(windows)]
fn windows_file_identity(file: &File) -> std::io::Result<(u32, u64)> {
    use std::{mem::MaybeUninit, os::windows::io::AsRawHandle};
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle,
    };

    let mut information = MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::zeroed();
    // SAFETY: `information` is writable storage for the exact Win32 structure,
    // and `file` keeps the borrowed operating-system handle alive for the call.
    let succeeded =
        unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, information.as_mut_ptr()) };
    if succeeded == 0 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: a nonzero return means Windows initialized the structure.
    let information = unsafe { information.assume_init() };
    Ok((
        information.dwVolumeSerialNumber,
        (u64::from(information.nFileIndexHigh) << 32) | u64::from(information.nFileIndexLow),
    ))
}

fn windows_file_identity_matches(
    before_volume_serial: Option<u32>,
    before_file_index: Option<u64>,
    opened_volume_serial: Option<u32>,
    opened_file_index: Option<u64>,
) -> bool {
    matches!(
        (
            before_volume_serial,
            before_file_index,
            opened_volume_serial,
            opened_file_index,
        ),
        (
            Some(before_volume_serial),
            Some(before_file_index),
            Some(opened_volume_serial),
            Some(opened_file_index),
        ) if before_volume_serial == opened_volume_serial && before_file_index == opened_file_index
    )
}

fn normalized_timestamp(value: &str) -> Option<String> {
    OffsetDateTime::parse(value, &Rfc3339)
        .ok()?
        .format(&Rfc3339)
        .ok()
}

#[doc(hidden)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ClaudeTranscriptReadFixtureOutput {
    pub opened: bool,
    pub cancelled: bool,
    pub bytes_read: usize,
}

#[doc(hidden)]
pub struct ClaudeTranscriptReaderFixture;

#[doc(hidden)]
impl ClaudeTranscriptReaderFixture {
    #[must_use]
    pub fn windows_identity_matches(
        before_volume_serial: Option<u32>,
        before_file_index: Option<u64>,
        opened_volume_serial: Option<u32>,
        opened_file_index: Option<u64>,
    ) -> bool {
        windows_file_identity_matches(
            before_volume_serial,
            before_file_index,
            opened_volume_serial,
            opened_file_index,
        )
    }

    pub async fn read(path: &Path, cancelled: bool) -> ClaudeTranscriptReadFixtureOutput {
        let cancellation = CancellationToken::new();
        if cancelled {
            cancellation.cancel();
        }
        read_fixture_output(read_transcript_path(path.to_path_buf(), cancellation, None).await)
    }

    #[cfg(unix)]
    pub async fn read_after_metadata_replacement(
        path: &Path,
        replacement: &Path,
    ) -> ClaudeTranscriptReadFixtureOutput {
        let replacement = replacement.to_path_buf();
        let before_open: BeforeOpen = Box::new(move |canonical_path| {
            let _ = std::fs::remove_file(canonical_path);
            let _ = std::os::unix::fs::symlink(&replacement, canonical_path);
        });
        read_fixture_output(
            read_transcript_path(
                path.to_path_buf(),
                CancellationToken::new(),
                Some(before_open),
            )
            .await,
        )
    }
}

fn read_fixture_output(read: ClaudeTranscriptRead) -> ClaudeTranscriptReadFixtureOutput {
    match read {
        ClaudeTranscriptRead::Opened(bytes) => ClaudeTranscriptReadFixtureOutput {
            opened: true,
            cancelled: false,
            bytes_read: bytes.len(),
        },
        ClaudeTranscriptRead::Unavailable => ClaudeTranscriptReadFixtureOutput {
            opened: false,
            cancelled: false,
            bytes_read: 0,
        },
        ClaudeTranscriptRead::Cancelled => ClaudeTranscriptReadFixtureOutput {
            opened: false,
            cancelled: true,
            bytes_read: 0,
        },
    }
}

#[doc(hidden)]
#[derive(Debug)]
pub struct ClaudeTranscriptFixtureOutput {
    pub correlation_validated: bool,
    pub mutations: Vec<ProviderActivityMutation>,
    pub scanned_bytes: usize,
}

#[doc(hidden)]
pub struct ClaudeTranscriptFixtureAdapter {
    root_session_id: String,
    tracker: ClaudeActivityTracker,
}

#[doc(hidden)]
impl ClaudeTranscriptFixtureAdapter {
    #[must_use]
    pub fn new(root_session_id: &str) -> Self {
        Self {
            root_session_id: root_session_id.to_owned(),
            tracker: ClaudeActivityTracker::new(root_session_id),
        }
    }

    #[must_use]
    pub fn recover(
        root_session_id: &str,
        agent_id: &str,
        agent_type: &str,
        bytes: &[u8],
    ) -> ClaudeTranscriptFixtureOutput {
        let parsed = parse_transcript_tail(root_session_id, agent_id, bytes);
        let mut tracker = ClaudeActivityTracker::new(root_session_id);
        let mutations = tracker
            .handle_recovered_records(agent_id, agent_type, &parsed.records)
            .mutations;
        ClaudeTranscriptFixtureOutput {
            correlation_validated: parsed.correlation_validated,
            mutations,
            scanned_bytes: parsed.scanned_bytes,
        }
    }

    #[must_use]
    pub fn recover_since(
        root_session_id: &str,
        agent_id: &str,
        agent_type: &str,
        bytes: &[u8],
        not_before: &str,
    ) -> ClaudeTranscriptFixtureOutput {
        let parsed = parse_transcript_tail(root_session_id, agent_id, bytes);
        let not_before_unix_nanos = OffsetDateTime::parse(not_before, &Rfc3339)
            .expect("fixture recovery cutoff must be RFC 3339")
            .unix_timestamp_nanos();
        let records = records_at_or_after(parsed.records, not_before_unix_nanos);
        let mut tracker = ClaudeActivityTracker::new(root_session_id);
        let mutations = tracker
            .handle_recovered_records(agent_id, agent_type, &records)
            .mutations;
        ClaudeTranscriptFixtureOutput {
            correlation_validated: parsed.correlation_validated,
            mutations,
            scanned_bytes: parsed.scanned_bytes,
        }
    }

    pub fn handle_hook(&mut self, value: &Value, emitted_at_ms: u64) -> ClaudeActivityOutput {
        self.tracker
            .handle_value(ClaudeActivityInputSource::HookInput, value, emitted_at_ms)
    }

    pub fn recover_bytes(
        &mut self,
        agent_id: &str,
        agent_type: &str,
        bytes: &[u8],
    ) -> ClaudeTranscriptFixtureOutput {
        let parsed = parse_transcript_tail(&self.root_session_id, agent_id, bytes);
        let mutations = self
            .tracker
            .handle_recovered_records(agent_id, agent_type, &parsed.records)
            .mutations;
        ClaudeTranscriptFixtureOutput {
            correlation_validated: parsed.correlation_validated,
            mutations,
            scanned_bytes: parsed.scanned_bytes,
        }
    }
}

fn field<'a>(value: &'a Value, name: &str) -> Option<&'a str> {
    value
        .get(name)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}
