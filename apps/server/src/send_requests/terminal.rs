//! A person's request to an AI Terminal agent. The request is stored in the terminal
//! generation's mailbox as the person's own row, announced only by the fixed pointer line, and
//! fetched by the agent with `bibcode agent inbox`, whether agent messaging is on or not. The
//! request follows its mail: delivered when the pointer was typed, read when the inbox returned
//! it, answered when the terminal replied to it.

use std::sync::Arc;

use serde_json::Value;

use super::{
    service::{SendRequestsService, cut_answer, refusal},
    store::{SendAction, SendRequestRow, SendState, StateChange},
};
pub(crate) use crate::agent_messaging::pointer::RequestStateSink;
use crate::agent_messaging::{
    AgentMessagingError, directory,
    pointer::{TERMINAL_RECIPIENT_MODE, TerminalPointer},
    store::{AgentMessageRow, AgentMessageStatus, NewAgentMessage, SenderKind},
    terminal_credential::{TerminalIdentity, parse_terminal_address},
};

pub(crate) fn action_label(action: SendAction) -> &'static str {
    match action {
        SendAction::Review => "Review",
        SendAction::SecondOpinion => "Second opinion",
        SendAction::HandOff => "Hand off",
        SendAction::TakeOver => "Take over from",
        SendAction::Message => "Message",
    }
}

/// The text a terminal's inbox prints for a person's request: who it is from, then the request.
/// Never the agent envelope, because it comes from the person (R8).
pub(crate) fn render_request(action: SendAction, source_title: &str, text: &str) -> String {
    format!(
        "From the user of this project: {}, sent from {source_title}.\n\n{text}",
        action_label(action)
    )
}

pub(crate) fn not_notifiable() -> Value {
    refusal(
        "target_not_notifiable",
        "This terminal cannot be notified of new requests. Choose another agent.",
    )
}

/// The live generation of the AI Terminal at `address`, when BiBCode can tell it about mail: a
/// running AI Terminal whose readiness it observes (the directory's `canReceive`).
pub(crate) async fn notifiable_target(
    pointer: &TerminalPointer,
    address: &str,
) -> Result<TerminalIdentity, Value> {
    let (thread_id, terminal_id) = parse_terminal_address(address).ok_or_else(not_notifiable)?;
    let notifiable = pointer
        .terminals()
        .thread_sessions(&thread_id)
        .await
        .iter()
        .find(|summary| summary.terminal_id == terminal_id)
        .and_then(|summary| directory::terminal_agent(summary, TERMINAL_RECIPIENT_MODE))
        .is_some_and(|agent| agent.can_receive);
    if !notifiable {
        return Err(not_notifiable());
    }
    let generation = pointer
        .terminals()
        .live_generation(&thread_id, &terminal_id)
        .await
        .ok_or_else(not_notifiable)?;
    Ok(TerminalIdentity {
        // Routing reads only the address and the generation.
        environment_id: String::new(),
        thread_id,
        terminal_id,
        generation,
    })
}

/// Stores the request `row` in `target`'s mailbox as one `queued` row from the person, with id
/// `person-send:{requestId}` (a second store of that id is a replay and changes nothing), and
/// lets the pointer announce it. A generation that ended meanwhile ends the request unanswered.
pub(crate) async fn deliver_person_request(
    service: &SendRequestsService,
    row: &SendRequestRow,
    source_title: &str,
    text: &str,
    target: &TerminalIdentity,
) -> Result<(), Value> {
    let pointer = service.terminal_mail().ok_or_else(not_notifiable)?;
    let new = NewAgentMessage {
        message_id: format!("person-send:{}", row.request_id),
        conversation_id: row.request_id.clone(),
        sender_address: row.source_address.clone(),
        sender_kind: SenderKind::Person,
        recipient_address: target.address(),
        in_reply_to: None,
        hop: 1,
        text: render_request(row.action, source_title, text),
        status: AgentMessageStatus::Queued,
        reason: None,
        accepted_at: crate::mcp::control::now_iso(),
        sender_runtime_mode: None,
        recipient_terminal_generation: Some(target.generation_key()),
        send_request_id: Some(row.request_id.clone()),
        client_request_id: None,
        delivery_command_id: None,
        delivery_message_id: None,
    };
    match pointer.accept_person(new, target).await {
        Ok(_) => Ok(()),
        Err(AgentMessagingError::UnknownRecipient) => {
            service.end_unreachable(row).await;
            Err(not_notifiable())
        }
        Err(_) => Err(refusal(
            "storage",
            "BiBCode could not read or save this request. Try again.",
        )),
    }
}

/// Moves a request after its mail: `delivered` when the pointer was typed, `read` when the inbox
/// returned it, `answered` with the terminal's reply. Each through
/// [`SendRequestsService::apply`], so every transition is published to subscribers.
pub(crate) fn request_state_sink(service: SendRequestsService) -> RequestStateSink {
    Arc::new(move |row: AgentMessageRow| {
        let service = service.clone();
        Box::pin(async move { follow_mail(&service, row).await })
    })
}

async fn follow_mail(service: &SendRequestsService, row: AgentMessageRow) {
    let Some(request_id) = row.send_request_id.clone() else {
        return;
    };
    let (to, from, answer): (SendState, &[SendState], _) = match row.status {
        AgentMessageStatus::Delivered if row.sender_kind == SenderKind::Person => {
            (SendState::Delivered, &[SendState::Queued], None)
        }
        AgentMessageStatus::Consumed if row.sender_kind == SenderKind::Person => (
            SendState::Read,
            &[SendState::Queued, SendState::Delivered],
            None,
        ),
        AgentMessageStatus::Completed if row.in_reply_to.is_some() => (
            SendState::Answered,
            &[SendState::Queued, SendState::Delivered, SendState::Read],
            Some(cut_answer(row.text)),
        ),
        _ => return,
    };
    let (answer_text, answer_truncated) = match answer {
        Some((text, truncated)) => (Some(text), truncated),
        None => (None, false),
    };
    let change = StateChange {
        to,
        reason: None,
        answering_turn_id: None,
        answer_message_id: answer_text.as_ref().map(|_| row.message_id.clone()),
        answer_text,
        answer_truncated,
        // As for a chat target: a message, hand-off or take-over needs nothing more once read.
        dismiss: to != SendState::Delivered && service.dismissed_once_read(&request_id).await,
        at: crate::mcp::control::now_iso(),
    };
    if let Err(error) = service.apply(&request_id, from, change).await {
        tracing::warn!(%request_id, %error, "a terminal request's state was not stored");
    }
}

#[cfg(test)]
mod tests;
