//! Conversation compaction: the durable `thread_compactions` row, whether a context-limit
//! failure is recovered automatically, and how a compaction settles.
//!
//! The row is the source of truth for an unsettled compaction, as the outbox is for the queue:
//! while one is `requested`, `running` or `unresolved`, the delivery claim and automatic promotion
//! refuse the thread in SQL and admission queues new starts. Everything here runs inside the
//! transaction of the command that records it, so a failure, its recovery and the copy it sends
//! are never half-applied.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex as StdMutex},
};

use rusqlite::{Connection, OptionalExtension, Row, Transaction, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::{oneshot, watch};
use uuid::Uuid;

use super::{
    NewOrchestrationEvent, PersistenceError, delivery_value, hold_queued_provider_turns,
    json_string, make_event,
};

/// The states of a compaction that holds its thread.
pub(crate) const UNSETTLED_COMPACTION_STATES: &str = "('requested', 'running', 'unresolved')";

/// What `lastError` reads while a context-limit failure is being recovered.
pub(crate) const RECOVERY_LAST_ERROR: &str =
    "The context window is full. Compacting the conversation, then sending your message again.";

/// Added to the error of a resent message that failed at the context limit again.
pub(crate) const ALREADY_COMPACTED_SUFFIX: &str =
    "The conversation was already compacted once for this message.";

/// The guarded delivery's detail while its compaction runs.
pub(crate) const GUARD_WAITING_DETAIL: &str = "Waiting for the conversation to be compacted.";

/// A guarded message whose compaction the user stopped.
pub(crate) const GUARD_STOPPED_DETAIL: &str =
    "Not sent: you stopped the conversation compaction. Retry sends it.";

/// A guarded message whose compaction a restart cut short.
pub(crate) const GUARD_RESTARTED_DETAIL: &str =
    "BiBCode restarted before the conversation was compacted. Retry sends it.";

/// What the provider reported about a turn it failed at the context limit. The adapter sets
/// these; the engine never infers them from the failure's text.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ContextLimitFacts {
    #[serde(rename = "turnId")]
    pub turn_id: String,
    /// The provider refused the turn's input before any assistant text, tool call or compaction.
    #[serde(
        rename = "beforeOutput",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub before_output: Option<bool>,
    /// `Some(false)` when the provider said compacting cannot help.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compactable: Option<bool>,
}

/// One `thread_compactions` row.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ThreadCompactionRow {
    pub compaction_id: String,
    pub thread_id: String,
    /// `manual`, `contextRecovery` or `guard`.
    pub trigger: String,
    pub state: String,
    pub stop_requested: bool,
    pub provider_instance_id: String,
    pub provider_kind: String,
    pub conversation_id: Option<String>,
    pub turn_id: Option<String>,
    pub failed_message_id: Option<String>,
    pub guarded_delivery_command_id: Option<String>,
    pub resend_message_id: Option<String>,
    /// A recovery keeps the failure's own message here, which an interrupted recovery restores; a
    /// manual compaction keeps the context-limit error it was asked for from, if any. Once
    /// settled, a failure's detail.
    pub detail: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

impl ThreadCompactionRow {
    #[must_use]
    pub fn is_unsettled(&self) -> bool {
        matches!(self.state.as_str(), "requested" | "running" | "unresolved")
    }
}

pub(crate) const COMPACTION_SELECT: &str = "SELECT compaction_id, thread_id, trigger, state, stop_requested, provider_instance_id, provider_kind, conversation_id, turn_id, failed_message_id, guarded_delivery_command_id, resend_message_id, detail, created_at, updated_at FROM thread_compactions";

pub(crate) fn decode_compaction_row(row: &Row<'_>) -> rusqlite::Result<ThreadCompactionRow> {
    Ok(ThreadCompactionRow {
        compaction_id: row.get(0)?,
        thread_id: row.get(1)?,
        trigger: row.get(2)?,
        state: row.get(3)?,
        stop_requested: row.get::<_, i64>(4)? != 0,
        provider_instance_id: row.get(5)?,
        provider_kind: row.get(6)?,
        conversation_id: row.get(7)?,
        turn_id: row.get(8)?,
        failed_message_id: row.get(9)?,
        guarded_delivery_command_id: row.get(10)?,
        resend_message_id: row.get(11)?,
        detail: row.get(12)?,
        created_at: row.get(13)?,
        updated_at: row.get(14)?,
    })
}

/// The thread's unsettled compaction, if any. There is at most one.
pub(crate) fn unsettled_compaction_on(
    connection: &Connection,
    thread_id: &str,
) -> Result<Option<ThreadCompactionRow>, PersistenceError> {
    connection
        .query_row(
            &format!(
                "{COMPACTION_SELECT} WHERE thread_id = ? AND state IN {UNSETTLED_COMPACTION_STATES} ORDER BY created_at, compaction_id LIMIT 1"
            ),
            [thread_id],
            decode_compaction_row,
        )
        .optional()
        .map_err(Into::into)
}

