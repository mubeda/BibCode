//! Who acted, and what outside agents did (#139, slice X1).
//!
//! **Attribution.** The actor of a command comes from the authenticated principal only:
//! [`principal_actor`] is `{ kind: "mcp-client", clientId, label }` for an `mcp-client`
//! session and `None` for anyone else, and the dispatch handlers attribute the command's
//! admission claim to it, so the engine stamps `metadata.actor` on every event it plans. No
//! client input decides it.
//!
//! **Activity.** [`McpActivity`] keeps one content-free row per mutating tool call that ran
//! work (`mcp_activity`: time, session, label, tool, thread, outcome tag, and a target of ids
//! and counts), pruned past 7 days or 5,000 rows, and knows which clients are active: a call
//! in flight or in the last 2 minutes, or an owned mutation running. `subscribeMcpActivity`
//! streams the last 200 rows, each new one, and the active clients.
//!
//! **Stop.** A person's Stop revokes the agent and announces it; [`watch_stops`] then
//! interrupts each running turn whose latest user message that agent sent. A plain
//! revocation interrupts nothing.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex, Weak},
    time::{Duration, Instant},
};

use rusqlite::params;
use serde_json::{Map, Value, json};
use tokio::sync::{broadcast, mpsc, watch};
use tokio_util::sync::CancellationToken;

use super::control::{
    Inner, McpControl, REQUEST_ROW_TTL_SECONDS, ToolCall, ToolSpec, invalid_argument, now_iso,
};
use crate::{
    auth::MCP_CLIENT_SUBJECT,
    orchestration::engine::MAX_THREAD_PURPOSE_CHARS,
    persistence::Database,
    rpc::{RpcRegistry, RpcSessionContext, RpcStreamChunk},
};

/// Rows the stream starts with.
pub(crate) const RECENT_ROWS: i64 = 200;
/// Rows kept, and for how long.
const KEPT_ROWS: i64 = 5_000;
const KEPT_DAYS: i64 = 7;
/// A client counts as active this long after its last call.
pub(crate) const ACTIVE_WINDOW: Duration = Duration::from_secs(120);
/// How often a stream re-checks who is active, so a client that went quiet drops off.
const ACTIVE_RECHECK: Duration = Duration::from_secs(15);
/// How often a cancelled keyed call's owned work is checked for its outcome, and for how long.
const OUTCOME_POLL: Duration = Duration::from_secs(2);
const OUTCOME_WAIT: Duration = Duration::from_secs(35 * 60);
const STREAM_CAPACITY: usize = 64;
const ROW_CAPACITY: usize = 256;
/// The longest id a target keeps.
const MOST_ID_CHARS: usize = 128;

/// The actor of a command sent with `context`'s credential: an outside agent's session, with
/// its Authorized clients label at dispatch time; `None` for anyone else.
pub(crate) async fn principal_actor(context: &RpcSessionContext) -> Option<Value> {
    let principal = context.principal()?;
    if principal.subject != MCP_CLIENT_SUBJECT {
        return None;
    }
    let label = context
        .current_client_metadata()
        .await
        .and_then(|client| client.label);
    Some(actor(&principal.session_id, label.as_deref()))
}

/// An outside agent as an actor.
pub(crate) fn actor(client_id: &str, label: Option<&str>) -> Value {
    json!({ "kind": "mcp-client", "clientId": client_id, "label": label })
}

/// The description of a tool's `purpose` argument.
pub(crate) const PURPOSE: &str = "Optional: why you are creating it, in at most 200 characters. BiBCode shows it with your name on what you create.";

impl ToolCall<'_> {
    /// The optional `purpose` argument: at most 200 characters, blank as absent.
    pub(crate) fn purpose(&self) -> Result<Option<String>, Value> {
        let purpose = self
            .string("purpose")?
            .map(str::trim)
            .filter(|purpose| !purpose.is_empty());
        if purpose.is_some_and(|purpose| purpose.chars().count() > MAX_THREAD_PURPOSE_CHARS) {
            return Err(invalid_argument(&format!(
                "purpose is at most {MAX_THREAD_PURPOSE_CHARS} characters"
            )));
        }
        Ok(purpose.map(str::to_owned))
    }
}

