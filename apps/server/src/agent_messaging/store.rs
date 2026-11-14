//! The `agent_messages` table (migration 76): one row per agent message with its status and
//! correlation fields. A terminal status is never left, and a relink of the delivery pair is a
//! compare and set on the stored status and delivery command.
#![expect(
    dead_code,
    reason = "the send, delivery and status paths of tasks 5.4 to 5.6 read these"
)]

use rusqlite::{OptionalExtension as _, Row, params};

use crate::persistence::{Database, Result};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AgentMessageStatus {
    Accepted,
    Queued,
    Held,
    Delivered,
    Consumed,
    Completed,
    Cancelled,
    Failed,
}

impl AgentMessageStatus {
    const ALL: [Self; 8] = [
        Self::Accepted,
        Self::Queued,
        Self::Held,
        Self::Delivered,
        Self::Consumed,
        Self::Completed,
        Self::Cancelled,
        Self::Failed,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Accepted => "accepted",
            Self::Queued => "queued",
            Self::Held => "held",
            Self::Delivered => "delivered",
            Self::Consumed => "consumed",
            Self::Completed => "completed",
            Self::Cancelled => "cancelled",
            Self::Failed => "failed",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|status| status.as_str() == value)
    }

    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Cancelled | Self::Failed)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AgentMessageReason {
    MessagingOff,
    RecipientModeAboveSender,
    RecipientGone,
    RecipientTurnFailed,
    RecipientQueueHeld,
    DeliveryFailed,
    DeliveryUncertain,
}

impl AgentMessageReason {
    const ALL: [Self; 7] = [
        Self::MessagingOff,
        Self::RecipientModeAboveSender,
        Self::RecipientGone,
        Self::RecipientTurnFailed,
        Self::RecipientQueueHeld,
        Self::DeliveryFailed,
        Self::DeliveryUncertain,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::MessagingOff => "messaging_off",
            Self::RecipientModeAboveSender => "recipient_mode_above_sender",
            Self::RecipientGone => "recipient_gone",
            Self::RecipientTurnFailed => "recipient_turn_failed",
            Self::RecipientQueueHeld => "recipient_queue_held",
            Self::DeliveryFailed => "delivery_failed",
            Self::DeliveryUncertain => "delivery_uncertain",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|reason| reason.as_str() == value)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SenderKind {
    Agent,
    Person,
}

impl SenderKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Agent => "agent",
            Self::Person => "person",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        [Self::Agent, Self::Person]
            .into_iter()
            .find(|kind| kind.as_str() == value)
    }
}

#[derive(Clone, Debug)]
pub struct NewAgentMessage {
    pub message_id: String,
    pub conversation_id: String,
    pub sender_address: String,
    pub sender_kind: SenderKind,
    pub recipient_address: String,
    pub in_reply_to: Option<String>,
    pub hop: u32,
    pub text: String,
    pub status: AgentMessageStatus,
    pub reason: Option<AgentMessageReason>,
    pub accepted_at: String,
    pub sender_runtime_mode: Option<String>,
    pub recipient_terminal_generation: Option<String>,
    pub send_request_id: Option<String>,
    pub client_request_id: Option<String>,
    pub delivery_command_id: Option<String>,
    pub delivery_message_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentMessageRow {
    pub message_id: String,
    pub conversation_id: String,
    pub sender_address: String,
    pub sender_kind: SenderKind,
    pub recipient_address: String,
    pub in_reply_to: Option<String>,
    pub hop: u32,
    pub text: String,
    pub status: AgentMessageStatus,
    pub reason: Option<AgentMessageReason>,
    pub accepted_at: String,
    pub sender_runtime_mode: Option<String>,
    pub recipient_terminal_generation: Option<String>,
    pub send_request_id: Option<String>,
    pub client_request_id: Option<String>,
    pub delivery_command_id: Option<String>,
    pub delivery_message_id: Option<String>,
    pub updated_at: String,
    pub recipient_turn_id: Option<String>,
}

/// The message row written in the same transaction as its queue entry.
#[derive(Clone, Debug)]
#[expect(
    clippy::large_enum_variant,
    reason = "one per admitted command, moved once; the Insert form is the interface tasks 5.4 and 6.4 build"
)]
pub enum AgentMessageCompanion {
    /// A new message, refused with its whole command when a limit applies.
    Insert(NewAgentMessage, Option<super::policy::AdmissionLimits>),
    Relink(RelinkAgentMessage),
}

impl AgentMessageCompanion {
    /// Whether the message waits in its recipient's paused queue, its entry held with it.
    pub(crate) fn is_held(&self) -> bool {
        let status = match self {
            Self::Insert(message, _) => message.status,
            Self::Relink(relink) => relink.status,
        };
        status == AgentMessageStatus::Held
    }
}

/// Moves a message to a new queue entry, only from the state the caller last read.
#[derive(Clone, Debug)]
pub struct RelinkAgentMessage {
    pub message_id: String,
    pub expected_status: AgentMessageStatus,
    pub expected_delivery_command_id: Option<String>,
    pub delivery_command_id: String,
    pub delivery_message_id: String,
    pub status: AgentMessageStatus,
    pub reason: Option<AgentMessageReason>,
}

const COLUMNS: &str = "message_id, conversation_id, sender_address, sender_kind, recipient_address, in_reply_to, hop, text, status, reason, accepted_at, sender_runtime_mode, recipient_terminal_generation, send_request_id, client_request_id, delivery_command_id, delivery_message_id, updated_at, recipient_turn_id";

