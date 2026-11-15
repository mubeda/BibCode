//! The `send_requests` table (migration 75): one row per request a person sent to an agent.
//! A row keeps the sizes of the note and attachments, never their text, and keeps only the
//! target's answer text. Every state change is a compare and set on the stored state, so a
//! late event can never move a request back or overwrite a final state.

use rusqlite::{OptionalExtension as _, Row, params, params_from_iter};

use crate::persistence::{Database, Result};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SendAction {
    Review,
    SecondOpinion,
    HandOff,
    TakeOver,
    Message,
}

impl SendAction {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Review => "review",
            Self::SecondOpinion => "second-opinion",
            Self::HandOff => "hand-off",
            Self::TakeOver => "take-over",
            Self::Message => "message",
        }
    }

    pub(crate) fn parse(value: &str) -> Option<Self> {
        [
            Self::Review,
            Self::SecondOpinion,
            Self::HandOff,
            Self::TakeOver,
            Self::Message,
        ]
        .into_iter()
        .find(|action| action.as_str() == value)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SendState {
    Queued,
    Waiting,
    Delivered,
    Read,
    Answered,
    NotAnswered,
    Cancelled,
}

impl SendState {
    const ALL: [Self; 7] = [
        Self::Queued,
        Self::Waiting,
        Self::Delivered,
        Self::Read,
        Self::Answered,
        Self::NotAnswered,
        Self::Cancelled,
    ];
    const OPEN: [Self; 4] = [Self::Queued, Self::Waiting, Self::Delivered, Self::Read];
    const FINAL: [Self; 3] = [Self::Answered, Self::NotAnswered, Self::Cancelled];

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Waiting => "waiting",
            Self::Delivered => "delivered",
            Self::Read => "read",
            Self::Answered => "answered",
            Self::NotAnswered => "not_answered",
            Self::Cancelled => "cancelled",
        }
    }

    pub(crate) fn parse(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|state| state.as_str() == value)
    }

    pub(crate) fn is_final(self) -> bool {
        Self::FINAL.contains(&self)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SendRequestRow {
    pub(crate) request_id: String,
    pub(crate) project_id: String,
    pub(crate) source_address: String,
    pub(crate) source_thread_id: String,
    pub(crate) action: SendAction,
    pub(crate) target_address: String,
    pub(crate) target_thread_id: String,
    pub(crate) taken_over_address: Option<String>,
    pub(crate) args_digest: String,
    pub(crate) note_chars: i64,
    pub(crate) attachment_chars: i64,
    pub(crate) target_message_id: Option<String>,
    pub(crate) command_id: Option<String>,
    /// The modes the turn command was built with, so a replay rebuilds the same command.
    pub(crate) runtime_mode: String,
    pub(crate) interaction_mode: String,
    pub(crate) answering_turn_id: Option<String>,
    pub(crate) answer_message_id: Option<String>,
    pub(crate) answer_text: Option<String>,
    pub(crate) answer_truncated: bool,
    pub(crate) terminal_generation: Option<i64>,
    pub(crate) state: SendState,
    pub(crate) reason: Option<String>,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
    pub(crate) dismissed_at: Option<String>,
}

/// One state change. `reason` replaces the stored reason; the answer fields are kept when
/// `None`. `dismiss` stamps `dismissed_at` in the same update, so a request can be dismissed
/// at `read` without being final.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct StateChange {
    pub(crate) to: SendState,
    pub(crate) reason: Option<String>,
    pub(crate) answering_turn_id: Option<String>,
    pub(crate) answer_message_id: Option<String>,
    pub(crate) answer_text: Option<String>,
    pub(crate) answer_truncated: bool,
    pub(crate) dismiss: bool,
    pub(crate) at: String,
}

const COLUMNS: &str = "request_id, project_id, source_address, source_thread_id, action, \
    target_address, target_thread_id, taken_over_address, args_digest, note_chars, \
    attachment_chars, target_message_id, command_id, runtime_mode, interaction_mode, \
    answering_turn_id, answer_message_id, answer_text, answer_truncated, terminal_generation, \
    state, reason, created_at, updated_at, dismissed_at";

