//! `sendRequests.send`: a signed-in person's request to a specific chat agent. The request is
//! stored once per request id, then queued on the target as that person's own message with
//! its provenance (`message.personSend`), through the server-only command dispatcher. A
//! follower moves each request through its states from the target's turn events.

use rusqlite::{OptionalExtension as _, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::{broadcast, mpsc};
use tokio_util::sync::CancellationToken;

use super::store::{SendAction, SendRequestRow, SendRequestStore, SendState, StateChange};
use crate::{
    orchestration::{OrchestrationCommand, OrchestrationEngine, canonical_command_digest},
    persistence::{Database, OrchestrationEvent, ProjectionThread, Repositories},
    production::{
        orchestration_rpc::{ServerActor, ServerCommandDispatcher},
        thread_context::handoff_text,
    },
    rpc::{RpcSessionContext, RpcStreamChunk},
    transfer::staging::UploadOwner,
};

/// Note plus attachment text of one request, in Unicode scalar values.
pub(crate) const PERSON_REQUEST_MAX_CHARS: usize = 48_000;
/// The lead-in the client writes before the note, in Unicode scalar values.
pub(crate) const LEAD_IN_MAX_CHARS: usize = 16_000;
/// The answer text a request keeps, in Unicode scalar values.
pub(crate) const ANSWER_TEXT_MAX_CHARS: usize = 48_000;

/// The requests a `snapshot` or `page` event of `sendRequests.subscribe` carries.
pub(crate) const SEND_REQUESTS_PAGE_SIZE: usize = 100;
const SUBSCRIBE_CAPACITY: usize = 16;

const OPEN: [SendState; 4] = [
    SendState::Queued,
    SendState::Waiting,
    SendState::Delivered,
    SendState::Read,
];

/// The result of `sendRequests.cancel`: `cancelled` is false once the target took it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct SendRequestsCancelResult {
    pub(crate) request: SendRequest,
    pub(crate) cancelled: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SendRequestsGetAnswerResult {
    pub(crate) request_id: String,
    pub(crate) text: String,
    pub(crate) truncated: bool,
}

/// The wire input of `sendRequests.getHandoffText`: the thread the person clicked in and the
/// thread to read, which may be the same one.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SendRequestsGetHandoffTextInput {
    pub(crate) source_thread_id: String,
    pub(crate) thread_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SendRequestsGetHandoffTextResult {
    pub(crate) thread_id: String,
    pub(crate) text: String,
    pub(crate) left_out: usize,
    /// The first message, when it is included, and the tail.
    pub(crate) included_messages: usize,
}

/// The wire input of `sendRequests.getTerminalOutput`: the thread the person clicked in, and the
/// terminal to read with its owner thread.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SendRequestsGetTerminalOutputInput {
    pub(crate) source_thread_id: String,
    pub(crate) thread_id: String,
    pub(crate) terminal_id: String,
    pub(crate) source: TerminalTextSource,
    /// The part of a conversation to read; the output has one part only.
    pub(crate) part: TerminalTextPart,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum TerminalTextSource {
    Output,
    Conversation,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum TerminalTextPart {
    LastAnswer,
    Handoff,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SendRequestsGetTerminalOutputResult {
    pub(crate) thread_id: String,
    pub(crate) terminal_id: String,
    pub(crate) text: String,
    pub(crate) truncated: bool,
    pub(crate) used_source: TerminalTextSource,
    pub(crate) fell_back: bool,
    pub(crate) start_missing: bool,
}

/// The most terminal output one read returns, in Unicode scalar values.
pub(crate) const TERMINAL_OUTPUT_MAX_CHARS: usize = 16_000;

/// The last output of a terminal, without escape sequences.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct TerminalTail {
    pub(crate) text: String,
    /// Older output exists that the text leaves out.
    pub(crate) truncated: bool,
}

/// Read access to a terminal's retained output. It has no way to write to the terminal.
pub(crate) trait TerminalOutputSource: Send + Sync {
    fn tail<'a>(
        &'a self,
        owner_thread_id: &'a str,
        terminal_id: &'a str,
        max_chars: usize,
    ) -> futures_util::future::BoxFuture<'a, Result<TerminalTail, crate::terminal::TerminalError>>;

    /// The conversation a Claude AI Terminal's current observer recorded, if any.
    fn observed_conversation<'a>(
        &'a self,
        owner_thread_id: &'a str,
        terminal_id: &'a str,
    ) -> futures_util::future::BoxFuture<'a, Option<crate::provider_terminal::ObservedConversation>>;

    /// The main session that observer bound last.
    fn observed_session<'a>(
        &'a self,
        owner_thread_id: &'a str,
        terminal_id: &'a str,
    ) -> futures_util::future::BoxFuture<'a, Option<String>>;

    /// The environment the terminal's command was launched with, for the provider's folders.
    fn launch_environment<'a>(
        &'a self,
        owner_thread_id: &'a str,
        terminal_id: &'a str,
    ) -> futures_util::future::BoxFuture<'a, Vec<(std::ffi::OsString, std::ffi::OsString)>>;
}

impl TerminalOutputSource for crate::terminal::TerminalManager {
    fn observed_conversation<'a>(
        &'a self,
        owner_thread_id: &'a str,
        terminal_id: &'a str,
    ) -> futures_util::future::BoxFuture<'a, Option<crate::provider_terminal::ObservedConversation>>
    {
        Box::pin(self.observed_conversation(owner_thread_id, terminal_id))
    }

    fn observed_session<'a>(
        &'a self,
        owner_thread_id: &'a str,
        terminal_id: &'a str,
    ) -> futures_util::future::BoxFuture<'a, Option<String>> {
        Box::pin(self.observed_session(owner_thread_id, terminal_id))
    }

    fn launch_environment<'a>(
        &'a self,
        owner_thread_id: &'a str,
        terminal_id: &'a str,
    ) -> futures_util::future::BoxFuture<'a, Vec<(std::ffi::OsString, std::ffi::OsString)>> {
        Box::pin(self.launch_environment(owner_thread_id, terminal_id))
    }

    fn tail<'a>(
        &'a self,
        owner_thread_id: &'a str,
        terminal_id: &'a str,
        max_chars: usize,
    ) -> futures_util::future::BoxFuture<'a, Result<TerminalTail, crate::terminal::TerminalError>>
    {
        Box::pin(async move {
            let read = self
                .read_history(
                    owner_thread_id,
                    terminal_id,
                    None,
                    raw_window_chars(max_chars),
                )
                .await?;
            Ok(plain_tail(
                &read.window.text,
                read.window.start > 0,
                max_chars,
            ))
        })
    }
}

