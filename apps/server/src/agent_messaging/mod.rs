//! Messages between the agents of one project: the store, the directory, the envelope and the
//! provider tools. Off unless `agentMessaging.enabled` is on. An agent's identity is the thread
//! of its credential, never an argument, and it reaches only agents of its own project.

pub(crate) mod delivery;
pub(crate) mod directory;
pub(crate) mod envelope;
pub(crate) mod policy;
pub mod store;

use std::sync::Arc;

use tokio::sync::watch;
use uuid::Uuid;

use crate::{
    orchestration::{OrchestrationCommand, OrchestrationEngine},
    persistence::{ProjectionThread, ProjectionThreadSession},
    production::orchestration_rpc::{AgentTurn, ServerActor, ServerTurnStarter},
};
use directory::AgentSummary;
use envelope::{EnvelopeInput, build_envelope};
use store::{
    AgentMessageCompanion, AgentMessageReason, AgentMessageRow, AgentMessageStatus,
    NewAgentMessage, SenderKind,
};

/// The longest message text, counted in Unicode scalar values.
const AGENT_MESSAGE_MAX_CHARACTERS: usize = 16_000;

/// One message on its way to a recipient: a send or a reply.
struct Outgoing<'a> {
    message_id: &'a str,
    conversation_id: &'a str,
    in_reply_to: Option<&'a str>,
    hop: u32,
    text: &'a str,
    client_request_id: Option<&'a str>,
}

/// Refuses an empty or whitespace-only text and one over the limit, without quoting it.
fn check_text(text: &str) -> Result<(), AgentMessagingError> {
    if text.trim().is_empty() {
        return Err(AgentMessagingError::InvalidArgument(
            "text must not be empty.".to_owned(),
        ));
    }
    if text.chars().count() > AGENT_MESSAGE_MAX_CHARACTERS {
        return Err(AgentMessagingError::InvalidArgument(format!(
            "text must be at most {AGENT_MESSAGE_MAX_CHARACTERS} characters."
        )));
    }
    Ok(())
}

const DISABLED_MESSAGE: &str =
    "Agent messaging is off. Turn it on in Settings → Agents → Agent integrations.";
const UNKNOWN_RECIPIENT_MESSAGE: &str =
    "No agent with that address in this project. Call agents_list to see the agents you can reach.";

/// A refusal of an agent messaging tool. Its message never quotes the caller's input.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum AgentMessagingError {
    Disabled,
    UnknownRecipient,
    InvalidArgument(String),
    /// A message that does not exist or that the caller may not use: one answer for both.
    UnknownMessage,
    /// The agent a reply would go to no longer exists.
    RecipientGone,
    /// The recipient runs with more access than the sender.
    ModeCeiling {
        sender: String,
        recipient: String,
    },
    /// The sender already used the `clientRequestId` for a different message.
    Conflict,
    /// The exchange reached the hop limit; a person has to write before agents continue.
    HopLimit,
    /// The message was already handed to its recipient, or its status is final.
    NotCancellable,
    /// The sender sent its allowance of agent messages in the rate window.
    RateLimit,
    /// The recipient has its allowance of agent messages it has not read.
    BacklogLimit,
    /// The store did not answer; the details go to the log, never to the agent.
    Storage,
}

