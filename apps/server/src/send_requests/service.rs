//! `sendRequests.send`: a signed-in person's request to a specific chat agent. The request is
//! stored once per request id, then queued on the target as that person's own message with
//! its provenance (`message.personSend`), through the server-only command dispatcher.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::store::{SendAction, SendRequestRow, SendRequestStore, SendState};
use crate::{
    orchestration::{OrchestrationCommand, canonical_command_digest},
    persistence::{Database, ProjectionThread, Repositories},
    production::orchestration_rpc::{ServerActor, ServerCommandDispatcher},
    rpc::RpcSessionContext,
    transfer::staging::UploadOwner,
};

/// Note plus attachment text of one request, in Unicode scalar values.
pub(crate) const PERSON_REQUEST_MAX_CHARS: usize = 48_000;
/// The lead-in the client writes before the note, in Unicode scalar values.
pub(crate) const LEAD_IN_MAX_CHARS: usize = 16_000;

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
        }
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

        let args_digest = canonical_command_digest(&input).map_err(|error| invalid(&error))?;
        let command_id = format!("person-send:{}", input.request_id);
        let now = crate::mcp::control::now_iso();
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
                args_digest,
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
        if !created {
            // shortcut: every repeated request id is a conflict; task 1.5 adds the replay.
            return Err(refusal(
                "request_conflict",
                "A request with this id was already sent.",
            ));
        }

        let attachments = input
            .attachments
            .iter()
            .map(|attachment| (attachment.label.clone(), attachment.text.clone()))
            .collect::<Vec<_>>();
        let command = turn_command(
            &row,
            compose_message_text(&input.lead_in, &input.note, &attachments),
        )
        .map_err(|error| invalid(&error))?;
        (self.dispatcher)(
            command,
            UploadOwner::from_context(context),
            ServerActor::Person,
        )
        .await
        .map_err(|error| {
            tracing::warn!(
                request_id = %row.request_id,
                error = %error["_tag"],
                "a send request could not be queued"
            );
            refusal(
                "invalid",
                "BiBCode could not queue this request on the agent. Try again.",
            )
        })?;
        Ok(SendRequest::from(&row))
    }
}

/// The `thread.turn.start` a request queues, built only from its stored row and its text, so
/// a replay builds the same command.
fn turn_command(row: &SendRequestRow, text: String) -> Result<OrchestrationCommand, String> {
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