pub(crate) fn compaction_row_on(
    connection: &Connection,
    compaction_id: &str,
) -> Result<Option<ThreadCompactionRow>, PersistenceError> {
    connection
        .query_row(
            &format!("{COMPACTION_SELECT} WHERE compaction_id = ?"),
            [compaction_id],
            decode_compaction_row,
        )
        .optional()
        .map_err(Into::into)
}

/// The conversation a provider's resume cursor names: Codex's thread id, or the session id of
/// Claude and OpenCode.
#[must_use]
pub fn resume_cursor_conversation_id(provider_kind: &str, cursor: &Value) -> Option<String> {
    let field = if provider_kind == "codex" {
        "threadId"
    } else {
        "sessionId"
    };
    cursor
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

/// The provider instance, kind and conversation a compaction compacts.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CompactionTarget {
    pub(crate) provider_instance_id: String,
    pub(crate) provider_kind: String,
    pub(crate) conversation_id: Option<String>,
}

/// The conversation the thread's next message would continue: its saved runtime, when that is
/// for `instance_id` and names a conversation.
pub(crate) fn saved_conversation_on(
    connection: &Connection,
    thread_id: &str,
    instance_id: &str,
) -> Result<Option<CompactionTarget>, PersistenceError> {
    let saved = connection
        .query_row(
            "SELECT provider_name, COALESCE(provider_instance_id, provider_name), resume_cursor_json FROM provider_session_runtime WHERE thread_id = ?",
            [thread_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            },
        )
        .optional()?;
    let Some((kind, saved_instance, cursor)) = saved else {
        return Ok(None);
    };
    if saved_instance != instance_id {
        return Ok(None);
    }
    let conversation_id = cursor
        .and_then(|cursor| serde_json::from_str::<Value>(&cursor).ok())
        .and_then(|cursor| resume_cursor_conversation_id(&kind, &cursor));
    Ok(conversation_id.map(|conversation_id| CompactionTarget {
        provider_instance_id: saved_instance,
        provider_kind: kind,
        conversation_id: Some(conversation_id),
    }))
}

pub(crate) struct NewCompaction<'a> {
    pub(crate) compaction_id: &'a str,
    pub(crate) thread_id: &'a str,
    pub(crate) trigger: &'a str,
    pub(crate) target: &'a CompactionTarget,
    pub(crate) failed_message_id: Option<&'a str>,
    pub(crate) guarded_delivery_command_id: Option<&'a str>,
    pub(crate) detail: Option<&'a str>,
    pub(crate) created_at: &'a str,
}

pub(crate) fn insert_compaction_tx(
    transaction: &Transaction<'_>,
    compaction: &NewCompaction<'_>,
) -> Result<(), PersistenceError> {
    transaction.execute(
        "INSERT INTO thread_compactions (compaction_id, thread_id, trigger, state, stop_requested, provider_instance_id, provider_kind, conversation_id, turn_id, failed_message_id, guarded_delivery_command_id, resend_message_id, detail, created_at, updated_at) VALUES (?, ?, ?, 'requested', 0, ?, ?, ?, NULL, ?, ?, NULL, ?, ?, ?)",
        params![
            compaction.compaction_id,
            compaction.thread_id,
            compaction.trigger,
            compaction.target.provider_instance_id,
            compaction.target.provider_kind,
            compaction.target.conversation_id,
            compaction.failed_message_id,
            compaction.guarded_delivery_command_id,
            compaction.detail,
            compaction.created_at,
            compaction.created_at,
        ],
    )?;
    Ok(())
}

/// What a context-limit failure leads to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ContextLimitRecovery {
    /// Compact the conversation, then send the failed message again.
    Begin {
        failed_message_id: String,
        target: CompactionTarget,
    },
    /// The failed message was itself sent again after a compaction: today's error, saying so.
    AlreadyCompacted,
    /// The same failure arrived again while its recovery runs: nothing changes.
    Recovering,
    /// Today's error.
    None,
}

