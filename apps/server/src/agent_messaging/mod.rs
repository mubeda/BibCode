//! Messages between the agents of one project: the store, the directory, the envelope and the
//! provider tools. Off unless `agentMessaging.enabled` is on. An agent's identity is the thread
//! of its credential, never an argument, and it reaches only agents of its own project.

pub(crate) mod delivery;
pub(crate) mod directory;
pub(crate) mod envelope;
pub(crate) mod pointer;
pub(crate) mod policy;
pub mod store;
pub mod terminal_credential;

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
    /// `bibcode agent` ran without an AI Terminal's credential.
    NoIdentity,
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
            Self::NoIdentity => "AgentMessagingNoIdentityError",
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
            Self::NoIdentity => {
                "This command has no agent identity. Run it in an AI Terminal that BiBCode started."
                    .to_owned()
            }
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

/// What one send or reply call learned about who it involves, for its activity row: both thread
/// titles once it resolved the recipient as a live thread of the sender's project, never before.
#[derive(Default)]
struct Attribution {
    titles: Option<(String, String)>,
}

/// Who a message comes from: the caller, with the title, provider and mode it sends with. A
/// terminal sends with its label and launch driver kind, and with its host thread's mode (R6).
struct Sender {
    address: String,
    title: String,
    provider: String,
    mode: String,
}

/// Where a send or reply goes.
enum Recipient {
    Thread(String),
    Terminal { owner: String, terminal: String },
}

impl Recipient {
    fn parse(address: &str) -> Option<Self> {
        if let Some((owner, terminal)) = terminal_credential::parse_terminal_address(address) {
            return Some(Self::Terminal { owner, terminal });
        }
        address
            .strip_prefix("thread:")
            .filter(|id| !id.is_empty())
            .map(|id| Self::Thread(id.to_owned()))
    }
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
    terminals: Option<pointer::TerminalPointer>,
}