fn decode(row: &Row<'_>) -> rusqlite::Result<SendRequestRow> {
    let action: String = row.get(4)?;
    let state: String = row.get(20)?;
    Ok(SendRequestRow {
        request_id: row.get(0)?,
        project_id: row.get(1)?,
        source_address: row.get(2)?,
        source_thread_id: row.get(3)?,
        action: SendAction::parse(&action).ok_or_else(|| invalid_text(4, &action))?,
        target_address: row.get(5)?,
        target_thread_id: row.get(6)?,
        taken_over_address: row.get(7)?,
        args_digest: row.get(8)?,
        note_chars: row.get(9)?,
        attachment_chars: row.get(10)?,
        target_message_id: row.get(11)?,
        command_id: row.get(12)?,
        runtime_mode: row.get(13)?,
        interaction_mode: row.get(14)?,
        answering_turn_id: row.get(15)?,
        answer_message_id: row.get(16)?,
        answer_text: row.get(17)?,
        answer_truncated: row.get::<_, i64>(18)? != 0,
        terminal_generation: row.get(19)?,
        state: SendState::parse(&state).ok_or_else(|| invalid_text(20, &state))?,
        reason: row.get(21)?,
        created_at: row.get(22)?,
        updated_at: row.get(23)?,
        dismissed_at: row.get(24)?,
    })
}

fn invalid_text(column: usize, value: &str) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        column,
        rusqlite::types::Type::Text,
        format!("unknown send request value {value:?}").into(),
    )
}

fn read(connection: &rusqlite::Connection, request_id: &str) -> Result<Option<SendRequestRow>> {
    Ok(connection
        .query_row(
            &format!("SELECT {COLUMNS} FROM send_requests WHERE request_id = ?1"),
            params![request_id],
            decode,
        )
        .optional()?)
}

fn placeholders(states: &[SendState]) -> String {
    vec!["?"; states.len()].join(", ")
}

/// [`SendRequestStore::transition`] inside the caller's transaction, so a request and another
/// row can change together.
pub(crate) fn transition_in(
    transaction: &rusqlite::Transaction<'_>,
    request_id: &str,
    from: &[SendState],
    change: StateChange,
) -> Result<Option<SendRequestRow>> {
    if from.is_empty() {
        return Ok(None);
    }
    let sql = format!(
        "UPDATE send_requests SET state = ?2, reason = ?3, \
         answering_turn_id = COALESCE(?4, answering_turn_id), \
         answer_message_id = COALESCE(?5, answer_message_id), \
         answer_text = COALESCE(?6, answer_text), \
         answer_truncated = CASE WHEN ?6 IS NULL THEN answer_truncated ELSE ?7 END, \
         dismissed_at = CASE WHEN ?8 THEN COALESCE(dismissed_at, ?9) ELSE dismissed_at END, \
         updated_at = ?9 \
         WHERE request_id = ?1 AND state IN ({})",
        (0..from.len())
            .map(|index| format!("?{}", index + 10))
            .collect::<Vec<_>>()
            .join(", ")
    );
    let mut values: Vec<rusqlite::types::Value> = vec![
        request_id.to_owned().into(),
        change.to.as_str().to_owned().into(),
        change.reason.into(),
        change.answering_turn_id.into(),
        change.answer_message_id.into(),
        change.answer_text.into(),
        i64::from(change.answer_truncated).into(),
        i64::from(change.dismiss).into(),
        change.at.into(),
    ];
    values.extend(from.iter().map(|state| state.as_str().to_owned().into()));
    if transaction.execute(&sql, params_from_iter(values))? != 1 {
        return Ok(None);
    }
    read(transaction, request_id)
}

#[derive(Clone)]
pub(crate) struct SendRequestStore {
    database: Database,
}

impl SendRequestStore {
    pub(crate) fn new(database: Database) -> Self {
        Self { database }
    }

    /// Stores `row` unless a request with its id exists. Returns the stored row and whether
    /// this call created it.
    pub(crate) async fn insert_if_absent(
        &self,
        row: SendRequestRow,
    ) -> Result<(SendRequestRow, bool)> {
        self.database
            .call(move |connection| {
                let transaction = connection.transaction()?;
                let created = transaction.execute(
                    &format!(
                        "INSERT INTO send_requests ({COLUMNS}) VALUES \
                         (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, \
                          ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25) \
                         ON CONFLICT (request_id) DO NOTHING"
                    ),
                    params![
                        row.request_id,
                        row.project_id,
                        row.source_address,
                        row.source_thread_id,
                        row.action.as_str(),
                        row.target_address,
                        row.target_thread_id,
                        row.taken_over_address,
                        row.args_digest,
                        row.note_chars,
                        row.attachment_chars,
                        row.target_message_id,
                        row.command_id,
                        row.runtime_mode,
                        row.interaction_mode,
                        row.answering_turn_id,
                        row.answer_message_id,
                        row.answer_text,
                        i64::from(row.answer_truncated),
                        row.terminal_generation,
                        row.state.as_str(),
                        row.reason,
                        row.created_at,
                        row.updated_at,
                        row.dismissed_at,
                    ],
                )? == 1;
                let stored = transaction.query_row(
                    &format!("SELECT {COLUMNS} FROM send_requests WHERE request_id = ?1"),
                    params![row.request_id],
                    decode,
                )?;
                transaction.commit()?;
                Ok((stored, created))
            })
            .await
    }