/// Whether the failure is recovered automatically. Every rule of the design's Eligibility must
/// hold; anything unknown means no recovery.
pub(crate) fn context_limit_recovery_tx(
    transaction: &Transaction<'_>,
    thread_id: &str,
    facts: &ContextLimitFacts,
) -> Result<ContextLimitRecovery, PersistenceError> {
    // The failed turn was started by a delivered start of a user message.
    let message_id = transaction
        .query_row(
            "SELECT pending_message_id FROM projection_turns WHERE thread_id = ? AND turn_id = ?",
            params![thread_id, facts.turn_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten();
    let Some(message_id) = message_id else {
        return Ok(ContextLimitRecovery::None);
    };
    let delivery = transaction
        .query_row(
            "SELECT command_id, provider_instance_id, provider_kind, provider_session_id, json_extract(payload_json, '$.resendOf') FROM provider_turn_outbox WHERE thread_id = ? AND message_id = ? AND mode = 'start' AND state = 'delivered'",
            params![thread_id, message_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                ))
            },
        )
        .optional()?;
    let Some((delivery_command_id, instance_id, provider_kind, conversation_id, resend_of)) =
        delivery
    else {
        return Ok(ContextLimitRecovery::None);
    };
    // A copy is never recovered again.
    if resend_of.is_some() {
        return Ok(ContextLimitRecovery::AlreadyCompacted);
    }
    let recovering: bool = transaction.query_row(
        &format!(
            "SELECT EXISTS(SELECT 1 FROM thread_compactions WHERE failed_message_id = ? AND state IN {UNSETTLED_COMPACTION_STATES})"
        ),
        [&message_id],
        |row| row.get(0),
    )?;
    if recovering {
        return Ok(ContextLimitRecovery::Recovering);
    }
    if facts.before_output != Some(true) || facts.compactable == Some(false) {
        return Ok(ContextLimitRecovery::None);
    }
    let excluded: bool = transaction.query_row(
        "SELECT EXISTS(SELECT 1 FROM thread_compactions WHERE failed_message_id = ?1)
            OR EXISTS(SELECT 1 FROM thread_compactions WHERE guarded_delivery_command_id = ?2 AND state IN ('failed', 'interrupted'))",
        params![message_id, delivery_command_id],
        |row| row.get(0),
    )?;
    if excluded || !crate::provider::supports_compaction(&provider_kind) {
        return Ok(ContextLimitRecovery::None);
    }
    let Some(conversation_id) = conversation_id else {
        return Ok(ContextLimitRecovery::None);
    };
    // The provider's own auto-compact switch, from its latest reading of this conversation. An
    // untagged reading (one recorded before readings were tagged) never matches.
    let compacts_automatically = transaction
        .query_row(
            "SELECT json_extract(payload_json, '$.compactsAutomatically') FROM projection_thread_activities
             WHERE thread_id = ? AND kind = 'context-window.updated'
               AND json_type(payload_json, '$.usedTokens') IN ('integer', 'real')
               AND json_extract(payload_json, '$.providerInstanceId') = ?
               AND json_extract(payload_json, '$.conversationId') = ?
             ORDER BY created_at DESC, sequence DESC LIMIT 1",
            params![thread_id, instance_id, conversation_id],
            |row| row.get::<_, Option<i64>>(0),
        )
        .optional()?
        .flatten()
        == Some(1);
    if !compacts_automatically {
        return Ok(ContextLimitRecovery::None);
    }
    // Nothing else of the thread is unsettled or still on its way to the provider: a steer
    // written during the failing turn is input the provider reads next.
    let busy: bool = transaction.query_row(
        &format!(
            "SELECT EXISTS(SELECT 1 FROM thread_compactions WHERE thread_id = ?1 AND state IN {UNSETTLED_COMPACTION_STATES})
                OR EXISTS(SELECT 1 FROM provider_turn_outbox WHERE thread_id = ?1 AND state IN ('pending', 'sending'))
                OR NOT EXISTS(SELECT 1 FROM projection_threads WHERE thread_id = ?1 AND deleted_at IS NULL
                  AND NOT (kind = 'panel' AND archived_at IS NOT NULL))"
        ),
        [thread_id],
        |row| row.get(0),
    )?;
    if busy {
        return Ok(ContextLimitRecovery::None);
    }
    Ok(ContextLimitRecovery::Begin {
        failed_message_id: message_id,
        target: CompactionTarget {
            provider_instance_id: instance_id,
            provider_kind,
            conversation_id: Some(conversation_id),
        },
    })
}

/// The thread's projected session, for a session update a settlement makes.
struct SessionRow {
    status: String,
    provider_name: Option<String>,
    provider_instance_id: Option<String>,
    runtime_mode: String,
    active_turn_id: Option<String>,
}

fn session_row_on(
    connection: &Connection,
    thread_id: &str,
) -> Result<Option<SessionRow>, PersistenceError> {
    connection
        .query_row(
            "SELECT status, provider_name, provider_instance_id, runtime_mode, active_turn_id FROM projection_thread_sessions WHERE thread_id = ?",
            [thread_id],
            |row| {
                Ok(SessionRow {
                    status: row.get(0)?,
                    provider_name: row.get(1)?,
                    provider_instance_id: row.get(2)?,
                    runtime_mode: row.get(3)?,
                    active_turn_id: row.get(4)?,
                })
            },
        )
        .optional()
        .map_err(Into::into)
}

/// Where a settlement records its events.
pub(crate) struct SettlementContext<'a> {
    pub(crate) occurred_at: &'a str,
    pub(crate) command_id: &'a str,
    pub(crate) events: &'a mut Vec<NewOrchestrationEvent>,
}