/// The activity log and the active clients of one environment.
#[derive(Clone)]
pub struct McpActivity {
    shared: Arc<Shared>,
}

struct Shared {
    database: Database,
    rows: broadcast::Sender<Value>,
    presence: Mutex<HashMap<String, Presence>>,
    presence_changed: watch::Sender<u64>,
}

#[derive(Default)]
struct Presence {
    label: Option<String>,
    calls: usize,
    owned: usize,
    last_call: Option<(Instant, String)>,
}

/// One row to record.
pub(crate) struct NewActivity {
    pub(crate) session_id: String,
    pub(crate) label: Option<String>,
    pub(crate) tool: String,
    pub(crate) thread_id: Option<String>,
    pub(crate) outcome: String,
    pub(crate) target: Value,
}

/// Holds a call's place among the active clients; dropping it ends the call.
pub(crate) struct CallPresence {
    activity: McpActivity,
    session_id: String,
}

impl Drop for CallPresence {
    fn drop(&mut self) {
        self.activity.update(&self.session_id, |presence| {
            presence.calls = presence.calls.saturating_sub(1);
            presence.last_call = Some((Instant::now(), now_iso()));
        });
    }
}

impl McpActivity {
    #[must_use]
    pub fn new(database: Database) -> Self {
        Self {
            shared: Arc::new(Shared {
                database,
                rows: broadcast::channel(ROW_CAPACITY).0,
                presence: Mutex::new(HashMap::new()),
                presence_changed: watch::channel(0).0,
            }),
        }
    }

    fn update(&self, session_id: &str, change: impl FnOnce(&mut Presence)) {
        {
            let mut presence = self
                .shared
                .presence
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            change(presence.entry(session_id.to_owned()).or_default());
        }
        self.shared
            .presence_changed
            .send_modify(|version| *version = version.wrapping_add(1));
    }

    /// Marks a call of `session_id` in flight until the guard drops.
    pub(crate) fn call_started(&self, session_id: &str, label: Option<String>) -> CallPresence {
        self.update(session_id, |presence| {
            presence.calls += 1;
            presence.label = label;
            presence.last_call = Some((Instant::now(), now_iso()));
        });
        CallPresence {
            activity: self.clone(),
            session_id: session_id.to_owned(),
        }
    }

    /// An owned mutation of `session_id` started (`true`) or settled (`false`).
    pub(crate) fn owned_changed(&self, session_id: &str, started: bool) {
        self.update(session_id, |presence| {
            if started {
                presence.owned += 1;
            } else {
                presence.owned = presence.owned.saturating_sub(1);
            }
        });
    }

    /// Each client with a call in flight or in the last 2 minutes, or an owned mutation
    /// running, most recent first.
    #[must_use]
    pub(crate) fn active(&self) -> Vec<Value> {
        let now = Instant::now();
        let mut presence = self
            .shared
            .presence
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let busy = |entry: &Presence| entry.calls > 0 || entry.owned > 0;
        let recent = |entry: &Presence| {
            entry
                .last_call
                .as_ref()
                .is_some_and(|(at, _)| now.duration_since(*at) < ACTIVE_WINDOW)
        };
        presence.retain(|_, entry| busy(entry) || recent(entry));
        let mut active: Vec<(&String, &Presence)> = presence.iter().collect();
        active.sort_by(|left, right| {
            let at = |entry: &Presence| entry.last_call.as_ref().map(|(at, _)| *at);
            at(right.1).cmp(&at(left.1))
        });
        active
            .into_iter()
            .map(|(session_id, entry)| {
                json!({
                    "clientId": session_id,
                    "label": entry.label,
                    "lastCallAt": entry.last_call.as_ref().map(|(_, at)| at),
                    "running": busy(entry),
                })
            })
            .collect()
    }

