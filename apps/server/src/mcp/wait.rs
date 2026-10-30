//! `wait_for_thread`: a bounded long-poll on one thread (#139).
//!
//! The 2026-07-28 revision removed server-initiated requests, so turns are polled, not pushed.
//! A wait subscribes to the engine's event stream before its first read, keeps only the
//! thread's events, and re-reads one targeted wait state at most once per 100 ms burst. It
//! returns when the selected turn settles, the thread needs a person, delivery fails, the turn
//! errors, or the timeout passes. A timeout never cancels work. Returning, timing out, a
//! cancelled call, the setting turning off, and server shutdown all drop the receiver (#113),
//! and they end the call even while a read of the store is still pending.

use std::time::Duration;

use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};
use tokio::{
    sync::{broadcast::error::RecvError, watch},
    time::Instant,
};
use tokio_util::sync::CancellationToken;

use super::{
    control::{
        DISABLED_MESSAGE, DISABLED_TAG, MESSAGE_TEXT_CHARS, McpServerSettings, ProgressSink,
        ToolCall, derive_status,
    },
    protocol::{tool_result, typed_tool_failure},
};
use crate::persistence::Repositories;

pub const DEFAULT_TIMEOUT_MS: u64 = 30_000;
/// Under Codex's 60 s default tool timeout.
pub const MOST_TIMEOUT_MS: u64 = 50_000;
const REREAD_DELAY: Duration = Duration::from_millis(100);
const PROGRESS_EVERY: Duration = Duration::from_secs(10);

/// What one targeted read saw.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct WaitState {
    status: &'static str,
    turn_id: Option<String>,
    turn_state: Option<String>,
    /// The message is queued, or not yet admitted.
    queued: bool,
    queued_ahead: i64,
    settled: bool,
    error: Option<String>,
    reply: Option<Value>,
}

impl WaitState {
    fn done(&self) -> bool {
        self.settled
            || matches!(
                self.status,
                "awaiting_approval" | "awaiting_input" | "delivery_failed" | "error"
            )
    }

    fn progress_message(&self) -> String {
        if self.queued {
            match self.queued_ahead {
                0 => "queued".to_owned(),
                1 => "queued behind 1 message".to_owned(),
                ahead => format!("queued behind {ahead} messages"),
            }
        } else {
            self.status.to_owned()
        }
    }
}

pub(crate) async fn wait_for_thread(
    call: &ToolCall<'_>,
    progress: Option<(ProgressSink, Value)>,
) -> Result<Value, Value> {
    call.only(&["threadId", "messageId", "timeoutMs"])?;
    let thread_id = call.required("threadId")?.to_owned();
    let message_id = call.string("messageId")?.map(str::to_owned);
    let requested = call
        .integer("timeoutMs")?
        .map_or(DEFAULT_TIMEOUT_MS, |ms| u64::try_from(ms).unwrap_or(0));
    let effective_timeout_ms = requested.min(MOST_TIMEOUT_MS);
    let control = call.control;
    // The deadline, cancellation, shutdown and the off switch bound every read of the store
    // too, so a stalled read never holds the call past them.
    let deadline = Instant::now() + Duration::from_millis(effective_timeout_ms);
    // Subscribe before the first read, so no event between the read and the wait is missed.
    let mut events = control.engine().subscribe_events();
    let mut settings = control.settings_signal();
    let shutdown = control.shutdown_token();
    let ended = |stop: Stop, state: Option<&WaitState>| match (stop, state) {
        (Stop::Deadline, Some(state)) => Ok(finish(&thread_id, state, effective_timeout_ms, true)),
        (stop, _) => Err(stop.failure()),
    };
    match bounded(
        stopped(call, &shutdown, &mut settings, deadline),
        call.thread(&thread_id),
    )
    .await
    {
        Ok(found) => {
            found?;
        }
        Err(stop) => return ended(stop, None),
    }
    let read = || read_wait_state(control.repositories(), &thread_id, message_id.as_deref());
    let mut state = match bounded(stopped(call, &shutdown, &mut settings, deadline), read()).await {
        Ok(state) => state.map_err(storage_failure)?,
        Err(stop) => return ended(stop, None),
    };
    let mut progress = progress.map(|(sink, token)| Progress {
        sink,
        token,
        count: 0,
        last: None,
    });
    let mut reread_at: Option<Instant> = None;
    let mut ticker = tokio::time::interval_at(Instant::now() + PROGRESS_EVERY, PROGRESS_EVERY);
    loop {
        if let Some(progress) = &mut progress {
            progress.send_if_changed(&state).await;
        }
        if state.done() {
            return Ok(finish(&thread_id, &state, effective_timeout_ms, false));
        }
        tokio::select! {
            biased;
            stop = stopped(call, &shutdown, &mut settings, deadline) => {
                return ended(stop, Some(&state));
            }
            () = async { tokio::time::sleep_until(reread_at.unwrap_or(deadline)).await },
                if reread_at.is_some() =>
            {
                reread_at = None;
                state = match bounded(stopped(call, &shutdown, &mut settings, deadline), read())
                    .await
                {
                    Ok(read) => read.map_err(storage_failure)?,
                    Err(stop) => return ended(stop, Some(&state)),
                };
            }
            _ = ticker.tick() => {
                if let Some(progress) = &mut progress {
                    progress.send(&state).await;
                }
            }
            event = events.recv() => match event {
                Ok(event) if event.event.aggregate_id == thread_id => {
                    reread_at.get_or_insert_with(|| Instant::now() + REREAD_DELAY);
                }
                Ok(_) => {}
                Err(RecvError::Lagged(_)) => {
                    reread_at.get_or_insert_with(|| Instant::now() + REREAD_DELAY);
                }
                Err(RecvError::Closed) => return Err(Stop::Stopping.failure()),
            },
        }
    }
}