impl SettlementContext<'_> {
    fn push(&mut self, event_type: &str, thread_id: &str, metadata: Value, payload: Value) {
        self.events.push(make_event(
            event_type,
            "thread",
            thread_id,
            self.occurred_at,
            self.command_id,
            metadata,
            payload,
        ));
    }

    /// Sets the session's error without changing a live turn.
    fn set_session_error(
        &mut self,
        transaction: &Transaction<'_>,
        thread_id: &str,
        status: Option<&str>,
        last_error: &str,
        last_error_class: &str,
    ) -> Result<(), PersistenceError> {
        let Some(session) = session_row_on(transaction, thread_id)? else {
            return Ok(());
        };
        if matches!(session.status.as_str(), "running" | "starting") {
            return Ok(());
        }
        let occurred_at = self.occurred_at.to_owned();
        self.push(
            "thread.session-set",
            thread_id,
            json!({}),
            json!({
                "threadId": thread_id,
                "session": {
                    "threadId": thread_id,
                    "status": status.unwrap_or(&session.status),
                    "providerName": session.provider_name,
                    "providerInstanceId": session.provider_instance_id,
                    "runtimeMode": session.runtime_mode,
                    "activeTurnId": session.active_turn_id,
                    "lastError": last_error,
                    "lastErrorClass": last_error_class,
                    "updatedAt": occurred_at,
                },
            }),
        );
        Ok(())
    }

    /// Holds the thread's queue, as an error or interrupt does.
    fn hold_queue(
        &mut self,
        transaction: &Transaction<'_>,
        thread_id: &str,
    ) -> Result<(), PersistenceError> {
        let updated_at = self.occurred_at.to_owned();
        for delivery_id in hold_queued_provider_turns(transaction, thread_id, &updated_at)? {
            let (message_id, provider, mode, detail, state, provider_instance_id) = transaction.query_row(
                "SELECT message_id, provider_kind, mode, last_error, state, provider_instance_id FROM provider_turn_outbox WHERE command_id = ?",
                [&delivery_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, Option<String>>(3)?, row.get::<_, String>(4)?, row.get::<_, String>(5)?)),
            )?;
            self.push(
                "thread.turn-delivery-updated",
                thread_id,
                json!({"deliveryCommandId": delivery_id}),
                json!({"threadId": thread_id, "messageId": message_id, "state": state, "provider": provider, "mode": mode, "held": true, "detail": detail, "updatedAt": updated_at,
                    "delivery": delivery_value(&state, &provider, &provider_instance_id, &mode, true, detail.as_deref())}),
            );
        }
        Ok(())
    }
}

/// A settled compaction: its final outcome, and the copy it admitted.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SettledCompaction {
    pub(crate) outcome: String,
    /// The copy's command id, whose receipt the caller records after the events.
    pub(crate) copy_command_id: Option<String>,
}

/// Settles an unsettled compaction and applies its outcome to the thread. Returns `None` when it
/// was already settled. A Stop asked for during the compaction makes it `interrupted`, even if
/// the provider completed it.
pub(crate) fn settle_compaction_tx(
    transaction: &Transaction<'_>,
    row: &ThreadCompactionRow,
    requested_outcome: &str,
    detail: Option<&str>,
    restarted: bool,
    context: &mut SettlementContext<'_>,
) -> Result<Option<SettledCompaction>, PersistenceError> {
    let outcome = if row.stop_requested || restarted {
        "interrupted"
    } else {
        requested_outcome
    };
    // A recovery keeps the failure's own message in `detail`.
    let stored_detail = if row.trigger == "contextRecovery" {
        row.detail.as_deref()
    } else {
        detail
    };
    let updated = transaction.execute(
        &format!(
            "UPDATE thread_compactions SET state = ?, detail = ?, updated_at = ? WHERE compaction_id = ? AND state IN {UNSETTLED_COMPACTION_STATES}"
        ),
        params![
            outcome,
            stored_detail,
            context.occurred_at,
            row.compaction_id
        ],
    )?;
    if updated == 0 {
        return Ok(None);
    }
    let mut payload = json!({
        "threadId": row.thread_id,
        "compactionId": row.compaction_id,
        "outcome": outcome,
        "createdAt": context.occurred_at,
    });
    if let Some(detail) = detail.map(str::trim).filter(|detail| !detail.is_empty()) {
        payload["detail"] = json!(detail);
    }
    context.push("thread.compacted", &row.thread_id, json!({}), payload);
    let mut copy_command_id = None;
    match (row.trigger.as_str(), outcome) {
        ("contextRecovery", "completed") => {
            copy_command_id = admit_resend_copy_tx(transaction, row, context)?;
        }
        ("contextRecovery", "failed") => {
            let last_error = detail.unwrap_or("The conversation couldn't be compacted.");
            context.set_session_error(
                transaction,
                &row.thread_id,
                Some("error"),
                last_error,
                "context_limit",
            )?;
            context.hold_queue(transaction, &row.thread_id)?;
        }
        ("contextRecovery", "interrupted") => {
            if let Some(original) = row.detail.as_deref() {
                context.set_session_error(
                    transaction,
                    &row.thread_id,
                    None,
                    original,
                    "context_limit",
                )?;
            }
            context.hold_queue(transaction, &row.thread_id)?;
        }
        ("guard", "interrupted") => {
            if let Some(command_id) = row.guarded_delivery_command_id.as_deref() {
                let detail = if restarted {
                    GUARD_RESTARTED_DETAIL
                } else {
                    GUARD_STOPPED_DETAIL
                };
                fail_guarded_delivery_tx(transaction, &row.thread_id, command_id, detail, context)?;
            }
        }
        ("manual", "failed") => {
            if let Some(detail) = detail {
                // A compaction of a context-limit error that fails leaves the conversation as
                // full as before: the error keeps its class, so the Compact action stays. The row
                // kept that error's message when it was requested; the compaction's own turn has
                // cleared the session's since.
                let class = if row.detail.is_some() {
                    "context_limit"
                } else {
                    "provider_error"
                };
                context.set_session_error(
                    transaction,
                    &row.thread_id,
                    Some("error"),
                    detail,
                    class,
                )?;
            }
        }
        _ => {}
    }
    Ok(Some(SettledCompaction {
        outcome: outcome.to_owned(),
        copy_command_id,
    }))
}

