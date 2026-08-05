use std::collections::HashSet;

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use thiserror::Error;
use uuid::Uuid;

use crate::{
    crypto::sha256_hex,
    diagnostics::redact_sensitive_text,
    persistence::{Database, PersistenceError},
};

use super::model::{
    ACTIVITY_CURSOR_MAX_LENGTH, ACTIVITY_DELTA_MAX_CHANGES, ACTIVITY_DETAIL_MAX_LENGTH,
    ACTIVITY_ID_MAX_LENGTH, ACTIVITY_LABEL_MAX_LENGTH, ACTIVITY_PAGE_MAX_LENGTH,
    ACTIVITY_SUMMARY_MAX_LENGTH, ActivityActorSummary, ActivityCapabilities, ActivityChange,
    ActivityCounts, ActivityDelta, ActivityDetailPage, ActivityEntry, ActivityEntryKind,
    ActivityEntryTone, ActivityLifecycle, ActivityModelError, ActivityObservationState,
    ActivityRecordKind, ActivityRecordSummary, ActivityRosterBucket, ActivityRosterPage,
    ActivityScopeRef, ActivityScopeSeed, ActivitySection, ActivitySectionHealthMap,
    ActivitySectionObservationState, ActivitySnapshot, ActivitySummaryCounts,
    ActivityWorkItemSummary, ProviderActivityMutation, compare_timestamps, max_timestamp,
    validate_text, validate_timestamp,
};
use super::routing::AgentActivitySource;

pub const ACTIVE_STATUSES: &[&str] = &["starting", "running", "waiting", "unknown"];
pub const DONE_STATUSES: &[&str] = &["completed", "failed", "cancelled", "interrupted"];

const NOW_SQL: &str = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
const JOURNAL_EVENT_KEY_NAMESPACE_CANONICAL: &str = "canonical";
const JOURNAL_EVENT_KEY_NAMESPACE_LEGACY: &str = "legacy";
const ACTIVITY_LINEAGE_V1_MAX_DEPTH: i64 = 64;
const ACTIVITY_RETENTION_V1_SUMMARY_RECORDS_PER_SCOPE: i64 = 2_000;
const ACTIVITY_RETENTION_V1_ENTRIES_PER_RECORD: i64 = 200;
const ACTIVITY_RETENTION_V1_JOURNAL_ROWS_PER_SCOPE: i64 = 5_000;
const ACTIVITY_RETENTION_V1_COMPLETED_AGE_DAYS: i64 = 30;
const ACTIVITY_RETENTION_PRUNE_ROWS_PER_TRANSACTION: i64 = 128;
const ACTIVITY_RETENTION_PRUNE_RECORD_GROUP_MAX_ROWS: i64 =
    ACTIVITY_RETENTION_V1_ENTRIES_PER_RECORD + 1;
const ACTIVITY_REDACTION_LOOKAHEAD_UTF16_UNITS: usize = 512;

#[derive(Clone, Debug)]
pub struct ActivityRepository {
    database: Database,
}

