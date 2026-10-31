//! The tools of no capability set (#139 slice X3): `server_capabilities`, which describes this
//! server, this connection and every error a tool returns, and `changes_since`, a durable,
//! content-free change feed an agent or a webhook receiver (slice X8) catches up with.
//!
//! `changes_since` reads two durable sequences, never a new table: the orchestration event log
//! (`orchestration_events.sequence`), mapped to thread transitions, and the agent activity log
//! (`mcp_activity.activity_id`, slice X1), for the work outside agents ran. Both page by a
//! monotonic id, never a timestamp, so entries written in the same second are never skipped.
//! The transition read ([`crate::persistence::Repositories::read_change_feed`]) extracts only
//! ids, enums and timestamps in SQL, so no prompt, message, summary or output is read into
//! memory, let alone returned.

use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::{
    auth::SCOPE_ORCHESTRATION_READ,
    mcp::{
        control::{
            Family, McpCapability, ProgressSink, ToolCall, ToolFuture, ToolResult, ToolSpec,
            invalid_argument, object_schema, storage_failure,
        },
        protocol::{self, Cut, fit_list, tool_result, typed_tool_failure},
    },
    persistence::{ActivityChangeRow, ChangeFeedQuery, TransitionRow},
};

const READ: &str = SCOPE_ORCHESTRATION_READ;
/// The most events one `changes_since` call scans.
pub(crate) const SCAN_LIMIT: usize = 5_000;
/// The most payload bytes of transition-type events one call lets SQLite parse. The scan stops
/// before the event that would pass it; the first event is always scanned, so a call progresses
/// past one larger payload.
pub(crate) const PARSE_BUDGET: usize = 4 * 1024 * 1024;
/// Entries per page: `(default, most)`.
const LIMIT: (i64, i64) = (100, 500);

/// The feed tools: always listed, read-only, at every ceiling.
pub(crate) const TOOLS: &[ToolSpec] = &[
    ToolSpec::client("server_capabilities", READ, &[])
        .reads()
        .in_set(None),
    ToolSpec::client("changes_since", READ, &[])
        .reads()
        .in_set(None),
];

pub(crate) const FAMILY: Family = Family {
    tools: TOOLS,
    text,
    call,
};

fn call<'a>(
    call: &'a ToolCall<'a>,
    name: &'a str,
    _progress: Option<(ProgressSink, Value)>,
) -> ToolFuture<'a> {
    Box::pin(async move {
        match name {
            "server_capabilities" => call.server_capabilities(),
            "changes_since" => call.changes_since().await,
            _ => Err(typed_tool_failure("McpUnknownToolError", "Unknown tool.")),
        }
    })
}

fn text(name: &str) -> Option<(&'static str, Value)> {
    Some(match name {
        "server_capabilities" => (
            "This BiBCode server and your connection: the server version, the MCP protocol versions, toolsVersion (a hash of the tools you can see now: list tools again when it changes), your effective access ceiling, which tool sets are on, the scopes your credential holds, and every error tag a tool returns with what it means and what fixes it.",
            object_schema(json!({}), &[]),
        ),
        "changes_since" => (
            "What changed since a cursor, as ids and states only, never text: threads and chat panels created or archived, turns requested, started, completed, interrupted or failed, session status, approvals and input requested or resolved (with the requestId when it is a plain id; otherwise list_pending_requests names it), and each change outside agents made through MCP (tool, outcome and a target of ids). Without a cursor it returns the current position and no entries: start there. Pass each call's cursor to the next; while more is true, call again at once. One call scans at most 5,000 events (fewer when their payloads are large) and returns its position even when nothing matched. A cursor older than the agent activity BiBCode keeps (7 days, 5,000 rows) sets activityDropped. Use one cursor with one threadId. Not in the feed: Git operations a person ran in the app, worktree and file changes, and profiler findings (profiler_findings has its own cursor).",
            object_schema(
                json!({
                    "cursor": { "type": "string", "description": "The cursor a previous call returned (the page's, or any entry's); omit it to start from now." },
                    "threadId": { "type": "string", "description": "Only this thread's changes." },
                    "limit": { "type": "integer", "minimum": 1, "maximum": LIMIT.1, "description": "Entries per call; 100 unless set." },
                }),
                &[],
            ),
        ),
        _ => return None,
    })
}