/// Why a wait ends before what it waits for.
enum Stop {
    Cancelled,
    Stopping,
    Disabled,
    Deadline,
}

impl Stop {
    /// The failure for every stop but a deadline that has a state to report. A deadline that
    /// passes before the first read answers has none.
    fn failure(self) -> Value {
        match self {
            Self::Cancelled => typed_tool_failure("McpCancelledError", "The wait was cancelled."),
            Self::Stopping => typed_tool_failure(
                "McpServerStoppingError",
                "This BiBCode server is shutting down; the work goes on. Wait again once it is back.",
            ),
            Self::Disabled => typed_tool_failure(DISABLED_TAG, DISABLED_MESSAGE),
            Self::Deadline => {
                tracing::warn!("wait_for_thread reached its deadline before the store answered");
                typed_tool_failure(
                    "McpStorageError",
                    "BiBCode's store did not answer before the wait ended; the work goes on. Wait again.",
                )
            }
        }
    }
}

/// Ends when the wait must: its call is cancelled, the server stops, the setting turns off,
/// or the deadline passes.
async fn stopped(
    call: &ToolCall<'_>,
    shutdown: &CancellationToken,
    settings: &mut watch::Receiver<McpServerSettings>,
    deadline: Instant,
) -> Stop {
    loop {
        if !settings.borrow_and_update().enabled {
            return Stop::Disabled;
        }
        tokio::select! {
            biased;
            () = call.cancellation.cancelled() => return Stop::Cancelled,
            () = shutdown.cancelled() => return Stop::Stopping,
            changed = settings.changed() => {
                if changed.is_err() {
                    return Stop::Disabled;
                }
            }
            () = tokio::time::sleep_until(deadline) => return Stop::Deadline,
        }
    }
}

/// `work`, unless `stop` ends first.
async fn bounded<T>(
    stop: impl Future<Output = Stop>,
    work: impl Future<Output = T>,
) -> Result<T, Stop> {
    tokio::select! {
        biased;
        value = work => Ok(value),
        stop = stop => Err(stop),
    }
}

struct Progress {
    sink: ProgressSink,
    token: Value,
    count: u64,
    last: Option<String>,
}

impl Progress {
    async fn send_if_changed(&mut self, state: &WaitState) {
        if self.last.as_deref() != Some(state.progress_message().as_str()) {
            self.send(state).await;
        }
    }

    /// Status only, never message text.
    async fn send(&mut self, state: &WaitState) {
        let message = state.progress_message();
        self.count += 1;
        let _ = self
            .sink
            .send(json!({
                "jsonrpc": "2.0",
                "method": "notifications/progress",
                "params": { "progressToken": self.token, "progress": self.count, "message": message },
            }))
            .await;
        self.last = Some(message);
    }
}

fn finish(thread_id: &str, state: &WaitState, effective_timeout_ms: u64, timed_out: bool) -> Value {
    tool_result(
        json!({
            "threadId": thread_id,
            "status": if state.queued && !state.done() { "queued" } else { state.status },
            "turnId": state.turn_id,
            "turnState": state.turn_state,
            "settled": state.settled,
            "timedOut": timed_out,
            "effectiveTimeoutMs": effective_timeout_ms,
            "queuedAhead": state.queued.then_some(state.queued_ahead),
            "error": state.error,
            "reply": state.reply,
        }),
        &[],
    )
}

fn storage_failure(error: impl std::fmt::Display) -> Value {
    tracing::warn!(%error, "wait_for_thread could not read the store");
    typed_tool_failure(
        "McpStorageError",
        "BiBCode could not read its store; try again.",
    )
}

