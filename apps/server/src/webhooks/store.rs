//! The webhook tables (migration 61): endpoints, the durable delivery queue and log, and the
//! dispatcher's positions. Every write that changes more than one row runs in one SQLite
//! transaction, so a restart finds the queue and the positions agreeing.

use std::collections::HashMap;

use rusqlite::{OptionalExtension as _, Row, Transaction, params};

use crate::persistence::{Database, Result};

/// At most this many endpoints per environment.
pub(crate) const MAX_ENDPOINTS: i64 = 20;
/// At most this many deliveries wait to be sent; past it the oldest are abandoned.
pub(crate) const MAX_PENDING: i64 = 10_000;
/// Finished deliveries are kept this long, and at most this many per endpoint.
const KEPT_DAYS: i64 = 7;
const KEPT_PER_ENDPOINT: i64 = 1_000;
/// This many consecutive failed deliveries disable an endpoint.
pub(crate) const FAILURES_TO_DISABLE: i64 = 10;

pub(crate) const PENDING: &str = "pending";
pub(crate) const DELIVERED: &str = "delivered";
pub(crate) const FAILED: &str = "failed";
/// Sent now by `webhooks.sendTest` or `webhooks.redeliver`, outside the dispatcher's queue.
pub(crate) const SENDING: &str = "sending";

/// Why an endpoint is off without a person turning it off.
pub(crate) const DISABLED_FAILURES: &str = "failures";
pub(crate) const DISABLED_CLIENT_REVOKED: &str = "client-revoked";

/// Why a queued delivery was abandoned, as its log shows it.
pub(crate) const ENDPOINT_CHANGED: &str = "endpoint_changed";

/// The dispatcher's positions (`webhook_state` keys).
pub(crate) const FEED_POSITION: &str = "feed";
pub(crate) const FINDINGS_POSITION: &str = "findings";

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Endpoint {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) url: String,
    pub(crate) enabled: bool,
    pub(crate) event_types: Vec<String>,
    pub(crate) project_id: Option<String>,
    pub(crate) paired_session_id: Option<String>,
    pub(crate) consecutive_failures: i64,
    pub(crate) disabled_reason: Option<String>,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
    /// Bumped by every edit that changes where its deliveries go or which events it gets,
    /// and by turning it off or on; each queued delivery is stamped with it.
    pub(crate) revision: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Delivery {
    pub(crate) sequence: i64,
    pub(crate) delivery_id: String,
    pub(crate) endpoint_id: String,
    pub(crate) event_id: String,
    pub(crate) event_type: String,
    pub(crate) body: String,
    pub(crate) state: String,
    pub(crate) attempts: i64,
    pub(crate) next_attempt_ms: i64,
    pub(crate) last_status: Option<i64>,
    pub(crate) last_error: Option<String>,
    pub(crate) latency_ms: Option<i64>,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
    /// The endpoint's revision when this delivery was queued or built.
    pub(crate) endpoint_revision: i64,
}

/// One delivery to queue.
#[derive(Clone, Debug)]
pub(crate) struct NewDelivery {
    pub(crate) delivery_id: String,
    pub(crate) endpoint_id: String,
    pub(crate) event_id: String,
    pub(crate) event_type: String,
    pub(crate) body: String,
    /// The endpoint revision this delivery was chosen or built under. The enqueue drops it
    /// when the endpoint's revision moved since (`None` takes the current one unchecked), and
    /// the row is stamped with it.
    pub(crate) addressed: Option<i64>,
}

/// How an attempt left its delivery.
#[derive(Clone, Debug)]
pub(crate) struct AttemptRecord {
    pub(crate) delivery_id: String,
    pub(crate) status: Option<i64>,
    pub(crate) error: Option<&'static str>,
    pub(crate) latency_ms: i64,
    /// `Some(at)` to try again then; `None` when the delivery is finished.
    pub(crate) retry_at_ms: Option<i64>,
    /// Whether the endpoint's health counts it (a test event does not).
    pub(crate) counts_toward_health: bool,
}

/// What recording an attempt did to its endpoint.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) struct Recorded {
    /// This failure was the tenth in a row, so the endpoint is now disabled.
    pub(crate) disabled_endpoint: bool,
    /// The delivery was no longer pending (abandoned while in flight), so nothing changed.
    pub(crate) stale: bool,
}