/// The server-only `pending` to `failed` transition of a guarded start whose compaction was
/// stopped or cut short. Its marker stays, as for any failed start, so Retry binds its turn.
fn fail_guarded_delivery_tx(
    transaction: &Transaction<'_>,
    thread_id: &str,
    command_id: &str,
    detail: &str,
    context: &mut SettlementContext<'_>,
) -> Result<(), PersistenceError> {
    let row = transaction
        .query_row(
            "UPDATE provider_turn_outbox SET state = 'failed', last_error = ?, failure_reason = NULL, updated_at = ? WHERE command_id = ? AND thread_id = ? AND state = 'pending' AND mode = 'start' RETURNING message_id, provider_kind, provider_instance_id, held",
            params![detail, context.occurred_at, command_id, thread_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, bool>(3)?,
                ))
            },
        )
        .optional()?;
    let Some((message_id, provider, provider_instance_id, held)) = row else {
        return Ok(());
    };
    let occurred_at = context.occurred_at.to_owned();
    context.push(
        "thread.turn-delivery-updated",
        thread_id,
        json!({"deliveryCommandId": command_id, "deliveryPreviousState": "pending"}),
        json!({"threadId": thread_id, "messageId": message_id, "state": "failed", "provider": provider, "mode": "start", "held": held, "detail": detail, "updatedAt": occurred_at,
            "delivery": delivery_value("failed", &provider, &provider_instance_id, "start", held, Some(detail))}),
    );
    Ok(())
}