impl AgentMessagingError {
    pub(crate) fn tag(&self) -> &'static str {
        match self {
            Self::Disabled => "AgentMessagingDisabledError",
            Self::UnknownRecipient => "AgentMessagingUnknownRecipientError",
            Self::InvalidArgument(_) => "AgentMessagingInvalidArgumentError",
            Self::UnknownMessage => "AgentMessagingUnknownMessageError",
            Self::RecipientGone => "AgentMessagingRecipientGoneError",
            Self::ModeCeiling { .. } => "AgentMessagingModeCeilingError",
            Self::Conflict => "AgentMessagingConflictError",
            Self::HopLimit => "AgentMessagingHopLimitError",
            Self::NotCancellable => "AgentMessagingNotCancellableError",
            Self::RateLimit => "AgentMessagingRateLimitError",
            Self::BacklogLimit => "AgentMessagingBacklogLimitError",
            Self::Storage => "McpStorageError",
        }
    }

    pub(crate) fn message(&self) -> String {
        match self {
            Self::Disabled => DISABLED_MESSAGE.to_owned(),
            Self::UnknownRecipient => UNKNOWN_RECIPIENT_MESSAGE.to_owned(),
            Self::InvalidArgument(detail) => detail.clone(),
            Self::UnknownMessage => "No message with that id that you may use.".to_owned(),
            Self::RecipientGone => {
                "The agent that sent that message is gone, so it cannot get a reply.".to_owned()
            }
            Self::ModeCeiling { sender, recipient } => format!(
                "The recipient runs with more access ({recipient}) than you ({sender}), so it cannot take your message."
            ),
            Self::Conflict => {
                "This clientRequestId was already used for a different message. Use a new id."
                    .to_owned()
            }
            Self::HopLimit => format!(
                "This exchange has reached the limit of {} agent-to-agent hops. A person has to write in a thread before agents can continue.",
                policy::HOP_LIMIT
            ),
            Self::NotCancellable => {
                "That message was already delivered, so it cannot be cancelled.".to_owned()
            }
            Self::RateLimit => format!(
                "You have sent {} agent messages in the last {} seconds, which is the limit. Wait before sending more.",
                policy::RATE_LIMIT,
                policy::RATE_WINDOW_SECONDS
            ),
            Self::BacklogLimit => format!(
                "The recipient already has {} agent messages it has not read, which is the limit. Try again after it has read some.",
                policy::BACKLOG_LIMIT
            ),
            Self::Storage => "BiBCode could not read its store; try again.".to_owned(),
        }
    }
}

/// What an agent asks to send. The sender is never part of it: it is the credential's thread.
pub(crate) struct SendRequest {
    pub(crate) to: String,
    pub(crate) text: String,
    pub(crate) client_request_id: Option<String>,
}

/// A reply to a message the caller received; it goes to that message's sender.
pub(crate) struct ReplyRequest {
    pub(crate) in_reply_to: String,
    pub(crate) text: String,
    pub(crate) client_request_id: Option<String>,
}

/// A message's status as stored, for its sender.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct StatusReport {
    pub(crate) status: AgentMessageStatus,
    pub(crate) reason: Option<AgentMessageReason>,
    pub(crate) updated_at: String,
    pub(crate) reply_message_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct MessageReceipt {
    pub(crate) message_id: String,
    pub(crate) conversation_id: String,
    pub(crate) status: AgentMessageStatus,
    pub(crate) hop: u32,
}

/// How a recipient's turn queue takes a new agent message.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TurnAdmission {
    /// Start a turn now.
    Start,
    /// Wait behind the turn that runs.
    Queue,
    /// Wait in the recipient's paused queue until a person releases it (R18).
    Hold,
}

/// `Hold` while the recipient's queue is paused ([`store::queue_paused`]): its last turn ended in
/// an error or an interrupt, or an entry a person has not released still waits, whatever the
/// session reads now, so a message never restarts it or overtakes the held entries. The
/// admitting transaction checks `paused` again. `Queue` while the recipient's session runs
/// or starts a turn, and while it has an open approval or question whatever its session (a
/// restart recovers a ready session's asks), so a message never reaches a turn that waits for a
/// person's answer (R9). `Start` otherwise, no session at all included, so a never-started
/// recipient is not stranded in the queue.
pub(crate) fn admission_for(
    thread: &ProjectionThread,
    session: Option<&ProjectionThreadSession>,
    paused: bool,
) -> TurnAdmission {
    if paused {
        return TurnAdmission::Hold;
    }
    if thread.pending_approval_count > 0 || thread.pending_user_input_count > 0 {
        return TurnAdmission::Queue;
    }
    match session.map(|session| session.status.as_str()) {
        Some("running" | "starting") => TurnAdmission::Queue,
        _ => TurnAdmission::Start,
    }
}