impl AgentMessaging {
    pub(crate) fn new(engine: OrchestrationEngine, enabled: watch::Receiver<bool>) -> Self {
        Self {
            engine,
            enabled,
            starter: None,
            outcomes: None,
            terminals: None,
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

    #[cfg(test)]
    /// Sends `request` from the agent of `sender_thread_id` to another agent of its project.
    pub(crate) async fn send(
        &self,
        sender_thread_id: &str,
        request: SendRequest,
    ) -> Result<MessageReceipt, AgentMessagingError> {
        self.send_as(&AgentCaller::Thread(sender_thread_id.to_owned()), request)
            .await
    }

    /// Sends `request` from `caller` to another agent of its project.
    pub(crate) async fn send_as(
        &self,
        caller: &AgentCaller,
        request: SendRequest,
    ) -> Result<MessageReceipt, AgentMessagingError> {
        let mut attribution = Attribution::default();
        let result = self.send_inner(caller, &request, &mut attribution).await;
        self.report(
            "agent_message_send",
            caller,
            &request.to,
            attribution,
            result.as_ref(),
        );
        result
    }

    /// Reports a send or reply the tool refused before calling [`Self::send_as`] or
    /// [`Self::reply_as`], with no argument of it, and returns the refusal.
    pub(crate) fn refused(
        &self,
        tool: &'static str,
        caller: &AgentCaller,
        error: AgentMessagingError,
    ) -> AgentMessagingError {
        self.report(tool, caller, "", Attribution::default(), Err(&error));
        error
    }

    /// Tells the outcome sink, if any, what one send or reply call ended with.
    fn report(
        &self,
        tool: &'static str,
        caller: &AgentCaller,
        recipient_address: &str,
        attribution: Attribution,
        result: Result<&MessageReceipt, &AgentMessagingError>,
    ) {
        let Some(outcomes) = &self.outcomes else {
            return;
        };
        // Without titles the writer fills in the caller's own: it tells the caller nothing about
        // any other thread, and the caller never waits on the database for it.
        let titles = attribution
            .titles
            .map_or((None, None), |(sender, recipient)| {
                (Some(sender), Some(recipient))
            });
        let (outcome, receipt) = match result {
            Ok(receipt) => ("accepted".to_owned(), Some(receipt)),
            Err(error) => (error.tag().to_owned(), None),
        };
        outcomes(MessageOutcome {
            sender_address: caller.address(),
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
    }

    #[cfg(test)]
    /// Replies to `request.in_reply_to`, a message the agent of `sender_thread_id` received:
    /// the reply goes to that message's sender, in the same conversation. It returns at once.
    pub(crate) async fn reply(
        &self,
        sender_thread_id: &str,
        request: ReplyRequest,
    ) -> Result<MessageReceipt, AgentMessagingError> {
        self.reply_as(&AgentCaller::Thread(sender_thread_id.to_owned()), request)
            .await
    }

    /// Replies to `request.in_reply_to`, a message `caller` received. A terminal replies only to
    /// mail its own generation fetched, and its reply completes that mail (R11).
    pub(crate) async fn reply_as(
        &self,
        caller: &AgentCaller,
        request: ReplyRequest,
    ) -> Result<MessageReceipt, AgentMessagingError> {
        let mut recipient_address = String::new();
        let mut attribution = Attribution::default();
        let result = self
            .reply_inner(caller, &request, &mut recipient_address, &mut attribution)
            .await;
        self.report(
            "agent_message_reply",
            caller,
            &recipient_address,
            attribution,
            result.as_ref(),
        );
        result
    }

    /// The receipt of an accepted reply. `recipient_address` is set once the message replied to
    /// is known to be the caller's.
    async fn reply_inner(
        &self,
        caller: &AgentCaller,
        request: &ReplyRequest,
        recipient_address: &mut String,
        attribution: &mut Attribution,
    ) -> Result<MessageReceipt, AgentMessagingError> {
        let original = self
            .message(&request.in_reply_to)
            .await?
            .filter(|message| received_by(message, caller));
        // A person's request is answered whatever the setting is (R5).
        if let Some(original) = original
            .as_ref()
            .filter(|message| message.sender_kind == SenderKind::Person)
        {
            recipient_address.clone_from(&original.sender_address);
            return self.answer_person(caller, original, request).await;
        }
        if !self.is_enabled() {
            return Err(AgentMessagingError::Disabled);
        }
        let original = original.ok_or(AgentMessagingError::UnknownMessage)?;
        recipient_address.clone_from(&original.sender_address);
        let recipient =
            Recipient::parse(&original.sender_address).ok_or(AgentMessagingError::RecipientGone)?;
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
        let receipt = match self
            .replay(&caller.address(), &original.sender_address, &outgoing)
            .await?
        {
            Some(receipt) => receipt,
            None => match self
                .deliver_to(caller, &recipient, outgoing, attribution)
                .await
            {
                Err(AgentMessagingError::UnknownRecipient) => {
                    return Err(AgentMessagingError::RecipientGone);
                }
                receipt => receipt?,
            },
        };
        if matches!(caller, AgentCaller::Terminal(_)) {
            self.complete(&original.message_id).await?;
        }
        Ok(receipt)
    }

    /// A terminal's reply to a person's request it fetched: stored `completed` with no queue entry,
    /// so it starts no turn (R10), in the transaction that completes the request's mail, under the
    /// terminal's exclusion; then the request takes it as its answer through the request sink.
    async fn answer_person(
        &self,
        caller: &AgentCaller,
        original: &AgentMessageRow,
        request: &ReplyRequest,
    ) -> Result<MessageReceipt, AgentMessagingError> {
        // The answer is cut to the request's limit when stored, not refused here.
        if request.text.trim().is_empty() {
            return Err(AgentMessagingError::InvalidArgument(
                "text must not be empty.".to_owned(),
            ));
        }
        let pointer = self
            .terminals
            .as_ref()
            .ok_or(AgentMessagingError::UnknownMessage)?;
        let message_id = Uuid::new_v4().to_string();
        let outgoing = Outgoing {
            message_id: &message_id,
            conversation_id: &original.conversation_id,
            in_reply_to: Some(&original.message_id),
            hop: 1,
            text: &request.text,
            client_request_id: request.client_request_id.as_deref(),
        };
        let _exclusive = pointer.exclusive(&original.recipient_address).await;
        if let Some(receipt) = self
            .replay(&caller.address(), &original.sender_address, &outgoing)
            .await?
        {
            return Ok(receipt);
        }
        // A request has one answer; only a replay of it gets past here once it is answered.
        if original.status == AgentMessageStatus::Completed {
            return Err(AgentMessagingError::InvalidArgument(
                "This request was already answered.".to_owned(),
            ));
        }
        let now = crate::mcp::control::now_iso();
        let reply = NewAgentMessage {
            message_id: message_id.clone(),
            conversation_id: original.conversation_id.clone(),
            sender_address: caller.address(),
            sender_kind: SenderKind::Agent,
            recipient_address: original.sender_address.clone(),
            in_reply_to: Some(original.message_id.clone()),
            hop: 1,
            text: request.text.clone(),
            status: AgentMessageStatus::Completed,
            reason: None,
            accepted_at: now.clone(),
            sender_runtime_mode: None,
            recipient_terminal_generation: None,
            send_request_id: original.send_request_id.clone(),
            client_request_id: request.client_request_id.clone(),
            delivery_command_id: None,
            delivery_message_id: None,
        };
        let original_id = original.message_id.clone();
        let stored = self
            .engine
            .repositories()
            .database()
            .call(move |connection| {
                let tx = connection.transaction()?;
                store::set_status(&tx, &original_id, AgentMessageStatus::Completed, None, &now)?;
                store::insert_message(&tx, &reply)?;
                let stored = store::get_message(&tx, &reply.message_id)?;
                tx.commit()?;
                Ok(stored)
            })
            .await
            .map_err(|error| {
                tracing::warn!(error = %error, "a terminal's answer to a person was not stored");
                AgentMessagingError::Storage
            })?;
        if let Some(stored) = stored {
            pointer.tell_requests(std::slice::from_ref(&stored)).await;
        }
        Ok(MessageReceipt {
            message_id,
            conversation_id: original.conversation_id.clone(),
            status: AgentMessageStatus::Completed,
            hop: 1,
        })
    }

    /// Moves mail a terminal fetched to `completed` once the terminal replied to it.
    async fn complete(&self, message_id: &str) -> Result<(), AgentMessagingError> {
        let id = message_id.to_owned();
        self.engine
            .repositories()
            .database()
            .call(move |connection| {
                store::set_status(
                    connection,
                    &id,
                    AgentMessageStatus::Completed,
                    None,
                    &crate::mcp::control::now_iso(),
                )
            })
            .await
            .map(drop)
            .map_err(|error| {
                tracing::warn!(error = %error, "a replied terminal message was not completed");
                AgentMessagingError::Storage
            })
    }

    /// The stored status of a message `caller` sent.
    pub(crate) async fn status_as(
        &self,
        caller: &AgentCaller,
        message_id: &str,
    ) -> Result<StatusReport, AgentMessagingError> {
        if !self.is_enabled() {
            return Err(AgentMessagingError::Disabled);
        }
        let message = self
            .message(message_id)
            .await?
            .filter(|message| is_sent_by(message, caller))
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
        caller: &AgentCaller,
        request: &SendRequest,
        attribution: &mut Attribution,
    ) -> Result<MessageReceipt, AgentMessagingError> {
        if !self.is_enabled() {
            return Err(AgentMessagingError::Disabled);
        }
        let recipient = Recipient::parse(&request.to)
            .filter(|_| request.to != caller.address())
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
            .replay(&caller.address(), &request.to, &outgoing)
            .await?
        {
            return Ok(receipt);
        }
        self.deliver_to(caller, &recipient, outgoing, attribution)
            .await
    }

    /// Stores `outgoing` from `caller` for `recipient`, under every check: a chat recipient gets
    /// a queue entry, an AI Terminal a mailbox row.
    async fn deliver_to(
        &self,
        caller: &AgentCaller,
        recipient: &Recipient,
        outgoing: Outgoing<'_>,
        attribution: &mut Attribution,
    ) -> Result<MessageReceipt, AgentMessagingError> {
        match recipient {
            Recipient::Thread(thread_id) => {
                let route = self.route(caller.owner_thread_id(), thread_id).await?;
                let sender = self.sender(caller, &route).await;
                attribution.titles = Some((sender.title.clone(), route.recipient.title.clone()));
                let outgoing = Outgoing {
                    hop: self.next_hop_as(caller).await?,
                    ..outgoing
                };
                self.deliver(&route, &sender, outgoing).await
            }
            Recipient::Terminal { owner, terminal } => {
                self.deliver_to_terminal(caller, owner, terminal, outgoing, attribution)
                    .await
            }
        }
    }

    /// Who `caller` sends as, given its owner thread in `route`.
    async fn sender(&self, caller: &AgentCaller, route: &Route) -> Sender {
        match caller {
            AgentCaller::Thread(_) => Sender {
                address: caller.address(),
                title: route.sender.title.clone(),
                provider: route.sender_provider.clone(),
                mode: route.sender.runtime_mode.clone(),
            },
            AgentCaller::Terminal(identity) => {
                let address = identity.address();
                let description = self.sender_description(&address).await;
                Sender {
                    address,
                    title: description.title,
                    provider: description.provider,
                    mode: route.sender.runtime_mode.clone(),
                }
            }
        }
    }

    /// The hop of a message `caller` sends now (R14): a chat agent's from the message that started
    /// its turn, a terminal's from the highest hop its generation fetched since a person typed.
    async fn next_hop_as(&self, caller: &AgentCaller) -> Result<u32, AgentMessagingError> {
        match caller {
            AgentCaller::Thread(thread_id) => self.next_hop(thread_id).await,
            AgentCaller::Terminal(identity) => {
                let trigger = match &self.terminals {
                    Some(pointer) => pointer.terminal_trigger_hop(identity).await,
                    None => None,
                };
                policy::next_hop(trigger)
            }
        }
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
        sender: &Sender,
        outgoing: Outgoing<'_>,
    ) -> Result<MessageReceipt, AgentMessagingError> {
        let Some(starter) = &self.starter else {
            tracing::warn!("agent messaging has no turn starter");
            return Err(AgentMessagingError::Storage);
        };
        let sender_address = sender.address.clone();
        let recipient_address = format!("thread:{}", route.recipient.thread_id);
        let sender_mode = &sender.mode;
        let recipient_mode = &route.recipient.runtime_mode;
        if !policy::ceiling_allows(sender_mode, recipient_mode) {
            return Err(AgentMessagingError::ModeCeiling {
                sender: sender_mode.clone(),
                recipient: recipient_mode.clone(),
            });
        }
        let label = match sender.title.trim() {
            "" => "Agent".to_owned(),
            title => title.to_owned(),
        };
        let envelope = build_envelope(&EnvelopeInput {
            sender_title: &label,
            provider: &sender.provider,
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

    #[cfg(test)]
    /// Cancels a message the agent of `caller_thread_id` sent, while it is accepted, queued or
    /// held and its entry was not handed to the recipient's provider (R20). Any other caller's
    /// message reads as one that does not exist. Not refused while messaging is off.
    pub(crate) async fn cancel(
        &self,
        caller_thread_id: &str,
        message_id: &str,
    ) -> Result<AgentMessageStatus, AgentMessagingError> {
        self.cancel_as(
            &AgentCaller::Thread(caller_thread_id.to_owned()),
            message_id,
        )
        .await
    }

    /// [`Self::cancel`] for a message `caller` sent.
    pub(crate) async fn cancel_as(
        &self,
        caller: &AgentCaller,
        message_id: &str,
    ) -> Result<AgentMessageStatus, AgentMessagingError> {
        let message = self
            .message(message_id)
            .await?
            .filter(|message| is_sent_by(message, caller))
            .ok_or(AgentMessagingError::UnknownMessage)?;
        if message.status == AgentMessageStatus::Cancelled {
            return Ok(AgentMessageStatus::Cancelled);
        }
        let id = message_id.to_owned();
        // A terminal row has no queue entry; it stays cancellable until an inbox fetched it.
        let terminal = message.recipient_address.starts_with("terminal:");
        // A pointer write holds the terminal's exclusion until its mail is marked, so a cancel
        // never lands between the pointer's eligibility read and its write.
        let _exclusive = match (&self.terminals, terminal) {
            (Some(pointer), true) => Some(pointer.exclusive(&message.recipient_address).await),
            _ => None,
        };
        let cancelled = self
            .engine
            .repositories()
            .database()
            .call(move |connection| {
                let now = crate::mcp::control::now_iso();
                if terminal {
                    store::cancel_unfetched_terminal(connection, &id, &now)
                } else {
                    store::cancel_waiting(connection, &id, &now)
                }
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
        if !terminal && !delivery::withdraw_from_queue(&self.engine, &message).await? {
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

    /// The chat agents and AI Terminals of `caller`'s project, except `caller` itself: a
    /// terminal lists its host thread, and a thread its own terminals. A caller whose owner
    /// thread is gone reaches nobody. Only threads of that one project are read.
    pub(crate) async fn agents_for(
        &self,
        caller: &AgentCaller,
    ) -> Result<Vec<AgentSummary>, AgentMessagingError> {
        if !self.is_enabled() {
            return Err(AgentMessagingError::Disabled);
        }
        let owner = caller.owner_thread_id().to_owned();
        let excluded = match caller {
            AgentCaller::Thread(thread_id) => Some(thread_id.clone()),
            AgentCaller::Terminal(_) => None,
        };
        let listed = self
            .engine
            .repositories()
            .database()
            .call(move |connection| {
                let Some((project_id, caller_mode)) = directory::project_of(connection, &owner)?
                else {
                    return Ok(None);
                };
                let chats = directory::list_agents(
                    connection,
                    &project_id,
                    excluded.as_deref(),
                    &caller_mode,
                )?;
                let owners = directory::terminal_owner_threads(connection, &project_id)?;
                Ok(Some((chats, owners, caller_mode)))
            })
            .await
            .map_err(|error| {
                tracing::warn!(error = %error, "agents_list could not read the directory");
                AgentMessagingError::Storage
            })?;
        let (mut agents, owners, caller_mode) =
            listed.ok_or(AgentMessagingError::UnknownRecipient)?;
        if let Some(pointer) = &self.terminals {
            let own_address = caller.address();
            for owner in owners {
                let mut sessions = pointer.terminals().thread_sessions(&owner).await;
                sessions.sort_by(|left, right| left.terminal_id.cmp(&right.terminal_id));
                agents.extend(
                    sessions
                        .iter()
                        .filter_map(|summary| directory::terminal_agent(summary, &caller_mode))
                        .filter(|agent| agent.address != own_address),
                );
            }
        }
        Ok(agents)
    }
}

/// Who calls a messaging operation: a chat agent by its thread, or an AI Terminal by the live
/// generation its credential names. Never taken from an argument.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum AgentCaller {
    Thread(String),
    Terminal(terminal_credential::TerminalIdentity),
}

impl AgentCaller {
    pub(crate) fn address(&self) -> String {
        match self {
            Self::Thread(thread_id) => format!("thread:{thread_id}"),
            Self::Terminal(identity) => identity.address(),
        }
    }

    /// The thread whose project and runtime mode the caller has: a terminal's host thread.
    pub(crate) fn owner_thread_id(&self) -> &str {
        match self {
            Self::Thread(thread_id) => thread_id,
            Self::Terminal(identity) => &identity.thread_id,
        }
    }
}

/// Who an address is, for an envelope or the activity log: a thread's title and provider, or a
/// terminal's label and launch driver kind. Empty when unknown.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct SenderDescription {
    pub(crate) title: String,
    pub(crate) provider: String,
}

/// AI Terminal recipients (task 8.4).
impl AgentMessaging {
    pub(crate) fn with_terminals(mut self, terminals: pointer::TerminalPointer) -> Self {
        self.terminals = Some(terminals);
        self
    }

    /// The mail of the terminal generation `caller` names, consumed as it is returned. A chat
    /// agent reads its messages in its own thread and has no inbox.
    pub(crate) async fn inbox_as(
        &self,
        caller: &AgentCaller,
    ) -> Result<Vec<pointer::InboxEntry>, AgentMessagingError> {
        let AgentCaller::Terminal(identity) = caller else {
            return Err(AgentMessagingError::InvalidArgument(
                "Only an AI Terminal has an inbox; a chat agent reads its messages in its thread."
                    .to_owned(),
            ));
        };
        match &self.terminals {
            Some(pointer) => pointer.inbox(self, identity).await,
            None => Ok(Vec::new()),
        }
    }

    pub(crate) async fn sender_description(&self, address: &str) -> SenderDescription {
        if let Some(thread_id) = address.strip_prefix("thread:") {
            let repositories = self.engine.repositories();
            let Ok(Some(thread)) = repositories.get_thread(thread_id.to_owned()).await else {
                return SenderDescription::default();
            };
            let session = repositories
                .get_thread_session(thread_id.to_owned())
                .await
                .ok()
                .flatten();
            let provider = session
                .and_then(|session| session.provider_name)
                .or_else(|| {
                    thread
                        .model_selection
                        .get("instanceId")
                        .and_then(serde_json::Value::as_str)
                        .map(str::to_owned)
                })
                .unwrap_or_default();
            return SenderDescription {
                title: thread.title,
                provider,
            };
        }
        match terminal_credential::parse_terminal_address(address) {
            Some((thread_id, terminal_id)) => self
                .terminal_summary(&thread_id, &terminal_id)
                .await
                .map(|summary| SenderDescription {
                    provider: summary
                        .command
                        .and_then(|command| command.activity)
                        .map(|activity| activity.driver_kind)
                        .unwrap_or_default(),
                    title: summary.label,
                })
                .unwrap_or_default(),
            None => SenderDescription::default(),
        }
    }

    async fn terminal_summary(
        &self,
        thread_id: &str,
        terminal_id: &str,
    ) -> Option<crate::terminal::TerminalSummary> {
        self.terminals
            .as_ref()?
            .terminals()
            .thread_sessions(thread_id)
            .await
            .into_iter()
            .find(|summary| summary.terminal_id == terminal_id)
    }

    /// Stores `outgoing` for the AI Terminal `terminal_id` of `owner_thread_id`, which must be a
    /// live thread of the sender's project; a plain shell, a terminal that is not running and
    /// any other terminal read as an unknown address.
    async fn deliver_to_terminal(
        &self,
        caller: &AgentCaller,
        owner_thread_id: &str,
        terminal_id: &str,
        outgoing: Outgoing<'_>,
        attribution: &mut Attribution,
    ) -> Result<MessageReceipt, AgentMessagingError> {
        let pointer = self
            .terminals
            .as_ref()
            .ok_or(AgentMessagingError::UnknownRecipient)?;
        let route = self
            .route(caller.owner_thread_id(), owner_thread_id)
            .await?;
        let summary = self
            .terminal_summary(owner_thread_id, terminal_id)
            .await
            .filter(|summary| {
                summary.agent_status.is_some()
                    && summary.status == crate::terminal::TerminalStatus::Running
            })
            .ok_or(AgentMessagingError::UnknownRecipient)?;
        let sender = self.sender(caller, &route).await;
        attribution.titles = Some((sender.title.clone(), summary.label));
        let generation = pointer
            .terminals()
            .live_generation(owner_thread_id, terminal_id)
            .await
            .ok_or(AgentMessagingError::UnknownRecipient)?;
        let hop = self.next_hop_as(caller).await?;
        let recipient = terminal_credential::TerminalIdentity {
            // Routing reads only the address and the generation.
            environment_id: String::new(),
            thread_id: owner_thread_id.to_owned(),
            terminal_id: terminal_id.to_owned(),
            generation,
        };
        let recipient_address = recipient.address();
        let new = NewAgentMessage {
            message_id: outgoing.message_id.to_owned(),
            conversation_id: outgoing.conversation_id.to_owned(),
            sender_address: sender.address.clone(),
            sender_kind: SenderKind::Agent,
            recipient_address: recipient_address.clone(),
            in_reply_to: outgoing.in_reply_to.map(str::to_owned),
            hop,
            text: outgoing.text.to_owned(),
            status: AgentMessageStatus::Queued,
            reason: None,
            accepted_at: crate::mcp::control::now_iso(),
            sender_runtime_mode: Some(sender.mode),
            recipient_terminal_generation: None,
            send_request_id: None,
            client_request_id: outgoing.client_request_id.map(str::to_owned),
            delivery_command_id: None,
            delivery_message_id: None,
        };
        if let Err(error) = pointer.accept(self, new, &recipient).await {
            // Another call with the same id won the unique index first: answer from its row.
            return match self
                .replay(&sender.address, &recipient_address, &outgoing)
                .await?
            {
                Some(receipt) => Ok(receipt),
                None => Err(error),
            };
        }
        let status = if self.is_enabled() {
            AgentMessageStatus::Queued
        } else {
            AgentMessageStatus::Held
        };
        Ok(MessageReceipt {
            message_id: outgoing.message_id.to_owned(),
            conversation_id: outgoing.conversation_id.to_owned(),
            status,
            hop,
        })
    }
}

/// `message` is an agent message `caller` sent. A person's request carries its source agent's
/// address as its sender, but that agent never sent it, so it may neither see nor cancel it.
fn is_sent_by(message: &AgentMessageRow, caller: &AgentCaller) -> bool {
    message.sender_kind == SenderKind::Agent && message.sender_address == caller.address()
}

/// `message` was sent to `caller`: to its thread, or to the terminal generation that fetched it
/// (`completed` once it replied, so a retry with the same `clientRequestId` replays its receipt).
fn received_by(message: &AgentMessageRow, caller: &AgentCaller) -> bool {
    if message.recipient_address != caller.address() {
        return false;
    }
    match caller {
        AgentCaller::Thread(_) => true,
        AgentCaller::Terminal(identity) => {
            matches!(
                message.status,
                AgentMessageStatus::Consumed | AgentMessageStatus::Completed
            ) && message.recipient_terminal_generation.as_deref()
                == Some(identity.generation_key().as_str())
        }
    }
}