/// Admits the failed message's copy as a pending start: the original's stored payload, frozen
/// route and conversation, under a deterministic command id and a new delivery key. Its
/// attachment references are recorded under the copy's command id, as admission does, because
/// the delivery's attachment check looks them up by command.
fn admit_resend_copy_tx(
    transaction: &Transaction<'_>,
    row: &ThreadCompactionRow,
    context: &mut SettlementContext<'_>,
) -> Result<Option<String>, PersistenceError> {
    let Some(failed_message_id) = row.failed_message_id.as_deref() else {
        return Ok(None);
    };
    let original = transaction
        .query_row(
            "SELECT command_id, provider_instance_id, provider_kind, provider_session_id, payload_json FROM provider_turn_outbox WHERE thread_id = ? AND message_id = ? AND mode = 'start'",
            params![row.thread_id, failed_message_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, String>(4)?,
                ))
            },
        )
        .optional()?;
    let Some((original_command_id, instance_id, provider_kind, conversation_id, payload_json)) =
        original
    else {
        return Ok(None);
    };
    let mut payload: Value = serde_json::from_str(&payload_json)
        .map_err(|error| PersistenceError::Corrupt(error.to_string()))?;
    let copy_command_id = resend_command_id(failed_message_id);
    let copy_message_id = resend_message_id(failed_message_id);
    let occurred_at = context.occurred_at.to_owned();
    let Some(object) = payload.as_object_mut() else {
        return Err(PersistenceError::Corrupt(
            "a stored turn delivery payload is not an object".to_owned(),
        ));
    };
    object.insert("commandId".to_owned(), json!(copy_command_id));
    object.insert("createdAt".to_owned(), json!(occurred_at));
    object.insert("resendOf".to_owned(), json!(failed_message_id));
    object.remove("queued");
    // The thread and its worktree exist by now; the original prepared them.
    object.remove("bootstrap");
    if let Some(message) = object.get_mut("message").and_then(Value::as_object_mut) {
        message.insert("messageId".to_owned(), json!(copy_message_id));
    }
    let message = payload.get("message").cloned().unwrap_or_else(|| json!({}));
    let text = message
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let attachments = message
        .get("attachments")
        .cloned()
        .unwrap_or_else(|| json!([]));
    // Reserved here, so the outbox row and attachment references can refer to it; the persist
    // transaction accepts it with its events' sequence once they are committed.
    transaction.execute(
        "INSERT INTO orchestration_command_receipts (command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status, error, payload_digest) VALUES (?, 'thread', ?, ?, 0, 'reserved', NULL, NULL)",
        params![copy_command_id, row.thread_id, occurred_at],
    )?;
    transaction.execute(
        "INSERT INTO provider_turn_outbox (command_id, thread_id, message_id, provider_instance_id, provider_kind, provider_session_id, delivery_key, payload_json, state, mode, attempts, last_error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'start', 0, NULL, ?, ?)",
        params![
            copy_command_id,
            row.thread_id,
            copy_message_id,
            instance_id,
            provider_kind,
            conversation_id,
            Uuid::new_v4().to_string(),
            json_string(&payload)?,
            occurred_at,
            occurred_at,
        ],
    )?;
    transaction.execute(
        "INSERT OR IGNORE INTO orchestration_attachment_refs (command_id, attachment_id, content_digest, size_bytes) SELECT ?, attachment_id, content_digest, size_bytes FROM orchestration_attachment_refs WHERE command_id = ?",
        params![copy_command_id, original_command_id],
    )?;
    transaction.execute(
        "UPDATE thread_compactions SET resend_message_id = ? WHERE compaction_id = ?",
        params![copy_message_id, row.compaction_id],
    )?;
    let thread_id = row.thread_id.as_str();
    let user = make_event(
        "thread.message-sent",
        "thread",
        thread_id,
        &occurred_at,
        &copy_command_id,
        json!({}),
        json!({"threadId": thread_id, "messageId": copy_message_id, "role": "user", "text": text, "attachments": attachments, "turnId": null, "streaming": false, "resendOf": failed_message_id, "createdAt": occurred_at, "updatedAt": occurred_at}),
    );
    let mut start_payload = json!({
        "threadId": thread_id,
        "messageId": copy_message_id,
        "runtimeMode": payload.get("runtimeMode").cloned().unwrap_or_else(|| json!("full-access")),
        "interactionMode": payload.get("interactionMode").cloned().unwrap_or_else(|| json!("default")),
        "createdAt": occurred_at,
    });
    if let Some(selection) = payload
        .get("modelSelection")
        .filter(|value| !value.is_null())
    {
        start_payload["modelSelection"] = selection.clone();
    }
    let mut start = make_event(
        "thread.turn-start-requested",
        "thread",
        thread_id,
        &occurred_at,
        &copy_command_id,
        json!({}),
        start_payload,
    );
    start.causation_event_id = Some(user.event_id.clone());
    let delivery = make_event(
        "thread.turn-delivery-updated",
        "thread",
        thread_id,
        &occurred_at,
        &copy_command_id,
        json!({}),
        json!({"threadId": thread_id, "messageId": copy_message_id, "state": "pending", "provider": provider_kind, "detail": null, "updatedAt": occurred_at,
            "delivery": delivery_value("pending", &provider_kind, &instance_id, "start", false, None)}),
    );
    context.events.extend([user, start, delivery]);
    Ok(Some(copy_command_id))
}

/// The command id of the copy that sends `failed_message_id` again.
#[must_use]
pub fn resend_command_id(failed_message_id: &str) -> String {
    format!("server:context-resend:{failed_message_id}")
}

/// The message id of the copy that sends `failed_message_id` again.
#[must_use]
pub fn resend_message_id(failed_message_id: &str) -> String {
    format!("resend:{failed_message_id}")
}

/// The command id of the guard compaction before `delivery_command_id`: one per delivery.
#[must_use]
pub fn guard_command_id(delivery_command_id: &str) -> String {
    format!("server:context-guard:{delivery_command_id}")
}

/// What the event pump saw of a compaction's tagged turn once it ended.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CompactionTurnOutcome {
    pub turn_id: Option<String>,
    /// The turn's end as the provider reported it: `completed`, `failed` or `interrupted`.
    pub turn_state: String,
    /// A `context_compaction` item in the turn completed with status `completed`.
    pub compacted: bool,
}

struct CompactionWaiter {
    thread_id: String,
    turn_id: watch::Sender<Option<String>>,
    compacted: bool,
    outcome: Option<oneshot::Sender<CompactionTurnOutcome>>,
}

/// The compaction effect's view of its tagged turn: when it starts, and how it ends.
pub struct CompactionWait {
    pub turn_started: watch::Receiver<Option<String>>,
    pub outcome: oneshot::Receiver<CompactionTurnOutcome>,
}

/// One entry per compacting thread, resolved by the event pump after it projects the tagged
/// turn's events. A late event of one compaction cannot resolve another: entries are keyed by
/// compaction id and match the turn id once it is known.
#[derive(Clone, Default)]
pub struct CompactionWaiters {
    waiters: Arc<StdMutex<HashMap<String, CompactionWaiter>>>,
}