#[derive(Debug, thiserror::Error)]
pub(crate) enum StoreError {
    #[error("at most {MAX_ENDPOINTS} webhook endpoints")]
    Limit,
    #[error("no such webhook endpoint")]
    NotFound,
    #[error(transparent)]
    Storage(#[from] crate::persistence::PersistenceError),
}

fn now_iso() -> String {
    crate::mcp::control::now_iso()
}

const ENDPOINT_COLUMNS: &str = "endpoint_id, name, url, enabled, event_types_json, project_id, \
    paired_session_id, consecutive_failures, disabled_reason, created_at, updated_at, revision";
const DELIVERY_COLUMNS: &str = "sequence, delivery_id, endpoint_id, event_id, event_type, body, \
    state, attempts, next_attempt_ms, last_status, last_error, latency_ms, created_at, updated_at, \
    endpoint_revision";

fn decode_endpoint(row: &Row<'_>) -> rusqlite::Result<Endpoint> {
    let event_types: String = row.get(4)?;
    Ok(Endpoint {
        id: row.get(0)?,
        name: row.get(1)?,
        url: row.get(2)?,
        enabled: row.get::<_, i64>(3)? != 0,
        event_types: serde_json::from_str(&event_types).unwrap_or_default(),
        project_id: row.get(5)?,
        paired_session_id: row.get(6)?,
        consecutive_failures: row.get(7)?,
        disabled_reason: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
        revision: row.get(11)?,
    })
}

fn decode_delivery(row: &Row<'_>) -> rusqlite::Result<Delivery> {
    Ok(Delivery {
        sequence: row.get(0)?,
        delivery_id: row.get(1)?,
        endpoint_id: row.get(2)?,
        event_id: row.get(3)?,
        event_type: row.get(4)?,
        body: row.get(5)?,
        state: row.get(6)?,
        attempts: row.get(7)?,
        next_attempt_ms: row.get(8)?,
        last_status: row.get(9)?,
        last_error: row.get(10)?,
        latency_ms: row.get(11)?,
        created_at: row.get(12)?,
        updated_at: row.get(13)?,
        endpoint_revision: row.get(14)?,
    })
}

#[derive(Clone)]
pub(crate) struct Store {
    database: Database,
    max_pending: i64,
}

impl Store {
    pub(crate) fn new(database: Database, max_pending: i64) -> Self {
        Self {
            database,
            max_pending,
        }
    }

    pub(crate) async fn endpoints(&self) -> Result<Vec<Endpoint>> {
        self.database
            .call(|connection| {
                let mut statement = connection.prepare_cached(&format!(
                    "SELECT {ENDPOINT_COLUMNS} FROM webhook_endpoints ORDER BY created_at, endpoint_id"
                ))?;
                Ok(statement
                    .query_map([], decode_endpoint)?
                    .collect::<rusqlite::Result<Vec<_>>>()?)
            })
            .await
    }

    pub(crate) async fn endpoint(&self, id: &str) -> Result<Option<Endpoint>> {
        let id = id.to_owned();
        self.database
            .call(move |connection| {
                Ok(connection
                    .query_row(
                        &format!(
                            "SELECT {ENDPOINT_COLUMNS} FROM webhook_endpoints WHERE endpoint_id = ?1"
                        ),
                        params![id],
                        decode_endpoint,
                    )
                    .optional()?)
            })
            .await
    }

    /// Adds `endpoint`, refusing a 21st.
    pub(crate) async fn insert_endpoint(
        &self,
        endpoint: Endpoint,
    ) -> std::result::Result<(), StoreError> {
        self.database
            .call(move |connection| {
                let transaction = connection.transaction()?;
                let count: i64 = transaction.query_row(
                    "SELECT COUNT(*) FROM webhook_endpoints",
                    [],
                    |row| row.get(0),
                )?;
                if count >= MAX_ENDPOINTS {
                    return Ok(Err(StoreError::Limit));
                }
                transaction.execute(
                    &format!("INSERT INTO webhook_endpoints ({ENDPOINT_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)"),
                    params![
                        endpoint.id,
                        endpoint.name,
                        endpoint.url,
                        i64::from(endpoint.enabled),
                        serde_json::to_string(&endpoint.event_types).unwrap_or_else(|_| "[]".to_owned()),
                        endpoint.project_id,
                        endpoint.paired_session_id,
                        endpoint.consecutive_failures,
                        endpoint.disabled_reason,
                        endpoint.created_at,
                        endpoint.updated_at,
                        endpoint.revision,
                    ],
                )?;
                transaction.commit()?;
                Ok(Ok(()))
            })
            .await?
    }