/// A position in both logs: `v1.<event sequence>.<activity id>`. Each entry's cursor is the
/// position just after it, so cursors increase strictly.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct Cursor {
    sequence: i64,
    activity: i64,
}

impl Cursor {
    fn parse(text: &str) -> Option<Self> {
        let mut parts = text.split('.');
        let (Some("v1"), Some(sequence), Some(activity), None) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            return None;
        };
        let position = |part: &str| {
            part.bytes()
                .all(|byte| byte.is_ascii_digit())
                .then(|| part.parse::<i64>().ok())
                .flatten()
        };
        Some(Self {
            sequence: position(sequence)?,
            activity: position(activity)?,
        })
    }

    fn text(self) -> String {
        format!("v1.{}.{}", self.sequence, self.activity)
    }
}

impl ToolCall<'_> {
    fn server_capabilities(&self) -> ToolResult {
        self.only(&[])?;
        let tools = self.control.tools(self.principal);
        let digest = Sha256::digest(tools.to_string().as_bytes());
        let capabilities = self.control.settings().capabilities;
        let sets: Map<String, Value> = McpCapability::ALL
            .iter()
            .map(|set| (set.key().to_owned(), capabilities.allows(*set).into()))
            .collect();
        Ok(tool_result(
            json!({
                "serverVersion": env!("CARGO_PKG_VERSION"),
                "protocolVersions": protocol::VERSIONS,
                "remoteProtocolVersion": crate::http::REMOTE_PROTOCOL_VERSION,
                "minCompatibleRemoteProtocol": crate::http::MIN_COMPATIBLE_REMOTE_PROTOCOL,
                "toolsVersion": crate::mcp::endpoint::hex(&digest[..8]),
                "ceiling": self.control.effective_ceiling(self.principal).as_str(),
                "capabilities": sets,
                "scopes": self.principal.principal.scopes,
                "errors": ERRORS
                    .iter()
                    .map(|(tag, meaning, fix)| json!({ "tag": tag, "meaning": meaning, "fix": fix }))
                    .collect::<Vec<_>>(),
                "otherErrors": "Any other tag is the error of the BiBCode operation the tool ran, as the app sees it; its message says what failed.",
            }),
            &[],
        ))
    }

    async fn changes_since(&self) -> ToolResult {
        self.only(&["cursor", "threadId", "limit"])?;
        let limit = match self.integer("limit")? {
            None => LIMIT.0,
            Some(limit) if (1..=LIMIT.1).contains(&limit) => limit,
            Some(_) => {
                return Err(invalid_argument(&format!("limit must be 1 to {}", LIMIT.1)));
            }
        };
        let limit = usize::try_from(limit).unwrap_or(1);
        let thread_id = match self.string("threadId")? {
            Some(id) if id.is_empty() || id.chars().count() > 256 => {
                return Err(invalid_argument("threadId must be 1 to 256 characters"));
            }
            id => id.map(str::to_owned),
        };
        let repositories = self.control.repositories();
        let Some(cursor) = self.string("cursor")? else {
            let (sequence, activity) = repositories
                .change_feed_heads()
                .await
                .map_err(storage_failure)?;
            return Ok(page(
                Cursor { sequence, activity },
                Vec::new(),
                false,
                false,
            ));
        };
        let cursor = Cursor::parse(cursor).ok_or_else(|| {
            invalid_argument(
                "cursor is not one changes_since returned; call it without a cursor to start from now",
            )
        })?;
        let read = repositories
            .read_change_feed(ChangeFeedQuery {
                after_sequence: cursor.sequence,
                after_activity: cursor.activity,
                thread_id,
                scan_limit: SCAN_LIMIT,
                parse_budget: PARSE_BUDGET,
                // One more than a page, to know whether more remain.
                activity_limit: limit + 1,
            })
            .await
            .map_err(storage_failure)?;
        if cursor.sequence > read.event_head || cursor.activity > read.activity_head {
            return Err(invalid_argument(
                "This cursor is ahead of this server's logs, so it comes from another BiBCode database. Call changes_since without a cursor to start from now.",
            ));
        }
        let activity_dropped = match read.oldest_activity {
            Some(oldest) => cursor.activity.saturating_add(1) < oldest,
            None => cursor.activity < read.activity_head,
        };

        // Events first, then activity rows, each in its own order.
        let mut entries = Vec::new();
        let mut position = cursor;
        let mut complete = true;
        for row in &read.transitions {
            let Some(mut entry) = transition(row) else {
                continue;
            };
            if entries.len() == limit {
                complete = false;
                break;
            }
            position.sequence = row.sequence;
            entry["cursor"] = position.text().into();
            entries.push(entry);
        }
        if complete {
            // Every event scanned was examined: the next call starts after the last one.
            position.sequence = read.scanned_to;
            for row in &read.activity {
                if entries.len() == limit {
                    complete = false;
                    break;
                }
                position.activity = row.activity_id;
                let mut entry = activity(row);
                entry["cursor"] = position.text().into();
                entries.push(entry);
            }
        }
        let more = !complete || read.more_events;
        let mut content = json!({ "entries": entries });
        if fit_list(&mut content, "/entries", Cut::Back, 1) > 0 {
            let last = content["entries"]
                .as_array()
                .and_then(|entries| entries.last())
                .and_then(|entry| entry["cursor"].as_str())
                .and_then(Cursor::parse);
            if let Some(last) = last {
                position = last;
            }
            return Ok(page(
                position,
                take_entries(content),
                true,
                activity_dropped,
            ));
        }
        Ok(page(
            position,
            take_entries(content),
            more,
            activity_dropped,
        ))
    }
}