impl CompactionWaiters {
    pub fn register(&self, thread_id: &str, compaction_id: &str) -> CompactionWait {
        let (turn_id, turn_started) = watch::channel(None);
        let (outcome, receiver) = oneshot::channel();
        self.lock().insert(
            compaction_id.to_owned(),
            CompactionWaiter {
                thread_id: thread_id.to_owned(),
                turn_id,
                compacted: false,
                outcome: Some(outcome),
            },
        );
        CompactionWait {
            turn_started,
            outcome: receiver,
        }
    }

    pub fn forget(&self, compaction_id: &str) {
        self.lock().remove(compaction_id);
    }

    /// The tagged turn started. Only the first turn of a compaction counts.
    pub fn turn_started(&self, thread_id: &str, compaction_id: &str, turn_id: &str) {
        if let Some(waiter) = self.lock().get_mut(compaction_id)
            && waiter.thread_id == thread_id
        {
            waiter.turn_id.send_if_modified(|current| {
                if current.is_some() {
                    return false;
                }
                *current = Some(turn_id.to_owned());
                true
            });
        }
    }

    /// A `context_compaction` item completed with status `completed` in `turn_id`.
    pub fn compaction_item_completed(&self, thread_id: &str, turn_id: &str) {
        for waiter in self.lock().values_mut() {
            if waiter.thread_id == thread_id && waiter.turn_id.borrow().as_deref() == Some(turn_id)
            {
                waiter.compacted = true;
            }
        }
    }