    /// Replaces an endpoint's editable fields. Turning it off abandons what it has queued;
    /// turning it on clears its failure count and reason.
    pub(crate) async fn update_endpoint(
        &self,
        endpoint: Endpoint,
    ) -> std::result::Result<(), StoreError> {
        self.database
            .call(move |connection| {
                let transaction = connection.transaction()?;
                let before: Option<(i64, String, Option<String>, String)> = transaction
                    .query_row(
                        "SELECT enabled, url, project_id, event_types_json FROM webhook_endpoints WHERE endpoint_id = ?1",
                        params![endpoint.id],
                        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                    )
                    .optional()?;
                let Some((was_enabled, url, project_id, event_types)) = before else {
                    return Ok(Err(StoreError::NotFound));
                };
                let event_types_json =
                    serde_json::to_string(&endpoint.event_types).unwrap_or_else(|_| "[]".to_owned());
                // Queued deliveries were addressed to the old URL and chosen by the old
                // filters: none of them goes to the new destination.
                let readdressed = url != endpoint.url
                    || project_id != endpoint.project_id
                    || event_types != event_types_json;
                let turned_on = was_enabled == 0 && endpoint.enabled;
                // A new destination, filters, or on/off is a new revision: whatever was chosen
                // or built under the old one is never sent.
                let new_revision = readdressed || (was_enabled != 0) != endpoint.enabled;
                transaction.execute(
                    "UPDATE webhook_endpoints SET name = ?2, url = ?3, enabled = ?4, event_types_json = ?5, \
                     project_id = ?6, paired_session_id = ?7, \
                     consecutive_failures = CASE WHEN ?8 THEN 0 ELSE consecutive_failures END, \
                     disabled_reason = CASE WHEN ?4 THEN NULL ELSE disabled_reason END, \
                     revision = revision + CASE WHEN ?10 THEN 1 ELSE 0 END, \
                     updated_at = ?9 WHERE endpoint_id = ?1",
                    params![
                        endpoint.id,
                        endpoint.name,
                        endpoint.url,
                        i64::from(endpoint.enabled),
                        event_types_json,
                        endpoint.project_id,
                        endpoint.paired_session_id,
                        turned_on,
                        now_iso(),
                        new_revision,
                    ],
                )?;
                if readdressed {
                    abandon_pending(&transaction, Some(&endpoint.id), Some(ENDPOINT_CHANGED))?;
                }
                if !endpoint.enabled {
                    abandon_pending(&transaction, Some(&endpoint.id), None)?;
                }
                transaction.commit()?;
                Ok(Ok(()))
            })
            .await?
    }