/// How many raw characters to read so `plain_tail` can return `max_chars` of plain text.
pub(crate) fn raw_window_chars(max_chars: usize) -> usize {
    // shortcut: an escape sequence longer than the extra window still leaks its payload when
    // its start is cut off, until the history reader can start a window at a sequence boundary.
    max_chars.saturating_mul(4)
}

/// The last `max_chars` of plain text in `raw`, the end of a terminal's retained output. Escape
/// sequences are removed before the limit applies, so a long sequence cannot be cut in half. Tab
/// and newline stay, every other C0 and C1 control character and DEL goes.
pub(crate) fn plain_tail(raw: &str, older_exists: bool, max_chars: usize) -> TerminalTail {
    let (stripped, _open) = crate::ansi::strip_escapes(raw);
    let text: String = stripped
        .chars()
        .filter(|c| matches!(c, '\t' | '\n') || !c.is_control())
        .collect();
    let count = text.chars().count();
    TerminalTail {
        text: text.chars().skip(count.saturating_sub(max_chars)).collect(),
        truncated: older_exists || count > max_chars,
    }
}

/// The conversation of a Claude AI Terminal, read off the async runtime. Every refusal is the
/// caller's cue to fall back to the output.
async fn conversation_text(
    reader: &dyn TerminalOutputSource,
    owner_thread_id: &str,
    terminal_id: &str,
) -> Result<crate::provider_terminal::ConversationText, crate::provider_terminal::ConversationRefusal>
{
    use crate::provider_terminal::ConversationRefusal;
    let observed = reader
        .observed_conversation(owner_thread_id, terminal_id)
        .await
        .ok_or(ConversationRefusal::NoObservedSession)?;
    let expected = reader
        .observed_session(owner_thread_id, terminal_id)
        .await
        .ok_or(ConversationRefusal::NoObservedSession)?;
    let config_dir = crate::provider::environment::claude_config_directory(
        &reader
            .launch_environment(owner_thread_id, terminal_id)
            .await,
    )
    .ok_or(ConversationRefusal::Unreadable)?;
    tokio::task::spawn_blocking(move || {
        crate::provider_terminal::read_claude_conversation(&observed, &expected, &config_dir)
    })
    .await
    .unwrap_or(Err(ConversationRefusal::Unreadable))
}

/// The part of a conversation the input asks for; `None` when it has none (no answer yet).
fn conversation_result(
    input: &SendRequestsGetTerminalOutputInput,
    conversation: crate::provider_terminal::ConversationText,
) -> Option<SendRequestsGetTerminalOutputResult> {
    let (text, truncated) = match input.part {
        TerminalTextPart::Handoff => (
            conversation.handoff.render(),
            conversation.handoff.truncated,
        ),
        TerminalTextPart::LastAnswer => {
            let answer = conversation.last_answer?;
            let count = answer.chars().count();
            (
                answer.chars().take(TERMINAL_OUTPUT_MAX_CHARS).collect(),
                count > TERMINAL_OUTPUT_MAX_CHARS,
            )
        }
    };
    (!text.trim().is_empty()).then(|| SendRequestsGetTerminalOutputResult {
        thread_id: input.thread_id.clone(),
        terminal_id: input.terminal_id.clone(),
        text,
        truncated,
        used_source: TerminalTextSource::Conversation,
        fell_back: false,
        start_missing: false,
    })
}

/// Sends one stream event; false when the stream was cancelled or closed.
async fn send_event(
    sender: &mpsc::Sender<RpcStreamChunk>,
    cancellation: &CancellationToken,
    event: Value,
) -> bool {
    tokio::select! {
        () = cancellation.cancelled() => false,
        sent = sender.send(Ok(vec![event])) => sent.is_ok(),
    }
}

/// One change of a stored request, as `sendRequests.subscribe` sends it on.
#[derive(Clone, Debug)]
pub(crate) enum RequestChange {
    Upsert(Box<SendRequestRow>),
    /// The request was removed with its source thread.
    Remove(String),
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SendRequestAttachment {
    pub(crate) label: String,
    pub(crate) text: String,
}

/// The wire input of `sendRequests.send`. It names no actor, mode or sender: the server
/// resolves them, so unknown fields are refused.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SendRequestsSendInput {
    pub(crate) request_id: String,
    pub(crate) action: String,
    pub(crate) source: String,
    pub(crate) target: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) taken_over: Option<String>,
    pub(crate) lead_in: String,
    pub(crate) note: String,
    pub(crate) attachments: Vec<SendRequestAttachment>,
}

/// One stored request as the client sees it; it carries no answer text.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SendRequest {
    pub(crate) request_id: String,
    pub(crate) project_id: String,
    pub(crate) action: &'static str,
    pub(crate) source: String,
    pub(crate) source_thread_id: String,
    pub(crate) target: String,
    pub(crate) target_thread_id: String,
    pub(crate) taken_over: Option<String>,
    pub(crate) target_message_id: Option<String>,
    pub(crate) state: &'static str,
    pub(crate) reason: Option<String>,
    pub(crate) answer_message_id: Option<String>,
    pub(crate) answering_turn_id: Option<String>,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
    pub(crate) dismissed_at: Option<String>,
}

impl From<&SendRequestRow> for SendRequest {
    fn from(row: &SendRequestRow) -> Self {
        Self {
            request_id: row.request_id.clone(),
            project_id: row.project_id.clone(),
            action: row.action.as_str(),
            source: row.source_address.clone(),
            source_thread_id: row.source_thread_id.clone(),
            target: row.target_address.clone(),
            target_thread_id: row.target_thread_id.clone(),
            taken_over: row.taken_over_address.clone(),
            target_message_id: row.target_message_id.clone(),
            state: row.state.as_str(),
            reason: row.reason.clone(),
            answer_message_id: row.answer_message_id.clone(),
            answering_turn_id: row.answering_turn_id.clone(),
            created_at: row.created_at.clone(),
            updated_at: row.updated_at.clone(),
            dismissed_at: row.dismissed_at.clone(),
        }
    }
}

/// The typed refusal every `sendRequests.*` method sends.
pub(crate) fn refusal(reason: &str, message: &str) -> Value {
    json!({ "_tag": "SendRequestError", "reason": reason, "message": message })
}

fn storage(error: impl std::fmt::Display) -> Value {
    tracing::warn!(%error, "a send request could not use the store");
    refusal(
        "storage",
        "BiBCode could not read or save this request. Try again.",
    )
}