fn take_entries(mut content: Value) -> Vec<Value> {
    match content["entries"].take() {
        Value::Array(entries) => entries,
        _ => Vec::new(),
    }
}

fn page(cursor: Cursor, entries: Vec<Value>, more: bool, activity_dropped: bool) -> Value {
    tool_result(
        json!({
            "cursor": cursor.text(),
            "entries": entries,
            "more": more,
            "activityDropped": activity_dropped,
        }),
        &[],
    )
}

const SESSION_STATUSES: &[&str] = &[
    "idle",
    "starting",
    "running",
    "ready",
    "interrupted",
    "stopped",
    "error",
];

/// The entry an event maps to, without its cursor; `None` for an event that is no transition.
fn transition(row: &TransitionRow) -> Option<Value> {
    let (kind, status) = match row.event_type.as_str() {
        "thread.created" if row.thread_kind.as_deref() == Some("panel") => ("panel.created", None),
        "thread.created" => ("thread.created", None),
        "thread.archived" => ("thread.archived", None),
        "thread.turn-start-requested" => ("turn.requested", None),
        "thread.session-set" => session_change(row)?,
        "thread.activity-appended" => match row.activity_kind.as_deref()? {
            "approval.requested" => ("approval.requested", None),
            "approval.resolved" => ("approval.resolved", Some("resolved")),
            "approval.expired" => ("approval.resolved", Some("expired")),
            "user-input.requested" => ("input.requested", None),
            "user-input.resolved" => ("input.resolved", Some("resolved")),
            "user-input.expired" => ("input.resolved", Some("expired")),
            _ => return None,
        },
        _ => return None,
    };
    let mut entry = json!({ "at": row.occurred_at, "kind": kind, "threadId": row.thread_id });
    if let Some(status) = status {
        entry["status"] = status.into();
    }
    // Only approval and input activities carry one (the read extracts it for nothing else).
    if let Some(request_id) = row.request_id.as_deref().filter(|id| is_id(id)) {
        entry["requestId"] = request_id.into();
    }
    if let Some(actor) = row.actor_json.as_deref().and_then(event_actor) {
        entry["actor"] = actor;
    }
    Some(entry)
}

/// A session update as a turn starting or ending, else as a new session status; `None` when
/// the status and turn did not change.
fn session_change(row: &TransitionRow) -> Option<(&'static str, Option<&'static str>)> {
    let status = SESSION_STATUSES
        .iter()
        .copied()
        .find(|known| row.status.as_deref() == Some(*known))?;
    let previous = row.previous_status.as_deref();
    let was_running = previous == Some("running");
    if status == "running" {
        if row.turn_id.is_some() && !(was_running && row.previous_turn_id == row.turn_id) {
            return Some(("turn.started", Some(status)));
        }
    } else if was_running {
        let kind = match status {
            "error" => "turn.failed",
            "interrupted" => "turn.interrupted",
            _ => "turn.completed",
        };
        return Some((kind, Some(status)));
    }
    (previous != Some(status)).then_some(("session.status", Some(status)))
}

