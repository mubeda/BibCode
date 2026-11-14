//! The status of a chat recipient's agent message, derived from what its thread shows: the queue
//! entry, the turn that took the message and the turn's reply. The tracker re-derives it on the
//! thread's events and once at start, so a restart or a lost broadcast cannot leave it behind.
//! It also holds a waiting message whose recipient's mode rose above its sender's, and takes the
//! queue entry of a held or failed message out of the queue. The only command it dispatches is
//! that withdrawal, so it cannot steer or answer anything.

use rusqlite::{OptionalExtension as _, params};
use tokio::{sync::broadcast, task::JoinHandle};
use tokio_util::sync::CancellationToken;

use super::{
    AgentMessagingError, MessageOutcome, OutcomeSink,
    store::{
        AgentMessageReason, AgentMessageRow, AgentMessageStatus, hold_above_ceiling,
        list_needing_withdrawal, list_open, list_open_for_thread, set_recipient_turn, set_status,
    },
};
use crate::{
    orchestration::{
        OrchestrationCommand, OrchestrationEngine, TurnDeliveryState,
        engine::TurnDeliveryResolutionAction,
    },
    persistence::{OrchestrationEvent, Result},
};

/// A status read from the recipient's thread.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Derived {
    pub(crate) status: AgentMessageStatus,
    pub(crate) reason: Option<AgentMessageReason>,
    pub(crate) turn_id: Option<String>,
}

impl Derived {
    fn of(status: AgentMessageStatus, reason: Option<AgentMessageReason>) -> Self {
        Self {
            status,
            reason,
            turn_id: None,
        }
    }
}