    /// Writes one row and sends it to every stream. A failure is logged, never returned: the
    /// call it describes already happened.
    pub(crate) async fn record(&self, row: NewActivity) {
        let occurred_at = now_iso();
        let target = row.target.to_string();
        let NewActivity {
            session_id,
            label,
            tool,
            thread_id,
            outcome,
            target: target_value,
        } = row;
        let cutoff = (time::OffsetDateTime::now_utc() - time::Duration::days(KEPT_DAYS))
            .format(&time::format_description::well_known::Rfc3339)
            .unwrap_or_default();
        let inserted = {
            let (session_id, label, tool, thread_id, outcome, occurred_at) = (
                session_id.clone(),
                label.clone(),
                tool.clone(),
                thread_id.clone(),
                outcome.clone(),
                occurred_at.clone(),
            );
            self.shared
                .database
                .call(move |connection| {
                    let transaction = connection.transaction()?;
                    transaction.execute(
                        "INSERT INTO mcp_activity (occurred_at, session_id, label, tool, thread_id, outcome, target_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
                        params![occurred_at, session_id, label, tool, thread_id, outcome, target],
                    )?;
                    let id = transaction.last_insert_rowid();
                    transaction.execute(
                        "DELETE FROM mcp_activity WHERE occurred_at < ? OR activity_id <= ? - ?",
                        params![cutoff, id, KEPT_ROWS],
                    )?;
                    transaction.commit()?;
                    Ok(id)
                })
                .await
        };
        match inserted {
            Ok(id) => {
                let _ = self.shared.rows.send(json!({
                    "id": id,
                    "occurredAt": occurred_at,
                    "clientId": session_id,
                    "label": label,
                    "tool": tool,
                    "threadId": thread_id,
                    "outcome": outcome,
                    "target": target_value,
                }));
            }
            Err(error) => {
                tracing::warn!(%error, tool, "MCP activity could not be recorded");
            }
        }
    }