/// An outside agent's work: the tool, its outcome and its target of ids (slice X1).
fn activity(row: &ActivityChangeRow) -> Value {
    let mut entry = json!({
        "at": row.occurred_at,
        "kind": "agent.call",
        "status": row.outcome,
        "actor": { "kind": "mcp-client", "clientId": row.session_id, "label": row.label },
        "tool": row.tool,
        "target": serde_json::from_str::<Value>(&row.target_json)
            .ok()
            .filter(Value::is_object)
            .unwrap_or_else(|| json!({})),
    });
    if let Some(thread_id) = &row.thread_id {
        entry["threadId"] = thread_id.as_str().into();
    }
    entry
}

/// An event's `metadata.actor`, kept to its kind, client id and label.
fn event_actor(json: &str) -> Option<Value> {
    let actor: Value = serde_json::from_str(json).ok()?;
    let field = |key: &str| actor.get(key).and_then(Value::as_str).map(str::to_owned);
    Some(json!({
        "kind": field("kind")?,
        "clientId": field("clientId")?,
        "label": field("label"),
    }))
}

/// A provider's request id is passed through as it gave it, so only a plain id is returned:
/// `[A-Za-z0-9_.:-]{1,128}`. Any other is left out; `list_pending_requests` names it.
fn is_id(id: &str) -> bool {
    (1..=128).contains(&id.len())
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b':' | b'-'))
}