    /// The enabled endpoints paired with `session_id`.
    pub(crate) async fn paired_endpoints(&self, session_id: &str) -> Result<Vec<String>> {
        let session_id = session_id.to_owned();
        self.database
            .call(move |connection| {
                let mut statement = connection.prepare_cached(
                    "SELECT endpoint_id FROM webhook_endpoints WHERE paired_session_id = ?1 AND enabled = 1",
                )?;
                Ok(statement
                    .query_map(params![session_id], |row| row.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?)
            })
            .await
    }

    /// Turns an endpoint off with `reason`, bumping its revision and abandoning its queue.
    /// Returns whether it was on.
    pub(crate) async fn disable_endpoint(&self, id: &str, reason: &'static str) -> Result<bool> {
        let id = id.to_owned();
        self.database
            .call(move |connection| {
                let transaction = connection.transaction()?;
                let changed = disable(&transaction, &id, reason)?;
                transaction.commit()?;
                Ok(changed)
            })
            .await
    }

    /// Enabled endpoints paired with a session that is gone, revoked or expired: what a missed
    /// revocation notice leaves behind.
    pub(crate) async fn orphaned_pairings(&self) -> Result<Vec<String>> {
        self.database
            .call(|connection| {
                let mut statement = connection.prepare_cached(
                    "SELECT DISTINCT w.paired_session_id FROM webhook_endpoints AS w \
                     LEFT JOIN auth_sessions AS s ON s.session_id = w.paired_session_id \
                     WHERE w.enabled = 1 AND w.paired_session_id IS NOT NULL \
                       AND (s.session_id IS NULL OR s.revoked_at IS NOT NULL)",
                )?;
                Ok(statement
                    .query_map([], |row| row.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?)
            })
            .await
    }

    /// Whether `session_id` is an outside agent's session that is not revoked.
    pub(crate) async fn is_live_agent_session(&self, session_id: &str) -> Result<bool> {
        let session_id = session_id.to_owned();
        self.database
            .call(move |connection| {
                Ok(connection
                    .query_row(
                        "SELECT 1 FROM auth_sessions WHERE session_id = ?1 AND subject = ?2 AND revoked_at IS NULL",
                        params![session_id, crate::auth::MCP_CLIENT_SUBJECT],
                        |_| Ok(()),
                    )
                    .optional()?
                    .is_some())
            })
            .await
    }

    /// Removes an endpoint and its delivery log. Returns whether it existed.
    pub(crate) async fn delete_endpoint(&self, id: &str) -> Result<bool> {
        let id = id.to_owned();
        self.database
            .call(move |connection| {
                let transaction = connection.transaction()?;
                transaction.execute(
                    "DELETE FROM webhook_deliveries WHERE endpoint_id = ?1",
                    params![id],
                )?;
                transaction.execute(
                    "DELETE FROM webhook_state WHERE key = ?1",
                    params![dropped_key(&id)],
                )?;
                let removed = transaction.execute(
                    "DELETE FROM webhook_endpoints WHERE endpoint_id = ?1",
                    params![id],
                )?;
                transaction.commit()?;
                Ok(removed > 0)
            })
            .await
    }

    /// Queues `deliveries` and stores `positions` in one transaction, then abandons the oldest
    /// pending deliveries past [`MAX_PENDING`]. Returns how many were abandoned.
    pub(crate) async fn enqueue(
        &self,
        deliveries: Vec<NewDelivery>,
        positions: Vec<(&'static str, String)>,
        now_ms: i64,
    ) -> Result<usize> {
        let max_pending = self.max_pending;
        self.database
            .call(move |connection| {
                let transaction = connection.transaction()?;
                let now = now_iso();
                {
                    // The endpoint's revision as it is now, in this transaction: a delivery
                    // chosen under an earlier revision is dropped here, since the edit that
                    // moved it abandoned whatever was queued before it (an edit and its undo
                    // move it twice, so they are caught too).
                    let mut current: HashMap<String, Option<i64>> = HashMap::new();
                    let mut read = transaction.prepare_cached(
                        "SELECT revision FROM webhook_endpoints WHERE endpoint_id = ?1 AND enabled = 1",
                    )?;
                    let mut insert = transaction.prepare_cached(
                        "INSERT INTO webhook_deliveries (delivery_id, endpoint_id, event_id, event_type, body, state, attempts, next_attempt_ms, created_at, updated_at, endpoint_revision) \
                         VALUES (?1, ?2, ?3, ?4, ?5, 'pending', 0, ?6, ?7, ?7, ?8)",
                    )?;
                    for delivery in &deliveries {
                        if !current.contains_key(&delivery.endpoint_id) {
                            let revision = read
                                .query_row(params![delivery.endpoint_id], |row| row.get(0))
                                .optional()?;
                            current.insert(delivery.endpoint_id.clone(), revision);
                        }
                        let Some(revision) = current.get(&delivery.endpoint_id).copied().flatten()
                        else {
                            continue;
                        };
                        if delivery.addressed.is_some_and(|addressed| addressed != revision) {
                            continue;
                        }
                        insert.execute(params![
                            delivery.delivery_id,
                            delivery.endpoint_id,
                            delivery.event_id,
                            delivery.event_type,
                            delivery.body,
                            now_ms,
                            now,
                            revision,
                        ])?;
                    }
                }
                for (key, value) in &positions {
                    set_state(&transaction, key, value)?;
                }
                let dropped: Vec<(String, Option<String>, Option<String>)> = {
                    let mut statement = transaction.prepare_cached(
                        "UPDATE webhook_deliveries SET state = 'abandoned', last_error = 'queue_full', updated_at = ?2 \
                         WHERE sequence IN (SELECT sequence FROM webhook_deliveries WHERE state = 'pending' \
                           ORDER BY sequence DESC LIMIT -1 OFFSET ?1) \
                         RETURNING endpoint_id, json_extract(body, '$.cursor'), json_extract(body, '$.finding.lastSeen')",
                    )?;
                    statement
                        .query_map(params![max_pending, now], |row| {
                            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
                        })?
                        .collect::<rusqlite::Result<Vec<_>>>()?
                };
                // Each endpoint's next delivery names what it lost (see `Dropped`).
                let mut by_endpoint: HashMap<String, Dropped> = HashMap::new();
                for (endpoint, cursor, last_seen) in &dropped {
                    by_endpoint
                        .entry(endpoint.clone())
                        .or_default()
                        .add(cursor.as_deref(), last_seen.as_deref());
                }
                // One batch per endpoint and enqueue, numbered from one counter, so a request
                // acknowledges exactly the batches it announced.
                for (endpoint, lost) in by_endpoint {
                    let key = dropped_key(&endpoint);
                    let mut batches = read_batches(&transaction, &key)?;
                    let seq = transaction
                        .query_row(
                            "SELECT value FROM webhook_state WHERE key = ?1",
                            params![DROP_SEQ],
                            |row| row.get::<_, String>(0),
                        )
                        .optional()?
                        .and_then(|text| text.parse::<u64>().ok())
                        .unwrap_or(0)
                        + 1;
                    set_state(&transaction, DROP_SEQ, &seq.to_string())?;
                    batches.push(DropBatch { seq, lost });
                    set_state(
                        &transaction,
                        &key,
                        &serde_json::to_string(&batches).unwrap_or_default(),
                    )?;
                }
                transaction.commit()?;
                Ok(dropped.len())
            })
            .await
    }

    /// The oldest due pending delivery of each enabled endpoint not in `busy`, at most `limit`.
    pub(crate) async fn due(
        &self,
        now_ms: i64,
        busy: Vec<String>,
        limit: usize,
    ) -> Result<Vec<Delivery>> {
        self.database
            .call(move |connection| {
                let mut statement = connection.prepare_cached(&format!(
                    "SELECT {DELIVERY_COLUMNS} FROM webhook_deliveries WHERE sequence IN ( \
                       SELECT MIN(d.sequence) FROM webhook_deliveries AS d \
                       JOIN webhook_endpoints AS w ON w.endpoint_id = d.endpoint_id AND w.enabled = 1 \
                       WHERE d.state = 'pending' GROUP BY d.endpoint_id) \
                     AND next_attempt_ms <= ?1 ORDER BY sequence"
                ))?;
                let rows = statement
                    .query_map(params![now_ms], decode_delivery)?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(rows
                    .into_iter()
                    .filter(|row| !busy.contains(&row.endpoint_id))
                    .take(limit)
                    .collect())
            })
            .await
    }

    /// When the next pending delivery of an enabled endpoint is due, if any.
    ///
    /// Only each endpoint's oldest pending delivery counts, since `due` sends nothing behind
    /// it, and an endpoint in `busy` (a request in flight, whose end wakes the loop) does not.
    pub(crate) async fn next_due_ms(&self, busy: Vec<String>) -> Result<Option<i64>> {
        self.database
            .call(move |connection| {
                let mut statement = connection.prepare_cached(
                    "SELECT endpoint_id, next_attempt_ms FROM webhook_deliveries WHERE sequence IN ( \
                       SELECT MIN(d.sequence) FROM webhook_deliveries AS d \
                       JOIN webhook_endpoints AS w ON w.endpoint_id = d.endpoint_id AND w.enabled = 1 \
                       WHERE d.state = 'pending' GROUP BY d.endpoint_id)",
                )?;
                let heads = statement
                    .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(heads
                    .into_iter()
                    .filter(|(endpoint, _)| !busy.contains(endpoint))
                    .map(|(_, due)| due)
                    .min())
            })
            .await
    }

    /// What an endpoint lost to a full queue and was not yet told: the batches' numbers and
    /// their sum.
    pub(crate) async fn dropped(&self, endpoint_id: &str) -> Result<Option<(Vec<u64>, Dropped)>> {
        let key = dropped_key(endpoint_id);
        self.database
            .call(move |connection| {
                let transaction = connection.transaction()?;
                let batches = read_batches(&transaction, &key)?;
                transaction.commit()?;
                if batches.is_empty() {
                    return Ok(None);
                }
                let mut sum = Dropped::default();
                for batch in &batches {
                    sum.merge(&batch.lost);
                }
                Ok(Some((batches.iter().map(|batch| batch.seq).collect(), sum)))
            })
            .await
    }

    /// Forgets the batches a delivered request announced; a batch recorded since stays.
    pub(crate) async fn acknowledge_dropped(
        &self,
        endpoint_id: &str,
        announced: Vec<u64>,
    ) -> Result<()> {
        let key = dropped_key(endpoint_id);
        self.database
            .call(move |connection| {
                let transaction = connection.transaction()?;
                let left: Vec<DropBatch> = read_batches(&transaction, &key)?
                    .into_iter()
                    .filter(|batch| !announced.contains(&batch.seq))
                    .collect();
                if left.is_empty() {
                    transaction
                        .execute("DELETE FROM webhook_state WHERE key = ?1", params![key])?;
                } else {
                    set_state(
                        &transaction,
                        &key,
                        &serde_json::to_string(&left).unwrap_or_default(),
                    )?;
                }
                transaction.commit()?;
                Ok(())
            })
            .await
    }

    /// Records one attempt and what it does to the endpoint's health.
    pub(crate) async fn record_attempt(&self, record: AttemptRecord) -> Result<Recorded> {
        self.database
            .call(move |connection| {
                let transaction = connection.transaction()?;
                let row: Option<(String, String)> = transaction
                    .query_row(
                        "SELECT endpoint_id, state FROM webhook_deliveries WHERE delivery_id = ?1",
                        params![record.delivery_id],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .optional()?;
                let Some((endpoint_id, state)) = row else {
                    return Ok(Recorded {
                        stale: true,
                        ..Recorded::default()
                    });
                };
                let now = now_iso();
                if state != PENDING && state != SENDING {
                    // Abandoned while in flight: keep what it says, add the attempt's result.
                    transaction.execute(
                        "UPDATE webhook_deliveries SET attempts = attempts + 1, last_status = ?2, last_error = COALESCE(?3, last_error), latency_ms = ?4, updated_at = ?5 WHERE delivery_id = ?1",
                        params![record.delivery_id, record.status, record.error, record.latency_ms, now],
                    )?;
                    transaction.commit()?;
                    return Ok(Recorded {
                        stale: true,
                        ..Recorded::default()
                    });
                }
                let succeeded = record.error.is_none();
                let next_state = match (succeeded, record.retry_at_ms) {
                    (true, _) => DELIVERED,
                    (false, Some(_)) => PENDING,
                    (false, None) => FAILED,
                };
                transaction.execute(
                    "UPDATE webhook_deliveries SET state = ?2, attempts = attempts + 1, next_attempt_ms = COALESCE(?3, next_attempt_ms), \
                     last_status = ?4, last_error = ?5, latency_ms = ?6, updated_at = ?7 WHERE delivery_id = ?1",
                    params![
                        record.delivery_id,
                        next_state,
                        record.retry_at_ms,
                        record.status,
                        record.error,
                        record.latency_ms,
                        now,
                    ],
                )?;
                let mut recorded = Recorded::default();
                if record.counts_toward_health {
                    if succeeded {
                        transaction.execute(
                            "UPDATE webhook_endpoints SET consecutive_failures = 0 WHERE endpoint_id = ?1",
                            params![endpoint_id],
                        )?;
                    } else if next_state == FAILED {
                        let failures: i64 = transaction.query_row(
                            "UPDATE webhook_endpoints SET consecutive_failures = consecutive_failures + 1 \
                             WHERE endpoint_id = ?1 RETURNING consecutive_failures",
                            params![endpoint_id],
                            |row| row.get(0),
                        )?;
                        if failures >= FAILURES_TO_DISABLE {
                            recorded.disabled_endpoint =
                                disable(&transaction, &endpoint_id, DISABLED_FAILURES)?;
                        }
                    }
                }
                transaction.commit()?;
                Ok(recorded)
            })
            .await
    }

    /// Adds a delivery that the caller sends at once (`sending`), outside the queue.
    pub(crate) async fn insert_sending(
        &self,
        delivery: NewDelivery,
        now_ms: i64,
    ) -> Result<Delivery> {
        self.database
            .call(move |connection| {
                let now = now_iso();
                connection.execute(
                    "INSERT INTO webhook_deliveries (delivery_id, endpoint_id, event_id, event_type, body, state, attempts, next_attempt_ms, created_at, updated_at, endpoint_revision) \
                     VALUES (?1, ?2, ?3, ?4, ?5, 'sending', 0, ?6, ?7, ?7, ?8)",
                    params![
                        delivery.delivery_id,
                        delivery.endpoint_id,
                        delivery.event_id,
                        delivery.event_type,
                        delivery.body,
                        now_ms,
                        now,
                        delivery.addressed.unwrap_or_default(),
                    ],
                )?;
                Ok(connection.query_row(
                    &format!(
                        "SELECT {DELIVERY_COLUMNS} FROM webhook_deliveries WHERE delivery_id = ?1"
                    ),
                    params![delivery.delivery_id],
                    decode_delivery,
                )?)
            })
            .await
    }

    /// A send-now delivery dropped in flight (turned off, disabled or shut down).
    pub(crate) async fn abandon_delivery(
        &self,
        delivery_id: &str,
        reason: &'static str,
    ) -> Result<()> {
        let delivery_id = delivery_id.to_owned();
        self.database
            .call(move |connection| {
                connection.execute(
                    "UPDATE webhook_deliveries SET state = 'abandoned', last_error = ?3, updated_at = ?2 \
                     WHERE delivery_id = ?1 AND state IN ('pending', 'sending')",
                    params![delivery_id, now_iso(), reason],
                )?;
                Ok(())
            })
            .await
    }

    /// Adds the revision columns to a development store that ran the first migration 61.
    pub(crate) async fn ensure_revisions(&self) -> Result<()> {
        self.database
            .call(|connection| {
                let transaction = connection.transaction()?;
                crate::persistence::ensure_webhook_revisions(&transaction)?;
                transaction.commit()?;
                Ok(())
            })
            .await
    }

    /// Send-now deliveries a stopped server left unfinished: whether they arrived is unknown,
    /// so they are failed as `interrupted`, never sent again on their own.
    pub(crate) async fn fail_interrupted_sends(&self) -> Result<usize> {
        self.database
            .call(|connection| {
                Ok(connection.execute(
                    "UPDATE webhook_deliveries SET state = 'failed', last_error = 'interrupted', updated_at = ?1 \
                     WHERE state = 'sending'",
                    params![now_iso()],
                )?)
            })
            .await
    }

    /// Abandons every pending delivery (webhooks turned off); returns how many.
    pub(crate) async fn abandon_all_pending(&self) -> Result<usize> {
        self.database
            .call(|connection| {
                let transaction = connection.transaction()?;
                let abandoned = abandon_pending(&transaction, None, None)?;
                transaction.commit()?;
                Ok(abandoned)
            })
            .await
    }

    /// An endpoint's deliveries, newest first.
    pub(crate) async fn deliveries(&self, endpoint_id: &str, limit: i64) -> Result<Vec<Delivery>> {
        let endpoint_id = endpoint_id.to_owned();
        self.database
            .call(move |connection| {
                let mut statement = connection.prepare_cached(&format!(
                    "SELECT {DELIVERY_COLUMNS} FROM webhook_deliveries WHERE endpoint_id = ?1 ORDER BY sequence DESC LIMIT ?2"
                ))?;
                Ok(statement
                    .query_map(params![endpoint_id, limit], decode_delivery)?
                    .collect::<rusqlite::Result<Vec<_>>>()?)
            })
            .await
    }

    pub(crate) async fn delivery(&self, delivery_id: &str) -> Result<Option<Delivery>> {
        let delivery_id = delivery_id.to_owned();
        self.database
            .call(move |connection| {
                Ok(connection
                    .query_row(
                        &format!(
                            "SELECT {DELIVERY_COLUMNS} FROM webhook_deliveries WHERE delivery_id = ?1"
                        ),
                        params![delivery_id],
                        decode_delivery,
                    )
                    .optional()?)
            })
            .await
    }

    /// Per endpoint: how many deliveries are pending, and the last finished one's state.
    /// Per endpoint: deliveries pending, the last finished one's state, and how many in the
    /// log were dropped from a full queue.
    pub(crate) async fn summaries(&self) -> Result<HashMap<String, (i64, Option<String>, i64)>> {
        self.database
            .call(|connection| {
                let mut statement = connection.prepare_cached(
                    "SELECT w.endpoint_id, \
                       (SELECT COUNT(*) FROM webhook_deliveries AS d WHERE d.endpoint_id = w.endpoint_id AND d.state = 'pending'), \
                       (SELECT d.state FROM webhook_deliveries AS d WHERE d.endpoint_id = w.endpoint_id AND d.state != 'pending' ORDER BY d.sequence DESC LIMIT 1), \
                       (SELECT COUNT(*) FROM webhook_deliveries AS d WHERE d.endpoint_id = w.endpoint_id AND d.last_error = 'queue_full') \
                     FROM webhook_endpoints AS w",
                )?;
                Ok(statement
                    .query_map([], |row| {
                        Ok((row.get(0)?, (row.get(1)?, row.get(2)?, row.get(3)?)))
                    })?
                    .collect::<rusqlite::Result<HashMap<_, _>>>()?)
            })
            .await
    }

    pub(crate) async fn position(&self, key: &'static str) -> Result<Option<String>> {
        self.database
            .call(move |connection| {
                Ok(connection
                    .query_row(
                        "SELECT value FROM webhook_state WHERE key = ?1",
                        params![key],
                        |row| row.get(0),
                    )
                    .optional()?)
            })
            .await
    }

    pub(crate) async fn set_position(&self, key: &'static str, value: String) -> Result<()> {
        self.database
            .call(move |connection| {
                let transaction = connection.transaction()?;
                set_state(&transaction, key, &value)?;
                transaction.commit()?;
                Ok(())
            })
            .await
    }

    /// Forgets every position, so the next start begins at the sources' current heads.
    pub(crate) async fn clear_positions(&self) -> Result<()> {
        self.database
            .call(|connection| {
                // The drop counter stays: batch numbers are never reused, so an old
                // acknowledgement can never match a newer batch.
                connection.execute(
                    "DELETE FROM webhook_state WHERE key != ?1",
                    params![DROP_SEQ],
                )?;
                Ok(())
            })
            .await
    }

    /// Deletes finished deliveries older than 7 days, and beyond the newest 1,000 of each
    /// endpoint. Pending deliveries are never pruned.
    pub(crate) async fn prune(&self) -> Result<usize> {
        let cutoff = (time::OffsetDateTime::now_utc() - time::Duration::days(KEPT_DAYS))
            .format(&time::format_description::well_known::Rfc3339)
            .unwrap_or_default();
        self.database
            .call(move |connection| {
                let transaction = connection.transaction()?;
                let old = transaction.execute(
                    "DELETE FROM webhook_deliveries WHERE state != 'pending' AND updated_at < ?1",
                    params![cutoff],
                )?;
                let beyond = transaction.execute(
                    "DELETE FROM webhook_deliveries WHERE state != 'pending' AND sequence IN ( \
                       SELECT sequence FROM (SELECT sequence, ROW_NUMBER() OVER ( \
                         PARTITION BY endpoint_id ORDER BY sequence DESC) AS n \
                         FROM webhook_deliveries WHERE state != 'pending') WHERE n > ?1)",
                    params![KEPT_PER_ENDPOINT],
                )?;
                transaction.commit()?;
                Ok(old + beyond)
            })
            .await
    }

    /// For each thread: its project, and whether it has a worktree. Ids and a boolean only.
    pub(crate) async fn thread_routes(
        &self,
        thread_ids: Vec<String>,
    ) -> Result<HashMap<String, (String, bool)>> {
        if thread_ids.is_empty() {
            return Ok(HashMap::new());
        }
        self.database
            .call(move |connection| {
                let mut statement = connection.prepare_cached(
                    "SELECT project_id, worktree_path IS NOT NULL FROM projection_threads WHERE thread_id = ?1",
                )?;
                let mut routes = HashMap::new();
                for id in thread_ids {
                    if let Some(route) = statement
                        .query_row(params![id], |row| Ok((row.get(0)?, row.get(1)?)))
                        .optional()?
                    {
                        routes.insert(id, route);
                    }
                }
                Ok(routes)
            })
            .await
    }
}

/// The counter that numbers drop batches.
const DROP_SEQ: &str = "drop_seq";

/// One enqueue's losses for one endpoint.
#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
struct DropBatch {
    seq: u64,
    #[serde(flatten)]
    lost: Dropped,
}

fn read_batches(transaction: &Transaction<'_>, key: &str) -> rusqlite::Result<Vec<DropBatch>> {
    let text: Option<String> = transaction
        .query_row(
            "SELECT value FROM webhook_state WHERE key = ?1",
            params![key],
            |row| row.get(0),
        )
        .optional()?;
    Ok(text
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default())
}

fn dropped_key(endpoint_id: &str) -> String {
    format!("dropped:{endpoint_id}")
}

/// Deliveries an endpoint lost to a full queue and has not been told about yet: their count,
/// the range of change-feed cursors they carried, and the earliest finding `lastSeen`. The
/// next delivery to the endpoint carries it as `dropped`, and it is cleared once one arrives.
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Dropped {
    pub(crate) count: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) from_cursor: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) to_cursor: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) since_last_seen: Option<String>,
}

/// A feed cursor's position for ordering: `v1.<sequence>.<activity>`.
fn cursor_order(cursor: &str) -> Option<(i64, i64)> {
    let mut parts = cursor.split('.');
    let (Some("v1"), Some(sequence), Some(activity), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return None;
    };
    Some((sequence.parse().ok()?, activity.parse().ok()?))
}

impl Dropped {
    fn add(&mut self, cursor: Option<&str>, last_seen: Option<&str>) {
        self.merge(&Self {
            count: 1,
            from_cursor: cursor.map(str::to_owned),
            to_cursor: cursor.map(str::to_owned),
            since_last_seen: last_seen.map(str::to_owned),
        });
    }