/// Refuses an outside agent's session. Only a signed-in person (any other subject) or an
/// unauthenticated server, which has no principal, may use a `sendRequests.*` method.
pub(crate) fn require_person(context: &RpcSessionContext) -> Result<(), Value> {
    if context
        .principal()
        .is_some_and(|principal| principal.subject == crate::auth::MCP_CLIENT_SUBJECT)
    {
        return Err(refusal(
            "person_only",
            "Only a signed-in person can send a request to an agent.",
        ));
    }
    Ok(())
}

/// The message a request queues: the non-empty parts joined by a blank line. The lead-in is
/// trimmed at its end, the note on both sides, then each attachment follows its label.
pub(crate) fn compose_message_text(
    lead_in: &str,
    note: &str,
    attachments: &[(String, String)],
) -> String {
    [lead_in.trim_end().to_owned(), note.trim().to_owned()]
        .into_iter()
        .chain(
            attachments
                .iter()
                .map(|(label, text)| format!("=== {label} ===\n{text}")),
        )
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// A parsed agent address: the thread it lives on, and whether it is a terminal agent.
struct Address {
    thread_id: String,
    terminal: bool,
}

fn parse_address(address: &str) -> Option<Address> {
    let valid = |part: &str| !part.is_empty() && !part.contains(['/', ' ', '\t', '\n', '\r']);
    if let Some(thread_id) = address.strip_prefix("thread:") {
        return valid(thread_id).then(|| Address {
            thread_id: thread_id.to_owned(),
            terminal: false,
        });
    }
    let (thread_id, terminal_id) = address.strip_prefix("terminal:")?.split_once('/')?;
    (valid(thread_id) && valid(terminal_id)).then(|| Address {
        thread_id: thread_id.to_owned(),
        terminal: true,
    })
}

fn invalid(message: &str) -> Value {
    refusal("invalid", message)
}

#[derive(Clone)]
pub(crate) struct SendRequestsService {
    store: SendRequestStore,
    repositories: Repositories,
    dispatcher: ServerCommandDispatcher,
    changes: broadcast::Sender<RequestChange>,
    terminal_output: Option<std::sync::Arc<dyn TerminalOutputSource>>,
    /// Held across a dispatch, and by a cancel that finds no delivery yet, so a cancelled
    /// request is never queued afterwards.
    // shortcut: one gate for every request; a per-request lock if person sends ever contend.
    dispatch_gate: std::sync::Arc<tokio::sync::Mutex<()>>,
    /// Held across each store write and its publication, so changes are published in the order
    /// they were stored. Taken after `dispatch_gate`, never before it.
    publish_order: std::sync::Arc<tokio::sync::Mutex<()>>,
}

impl SendRequestsService {
    pub(crate) fn new(
        database: Database,
        repositories: Repositories,
        dispatcher: ServerCommandDispatcher,
    ) -> Self {
        Self {
            store: SendRequestStore::new(database),
            repositories,
            dispatcher,
            changes: broadcast::channel(256).0,
            terminal_output: None,
            dispatch_gate: std::sync::Arc::default(),
            publish_order: std::sync::Arc::default(),
        }
    }

    // Production attaches the terminal manager in `production/runtime.rs`, which this change
    // could not edit; until then only tests call it.
    #[cfg_attr(not(test), expect(dead_code))]
    pub(crate) fn with_terminal_output(
        mut self,
        source: std::sync::Arc<dyn TerminalOutputSource>,
    ) -> Self {
        self.terminal_output = Some(source);
        self
    }

    pub(crate) fn subscribe_changes(&self) -> broadcast::Receiver<RequestChange> {
        self.changes.subscribe()
    }

    /// Stores one state change (a compare and set from `from`) and publishes it. Every request
    /// transition goes through here. `None` when the stored state is not in `from`.
    pub(crate) async fn apply(
        &self,
        request_id: &str,
        from: &[SendState],
        change: StateChange,
    ) -> crate::persistence::Result<Option<SendRequestRow>> {
        let _order = self.publish_order.lock().await;
        let row = self.store.transition(request_id, from, change).await?;
        if let Some(row) = &row {
            let _ = self
                .changes
                .send(RequestChange::Upsert(Box::new(row.clone())));
        }
        Ok(row)
    }

    /// Spawns the follower: one sweep of every open request, then the target threads' events.
    pub(crate) fn start_follower(&self, engine: OrchestrationEngine, shutdown: CancellationToken) {
        // Subscribed before the sweep, so no event between the two is missed.
        let events = engine.subscribe_events();
        let service = self.clone();
        tokio::spawn(async move {
            service.sweep().await;
            service.follow(events, shutdown).await;
        });
    }

    /// Re-reads the requests an event may concern. The broadcast is lossy, so an event only
    /// names a thread to read again, and a lag reads every open request again.
    pub(crate) async fn follow(
        &self,
        mut events: broadcast::Receiver<OrchestrationEvent>,
        shutdown: CancellationToken,
    ) {
        loop {
            let event = tokio::select! {
                // A stopped follower reads no further event, even one already waiting.
                biased;
                () = shutdown.cancelled() => return,
                event = events.recv() => event,
            };
            match event {
                Ok(event) => self.on_event(&event).await,
                Err(broadcast::error::RecvError::Lagged(_)) => self.sweep().await,
                Err(broadcast::error::RecvError::Closed) => return,
            }
        }
    }

    async fn on_event(&self, event: &OrchestrationEvent) {
        let event = &event.event;
        if event.aggregate_kind != "thread" {
            return;
        }
        // A streamed assistant chunk changes no request; the completed message does.
        if event.event_type == "thread.message-sent"
            && event.payload.get("streaming").and_then(Value::as_bool) == Some(true)
        {
            return;
        }
        let thread_id = event.aggregate_id.as_str();
        if event.event_type == "thread.deleted" {
            self.remove_sent_from(thread_id).await;
        }
        self.refresh_where(|row| row.target_thread_id == thread_id)
            .await;
    }

    /// Removes every request sent from a deleted thread.
    async fn remove_sent_from(&self, source_thread_id: &str) {
        let _order = self.publish_order.lock().await;
        match self.store.delete_for_source_thread(source_thread_id).await {
            Ok(removed) => {
                for request_id in removed {
                    let _ = self.changes.send(RequestChange::Remove(request_id));
                }
            }
            Err(error) => {
                tracing::warn!(%error, "the send requests of a deleted thread were kept");
            }
        }
    }

    /// Removes the requests of source threads deleted while no event reached the follower, then
    /// reads every open request again.
    pub(crate) async fn sweep(&self) {
        let deleted_sources = self
            .repositories
            .database()
            .call(|connection| {
                let mut statement = connection.prepare(
                    "SELECT DISTINCT request.source_thread_id FROM send_requests AS request \
                     LEFT JOIN projection_threads AS thread ON thread.thread_id = request.source_thread_id \
                     WHERE thread.thread_id IS NULL OR thread.deleted_at IS NOT NULL",
                )?;
                Ok(statement
                    .query_map([], |row| row.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?)
            })
            .await;
        match deleted_sources {
            Ok(sources) => {
                for source_thread_id in sources {
                    self.remove_sent_from(&source_thread_id).await;
                }
            }
            Err(error) => tracing::warn!(%error, "deleted source threads could not be read"),
        }
        self.refresh_where(|_| true).await;
    }

    async fn refresh_where(&self, concerned: impl Fn(&SendRequestRow) -> bool) {
        let open = match self.store.list_open().await {
            Ok(open) => open,
            Err(error) => {
                tracing::warn!(%error, "the open send requests could not be read");
                return;
            }
        };
        for row in open.iter().filter(|row| concerned(row)) {
            if let Err(error) = self.refresh(row).await {
                tracing::warn!(
                    request_id = %row.request_id,
                    %error,
                    "a send request's state could not be updated"
                );
            }
        }
    }

    /// Reads the target's state for one open request and stores the state it implies.
    async fn refresh(&self, row: &SendRequestRow) -> crate::persistence::Result<()> {
        let Some(message_id) = row.target_message_id.clone() else {
            return Ok(());
        };
        let view = read_target(
            self.repositories.database(),
            row.target_thread_id.clone(),
            message_id,
            row.command_id.clone(),
        )
        .await?;
        let next = decide(view);
        if next.state == row.state && next.reason == row.reason.as_deref() {
            return Ok(());
        }
        let from: &[SendState] = match next.state {
            SendState::Queued => &[SendState::Waiting],
            SendState::Waiting => &[SendState::Queued],
            SendState::Read => &[SendState::Queued, SendState::Waiting, SendState::Delivered],
            _ => &OPEN,
        };
        let (answer_message_id, answer_text, answer_truncated) = match next.answer {
            Some((message_id, text)) => {
                let (text, truncated) = cut_answer(text);
                (message_id, Some(text), truncated)
            }
            None => (None, None, false),
        };
        self.apply(
            &row.request_id,
            from,
            StateChange {
                to: next.state,
                reason: next.reason.map(str::to_owned),
                answering_turn_id: next.turn_id,
                answer_message_id,
                answer_text,
                answer_truncated,
                // A message, hand-off or take-over needs nothing more once the target read it.
                dismiss: next.read
                    && matches!(
                        row.action,
                        SendAction::Message | SendAction::HandOff | SendAction::TakeOver
                    ),
                at: crate::mcp::control::now_iso(),
            },
        )
        .await?;
        Ok(())
    }

    async fn stored(&self, request_id: &str) -> Result<SendRequestRow, Value> {
        self.store
            .get(request_id)
            .await
            .map_err(storage)?
            .ok_or_else(|| refusal("not_found", "BiBCode has no such request."))
    }

    /// Withdraws a request the target has not taken yet. A request already read, or whose
    /// delivery the target already claimed, is returned unchanged with `cancelled: false`.
    pub(crate) async fn cancel(
        &self,
        context: &RpcSessionContext,
        request_id: &str,
    ) -> Result<SendRequestsCancelResult, Value> {
        require_person(context)?;
        let row = self.stored(request_id).await?;
        let target = parse_address(&row.target_address)
            .ok_or_else(|| invalid("The request's target is not an agent address."))?;
        match target.terminal {
            // shortcut: no terminal request exists before task 9.2 adds its branch here.
            true => {}
            false => self.cancel_chat(context, &row).await?,
        }
        let request = self.stored(request_id).await?;
        Ok(SendRequestsCancelResult {
            cancelled: request.state == SendState::Cancelled,
            request: SendRequest::from(&request),
        })
    }

    /// Withdraws a chat request's message. A queued or pending delivery is withdrawn by the
    /// engine's worker, which also runs the delivery's claim, so the withdrawal and the claim
    /// are one compare and set each and exactly one of them wins. Before any delivery exists,
    /// the dispatch gate keeps `send` from queueing the request after it was cancelled.
    async fn cancel_chat(
        &self,
        context: &RpcSessionContext,
        row: &SendRequestRow,
    ) -> Result<(), Value> {
        if !matches!(row.state, SendState::Queued | SendState::Waiting) {
            return Ok(());
        }
        let message_id = row.target_message_id.clone().unwrap_or_default();
        {
            let _gate = self.dispatch_gate.lock().await;
            if !self
                .has_delivery(&row.target_thread_id, &message_id)
                .await
                .map_err(storage)?
            {
                self.mark_cancelled(row).await?;
                return Ok(());
            }
        }
        let command = serde_json::from_value(json!({
            "type": "thread.turn-delivery.resolve",
            // A fresh id per attempt: a cancel that lost to a claim leaves a rejected receipt,
            // and a delivery that failed back to pending must stay cancellable.
            "commandId": format!("person-send-cancel:{}:{}", row.request_id, uuid::Uuid::new_v4()),
            "threadId": row.target_thread_id,
            "messageId": message_id,
            "action": "cancel",
            "createdAt": crate::mcp::control::now_iso(),
        }))
        .map_err(|_| invalid("BiBCode could not build this cancel."))?;
        let owner = UploadOwner::from_context(context);
        if (self.dispatcher)(command, owner, ServerActor::Person)
            .await
            .is_ok()
        {
            self.mark_cancelled(row).await?;
        }
        Ok(())
    }

    async fn mark_cancelled(&self, row: &SendRequestRow) -> Result<(), Value> {
        self.apply(
            &row.request_id,
            &[SendState::Queued, SendState::Waiting],
            StateChange {
                to: SendState::Cancelled,
                reason: None,
                answering_turn_id: None,
                answer_message_id: None,
                answer_text: None,
                answer_truncated: false,
                dismiss: false,
                at: crate::mcp::control::now_iso(),
            },
        )
        .await
        .map_err(storage)?;
        Ok(())
    }

    async fn has_delivery(
        &self,
        thread_id: &str,
        message_id: &str,
    ) -> crate::persistence::Result<bool> {
        let (thread_id, message_id) = (thread_id.to_owned(), message_id.to_owned());
        self.repositories
            .database()
            .call(move |connection| {
                Ok(connection.query_row(
                    "SELECT EXISTS(SELECT 1 FROM provider_turn_outbox WHERE thread_id = ? AND message_id = ?)",
                    params![thread_id, message_id],
                    |row| row.get(0),
                )?)
            })
            .await
    }

    /// Hides a request that has ended. The dismissed row is published as an upsert whose
    /// `updated_at` advanced, so a page that arrives later cannot bring it back.
    pub(crate) async fn dismiss(
        &self,
        context: &RpcSessionContext,
        request_id: &str,
    ) -> Result<SendRequest, Value> {
        require_person(context)?;
        let row = self.stored(request_id).await?;
        if !row.state.is_final() {
            return Err(refusal(
                "not_final",
                "Only a request that has ended can be dismissed. Cancel it first.",
            ));
        }
        let _order = self.publish_order.lock().await;
        let dismissed = self
            .store
            .dismiss(request_id, &crate::mcp::control::now_iso())
            .await
            .map_err(storage)?
            .ok_or_else(|| {
                refusal(
                    "not_final",
                    "Only a request that has ended can be dismissed.",
                )
            })?;
        let _ = self
            .changes
            .send(RequestChange::Upsert(Box::new(dismissed.clone())));
        Ok(SendRequest::from(&dismissed))
    }

    /// The stored answer of a request, which does not depend on the target thread.
    pub(crate) async fn get_answer(
        &self,
        context: &RpcSessionContext,
        request_id: &str,
    ) -> Result<SendRequestsGetAnswerResult, Value> {
        require_person(context)?;
        let row = self.stored(request_id).await?;
        match (row.state, row.answer_text) {
            (SendState::Answered, Some(text)) => Ok(SendRequestsGetAnswerResult {
                request_id: row.request_id,
                text,
                truncated: row.answer_truncated,
            }),
            _ => Err(refusal("not_answered", "This request has no answer yet.")),
        }
    }

    /// A thread's handoff text, built from its stored messages for Hand off and Take over from.
    /// It only reads the store, so the read thread's agent receives nothing, even one that can no
    /// longer take a turn.
    pub(crate) async fn handoff_text(
        &self,
        context: &RpcSessionContext,
        input: SendRequestsGetHandoffTextInput,
    ) -> Result<SendRequestsGetHandoffTextResult, Value> {
        require_person(context)?;
        let source = self.live_thread(&input.source_thread_id).await?;
        let thread = self.live_thread(&input.thread_id).await?;
        if thread.project_id != source.project_id {
            return Err(refusal(
                "other_project",
                "This agent belongs to another project. Pick an agent from this project.",
            ));
        }
        let messages = self
            .repositories
            .list_messages_by_thread(input.thread_id.clone())
            .await
            .map_err(storage)?;
        let handoff = handoff_text(&messages, "");
        Ok(SendRequestsGetHandoffTextResult {
            thread_id: input.thread_id,
            text: handoff.render(),
            left_out: handoff.left_out,
            included_messages: handoff.tail.len() + usize::from(handoff.first_message.is_some()),
        })
    }

    /// The last output of an AI Terminal, or its CLI's own conversation when that source is asked
    /// for and can be read (R112), for a terminal source's preview. It only reads, logs ids and
    /// sizes, and never the text, a path or why a conversation could not be read.
    pub(crate) async fn get_terminal_output(
        &self,
        context: &RpcSessionContext,
        input: SendRequestsGetTerminalOutputInput,
    ) -> Result<SendRequestsGetTerminalOutputResult, Value> {
        require_person(context)?;
        let source = self.live_thread(&input.source_thread_id).await?;
        let owner = self.live_thread(&input.thread_id).await?;
        if owner.project_id != source.project_id {
            return Err(refusal(
                "other_project",
                "This terminal belongs to another project.",
            ));
        }
        let reader = self
            .terminal_output
            .as_ref()
            .ok_or_else(|| refusal("not_found", "This terminal's output is not available."))?;
        let owner_id = owner
            .host_thread_id
            .clone()
            .filter(|host| !host.is_empty())
            .unwrap_or_else(|| input.thread_id.clone());
        if input.source == TerminalTextSource::Conversation {
            if let Ok(conversation) =
                conversation_text(reader.as_ref(), &owner_id, &input.terminal_id).await
                && let Some(result) = conversation_result(&input, conversation)
            {
                tracing::debug!(
                    terminal_id = %input.terminal_id,
                    chars = result.text.chars().count(),
                    truncated = result.truncated,
                    "a terminal's conversation was read for a send request"
                );
                return Ok(result);
            }
            tracing::debug!(
                terminal_id = %input.terminal_id,
                "a terminal's conversation could not be read, so its output is used"
            );
        }
        let tail = reader
            .tail(&owner_id, &input.terminal_id, TERMINAL_OUTPUT_MAX_CHARS)
            .await
            .map_err(|_| refusal("not_found", "This terminal is no longer available."))?;
        tracing::debug!(
            terminal_id = %input.terminal_id,
            chars = tail.text.chars().count(),
            truncated = tail.truncated,
            "a terminal's output was read for a send request"
        );
        Ok(SendRequestsGetTerminalOutputResult {
            thread_id: input.thread_id,
            terminal_id: input.terminal_id,
            text: tail.text,
            truncated: tail.truncated,
            used_source: TerminalTextSource::Output,
            fell_back: input.source == TerminalTextSource::Conversation,
            start_missing: false,
        })
    }

    /// Every undismissed request of the scope (requests sent from `thread_id`, or all), in a
    /// snapshot and pages, then each change. A lag sends a new snapshot and pages.
    pub(crate) fn subscribe(
        &self,
        context: &RpcSessionContext,
        thread_id: Option<String>,
        cancellation: CancellationToken,
    ) -> mpsc::Receiver<RpcStreamChunk> {
        let (sender, receiver) = mpsc::channel(SUBSCRIBE_CAPACITY);
        if let Err(error) = require_person(context) {
            let _ = sender.try_send(Err(error));
            return receiver;
        }
        let service = self.clone();
        tokio::spawn(async move {
            // Subscribed before the first read, so no change after it is missed.
            let mut changes = service.subscribe_changes();
            if !service
                .send_pages(&sender, &cancellation, thread_id.as_deref())
                .await
            {
                return;
            }
            loop {
                let change = tokio::select! {
                    () = cancellation.cancelled() => return,
                    change = changes.recv() => change,
                };
                let event = match change {
                    Ok(RequestChange::Upsert(row)) => {
                        if thread_id
                            .as_deref()
                            .is_some_and(|thread_id| row.source_thread_id != thread_id)
                        {
                            continue;
                        }
                        json!({ "type": "upsert", "request": SendRequest::from(row.as_ref()) })
                    }
                    // The removed request's source thread is gone, so every scope hears it.
                    Ok(RequestChange::Remove(request_id)) => {
                        json!({ "type": "remove", "requestId": request_id })
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        if !service
                            .send_pages(&sender, &cancellation, thread_id.as_deref())
                            .await
                        {
                            return;
                        }
                        continue;
                    }
                    Err(broadcast::error::RecvError::Closed) => return,
                };
                if !send_event(&sender, &cancellation, event).await {
                    return;
                }
            }
        });
        receiver
    }

    async fn send_pages(
        &self,
        sender: &mpsc::Sender<RpcStreamChunk>,
        cancellation: &CancellationToken,
        thread_id: Option<&str>,
    ) -> bool {
        let rows = match self.store.list_undismissed(thread_id).await {
            Ok(rows) => rows,
            Err(error) => {
                let _ = sender.send(Err(storage(error))).await;
                return false;
            }
        };
        let page = |kind: &str, rows: &[SendRequestRow]| json!({ "type": kind, "requests": rows.iter().map(SendRequest::from).collect::<Vec<_>>() });
        let mut pages = rows.chunks(SEND_REQUESTS_PAGE_SIZE);
        if !send_event(
            sender,
            cancellation,
            page("snapshot", pages.next().unwrap_or(&[])),
        )
        .await
        {
            return false;
        }
        for rows in pages {
            if !send_event(sender, cancellation, page("page", rows)).await {
                return false;
            }
        }
        true
    }

    /// A live thread, or `unknown_thread`.
    async fn live_thread(&self, thread_id: &str) -> Result<ProjectionThread, Value> {
        self.repositories
            .get_thread(thread_id.to_owned())
            .await
            .map_err(storage)?
            .filter(|thread| thread.deleted_at.is_none())
            .ok_or_else(|| {
                refusal(
                    "unknown_thread",
                    "This agent no longer exists. Choose another agent.",
                )
            })
    }

    pub(crate) async fn send(
        &self,
        context: &RpcSessionContext,
        input: SendRequestsSendInput,
    ) -> Result<SendRequest, Value> {
        require_person(context)?;
        if input.request_id.trim().is_empty() {
            return Err(invalid("The request needs an id."));
        }
        let args_digest = canonical_command_digest(&input)
            .map_err(|_| invalid("BiBCode could not read this request."))?;
        // A repeat replays the stored request without validating it again: its target may be
        // gone by now, and the first attempt already passed every check.
        if let Some(row) = self.store.get(&input.request_id).await.map_err(storage)? {
            return self.replay(context, row, &args_digest, &input).await;
        }
        let action = SendAction::parse(&input.action)
            .ok_or_else(|| invalid("This action is not one BiBCode knows."))?;
        let source = parse_address(&input.source)
            .ok_or_else(|| invalid("The source is not an agent address."))?;
        let target = parse_address(&input.target)
            .ok_or_else(|| invalid("The target is not an agent address."))?;
        let taken_over = input
            .taken_over
            .as_deref()
            .map(|address| {
                parse_address(address)
                    .ok_or_else(|| invalid("The taken-over agent is not an agent address."))
            })
            .transpose()?;
        match (action, &taken_over) {
            (SendAction::TakeOver, Some(taken_over)) => {
                if input.target != input.source {
                    return Err(invalid(
                        "A take-over is queued on the agent that takes over.",
                    ));
                }
                if taken_over.thread_id == source.thread_id {
                    return Err(invalid("An agent cannot take over its own work."));
                }
            }
            (SendAction::TakeOver, None) => {
                return Err(invalid("A take-over names the agent it takes over."));
            }
            (_, Some(_)) => return Err(invalid("Only a take-over names a taken-over agent.")),
            (_, None) => {
                if input.target == input.source {
                    return Err(invalid("Choose another agent than this one."));
                }
            }
        }
        if action == SendAction::Message && input.note.trim().is_empty() {
            return Err(invalid("Write a message first."));
        }
        if input.lead_in.chars().count() > LEAD_IN_MAX_CHARS {
            return Err(refusal(
                "too_long",
                "The request's introduction is longer than 16,000 characters.",
            ));
        }
        let note_chars = input.note.chars().count();
        let attachment_chars: usize = input
            .attachments
            .iter()
            .map(|attachment| attachment.text.chars().count())
            .sum();
        if note_chars + attachment_chars > PERSON_REQUEST_MAX_CHARS {
            return Err(refusal(
                "too_long",
                "The note and attachments are longer than 48,000 characters. Shorten them.",
            ));
        }
        // shortcut: a terminal agent cannot be notified yet; task 9.2 lifts this.
        if target.terminal {
            return Err(refusal(
                "target_not_notifiable",
                "BiBCode cannot send a request to a terminal agent yet.",
            ));
        }

        let source_thread = self.live_thread(&source.thread_id).await?;
        let target_thread = self.live_thread(&target.thread_id).await?;
        let taken_over_thread = match &taken_over {
            Some(address) => Some(self.live_thread(&address.thread_id).await?),
            None => None,
        };
        let project_id = &source_thread.project_id;
        if target_thread.project_id != *project_id
            || taken_over_thread
                .as_ref()
                .is_some_and(|thread| thread.project_id != *project_id)
        {
            return Err(refusal(
                "other_project",
                "Requests go only to agents of the same project.",
            ));
        }

        let command_id = format!("person-send:{}", input.request_id);
        let now = crate::mcp::control::now_iso();
        let order = self.publish_order.lock().await;
        let (row, created) = self
            .store
            .insert_if_absent(SendRequestRow {
                request_id: input.request_id.clone(),
                project_id: project_id.clone(),
                source_address: input.source.clone(),
                source_thread_id: source.thread_id.clone(),
                action,
                target_address: input.target.clone(),
                target_thread_id: target.thread_id.clone(),
                taken_over_address: input.taken_over.clone(),
                args_digest: args_digest.clone(),
                note_chars: i64::try_from(note_chars).unwrap_or(i64::MAX),
                attachment_chars: i64::try_from(attachment_chars).unwrap_or(i64::MAX),
                target_message_id: Some(command_id.clone()),
                command_id: Some(command_id.clone()),
                runtime_mode: target_thread.runtime_mode.clone(),
                interaction_mode: target_thread.interaction_mode.clone(),
                answering_turn_id: None,
                answer_message_id: None,
                answer_text: None,
                answer_truncated: false,
                terminal_generation: None,
                state: SendState::Queued,
                reason: None,
                created_at: now.clone(),
                updated_at: now,
                dismissed_at: None,
            })
            .await
            .map_err(storage)?;
        if created {
            // Published before the turn is queued, so no later state of the request comes first.
            let _ = self
                .changes
                .send(RequestChange::Upsert(Box::new(row.clone())));
        }
        drop(order);
        if !created {
            // A simultaneous call with the same id stored it first.
            return self.replay(context, row, &args_digest, &input).await;
        }
        self.dispatch(context, &row, &input).await?;
        Ok(SendRequest::from(&row))
    }

    /// A repeat of a stored request. Other arguments are a conflict. Otherwise the command's
    /// receipt says what the first attempt reached: accepted means the turn is queued, so
    /// nothing is sent again; rejected is reported as the failure it was; none or reserved
    /// means the identical command is dispatched again, which the engine admits once.
    async fn replay(
        &self,
        context: &RpcSessionContext,
        row: SendRequestRow,
        args_digest: &str,
        input: &SendRequestsSendInput,
    ) -> Result<SendRequest, Value> {
        if row.args_digest != args_digest {
            return Err(refusal(
                "request_conflict",
                "A request with this id was already sent with other content.",
            ));
        }
        let receipt = self
            .repositories
            .get_command_receipt(row.command_id.clone().unwrap_or_default())
            .await
            .map_err(storage)?;
        match receipt {
            Some(receipt) if receipt.status == "accepted" => {}
            Some(receipt) if !matches!(receipt.status.as_str(), "reserved" | "prepared") => {
                return Err(self.rejected(&row, receipt.error).await);
            }
            _ => self.dispatch(context, &row, input).await?,
        }
        let current = self.store.get(&row.request_id).await.map_err(storage)?;
        Ok(SendRequest::from(current.as_ref().unwrap_or(&row)))
    }

    /// Queues the request's turn, built from its stored row and the caller's text, so every
    /// attempt builds the same command.
    async fn dispatch(
        &self,
        context: &RpcSessionContext,
        row: &SendRequestRow,
        input: &SendRequestsSendInput,
    ) -> Result<(), Value> {
        let attachments = input
            .attachments
            .iter()
            .map(|attachment| (attachment.label.clone(), attachment.text.clone()))
            .collect::<Vec<_>>();
        let command = turn_command(
            row,
            compose_message_text(&input.lead_in, &input.note, &attachments),
        )
        .map_err(|_| invalid("BiBCode could not build this request."))?;
        let _gate = self.dispatch_gate.lock().await;
        // Cancelled (or otherwise ended) before any delivery existed: never queued afterwards.
        if self
            .store
            .get(&row.request_id)
            .await
            .map_err(storage)?
            .is_some_and(|current| current.state.is_final())
        {
            return Ok(());
        }
        let Err(error) = (self.dispatcher)(
            command,
            UploadOwner::from_context(context),
            ServerActor::Person,
        )
        .await
        else {
            return Ok(());
        };
        tracing::warn!(
            request_id = %row.request_id,
            error = %error["_tag"],
            "a send request could not be queued"
        );
        // Only a rejection the engine stored is final; any other failure stays replayable.
        let receipt = self
            .repositories
            .get_command_receipt(row.command_id.clone().unwrap_or_default())
            .await
            .map_err(storage)?;
        if let Some(receipt) = receipt.filter(|receipt| receipt.status == "rejected") {
            return Err(self.rejected(row, receipt.error).await);
        }
        Err(refusal(
            "invalid",
            "BiBCode could not queue this request on the agent. Try again.",
        ))
    }

    /// Ends a request whose command the engine rejected, and returns that rejection.
    async fn rejected(&self, row: &SendRequestRow, error: Option<String>) -> Value {
        let change = StateChange {
            to: SendState::NotAnswered,
            reason: Some("delivery_failed".to_owned()),
            answering_turn_id: None,
            answer_message_id: None,
            answer_text: None,
            answer_truncated: false,
            dismiss: false,
            at: crate::mcp::control::now_iso(),
        };
        if let Err(error) = self.apply(&row.request_id, &OPEN, change).await {
            tracing::warn!(request_id = %row.request_id, %error, "a rejected send request was kept open");
        }
        refusal(
            "invalid",
            &format!(
                "The agent did not accept this request: {}",
                error.as_deref().unwrap_or("it was refused.")
            ),
        )
    }
}

/// The `thread.turn.start` a request queues, built only from its stored row and its text, so
/// a replay builds the same command.
pub(super) fn turn_command(
    row: &SendRequestRow,
    text: String,
) -> Result<OrchestrationCommand, String> {
    // A take-over is labelled with the agent whose work it takes over.
    let source_address = row
        .taken_over_address
        .as_deref()
        .unwrap_or(&row.source_address);
    serde_json::from_value(json!({
        "type": "thread.turn.start",
        "commandId": row.command_id,
        "threadId": row.target_thread_id,
        "message": {
            "messageId": row.target_message_id,
            "role": "user",
            "text": text,
            "attachments": [],
            "personSend": {
                "requestId": row.request_id,
                "action": row.action.as_str(),
                "sourceAddress": source_address,
            },
        },
        "runtimeMode": row.runtime_mode,
        "interactionMode": row.interaction_mode,
        "queued": true,
        "createdAt": row.created_at,
    }))
    .map_err(|error| error.to_string())
}

/// What the target shows for one request's message.
#[derive(Debug, Default)]
struct TargetView {
    deleted: bool,
    /// The message's delivery: its state and whether it is held.
    outbox: Option<(String, bool)>,
    session_status: Option<String>,
    /// An older delivery of the thread failed or is uncertain, so this one is never claimed.
    behind_failed: bool,
    turn: Option<TurnView>,
    /// The proposed plan the turn ended with.
    plan: Option<String>,
    assistant_text: Option<String>,
    /// The assistant message is still streaming: its turn can complete before its last output.
    assistant_streaming: bool,
    /// The delivery was dismissed by a withdrawal (a cancel), not after it was sent.
    withdrawn: bool,
    /// The engine rejected the request's command.
    rejected: bool,
}

#[derive(Debug)]
struct TurnView {
    turn_id: Option<String>,
    state: String,
    started: bool,
    assistant_message_id: Option<String>,
}

async fn read_target(
    database: &Database,
    thread_id: String,
    message_id: String,
    command_id: Option<String>,
) -> crate::persistence::Result<TargetView> {
    database
        .call(move |connection| {
            let deleted = connection
                .query_row(
                    "SELECT deleted_at IS NOT NULL FROM projection_threads WHERE thread_id = ?",
                    [&thread_id],
                    |row| row.get::<_, bool>(0),
                )
                .optional()?
                .unwrap_or(true);
            let outbox = connection
                .query_row(
                    "SELECT state, held, created_at, command_id FROM provider_turn_outbox WHERE thread_id = ? AND message_id = ?",
                    params![thread_id, message_id],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, bool>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, String>(3)?,
                        ))
                    },
                )
                .optional()?;
            let behind_failed = match &outbox {
                Some((_, _, created_at, delivery_command_id)) => connection.query_row(
                    "SELECT EXISTS(SELECT 1 FROM provider_turn_outbox WHERE thread_id = ?1 AND state IN ('failed', 'uncertain') AND (created_at, command_id) < (?2, ?3))",
                    params![thread_id, created_at, delivery_command_id],
                    |row| row.get(0),
                )?,
                None => false,
            };
            let session_status = connection
                .query_row(
                    "SELECT status FROM projection_thread_sessions WHERE thread_id = ?",
                    [&thread_id],
                    |row| row.get(0),
                )
                .optional()?;
            // The turn the message started, found as `read_wait_state` finds it.
            let turn = connection
                .query_row(
                    "SELECT turn_id, state, started_at IS NOT NULL, assistant_message_id FROM projection_turns
                      WHERE thread_id = ?1 AND (pending_message_id = ?2
                         OR turn_id = (SELECT turn_id FROM projection_thread_messages WHERE message_id = ?2 AND thread_id = ?1))
                      ORDER BY (turn_id IS NULL) ASC, requested_at DESC LIMIT 1",
                    params![thread_id, message_id],
                    |row| {
                        Ok(TurnView {
                            turn_id: row.get(0)?,
                            state: row.get(1)?,
                            started: row.get(2)?,
                            assistant_message_id: row.get(3)?,
                        })
                    },
                )
                .optional()?;
            let mut view = TargetView {
                deleted,
                outbox: outbox.map(|(state, held, _, _)| (state, held)),
                session_status,
                behind_failed,
                ..TargetView::default()
            };
            if let Some(turn) = turn.as_ref().filter(|turn| turn.state == "completed") {
                if let Some(turn_id) = &turn.turn_id {
                    view.plan = connection
                        .query_row(
                            "SELECT plan_markdown FROM projection_thread_proposed_plans WHERE thread_id = ? AND turn_id = ? ORDER BY updated_at DESC, plan_id DESC LIMIT 1",
                            params![thread_id, turn_id],
                            |row| row.get(0),
                        )
                        .optional()?;
                }
                if let Some(assistant_message_id) = &turn.assistant_message_id
                    && let Some((text, streaming)) = connection
                        .query_row(
                            "SELECT text, is_streaming FROM projection_thread_messages WHERE message_id = ? AND thread_id = ?",
                            params![assistant_message_id, thread_id],
                            |row| Ok((row.get(0)?, row.get(1)?)),
                        )
                        .optional()?
                {
                    view.assistant_text = Some(text);
                    view.assistant_streaming = streaming;
                }
            }
            if view.outbox.as_ref().is_some_and(|(state, _)| state == "dismissed") {
                view.withdrawn = connection
                    .query_row(
                        "SELECT json_extract(payload_json, '$.withdrawn') = 1 FROM orchestration_events \
                         WHERE stream_id = ?1 AND event_type = 'thread.turn-delivery-updated' \
                           AND json_extract(payload_json, '$.messageId') = ?2 \
                         ORDER BY sequence DESC LIMIT 1",
                        params![thread_id, message_id],
                        |row| row.get::<_, Option<bool>>(0),
                    )
                    .optional()?
                    .flatten()
                    .unwrap_or(false);
            }
            if view.outbox.is_none()
                && let Some(command_id) = &command_id
            {
                view.rejected = connection
                    .query_row(
                        "SELECT status = 'rejected' FROM orchestration_command_receipts WHERE command_id = ?",
                        [command_id],
                        |row| row.get(0),
                    )
                    .optional()?
                    .unwrap_or(false);
            }
            view.turn = turn;
            Ok(view)
        })
        .await
}