#[derive(Debug, Error)]
pub enum ActivityRepositoryError {
    #[error(transparent)]
    Persistence(#[from] PersistenceError),
    #[error(transparent)]
    InvalidModel(#[from] ActivityModelError),
    #[error("activity scope was not found")]
    NotFound,
    #[error("activity scope is invalid: {0}")]
    InvalidScope(String),
    #[error("activity cursor is invalid")]
    InvalidCursor,
    #[error("activity mutation batch must not be empty")]
    EmptyBatch,
    #[error("activity mutation batch exceeds the 256-change bound")]
    TooManyMutations,
    #[error("activity record reference does not belong to this scope: {0}")]
    InvalidReference(String),
    #[error("activity capability invariant failed: {0}")]
    InvalidCapabilities(String),
    #[error("activity page limit must be positive")]
    InvalidLimit,
    #[error("agent activity is disabled")]
    FeatureDisabled,
    #[error("activity JSON could not be encoded or decoded")]
    Serialization(#[source] serde_json::Error),
}

pub type ActivityRepositoryResult<T> = Result<T, ActivityRepositoryError>;

#[derive(Clone, Debug)]
struct StoredScope {
    scope_id: String,
    scope: ActivityScopeRef,
    revision: u64,
    provider: String,
    provider_instance_id: Option<String>,
    capabilities: ActivityCapabilities,
    observation_state: ActivityObservationState,
    sections: ActivitySectionHealthMap,
    updated_at: String,
}

#[derive(Debug)]
struct PrunedRecord {
    record_kind: ActivityRecordKind,
    record_id: String,
}

#[derive(Debug)]
struct PrunedEntries {
    owner_kind: ActivityRecordKind,
    owner_id: String,
}

#[derive(Debug)]
struct RetentionRecordCandidate {
    record_kind: String,
    record_id: String,
    entry_count: i64,
}

#[derive(Debug, Default)]
struct RetentionPruneResult {
    records: Vec<PrunedRecord>,
    entries: Vec<PrunedEntries>,
}

#[derive(Debug)]
struct RetentionWorkBudget {
    remaining_rows: i64,
}

impl RetentionWorkBudget {
    const fn new() -> Self {
        Self {
            remaining_rows: ACTIVITY_RETENTION_PRUNE_ROWS_PER_TRANSACTION,
        }
    }

    const fn has_remaining(&self) -> bool {
        self.remaining_rows > 0
    }

    fn consume(&mut self, rows: i64) -> bool {
        if rows > self.remaining_rows {
            return false;
        }
        self.remaining_rows -= rows;
        true
    }

    /// A record and all of its retained detail form one deletion unit. Allow one
    /// complete v1-sized group when it is the first work in this transaction so
    /// a 128-row general budget cannot strand records with 128–200 entries.
    fn consume_record_group(&mut self, rows: i64) -> bool {
        if self.consume(rows) {
            return true;
        }
        if self.remaining_rows == ACTIVITY_RETENTION_PRUNE_ROWS_PER_TRANSACTION
            && rows <= ACTIVITY_RETENTION_PRUNE_RECORD_GROUP_MAX_ROWS
        {
            self.remaining_rows = 0;
            return true;
        }
        false
    }

    fn limit(&self, requested: i64) -> i64 {
        requested.min(self.remaining_rows)
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RosterCursor {
    updated_at: String,
    record_id: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct DetailCursor {
    created_at: String,
    entry_id: String,
}

impl ActivityRepository {
    pub const fn new(database: Database) -> Self {
        Self { database }
    }

    pub async fn ensure_scope(&self, seed: ActivityScopeSeed) -> ActivityRepositoryResult<()> {
        seed.validate()?;
        self.database
            .call(move |connection| Ok(ensure_scope(connection, seed)))
            .await?
    }

    pub async fn apply_batch(
        &self,
        scope_id: &str,
        native_event_key: &str,
        mutations: Vec<ProviderActivityMutation>,
        updated_at: &str,
    ) -> ActivityRepositoryResult<Vec<ActivityDelta>> {
        if mutations.is_empty() {
            return Err(ActivityRepositoryError::EmptyBatch);
        }
        if mutations.len() > 256 {
            return Err(ActivityRepositoryError::TooManyMutations);
        }
        let scope_id = validate_text(
            scope_id.to_owned(),
            "scope id",
            ACTIVITY_ID_MAX_LENGTH,
            true,
        )?;
        let native_event_key = validate_text(
            native_event_key.to_owned(),
            "native event key",
            ACTIVITY_ID_MAX_LENGTH,
            true,
        )?;
        let updated_at = validate_timestamp(updated_at.to_owned(), "updatedAt")?;
        self.database
            .call(move |connection| {
                Ok(apply_batch(
                    connection,
                    &scope_id,
                    &native_event_key,
                    mutations,
                    &updated_at,
                ))
            })
            .await?
    }

    pub(crate) async fn prune_retention_pass(
        &self,
        scope_id: &str,
    ) -> ActivityRepositoryResult<Vec<ActivityDelta>> {
        let scope_id = validate_text(
            scope_id.to_owned(),
            "scope id",
            ACTIVITY_ID_MAX_LENGTH,
            true,
        )?;
        let native_event_key = format!("activity:retention:{}", Uuid::new_v4());
        self.database
            .call(move |connection| {
                Ok(database_now(connection).and_then(|updated_at| {
                    apply_batch(
                        connection,
                        &scope_id,
                        &native_event_key,
                        Vec::new(),
                        &updated_at,
                    )
                }))
            })
            .await?
    }

    pub(crate) async fn retention_pending(&self, scope_id: &str) -> ActivityRepositoryResult<bool> {
        let scope_id = validate_text(
            scope_id.to_owned(),
            "scope id",
            ACTIVITY_ID_MAX_LENGTH,
            true,
        )?;
        self.database
            .call(move |connection| Ok(retention_pending(connection, &scope_id)))
            .await?
    }

    pub async fn interrupt_unresolved_terminal_scopes(&self) -> ActivityRepositoryResult<usize> {
        self.database
            .call(move |connection| Ok(interrupt_unresolved_terminal_scopes(connection)))
            .await?
    }

    pub async fn interrupt_unresolved_activity_scopes(
        &self,
        reason: &'static str,
        source: AgentActivitySource,
    ) -> ActivityRepositoryResult<usize> {
        let source_kind = source.storage_kind();
        self.database
            .call(move |connection| {
                Ok(interrupt_unresolved_activity_scopes(
                    connection,
                    reason,
                    None,
                    source_kind,
                ))
            })
            .await?
    }

    pub(crate) async fn interrupt_unresolved_activity_scopes_for_generation(
        &self,
        reason: &'static str,
        disable_generation: u64,
        source: AgentActivitySource,
    ) -> ActivityRepositoryResult<usize> {
        let source_kind = source.storage_kind();
        self.database
            .call(move |connection| {
                Ok(interrupt_unresolved_activity_scopes(
                    connection,
                    reason,
                    Some(disable_generation),
                    source_kind,
                ))
            })
            .await?
    }

    pub async fn snapshot(
        &self,
        scope: &ActivityScopeRef,
    ) -> ActivityRepositoryResult<ActivitySnapshot> {
        scope.validate()?;
        let scope = scope.clone();
        self.database
            .call(move |connection| Ok(snapshot(connection, &scope)))
            .await?
    }

    pub async fn list_roster(
        &self,
        scope: &ActivityScopeRef,
        scope_id: &str,
        section: ActivitySection,
        bucket: ActivityRosterBucket,
        cursor: Option<&str>,
        limit: usize,
    ) -> ActivityRepositoryResult<ActivityRosterPage> {
        if limit == 0 {
            return Err(ActivityRepositoryError::InvalidLimit);
        }
        let scope = scope.clone();
        scope.validate()?;
        let scope_id = validate_text(
            scope_id.to_owned(),
            "scope id",
            ACTIVITY_ID_MAX_LENGTH,
            true,
        )?;
        let cursor = cursor.map(decode_cursor).transpose()?;
        self.database
            .call(move |connection| {
                Ok(
                    load_paged_scope(connection, &scope, &scope_id).and_then(|_| {
                        list_roster(
                            connection,
                            &scope_id,
                            section,
                            bucket,
                            cursor.as_ref(),
                            limit.min(ACTIVITY_PAGE_MAX_LENGTH),
                        )
                    }),
                )
            })
            .await?
    }

    pub async fn list_detail(
        &self,
        scope: &ActivityScopeRef,
        scope_id: &str,
        record_kind: ActivityRecordKind,
        record_id: &str,
        cursor: Option<&str>,
        limit: usize,
    ) -> ActivityRepositoryResult<ActivityDetailPage> {
        if limit == 0 {
            return Err(ActivityRepositoryError::InvalidLimit);
        }
        let scope = scope.clone();
        scope.validate()?;
        let scope_id = validate_text(
            scope_id.to_owned(),
            "scope id",
            ACTIVITY_ID_MAX_LENGTH,
            true,
        )?;
        let record_id = validate_text(
            record_id.to_owned(),
            "record id",
            ACTIVITY_ID_MAX_LENGTH,
            true,
        )?;
        let cursor = cursor.map(decode_cursor).transpose()?;
        self.database
            .call(move |connection| {
                Ok(
                    load_paged_scope(connection, &scope, &scope_id).and_then(|_| {
                        list_detail(
                            connection,
                            &scope_id,
                            record_kind,
                            &record_id,
                            cursor.as_ref(),
                            limit.min(ACTIVITY_PAGE_MAX_LENGTH),
                        )
                    }),
                )
            })
            .await?
    }
}

fn ensure_scope(
    connection: &mut Connection,
    seed: ActivityScopeSeed,
) -> ActivityRepositoryResult<()> {
    let transaction = connection.transaction().map_err(sql_error)?;
    let exists = transaction
        .query_row(
            "SELECT 1 FROM activity_scopes WHERE scope_id = ?",
            [&seed.scope_id],
            |_| Ok(()),
        )
        .optional()
        .map_err(sql_error)?
        .is_some();
    if exists {
        transaction.commit().map_err(sql_error)?;
        return Ok(());
    }

    let now = database_now(&transaction)?;
    if let ActivityScopeRef::Terminal {
        thread_id,
        terminal_id,
    } = &seed.scope
    {
        let prior_scope_ids = {
            let mut statement = transaction
                .prepare(
                    "SELECT scope_id FROM activity_scopes
                     WHERE thread_id = ? AND source_kind = 'terminal'
                       AND terminal_id = ? AND is_current = 1",
                )
                .map_err(sql_error)?;
            statement
                .query_map(params![thread_id, terminal_id], |row| {
                    row.get::<_, String>(0)
                })
                .map_err(sql_error)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(sql_error)?
        };
        for prior_scope_id in &prior_scope_ids {
            interrupt_active_records_for_scope(&transaction, prior_scope_id, &now, None, None)?;
            let prior_updated_at = transaction
                .query_row(
                    "SELECT updated_at FROM activity_scopes WHERE scope_id = ?",
                    [prior_scope_id],
                    |row| row.get::<_, String>(0),
                )
                .map_err(sql_error)?;
            let scope_updated_at = max_timestamp(&prior_updated_at, &now)?;
            transaction
                .execute(
                    "UPDATE activity_scopes
                     SET is_current = 0, updated_at = ?
                     WHERE scope_id = ?",
                    params![scope_updated_at, prior_scope_id],
                )
                .map_err(sql_error)?;
        }
    }

    let capabilities_json = encode_json(&seed.capabilities)?;
    let sections_json = encode_json(&seed.sections)?;
    transaction
        .execute(
            "INSERT INTO activity_scopes (
               scope_id, source_kind, thread_id, terminal_id, generation_id, is_current,
               provider_name, provider_instance_id, capabilities_json, observation_state,
               section_health_json, revision, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, 'live', ?, 0, ?, ?)",
            params![
                seed.scope_id,
                seed.scope.source_kind(),
                seed.scope.thread_id(),
                seed.scope.terminal_id(),
                seed.generation_id,
                seed.provider,
                seed.provider_instance_id,
                capabilities_json,
                sections_json,
                now,
                now,
            ],
        )
        .map_err(sql_error)?;
    if record_retention_counts_available(&transaction)? {
        transaction
            .execute(
                "INSERT INTO activity_record_retention_counts (scope_id, record_count)
                 VALUES (?, 0)",
                [&seed.scope_id],
            )
            .map_err(sql_error)?;
    }
    transaction.commit().map_err(sql_error)?;
    Ok(())
}

fn interrupt_unresolved_terminal_scopes(
    connection: &mut Connection,
) -> ActivityRepositoryResult<usize> {
    let transaction = connection.transaction().map_err(sql_error)?;
    let now = database_now(&transaction)?;
    let scope_ids = {
        let mut statement = transaction
            .prepare(
                "SELECT DISTINCT s.scope_id
                 FROM activity_scopes s
                 JOIN activity_records r ON r.scope_id = s.scope_id
                 WHERE s.source_kind = 'terminal'
                   AND r.status IN ('starting', 'running', 'waiting', 'unknown')",
            )
            .map_err(sql_error)?;
        statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(sql_error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(sql_error)?
    };
    let mut interrupted = 0_usize;
    for scope_id in scope_ids {
        interrupted = interrupted.saturating_add(interrupt_active_records_for_scope(
            &transaction,
            &scope_id,
            &now,
            None,
            None,
        )?);
        transaction
            .execute(
                "UPDATE activity_scopes
                 SET revision = revision + 1,
                     updated_at = CASE WHEN updated_at > ? THEN updated_at ELSE ? END
                 WHERE scope_id = ?",
                params![now, now, scope_id],
            )
            .map_err(sql_error)?;
    }
    transaction.commit().map_err(sql_error)?;
    Ok(interrupted)
}

fn interrupt_unresolved_activity_scopes(
    connection: &mut Connection,
    reason: &'static str,
    disable_generation: Option<u64>,
    source_kind: &'static str,
) -> ActivityRepositoryResult<usize> {
    let transaction = connection.transaction().map_err(sql_error)?;
    let now = database_now(&transaction)?;
    let scope_ids = {
        let mut statement = transaction
            .prepare(
                "SELECT DISTINCT s.scope_id
                 FROM activity_scopes s
                 JOIN activity_records r ON r.scope_id = s.scope_id
                 WHERE s.source_kind = ?
                   AND r.status IN ('starting', 'running', 'waiting', 'unknown')",
            )
            .map_err(sql_error)?;
        statement
            .query_map([source_kind], |row| row.get::<_, String>(0))
            .map_err(sql_error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(sql_error)?
    };
    let mut interrupted = 0_usize;
    for scope_id in scope_ids {
        let scope_interrupted = interrupt_active_records_for_scope(
            &transaction,
            &scope_id,
            &now,
            Some(reason),
            disable_generation,
        )?;
        if scope_interrupted == 0 {
            continue;
        }
        interrupted = interrupted.saturating_add(scope_interrupted);
        transaction
            .execute(
                "UPDATE activity_scopes
                 SET revision = revision + 1,
                     updated_at = CASE WHEN updated_at > ? THEN updated_at ELSE ? END
                 WHERE scope_id = ?",
                params![now, now, scope_id],
            )
            .map_err(sql_error)?;
    }
    transaction.commit().map_err(sql_error)?;
    Ok(interrupted)
}

fn interrupt_active_records_for_scope(
    transaction: &Transaction<'_>,
    scope_id: &str,
    now: &str,
    reason: Option<&'static str>,
    interruption_generation: Option<u64>,
) -> ActivityRepositoryResult<usize> {
    let active_records = {
        let mut statement = transaction
            .prepare(
                "SELECT record_kind, record_id, summary_json
                 FROM activity_records
                 WHERE scope_id = ?
                   AND status IN ('starting', 'running', 'waiting', 'unknown')",
            )
            .map_err(sql_error)?;
        statement
            .query_map([scope_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(sql_error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(sql_error)?
    };
    let interrupted_count = active_records.len();
    for (record_kind, record_id, summary_json) in active_records {
        let (record_kind_value, interrupted_at, summary_json) = match record_kind.as_str() {
            "actor" => {
                let mut actor = decode_json::<ActivityActorSummary>(&summary_json)?;
                actor.normalize_timestamps()?;
                let interrupted_at = max_timestamp(&actor.updated_at, now)?;
                actor.status = ActivityLifecycle::Interrupted;
                actor.updated_at = interrupted_at.clone();
                actor.terminal_at = Some(interrupted_at.clone());
                actor.validate()?;
                (
                    ActivityRecordKind::Actor,
                    interrupted_at,
                    encode_json(&actor)?,
                )
            }
            "workItem" => {
                let mut work_item = decode_json::<ActivityWorkItemSummary>(&summary_json)?;
                work_item.normalize_timestamps()?;
                let interrupted_at = max_timestamp(&work_item.updated_at, now)?;
                work_item.status = ActivityLifecycle::Interrupted;
                work_item.updated_at = interrupted_at.clone();
                work_item.terminal_at = Some(interrupted_at.clone());
                work_item.validate()?;
                (
                    ActivityRecordKind::WorkItem,
                    interrupted_at,
                    encode_json(&work_item)?,
                )
            }
            _ => {
                return Err(ActivityRepositoryError::InvalidScope(
                    "persisted record kind is invalid".to_owned(),
                ));
            }
        };
        transaction
            .execute(
                "UPDATE activity_records
                 SET status = 'interrupted',
                     native_sort_key = ?,
                     summary_json = ?,
                     updated_at = ?,
                     terminal_at = ?
                 WHERE scope_id = ? AND record_kind = ? AND record_id = ?",
                params![
                    interrupted_at,
                    summary_json,
                    interrupted_at,
                    interrupted_at,
                    scope_id,
                    record_kind,
                    record_id,
                ],
            )
            .map_err(sql_error)?;
        if let Some(reason) = reason {
            append_interruption_entry(
                transaction,
                scope_id,
                record_kind_value,
                &record_id,
                &interrupted_at,
                reason,
                interruption_generation,
            )?;
        }
    }
    Ok(interrupted_count)
}

fn append_interruption_entry(
    transaction: &Transaction<'_>,
    scope_id: &str,
    record_kind: ActivityRecordKind,
    record_id: &str,
    interrupted_at: &str,
    reason: &'static str,
    interruption_generation: Option<u64>,
) -> ActivityRepositoryResult<()> {
    let entry_identity = interruption_generation.map_or_else(
        || format!("{scope_id}\0{}\0{record_id}", record_kind.as_str()),
        |generation| {
            format!(
                "{scope_id}\0{}\0{record_id}\0{generation}",
                record_kind.as_str()
            )
        },
    );
    let entry_id = format!(
        "activity:monitoring-disabled:{}",
        sha256_hex(entry_identity)
    );
    let entry = ActivityEntry::try_new(
        entry_id,
        record_kind,
        record_id,
        ActivityEntryKind::State,
        reason,
        None,
        ActivityEntryTone::Warning,
        interrupted_at,
    )?;
    let inserted = transaction
        .execute(
            "INSERT OR IGNORE INTO activity_entries (
               scope_id, entry_id, owner_kind, owner_id, native_sort_key,
               entry_json, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?)",
            params![
                scope_id,
                entry.id,
                entry.owner_kind.as_str(),
                entry.owner_id,
                entry.created_at,
                encode_json(&entry)?,
                entry.created_at,
            ],
        )
        .map_err(sql_error)?;
    if inserted > 0 {
        transaction
            .execute(
                "INSERT INTO activity_entry_owners (
                   scope_id, owner_kind, owner_id, entry_count
                 ) VALUES (?, ?, ?, 1)
                 ON CONFLICT(scope_id, owner_kind, owner_id)
                 DO UPDATE SET entry_count = entry_count + 1",
                params![scope_id, entry.owner_kind.as_str(), entry.owner_id],
            )
            .map_err(sql_error)?;
    }
    Ok(())
}

fn apply_batch(
    connection: &mut Connection,
    scope_id: &str,
    native_event_key: &str,
    mut mutations: Vec<ProviderActivityMutation>,
    updated_at: &str,
) -> ActivityRepositoryResult<Vec<ActivityDelta>> {
    normalize_activity_mutation_text(&mut mutations);
    let transaction = connection.transaction().map_err(sql_error)?;
    let journal_head_key = journal_event_key(native_event_key, 0);
    let duplicate = transaction
        .query_row(
            "SELECT 1
             FROM activity_event_idempotency
             WHERE scope_id = ? AND native_event_key = ?
             UNION ALL
             SELECT 1
             FROM activity_journal
             WHERE scope_id = ?
               AND event_key_namespace = ? AND native_event_key = ?",
            params![
                scope_id,
                journal_head_key,
                scope_id,
                JOURNAL_EVENT_KEY_NAMESPACE_LEGACY,
                native_event_key,
            ],
            |_| Ok(()),
        )
        .optional()
        .map_err(sql_error)?
        .is_some();
    if duplicate {
        transaction.commit().map_err(sql_error)?;
        return Ok(Vec::new());
    }

    let mut scope = load_current_scope_by_id(&transaction, scope_id)?;
    let initial_scope = scope.clone();
    let initial_counts = calculate_counts(&transaction, scope_id)?;
    let previous_revision = scope.revision;
    let mut changes = Vec::with_capacity(mutations.len());

    for mutation in mutations {
        match mutation {
            ProviderActivityMutation::SetScope {
                capabilities,
                observation_state,
            } => {
                validate_capabilities(&capabilities)?;
                if scope.capabilities != capabilities
                    || scope.observation_state != observation_state
                {
                    scope.capabilities = capabilities;
                    scope.observation_state = observation_state;
                }
            }
            ProviderActivityMutation::SetSectionHealth { section, health } => {
                health.validate()?;
                if scope.sections.get(section) != &health {
                    scope.sections.set(section, health);
                }
            }
            ProviderActivityMutation::UpsertActor(mut actor) => {
                if !scope.capabilities.actors {
                    return Err(ActivityRepositoryError::InvalidCapabilities(
                        "actor mutation requires actors capability".to_owned(),
                    ));
                }
                let existing = load_actor(&transaction, scope_id, &actor.id)?;
                if actor.name.is_empty() {
                    let mut current = existing.clone().ok_or_else(|| {
                        ActivityRepositoryError::InvalidReference(actor.id.clone())
                    })?;
                    current.status = actor.status;
                    current.updated_at = updated_at.to_owned();
                    current.terminal_at = actor.status.is_terminal().then(|| updated_at.to_owned());
                    actor = current;
                } else {
                    actor.fill_batch_timestamp(updated_at);
                }
                actor.normalize_timestamps()?;
                if should_ignore_late_terminal(existing.as_ref(), actor.status, &actor.updated_at)?
                {
                    continue;
                }
                actor.validate()?;
                validate_actor_parent(&transaction, scope_id, &actor)?;
                if existing.as_ref() == Some(&actor) {
                    continue;
                }
                upsert_actor(&transaction, scope_id, &actor)?;
                if existing.is_none() {
                    adjust_record_retention_count(&transaction, scope_id, 1)?;
                }
                changes.push(ActivityChange::ActorUpserted { actor });
            }
            ProviderActivityMutation::RemoveActor { actor_id } => {
                validate_text(actor_id.clone(), "actor id", ACTIVITY_ID_MAX_LENGTH, true)?;
                validate_actor_deletion(&transaction, scope_id, &actor_id)?;
                let removed = transaction
                    .execute(
                        "DELETE FROM activity_records
                         WHERE scope_id = ? AND record_kind = 'actor' AND record_id = ?",
                        params![scope_id, actor_id],
                    )
                    .map_err(sql_error)?;
                if removed > 0 {
                    adjust_record_retention_count(&transaction, scope_id, -1)?;
                    changes.push(ActivityChange::ActorRemoved { actor_id });
                }
            }
            ProviderActivityMutation::UpsertWorkItem(mut work_item) => {
                if !scope.capabilities.background_work {
                    return Err(ActivityRepositoryError::InvalidCapabilities(
                        "work-item mutation requires backgroundWork capability".to_owned(),
                    ));
                }
                work_item.fill_batch_timestamp(updated_at);
                work_item.normalize_timestamps()?;
                work_item.validate()?;
                validate_work_item_owner(&transaction, scope_id, &work_item)?;
                let existing = load_work_item(&transaction, scope_id, &work_item.id)?;
                if should_ignore_late_terminal(
                    existing.as_ref(),
                    work_item.status,
                    &work_item.updated_at,
                )? {
                    continue;
                }
                if existing.as_ref() == Some(&work_item) {
                    continue;
                }
                upsert_work_item(&transaction, scope_id, &work_item)?;
                if existing.is_none() {
                    adjust_record_retention_count(&transaction, scope_id, 1)?;
                }
                changes.push(ActivityChange::WorkItemUpserted { work_item });
            }
            ProviderActivityMutation::RemoveWorkItem { work_item_id } => {
                validate_text(
                    work_item_id.clone(),
                    "work item id",
                    ACTIVITY_ID_MAX_LENGTH,
                    true,
                )?;
                validate_work_item_deletion(&transaction, scope_id, &work_item_id)?;
                let removed = transaction
                    .execute(
                        "DELETE FROM activity_records
                         WHERE scope_id = ? AND record_kind = 'workItem' AND record_id = ?",
                        params![scope_id, work_item_id],
                    )
                    .map_err(sql_error)?;
                if removed > 0 {
                    adjust_record_retention_count(&transaction, scope_id, -1)?;
                    changes.push(ActivityChange::WorkItemRemoved { work_item_id });
                }
            }
            ProviderActivityMutation::AppendEntry(mut entry) => {
                if !scope.capabilities.attributed_activity {
                    return Err(ActivityRepositoryError::InvalidCapabilities(
                        "entry mutation requires attributedActivity capability".to_owned(),
                    ));
                }
                entry.normalize_timestamp()?;
                entry.validate()?;
                validate_entry_owner(&transaction, scope_id, &entry)?;
                let inserted = transaction
                    .execute(
                        "INSERT OR IGNORE INTO activity_entries (
                           scope_id, entry_id, owner_kind, owner_id, native_sort_key,
                           entry_json, created_at
                         ) VALUES (?, ?, ?, ?, ?, ?, ?)",
                        params![
                            scope_id,
                            entry.id,
                            entry.owner_kind.as_str(),
                            entry.owner_id,
                            entry.created_at,
                            encode_json(&entry)?,
                            entry.created_at,
                        ],
                    )
                    .map_err(sql_error)?;
                if inserted > 0 {
                    transaction
                        .execute(
                            "INSERT INTO activity_entry_owners (
                               scope_id, owner_kind, owner_id, entry_count
                             ) VALUES (?, ?, ?, 1)
                             ON CONFLICT(scope_id, owner_kind, owner_id)
                             DO UPDATE SET entry_count = entry_count + 1",
                            params![scope_id, entry.owner_kind.as_str(), entry.owner_id],
                        )
                        .map_err(sql_error)?;
                    changes.push(ActivityChange::EntryAppended { entry });
                }
            }
        }
    }

    let mut retention_budget = RetentionWorkBudget::new();
    let pruned = prune_retained_records(&transaction, scope_id, &mut retention_budget)?;
    for pruned_entries in pruned.entries {
        changes.retain(|change| {
            !matches!(
                change,
                ActivityChange::EntryAppended { entry }
                    if entry.owner_kind == pruned_entries.owner_kind
                        && entry.owner_id == pruned_entries.owner_id
            )
        });
        changes.push(ActivityChange::EntriesReplaced {
            owner_kind: pruned_entries.owner_kind,
            owner_id: pruned_entries.owner_id,
        });
    }
    for pruned in pruned.records {
        changes.retain(|change| {
            !matches!(
                change,
                ActivityChange::EntriesReplaced { owner_kind, owner_id }
                    if *owner_kind == pruned.record_kind && owner_id == &pruned.record_id
            )
        });
        changes.retain(|change| match change {
            ActivityChange::ActorUpserted { actor } => {
                !(pruned.record_kind == ActivityRecordKind::Actor && actor.id == pruned.record_id)
            }
            ActivityChange::WorkItemUpserted { work_item } => {
                !(pruned.record_kind == ActivityRecordKind::WorkItem
                    && work_item.id == pruned.record_id)
            }
            _ => true,
        });
        changes.push(match pruned.record_kind {
            ActivityRecordKind::Actor => ActivityChange::ActorRemoved {
                actor_id: pruned.record_id,
            },
            ActivityRecordKind::WorkItem => ActivityChange::WorkItemRemoved {
                work_item_id: pruned.record_id,
            },
        });
    }

    validate_scope_invariants(&transaction, &scope)?;
    let counts = calculate_counts(&transaction, scope_id)?;
    let effective_scope_change = scope.capabilities != initial_scope.capabilities
        || scope.observation_state != initial_scope.observation_state
        || scope.sections != initial_scope.sections
        || counts != initial_counts;
    if effective_scope_change {
        changes.insert(
            0,
            ActivityChange::ScopeUpdated {
                capabilities: scope.capabilities.clone(),
                observation_state: scope.observation_state,
                sections: scope.sections.clone(),
                counts: counts.clone(),
            },
        );
    }
    if changes.is_empty() {
        prune_journal(&transaction, scope_id, &mut retention_budget)?;
        prune_event_idempotency(&transaction, scope_id, &mut retention_budget)?;
        transaction.commit().map_err(sql_error)?;
        return Ok(Vec::new());
    }

    let mut deltas = Vec::with_capacity(changes.len().div_ceil(ACTIVITY_DELTA_MAX_CHANGES));
    let mut revision = previous_revision;
    for (chunk_index, chunk) in changes.chunks(ACTIVITY_DELTA_MAX_CHANGES).enumerate() {
        let next_revision = revision
            .checked_add(1)
            .ok_or_else(|| ActivityRepositoryError::InvalidScope("revision overflow".to_owned()))?;
        let sqlite_revision = i64::try_from(next_revision)
            .map_err(|_| ActivityRepositoryError::InvalidScope("revision overflow".to_owned()))?;
        let delta = ActivityDelta {
            scope_id: scope_id.to_owned(),
            previous_revision: revision,
            revision: next_revision,
            changes: chunk.to_vec(),
            updated_at: updated_at.to_owned(),
        };
        delta.validate()?;
        transaction
            .execute(
                "INSERT INTO activity_journal (
                   scope_id, revision, event_key_namespace, native_event_key, delta_json, created_at
                 ) VALUES (?, ?, ?, ?, ?, ?)",
                params![
                    scope_id,
                    sqlite_revision,
                    JOURNAL_EVENT_KEY_NAMESPACE_CANONICAL,
                    journal_event_key(native_event_key, chunk_index),
                    encode_json(&delta)?,
                    updated_at,
                ],
            )
            .map_err(sql_error)?;
        revision = next_revision;
        deltas.push(delta);
    }
    let event_revision = deltas
        .first()
        .map(|delta| i64::try_from(delta.revision))
        .transpose()
        .map_err(|_| ActivityRepositoryError::InvalidScope("revision overflow".to_owned()))?
        .ok_or_else(|| {
            ActivityRepositoryError::InvalidScope("event revision is missing".to_owned())
        })?;
    transaction
        .execute(
            "INSERT INTO activity_event_idempotency (
               scope_id, native_event_key, revision, created_at
             ) VALUES (?, ?, ?, ?)",
            params![scope_id, journal_head_key, event_revision, updated_at],
        )
        .map_err(sql_error)?;
    let sqlite_revision = i64::try_from(revision)
        .map_err(|_| ActivityRepositoryError::InvalidScope("revision overflow".to_owned()))?;
    transaction
        .execute(
            "UPDATE activity_scopes
             SET capabilities_json = ?, observation_state = ?, section_health_json = ?,
                 revision = ?, updated_at = ?
             WHERE scope_id = ?",
            params![
                encode_json(&scope.capabilities)?,
                scope.observation_state.as_str(),
                encode_json(&scope.sections)?,
                sqlite_revision,
                updated_at,
                scope_id,
            ],
        )
        .map_err(sql_error)?;
    prune_journal(&transaction, scope_id, &mut retention_budget)?;
    prune_event_idempotency(&transaction, scope_id, &mut retention_budget)?;
    transaction.commit().map_err(sql_error)?;
    Ok(deltas)
}

fn prune_retained_records(
    transaction: &Transaction<'_>,
    scope_id: &str,
    budget: &mut RetentionWorkBudget,
) -> ActivityRepositoryResult<RetentionPruneResult> {
    let mut pruned = Vec::new();
    let mut pruned_entries = Vec::new();
    let completed_retention_cutoff = completed_retention_cutoff(transaction)?;
    for retain_fresh_completed in [false, true] {
        if !budget.has_remaining() {
            break;
        }
        let retained_record_count = record_retention_count(transaction, scope_id)?;
        let excess_records =
            (retained_record_count - ACTIVITY_RETENTION_V1_SUMMARY_RECORDS_PER_SCOPE).max(0);
        if retain_fresh_completed && excess_records == 0 {
            break;
        }
        let prune_limit = if retain_fresh_completed {
            ACTIVITY_RETENTION_PRUNE_ROWS_PER_TRANSACTION.min(excess_records)
        } else {
            ACTIVITY_RETENTION_PRUNE_ROWS_PER_TRANSACTION
        };
        if prune_limit == 0 {
            break;
        }
        let candidates = load_retention_record_candidates(
            transaction,
            scope_id,
            &completed_retention_cutoff,
            retain_fresh_completed,
            prune_limit,
        )?;
        if candidates.is_empty() {
            if retain_fresh_completed {
                break;
            }
            continue;
        }

        for candidate in candidates {
            if candidate.entry_count > ACTIVITY_RETENTION_V1_ENTRIES_PER_RECORD {
                if let Some(entries) = prune_owner_excess_entries(
                    transaction,
                    scope_id,
                    &candidate.record_kind,
                    &candidate.record_id,
                    candidate.entry_count,
                    budget,
                )? {
                    pruned_entries.push(entries);
                }
                break;
            }
            if !budget.consume_record_group(candidate.entry_count.saturating_add(1)) {
                break;
            }
            let record_kind = match candidate.record_kind.as_str() {
                "actor" => ActivityRecordKind::Actor,
                "workItem" => ActivityRecordKind::WorkItem,
                _ => {
                    return Err(ActivityRepositoryError::InvalidScope(
                        "activity record has an invalid kind".to_owned(),
                    ));
                }
            };
            transaction
                .execute(
                    "DELETE FROM activity_entries
                         WHERE scope_id = ? AND owner_kind = ? AND owner_id = ?",
                    params![scope_id, record_kind.as_str(), candidate.record_id],
                )
                .map_err(sql_error)?;
            transaction
                .execute(
                    "DELETE FROM activity_entry_owners
                     WHERE scope_id = ? AND owner_kind = ? AND owner_id = ?",
                    params![scope_id, record_kind.as_str(), candidate.record_id],
                )
                .map_err(sql_error)?;
            let deleted = transaction
                .execute(
                    "DELETE FROM activity_records
                         WHERE scope_id = ? AND record_kind = ? AND record_id = ?",
                    params![scope_id, record_kind.as_str(), candidate.record_id],
                )
                .map_err(sql_error)?;
            if deleted == 1 {
                adjust_record_retention_count(transaction, scope_id, -1)?;
                pruned.push(PrunedRecord {
                    record_kind,
                    record_id: candidate.record_id,
                });
            }
        }
    }
    pruned_entries.extend(prune_excess_entries(transaction, scope_id, budget)?);
    Ok(RetentionPruneResult {
        records: pruned,
        entries: pruned_entries,
    })
}

fn completed_retention_cutoff(connection: &Connection) -> ActivityRepositoryResult<String> {
    // Activity timestamps are normalized to nine fractional UTC digits. SQLite
    // exposes milliseconds through `%f`, so pad the remaining six digits to keep
    // the cutoff in the same lexicographically sortable canonical representation.
    connection
        .query_row(
            "SELECT strftime('%Y-%m-%dT%H:%M:%f000000Z', 'now', ?)",
            [format!(
                "-{} days",
                ACTIVITY_RETENTION_V1_COMPLETED_AGE_DAYS
            )],
            |row| row.get::<_, String>(0),
        )
        .map_err(sql_error)
}

fn retention_record_candidates_query(retain_fresh_completed: bool) -> String {
    // Comparing the canonical timestamp directly preserves chronological order
    // while allowing the retention index to range-bound `terminal_at`.
    let age_predicate = if retain_fresh_completed {
        ""
    } else {
        "AND terminal_at < ?2"
    };
    format!(
        "SELECT record_kind, record_id,
                COALESCE((
                  SELECT entry_count FROM activity_entry_owners AS owner
                  WHERE owner.scope_id = record.scope_id
                    AND owner.owner_kind = record.record_kind
                    AND owner.owner_id = record.record_id
                ), 0)
         FROM activity_records AS record
         WHERE scope_id = ?1
           AND status IN ('completed', 'failed', 'cancelled', 'interrupted')
           {age_predicate}
           AND NOT EXISTS(
             SELECT 1
             FROM activity_records AS dependent
             WHERE dependent.scope_id = record.scope_id
               AND record.record_kind = 'actor'
               AND (
                 (dependent.record_kind = 'actor'
                   AND dependent.parent_actor_id = record.record_id)
                 OR (dependent.record_kind = 'workItem'
                   AND dependent.owner_actor_id = record.record_id)
               )
           )
         ORDER BY terminal_at ASC, updated_at ASC, record_kind ASC, record_id ASC
         LIMIT ?3"
    )
}

fn load_retention_record_candidates(
    connection: &Connection,
    scope_id: &str,
    completed_retention_cutoff: &str,
    retain_fresh_completed: bool,
    limit: i64,
) -> ActivityRepositoryResult<Vec<RetentionRecordCandidate>> {
    let query = retention_record_candidates_query(retain_fresh_completed);
    let mut statement = connection.prepare(&query).map_err(sql_error)?;
    statement
        .query_map(
            params![scope_id, completed_retention_cutoff, limit],
            |row| {
                Ok(RetentionRecordCandidate {
                    record_kind: row.get(0)?,
                    record_id: row.get(1)?,
                    entry_count: row.get(2)?,
                })
            },
        )
        .map_err(sql_error)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(sql_error)
}

fn record_retention_count(
    connection: &Connection,
    scope_id: &str,
) -> ActivityRepositoryResult<i64> {
    connection
        .query_row(
            "SELECT record_count FROM activity_record_retention_counts WHERE scope_id = ?",
            [scope_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(sql_error)
        .map(Option::unwrap_or_default)
}

fn record_retention_counts_available(connection: &Connection) -> ActivityRepositoryResult<bool> {
    connection
        .query_row(
            "SELECT 1 FROM sqlite_master
             WHERE type = 'table' AND name = 'activity_record_retention_counts'",
            [],
            |_| Ok(()),
        )
        .optional()
        .map_err(sql_error)
        .map(|row| row.is_some())
}

fn adjust_record_retention_count(
    transaction: &Transaction<'_>,
    scope_id: &str,
    delta: i64,
) -> ActivityRepositoryResult<()> {
    let updated = transaction
        .execute(
            "UPDATE activity_record_retention_counts
             SET record_count = record_count + ?
             WHERE scope_id = ?",
            params![delta, scope_id],
        )
        .map_err(sql_error)?;
    if updated == 0 {
        if delta < 0 {
            return Err(ActivityRepositoryError::InvalidScope(
                "activity record retention count is stale".to_owned(),
            ));
        }
        transaction
            .execute(
                "INSERT INTO activity_record_retention_counts (scope_id, record_count)
                 VALUES (?, ?)",
                params![scope_id, delta],
            )
            .map_err(sql_error)?;
    }
    Ok(())
}

fn prune_excess_entries(
    transaction: &Transaction<'_>,
    scope_id: &str,
    budget: &mut RetentionWorkBudget,
) -> ActivityRepositoryResult<Vec<PrunedEntries>> {
    if !budget.has_remaining() {
        return Ok(Vec::new());
    }
    let mut pruned = Vec::new();
    while budget.has_remaining() {
        let owner = transaction
            .query_row(
                "SELECT owner_kind, owner_id, entry_count
                 FROM activity_entry_owners
                 WHERE scope_id = ? AND entry_count > ?
                 ORDER BY entry_count DESC, owner_kind ASC, owner_id ASC
                 LIMIT 1",
                params![scope_id, ACTIVITY_RETENTION_V1_ENTRIES_PER_RECORD],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                },
            )
            .optional()
            .map_err(sql_error)?;
        let Some((owner_kind, owner_id, entry_count)) = owner else {
            break;
        };
        let Some(entries) = prune_owner_excess_entries(
            transaction,
            scope_id,
            &owner_kind,
            &owner_id,
            entry_count,
            budget,
        )?
        else {
            break;
        };
        pruned.push(entries);
    }
    Ok(pruned)
}

fn prune_owner_excess_entries(
    transaction: &Transaction<'_>,
    scope_id: &str,
    owner_kind: &str,
    owner_id: &str,
    entry_count: i64,
    budget: &mut RetentionWorkBudget,
) -> ActivityRepositoryResult<Option<PrunedEntries>> {
    let owner_kind = match owner_kind {
        "actor" => ActivityRecordKind::Actor,
        "workItem" => ActivityRecordKind::WorkItem,
        _ => {
            return Err(ActivityRepositoryError::InvalidScope(
                "activity entry has an invalid owner kind".to_owned(),
            ));
        }
    };
    let delete_limit =
        budget.limit(entry_count.saturating_sub(ACTIVITY_RETENTION_V1_ENTRIES_PER_RECORD));
    if delete_limit == 0 {
        return Ok(None);
    }
    let deleted = transaction
        .execute(
            "DELETE FROM activity_entries
             WHERE rowid IN (
               SELECT rowid FROM activity_entries
               WHERE scope_id = ? AND owner_kind = ? AND owner_id = ?
               ORDER BY created_at ASC, entry_id ASC
               LIMIT ?
             )",
            params![scope_id, owner_kind.as_str(), owner_id, delete_limit],
        )
        .map_err(sql_error)?;
    if deleted == 0 {
        return Err(ActivityRepositoryError::InvalidScope(
            "activity entry retention owner count is stale".to_owned(),
        ));
    }
    let deleted = i64::try_from(deleted).map_err(|_| {
        ActivityRepositoryError::InvalidScope("activity retention delete overflow".to_owned())
    })?;
    transaction
        .execute(
            "UPDATE activity_entry_owners
             SET entry_count = entry_count - ?
             WHERE scope_id = ? AND owner_kind = ? AND owner_id = ?",
            params![deleted, scope_id, owner_kind.as_str(), owner_id],
        )
        .map_err(sql_error)?;
    budget.consume(deleted);
    Ok(Some(PrunedEntries {
        owner_kind,
        owner_id: owner_id.to_owned(),
    }))
}

fn prune_journal(
    transaction: &Transaction<'_>,
    scope_id: &str,
    budget: &mut RetentionWorkBudget,
) -> ActivityRepositoryResult<()> {
    let journal_rows = transaction
        .query_row(
            "SELECT COUNT(*) FROM activity_journal WHERE scope_id = ?",
            [scope_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(sql_error)?;
    let excess_rows = (journal_rows - ACTIVITY_RETENTION_V1_JOURNAL_ROWS_PER_SCOPE).max(0);
    let delete_limit = budget.limit(excess_rows);
    if delete_limit == 0 {
        return Ok(());
    }
    transaction
        .execute(
            "DELETE FROM activity_journal
             WHERE rowid IN (
               SELECT rowid
               FROM activity_journal
               WHERE scope_id = ?
               ORDER BY revision ASC
               LIMIT ?
             )",
            params![scope_id, delete_limit],
        )
        .map_err(sql_error)?;
    budget.consume(delete_limit);
    Ok(())
}

fn prune_event_idempotency(
    transaction: &Transaction<'_>,
    scope_id: &str,
    budget: &mut RetentionWorkBudget,
) -> ActivityRepositoryResult<()> {
    let retained_events = transaction
        .query_row(
            "SELECT COUNT(*) FROM activity_event_idempotency WHERE scope_id = ?",
            [scope_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(sql_error)?;
    let excess_events = (retained_events - ACTIVITY_RETENTION_V1_JOURNAL_ROWS_PER_SCOPE).max(0);
    let delete_limit = budget.limit(excess_events);
    if delete_limit == 0 {
        return Ok(());
    }
    transaction
        .execute(
            "DELETE FROM activity_event_idempotency
             WHERE rowid IN (
               SELECT rowid
               FROM activity_event_idempotency
               WHERE scope_id = ?
               ORDER BY revision ASC
               LIMIT ?
             )",
            params![scope_id, delete_limit],
        )
        .map_err(sql_error)?;
    budget.consume(delete_limit);
    Ok(())
}

fn retention_pending(connection: &Connection, scope_id: &str) -> ActivityRepositoryResult<bool> {
    load_current_scope_by_id(connection, scope_id)?;
    let excess_entries = connection
        .query_row(
            "SELECT EXISTS(
               SELECT 1 FROM activity_entry_owners
               WHERE scope_id = ? AND entry_count > ?
             )",
            params![scope_id, ACTIVITY_RETENTION_V1_ENTRIES_PER_RECORD],
            |row| row.get::<_, bool>(0),
        )
        .map_err(sql_error)?;
    if excess_entries {
        return Ok(true);
    }
    let excess_records = record_retention_count(connection, scope_id)?
        > ACTIVITY_RETENTION_V1_SUMMARY_RECORDS_PER_SCOPE;
    let completed_retention_cutoff = completed_retention_cutoff(connection)?;
    let prunable_records = !load_retention_record_candidates(
        connection,
        scope_id,
        &completed_retention_cutoff,
        excess_records,
        1,
    )?
    .is_empty();
    if prunable_records {
        return Ok(true);
    }
    let excess_journal = connection
        .query_row(
            "SELECT COUNT(*) > ? FROM activity_journal WHERE scope_id = ?",
            params![ACTIVITY_RETENTION_V1_JOURNAL_ROWS_PER_SCOPE, scope_id],
            |row| row.get::<_, bool>(0),
        )
        .map_err(sql_error)?;
    if excess_journal {
        return Ok(true);
    }
    connection
        .query_row(
            "SELECT COUNT(*) > ? FROM activity_event_idempotency WHERE scope_id = ?",
            params![ACTIVITY_RETENTION_V1_JOURNAL_ROWS_PER_SCOPE, scope_id],
            |row| row.get::<_, bool>(0),
        )
        .map_err(sql_error)
}

fn normalize_activity_mutation_text(mutations: &mut [ProviderActivityMutation]) {
    for mutation in mutations {
        match mutation {
            ProviderActivityMutation::SetSectionHealth { health, .. } => {
                normalize_optional_activity_text(&mut health.message, ACTIVITY_SUMMARY_MAX_LENGTH);
            }
            ProviderActivityMutation::UpsertActor(actor) => {
                actor.name = normalize_activity_text(&actor.name, ACTIVITY_LABEL_MAX_LENGTH);
                normalize_optional_activity_text(&mut actor.role, ACTIVITY_LABEL_MAX_LENGTH);
                normalize_optional_activity_text(
                    &mut actor.provider_type,
                    ACTIVITY_LABEL_MAX_LENGTH,
                );
                normalize_optional_activity_text(&mut actor.summary, ACTIVITY_SUMMARY_MAX_LENGTH);
            }
            ProviderActivityMutation::UpsertWorkItem(work_item) => {
                work_item.name =
                    normalize_activity_text(&work_item.name, ACTIVITY_LABEL_MAX_LENGTH);
                work_item.work_kind =
                    normalize_activity_text(&work_item.work_kind, ACTIVITY_LABEL_MAX_LENGTH);
                normalize_optional_activity_text(
                    &mut work_item.command,
                    ACTIVITY_DETAIL_MAX_LENGTH,
                );
                normalize_optional_activity_text(&mut work_item.cwd, ACTIVITY_DETAIL_MAX_LENGTH);
                normalize_optional_activity_text(
                    &mut work_item.summary,
                    ACTIVITY_SUMMARY_MAX_LENGTH,
                );
            }
            ProviderActivityMutation::AppendEntry(entry) => {
                entry.title = normalize_activity_text(&entry.title, ACTIVITY_LABEL_MAX_LENGTH);
                normalize_optional_activity_text(&mut entry.detail, ACTIVITY_DETAIL_MAX_LENGTH);
            }
            ProviderActivityMutation::SetScope { .. }
            | ProviderActivityMutation::RemoveActor { .. }
            | ProviderActivityMutation::RemoveWorkItem { .. } => {}
        }
    }
}

fn normalize_optional_activity_text(value: &mut Option<String>, maximum_utf16_units: usize) {
    if let Some(value) = value {
        *value = normalize_activity_text(value, maximum_utf16_units);
    }
}

fn normalize_activity_text(value: &str, maximum_utf16_units: usize) -> String {
    let bounded = truncate_activity_text(
        value,
        maximum_utf16_units.saturating_add(ACTIVITY_REDACTION_LOOKAHEAD_UTF16_UNITS),
    );
    let redacted = redact_sensitive_text(&redact_activity_secret_markers(&bounded));
    let mut normalized = String::with_capacity(redacted.len().min(maximum_utf16_units));
    let mut utf16_units: usize = 0;
    for character in redacted.chars() {
        let character = match character {
            '\u{1b}' => '␛',
            character if character.is_control() && !matches!(character, '\n' | '\t') => ' ',
            character => character,
        };
        let character_utf16_units = character.len_utf16();
        if utf16_units.saturating_add(character_utf16_units) > maximum_utf16_units {
            break;
        }
        normalized.push(character);
        utf16_units += character_utf16_units;
    }
    normalized
}

fn truncate_activity_text(value: &str, maximum_utf16_units: usize) -> String {
    let mut bounded = String::with_capacity(value.len().min(maximum_utf16_units));
    let mut utf16_units: usize = 0;
    for character in value.chars() {
        let character_utf16_units = character.len_utf16();
        if utf16_units.saturating_add(character_utf16_units) > maximum_utf16_units {
            break;
        }
        bounded.push(character);
        utf16_units += character_utf16_units;
    }
    bounded
}

fn redact_activity_secret_markers(value: &str) -> String {
    value
        .lines()
        .map(redact_activity_secret_line)
        .collect::<Vec<_>>()
        .join("\n")
}

#[derive(Clone, Copy)]
struct RedactionCharacter {
    character: char,
    end: usize,
}

fn redact_activity_secret_line(line: &str) -> String {
    let characters = decode_redaction_characters(line);
    let Some(redaction_end) = find_activity_secret_boundary(&characters) else {
        return line.to_owned();
    };
    format!("{} [REDACTED]", line[..redaction_end].trim_end())
}

fn decode_redaction_characters(value: &str) -> Vec<RedactionCharacter> {
    let bytes = value.as_bytes();
    let mut characters = Vec::with_capacity(value.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'\\' && index + 1 < bytes.len() {
            let escaped_index = index + 1;
            let decoded = match bytes[escaped_index] {
                b'\"' => Some(('\"', escaped_index + 1)),
                b'\\' => Some(('\\', escaped_index + 1)),
                b'/' => Some(('/', escaped_index + 1)),
                b'b' => Some(('\u{0008}', escaped_index + 1)),
                b'f' => Some(('\u{000C}', escaped_index + 1)),
                b'n' => Some(('\n', escaped_index + 1)),
                b'r' => Some(('\r', escaped_index + 1)),
                b't' => Some(('\t', escaped_index + 1)),
                b'u' if escaped_index + 5 < bytes.len() => value
                    .get(escaped_index + 1..escaped_index + 5)
                    .and_then(|hex| u32::from_str_radix(hex, 16).ok())
                    .and_then(char::from_u32)
                    .map(|character| (character, escaped_index + 5)),
                _ => None,
            };
            if let Some((character, end)) = decoded {
                characters.push(RedactionCharacter { character, end });
                index = end;
                continue;
            }
        }
        let character = value[index..]
            .chars()
            .next()
            .expect("byte index must remain on a UTF-8 boundary");
        index += character.len_utf8();
        characters.push(RedactionCharacter {
            character,
            end: index,
        });
    }
    characters
}

fn find_activity_secret_boundary(characters: &[RedactionCharacter]) -> Option<usize> {
    let mut index = 0;
    let mut in_quotes = false;
    while index < characters.len() {
        if characters[index].character == '"' {
            if !in_quotes
                && let Some((key, key_end)) = quoted_redaction_key(characters, index)
                && let Some(redaction_end) = secret_assignment_boundary(characters, key_end, &key)
            {
                return Some(redaction_end);
            }
            in_quotes = !in_quotes;
            index += 1;
            continue;
        }
        if !in_quotes && is_redaction_key_character(characters[index].character) {
            let start = index;
            index += 1;
            while index < characters.len()
                && is_redaction_key_character(characters[index].character)
            {
                index += 1;
            }
            let key = characters[start..index]
                .iter()
                .map(|character| character.character)
                .collect::<String>();
            if let Some(redaction_end) = secret_assignment_boundary(characters, index, &key) {
                return Some(redaction_end);
            }
            if normalize_redaction_key(&key) == "bearer" {
                let value_start = skip_redaction_whitespace(characters, index);
                if value_start > index && value_start < characters.len() {
                    return Some(characters[value_start - 1].end);
                }
            }
            continue;
        }
        index += 1;
    }
    None
}

fn quoted_redaction_key(
    characters: &[RedactionCharacter],
    quote_start: usize,
) -> Option<(String, usize)> {
    let mut index = quote_start + 1;
    while index < characters.len() && characters[index].character != '"' {
        index += 1;
    }
    (index < characters.len()).then(|| {
        (
            characters[quote_start + 1..index]
                .iter()
                .map(|character| character.character)
                .collect(),
            index + 1,
        )
    })
}

fn secret_assignment_boundary(
    characters: &[RedactionCharacter],
    key_end: usize,
    key: &str,
) -> Option<usize> {
    if !is_sensitive_activity_key(key) {
        return None;
    }
    let separator = skip_redaction_whitespace(characters, key_end);
    if separator >= characters.len() || !matches!(characters[separator].character, ':' | '=') {
        return None;
    }
    let value_start = skip_redaction_whitespace(characters, separator + 1);
    Some(if value_start == separator + 1 {
        characters[separator].end
    } else {
        characters[value_start - 1].end
    })
}

fn skip_redaction_whitespace(characters: &[RedactionCharacter], mut index: usize) -> usize {
    while index < characters.len() && characters[index].character.is_whitespace() {
        index += 1;
    }
    index
}

fn is_redaction_key_character(character: char) -> bool {
    character.is_ascii_alphanumeric() || matches!(character, '_' | '-')
}

fn is_sensitive_activity_key(key: &str) -> bool {
    let normalized = normalize_redaction_key(key);
    matches!(
        normalized.as_str(),
        "authorization"
            | "proxyauthorization"
            | "cookie"
            | "setcookie"
            | "xapikey"
            | "apikey"
            | "token"
            | "accesstoken"
            | "refreshtoken"
            | "githubtoken"
            | "password"
            | "secret"
            | "awsaccesskeyid"
            | "awssecretaccesskey"
            | "awssessiontoken"
            | "awssecuritytoken"
            | "azureclientsecret"
            | "azureclientid"
            | "azuretenantid"
            | "openaiapikey"
            | "anthropicapikey"
            | "ghtoken"
    )
}

fn normalize_redaction_key(key: &str) -> String {
    key.chars()
        .filter(char::is_ascii_alphanumeric)
        .flat_map(char::to_lowercase)
        .collect()
}

fn journal_event_key(native_event_key: &str, chunk_index: usize) -> String {
    let digest = sha256_hex(format!(
        "activity-journal-v2\0{native_event_key}\0{chunk_index}"
    ));
    format!("activity:v2:{digest}")
}

fn snapshot(
    connection: &Connection,
    scope_ref: &ActivityScopeRef,
) -> ActivityRepositoryResult<ActivitySnapshot> {
    let scope = load_current_scope(connection, scope_ref)?;
    let counts = calculate_counts(connection, &scope.scope_id)?;
    let (actors, actors_has_more) =
        load_snapshot_records(connection, &scope.scope_id, ActivityRecordKind::Actor)?;
    let (work_items, work_items_has_more) =
        load_snapshot_records(connection, &scope.scope_id, ActivityRecordKind::WorkItem)?;
    Ok(ActivitySnapshot {
        protocol_version: 1,
        scope_id: scope.scope_id,
        scope: scope.scope,
        revision: scope.revision,
        provider: scope.provider,
        provider_instance_id: scope.provider_instance_id,
        capabilities: scope.capabilities,
        observation_state: scope.observation_state,
        sections: scope.sections,
        counts,
        actors: actors
            .into_iter()
            .map(|record| match record {
                ActivityRecordSummary::Actor(actor) => actor,
                ActivityRecordSummary::WorkItem(_) => {
                    unreachable!("actor query returned work item")
                }
            })
            .collect(),
        work_items: work_items
            .into_iter()
            .map(|record| match record {
                ActivityRecordSummary::WorkItem(work_item) => work_item,
                ActivityRecordSummary::Actor(_) => unreachable!("work-item query returned actor"),
            })
            .collect(),
        actors_has_more,
        work_items_has_more,
        updated_at: scope.updated_at,
    })
}

fn list_roster(
    connection: &Connection,
    scope_id: &str,
    section: ActivitySection,
    bucket: ActivityRosterBucket,
    cursor: Option<&RosterCursor>,
    limit: usize,
) -> ActivityRepositoryResult<ActivityRosterPage> {
    let record_kind = match section {
        ActivitySection::Subagents => ActivityRecordKind::Actor,
        ActivitySection::BackgroundTasks => ActivityRecordKind::WorkItem,
    };
    let statuses = match bucket {
        ActivityRosterBucket::Active => ACTIVE_STATUSES,
        ActivityRosterBucket::Done => DONE_STATUSES,
    };
    let fetch_limit = limit.saturating_add(1);
    let mut records = if let Some(cursor) = cursor {
        let updated_at = validate_timestamp(cursor.updated_at.clone(), "cursor updatedAt")
            .map_err(|_| ActivityRepositoryError::InvalidCursor)?;
        let record_id = validate_text(
            cursor.record_id.clone(),
            "cursor recordId",
            ACTIVITY_ID_MAX_LENGTH,
            true,
        )
        .map_err(|_| ActivityRepositoryError::InvalidCursor)?;
        if record_id != cursor.record_id {
            return Err(ActivityRepositoryError::InvalidCursor);
        }
        let mut statement = connection
            .prepare(
                "SELECT summary_json FROM activity_records
                 WHERE scope_id = ? AND record_kind = ?
                   AND status IN (?, ?, ?, ?)
                   AND (updated_at < ? OR (updated_at = ? AND record_id < ?))
                 ORDER BY updated_at DESC, record_id DESC
                 LIMIT ?",
            )
            .map_err(sql_error)?;
        decode_record_rows(
            statement
                .query_map(
                    params![
                        scope_id,
                        record_kind.as_str(),
                        statuses[0],
                        statuses[1],
                        statuses[2],
                        statuses[3],
                        updated_at,
                        updated_at,
                        record_id,
                        fetch_limit as i64,
                    ],
                    |row| row.get::<_, String>(0),
                )
                .map_err(sql_error)?,
        )?
    } else {
        let mut statement = connection
            .prepare(
                "SELECT summary_json FROM activity_records
                 WHERE scope_id = ? AND record_kind = ?
                   AND status IN (?, ?, ?, ?)
                 ORDER BY updated_at DESC, record_id DESC
                 LIMIT ?",
            )
            .map_err(sql_error)?;
        decode_record_rows(
            statement
                .query_map(
                    params![
                        scope_id,
                        record_kind.as_str(),
                        statuses[0],
                        statuses[1],
                        statuses[2],
                        statuses[3],
                        fetch_limit as i64,
                    ],
                    |row| row.get::<_, String>(0),
                )
                .map_err(sql_error)?,
        )?
    };
    let has_more = records.len() > limit;
    records.truncate(limit);
    let next_cursor = if has_more {
        records
            .last()
            .map(record_cursor)
            .transpose()?
            .map(|cursor| encode_cursor(&cursor))
            .transpose()?
    } else {
        None
    };
    Ok(ActivityRosterPage {
        records,
        next_cursor,
    })
}

fn list_detail(
    connection: &Connection,
    scope_id: &str,
    record_kind: ActivityRecordKind,
    record_id: &str,
    cursor: Option<&DetailCursor>,
    limit: usize,
) -> ActivityRepositoryResult<ActivityDetailPage> {
    let record = load_record(connection, scope_id, record_kind, record_id)?
        .ok_or(ActivityRepositoryError::NotFound)?;
    let fetch_limit = limit.saturating_add(1);
    let mut entries: Vec<ActivityEntry> = if let Some(cursor) = cursor {
        let created_at = validate_timestamp(cursor.created_at.clone(), "cursor createdAt")
            .map_err(|_| ActivityRepositoryError::InvalidCursor)?;
        let entry_id = validate_text(
            cursor.entry_id.clone(),
            "cursor entryId",
            ACTIVITY_ID_MAX_LENGTH,
            true,
        )
        .map_err(|_| ActivityRepositoryError::InvalidCursor)?;
        if entry_id != cursor.entry_id {
            return Err(ActivityRepositoryError::InvalidCursor);
        }
        let mut statement = connection
            .prepare(
                "SELECT entry_json FROM activity_entries
                 WHERE scope_id = ? AND owner_kind = ? AND owner_id = ?
                   AND (created_at < ? OR (created_at = ? AND entry_id < ?))
                 ORDER BY created_at DESC, entry_id DESC
                 LIMIT ?",
            )
            .map_err(sql_error)?;
        decode_json_rows(
            statement
                .query_map(
                    params![
                        scope_id,
                        record_kind.as_str(),
                        record_id,
                        created_at,
                        created_at,
                        entry_id,
                        fetch_limit as i64,
                    ],
                    |row| row.get::<_, String>(0),
                )
                .map_err(sql_error)?,
        )?
    } else {
        let mut statement = connection
            .prepare(
                "SELECT entry_json FROM activity_entries
                 WHERE scope_id = ? AND owner_kind = ? AND owner_id = ?
                 ORDER BY created_at DESC, entry_id DESC
                 LIMIT ?",
            )
            .map_err(sql_error)?;
        decode_json_rows(
            statement
                .query_map(
                    params![
                        scope_id,
                        record_kind.as_str(),
                        record_id,
                        fetch_limit as i64
                    ],
                    |row| row.get::<_, String>(0),
                )
                .map_err(sql_error)?,
        )?
    };
    let has_more = entries.len() > limit;
    entries.truncate(limit);
    let next_cursor = if has_more {
        entries
            .last()
            .map(|entry| DetailCursor {
                created_at: entry.created_at.clone(),
                entry_id: entry.id.clone(),
            })
            .map(|cursor| encode_cursor(&cursor))
            .transpose()?
    } else {
        None
    };
    Ok(ActivityDetailPage {
        record,
        entries,
        next_cursor,
    })
}

fn load_paged_scope(
    connection: &Connection,
    requested_scope: &ActivityScopeRef,
    scope_id: &str,
) -> ActivityRepositoryResult<StoredScope> {
    let stored = load_current_scope_by_id(connection, scope_id)?;
    let current = load_current_scope(connection, &stored.scope)?;
    if current.scope_id != scope_id || requested_scope != &stored.scope {
        return Err(ActivityRepositoryError::InvalidScope(
            "scope ID does not match the current requested scope".to_owned(),
        ));
    }
    Ok(stored)
}

fn validate_capabilities(capabilities: &ActivityCapabilities) -> ActivityRepositoryResult<()> {
    capabilities
        .validate()
        .map_err(|error| ActivityRepositoryError::InvalidCapabilities(error.to_string()))
}

fn validate_scope_invariants(
    connection: &Connection,
    scope: &StoredScope,
) -> ActivityRepositoryResult<()> {
    validate_capabilities(&scope.capabilities)?;
    scope.sections.validate()?;
    validate_section_invariant(
        connection,
        scope,
        ActivitySection::Subagents,
        scope.capabilities.actors,
        ActivityRecordKind::Actor,
    )?;
    validate_section_invariant(
        connection,
        scope,
        ActivitySection::BackgroundTasks,
        scope.capabilities.background_work,
        ActivityRecordKind::WorkItem,
    )
}

fn validate_section_invariant(
    connection: &Connection,
    scope: &StoredScope,
    section: ActivitySection,
    negotiated: bool,
    record_kind: ActivityRecordKind,
) -> ActivityRepositoryResult<()> {
    let health = scope.sections.get(section);
    if negotiated && health.state == ActivitySectionObservationState::Unsupported {
        return Err(ActivityRepositoryError::InvalidCapabilities(
            "negotiated section cannot be unsupported".to_owned(),
        ));
    }
    if !negotiated && health.state == ActivitySectionObservationState::Live {
        return Err(ActivityRepositoryError::InvalidCapabilities(
            "unnegotiated section cannot be live".to_owned(),
        ));
    }
    if !negotiated && health.state == ActivitySectionObservationState::Unsupported {
        let count = connection
            .query_row(
                "SELECT COUNT(*) FROM activity_records
                 WHERE scope_id = ? AND record_kind = ?",
                params![scope.scope_id, record_kind.as_str()],
                |row| row.get::<_, i64>(0),
            )
            .map_err(sql_error)?;
        if count > 0 {
            return Err(ActivityRepositoryError::InvalidCapabilities(
                "a section with retained records must be stale rather than unsupported".to_owned(),
            ));
        }
    }
    Ok(())
}

fn validate_actor_parent(
    connection: &Connection,
    scope_id: &str,
    actor: &ActivityActorSummary,
) -> ActivityRepositoryResult<()> {
    let Some(parent_actor_id) = &actor.parent_actor_id else {
        return Ok(());
    };
    let (parent_exists, reaches_actor, stored_cycle, missing_ancestor, budget_exhausted) =
        connection
            .query_row(
                "WITH RECURSIVE ancestry(
               record_id,
               parent_actor_id,
               depth,
               path,
               cycle
             ) AS (
               SELECT record_id,
                      parent_actor_id,
                      1,
                      json_array(record_id),
                      0
               FROM activity_records
               WHERE scope_id = ?1
                 AND record_kind = 'actor'
                 AND record_id = ?2
               UNION ALL
               SELECT parent.record_id,
                      parent.parent_actor_id,
                      ancestry.depth + 1,
                      json_insert(ancestry.path, '$[#]', parent.record_id),
                      EXISTS(
                        SELECT 1
                        FROM json_each(ancestry.path)
                        WHERE value = parent.record_id
                      )
               FROM ancestry
               JOIN activity_records parent
                 ON parent.scope_id = ?1
                AND parent.record_kind = 'actor'
                AND parent.record_id = ancestry.parent_actor_id
               WHERE ancestry.parent_actor_id IS NOT NULL
                 AND ancestry.depth < ?3
                 AND ancestry.cycle = 0
             )
             SELECT EXISTS(SELECT 1 FROM ancestry WHERE depth = 1),
                    EXISTS(SELECT 1 FROM ancestry WHERE record_id = ?4),
                    EXISTS(SELECT 1 FROM ancestry WHERE cycle = 1),
                    EXISTS(
                      SELECT 1
                      FROM ancestry
                      WHERE parent_actor_id IS NOT NULL
                        AND NOT EXISTS(
                          SELECT 1
                          FROM activity_records parent
                          WHERE parent.scope_id = ?1
                            AND parent.record_kind = 'actor'
                            AND parent.record_id = ancestry.parent_actor_id
                        )
                    ),
                    EXISTS(
                      SELECT 1
                      FROM ancestry
                      WHERE depth = ?3 AND parent_actor_id IS NOT NULL
                    )",
                params![
                    scope_id,
                    parent_actor_id,
                    ACTIVITY_LINEAGE_V1_MAX_DEPTH,
                    actor.id
                ],
                |row| {
                    Ok((
                        row.get::<_, bool>(0)?,
                        row.get::<_, bool>(1)?,
                        row.get::<_, bool>(2)?,
                        row.get::<_, bool>(3)?,
                        row.get::<_, bool>(4)?,
                    ))
                },
            )
            .map_err(sql_error)?;
    if parent_exists && !reaches_actor && !stored_cycle && !missing_ancestor && !budget_exhausted {
        return Ok(());
    }
    Err(ActivityRepositoryError::InvalidReference(
        parent_actor_id.clone(),
    ))
}

fn validate_actor_deletion(
    connection: &Connection,
    scope_id: &str,
    actor_id: &str,
) -> ActivityRepositoryResult<()> {
    let has_dependents = connection
        .query_row(
            "SELECT EXISTS(
               SELECT 1 FROM activity_records
               WHERE scope_id = ? AND record_kind = 'actor' AND parent_actor_id = ?
               UNION ALL
               SELECT 1 FROM activity_records
               WHERE scope_id = ? AND record_kind = 'workItem' AND owner_actor_id = ?
               UNION ALL
               SELECT 1 FROM activity_entries
               WHERE scope_id = ? AND owner_kind = 'actor' AND owner_id = ?
             )",
            params![scope_id, actor_id, scope_id, actor_id, scope_id, actor_id],
            |row| row.get::<_, bool>(0),
        )
        .map_err(sql_error)?;
    if has_dependents {
        return Err(ActivityRepositoryError::InvalidReference(
            actor_id.to_owned(),
        ));
    }
    Ok(())
}

fn validate_work_item_deletion(
    connection: &Connection,
    scope_id: &str,
    work_item_id: &str,
) -> ActivityRepositoryResult<()> {
    let has_entries = connection
        .query_row(
            "SELECT EXISTS(
               SELECT 1 FROM activity_entries
               WHERE scope_id = ? AND owner_kind = 'workItem' AND owner_id = ?
             )",
            params![scope_id, work_item_id],
            |row| row.get::<_, bool>(0),
        )
        .map_err(sql_error)?;
    if has_entries {
        return Err(ActivityRepositoryError::InvalidReference(
            work_item_id.to_owned(),
        ));
    }
    Ok(())
}

fn validate_work_item_owner(
    connection: &Connection,
    scope_id: &str,
    work_item: &ActivityWorkItemSummary,
) -> ActivityRepositoryResult<()> {
    if let Some(owner_actor_id) = &work_item.owner_actor_id
        && !record_exists(
            connection,
            scope_id,
            ActivityRecordKind::Actor,
            owner_actor_id,
        )?
    {
        return Err(ActivityRepositoryError::InvalidReference(
            owner_actor_id.clone(),
        ));
    }
    Ok(())
}

fn validate_entry_owner(
    connection: &Connection,
    scope_id: &str,
    entry: &ActivityEntry,
) -> ActivityRepositoryResult<()> {
    if !record_exists(connection, scope_id, entry.owner_kind, &entry.owner_id)? {
        return Err(ActivityRepositoryError::InvalidReference(
            entry.owner_id.clone(),
        ));
    }
    Ok(())
}

fn record_exists(
    connection: &Connection,
    scope_id: &str,
    record_kind: ActivityRecordKind,
    record_id: &str,
) -> ActivityRepositoryResult<bool> {
    Ok(connection
        .query_row(
            "SELECT 1 FROM activity_records
             WHERE scope_id = ? AND record_kind = ? AND record_id = ?",
            params![scope_id, record_kind.as_str(), record_id],
            |_| Ok(()),
        )
        .optional()
        .map_err(sql_error)?
        .is_some())
}

fn should_ignore_late_terminal<T: RecordStatus>(
    existing: Option<&T>,
    incoming_status: ActivityLifecycle,
    incoming_updated_at: &str,
) -> ActivityRepositoryResult<bool> {
    existing
        .map(|existing| {
            Ok(existing.status().is_terminal()
                && !incoming_status.is_terminal()
                && compare_timestamps(incoming_updated_at, existing.updated_at())?.is_lt())
        })
        .transpose()
        .map(Option::unwrap_or_default)
}

trait RecordStatus {
    fn status(&self) -> ActivityLifecycle;
    fn updated_at(&self) -> &str;
}

impl RecordStatus for ActivityActorSummary {
    fn status(&self) -> ActivityLifecycle {
        self.status
    }

    fn updated_at(&self) -> &str {
        &self.updated_at
    }
}

impl RecordStatus for ActivityWorkItemSummary {
    fn status(&self) -> ActivityLifecycle {
        self.status
    }

    fn updated_at(&self) -> &str {
        &self.updated_at
    }
}

fn upsert_actor(
    transaction: &Transaction<'_>,
    scope_id: &str,
    actor: &ActivityActorSummary,
) -> ActivityRepositoryResult<()> {
    transaction
        .execute(
            "INSERT INTO activity_records (
               scope_id, record_kind, record_id, parent_actor_id, owner_actor_id,
               status, native_sort_key, summary_json, started_at, updated_at, terminal_at
             ) VALUES (?, 'actor', ?, ?, NULL, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(scope_id, record_kind, record_id) DO UPDATE SET
               parent_actor_id = excluded.parent_actor_id,
               status = excluded.status,
               native_sort_key = excluded.native_sort_key,
               summary_json = excluded.summary_json,
               started_at = excluded.started_at,
               updated_at = excluded.updated_at,
               terminal_at = excluded.terminal_at",
            params![
                scope_id,
                actor.id,
                actor.parent_actor_id,
                actor.status.as_str(),
                actor.updated_at,
                encode_json(actor)?,
                actor.started_at,
                actor.updated_at,
                actor.terminal_at,
            ],
        )
        .map_err(sql_error)?;
    Ok(())
}

fn upsert_work_item(
    transaction: &Transaction<'_>,
    scope_id: &str,
    work_item: &ActivityWorkItemSummary,
) -> ActivityRepositoryResult<()> {
    transaction
        .execute(
            "INSERT INTO activity_records (
               scope_id, record_kind, record_id, parent_actor_id, owner_actor_id,
               status, native_sort_key, summary_json, started_at, updated_at, terminal_at
             ) VALUES (?, 'workItem', ?, NULL, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(scope_id, record_kind, record_id) DO UPDATE SET
               owner_actor_id = excluded.owner_actor_id,
               status = excluded.status,
               native_sort_key = excluded.native_sort_key,
               summary_json = excluded.summary_json,
               started_at = excluded.started_at,
               updated_at = excluded.updated_at,
               terminal_at = excluded.terminal_at",
            params![
                scope_id,
                work_item.id,
                work_item.owner_actor_id,
                work_item.status.as_str(),
                work_item.updated_at,
                encode_json(work_item)?,
                work_item.started_at,
                work_item.updated_at,
                work_item.terminal_at,
            ],
        )
        .map_err(sql_error)?;
    Ok(())
}

fn load_actor(
    connection: &Connection,
    scope_id: &str,
    actor_id: &str,
) -> ActivityRepositoryResult<Option<ActivityActorSummary>> {
    load_json_record(connection, scope_id, ActivityRecordKind::Actor, actor_id)
}

fn load_work_item(
    connection: &Connection,
    scope_id: &str,
    work_item_id: &str,
) -> ActivityRepositoryResult<Option<ActivityWorkItemSummary>> {
    load_json_record(
        connection,
        scope_id,
        ActivityRecordKind::WorkItem,
        work_item_id,
    )
}

fn load_json_record<T: DeserializeOwned>(
    connection: &Connection,
    scope_id: &str,
    record_kind: ActivityRecordKind,
    record_id: &str,
) -> ActivityRepositoryResult<Option<T>> {
    connection
        .query_row(
            "SELECT summary_json FROM activity_records
             WHERE scope_id = ? AND record_kind = ? AND record_id = ?",
            params![scope_id, record_kind.as_str(), record_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(sql_error)?
        .map(|json| decode_json(&json))
        .transpose()
}

fn load_record(
    connection: &Connection,
    scope_id: &str,
    record_kind: ActivityRecordKind,
    record_id: &str,
) -> ActivityRepositoryResult<Option<ActivityRecordSummary>> {
    let json = connection
        .query_row(
            "SELECT summary_json FROM activity_records
             WHERE scope_id = ? AND record_kind = ? AND record_id = ?",
            params![scope_id, record_kind.as_str(), record_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(sql_error)?;
    json.map(|json| decode_record(&json)).transpose()
}

fn load_current_scope_by_id(
    connection: &Connection,
    scope_id: &str,
) -> ActivityRepositoryResult<StoredScope> {
    connection
        .query_row(
            "SELECT source_kind, thread_id, terminal_id, revision, provider_name,
                    provider_instance_id, capabilities_json, observation_state,
                    section_health_json, updated_at, is_current
             FROM activity_scopes WHERE scope_id = ?",
            [scope_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, String>(9)?,
                    row.get::<_, bool>(10)?,
                ))
            },
        )
        .optional()
        .map_err(sql_error)?
        .ok_or(ActivityRepositoryError::NotFound)
        .and_then(
            |(
                source_kind,
                thread_id,
                terminal_id,
                revision,
                provider,
                provider_instance_id,
                capabilities_json,
                observation_state,
                section_health_json,
                updated_at,
                is_current,
            )| {
                if !is_current {
                    return Err(ActivityRepositoryError::InvalidScope(
                        "scope is no longer current".to_owned(),
                    ));
                }
                let scope = match (source_kind.as_str(), terminal_id) {
                    ("thread", None) => ActivityScopeRef::Thread { thread_id },
                    ("terminal", Some(terminal_id)) => ActivityScopeRef::Terminal {
                        thread_id,
                        terminal_id,
                    },
                    _ => {
                        return Err(ActivityRepositoryError::InvalidScope(
                            "persisted scope discriminator is invalid".to_owned(),
                        ));
                    }
                };
                Ok(StoredScope {
                    scope_id: scope_id.to_owned(),
                    scope,
                    revision: u64::try_from(revision).map_err(|_| {
                        ActivityRepositoryError::InvalidScope(
                            "persisted revision is invalid".to_owned(),
                        )
                    })?,
                    provider,
                    provider_instance_id,
                    capabilities: decode_json(&capabilities_json)?,
                    observation_state: observation_state.parse()?,
                    sections: decode_json(&section_health_json)?,
                    updated_at,
                })
            },
        )
}

fn load_current_scope(
    connection: &Connection,
    scope: &ActivityScopeRef,
) -> ActivityRepositoryResult<StoredScope> {
    let scope_id = match scope {
        ActivityScopeRef::Thread { thread_id } => connection
            .query_row(
                "SELECT scope_id FROM activity_scopes
                 WHERE source_kind = 'thread' AND thread_id = ? AND terminal_id IS NULL
                   AND is_current = 1
                 ORDER BY updated_at DESC LIMIT 1",
                [thread_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(sql_error)?,
        ActivityScopeRef::Terminal {
            thread_id,
            terminal_id,
        } => {
            let scope_id = connection
                .query_row(
                    "SELECT scope_id FROM activity_scopes
                 WHERE source_kind = 'terminal' AND thread_id = ? AND terminal_id = ?
                   AND is_current = 1
                 ORDER BY updated_at DESC LIMIT 1",
                    params![thread_id, terminal_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(sql_error)?;
            if scope_id.is_none() {
                let owned_by_another_thread = connection
                    .query_row(
                        "SELECT 1 FROM activity_scopes
                         WHERE source_kind = 'terminal' AND terminal_id = ?
                           AND thread_id <> ? AND is_current = 1
                         LIMIT 1",
                        params![terminal_id, thread_id],
                        |_| Ok(()),
                    )
                    .optional()
                    .map_err(sql_error)?
                    .is_some();
                if owned_by_another_thread {
                    return Err(ActivityRepositoryError::InvalidScope(
                        "terminal scope belongs to a different thread".to_owned(),
                    ));
                }
            }
            scope_id
        }
    }
    .ok_or(ActivityRepositoryError::NotFound)?;
    load_current_scope_by_id(connection, &scope_id)
}

fn calculate_counts(
    connection: &Connection,
    scope_id: &str,
) -> ActivityRepositoryResult<ActivitySummaryCounts> {
    let mut counts = ActivitySummaryCounts::default();
    let mut statement = connection
        .prepare(
            "SELECT record_kind, status, COUNT(*)
             FROM activity_records
             WHERE scope_id = ?
             GROUP BY record_kind, status",
        )
        .map_err(sql_error)?;
    let rows = statement
        .query_map([scope_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })
        .map_err(sql_error)?;
    let active_statuses = ACTIVE_STATUSES.iter().copied().collect::<HashSet<_>>();
    let done_statuses = DONE_STATUSES.iter().copied().collect::<HashSet<_>>();
    for row in rows {
        let (record_kind, status, count) = row.map_err(sql_error)?;
        let count = u64::try_from(count).map_err(|_| {
            ActivityRepositoryError::InvalidScope("persisted count is invalid".to_owned())
        })?;
        let target = match record_kind.as_str() {
            "actor" => &mut counts.subagents,
            "workItem" => &mut counts.background_tasks,
            _ => {
                return Err(ActivityRepositoryError::InvalidScope(
                    "persisted record kind is invalid".to_owned(),
                ));
            }
        };
        apply_count(target, &status, count, &active_statuses, &done_statuses)?;
    }
    Ok(counts)
}

fn apply_count(
    target: &mut ActivityCounts,
    status: &str,
    count: u64,
    active_statuses: &HashSet<&str>,
    done_statuses: &HashSet<&str>,
) -> ActivityRepositoryResult<()> {
    if active_statuses.contains(status) {
        target.active += count;
    } else if done_statuses.contains(status) {
        target.done += count;
    } else {
        return Err(ActivityRepositoryError::InvalidScope(
            "persisted lifecycle is invalid".to_owned(),
        ));
    }
    Ok(())
}

fn load_snapshot_records(
    connection: &Connection,
    scope_id: &str,
    record_kind: ActivityRecordKind,
) -> ActivityRepositoryResult<(Vec<ActivityRecordSummary>, bool)> {
    let mut statement = connection
        .prepare(
            "SELECT summary_json FROM activity_records
             WHERE scope_id = ? AND record_kind = ?
             ORDER BY
               CASE WHEN status IN ('starting', 'running', 'waiting', 'unknown')
                 THEN 0 ELSE 1 END,
               updated_at DESC, record_id DESC
             LIMIT ?",
        )
        .map_err(sql_error)?;
    let mut records = decode_record_rows(
        statement
            .query_map(
                params![
                    scope_id,
                    record_kind.as_str(),
                    (ACTIVITY_PAGE_MAX_LENGTH + 1) as i64
                ],
                |row| row.get::<_, String>(0),
            )
            .map_err(sql_error)?,
    )?;
    let has_more = records.len() > ACTIVITY_PAGE_MAX_LENGTH;
    records.truncate(ACTIVITY_PAGE_MAX_LENGTH);
    Ok((records, has_more))
}

fn decode_record_rows(
    rows: rusqlite::MappedRows<'_, impl FnMut(&rusqlite::Row<'_>) -> rusqlite::Result<String>>,
) -> ActivityRepositoryResult<Vec<ActivityRecordSummary>> {
    let json_rows = rows
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(sql_error)?;
    json_rows.iter().map(|json| decode_record(json)).collect()
}

fn decode_json_rows<T: DeserializeOwned>(
    rows: rusqlite::MappedRows<'_, impl FnMut(&rusqlite::Row<'_>) -> rusqlite::Result<String>>,
) -> ActivityRepositoryResult<Vec<T>> {
    let json_rows = rows
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(sql_error)?;
    json_rows.iter().map(|json| decode_json(json)).collect()
}

fn decode_record(json: &str) -> ActivityRepositoryResult<ActivityRecordSummary> {
    #[derive(Deserialize)]
    struct Tag {
        #[serde(rename = "_tag")]
        tag: String,
    }
    match decode_json::<Tag>(json)?.tag.as_str() {
        "actor" => Ok(ActivityRecordSummary::Actor(decode_json(json)?)),
        "workItem" => Ok(ActivityRecordSummary::WorkItem(decode_json(json)?)),
        _ => Err(ActivityRepositoryError::InvalidScope(
            "persisted activity record tag is invalid".to_owned(),
        )),
    }
}

fn record_cursor(record: &ActivityRecordSummary) -> ActivityRepositoryResult<RosterCursor> {
    let (updated_at, record_id) = match record {
        ActivityRecordSummary::Actor(actor) => (&actor.updated_at, &actor.id),
        ActivityRecordSummary::WorkItem(work_item) => (&work_item.updated_at, &work_item.id),
    };
    Ok(RosterCursor {
        updated_at: updated_at.clone(),
        record_id: record_id.clone(),
    })
}

fn database_now(connection: &Connection) -> ActivityRepositoryResult<String> {
    let timestamp = connection
        .query_row(&format!("SELECT {NOW_SQL}"), [], |row| {
            row.get::<_, String>(0)
        })
        .map_err(sql_error)?;
    Ok(validate_timestamp(timestamp, "database timestamp")?)
}

fn encode_cursor<T: Serialize>(cursor: &T) -> ActivityRepositoryResult<String> {
    let encoded = URL_SAFE_NO_PAD
        .encode(serde_json::to_vec(cursor).map_err(ActivityRepositoryError::Serialization)?);
    if encoded.len() > ACTIVITY_CURSOR_MAX_LENGTH {
        return Err(ActivityRepositoryError::InvalidCursor);
    }
    Ok(encoded)
}

fn decode_cursor<T: DeserializeOwned>(cursor: &str) -> ActivityRepositoryResult<T> {
    if cursor.is_empty() || cursor.len() > ACTIVITY_CURSOR_MAX_LENGTH || cursor.trim() != cursor {
        return Err(ActivityRepositoryError::InvalidCursor);
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(cursor)
        .map_err(|_| ActivityRepositoryError::InvalidCursor)?;
    serde_json::from_slice(&bytes).map_err(|_| ActivityRepositoryError::InvalidCursor)
}

fn encode_json<T: Serialize>(value: &T) -> ActivityRepositoryResult<String> {
    serde_json::to_string(value).map_err(ActivityRepositoryError::Serialization)
}

fn decode_json<T: DeserializeOwned>(value: &str) -> ActivityRepositoryResult<T> {
    serde_json::from_str(value).map_err(ActivityRepositoryError::Serialization)
}

fn sql_error(error: rusqlite::Error) -> ActivityRepositoryError {
    ActivityRepositoryError::Persistence(PersistenceError::Sql(error))
}

#[cfg(test)]
mod tests {
    use crate::persistence::run_migrations;

    use super::retention_record_candidates_query;

    #[test]
    fn completed_age_candidate_query_range_bounds_terminal_timestamp() -> rusqlite::Result<()> {
        let mut connection = rusqlite::Connection::open_in_memory()?;
        run_migrations(&mut connection, None)?;

        let query = format!(
            "EXPLAIN QUERY PLAN {}",
            retention_record_candidates_query(false)
        );
        let mut statement = connection.prepare(&query)?;
        let plan = statement
            .query_map(
                rusqlite::params!["thread:age-plan", "2026-06-28T00:00:00.000000000Z", 128],
                |row| row.get::<_, String>(3),
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        assert!(
            plan.iter().any(|detail| {
                detail.contains("idx_activity_records_retention_candidates")
                    && detail.contains("terminal_at<?")
            }),
            "age candidate lookup must range-bound canonical terminal timestamps: {plan:?}"
        );
        Ok(())
    }
}