fn decode(row: &Row<'_>) -> rusqlite::Result<AgentMessageRow> {
    let sender_kind: String = row.get(3)?;
    let status: String = row.get(8)?;
    let reason: Option<String> = row.get(9)?;
    Ok(AgentMessageRow {
        message_id: row.get(0)?,
        conversation_id: row.get(1)?,
        sender_address: row.get(2)?,
        sender_kind: SenderKind::parse(&sender_kind)
            .ok_or_else(|| invalid_text(3, &sender_kind))?,
        recipient_address: row.get(4)?,
        in_reply_to: row.get(5)?,
        hop: row.get(6)?,
        text: row.get(7)?,
        status: AgentMessageStatus::parse(&status).ok_or_else(|| invalid_text(8, &status))?,
        reason: reason
            .map(|value| AgentMessageReason::parse(&value).ok_or_else(|| invalid_text(9, &value)))
            .transpose()?,
        accepted_at: row.get(10)?,
        sender_runtime_mode: row.get(11)?,
        recipient_terminal_generation: row.get(12)?,
        send_request_id: row.get(13)?,
        client_request_id: row.get(14)?,
        delivery_command_id: row.get(15)?,
        delivery_message_id: row.get(16)?,
        updated_at: row.get(17)?,
        recipient_turn_id: row.get(18)?,
    })
}

fn invalid_text(column: usize, value: &str) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        column,
        rusqlite::types::Type::Text,
        format!("unknown agent message value {value:?}").into(),
    )
}

pub(crate) fn insert_message(tx: &rusqlite::Transaction<'_>, new: &NewAgentMessage) -> Result<()> {
    tx.execute(
        &format!("INSERT INTO agent_messages ({COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?11, NULL)"),
        params![
            new.message_id,
            new.conversation_id,
            new.sender_address,
            new.sender_kind.as_str(),
            new.recipient_address,
            new.in_reply_to,
            new.hop,
            new.text,
            new.status.as_str(),
            new.reason.map(AgentMessageReason::as_str),
            new.accepted_at,
            new.sender_runtime_mode,
            new.recipient_terminal_generation,
            new.send_request_id,
            new.client_request_id,
            new.delivery_command_id,
            new.delivery_message_id,
        ],
    )?;
    Ok(())
}

/// How many agent messages `sender_address` had accepted since `since`, compared as times, not
/// as strings.
pub(crate) fn count_sent_since(
    connection: &rusqlite::Connection,
    sender_address: &str,
    since: &str,
) -> Result<u32> {
    Ok(connection.query_row(
        "SELECT COUNT(*) FROM agent_messages
          WHERE sender_address = ?1 AND sender_kind = 'agent'
            AND julianday(accepted_at) >= julianday(?2)",
        params![sender_address, since],
        |row| row.get(0),
    )?)
}

/// How many agent messages to `recipient_address` are not yet consumed or final.
pub(crate) fn count_unconsumed(
    connection: &rusqlite::Connection,
    recipient_address: &str,
) -> Result<u32> {
    Ok(connection.query_row(
        "SELECT COUNT(*) FROM agent_messages
          WHERE recipient_address = ?1 AND sender_kind = 'agent'
            AND status IN ('accepted', 'queued', 'held', 'delivered')",
        params![recipient_address],
        |row| row.get(0),
    )?)
}

pub(crate) fn get_message(
    connection: &rusqlite::Connection,
    message_id: &str,
) -> Result<Option<AgentMessageRow>> {
    Ok(connection
        .query_row(
            &format!("SELECT {COLUMNS} FROM agent_messages WHERE message_id = ?1"),
            params![message_id],
            decode,
        )
        .optional()?)
}

/// The message `sender_address` stored under `client_request_id`, if any.
pub(crate) fn find_by_client_request(
    connection: &rusqlite::Connection,
    sender_address: &str,
    client_request_id: &str,
) -> Result<Option<AgentMessageRow>> {
    Ok(connection
        .query_row(
            &format!(
                "SELECT {COLUMNS} FROM agent_messages WHERE sender_address = ?1 AND client_request_id = ?2"
            ),
            params![sender_address, client_request_id],
            decode,
        )
        .optional()?)
}

/// Returns false and changes nothing when the stored status is terminal or the row is absent.
pub(crate) fn set_status(
    connection: &rusqlite::Connection,
    message_id: &str,
    status: AgentMessageStatus,
    reason: Option<AgentMessageReason>,
    updated_at: &str,
) -> Result<bool> {
    let changed = connection.execute(
        "UPDATE agent_messages SET status = ?2, reason = ?3, updated_at = ?4 \
         WHERE message_id = ?1 AND status NOT IN ('completed', 'cancelled', 'failed')",
        params![
            message_id,
            status.as_str(),
            reason.map(AgentMessageReason::as_str),
            updated_at
        ],
    )?;
    Ok(changed == 1)
}

/// Cancels `message_id` in one compare and set: only while it is accepted, queued or held (an
/// uncertain delivery may have reached the provider, so not that hold) and its queue entry was
/// not claimed, so a message the recipient may have read is never reported cancelled.
pub(crate) fn cancel_waiting(
    connection: &rusqlite::Connection,
    message_id: &str,
    updated_at: &str,
) -> Result<bool> {
    let changed = connection.execute(
        "UPDATE agent_messages SET status = 'cancelled', reason = NULL, updated_at = ?2
          WHERE message_id = ?1 AND status IN ('accepted', 'queued', 'held')
            AND reason IS NOT 'delivery_uncertain'
            AND NOT EXISTS(SELECT 1 FROM provider_turn_outbox AS entry
                            WHERE entry.command_id = agent_messages.delivery_command_id
                              AND entry.state IN ('sending', 'delivered', 'uncertain'))",
        params![message_id, updated_at],
    )?;
    Ok(changed == 1)
}