/// The state a request is in, given what its target shows.
#[derive(Debug, PartialEq, Eq)]
struct Next {
    state: SendState,
    reason: Option<&'static str>,
    turn_id: Option<String>,
    /// The answer's message (none for a plan) and its text.
    answer: Option<(Option<String>, String)>,
    /// The target's turn for the request started.
    read: bool,
}

fn decide(view: TargetView) -> Next {
    let next = |state, reason| Next {
        state,
        reason,
        turn_id: None,
        answer: None,
        read: false,
    };
    if view.deleted {
        return next(SendState::NotAnswered, Some("target_deleted"));
    }
    if let Some(turn) = view.turn {
        let settled = |state, reason, answer| Next {
            state,
            reason,
            turn_id: turn.turn_id.clone(),
            answer,
            read: turn.started,
        };
        match turn.state.as_str() {
            // A reviewer in plan mode ends its turn with a proposed plan, which is the answer.
            "completed" => {
                return match (view.plan, view.assistant_text) {
                    (Some(plan), _) => settled(SendState::Answered, None, Some((None, plan))),
                    // The provider runtime completes the turn before it settles the message.
                    (None, Some(_)) if view.assistant_streaming => {
                        settled(SendState::Read, None, None)
                    }
                    (None, Some(text)) => settled(
                        SendState::Answered,
                        None,
                        Some((turn.assistant_message_id.clone(), text)),
                    ),
                    (None, None) => settled(SendState::NotAnswered, Some("no_answer"), None),
                };
            }
            "error" => return settled(SendState::NotAnswered, Some("turn_failed"), None),
            "interrupted" => {
                return settled(SendState::NotAnswered, Some("turn_interrupted"), None);
            }
            _ if turn.started => return settled(SendState::Read, None, None),
            _ => {}
        }
    }
    let paused_session = matches!(
        view.session_status.as_deref(),
        Some("error" | "interrupted" | "stopped")
    );
    match view.outbox {
        Some((state, _)) if matches!(state.as_str(), "failed" | "uncertain") => {
            next(SendState::NotAnswered, Some("delivery_failed"))
        }
        // Withdrawn before it was sent: a cancel whose own state change was not stored. Any
        // other dismissal may follow a send, so the request ends unanswered.
        Some((state, _)) if state == "dismissed" && view.withdrawn => {
            next(SendState::Cancelled, None)
        }
        Some((state, _)) if state == "dismissed" => {
            next(SendState::NotAnswered, Some("delivery_failed"))
        }
        Some((state, held)) if state == "queued" && (held || paused_session) => {
            next(SendState::Waiting, Some("queue_paused"))
        }
        Some((state, _)) if state == "pending" && view.behind_failed => {
            next(SendState::Waiting, Some("queue_paused"))
        }
        None if view.rejected => next(SendState::NotAnswered, Some("delivery_failed")),
        _ => next(SendState::Queued, None),
    }
}

/// `text` cut at [`ANSWER_TEXT_MAX_CHARS`] Unicode scalar values, and whether it was cut.
fn cut_answer(mut text: String) -> (String, bool) {
    match text.char_indices().nth(ANSWER_TEXT_MAX_CHARS) {
        Some((index, _)) => {
            text.truncate(index);
            (text, true)
        }
        None => (text, false),
    }
}
