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
    Insert(NewAgentMessage),
    Relink(RelinkAgentMessage),
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

/// Returns false when the row is not in the expected status with the expected delivery command,
/// or its status is terminal.
pub(crate) fn apply_relink(
    tx: &rusqlite::Transaction<'_>,
    relink: &RelinkAgentMessage,
    updated_at: &str,
) -> Result<bool> {
    let changed = tx.execute(
        "UPDATE agent_messages SET delivery_command_id = ?4, delivery_message_id = ?5, status = ?6, reason = ?7, updated_at = ?8 \
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
}