    /// The tagged turn ended. Matches the compaction id and, once known, the turn id.
    pub fn turn_completed(
        &self,
        thread_id: &str,
        compaction_id: &str,
        turn_id: Option<&str>,
        turn_state: &str,
    ) {
        let mut waiters = self.lock();
        let Some(waiter) = waiters.get_mut(compaction_id) else {
            return;
        };
        let known = waiter.turn_id.borrow().clone();
        if waiter.thread_id != thread_id
            || known
                .as_deref()
                .is_some_and(|known| turn_id.is_some_and(|turn_id| turn_id != known))
        {
            return;
        }
        if let Some(sender) = waiter.outcome.take() {
            let _ = sender.send(CompactionTurnOutcome {
                turn_id: turn_id.map(str::to_owned).or(known),
                turn_state: turn_state.to_owned(),
                compacted: waiter.compacted,
            });
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, CompactionWaiter>> {
        self.waiters
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// How far below the provider's own compaction point the guard compacts, as a share of the
/// window: about 5%, so a message that crosses both points at once is compacted first.
const GUARD_HEADROOM_FRACTION: f64 = 0.05;

/// Whether a reading is at or above the guard's threshold: the provider reports where it
/// compacts and that it compacts automatically, and usage is within 5% of the window of it.
#[must_use]
pub fn reading_needs_guard(reading: &Value) -> bool {
    let number = |field: &str| reading.get(field).and_then(Value::as_f64);
    let (Some(used), Some(auto_compact), Some(max)) = (
        number("usedTokens"),
        number("autoCompactTokens"),
        number("maxTokens"),
    ) else {
        return false;
    };
    reading
        .get("compactsAutomatically")
        .and_then(Value::as_bool)
        == Some(true)
        && used >= auto_compact - GUARD_HEADROOM_FRACTION * max
}

/// Whether a pending start needs a guard compaction before it is claimed. Only once per
/// delivery, never right after a compaction no ordinary turn has followed (its reading predates
/// that compaction), and only from a reading of the conversation the delivery will continue.
fn guard_needed_on(
    connection: &Connection,
    thread_id: &str,
    delivery_command_id: &str,
    instance_id: &str,
    provider_kind: &str,
) -> Result<bool, PersistenceError> {
    let guarded: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM thread_compactions WHERE guarded_delivery_command_id = ?)",
        [delivery_command_id],
        |row| row.get(0),
    )?;
    if guarded || !crate::provider::supports_compaction(provider_kind) {
        return Ok(false);
    }
    let Some(target) = saved_conversation_on(connection, thread_id, instance_id)?
        .filter(|target| target.provider_kind == provider_kind)
    else {
        return Ok(false);
    };
    let Some(conversation_id) = target.conversation_id else {
        return Ok(false);
    };
    let compacted_without_turn: bool = connection.query_row(
        "SELECT EXISTS(
           SELECT 1 FROM (SELECT turn_id, updated_at FROM thread_compactions WHERE thread_id = ?1 AND state = 'completed' ORDER BY updated_at DESC LIMIT 1) AS last
           WHERE NOT EXISTS(SELECT 1 FROM projection_turns AS turn WHERE turn.thread_id = ?1 AND turn.turn_id IS NOT NULL
             AND turn.turn_id IS NOT last.turn_id AND COALESCE(turn.started_at, turn.requested_at) > last.updated_at))",
        [thread_id],
        |row| row.get(0),
    )?;
    if compacted_without_turn {
        return Ok(false);
    }
    let reading = connection
        .query_row(
            "SELECT payload_json FROM projection_thread_activities
             WHERE thread_id = ? AND kind = 'context-window.updated'
               AND json_type(payload_json, '$.usedTokens') IN ('integer', 'real')
               AND json_extract(payload_json, '$.providerInstanceId') = ?
               AND json_extract(payload_json, '$.conversationId') = ?
             ORDER BY created_at DESC, sequence DESC LIMIT 1",
            params![thread_id, instance_id, conversation_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    Ok(reading
        .and_then(|reading| serde_json::from_str::<Value>(&reading).ok())
        .is_some_and(|reading| reading_needs_guard(&reading)))
}

impl super::OrchestrationEngine {
    pub async fn thread_compaction(
        &self,
        compaction_id: &str,
    ) -> Result<Option<ThreadCompactionRow>, PersistenceError> {
        let compaction_id = compaction_id.to_owned();
        self.repositories()
            .database()
            .call(move |connection| compaction_row_on(connection, &compaction_id))
            .await
    }

    pub async fn unsettled_thread_compaction(
        &self,
        thread_id: &str,
    ) -> Result<Option<ThreadCompactionRow>, PersistenceError> {
        let thread_id = thread_id.to_owned();
        self.repositories()
            .database()
            .call(move |connection| unsettled_compaction_on(connection, &thread_id))
            .await
    }

    /// Every unsettled compaction, oldest first; startup settles them before delivery starts.
    pub async fn unsettled_thread_compactions(
        &self,
    ) -> Result<Vec<ThreadCompactionRow>, PersistenceError> {
        self.repositories()
            .database()
            .call(move |connection| {
                let mut statement = connection.prepare(&format!(
                    "{COMPACTION_SELECT} WHERE state IN {UNSETTLED_COMPACTION_STATES} ORDER BY created_at, compaction_id"
                ))?;
                let rows = statement
                    .query_map([], decode_compaction_row)?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(rows)
            })
            .await
    }

    /// Moves a requested compaction to `running`. Fails when a Stop got there first, so
    /// nothing is sent.
    pub async fn start_thread_compaction(
        &self,
        compaction_id: &str,
        updated_at: &str,
    ) -> Result<bool, PersistenceError> {
        self.update_thread_compaction(
            "UPDATE thread_compactions SET state = 'running', updated_at = ?1 WHERE compaction_id = ?2 AND state = 'requested'",
            compaction_id,
            updated_at,
            None,
        )
        .await
    }

    /// The request may have reached the provider: the compaction holds its thread until its own
    /// turn or the session that owns it ends.
    pub async fn mark_thread_compaction_unresolved(
        &self,
        compaction_id: &str,
        updated_at: &str,
    ) -> Result<bool, PersistenceError> {
        self.update_thread_compaction(
            "UPDATE thread_compactions SET state = 'unresolved', updated_at = ?1 WHERE compaction_id = ?2 AND state = 'running'",
            compaction_id,
            updated_at,
            None,
        )
        .await
    }

    pub async fn record_thread_compaction_turn(
        &self,
        compaction_id: &str,
        turn_id: &str,
        updated_at: &str,
    ) -> Result<bool, PersistenceError> {
        self.update_thread_compaction(
            &format!(
                "UPDATE thread_compactions SET turn_id = ?3, updated_at = ?1 WHERE compaction_id = ?2 AND turn_id IS NULL AND state IN {UNSETTLED_COMPACTION_STATES}"
            ),
            compaction_id,
            updated_at,
            Some(turn_id),
        )
        .await
    }

    async fn update_thread_compaction(
        &self,
        sql: &str,
        compaction_id: &str,
        updated_at: &str,
        turn_id: Option<&str>,
    ) -> Result<bool, PersistenceError> {
        let (sql, compaction_id, updated_at, turn_id) = (
            sql.to_owned(),
            compaction_id.to_owned(),
            updated_at.to_owned(),
            turn_id.map(str::to_owned),
        );
        self.repositories()
            .database()
            .call(move |connection| {
                let updated = match turn_id {
                    Some(turn_id) => {
                        connection.execute(&sql, params![updated_at, compaction_id, turn_id])?
                    }
                    None => connection.execute(&sql, params![updated_at, compaction_id])?,
                };
                Ok(updated == 1)
            })
            .await
    }

    /// Whether the delivery worker compacts before claiming this pending start (the guard).
    pub async fn compaction_guard_needed(
        &self,
        thread_id: &str,
        delivery_command_id: &str,
        instance_id: &str,
        provider_kind: &str,
    ) -> Result<bool, PersistenceError> {
        let (thread_id, delivery_command_id, instance_id, provider_kind) = (
            thread_id.to_owned(),
            delivery_command_id.to_owned(),
            instance_id.to_owned(),
            provider_kind.to_owned(),
        );
        self.repositories()
            .database()
            .call(move |connection| {
                guard_needed_on(
                    connection,
                    &thread_id,
                    &delivery_command_id,
                    &instance_id,
                    &provider_kind,
                )
            })
            .await
    }
}