    /// The newest rows, newest first.
    pub(crate) async fn recent(&self) -> crate::persistence::Result<Vec<Value>> {
        self.shared
            .database
            .call(|connection| {
                let mut statement = connection.prepare_cached(
                    "SELECT activity_id, occurred_at, session_id, label, tool, thread_id, outcome, target_json FROM mcp_activity ORDER BY activity_id DESC LIMIT ?",
                )?;
                let rows = statement
                    .query_map([RECENT_ROWS], |row| {
                        let target: String = row.get(7)?;
                        Ok(json!({
                            "id": row.get::<_, i64>(0)?,
                            "occurredAt": row.get::<_, String>(1)?,
                            "clientId": row.get::<_, String>(2)?,
                            "label": row.get::<_, Option<String>>(3)?,
                            "tool": row.get::<_, String>(4)?,
                            "threadId": row.get::<_, Option<String>>(5)?,
                            "outcome": row.get::<_, String>(6)?,
                            "target": serde_json::from_str::<Value>(&target).unwrap_or_else(|_| json!({})),
                        }))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(rows)
            })
            .await
    }

    fn snapshot_value(&self, rows: Vec<Value>, active: Vec<Value>) -> Value {
        json!({ "type": "snapshot", "rows": rows, "active": active })
    }
}

/// Registers `subscribeMcpActivity` (`access:read`): a snapshot of the last 200 rows and the
/// active clients, then each new row and each change of who is active.
pub(crate) fn register_mcp_activity_rpc(registry: &mut RpcRegistry, activity: McpActivity) {
    registry.register_stream("subscribeMcpActivity", move |_request, cancellation| {
        activity_stream(activity.clone(), cancellation)
    });
}

fn activity_stream(
    activity: McpActivity,
    cancellation: CancellationToken,
) -> mpsc::Receiver<RpcStreamChunk> {
    let (sender, receiver) = mpsc::channel(STREAM_CAPACITY);
    tokio::spawn(async move {
        let send = |value: Value| {
            let sender = sender.clone();
            let cancellation = cancellation.clone();
            async move {
                tokio::select! {
                    () = cancellation.cancelled() => false,
                    sent = sender.send(Ok(vec![value])) => sent.is_ok(),
                }
            }
        };
        let mut rows = activity.shared.rows.subscribe();
        let mut presence = activity.shared.presence_changed.subscribe();
        let snapshot = match activity.recent().await {
            Ok(recent) => recent,
            Err(error) => {
                tracing::warn!(%error, "MCP activity could not be read");
                let _ = sender
                    .send(Err(json!({
                        "_tag": "McpActivityError",
                        "message": "BiBCode could not read the agent activity; try again.",
                    })))
                    .await;
                return;
            }
        };
        let mut active = activity.active();
        if !send(activity.snapshot_value(snapshot, active.clone())).await {
            return;
        }
        let mut recheck = tokio::time::interval(ACTIVE_RECHECK);
        recheck.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            let next = tokio::select! {
                () = cancellation.cancelled() => break,
                row = rows.recv() => match row {
                    Ok(row) => json!({ "type": "row", "row": row }),
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        let Ok(recent) = activity.recent().await else { break };
                        active = activity.active();
                        activity.snapshot_value(recent, active.clone())
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                },
                changed = presence.changed() => {
                    if changed.is_err() {
                        break;
                    }
                    let now = activity.active();
                    if now == active {
                        continue;
                    }
                    active = now;
                    json!({ "type": "active", "active": active })
                }
                _ = recheck.tick() => {
                    let now = activity.active();
                    if now == active {
                        continue;
                    }
                    active = now;
                    json!({ "type": "active", "active": active })
                }
            };
            if !send(next).await {
                break;
            }
        }
    });
    receiver
}

/// Whether a keyed call is a retry: its `clientRequestId` already has a live row, so the work
/// ran (or runs) under the first call, which has its own row.
pub(crate) async fn is_retry(
    control: &McpControl,
    session_id: &str,
    arguments: &Map<String, Value>,
) -> bool {
    let Some(client_request_id) = arguments
        .get("clientRequestId")
        .and_then(Value::as_str)
        .map(str::to_owned)
    else {
        return false;
    };
    let session_id = session_id.to_owned();
    let cutoff = (time::OffsetDateTime::now_utc()
        - time::Duration::seconds(REQUEST_ROW_TTL_SECONDS))
    .format(&time::format_description::well_known::Rfc3339)
    .unwrap_or_default();
    control
        .repositories()
        .database()
        .call(move |connection| {
            // The `bibcode thread` CLI's requests share one scope (see `stored_request`).
            Ok(connection.query_row(
                "SELECT EXISTS (SELECT 1 FROM mcp_tool_requests WHERE client_request_id = ?2 AND created_at >= ?4 AND session_id = COALESCE((SELECT CASE WHEN client_label = ?3 THEN ?3 ELSE session_id END FROM auth_sessions WHERE session_id = ?1), ?1))",
                params![session_id, client_request_id, super::thread_cli::LABEL, cutoff],
                |row| row.get::<_, bool>(0),
            )?)
        })
        .await
        .unwrap_or_else(|error| {
            tracing::warn!(%error, "MCP activity could not check for a retry");
            false
        })
}

/// Records the row of a mutating call that ran work. A keyed call cancelled while its owned
/// mutation goes on is recorded once that work's outcome is written.
pub(crate) async fn settle(
    control: &McpControl,
    session_id: &str,
    label: Option<String>,
    spec: &ToolSpec,
    arguments: &Map<String, Value>,
    result: &Value,
) {
    let activity = control.activity().clone();
    let tool = spec.name.to_owned();
    let keyed = arguments
        .get("clientRequestId")
        .and_then(Value::as_str)
        .map(str::to_owned);
    if let (Some(client_request_id), "McpCancelledError") = (keyed, outcome_of(result).as_str()) {
        let database = control.repositories().database().clone();
        let session_id = session_id.to_owned();
        let arguments = arguments.clone();
        let shutdown = control.shutdown_token();
        tokio::spawn(async move {
            let deadline = Instant::now() + OUTCOME_WAIT;
            while Instant::now() < deadline {
                let (id, scope) = (client_request_id.clone(), session_id.clone());
                let stored = database
                    .call(move |connection| {
                        Ok(connection.query_row(
                            "SELECT state, outcome_json FROM mcp_tool_requests WHERE client_request_id = ?2 AND session_id = COALESCE((SELECT CASE WHEN client_label = ?3 THEN ?3 ELSE session_id END FROM auth_sessions WHERE session_id = ?1), ?1)",
                            params![scope, id, super::thread_cli::LABEL],
                            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
                        )?)
                    })
                    .await;
                match stored {
                    Ok((state, Some(outcome))) if state != "running" => {
                        let outcome = serde_json::from_str(&outcome).unwrap_or(Value::Null);
                        activity
                            .record(row(&session_id, label, &tool, &arguments, &outcome))
                            .await;
                        return;
                    }
                    Ok(_) => {}
                    Err(error) => {
                        tracing::warn!(%error, tool, "MCP activity could not read an outcome");
                        return;
                    }
                }
                tokio::select! {
                    () = shutdown.cancelled() => return,
                    () = tokio::time::sleep(OUTCOME_POLL) => {}
                }
            }
        });
        return;
    }
    activity
        .record(row(session_id, label, &tool, arguments, result))
        .await;
}

fn row(
    session_id: &str,
    label: Option<String>,
    tool: &str,
    arguments: &Map<String, Value>,
    result: &Value,
) -> NewActivity {
    let content = &result["structuredContent"];
    let thread_id = [arguments.get("threadId"), content.get("threadId")]
        .into_iter()
        .flatten()
        .find_map(safe_id)
        .map(str::to_owned);
    NewActivity {
        session_id: session_id.to_owned(),
        label,
        tool: tool.to_owned(),
        thread_id,
        outcome: outcome_of(result),
        target: target(arguments, content),
    }
}

/// `success`, or the typed failure's tag.
fn outcome_of(result: &Value) -> String {
    if result["isError"] == true {
        result["structuredContent"]["error"]["_tag"]
            .as_str()
            .and_then(|tag| safe_id(&Value::from(tag)).map(str::to_owned))
            .unwrap_or_else(|| "McpToolError".to_owned())
    } else {
        "success".to_owned()
    }
}

/// What a call acted on, as ids and counts only: never a path, message, branch name or output.
fn target(arguments: &Map<String, Value>, content: &Value) -> Value {
    let mut target = Map::new();
    if let Some(sha) = content.get("sha").and_then(hex_id) {
        target.insert("sha".to_owned(), sha.into());
    }
    if let Some(sha) = arguments.get("sha").and_then(hex_id) {
        target.insert("revertedSha".to_owned(), sha.into());
    }
    if let Some(number) = content
        .get("number")
        .or_else(|| arguments.get("number"))
        .and_then(Value::as_u64)
    {
        target.insert("pullRequest".to_owned(), number.into());
    }
    for (key, name) in [
        ("worktreeKey", "worktreeKey"),
        ("cloneId", "cloneId"),
        ("transferId", "transferId"),
    ] {
        if let Some(id) = content.get(key).and_then(safe_id) {
            target.insert(name.to_owned(), id.into());
        }
    }
    if let Some(paths) = arguments.get("paths").and_then(Value::as_array) {
        target.insert("fileCount".to_owned(), paths.len().into());
    }
    Value::Object(target)
}

/// An id made of letters, digits, `-`, `_`, `.` and `:` only.
fn safe_id(value: &Value) -> Option<&str> {
    value.as_str().filter(|id| {
        !id.is_empty()
            && id.len() <= MOST_ID_CHARS
            && id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ':'))
    })
}