/// Returns false when the row is not in the expected status with the expected delivery command,
/// or its status is terminal. The new queue entry starts a new turn, so the recorded one is
/// cleared.
pub(crate) fn apply_relink(
    tx: &rusqlite::Transaction<'_>,
    relink: &RelinkAgentMessage,
    updated_at: &str,
) -> Result<bool> {
    let changed = tx.execute(
        "UPDATE agent_messages SET delivery_command_id = ?4, delivery_message_id = ?5, status = ?6, reason = ?7, updated_at = ?8, recipient_turn_id = NULL \
         WHERE message_id = ?1 AND status = ?2 AND delivery_command_id IS ?3 \
           AND status NOT IN ('completed', 'cancelled', 'failed')",
        params![
            relink.message_id,
            relink.expected_status.as_str(),
            relink.expected_delivery_command_id,
            relink.delivery_command_id,
            relink.delivery_message_id,
            relink.status.as_str(),
            relink.reason.map(AgentMessageReason::as_str),
            updated_at,
        ],
    )?;
    Ok(changed == 1)
}

/// The newest reply to `in_reply_to`, in acceptance order.
pub(crate) fn latest_reply_id(
    connection: &rusqlite::Connection,
    in_reply_to: &str,
) -> Result<Option<String>> {
    Ok(connection
        .query_row(
            "SELECT message_id FROM agent_messages WHERE in_reply_to = ?1 ORDER BY rowid DESC LIMIT 1",
            params![in_reply_to],
            |row| row.get(0),
        )
        .optional()?)
}

/// Records the recipient's turn that took the message.
pub(crate) fn set_recipient_turn(
    connection: &rusqlite::Connection,
    message_id: &str,
    turn_id: &str,
) -> Result<()> {
    connection.execute(
        "UPDATE agent_messages SET recipient_turn_id = ?2 WHERE message_id = ?1",
        params![message_id, turn_id],
    )?;
    Ok(())
}

const OPEN: &str = "status NOT IN ('completed', 'cancelled', 'failed')";