    fn merge(&mut self, other: &Self) {
        self.count += other.count;
        let pick = |mine: &mut Option<String>, theirs: &Option<String>, earlier: bool| {
            if let Some(theirs) = theirs {
                let replace = match mine.as_deref() {
                    None => true,
                    Some(current) => match (cursor_order(theirs), cursor_order(current)) {
                        (Some(theirs), Some(current)) => (theirs < current) == earlier,
                        _ => (theirs.as_str() < current) == earlier,
                    },
                };
                if replace {
                    *mine = Some(theirs.clone());
                }
            }
        };
        pick(&mut self.from_cursor, &other.from_cursor, true);
        pick(&mut self.to_cursor, &other.to_cursor, false);
        pick(&mut self.since_last_seen, &other.since_last_seen, true);
    }
}

fn set_state(transaction: &Transaction<'_>, key: &str, value: &str) -> rusqlite::Result<()> {
    transaction.execute(
        "INSERT INTO webhook_state (key, value) VALUES (?1, ?2) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

/// Abandons pending deliveries (one endpoint's, or all), naming `reason` in their log.
fn abandon_pending(
    transaction: &Transaction<'_>,
    endpoint: Option<&str>,
    reason: Option<&str>,
) -> rusqlite::Result<usize> {
    transaction.execute(
        "UPDATE webhook_deliveries SET state = 'abandoned', last_error = COALESCE(?3, last_error), updated_at = ?2 \
         WHERE state = 'pending' AND (?1 IS NULL OR endpoint_id = ?1)",
        params![endpoint, now_iso(), reason],
    )
}

fn disable(transaction: &Transaction<'_>, id: &str, reason: &str) -> rusqlite::Result<bool> {
    let changed = transaction.execute(
        "UPDATE webhook_endpoints SET enabled = 0, disabled_reason = ?2, updated_at = ?3, \
         revision = revision + 1 WHERE endpoint_id = ?1 AND enabled = 1",
        params![id, reason, now_iso()],
    )?;
    abandon_pending(transaction, Some(id), None)?;
    Ok(changed > 0)
}