/// One outcome of an agent messaging call or delivery, for the activity log. Titles are thread
/// titles, never message text.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct MessageOutcome {
    pub(crate) sender_address: String,
    pub(crate) recipient_address: String,
    pub(crate) tool: &'static str,
    pub(crate) outcome: String,
    pub(crate) message_id: Option<String>,
    pub(crate) conversation_id: Option<String>,
    pub(crate) hop: Option<u32>,
    pub(crate) reason: Option<String>,
    pub(crate) sender_title: Option<String>,
    pub(crate) recipient_title: Option<String>,
}

pub(crate) type OutcomeSink = Arc<dyn Fn(MessageOutcome) + Send + Sync>;

/// Told when the admission of message `id` starts (`true`) and ends (`false`), around its send's
/// own outcome, so the sink keeps the message's later outcomes behind that one.
pub(crate) type AdmissionHook = Arc<dyn Fn(&str, bool) + Send + Sync>;

/// Started before a message's admission can make its delivery runnable; dropped after its send
/// reported, or with the call's future when the call is dropped, which ends the admission.
struct AdmissionHold {
    hook: AdmissionHook,
    message_id: String,
}

impl AdmissionHold {
    fn start(hook: &AdmissionHook, message_id: &str) -> Self {
        hook(message_id, true);
        Self {
            hook: Arc::clone(hook),
            message_id: message_id.to_owned(),
        }
    }
}

impl Drop for AdmissionHold {
    fn drop(&mut self) {
        (self.hook)(&self.message_id, false);
    }
}

/// What one send or reply call learned about who it involves, for its activity row: both thread
/// titles once it resolved the recipient as a live thread of the sender's project, never before.
#[derive(Default)]
struct Attribution {
    titles: Option<(String, String)>,
    hold: Option<AdmissionHold>,
}

/// The sender and recipient threads of a send that passed every check.
struct Route {
    sender: ProjectionThread,
    sender_provider: String,
    recipient: ProjectionThread,
    session: Option<ProjectionThreadSession>,
    /// The recipient's queue is paused ([`store::queue_paused`]).
    paused: bool,
}

#[derive(Clone)]
pub(crate) struct AgentMessaging {
    engine: OrchestrationEngine,
    enabled: watch::Receiver<bool>,
    starter: Option<ServerTurnStarter>,
    outcomes: Option<OutcomeSink>,
    admissions: Option<AdmissionHook>,
}

impl AgentMessaging {
    pub(crate) fn new(engine: OrchestrationEngine, enabled: watch::Receiver<bool>) -> Self {
        Self {
            engine,
            enabled,
            starter: None,
            outcomes: None,
            admissions: None,
        }
    }

    pub(crate) fn with_starter(mut self, starter: ServerTurnStarter) -> Self {
        self.starter = Some(starter);
        self
    }

    pub(crate) fn with_outcomes(mut self, outcomes: OutcomeSink) -> Self {
        self.outcomes = Some(outcomes);
        self
    }

    pub(crate) fn with_admissions(mut self, admissions: AdmissionHook) -> Self {
        self.admissions = Some(admissions);
        self
    }

    /// Sends `request` from the agent of `sender_thread_id` to another agent of its project.
    pub(crate) async fn send(
        &self,
        sender_thread_id: &str,
        request: SendRequest,
    ) -> Result<MessageReceipt, AgentMessagingError> {
        let mut attribution = Attribution::default();
        let result = self
            .send_inner(sender_thread_id, &request, &mut attribution)
            .await;
        self.report(
            "agent_message_send",
            sender_thread_id,
            &request.to,
            attribution,
            result.as_ref(),
        )
        .await;
        result
    }

    /// Reports a send or reply the tool refused before calling [`Self::send`] or
    /// [`Self::reply`], with no argument of it, and returns the refusal.
    pub(crate) async fn refused(
        &self,
        tool: &'static str,
        caller_thread_id: &str,
        error: AgentMessagingError,
    ) -> AgentMessagingError {
        self.report(
            tool,
            caller_thread_id,
            "",
            Attribution::default(),
            Err(&error),
        )
        .await;
        error
    }