/// Every error tag the MCP tools themselves return: `(tag, what it means, what fixes it)`.
/// A tool can also pass on the tag of the operation it ran (see `otherErrors`).
pub(crate) const ERRORS: &[(&str, &str, &str)] = &[
    (
        "McpServerDisabledError",
        "The MCP server is turned off for this environment.",
        "A person turns on Settings → Agents → Agent integrations → MCP server.",
    ),
    (
        "McpServerStoppingError",
        "This BiBCode server is shutting down.",
        "Retry once it is back.",
    ),
    (
        "McpCredentialRefusedError",
        "BiBCode refused this connection's credential: it was revoked (Stop or Revoke in Authorized clients) or expired. Over HTTP the server answers 401 instead of a tool result.",
        "Restart the MCP server in your agent to sign in again; a remote client reauthorizes.",
    ),
    (
        "McpServerUnreachableError",
        "The stdio relay could not reach a BiBCode server on its data root.",
        "Start or restart BiBCode, then retry the call.",
    ),
    (
        "McpSignInError",
        "The stdio relay could not sign in to BiBCode.",
        "Check that BiBCode runs with MCP server on, then restart the MCP server in your agent.",
    ),
    (
        "McpScopeError",
        "This credential does not hold the tool's scope (for terminals, terminal:operate).",
        "Reconnect with a credential that holds it; the terminal scope is granted only with Terminals on at Full access.",
    ),
    (
        "McpUnknownToolError",
        "No tool has this name for this credential.",
        "List tools again; toolsVersion tells when the list changed.",
    ),
    (
        "McpCapabilityDisabledError",
        "The tool's set is turned off for outside agents in this environment.",
        "A person turns the set on in Settings → Agents → Agent integrations.",
    ),
    (
        "McpAccessCeilingError",
        "The call needs more access than this connection has: it is read-only, the thread runs above its limit, or terminals need Full access.",
        "A person raises Agents may in Settings → Agents → Agent integrations; then restart the MCP server in your agent.",
    ),
    (
        "McpBusyError",
        "Too many calls, waits or keyed changes are in flight for this connection or environment.",
        "Retry when one of them returns.",
    ),
    (
        "McpInvalidArgumentError",
        "An argument is missing, of the wrong type, out of range or unknown.",
        "Correct it as the message and the tool's input schema say.",
    ),
    (
        "idempotency_conflict",
        "This clientRequestId was already used for a different call.",
        "Use a new clientRequestId.",
    ),
    (
        "McpCancelledError",
        "The call was cancelled; work started under a clientRequestId may still be running.",
        "Call again with the same clientRequestId to get its outcome.",
    ),
    (
        "McpOutcomeUnknownError",
        "BiBCode cannot tell whether the change ran: it was interrupted (off switch, read-only, revocation, shutdown or restart) or got no answer.",
        "Check the state (git_status, view_pull_request, read_thread), then retry with a new clientRequestId if it did not happen.",
    ),
    (
        "McpStreamEndedError",
        "An operation stopped reporting before its result, so its outcome is unknown.",
        "Check the state, then retry with a new clientRequestId if it did not happen.",
    ),
    (
        "McpPartialOutcomeError",
        "Part of a change landed and part did not; the result names each part.",
        "Run the tool and arguments in its recovery field, or check the state first.",
    ),
    (
        "McpStorageError",
        "BiBCode could not read or write its store.",
        "Retry.",
    ),
    (
        "McpToolError",
        "The operation failed without a more specific type.",
        "Read the message; retry only if it says the failure was temporary.",
    ),
    (
        "UpdateMaintenanceActiveError",
        "BiBCode is preparing an update and refuses changes until it finishes.",
        "Retry after the update.",
    ),
    (
        "McpThreadNotFoundError",
        "No live thread has this id.",
        "Use list_projects_and_threads to find it.",
    ),
    (
        "McpNotAHostThreadError",
        "A chat panel can only be opened on a host thread, and this thread is itself a panel.",
        "Open the panel on its host thread instead.",
    ),
    (
        "McpNotSameWorktreeError",
        "The two threads belong to different worktrees.",
        "Name a thread of the target's own worktree: its host or one of its panels.",
    ),
    (
        "McpSourceThreadNotOwnedError",
        "This agent neither opened the source thread nor sent its latest message.",
        "Name a panel this agent opened or last drove, or omit the source.",
    ),
    (
        "McpProjectNotFoundError",
        "No project has this id, or the thread's project is gone.",
        "Use list_projects_and_threads to find it.",
    ),
    (
        "McpRequestKindError",
        "The request id names an approval where a question was expected, or the reverse.",
        "Use the tool its answerWith names.",
    ),
    (
        "McpTurnRunningError",
        "A turn is running, and this change needs the thread idle.",
        "Wait for it (wait_for_thread) or interrupt it (interrupt_turn) first.",
    ),
    (
        "McpCheckpointRevertError",
        "Reverting to a checkpoint failed; the message says why.",
        "Read the thread, fix what the message names, then retry.",
    ),
    (
        "McpAttachmentExpiredError",
        "A stored request's attachment upload is gone (it expires after 10 minutes idle, or on restart).",
        "Send it again without the clientRequestId.",
    ),
    (
        "McpNoTurnDiffError",
        "This thread has no turn with recorded changes yet.",
        "Ask again after a turn changed files.",
    ),
    (
        "McpNotAWorktreeError",
        "This thread works in its project's folder, or in a worktree another thread hosts.",
        "Pass the hosting thread's id, as the message says.",
    ),
    (
        "McpPruneImpactTooLongError",
        "The removal would prune more stale worktrees than a plan can show.",
        "Remove this worktree in the BiBCode app.",
    ),
    (
        "McpTerminalsUnavailableError",
        "This server cannot reach its terminals now.",
        "Retry once it is back.",
    ),
    (
        "McpTerminalNotFoundError",
        "The thread has no terminal with this id (a closed terminal is gone).",
        "Use terminal_list, or open one with terminal_open.",
    ),
    (
        "McpTerminalExitedError",
        "The terminal's process has exited; its output stays readable.",
        "Open a new terminal.",
    ),
    (
        "McpProfilerUnavailableError",
        "This server has no profiler storage it can read.",
        "Diagnose through the other diagnostics tools.",
    ),
    (
        "McpProfilerReadError",
        "The profiler records could not be read.",
        "Retry.",
    ),
    (
        "McpCrashNotFoundError",
        "No crash record has this id.",
        "Use profiler_status for the newest crash ids.",
    ),
    (
        "PreviewAutomationNoAvailableHostError",
        "No BiBCode window can show this thread's browser preview.",
        "Ask the person to open BiBCode on the thread, then try again.",
    ),
    (
        "DevicePreviewsDisabledError",
        "Device previews are off on this server.",
        "A person turns on device previews in BiBCode.",
    ),
    (
        "DeviceBusyError",
        "Another thread is using this device.",
        "Use another device, or wait until that thread closes it.",
    ),
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_cursor_round_trips_and_nothing_else_parses() {
        let cursor = Cursor {
            sequence: 42,
            activity: 7,
        };
        assert_eq!(Cursor::parse(&cursor.text()), Some(cursor));
        for bad in [
            "",
            "v1",
            "v1.1",
            "v1.1.2.3",
            "v2.1.2",
            "v1.-1.2",
            "v1.+1.2",
            "v1.a.2",
            "v1.1.99999999999999999999",
        ] {
            assert_eq!(Cursor::parse(bad), None, "{bad}");
        }
    }

    fn session(
        status: &str,
        turn: Option<&str>,
        previous: Option<(&str, Option<&str>)>,
    ) -> TransitionRow {
        TransitionRow {
            sequence: 1,
            event_type: "thread.session-set".into(),
            thread_id: "t".into(),
            occurred_at: "2026-10-31T00:00:00.000Z".into(),
            thread_kind: None,
            status: Some(status.into()),
            turn_id: turn.map(str::to_owned),
            previous_status: previous.map(|(status, _)| status.to_owned()),
            previous_turn_id: previous.and_then(|(_, turn)| turn.map(str::to_owned)),
            activity_kind: None,
            request_id: None,
            actor_json: None,
        }
    }

    #[test]
    fn a_session_update_is_a_turn_start_an_end_or_a_status() {
        let kind = |row: TransitionRow| transition(&row).map(|entry| entry["kind"].clone());
        assert_eq!(
            kind(session("running", Some("a"), None)),
            Some("turn.started".into())
        );
        assert_eq!(
            kind(session("running", Some("b"), Some(("running", Some("a"))))),
            Some("turn.started".into())
        );
        assert_eq!(
            kind(session("running", Some("a"), Some(("running", Some("a"))))),
            None
        );
        assert_eq!(
            kind(session("ready", None, Some(("running", Some("a"))))),
            Some("turn.completed".into())
        );
        assert_eq!(
            kind(session("interrupted", None, Some(("running", Some("a"))))),
            Some("turn.interrupted".into())
        );
        assert_eq!(
            kind(session("error", None, Some(("running", Some("a"))))),
            Some("turn.failed".into())
        );
        assert_eq!(
            kind(session("ready", None, Some(("starting", None)))),
            Some("session.status".into())
        );
        assert_eq!(kind(session("ready", None, Some(("ready", None)))), None);
        assert_eq!(
            kind(session("running", None, None)),
            Some("session.status".into())
        );
        assert_eq!(kind(session("something-new", None, None)), None);
    }

    /// Every `Mcp…Error` tag the MCP sources write is in the table, so `server_capabilities`
    /// explains every error an agent can meet. A family added later fails here until its
    /// tags are described.
    #[test]
    fn the_error_table_holds_every_tag_the_mcp_sources_return() {
        // Tags that are no tool result: the endpoint proof answer and the UI's activity stream.
        const NOT_TOOL_RESULTS: &[&str] = &["McpEndpointProofError", "McpActivityError"];
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut sources = vec![root.join("rpc/session.rs")];
        let mut folders = vec![root.join("mcp")];
        while let Some(folder) = folders.pop() {
            for entry in std::fs::read_dir(&folder).expect("mcp sources") {
                let path = entry.expect("entry").path();
                if path.is_dir() {
                    folders.push(path);
                } else if path.extension().is_some_and(|extension| extension == "rs") {
                    sources.push(path);
                }
            }
        }
        let known: Vec<&str> = ERRORS.iter().map(|(tag, _, _)| *tag).collect();
        let mut missing = std::collections::BTreeSet::new();
        for source in sources {
            let text = std::fs::read_to_string(&source).expect("source");
            for (start, _) in text.match_indices("\"Mcp") {
                let tag: String = text[start + 1..]
                    .chars()
                    .take_while(char::is_ascii_alphanumeric)
                    .collect();
                if tag.ends_with("Error")
                    && !known.contains(&tag.as_str())
                    && !NOT_TOOL_RESULTS.contains(&tag.as_str())
                {
                    missing.insert(tag);
                }
            }
        }
        assert!(missing.is_empty(), "describe these in ERRORS: {missing:?}");
    }
}