    pub(crate) async fn get(&self, request_id: &str) -> Result<Option<SendRequestRow>> {
        let request_id = request_id.to_owned();
        self.database
            .call(move |connection| read(connection, &request_id))
            .await
    }

    #[allow(dead_code)] // The follower reads open requests by target thread instead.
    pub(crate) async fn by_target_message(
        &self,
        thread_id: &str,
        message_id: &str,
    ) -> Result<Option<SendRequestRow>> {
        let (thread_id, message_id) = (thread_id.to_owned(), message_id.to_owned());
        self.database
            .call(move |connection| {
                Ok(connection
                    .query_row(
                        &format!(
                            "SELECT {COLUMNS} FROM send_requests \
                             WHERE target_thread_id = ?1 AND target_message_id = ?2"
                        ),
                        params![thread_id, message_id],
                        decode,
                    )
                    .optional()?)
            })
            .await
    }

    /// Every undismissed request of the scope (one source thread, or all), newest first.
    pub(crate) async fn list_undismissed(
        &self,
        source_thread_id: Option<&str>,
    ) -> Result<Vec<SendRequestRow>> {
        let source_thread_id = source_thread_id.map(str::to_owned);
        self.database
            .call(move |connection| {
                let mut statement = connection.prepare_cached(&format!(
                    "SELECT {COLUMNS} FROM send_requests \
                     WHERE dismissed_at IS NULL AND (?1 IS NULL OR source_thread_id = ?1) \
                     ORDER BY created_at DESC, request_id DESC"
                ))?;
                Ok(statement
                    .query_map(params![source_thread_id], decode)?
                    .collect::<rusqlite::Result<Vec<_>>>()?)
            })
            .await
    }

    /// Every request that is queued, waiting, delivered or read, oldest first.
    pub(crate) async fn list_open(&self) -> Result<Vec<SendRequestRow>> {
        self.database
            .call(|connection| {
                let mut statement = connection.prepare_cached(&format!(
                    "SELECT {COLUMNS} FROM send_requests WHERE state IN ({}) \
                     ORDER BY created_at, request_id",
                    placeholders(&SendState::OPEN)
                ))?;
                Ok(statement
                    .query_map(
                        params_from_iter(SendState::OPEN.iter().map(|state| state.as_str())),
                        decode,
                    )?
                    .collect::<rusqlite::Result<Vec<_>>>()?)
            })
            .await
    }

    /// Moves the request to `change.to` only when its stored state is one of `from`. Returns
    /// the changed row, or `None` with no write when it is not.
    pub(crate) async fn transition(
        &self,
        request_id: &str,
        from: &[SendState],
        change: StateChange,
    ) -> Result<Option<SendRequestRow>> {
        let request_id = request_id.to_owned();
        let from = from.to_vec();
        self.database
            .call(move |connection| {
                let transaction = connection.transaction()?;
                let row = transition_in(&transaction, &request_id, &from, change)?;
                transaction.commit()?;
                Ok(row)
            })
            .await
    }

    /// The person's dismissal of a final request. `None` when the request is missing or not
    /// final. A second dismissal keeps the first time.
    pub(crate) async fn dismiss(
        &self,
        request_id: &str,
        at: &str,
    ) -> Result<Option<SendRequestRow>> {
        let (request_id, at) = (request_id.to_owned(), at.to_owned());
        self.database
            .call(move |connection| {
                let transaction = connection.transaction()?;
                let mut values: Vec<rusqlite::types::Value> =
                    vec![request_id.clone().into(), at.into()];
                values.extend(
                    SendState::FINAL
                        .iter()
                        .map(|state| state.as_str().to_owned().into()),
                );
                let changed = transaction.execute(
                    "UPDATE send_requests SET dismissed_at = COALESCE(dismissed_at, ?2), \
                     updated_at = ?2 WHERE request_id = ?1 AND state IN (?3, ?4, ?5)",
                    params_from_iter(values),
                )?;
                let row = if changed == 1 {
                    read(&transaction, &request_id)?
                } else {
                    None
                };
                transaction.commit()?;
                Ok(row)
            })
            .await
    }

    /// Removes every request sent from `source_thread_id` and returns their ids.
    pub(crate) async fn delete_for_source_thread(
        &self,
        source_thread_id: &str,
    ) -> Result<Vec<String>> {
        let source_thread_id = source_thread_id.to_owned();
        self.database
            .call(move |connection| {
                let mut statement = connection.prepare_cached(
                    "DELETE FROM send_requests WHERE source_thread_id = ?1 RETURNING request_id",
                )?;
                Ok(statement
                    .query_map(params![source_thread_id], |row| row.get(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?)
            })
            .await
    }
}