    /// Tells the outcome sink, if any, what one send or reply call ended with.
    async fn report(
        &self,
        tool: &'static str,
        sender_thread_id: &str,
        recipient_address: &str,
        attribution: Attribution,
        result: Result<&MessageReceipt, &AgentMessagingError>,
    ) {
        let Some(outcomes) = &self.outcomes else {
            return;
        };
        let Attribution { titles, hold } = attribution;
        let titles = match titles {
            Some((sender, recipient)) => (Some(sender), Some(recipient)),
            // The caller's own thread: its title tells it nothing about any other.
            None => (self.own_title(sender_thread_id).await, None),
        };
        let (outcome, receipt) = match result {
            Ok(receipt) => ("accepted".to_owned(), Some(receipt)),
            Err(error) => (error.tag().to_owned(), None),
        };
        outcomes(MessageOutcome {
            sender_address: format!("thread:{sender_thread_id}"),
            recipient_address: recipient_address.to_owned(),
            tool,
            outcome,
            message_id: receipt.map(|receipt| receipt.message_id.clone()),
            conversation_id: receipt.map(|receipt| receipt.conversation_id.clone()),
            hop: receipt.map(|receipt| receipt.hop),
            reason: None,
            sender_title: titles.0,
            recipient_title: titles.1,
        });
        // Only now may the message's later outcomes follow.
        drop(hold);
    }

    /// The title of the caller's own thread, unless it is deleted or unreadable.
    async fn own_title(&self, thread_id: &str) -> Option<String> {
        self.engine
            .repositories()
            .get_thread(thread_id.to_owned())
            .await
            .ok()
            .flatten()
            .filter(|thread| thread.deleted_at.is_none())
            .map(|thread| thread.title)
    }

    /// Replies to `request.in_reply_to`, a message the agent of `sender_thread_id` received:
    /// the reply goes to that message's sender, in the same conversation. It returns at once.
    pub(crate) async fn reply(
        &self,
        sender_thread_id: &str,
        request: ReplyRequest,
    ) -> Result<MessageReceipt, AgentMessagingError> {
        let mut recipient_address = String::new();
        let mut attribution = Attribution::default();
        let result = self
            .reply_inner(
                sender_thread_id,
                &request,
                &mut recipient_address,
                &mut attribution,
            )
            .await;
        self.report(
            "agent_message_reply",
            sender_thread_id,
            &recipient_address,
            attribution,
            result.as_ref(),
        )
        .await;
        result
    }

    /// The receipt of an accepted reply. `recipient_address` is set once the message replied to
    /// is known to be the caller's.
    async fn reply_inner(
        &self,
        sender_thread_id: &str,
        request: &ReplyRequest,
        recipient_address: &mut String,
        attribution: &mut Attribution,
    ) -> Result<MessageReceipt, AgentMessagingError> {
        if !self.is_enabled() {
            return Err(AgentMessagingError::Disabled);
        }
        let original = self
            .message(&request.in_reply_to)
            .await?
            .filter(|message| message.recipient_address == format!("thread:{sender_thread_id}"))
            .ok_or(AgentMessagingError::UnknownMessage)?;
        recipient_address.clone_from(&original.sender_address);
        let recipient_thread_id = original
            .sender_address
            .strip_prefix("thread:")
            .ok_or(AgentMessagingError::RecipientGone)?;
        check_text(&request.text)?;
        let message_id = Uuid::new_v4().to_string();
        let outgoing = Outgoing {
            message_id: &message_id,
            conversation_id: &original.conversation_id,
            in_reply_to: Some(&original.message_id),
            hop: 1,
            text: &request.text,
            client_request_id: request.client_request_id.as_deref(),
        };
        // A stored receipt answers a retry even after its recipient is gone (R12).
        if let Some(receipt) = self
            .replay(
                &format!("thread:{sender_thread_id}"),
                &original.sender_address,
                &outgoing,
            )
            .await?
        {
            return Ok(receipt);
        }
        let route = match self.route(sender_thread_id, recipient_thread_id).await {
            Err(AgentMessagingError::UnknownRecipient) => {
                return Err(AgentMessagingError::RecipientGone);
            }
            route => route?,
        };
        attribution.titles = Some((route.sender.title.clone(), route.recipient.title.clone()));
        let outgoing = Outgoing {
            hop: self.next_hop(sender_thread_id).await?,
            ..outgoing
        };
        // Before the admission can make the delivery runnable, so its rows follow this call's.
        attribution.hold = (self.admissions.as_ref())
            .map(|admissions| AdmissionHold::start(admissions, &message_id));
        self.deliver(&route, outgoing).await
    }