/// The turn that took the message: the one already recorded on it, the one its marker bound to
/// (the projector keeps that link when the provider reported the turn early), or the one its
/// projected message names. No other turn is ever taken for it, a later one included.
fn consuming_turn(
    connection: &rusqlite::Connection,
    thread_id: &str,
    delivery_message_id: &str,
    recorded_turn_id: Option<&str>,
) -> Result<Option<(String, String)>> {
    let turn_state = |turn_id: String| -> Result<Option<(String, String)>> {
        Ok(connection
            .query_row(
                "SELECT state FROM projection_turns WHERE thread_id = ?1 AND turn_id = ?2",
                params![thread_id, turn_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .map(|state| (turn_id, state)))
    };
    if let Some(turn_id) = recorded_turn_id {
        return turn_state(turn_id.to_owned());
    }
    let bound = connection
        .query_row(
            "SELECT turn_id, state FROM projection_turns
              WHERE thread_id = ?1 AND pending_message_id = ?2 AND turn_id IS NOT NULL
              ORDER BY row_id DESC LIMIT 1",
            params![thread_id, delivery_message_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?;
    if bound.is_some() {
        return Ok(bound);
    }
    let named: Option<String> = connection
        .query_row(
            "SELECT turn_id FROM projection_thread_messages WHERE thread_id = ?1 AND message_id = ?2",
            params![thread_id, delivery_message_id],
            |row| row.get(0),
        )
        .optional()?
        .flatten();
    match named {
        Some(turn_id) => turn_state(turn_id),
        None => Ok(None),
    }
}

/// The status `message` has by what its chat recipient's thread shows now.
pub(crate) fn derive_chat_status(
    connection: &rusqlite::Connection,
    message: &AgentMessageRow,
) -> Result<Derived> {
    let unchanged = Derived {
        status: message.status,
        reason: message.reason,
        turn_id: message.recipient_turn_id.clone(),
    };
    let Some(thread_id) = message.recipient_address.strip_prefix("thread:") else {
        return Ok(unchanged);
    };
    let live = connection
        .query_row(
            "SELECT deleted_at IS NULL FROM projection_threads WHERE thread_id = ?1",
            [thread_id],
            |row| row.get::<_, bool>(0),
        )
        .optional()?
        .unwrap_or(false);
    if !live {
        return Ok(Derived::of(
            AgentMessageStatus::Failed,
            Some(AgentMessageReason::RecipientGone),
        ));
    }
    let (Some(command_id), Some(delivery_message_id)) = (
        message.delivery_command_id.as_deref(),
        message.delivery_message_id.as_deref(),
    ) else {
        return Ok(unchanged);
    };
    if let Some((turn_id, state)) = consuming_turn(
        connection,
        thread_id,
        delivery_message_id,
        message.recipient_turn_id.as_deref(),
    )? {
        let status = match state.as_str() {
            "running" => Some((AgentMessageStatus::Consumed, None)),
            // A turn can be completed while its reply still streams; it ends with the reply.
            "completed" => {
                let streaming: bool = connection.query_row(
                    "SELECT EXISTS(SELECT 1 FROM projection_thread_messages
                      WHERE thread_id = ?1 AND turn_id = ?2 AND role = 'assistant' AND is_streaming = 1)",
                    params![thread_id, turn_id],
                    |row| row.get(0),
                )?;
                Some(if streaming {
                    (AgentMessageStatus::Consumed, None)
                } else {
                    (AgentMessageStatus::Completed, None)
                })
            }
            "error" | "interrupted" => Some((
                AgentMessageStatus::Failed,
                Some(AgentMessageReason::RecipientTurnFailed),
            )),
            _ => None,
        };
        if let Some((status, reason)) = status {
            return Ok(Derived {
                status,
                reason,
                turn_id: Some(turn_id),
            });
        }
    }
    let outbox: Option<String> = connection
        .query_row(
            "SELECT state FROM provider_turn_outbox WHERE command_id = ?1",
            [command_id],
            |row| row.get(0),
        )
        .optional()?;
    Ok(match outbox.as_deref() {
        Some("queued") => Derived::of(AgentMessageStatus::Queued, None),
        Some("pending" | "sending") => Derived::of(AgentMessageStatus::Accepted, None),
        Some("delivered") => Derived::of(AgentMessageStatus::Delivered, None),
        Some("uncertain") => Derived::of(
            AgentMessageStatus::Held,
            Some(AgentMessageReason::DeliveryUncertain),
        ),
        Some("failed" | "dismissed") => Derived::of(
            AgentMessageStatus::Failed,
            Some(AgentMessageReason::DeliveryFailed),
        ),
        _ => unchanged,
    })
}

/// The place of a status in the forward order of a delivery; `None` for one outside it.
fn stage(status: AgentMessageStatus) -> Option<u8> {
    match status {
        AgentMessageStatus::Accepted => Some(0),
        AgentMessageStatus::Queued => Some(1),
        AgentMessageStatus::Delivered => Some(2),
        AgentMessageStatus::Consumed => Some(3),
        AgentMessageStatus::Completed => Some(4),
        _ => None,
    }
}

/// Whether `derived` replaces the stored status: never a final one, never a held one this task
/// does not own, and never a step back (a promoted row that reads `pending` keeps `queued`).
fn applies(stored: &AgentMessageRow, derived: &Derived) -> bool {
    if stored.status.is_terminal()
        || (derived.status == stored.status && derived.reason == stored.reason)
    {
        return false;
    }
    if stored.status == AgentMessageStatus::Held {
        return stored.reason == Some(AgentMessageReason::DeliveryUncertain);
    }
    match (stage(stored.status), stage(derived.status)) {
        (Some(stored), Some(derived)) => derived > stored,
        _ => true,
    }
}

/// Applies the derived status of each of `messages`; returns the changes made.
fn apply(
    connection: &rusqlite::Connection,
    messages: Vec<AgentMessageRow>,
) -> Result<Vec<(AgentMessageRow, Derived)>> {
    let mut changed = Vec::new();
    for message in messages {
        let derived = derive_chat_status(connection, &message)?;
        if !applies(&message, &derived) {
            continue;
        }
        let now = crate::mcp::control::now_iso();
        if set_status(
            connection,
            &message.message_id,
            derived.status,
            derived.reason,
            &now,
        )? {
            if let Some(turn_id) = &derived.turn_id {
                set_recipient_turn(connection, &message.message_id, turn_id)?;
            }
            changed.push((message, derived));
        }
    }
    Ok(changed)
}

/// Tells the outcome sink of each change it reports, with the two thread titles.
async fn report(
    engine: &OrchestrationEngine,
    outcomes: Option<&OutcomeSink>,
    changes: &[(AgentMessageRow, Derived)],
) {
    for (message, derived) in changes {
        if derived.status == AgentMessageStatus::Failed {
            tracing::warn!(
                message_id = %message.message_id,
                reason = derived.reason.map_or("none", AgentMessageReason::as_str),
                "an agent message failed"
            );
        }
        let Some(outcomes) = outcomes else { continue };
        let outcome = match derived.status {
            AgentMessageStatus::Delivered => "delivered",
            AgentMessageStatus::Consumed => "consumed",
            AgentMessageStatus::Completed => "completed",
            AgentMessageStatus::Failed => "failed",
            _ => continue,
        };
        let title = |address: &str| {
            let repositories = engine.repositories();
            let thread_id = address.strip_prefix("thread:").map(str::to_owned);
            async move {
                match thread_id {
                    Some(thread_id) => repositories
                        .get_thread(thread_id)
                        .await
                        .ok()
                        .flatten()
                        .map(|thread| thread.title),
                    None => None,
                }
            }
        };
        outcomes(MessageOutcome {
            sender_address: message.sender_address.clone(),
            recipient_address: message.recipient_address.clone(),
            tool: "agent_message_delivery",
            outcome: outcome.to_owned(),
            message_id: Some(message.message_id.clone()),
            conversation_id: Some(message.conversation_id.clone()),
            hop: Some(message.hop),
            reason: derived.reason.map(|reason| reason.as_str().to_owned()),
            sender_title: title(&message.sender_address).await,
            recipient_title: title(&message.recipient_address).await,
        });
    }
}

/// Takes `message`'s queue entry out of its recipient's queue: `Cancel` for a queued entry,
/// `Dismiss` for a pending or failed one. False when the entry is sending or later (too late),
/// absent, or no longer takes the resolution.
pub(crate) async fn withdraw_from_queue(
    engine: &OrchestrationEngine,
    message: &AgentMessageRow,
) -> std::result::Result<bool, AgentMessagingError> {
    let (Some(command_id), Some(delivery_message_id), Some(thread_id)) = (
        message.delivery_command_id.clone(),
        message.delivery_message_id.clone(),
        message.recipient_address.strip_prefix("thread:"),
    ) else {
        return Ok(false);
    };
    let storage = |error: crate::persistence::PersistenceError| {
        tracing::warn!(error = %error, "an agent message's queue entry could not be read");
        AgentMessagingError::Storage
    };
    let repositories = engine.repositories();
    let Some(entry) = repositories
        .get_provider_turn_delivery(command_id.clone())
        .await
        .map_err(storage)?
    else {
        return Ok(false);
    };
    let action = match entry.state {
        TurnDeliveryState::Queued => TurnDeliveryResolutionAction::Cancel,
        TurnDeliveryState::Pending | TurnDeliveryState::Failed => {
            TurnDeliveryResolutionAction::Dismiss
        }
        _ => return Ok(false),
    };
    let resolve = OrchestrationCommand::ThreadTurnDeliveryResolve {
        command_id: format!(
            "agent-message-withdraw:{command_id}:{}",
            uuid::Uuid::new_v4()
        ),
        thread_id: thread_id.to_owned(),
        message_id: delivery_message_id,
        action,
        created_at: crate::mcp::control::now_iso(),
    };
    if let Err(error) = engine.dispatch(resolve).await {
        // A claim or another withdrawal may have moved the entry first; its state decides.
        tracing::debug!(error = %error, "an agent message's queue entry was not withdrawn");
    }
    Ok(repositories
        .get_provider_turn_delivery(command_id)
        .await
        .map_err(storage)?
        .is_some_and(|entry| entry.state == TurnDeliveryState::Dismissed))
}

/// Withdraws the queue entry of each message that must not wait in a queue.
async fn withdraw_left_entries(engine: &OrchestrationEngine, messages: Vec<AgentMessageRow>) {
    for message in messages {
        if let Err(error) = withdraw_from_queue(engine, &message).await {
            tracing::warn!(
                message_id = %message.message_id,
                tag = error.tag(),
                "an agent message's queue entry was left in the queue"
            );
        }
    }
}

/// Holds what the mode ceiling no longer admits, re-derives each open message of `recipient`
/// (every one when `None`) and withdraws the entries no message may keep. Every step reads the
/// stored state, so a restart between a hold and its withdrawal repeats only the withdrawal.
async fn reconcile(
    engine: &OrchestrationEngine,
    outcomes: Option<&OutcomeSink>,
    recipient: Option<String>,
) -> Result<usize> {
    let (changes, withdrawals) = engine
        .repositories()
        .database()
        .call(move |connection| {
            let recipient = recipient.as_deref();
            hold_above_ceiling(connection, recipient, &crate::mcp::control::now_iso())?;
            let open = match recipient {
                Some(address) => list_open_for_thread(connection, address)?,
                None => list_open(connection)?,
            };
            let changes = apply(connection, open)?;
            Ok((changes, list_needing_withdrawal(connection, recipient)?))
        })
        .await?;
    withdraw_left_entries(engine, withdrawals).await;
    report(engine, outcomes, &changes).await;
    Ok(changes.len())
}

async fn reconcile_thread(
    engine: &OrchestrationEngine,
    outcomes: Option<&OutcomeSink>,
    thread_id: &str,
) -> Result<usize> {
    reconcile(engine, outcomes, Some(format!("thread:{thread_id}"))).await
}

/// Re-derives every open message; returns how many changed.
pub(crate) async fn reconcile_all(
    engine: &OrchestrationEngine,
    outcomes: Option<&OutcomeSink>,
) -> Result<usize> {
    reconcile(engine, outcomes, None).await
}

/// The thread an event may change a message status of.
fn thread_of(event: &OrchestrationEvent) -> Option<&str> {
    let event = &event.event;
    if event.aggregate_kind != "thread" {
        return None;
    }
    // A streamed chunk changes nothing; the settled message does.
    if event.event_type == "thread.message-sent"
        && event
            .payload
            .get("streaming")
            .and_then(serde_json::Value::as_bool)
            == Some(true)
    {
        return None;
    }
    matches!(
        event.event_type.as_str(),
        "thread.turn-delivery-updated"
            | "thread.session-set"
            | "thread.message-sent"
            | "thread.turn-interrupt-requested"
            | "thread.runtime-mode-set"
            | "thread.deleted"
    )
    .then_some(event.aggregate_id.as_str())
}

pub(crate) struct AgentMessageTracker;

impl AgentMessageTracker {
    /// Follows the engine's events until `shutdown`, after one full reconciliation.
    pub(crate) fn start(
        engine: OrchestrationEngine,
        outcomes: Option<OutcomeSink>,
        shutdown: CancellationToken,
    ) -> JoinHandle<()> {
        // Subscribed before the first reconciliation, so no event between the two is missed.
        let mut events = engine.subscribe_events();
        let repositories = engine.repositories();
        tokio::spawn(async move {
            let outcomes = outcomes.as_ref();
            log_failure(reconcile_all(&engine, outcomes).await);
            loop {
                let event = tokio::select! {
                    biased;
                    () = shutdown.cancelled() => return,
                    // A hold decided at a claim writes no event; its entry is withdrawn here.
                    () = repositories.agent_claim_held() => {
                        log_failure(reconcile_all(&engine, outcomes).await);
                        continue;
                    }
                    event = events.recv() => event,
                };
                match event {
                    Ok(event) => {
                        if let Some(thread_id) = thread_of(&event) {
                            log_failure(reconcile_thread(&engine, outcomes, thread_id).await);
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        log_failure(reconcile_all(&engine, outcomes).await);
                    }
                    Err(broadcast::error::RecvError::Closed) => return,
                }
            }
        })
    }
}

fn log_failure(result: Result<usize>) {
    if let Err(error) = result {
        tracing::warn!(error = %error, "agent message statuses were not updated");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_messaging::store::SenderKind;

    fn row(status: AgentMessageStatus, reason: Option<AgentMessageReason>) -> AgentMessageRow {
        AgentMessageRow {
            message_id: "m1".to_owned(),
            conversation_id: "c1".to_owned(),
            sender_address: "thread:a".to_owned(),
            sender_kind: SenderKind::Agent,
            recipient_address: "thread:b".to_owned(),
            in_reply_to: None,
            hop: 1,
            text: "hello".to_owned(),
            status,
            reason,
            accepted_at: "2026-11-14T00:00:00Z".to_owned(),
            sender_runtime_mode: None,
            recipient_terminal_generation: None,
            send_request_id: None,
            client_request_id: None,
            delivery_command_id: Some("agent-message:m1".to_owned()),
            delivery_message_id: Some("d1".to_owned()),
            updated_at: "2026-11-14T00:00:00Z".to_owned(),
            recipient_turn_id: None,
        }
    }

    #[test]
    fn a_status_only_moves_forward_and_never_leaves_a_final_one() {
        use AgentMessageStatus::*;
        let to = |status| Derived::of(status, None);
        assert!(
            !applies(&row(Queued, None), &to(Accepted)),
            "queued never reads accepted again"
        );
        assert!(applies(&row(Queued, None), &to(Delivered)));
        assert!(applies(&row(Consumed, None), &to(Completed)));
        assert!(!applies(&row(Completed, None), &to(Failed)));
        assert!(!applies(&row(Cancelled, None), &to(Consumed)));
        assert!(applies(
            &row(Consumed, None),
            &Derived::of(Failed, Some(AgentMessageReason::RecipientTurnFailed))
        ));
        assert!(
            !applies(
                &row(Held, Some(AgentMessageReason::RecipientQueueHeld)),
                &to(Queued)
            ),
            "a held message this task does not own is left alone"
        );
        assert!(applies(
            &row(Held, Some(AgentMessageReason::DeliveryUncertain)),
            &to(Delivered)
        ));
    }
}