/// One targeted read in a single SQLite job: the thread row, its session, the selected turn
/// and, with `message_id`, that message's delivery. The reply is the selected turn's own
/// assistant message, never the thread's newest one.
pub(crate) async fn read_wait_state(
    repositories: &Repositories,
    thread_id: &str,
    message_id: Option<&str>,
) -> crate::persistence::Result<WaitState> {
    let thread_id = thread_id.to_owned();
    let message_id = message_id.map(str::to_owned);
    repositories
        .database()
        .call(move |connection| {
            let (approvals, inputs, unresolved, latest_turn_id) = connection.query_row(
                "SELECT pending_approval_count, pending_user_input_count, unresolved_delivery_state, latest_turn_id FROM projection_threads WHERE thread_id = ?",
                [&thread_id],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?, row.get::<_, Option<String>>(2)?, row.get::<_, Option<String>>(3)?)),
            )?;
            let (session_status, session_error) = connection
                .query_row(
                    "SELECT status, last_error FROM projection_thread_sessions WHERE thread_id = ?",
                    [&thread_id],
                    |row| Ok((Some(row.get::<_, String>(0)?), row.get::<_, Option<String>>(1)?)),
                )
                .optional()?
                .unwrap_or((None, None));
            type Turn = (Option<String>, String, Option<String>);
            let turn: Option<Turn> = match &message_id {
                Some(message_id) => connection
                    .query_row(
                        "SELECT turn_id, state, assistant_message_id FROM projection_turns
                          WHERE thread_id = ?1 AND (pending_message_id = ?2
                             OR turn_id = (SELECT turn_id FROM projection_thread_messages WHERE message_id = ?2 AND thread_id = ?1))
                          ORDER BY (turn_id IS NULL) ASC, requested_at DESC LIMIT 1",
                        params![thread_id, message_id],
                        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                    )
                    .optional()?,
                None => match &latest_turn_id {
                    Some(turn_id) => connection
                        .query_row(
                            "SELECT turn_id, state, assistant_message_id FROM projection_turns WHERE thread_id = ? AND turn_id = ?",
                            params![thread_id, turn_id],
                            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                        )
                        .optional()?,
                    None => None,
                },
            };
            let delivery: Option<String> = match &message_id {
                Some(message_id) => connection
                    .query_row(
                        "SELECT state FROM provider_turn_outbox WHERE message_id = ? AND thread_id = ?",
                        params![message_id, thread_id],
                        |row| row.get(0),
                    )
                    .optional()?,
                None => None,
            };
            let message_failed = message_id.is_some()
                && matches!(delivery.as_deref(), Some("failed" | "uncertain"));
            let queued = message_id.is_some()
                && turn.is_none()
                && !message_failed
                && matches!(delivery.as_deref(), None | Some("queued" | "pending" | "prepared" | "sending"));
            let queued_ahead = match (&message_id, queued) {
                (Some(message_id), true) => connection.query_row(
                    "SELECT COUNT(*) FROM projection_thread_messages AS other
                      WHERE other.thread_id = ?1 AND other.delivery_state = 'queued' AND other.message_id <> ?2
                        AND (other.created_at, other.message_id) < (SELECT created_at, message_id FROM projection_thread_messages WHERE message_id = ?2)",
                    params![thread_id, message_id],
                    |row| row.get(0),
                )?,
                _ => 0,
            };
            let pending_work = message_id.is_none()
                && connection.query_row(
                    // A delivery not yet sent, or a turn admitted that the provider has not
                    // started yet.
                    "SELECT EXISTS(SELECT 1 FROM provider_turn_outbox WHERE thread_id = ?1 AND state IN ('queued', 'pending', 'prepared', 'sending'))
                         OR EXISTS(SELECT 1 FROM projection_turns WHERE thread_id = ?1 AND turn_id IS NULL AND state = 'running')",
                    [&thread_id],
                    |row| row.get::<_, bool>(0),
                )?;
            let turn_state = turn.as_ref().map(|turn| turn.1.clone());
            let turn_settled = matches!(turn_state.as_deref(), Some("completed" | "interrupted" | "error"));
            let session_busy = matches!(session_status.as_deref(), Some("running" | "starting"));
            let settled = match &message_id {
                Some(_) => turn_settled,
                // The whole thread: idle, and nothing waiting to start.
                None => !session_busy && !pending_work && turn_state.as_deref() != Some("running"),
            };
            let status = match (&message_id, turn_state.as_deref()) {
                // The selected turn's own outcome, whatever newer turns are doing.
                (Some(_), Some("completed")) => "completed",
                (Some(_), Some("interrupted")) => "interrupted",
                (Some(_), Some("error")) => "error",
                _ => derive_status(
                    approvals > 0,
                    inputs > 0,
                    message_failed || (message_id.is_none() && unresolved.is_some()),
                    session_status.as_deref(),
                    turn_state.as_deref(),
                ),
            };
            let reply = match turn.as_ref().and_then(|turn| turn.2.clone()) {
                Some(assistant) => connection
                    .query_row(
                        "SELECT message_id, substr(text, 1, ?), length(text), is_streaming FROM projection_thread_messages WHERE message_id = ?",
                        params![MESSAGE_TEXT_CHARS, assistant],
                        |row| Ok(json!({
                            "messageId": row.get::<_, String>(0)?,
                            "text": row.get::<_, String>(1)?,
                            "textLength": row.get::<_, i64>(2)?,
                            "streaming": row.get::<_, bool>(3)?,
                        })),
                    )
                    .optional()?,
                None => None,
            };
            Ok(WaitState {
                status,
                turn_id: turn.and_then(|turn| turn.0),
                turn_state,
                queued,
                queued_ahead,
                settled,
                error: (status == "error").then_some(session_error).flatten(),
                reply,
            })
        })
        .await
}