fn hex_id(value: &Value) -> Option<&str> {
    value
        .as_str()
        .filter(|sha| (4..=64).contains(&sha.len()) && sha.chars().all(|c| c.is_ascii_hexdigit()))
}

/// Interrupts the running turns of each agent a person stops, until `McpControl` shuts down.
/// The listener holds the service weakly, so it never keeps a dropped one alive.
pub(crate) fn watch_stops(control: &McpControl) {
    let Ok(runtime) = tokio::runtime::Handle::try_current() else {
        return;
    };
    let mut stops = control.auth().subscribe_mcp_stops();
    let inner: Weak<Inner> = Arc::downgrade(&control.inner);
    let shutdown = control.shutdown_token();
    runtime.spawn(async move {
        loop {
            let session_id = tokio::select! {
                () = shutdown.cancelled() => break,
                stopped = stops.recv() => match stopped {
                    Ok(session_id) => session_id,
                    Err(broadcast::error::RecvError::Lagged(missed)) => {
                        tracing::warn!(missed, "MCP Stop requests were missed");
                        continue;
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                },
            };
            let Some(inner) = inner.upgrade() else {
                break;
            };
            let control = McpControl { inner };
            interrupt_turns_of(&control, &session_id).await;
        }
    });
}

/// Interrupts each running turn whose latest sent user message `session_id`'s agent sent.
pub(crate) async fn interrupt_turns_of(control: &McpControl, session_id: &str) -> usize {
    let client_id = session_id.to_owned();
    let running = control
        .repositories()
        .database()
        .call(move |connection| {
            let mut statement = connection.prepare(
                "SELECT thread.thread_id, thread.latest_turn_id FROM projection_threads AS thread
                   JOIN projection_turns AS turn ON turn.thread_id = thread.thread_id AND turn.turn_id = thread.latest_turn_id
                  WHERE turn.state = 'running' AND thread.deleted_at IS NULL
                    AND json_extract((
                      SELECT message.actor_json FROM projection_thread_messages AS message
                       WHERE message.thread_id = thread.thread_id AND message.role = 'user'
                         AND COALESCE(message.delivery_state, '') <> 'queued'
                       ORDER BY message.created_at DESC, message.message_id DESC LIMIT 1
                    ), '$.clientId') = ?",
            )?;
            let rows = statement
                .query_map([client_id], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
        .await;
    let running = match running {
        Ok(running) => running,
        Err(error) => {
            tracing::warn!(%error, "MCP Stop could not read the agent's running turns");
            return 0;
        }
    };
    let mut interrupted = 0;
    for (thread_id, turn_id) in running {
        // The UI's stop button's path: the engine records it, then the provider is told. The
        // server sends it itself, so no principal's scope applies.
        let command = json!({
            "type": "thread.turn.interrupt",
            "commandId": format!("server:mcp-stop:{}", uuid::Uuid::new_v4()),
            "threadId": thread_id,
            "turnId": turn_id,
            "createdAt": now_iso(),
        });
        match control
            .registry()
            .invoke_local(
                "orchestration.dispatchCommand",
                command,
                RpcSessionContext::unauthenticated(),
                control.shutdown_token(),
            )
            .await
        {
            Ok(_) => interrupted += 1,
            Err(error) => {
                let tag = error["_tag"].as_str().unwrap_or("unknown");
                tracing::warn!(tag, "MCP Stop could not interrupt a turn");
            }
        }
    }
    interrupted
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_target_keeps_ids_and_counts_and_never_content() {
        let arguments = json!({
            "threadId": "t-1",
            "paths": ["secret/a.txt", "b.txt"],
            "summary": "a commit message",
            "sha": "abc123",
            "branch": "feature/x",
        });
        let content =
            json!({ "sha": "deadbeef", "number": 7, "worktreeKey": "wk-1", "message": "output" });
        let kept = target(arguments.as_object().unwrap(), &content);
        assert_eq!(
            kept,
            json!({ "sha": "deadbeef", "revertedSha": "abc123", "pullRequest": 7, "worktreeKey": "wk-1", "fileCount": 2 })
        );
        let text = kept.to_string();
        for leaked in ["secret", "commit message", "feature/x", "output"] {
            assert!(!text.contains(leaked), "{leaked}");
        }
        // A value that is not an id is dropped.
        let odd = target(
            &Map::new(),
            &json!({ "sha": "not hex", "worktreeKey": "../etc" }),
        );
        assert_eq!(odd, json!({}));
    }

    #[test]
    fn a_failure_records_its_tag() {
        let failure = super::super::protocol::typed_tool_failure("McpBusyError", "busy");
        assert_eq!(outcome_of(&failure), "McpBusyError");
        assert_eq!(outcome_of(&json!({ "structuredContent": {} })), "success");
    }

    async fn migrated() -> Database {
        let database = Database::open_in_memory().await.unwrap();
        database
            .call(|connection| {
                crate::persistence::run_migrations(connection, None)?;
                Ok(())
            })
            .await
            .unwrap();
        database
    }

    fn new_row(tool: &str) -> NewActivity {
        NewActivity {
            session_id: "s-1".to_owned(),
            label: Some("Claude Code".to_owned()),
            tool: tool.to_owned(),
            thread_id: Some("t-1".to_owned()),
            outcome: "success".to_owned(),
            target: json!({ "sha": "abc123" }),
        }
    }

    async fn next(receiver: &mut mpsc::Receiver<RpcStreamChunk>) -> Value {
        let chunk = tokio::time::timeout(Duration::from_secs(5), receiver.recv())
            .await
            .expect("in time")
            .expect("open")
            .expect("ok");
        chunk.into_iter().next().unwrap()
    }

    #[tokio::test]
    async fn the_stream_sends_recent_rows_then_each_new_row_and_who_is_active() {
        let activity = McpActivity::new(migrated().await);
        activity.record(new_row("git_commit")).await;
        let cancellation = CancellationToken::new();
        let mut stream = activity_stream(activity.clone(), cancellation.clone());
        let snapshot = next(&mut stream).await;
        assert_eq!(snapshot["type"], "snapshot");
        assert_eq!(snapshot["rows"][0]["tool"], "git_commit");
        assert_eq!(snapshot["rows"][0]["target"]["sha"], "abc123");
        assert_eq!(snapshot["active"], json!([]));

        activity.record(new_row("git_push")).await;
        let row = next(&mut stream).await;
        assert_eq!(row["type"], "row");
        assert_eq!(row["row"]["tool"], "git_push");
        assert_eq!(row["row"]["label"], "Claude Code");

        let _call = activity.call_started("s-1", Some("Claude Code".to_owned()));
        let active = next(&mut stream).await;
        assert_eq!(active["type"], "active");
        assert_eq!(active["active"][0]["clientId"], "s-1");
        cancellation.cancel();
    }

    #[tokio::test]
    async fn rows_past_the_retention_count_are_pruned() {
        let database = migrated().await;
        let activity = McpActivity::new(database.clone());
        database
            .call(|connection| {
                connection.execute_batch(
                    "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5000)
                     INSERT INTO mcp_activity (occurred_at, session_id, tool, outcome, target_json)
                     SELECT strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), 's', 'git_commit', 'success', '{}' FROM n;
                     INSERT INTO mcp_activity (occurred_at, session_id, tool, outcome, target_json)
                     VALUES ('2020-01-01T00:00:00Z', 's', 'old', 'success', '{}');",
                )?;
                Ok(())
            })
            .await
            .unwrap();
        activity.record(new_row("git_push")).await;
        let (count, old) = database
            .call(|connection| {
                Ok(connection.query_row(
                    "SELECT COUNT(*), SUM(tool = 'old') FROM mcp_activity",
                    [],
                    |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
                )?)
            })
            .await
            .unwrap();
        assert!(count <= KEPT_ROWS, "{count}");
        assert_eq!(old, 0, "a row older than 7 days is pruned");
        assert_eq!(activity.recent().await.unwrap().len(), 200);
    }

    #[tokio::test]
    async fn the_active_list_holds_calls_in_flight_and_owned_work() {
        let database = Database::open_in_memory().await.unwrap();
        let activity = McpActivity::new(database);
        assert!(activity.active().is_empty());
        let call = activity.call_started("s-1", Some("Claude Code".to_owned()));
        let active = activity.active();
        assert_eq!(active.len(), 1);
        assert_eq!(active[0]["clientId"], "s-1");
        assert_eq!(active[0]["label"], "Claude Code");
        assert_eq!(active[0]["running"], true);
        drop(call);
        // Still active for two minutes after its last call.
        assert_eq!(activity.active()[0]["running"], false);
        activity.owned_changed("s-1", true);
        assert_eq!(activity.active()[0]["running"], true);
        activity.owned_changed("s-1", false);
        assert_eq!(activity.active()[0]["running"], false);
    }
}
