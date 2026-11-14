//! The rules an agent message obeys whoever asks: the runtime-mode ceiling and the claim gate
//! that applies it, and the messaging setting, at the moment a delivery starts.

use std::sync::Arc;

use rusqlite::{OptionalExtension as _, params};
use tokio::sync::watch;

use super::store::{AgentMessageReason, AgentMessageStatus, SenderKind};

/// The place of a runtime mode in the order of the spec (R6); `None` for any other value.
pub(crate) fn mode_rank(mode: &str) -> Option<u8> {
    match mode {
        "approval-required" => Some(0),
        "auto-accept-edits" => Some(1),
        "full-access" => Some(2),
        _ => None,
    }
}

/// Whether a sender in `sender_mode` may message a recipient in `recipient_mode`: the recipient
/// runs with at most the sender's access. An unknown mode allows nothing.
pub(crate) fn ceiling_allows(sender_mode: &str, recipient_mode: &str) -> bool {
    matches!(
        (mode_rank(sender_mode), mode_rank(recipient_mode)),
        (Some(sender), Some(recipient)) if recipient <= sender
    )
}

/// The most agent-to-agent hops of one exchange before a person has to write in it (R14).
pub(crate) const HOP_LIMIT: u32 = 8;

/// The hop of a new agent message, from the hop of the message that started its sender's turn
/// (`None` when a person or anything else started it): one more, and refused above the limit.
/// A chain is reset only by a person, never by time.
pub(crate) fn next_hop(trigger: Option<u32>) -> Result<u32, super::AgentMessagingError> {
    let hop = trigger.map_or(1, |trigger| trigger.saturating_add(1));
    if hop > HOP_LIMIT {
        return Err(super::AgentMessagingError::HopLimit);
    }
    Ok(hop)
}

/// What the claim of a queue entry does with it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ClaimDecision {
    Proceed,
    /// The entry's agent message is held with this reason and the entry is not claimed.
    Hold(AgentMessageReason),
    /// The gate could not read the entry's message: nothing is claimed or written, and the next
    /// claim asks again.
    Wait,
}

/// Asked inside the claiming statement's database call, with that connection and the claimed
/// entry's `command_id`.
pub(crate) type AgentClaimGate =
    Arc<dyn Fn(&rusqlite::Connection, &str) -> ClaimDecision + Send + Sync>;

/// The gate of `agentMessaging.enabled`'s live value. An agent's message is held while the
/// setting is off and while its recipient runs with more access than its sender had; a
/// person's request and any entry with no agent message proceed. A message already held for
/// either reason, or already final, is never claimed.
pub(crate) fn claim_gate(enabled: watch::Receiver<bool>) -> AgentClaimGate {
    Arc::new(move |connection, command_id| {
        // Accepted limit: a delivery claimed at the instant the setting is switched off may complete.
        let enabled = *enabled.borrow();
        match decide(connection, command_id, enabled) {
            Ok(decision) => decision,
            Err(error) => {
                tracing::warn!(error = %error, "the agent message claim gate could not read its row");
                ClaimDecision::Wait
            }
        }
    })
}

fn decide(
    connection: &rusqlite::Connection,
    command_id: &str,
    enabled: bool,
) -> crate::persistence::Result<ClaimDecision> {
    let row = connection
        .query_row(
            "SELECT message.sender_kind, message.status, message.reason, message.sender_runtime_mode, thread.runtime_mode, message.recipient_address
               FROM agent_messages AS message
               LEFT JOIN projection_threads AS thread
                 ON 'thread:' || thread.thread_id = message.recipient_address
              WHERE message.delivery_command_id = ?1",
            params![command_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, String>(5)?,
                ))
            },
        )
        .optional()?;
    let Some((sender_kind, status, reason, sender_mode, recipient_mode, recipient_address)) = row
    else {
        return Ok(ClaimDecision::Proceed);
    };
    if SenderKind::parse(&sender_kind) != Some(SenderKind::Agent) {
        return Ok(ClaimDecision::Proceed);
    }
    let status = AgentMessageStatus::parse(&status);
    let reason = reason.as_deref().and_then(AgentMessageReason::parse);
    match (status, reason) {
        (
            Some(AgentMessageStatus::Held),
            Some(
                held @ (AgentMessageReason::MessagingOff
                | AgentMessageReason::RecipientModeAboveSender),
            ),
        ) => return Ok(ClaimDecision::Hold(held)),
        (Some(status), reason) if status.is_terminal() => {
            return Ok(ClaimDecision::Hold(
                reason.unwrap_or(AgentMessageReason::DeliveryFailed),
            ));
        }
        _ => {}
    }
    if !enabled {
        return Ok(ClaimDecision::Hold(AgentMessageReason::MessagingOff));
    }
    // A terminal recipient receives as `full-access` (R6); a chat recipient as its thread runs.
    let recipient_mode = recipient_mode.unwrap_or_else(|| "full-access".to_owned());
    if !sender_mode.is_some_and(|sender| ceiling_allows(&sender, &recipient_mode)) {
        return Ok(ClaimDecision::Hold(
            AgentMessageReason::RecipientModeAboveSender,
        ));
    }
    // Whatever made the entry pending (Send now, a retry, a recovery copy), it never runs past
    // an open ask (R9); answering it wakes delivery, and the next claim asks again.
    if let Some(thread_id) = recipient_address.strip_prefix("thread:")
        && super::store::has_open_ask(connection, thread_id)?
    {
        return Ok(ClaimDecision::Wait);
    }
    Ok(ClaimDecision::Proceed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn modes_rank_in_the_order_of_the_spec() {
        assert_eq!(mode_rank("approval-required"), Some(0));
        assert_eq!(mode_rank("auto-accept-edits"), Some(1));
        assert_eq!(mode_rank("full-access"), Some(2));
        assert_eq!(mode_rank("read-only"), None);
        assert_eq!(mode_rank("x"), None);
    }

    #[test]
    fn ceiling_allows_equal_and_lower_only() {
        let modes = ["approval-required", "auto-accept-edits", "full-access"];
        for (sender_rank, sender) in modes.iter().enumerate() {
            for (recipient_rank, recipient) in modes.iter().enumerate() {
                assert_eq!(
                    ceiling_allows(sender, recipient),
                    recipient_rank <= sender_rank,
                    "{sender} to {recipient}"
                );
            }
        }
        assert!(!ceiling_allows("full-access", "x"));
        assert!(!ceiling_allows("x", "approval-required"));
    }

    #[test]
    fn next_hop_counts_from_the_trigger() {
        assert_eq!(next_hop(None), Ok(1));
        assert_eq!(next_hop(Some(7)), Ok(8));
        assert_eq!(
            next_hop(Some(8)),
            Err(super::super::AgentMessagingError::HopLimit)
        );
    }
}