    /// The stored status of a message the agent of `caller_thread_id` sent. Any other message,
    /// one it received included, reads exactly as a message that does not exist.
    pub(crate) async fn status(
        &self,
        caller_thread_id: &str,
        message_id: &str,
    ) -> Result<StatusReport, AgentMessagingError> {
        if !self.is_enabled() {
            return Err(AgentMessagingError::Disabled);
        }
        let message = self
            .message(message_id)
            .await?
            .filter(|message| message.sender_address == format!("thread:{caller_thread_id}"))
            .ok_or(AgentMessagingError::UnknownMessage)?;
        let in_reply_to = message.message_id.clone();
        let reply_message_id = self
            .engine
            .repositories()
            .database()
            .call(move |connection| store::latest_reply_id(connection, &in_reply_to))
            .await
            .map_err(|error| {
                tracing::warn!(error = %error, "agent_message_status could not read replies");
                AgentMessagingError::Storage
            })?;
        Ok(StatusReport {
            status: message.status,
            reason: message.reason,
            updated_at: message.updated_at,
            reply_message_id,
        })
    }

    async fn message(
        &self,
        message_id: &str,
    ) -> Result<Option<AgentMessageRow>, AgentMessagingError> {
        let message_id = message_id.to_owned();
        self.engine
            .repositories()
            .database()
            .call(move |connection| store::get_message(connection, &message_id))
            .await
            .map_err(|error| {
                tracing::warn!(error = %error, "agent messaging could not read a message");
                AgentMessagingError::Storage
            })
    }

    /// The receipt of an accepted send.
    async fn send_inner(
        &self,
        sender_thread_id: &str,
        request: &SendRequest,
        attribution: &mut Attribution,
    ) -> Result<MessageReceipt, AgentMessagingError> {
        if !self.is_enabled() {
            return Err(AgentMessagingError::Disabled);
        }
        let recipient_thread_id = request
            .to
            .strip_prefix("thread:")
            .filter(|id| !id.is_empty() && *id != sender_thread_id)
            .ok_or(AgentMessagingError::UnknownRecipient)?;
        check_text(&request.text)?;
        let message_id = Uuid::new_v4().to_string();
        let conversation_id = Uuid::new_v4().to_string();
        let outgoing = Outgoing {
            message_id: &message_id,
            conversation_id: &conversation_id,
            in_reply_to: None,
            hop: 1,
            text: &request.text,
            client_request_id: request.client_request_id.as_deref(),
        };
        // A stored receipt answers a retry even after its recipient is gone (R12).
        if let Some(receipt) = self
            .replay(
                &format!("thread:{sender_thread_id}"),
                &request.to,
                &outgoing,
            )
            .await?
        {
            return Ok(receipt);
        }
        let route = self.route(sender_thread_id, recipient_thread_id).await?;
        attribution.titles = Some((route.sender.title.clone(), route.recipient.title.clone()));
        let outgoing = Outgoing {
            hop: self.next_hop(sender_thread_id).await?,
            ..outgoing
        };
        // Before the admission can make the delivery runnable, so its rows follow this call's.
        attribution.hold = (self.admissions.as_ref())
            .map(|admissions| AdmissionHold::start(admissions, &message_id));
        self.deliver(&route, outgoing).await
    }

