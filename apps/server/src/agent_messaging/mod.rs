//! Messages between the agents of one project: the store, the directory, the envelope and the
//! provider tools. Off unless `agentMessaging.enabled` is on. An agent's identity is the thread
//! of its credential, never an argument, and it reaches only agents of its own project.

pub(crate) mod delivery;
pub(crate) mod directory;
pub(crate) mod envelope;
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
}

/// `Queue` while the recipient's session runs or starts a turn, `Start` otherwise (no session
/// at all included, so a never-started recipient is not stranded in the queue).
pub(crate) fn admission_for(
    _thread: &ProjectionThread,
    session: Option<&ProjectionThreadSession>,
) -> TurnAdmission {
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

/// The sender and recipient threads of a send that passed every check.
struct Route {
    sender: ProjectionThread,
    sender_provider: String,
    recipient: ProjectionThread,
    session: Option<ProjectionThreadSession>,
}

#[derive(Clone)]
pub(crate) struct AgentMessaging {
    engine: OrchestrationEngine,
    enabled: watch::Receiver<bool>,
    starter: Option<ServerTurnStarter>,
    outcomes: Option<OutcomeSink>,
}

impl AgentMessaging {
    pub(crate) fn new(engine: OrchestrationEngine, enabled: watch::Receiver<bool>) -> Self {
        Self {
            engine,
            enabled,
            starter: None,
            outcomes: None,
        }
    }

    pub(crate) fn with_starter(mut self, starter: ServerTurnStarter) -> Self {
        self.starter = Some(starter);
        self
    }

    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "task 7.2 supplies the activity sink")
    )]
    pub(crate) fn with_outcomes(mut self, outcomes: OutcomeSink) -> Self {
        self.outcomes = Some(outcomes);
        self
    }

    /// Sends `request` from the agent of `sender_thread_id` to another agent of its project.
    pub(crate) async fn send(
        &self,
        sender_thread_id: &str,
        request: SendRequest,
    ) -> Result<MessageReceipt, AgentMessagingError> {
        let result = self.send_inner(sender_thread_id, &request).await;
        if let Some(outcomes) = &self.outcomes {
            let (outcome, receipt) = match &result {
                Ok((receipt, _)) => ("accepted".to_owned(), Some(receipt)),
                Err(error) => (error.tag().to_owned(), None),
            };
            let titles = result.as_ref().ok().map(|(_, titles)| titles);
            outcomes(MessageOutcome {
                sender_address: format!("thread:{sender_thread_id}"),
                recipient_address: request.to.clone(),
                tool: "agent_message_send",
                outcome,
                message_id: receipt.map(|receipt| receipt.message_id.clone()),
                conversation_id: receipt.map(|receipt| receipt.conversation_id.clone()),
                hop: receipt.map(|receipt| receipt.hop),
                reason: None,
                sender_title: titles.map(|(sender, _)| sender.clone()),
                recipient_title: titles.map(|(_, recipient)| recipient.clone()),
            });
        }
        result.map(|(receipt, _)| receipt)
    }

    /// Replies to `request.in_reply_to`, a message the agent of `sender_thread_id` received:
    /// the reply goes to that message's sender, in the same conversation. It returns at once.
    pub(crate) async fn reply(
        &self,
        sender_thread_id: &str,
        request: ReplyRequest,
    ) -> Result<MessageReceipt, AgentMessagingError> {
        if !self.is_enabled() {
            return Err(AgentMessagingError::Disabled);
        }
        let original = self
            .message(&request.in_reply_to)
            .await?
            .filter(|message| message.recipient_address == format!("thread:{sender_thread_id}"))
            .ok_or(AgentMessagingError::UnknownMessage)?;
        let recipient_thread_id = original
            .sender_address
            .strip_prefix("thread:")
            .ok_or(AgentMessagingError::RecipientGone)?;
        let route = match self.route(sender_thread_id, recipient_thread_id).await {
            Err(AgentMessagingError::UnknownRecipient) => {
                return Err(AgentMessagingError::RecipientGone);
            }
            route => route?,
        };
        check_text(&request.text)?;
        let message_id = Uuid::new_v4().to_string();
        self.deliver(
            &route,
            Outgoing {
                message_id: &message_id,
                conversation_id: &original.conversation_id,
                in_reply_to: Some(&original.message_id),
                // Hop counting is task 6.5's.
                hop: 1,
                text: &request.text,
                client_request_id: request.client_request_id.as_deref(),
            },
        )
        .await
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

    /// The receipt and the two thread titles of an accepted send.
    async fn send_inner(
        &self,
        sender_thread_id: &str,
        request: &SendRequest,
    ) -> Result<(MessageReceipt, (String, String)), AgentMessagingError> {
        if !self.is_enabled() {
            return Err(AgentMessagingError::Disabled);
        }
        let recipient_thread_id = request
            .to
            .strip_prefix("thread:")
            .filter(|id| !id.is_empty() && *id != sender_thread_id)
            .ok_or(AgentMessagingError::UnknownRecipient)?;
        let route = self.route(sender_thread_id, recipient_thread_id).await?;
        check_text(&request.text)?;
        let message_id = Uuid::new_v4().to_string();
        let conversation_id = Uuid::new_v4().to_string();
        let receipt = self
            .deliver(
                &route,
                Outgoing {
                    message_id: &message_id,
                    conversation_id: &conversation_id,
                    in_reply_to: None,
                    hop: 1,
                    text: &request.text,
                    client_request_id: request.client_request_id.as_deref(),
                },
            )
            .await?;
        Ok((receipt, (route.sender.title, route.recipient.title)))
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
        // The dispatch path reads the session again and queues only while it still runs, so a
        // turn that ended since this read starts the message; neither admission forces it.
        let force_queue = match admission_for(&route.recipient, route.session.as_ref()) {
            TurnAdmission::Start | TurnAdmission::Queue => false,
        };
        let companion = AgentMessageCompanion::Insert(NewAgentMessage {
            message_id: outgoing.message_id.to_owned(),
            conversation_id: outgoing.conversation_id.to_owned(),
            sender_address: sender_address.clone(),
            sender_kind: SenderKind::Agent,
            recipient_address,
            in_reply_to: outgoing.in_reply_to.map(str::to_owned),
            hop: outgoing.hop,
            text: outgoing.text.to_owned(),
            status: AgentMessageStatus::Accepted,
            reason: None,
            accepted_at: now,
            sender_runtime_mode: None,
            recipient_terminal_generation: None,
            send_request_id: None,
            client_request_id: outgoing.client_request_id.map(str::to_owned),
            delivery_command_id: Some(command_id),
            delivery_message_id: Some(delivery_message_id),
        });
        starter
            .queue_turn_start(
                command,
                ServerActor::HostedAgent {
                    address: sender_address,
                    label,
                },
                Some(AgentTurn {
                    companion,
                    force_queue,
                }),
            )
            .await
            .map_err(|error| {
                // The refusal's tag only: its detail may quote the command.
                tracing::warn!(
                    tag = error
                        .get("_tag")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("unknown"),
                    "an agent message was not admitted"
                );
                AgentMessagingError::Storage
            })?;
        Ok(MessageReceipt {
            message_id: outgoing.message_id.to_owned(),
            conversation_id: outgoing.conversation_id.to_owned(),
            status: AgentMessageStatus::Accepted,
            hop: outgoing.hop,
        })
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
                let Some(project_id) = directory::project_of(connection, &caller)? else {
                    return Ok(None);
                };
                directory::list_agents(connection, &project_id, &caller).map(Some)
            })
            .await
            .map_err(|error| {
                tracing::warn!(error = %error, "agents_list could not read the directory");
                AgentMessagingError::Storage
            })?;
        agents.ok_or(AgentMessagingError::UnknownRecipient)
    }
}