/// The messages to `recipient_address` whose status is not final, in acceptance order.
pub(crate) fn list_open_for_thread(
    connection: &rusqlite::Connection,
    recipient_address: &str,
) -> Result<Vec<AgentMessageRow>> {
    let mut statement = connection.prepare_cached(&format!(
        "SELECT {COLUMNS} FROM agent_messages WHERE recipient_address = ?1 AND {OPEN} ORDER BY rowid"
    ))?;
    let rows = statement
        .query_map(params![recipient_address], decode)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Every message whose status is not final, in acceptance order.
pub(crate) fn list_open(connection: &rusqlite::Connection) -> Result<Vec<AgentMessageRow>> {
    let mut statement = connection.prepare_cached(&format!(
        "SELECT {COLUMNS} FROM agent_messages WHERE {OPEN} ORDER BY rowid"
    ))?;
    let rows = statement
        .query_map([], decode)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Holds the agent message of queue entry `command_id` with `reason`, only while that entry is
/// still `pending` and the message waits for it; returns whether it changed.
pub(crate) fn hold_pending_delivery(
    connection: &rusqlite::Connection,
    command_id: &str,
    reason: AgentMessageReason,
    updated_at: &str,
) -> Result<bool> {
    let changed = connection.execute(
        "UPDATE agent_messages SET status = 'held', reason = ?2, updated_at = ?3
          WHERE delivery_command_id = ?1 AND sender_kind = 'agent'
            AND status IN ('accepted', 'queued', 'held') AND NOT (status = 'held' AND reason IS ?2)
            AND EXISTS(SELECT 1 FROM provider_turn_outbox WHERE command_id = ?1 AND state = 'pending')",
        params![command_id, reason.as_str(), updated_at],
    )?;
    Ok(changed == 1)
}

/// Holds, with `recipient_mode_above_sender`, every agent message to `recipient_address` (every
/// recipient when `None`) still waiting in the queue whose recipient now runs with more access
/// than its sender had when it sent it. Run in one database call, so no claim falls between
/// the check of the entry and the hold.
pub(crate) fn hold_above_ceiling(
    connection: &rusqlite::Connection,
    recipient_address: Option<&str>,
    updated_at: &str,
) -> Result<usize> {
    let mut statement = connection.prepare_cached(
        "SELECT message.message_id, message.sender_runtime_mode, thread.runtime_mode
           FROM agent_messages AS message
           JOIN projection_threads AS thread ON 'thread:' || thread.thread_id = message.recipient_address
           JOIN provider_turn_outbox AS entry ON entry.command_id = message.delivery_command_id
          WHERE message.sender_kind = 'agent' AND message.status IN ('accepted', 'queued')
            AND entry.state IN ('queued', 'pending')
            AND (?1 IS NULL OR message.recipient_address = ?1)
          ORDER BY message.rowid",
    )?;
    let waiting = statement
        .query_map(params![recipient_address], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut held = 0;
    for (message_id, sender_mode, recipient_mode) in waiting {
        if sender_mode.is_some_and(|sender| super::policy::ceiling_allows(&sender, &recipient_mode))
        {
            continue;
        }
        if set_status(
            connection,
            &message_id,
            AgentMessageStatus::Held,
            Some(AgentMessageReason::RecipientModeAboveSender),
            updated_at,
        )? {
            held += 1;
        }
    }
    Ok(held)
}

/// Holds with `reason` every agent message to `recipient_address` (every recipient when `None`)
/// whose entry still waits in the queue. A message whose entry is already being sent is left to
/// complete (the accepted limit of turning messaging off).
pub(crate) fn hold_waiting(
    connection: &rusqlite::Connection,
    recipient_address: Option<&str>,
    reason: AgentMessageReason,
    updated_at: &str,
) -> Result<usize> {
    Ok(connection.execute(
        "UPDATE agent_messages SET status = 'held', reason = ?2, updated_at = ?3
          WHERE sender_kind = 'agent' AND status IN ('accepted', 'queued')
            AND (?1 IS NULL OR recipient_address = ?1)
            AND delivery_command_id IN (SELECT command_id FROM provider_turn_outbox WHERE state IN ('queued', 'pending'))",
        params![recipient_address, reason.as_str(), updated_at],
    )?)
}

/// The agent messages held for `reason`, in acceptance order.
pub(crate) fn list_held_for(
    connection: &rusqlite::Connection,
    reason: AgentMessageReason,
) -> Result<Vec<AgentMessageRow>> {
    let mut statement = connection.prepare_cached(&format!(
        "SELECT {COLUMNS} FROM agent_messages WHERE status = 'held' AND reason = ?1 AND sender_kind = 'agent' ORDER BY rowid"
    ))?;
    let rows = statement
        .query_map(params![reason.as_str()], decode)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// The agent messages held for the setting or the mode ceiling, in one acceptance order across
/// both reasons, so a release requeues them in the order they were accepted (R13).
pub(crate) fn list_held_for_release(
    connection: &rusqlite::Connection,
) -> Result<Vec<AgentMessageRow>> {
    let mut statement = connection.prepare_cached(&format!(
        "SELECT {COLUMNS} FROM agent_messages
          WHERE status = 'held' AND reason IN ('messaging_off', 'recipient_mode_above_sender')
            AND sender_kind = 'agent'
          ORDER BY rowid"
    ))?;
    let rows = statement
        .query_map([], decode)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// The messages that must not wait in a queue, whose entry still does: a final one, or one held
/// for the setting or the mode ceiling (a message held for its recipient's paused queue or an
/// uncertain delivery keeps its entry for a person). Acceptance order.
pub(crate) fn list_needing_withdrawal(
    connection: &rusqlite::Connection,
    recipient_address: Option<&str>,
) -> Result<Vec<AgentMessageRow>> {
    let mut statement = connection.prepare_cached(&format!(
        "SELECT {COLUMNS} FROM agent_messages
          WHERE (status IN ('completed', 'cancelled', 'failed')
                 OR (status = 'held' AND reason IN ('messaging_off', 'recipient_mode_above_sender')))
            AND (?1 IS NULL OR recipient_address = ?1)
            AND delivery_command_id IN (SELECT command_id FROM provider_turn_outbox
                                         WHERE state IN ('queued', 'pending', 'failed'))
          ORDER BY rowid"
    ))?;
    let rows = statement
        .query_map(params![recipient_address], decode)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Whether queue entry `command_id` delivering `message_id` is an agent's message: the server
/// stored its row in the queue entry's own transaction, so no text a person sends makes it one.
pub(crate) fn is_agent_message_delivery(
    connection: &rusqlite::Connection,
    command_id: &str,
    message_id: &str,
) -> Result<bool> {
    Ok(connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM agent_messages WHERE delivery_command_id = ?1 AND delivery_message_id = ?2 AND sender_kind = 'agent')",
        params![command_id, message_id],
        |row| row.get(0),
    )?)
}

/// The hop the chain of `sender_thread_id` stands at: the hop of the agent message that started
/// its latest agent-started turn (the message whose recorded turn it is, or whose thread message
/// its marker names, a marker not yet bound to a turn included), unless a later turn of the
/// thread started from a signed-in person's message: a stored thread message with no actor.
/// `None` when no agent message started a turn since. A turn with no known message resets nothing, and
/// neither does the end of a turn or time (R14); turns are ordered by their row, never by time.
pub(crate) fn trigger_hop(
    connection: &rusqlite::Connection,
    sender_thread_id: &str,
) -> Result<Option<u32>> {
    Ok(connection
        .query_row(
            "WITH started AS (
               SELECT turn.row_id, message.hop
                 FROM projection_turns AS turn
                 JOIN agent_messages AS message
                   ON message.recipient_address = 'thread:' || turn.thread_id
                  AND message.sender_kind = 'agent'
                  AND ((turn.turn_id IS NOT NULL AND message.recipient_turn_id = turn.turn_id)
                       OR message.delivery_message_id = turn.pending_message_id)
                WHERE turn.thread_id = ?1),
             latest AS (SELECT MAX(row_id) AS row_id FROM started)
             SELECT MAX(started.hop) FROM started JOIN latest ON started.row_id = latest.row_id
              WHERE NOT EXISTS(
                SELECT 1 FROM projection_turns AS later
                 WHERE later.thread_id = ?1 AND later.row_id > latest.row_id
                   AND later.pending_message_id IS NOT NULL
                   -- A withdrawn entry started nothing; a requeued agent message leaves one.
                   AND NOT EXISTS(SELECT 1 FROM provider_turn_outbox AS entry
                                   WHERE entry.thread_id = later.thread_id
                                     AND entry.message_id = later.pending_message_id
                                     AND entry.state = 'dismissed')
                   -- Only a signed-in person's message has no actor; an outside client's or a
                   -- hosted agent's message keeps the chain (R14).
                   AND EXISTS(SELECT 1 FROM projection_thread_messages AS sent
                               WHERE sent.message_id = later.pending_message_id
                                 AND sent.actor_json IS NULL))",
            params![sender_thread_id],
            |row| row.get::<_, Option<u32>>(0),
        )
        .optional()?
        .flatten())
}

/// Whether `thread_id`'s queue is paused: an entry a person has not released waits in it, or
/// its last turn ended in an error or an interrupt. An agent message joins a paused queue held
/// and never starts a turn (R18).
pub(crate) fn queue_paused(connection: &rusqlite::Connection, thread_id: &str) -> Result<bool> {
    Ok(connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM provider_turn_outbox WHERE thread_id = ?1 AND state = 'queued' AND held = 1)
             OR EXISTS(SELECT 1 FROM projection_thread_sessions WHERE thread_id = ?1 AND status IN ('error', 'interrupted'))",
        params![thread_id],
        |row| row.get(0),
    )?)
}

/// Whether `thread_id` has a pending approval or an open question, by the rule the promotion
/// gate applies: an agent message never answers or runs past one (R6, R9).
pub(crate) fn has_open_ask(connection: &rusqlite::Connection, thread_id: &str) -> Result<bool> {
    let open_user_inputs = crate::persistence::open_user_input_requests_sql("?1");
    Ok(connection.query_row(
        &format!(
            "SELECT EXISTS(SELECT 1 FROM projection_pending_approvals WHERE thread_id = ?1 AND status = 'pending')
                 OR EXISTS({open_user_inputs})"
        ),
        params![thread_id],
        |row| row.get(0),
    )?)
}

const TERMINAL_RECIPIENT: &str = "substr(recipient_address, 1, 9) = 'terminal:'";

/// Terminal mail with work left: not final, and consumed mail only until its generation's end is
/// recorded. Written exactly as the WHERE of `idx_agent_messages_terminal_pending` (migration 76),
/// so the queries below read only these rows, through that index.
const TERMINAL_PENDING: &str = "recipient_terminal_generation IS NOT NULL AND (status IN ('accepted', 'queued', 'held', 'delivered') OR (status = 'consumed' AND reason IS NULL))";

/// Whether a terminal's inbox may return `message` now: a person's request always, an agent's
/// message only while messaging is `enabled` and its sender's mode reaches `full-access`.
fn inbox_admits(message: &AgentMessageRow, enabled: bool) -> bool {
    message.sender_kind != SenderKind::Agent
        || (enabled
            && message
                .sender_runtime_mode
                .as_deref()
                .is_some_and(|sender| {
                    super::policy::ceiling_allows(sender, super::pointer::TERMINAL_RECIPIENT_MODE)
                }))
}

fn queued_terminal_mail_sql() -> String {
    format!(
        "SELECT {COLUMNS} FROM agent_messages
          WHERE {TERMINAL_PENDING} AND status = 'queued' AND (sender_kind = 'person' OR ?1)
          ORDER BY rowid"
    )
}

/// The `queued` mail of every terminal, in acceptance order: a person's request always, an
/// agent's message only while messaging is `enabled`.
pub(crate) fn list_queued_terminal_mail(
    connection: &rusqlite::Connection,
    enabled: bool,
) -> Result<Vec<AgentMessageRow>> {
    let mut statement = connection.prepare_cached(&queued_terminal_mail_sql())?;
    let rows = statement
        .query_map(params![enabled], decode)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// The `queued` mail of `recipient_address`'s generation `generation_key` that its inbox would
/// return now, in acceptance order: what a pointer may announce.
pub(crate) fn eligible_terminal_mail(
    connection: &rusqlite::Connection,
    recipient_address: &str,
    generation_key: &str,
    enabled: bool,
) -> Result<Vec<AgentMessageRow>> {
    let mut statement = connection.prepare_cached(&format!(
        "SELECT {COLUMNS} FROM agent_messages
          WHERE recipient_address = ?1 AND recipient_terminal_generation = ?2 AND status = 'queued'
          ORDER BY rowid"
    ))?;
    let rows = statement
        .query_map(params![recipient_address, generation_key], decode)?
        .filter(|row| row.as_ref().map_or(true, |row| inbox_admits(row, enabled)))
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Marks each of `message_ids` `delivered`, only while it is still `queued`: a fetch, a cancel or
/// a hold that came first keeps its status. Returns the rows it changed.
pub(crate) fn deliver_queued(
    connection: &rusqlite::Connection,
    message_ids: &[String],
    updated_at: &str,
) -> Result<Vec<AgentMessageRow>> {
    let mut statement = connection.prepare_cached(&format!(
        "UPDATE agent_messages SET status = 'delivered', reason = NULL, updated_at = ?2
          WHERE message_id = ?1 AND status = 'queued'
          RETURNING {COLUMNS}"
    ))?;
    let mut delivered = Vec::new();
    for message_id in message_ids {
        if let Some(row) = statement
            .query_row(params![message_id, updated_at], decode)
            .optional()?
        {
            delivered.push(row);
        }
    }
    Ok(delivered)
}

/// Moves the mail of `recipient_address`'s generation `generation_key` that its inbox may return
/// ([`inbox_admits`]) to `consumed`, oldest first, in one transaction: each row by a compare and
/// set from the status it was read with, so a concurrent cancel or fetch has one winner, and an
/// error leaves every row as it was. `queued` and `delivered` rows only. Returns the rows it
/// consumed.
pub(crate) fn consume_for_generation(
    connection: &rusqlite::Connection,
    recipient_address: &str,
    generation_key: &str,
    enabled: bool,
    updated_at: &str,
) -> Result<Vec<AgentMessageRow>> {
    let tx = connection.unchecked_transaction()?;
    let mut select = tx.prepare_cached(&format!(
        "SELECT {COLUMNS} FROM agent_messages
          WHERE recipient_address = ?1 AND recipient_terminal_generation = ?2
            AND status IN ('queued', 'delivered')
          ORDER BY rowid"
    ))?;
    let waiting = select
        .query_map(params![recipient_address, generation_key], decode)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut consume = tx.prepare_cached(&format!(
        "UPDATE agent_messages SET status = 'consumed', reason = NULL, updated_at = ?3
          WHERE message_id = ?1 AND status = ?2
          RETURNING {COLUMNS}"
    ))?;
    let mut consumed = Vec::new();
    for message in waiting {
        if !inbox_admits(&message, enabled) {
            continue;
        }
        if let Some(row) = consume
            .query_row(
                params![message.message_id, message.status.as_str(), updated_at],
                decode,
            )
            .optional()?
        {
            consumed.push(row);
        }
    }
    drop((select, consume));
    tx.commit()?;
    Ok(consumed)
}

/// Fails, with `recipient_gone`, every message of the ended generation `generation_key` of
/// `recipient_address` that its inbox did not fetch. Returns their ids.
pub(crate) fn fail_unconsumed_for_generation(
    connection: &rusqlite::Connection,
    recipient_address: &str,
    generation_key: &str,
) -> Result<Vec<String>> {
    let mut statement = connection.prepare_cached(
        "UPDATE agent_messages SET status = 'failed', reason = 'recipient_gone', updated_at = ?3
          WHERE recipient_address = ?1 AND recipient_terminal_generation = ?2
            AND status IN ('accepted', 'queued', 'held', 'delivered')
          RETURNING message_id",
    )?;
    let ids = statement
        .query_map(
            params![
                recipient_address,
                generation_key,
                crate::mcp::control::now_iso()
            ],
            |row| row.get(0),
        )?
        .collect::<rusqlite::Result<Vec<String>>>()?;
    Ok(ids)
}

/// Records the end of generation `generation_key` of `recipient_address` on the mail its inbox
/// fetched: `consumed` rows keep their status and take the reason `recipient_gone` (read, then
/// the terminal went), so the end is never handled again. Returns how many rows it marked.
pub(crate) fn end_consumed_for_generation(
    connection: &rusqlite::Connection,
    recipient_address: &str,
    generation_key: &str,
) -> Result<usize> {
    Ok(connection.execute(
        "UPDATE agent_messages SET reason = 'recipient_gone', updated_at = ?3
          WHERE recipient_address = ?1 AND recipient_terminal_generation = ?2
            AND status = 'consumed' AND reason IS NULL",
        params![
            recipient_address,
            generation_key,
            crate::mcp::control::now_iso()
        ],
    )?)
}

fn open_terminal_generations_sql() -> String {
    // The redundant status list lets the planner search the index by its leading column.
    format!(
        "SELECT recipient_address, recipient_terminal_generation FROM agent_messages
          WHERE {TERMINAL_PENDING}
            AND status IN ('accepted', 'queued', 'held', 'delivered', 'consumed')
          GROUP BY recipient_address, recipient_terminal_generation
          ORDER BY MIN(rowid)"
    )
}

/// Each terminal generation with pending mail ([`TERMINAL_PENDING`]), consumed mail whose end
/// is not recorded included, as `(recipient address, generation key)`, in acceptance order of
/// its first row.
pub(crate) fn list_open_terminal_generations(
    connection: &rusqlite::Connection,
) -> Result<Vec<(String, String)>> {
    let mut statement = connection.prepare_cached(&open_terminal_generations_sql())?;
    let rows = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Cancels the terminal message `message_id` in one compare and set, only while no inbox has
/// fetched it: `accepted`, `queued`, `held`, or `delivered` (the pointer was typed, the mail was
/// not read).
pub(crate) fn cancel_unfetched_terminal(
    connection: &rusqlite::Connection,
    message_id: &str,
    updated_at: &str,
) -> Result<bool> {
    let changed = connection.execute(
        &format!(
            "UPDATE agent_messages SET status = 'cancelled', reason = NULL, updated_at = ?2
              WHERE message_id = ?1 AND {TERMINAL_RECIPIENT}
                AND status IN ('accepted', 'queued', 'held', 'delivered')"
        ),
        params![message_id, updated_at],
    )?;
    Ok(changed == 1)
}

#[derive(Clone)]
pub(crate) struct AgentMessageStore {
    database: Database,
}

impl AgentMessageStore {
    pub(crate) fn new(database: Database) -> Self {
        Self { database }
    }

    pub(crate) async fn get(&self, message_id: &str) -> Result<Option<AgentMessageRow>> {
        let message_id = message_id.to_owned();
        self.database
            .call(move |connection| get_message(connection, &message_id))
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn connection() -> rusqlite::Connection {
        let mut connection = rusqlite::Connection::open_in_memory().unwrap();
        crate::persistence::run_migrations(&mut connection, None).unwrap();
        connection
    }

    fn message(message_id: &str) -> NewAgentMessage {
        NewAgentMessage {
            message_id: message_id.to_owned(),
            conversation_id: "c1".to_owned(),
            sender_address: "thread:a".to_owned(),
            sender_kind: SenderKind::Agent,
            recipient_address: "thread:b".to_owned(),
            in_reply_to: Some("m0".to_owned()),
            hop: 2,
            text: "Which port does the dev server use?".to_owned(),
            status: AgentMessageStatus::Accepted,
            reason: Some(AgentMessageReason::RecipientQueueHeld),
            accepted_at: "2026-11-14T00:00:00Z".to_owned(),
            sender_runtime_mode: Some("full-access".to_owned()),
            recipient_terminal_generation: Some("3".to_owned()),
            send_request_id: Some("r1".to_owned()),
            client_request_id: Some("client-1".to_owned()),
            delivery_command_id: Some("c1".to_owned()),
            delivery_message_id: Some("dm1".to_owned()),
        }
    }

    fn insert(connection: &mut rusqlite::Connection, new: &NewAgentMessage) {
        let tx = connection.transaction().unwrap();
        insert_message(&tx, new).unwrap();
        tx.commit().unwrap();
    }

    #[test]
    fn an_inserted_message_reads_back_with_every_column() {
        let mut connection = connection();
        insert(&mut connection, &message("m1"));
        let row = get_message(&connection, "m1").unwrap().unwrap();
        assert_eq!(
            row,
            AgentMessageRow {
                message_id: "m1".to_owned(),
                conversation_id: "c1".to_owned(),
                sender_address: "thread:a".to_owned(),
                sender_kind: SenderKind::Agent,
                recipient_address: "thread:b".to_owned(),
                in_reply_to: Some("m0".to_owned()),
                hop: 2,
                text: "Which port does the dev server use?".to_owned(),
                status: AgentMessageStatus::Accepted,
                reason: Some(AgentMessageReason::RecipientQueueHeld),
                accepted_at: "2026-11-14T00:00:00Z".to_owned(),
                sender_runtime_mode: Some("full-access".to_owned()),
                recipient_terminal_generation: Some("3".to_owned()),
                send_request_id: Some("r1".to_owned()),
                client_request_id: Some("client-1".to_owned()),
                delivery_command_id: Some("c1".to_owned()),
                delivery_message_id: Some("dm1".to_owned()),
                updated_at: "2026-11-14T00:00:00Z".to_owned(),
                recipient_turn_id: None,
            }
        );
        assert_eq!(get_message(&connection, "missing").unwrap(), None);
    }

    #[test]
    fn set_status_never_leaves_a_terminal_state() {
        let mut connection = connection();
        for (index, terminal) in [
            AgentMessageStatus::Completed,
            AgentMessageStatus::Cancelled,
            AgentMessageStatus::Failed,
        ]
        .into_iter()
        .enumerate()
        {
            let id = format!("m{index}");
            let mut new = message(&id);
            new.client_request_id = None;
            new.reason = None;
            insert(&mut connection, &new);
            assert!(set_status(&connection, &id, terminal, None, "2026-11-14T00:01:00Z").unwrap());
            let before = get_message(&connection, &id).unwrap().unwrap();
            assert!(
                !set_status(
                    &connection,
                    &id,
                    AgentMessageStatus::Queued,
                    Some(AgentMessageReason::DeliveryFailed),
                    "2026-11-14T00:02:00Z",
                )
                .unwrap(),
                "{} is terminal",
                terminal.as_str()
            );
            assert_eq!(get_message(&connection, &id).unwrap().unwrap(), before);
            assert!(terminal.is_terminal());
        }
    }

    #[test]
    fn status_and_reason_names_are_the_contract_names() {
        assert_eq!(
            AgentMessageStatus::ALL
                .map(AgentMessageStatus::as_str)
                .join(" "),
            "accepted queued held delivered consumed completed cancelled failed"
        );
        assert_eq!(
            AgentMessageReason::ALL
                .map(AgentMessageReason::as_str)
                .join(" "),
            "messaging_off recipient_mode_above_sender recipient_gone recipient_turn_failed recipient_queue_held delivery_failed delivery_uncertain"
        );
        for status in AgentMessageStatus::ALL {
            assert_eq!(AgentMessageStatus::parse(status.as_str()), Some(status));
        }
        for reason in AgentMessageReason::ALL {
            assert_eq!(AgentMessageReason::parse(reason.as_str()), Some(reason));
        }
        assert_eq!(
            AgentMessageStatus::ALL
                .into_iter()
                .filter(|status| status.is_terminal())
                .map(AgentMessageStatus::as_str)
                .collect::<Vec<_>>(),
            ["completed", "cancelled", "failed"]
        );
    }

    #[test]
    fn apply_relink_needs_the_expected_previous_state() {
        let mut connection = connection();
        let mut new = message("m1");
        new.status = AgentMessageStatus::Held;
        insert(&mut connection, &new);
        let before = get_message(&connection, "m1").unwrap().unwrap();
        let relink = |expected_status, expected_command: &str| RelinkAgentMessage {
            message_id: "m1".to_owned(),
            expected_status,
            expected_delivery_command_id: Some(expected_command.to_owned()),
            delivery_command_id: "c2".to_owned(),
            delivery_message_id: "dm2".to_owned(),
            status: AgentMessageStatus::Queued,
            reason: None,
        };
        for stale in [
            relink(AgentMessageStatus::Queued, "c1"),
            relink(AgentMessageStatus::Held, "c9"),
        ] {
            let tx = connection.transaction().unwrap();
            assert!(!apply_relink(&tx, &stale, "2026-11-14T00:01:00Z").unwrap());
            tx.commit().unwrap();
            assert_eq!(get_message(&connection, "m1").unwrap().unwrap(), before);
        }
        let tx = connection.transaction().unwrap();
        assert!(
            apply_relink(
                &tx,
                &relink(AgentMessageStatus::Held, "c1"),
                "2026-11-14T00:01:00Z"
            )
            .unwrap()
        );
        tx.commit().unwrap();
        let after = get_message(&connection, "m1").unwrap().unwrap();
        assert_eq!(after.delivery_command_id.as_deref(), Some("c2"));
        assert_eq!(after.delivery_message_id.as_deref(), Some("dm2"));
        assert_eq!(after.status, AgentMessageStatus::Queued);
        assert_eq!(after.reason, None);
        assert_eq!(after.updated_at, "2026-11-14T00:01:00Z");
    }

    #[test]
    fn apply_relink_never_revives_a_terminal_message() {
        let mut connection = connection();
        for terminal in [
            AgentMessageStatus::Completed,
            AgentMessageStatus::Cancelled,
            AgentMessageStatus::Failed,
        ] {
            let id = format!("m-{}", terminal.as_str());
            let mut new = message(&id);
            new.client_request_id = None;
            new.status = terminal;
            insert(&mut connection, &new);
            let before = get_message(&connection, &id).unwrap().unwrap();
            let tx = connection.transaction().unwrap();
            let revived = apply_relink(
                &tx,
                &RelinkAgentMessage {
                    message_id: id.clone(),
                    expected_status: terminal,
                    expected_delivery_command_id: Some("c1".to_owned()),
                    delivery_command_id: "c2".to_owned(),
                    delivery_message_id: "dm2".to_owned(),
                    status: AgentMessageStatus::Queued,
                    reason: None,
                },
                "2026-11-14T00:01:00Z",
            )
            .unwrap();
            tx.commit().unwrap();
            assert!(!revived, "{} is terminal", terminal.as_str());
            assert_eq!(get_message(&connection, &id).unwrap().unwrap(), before);
        }
    }

    /// Thread `a` takes turn `turn_id`, started by its user message `message_id` whose actor
    /// is `actor` (`None` for a person).
    fn turn_started(
        connection: &rusqlite::Connection,
        turn_id: &str,
        message_id: &str,
        actor: Option<&str>,
    ) {
        connection
            .execute(
                "INSERT INTO projection_thread_messages (message_id, thread_id, role, text, is_streaming, created_at, updated_at, actor_json)
                 VALUES (?1, 'a', 'user', 'hello', 0, '2026-11-14T00:00:00Z', '2026-11-14T00:00:00Z', ?2)",
                params![message_id, actor],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO projection_turns (thread_id, turn_id, pending_message_id, state, requested_at, checkpoint_files_json)
                 VALUES ('a', ?1, ?2, 'completed', '2026-11-14T00:00:00Z', '[]')",
                params![turn_id, message_id],
            )
            .unwrap();
    }

    #[test]
    fn only_a_persons_message_resets_the_hop_chain() {
        let mut connection = connection();
        let trigger = NewAgentMessage {
            recipient_address: "thread:a".to_owned(),
            sender_address: "thread:b".to_owned(),
            hop: 8,
            delivery_message_id: Some("dm8".to_owned()),
            ..message("m8")
        };
        insert(&mut connection, &trigger);
        turn_started(
            &connection,
            "t1",
            "dm8",
            Some(r#"{"kind":"hosted-agent","address":"thread:b","label":"B"}"#),
        );
        assert_eq!(trigger_hop(&connection, "a").unwrap(), Some(8));

        // `bibcode thread send` from inside a hosted agent: an outside client's message.
        turn_started(
            &connection,
            "t2",
            "cli",
            Some(r#"{"kind":"mcp-client","clientId":"session","label":"MCP"}"#),
        );
        assert_eq!(trigger_hop(&connection, "a").unwrap(), Some(8));

        turn_started(&connection, "t3", "person", None);
        assert_eq!(trigger_hop(&connection, "a").unwrap(), None);
    }

    fn terminal_message(message_id: &str) -> NewAgentMessage {
        NewAgentMessage {
            recipient_address: "terminal:t/term-1".to_owned(),
            status: AgentMessageStatus::Queued,
            reason: None,
            recipient_terminal_generation: Some("boot-1:1".to_owned()),
            client_request_id: None,
            delivery_command_id: None,
            delivery_message_id: None,
            ..message(message_id)
        }
    }

    #[test]
    fn a_failed_inbox_batch_consumes_nothing() {
        let mut connection = connection();
        insert(&mut connection, &terminal_message("m1"));
        insert(&mut connection, &terminal_message("m2"));
        connection
            .execute_batch(
                "CREATE TEMP TRIGGER fail_second BEFORE UPDATE ON agent_messages
                   WHEN OLD.message_id = 'm2' BEGIN SELECT RAISE(ABORT, 'injected'); END;",
            )
            .unwrap();
        assert!(
            consume_for_generation(&connection, "terminal:t/term-1", "boot-1:1", true, "now")
                .is_err()
        );
        assert_eq!(
            get_message(&connection, "m1").unwrap().unwrap().status,
            AgentMessageStatus::Queued,
            "a batch that returned an error kept a row consumed"
        );
    }

    /// The `detail` column of `sql`'s query plan, one step per line.
    fn query_plan(connection: &rusqlite::Connection, sql: &str) -> String {
        let mut statement = connection
            .prepare(&format!("EXPLAIN QUERY PLAN {sql}"))
            .unwrap();
        let count = statement.parameter_count();
        let parameters: Vec<bool> = vec![true; count];
        statement
            .query_map(rusqlite::params_from_iter(parameters), |row| {
                row.get::<_, String>(3)
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
            .join("\n")
    }

    #[test]
    fn terminal_mail_queries_read_only_pending_rows_through_an_index() {
        let connection = connection();
        for (name, sql) in [
            ("queued mail", queued_terminal_mail_sql()),
            ("open generations", open_terminal_generations_sql()),
        ] {
            let plan = query_plan(&connection, &sql);
            assert!(
                plan.contains("INDEX idx_agent_messages_terminal_pending"),
                "{name}: {plan}"
            );
        }
    }
}