    /// Both threads, when the recipient is a live thread of the sender's project. Every other
    /// case, another project's thread included, gives the same `UnknownRecipient`.
    async fn route(
        &self,
        sender_thread_id: &str,
        recipient_thread_id: &str,
    ) -> Result<Route, AgentMessagingError> {
        let repositories = self.engine.repositories();
        let storage = |error: crate::persistence::PersistenceError| {
            tracing::warn!(error = %error, "agent messaging could not read a thread");
            AgentMessagingError::Storage
        };
        let live = |thread: Option<ProjectionThread>| {
            thread.filter(|thread| thread.deleted_at.is_none() && thread.archived_at.is_none())
        };
        let sender = repositories
            .get_thread(sender_thread_id.to_owned())
            .await
            .map_err(storage)?
            .filter(|thread| thread.deleted_at.is_none())
            .ok_or(AgentMessagingError::UnknownRecipient)?;
        let recipient = live(
            repositories
                .get_thread(recipient_thread_id.to_owned())
                .await
                .map_err(storage)?,
        )
        .filter(|recipient| recipient.project_id == sender.project_id)
        .ok_or(AgentMessagingError::UnknownRecipient)?;
        let session = repositories
            .get_thread_session(recipient_thread_id.to_owned())
            .await
            .map_err(storage)?;
        let sender_session = repositories
            .get_thread_session(sender_thread_id.to_owned())
            .await
            .map_err(storage)?;
        let lookup = recipient_thread_id.to_owned();
        let paused = repositories
            .database()
            .call(move |connection| store::queue_paused(connection, &lookup))
            .await
            .map_err(storage)?;
        let sender_provider = sender_session
            .and_then(|session| session.provider_name)
            .or_else(|| {
                sender
                    .model_selection
                    .get("instanceId")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned)
            })
            .unwrap_or_default();
        Ok(Route {
            sender,
            sender_provider,
            recipient,
            session,
            paused,
        })
    }

    /// Stores the message and queues its envelope for the recipient in one transaction.
    async fn deliver(
        &self,
        route: &Route,
        outgoing: Outgoing<'_>,
    ) -> Result<MessageReceipt, AgentMessagingError> {
        let Some(starter) = &self.starter else {
            tracing::warn!("agent messaging has no turn starter");
            return Err(AgentMessagingError::Storage);
        };
        let sender_address = format!("thread:{}", route.sender.thread_id);
        let recipient_address = format!("thread:{}", route.recipient.thread_id);
        let sender_mode = &route.sender.runtime_mode;
        let recipient_mode = &route.recipient.runtime_mode;
        if !policy::ceiling_allows(sender_mode, recipient_mode) {
            return Err(AgentMessagingError::ModeCeiling {
                sender: sender_mode.clone(),
                recipient: recipient_mode.clone(),
            });
        }
        let label = match route.sender.title.trim() {
            "" => "Agent".to_owned(),
            title => title.to_owned(),
        };
        let envelope = build_envelope(&EnvelopeInput {
            sender_title: &label,
            provider: &route.sender_provider,
            sender_address: &sender_address,
            message_id: outgoing.message_id,
            conversation_id: outgoing.conversation_id,
            in_reply_to: outgoing.in_reply_to,
            text: outgoing.text,
        });
        let command_id = format!("agent-message:{}", outgoing.message_id);
        let delivery_message_id = Uuid::new_v4().to_string();
        let now = crate::mcp::control::now_iso();
        let command: OrchestrationCommand = serde_json::from_value(serde_json::json!({
            "type": "thread.turn.start",
            "commandId": command_id,
            "threadId": route.recipient.thread_id,
            "message": {
                "messageId": delivery_message_id,
                "role": "user",
                "text": envelope,
                "attachments": [],
            },
            "runtimeMode": route.recipient.runtime_mode,
            "interactionMode": route.recipient.interaction_mode,
            // The dispatch path queues it only while the recipient's session still runs.
            "queued": true,
            "createdAt": now,
        }))
        .map_err(|error| {
            tracing::warn!(error = %error, "an agent message command did not build");
            AgentMessagingError::Storage
        })?;
        let mut paused = route.paused;
        let mut rechecked = false;
        let (admitted, status) = loop {
            // A queued message waits for the promotion gate, which admits it only once no turn
            // runs and no approval or question is open; one that ended since this read is
            // promoted then.
            let admission = admission_for(&route.recipient, route.session.as_ref(), paused);
            let force_queue = admission != TurnAdmission::Start;
            // A paused queue holds the message, with its entry, until a person releases the queue.
            let (status, reason) = if admission == TurnAdmission::Hold {
                (
                    AgentMessageStatus::Held,
                    Some(AgentMessageReason::RecipientQueueHeld),
                )
            } else {
                (AgentMessageStatus::Accepted, None)
            };
            let companion = AgentMessageCompanion::Insert(
                NewAgentMessage {
                    message_id: outgoing.message_id.to_owned(),
                    conversation_id: outgoing.conversation_id.to_owned(),
                    sender_address: sender_address.clone(),
                    sender_kind: SenderKind::Agent,
                    recipient_address: recipient_address.clone(),
                    in_reply_to: outgoing.in_reply_to.map(str::to_owned),
                    hop: outgoing.hop,
                    text: outgoing.text.to_owned(),
                    status,
                    reason,
                    accepted_at: now.clone(),
                    sender_runtime_mode: Some(sender_mode.clone()),
                    recipient_terminal_generation: None,
                    send_request_id: None,
                    client_request_id: outgoing.client_request_id.map(str::to_owned),
                    delivery_command_id: Some(command_id.clone()),
                    delivery_message_id: Some(delivery_message_id.clone()),
                },
                Some(policy::AdmissionLimits::now()),
            );
            let admitted = starter
                .queue_turn_start(
                    command.clone(),
                    ServerActor::HostedAgent {
                        address: sender_address.clone(),
                        label: label.clone(),
                    },
                    Some(AgentTurn {
                        companion,
                        force_queue,
                    }),
                )
                .await;
            // The queue paused or was released since `route` read it: read it again, once.
            let pause_changed = admitted.as_ref().err().is_some_and(|error| {
                error
                    .get("message")
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|detail| detail.ends_with(policy::QUEUE_PAUSE_CHANGED))
            });
            if pause_changed && !rechecked {
                rechecked = true;
                let thread_id = route.recipient.thread_id.clone();
                paused = self
                    .engine
                    .repositories()
                    .database()
                    .call(move |connection| store::queue_paused(connection, &thread_id))
                    .await
                    .map_err(|error| {
                        tracing::warn!(error = %error, "agent messaging could not read a queue");
                        AgentMessagingError::Storage
                    })?;
                continue;
            }
            break (admitted, status);
        };
        let admitted = admitted.map_err(|error| {
            // A limit names itself in the refusal's detail, which quotes nothing else here.
            let detail = error
                .get("message")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default();
            if detail.ends_with(policy::LimitRefusal::Rate.detail()) {
                return AgentMessagingError::RateLimit;
            }
            if detail.ends_with(policy::LimitRefusal::Backlog.detail()) {
                return AgentMessagingError::BacklogLimit;
            }
            // The refusal's tag only: its detail may quote the command.
            tracing::warn!(
                tag = error
                    .get("_tag")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("unknown"),
                "an agent message was not admitted"
            );
            AgentMessagingError::Storage
        });
        if let Err(error) = admitted {
            // Another call with the same id won the unique index, or took the last slot of a
            // limit first: answer from its row.
            return match self
                .replay(&sender_address, &recipient_address, &outgoing)
                .await?
            {
                Some(receipt) => Ok(receipt),
                None => Err(error),
            };
        }
        Ok(MessageReceipt {
            message_id: outgoing.message_id.to_owned(),
            conversation_id: outgoing.conversation_id.to_owned(),
            status,
            hop: outgoing.hop,
        })
    }

    /// The hop of a message the agent of `sender_thread_id` sends now, from the message that
    /// started its turn (R14); `HopLimit` past the limit.
    async fn next_hop(&self, sender_thread_id: &str) -> Result<u32, AgentMessagingError> {
        let sender = sender_thread_id.to_owned();
        let trigger = self
            .engine
            .repositories()
            .database()
            .call(move |connection| store::trigger_hop(connection, &sender))
            .await
            .map_err(|error| {
                tracing::warn!(error = %error, "agent messaging could not read the sender's turn");
                AgentMessagingError::Storage
            })?;
        policy::next_hop(trigger)
    }

    /// The receipt of the message this sender already stored under `outgoing`'s client
    /// request id, when its recipient, text and `in_reply_to` are the same (R12); `Conflict`
    /// when any differs; `None` without an id or a stored message.
    async fn replay(
        &self,
        sender_address: &str,
        recipient_address: &str,
        outgoing: &Outgoing<'_>,
    ) -> Result<Option<MessageReceipt>, AgentMessagingError> {
        let Some(client_request_id) = outgoing.client_request_id else {
            return Ok(None);
        };
        let (sender, client_request_id) = (sender_address.to_owned(), client_request_id.to_owned());
        let stored = self
            .engine
            .repositories()
            .database()
            .call(move |connection| {
                store::find_by_client_request(connection, &sender, &client_request_id)
            })
            .await
            .map_err(|error| {
                tracing::warn!(error = %error, "agent messaging could not read a client request id");
                AgentMessagingError::Storage
            })?;
        let Some(stored) = stored else {
            return Ok(None);
        };
        if stored.recipient_address != recipient_address
            || stored.text != outgoing.text
            || stored.in_reply_to.as_deref() != outgoing.in_reply_to
        {
            return Err(AgentMessagingError::Conflict);
        }
        Ok(Some(MessageReceipt {
            message_id: stored.message_id,
            conversation_id: stored.conversation_id,
            status: stored.status,
            hop: stored.hop,
        }))
    }

    /// Cancels a message the agent of `caller_thread_id` sent, while it is accepted, queued or
    /// held and its entry was not handed to the recipient's provider (R20). Any other caller's
    /// message reads as one that does not exist. Not refused while messaging is off.
    pub(crate) async fn cancel(
        &self,
        caller_thread_id: &str,
        message_id: &str,
    ) -> Result<AgentMessageStatus, AgentMessagingError> {
        let message = self
            .message(message_id)
            .await?
            .filter(|message| message.sender_address == format!("thread:{caller_thread_id}"))
            .ok_or(AgentMessagingError::UnknownMessage)?;
        if message.status == AgentMessageStatus::Cancelled {
            return Ok(AgentMessageStatus::Cancelled);
        }
        let id = message_id.to_owned();
        let cancelled = self
            .engine
            .repositories()
            .database()
            .call(move |connection| {
                store::cancel_waiting(connection, &id, &crate::mcp::control::now_iso())
            })
            .await
            .map_err(|error| {
                tracing::warn!(error = %error, "agent_message_cancel could not write");
                AgentMessagingError::Storage
            })?;
        // Re-read: a concurrent cancel may have won, and a release may have moved the entry.
        let message = self
            .message(message_id)
            .await?
            .ok_or(AgentMessagingError::UnknownMessage)?;
        if !cancelled {
            return match message.status {
                AgentMessageStatus::Cancelled => Ok(AgentMessageStatus::Cancelled),
                _ => Err(AgentMessagingError::NotCancellable),
            };
        }
        // The claim gate never claims a cancelled message, and the tracker withdraws an entry
        // this leaves behind.
        if !delivery::withdraw_from_queue(&self.engine, &message).await? {
            tracing::debug!(message_id = %message.message_id, "a cancelled message's entry is left to the tracker");
        }
        Ok(AgentMessageStatus::Cancelled)
    }

    /// Puts a held message back at the end of its recipient's queue under a new entry; false
    /// when it is no longer held on the entry `message` names. See [`delivery::requeue`].
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the tracker releases through delivery::requeue")
    )]
    pub(crate) async fn requeue(
        &self,
        message: &AgentMessageRow,
    ) -> Result<bool, AgentMessagingError> {
        delivery::requeue(&self.engine, message).await
    }

    pub(crate) fn is_enabled(&self) -> bool {
        *self.enabled.borrow()
    }

    /// The other agents of the caller's project. A caller whose thread is gone reaches nobody.
    pub(crate) async fn agents(
        &self,
        caller_thread_id: &str,
    ) -> Result<Vec<AgentSummary>, AgentMessagingError> {
        if !self.is_enabled() {
            return Err(AgentMessagingError::Disabled);
        }
        let caller = caller_thread_id.to_owned();
        let agents = self
            .engine
            .repositories()
            .database()
            .call(move |connection| {
                let Some((project_id, caller_mode)) = directory::project_of(connection, &caller)?
                else {
                    return Ok(None);
                };
                directory::list_agents(connection, &project_id, &caller, &caller_mode).map(Some)
            })
            .await
            .map_err(|error| {
                tracing::warn!(error = %error, "agents_list could not read the directory");
                AgentMessagingError::Storage
            })?;
        agents.ok_or(AgentMessagingError::UnknownRecipient)
    }
}
