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
}

/// One delivery to queue.
#[derive(Clone, Debug)]
pub(crate) struct NewDelivery {
    pub(crate) delivery_id: String,
    pub(crate) endpoint_id: String,
    pub(crate) event_id: String,
    pub(crate) event_type: String,
    pub(crate) body: String,
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
    paired_session_id, consecutive_failures, disabled_reason, created_at, updated_at";
const DELIVERY_COLUMNS: &str = "sequence, delivery_id, endpoint_id, event_id, event_type, body, \
    state, attempts, next_attempt_ms, last_status, last_error, latency_ms, created_at, updated_at";

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
    })
}

#[derive(Clone)]
pub(crate) struct Store {
    database: Database,
}

impl Store {
    pub(crate) fn new(database: Database) -> Self {
        Self { database }
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
                    &format!("INSERT INTO webhook_endpoints ({ENDPOINT_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)"),
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
                let was_enabled: Option<i64> = transaction
                    .query_row(
                        "SELECT enabled FROM webhook_endpoints WHERE endpoint_id = ?1",
                        params![endpoint.id],
                        |row| row.get(0),
                    )
                    .optional()?;
                let Some(was_enabled) = was_enabled else {
                    return Ok(Err(StoreError::NotFound));
                };
                let turned_on = was_enabled == 0 && endpoint.enabled;
                transaction.execute(
                    "UPDATE webhook_endpoints SET name = ?2, url = ?3, enabled = ?4, event_types_json = ?5, \
                     project_id = ?6, paired_session_id = ?7, \
                     consecutive_failures = CASE WHEN ?8 THEN 0 ELSE consecutive_failures END, \
                     disabled_reason = CASE WHEN ?4 THEN NULL ELSE disabled_reason END, \
                     updated_at = ?9 WHERE endpoint_id = ?1",
                    params![
                        endpoint.id,
                        endpoint.name,
                        endpoint.url,
                        i64::from(endpoint.enabled),
                        serde_json::to_string(&endpoint.event_types).unwrap_or_else(|_| "[]".to_owned()),
                        endpoint.project_id,
                        endpoint.paired_session_id,
                        turned_on,
                        now_iso(),
                    ],
                )?;
                if !endpoint.enabled {
                    abandon_pending(&transaction, Some(&endpoint.id))?;
                }
                transaction.commit()?;
                Ok(Ok(()))
            })
            .await?
    }

    /// Disables every enabled endpoint paired with `session_id`; returns their ids.
    pub(crate) async fn disable_paired(&self, session_id: &str) -> Result<Vec<String>> {
        let session_id = session_id.to_owned();
        self.database
            .call(move |connection| {
                let transaction = connection.transaction()?;
                let ids = {
                    let mut statement = transaction.prepare_cached(
                        "SELECT endpoint_id FROM webhook_endpoints WHERE paired_session_id = ?1 AND enabled = 1",
                    )?;
                    statement
                        .query_map(params![session_id], |row| row.get::<_, String>(0))?
                        .collect::<rusqlite::Result<Vec<_>>>()?
                };
                for id in &ids {
                    disable(&transaction, id, DISABLED_CLIENT_REVOKED)?;
                }
                transaction.commit()?;
                Ok(ids)
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
        self.database
            .call(move |connection| {
                let transaction = connection.transaction()?;
                let now = now_iso();
                {
                    let mut insert = transaction.prepare_cached(
                        "INSERT INTO webhook_deliveries (delivery_id, endpoint_id, event_id, event_type, body, state, attempts, next_attempt_ms, created_at, updated_at) \
                         VALUES (?1, ?2, ?3, ?4, ?5, 'pending', 0, ?6, ?7, ?7)",
                    )?;
                    for delivery in &deliveries {
                        insert.execute(params![
                            delivery.delivery_id,
                            delivery.endpoint_id,
                            delivery.event_id,
                            delivery.event_type,
                            delivery.body,
                            now_ms,
                            now,
                        ])?;
                    }
                }
                for (key, value) in &positions {
                    set_state(&transaction, key, value)?;
                }
                let abandoned = transaction.execute(
                    "UPDATE webhook_deliveries SET state = 'abandoned', last_error = 'queue_full', updated_at = ?2 \
                     WHERE sequence IN (SELECT sequence FROM webhook_deliveries WHERE state = 'pending' \
                       ORDER BY sequence DESC LIMIT -1 OFFSET ?1)",
                    params![MAX_PENDING, now],
                )?;
                transaction.commit()?;
                Ok(abandoned)
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
    pub(crate) async fn next_due_ms(&self) -> Result<Option<i64>> {
        self.database
            .call(|connection| {
                Ok(connection.query_row(
                    "SELECT MIN(d.next_attempt_ms) FROM webhook_deliveries AS d \
                     JOIN webhook_endpoints AS w ON w.endpoint_id = d.endpoint_id AND w.enabled = 1 \
                     WHERE d.state = 'pending'",
                    [],
                    |row| row.get(0),
                )?)
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
                    "INSERT INTO webhook_deliveries (delivery_id, endpoint_id, event_id, event_type, body, state, attempts, next_attempt_ms, created_at, updated_at) \
                     VALUES (?1, ?2, ?3, ?4, ?5, 'sending', 0, ?6, ?7, ?7)",
                    params![
                        delivery.delivery_id,
                        delivery.endpoint_id,
                        delivery.event_id,
                        delivery.event_type,
                        delivery.body,
                        now_ms,
                        now,
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
    pub(crate) async fn abandon_delivery(&self, delivery_id: &str) -> Result<()> {
        let delivery_id = delivery_id.to_owned();
        self.database
            .call(move |connection| {
                connection.execute(
                    "UPDATE webhook_deliveries SET state = 'abandoned', last_error = 'cancelled', updated_at = ?2 \
                     WHERE delivery_id = ?1 AND state IN ('pending', 'sending')",
                    params![delivery_id, now_iso()],
                )?;
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
                let abandoned = abandon_pending(&transaction, None)?;
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
    pub(crate) async fn summaries(&self) -> Result<HashMap<String, (i64, Option<String>)>> {
        self.database
            .call(|connection| {
                let mut statement = connection.prepare_cached(
                    "SELECT w.endpoint_id, \
                       (SELECT COUNT(*) FROM webhook_deliveries AS d WHERE d.endpoint_id = w.endpoint_id AND d.state = 'pending'), \
                       (SELECT d.state FROM webhook_deliveries AS d WHERE d.endpoint_id = w.endpoint_id AND d.state != 'pending' ORDER BY d.sequence DESC LIMIT 1) \
                     FROM webhook_endpoints AS w",
                )?;
                Ok(statement
                    .query_map([], |row| Ok((row.get(0)?, (row.get(1)?, row.get(2)?))))?
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
                connection.execute("DELETE FROM webhook_state", [])?;
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

fn set_state(transaction: &Transaction<'_>, key: &str, value: &str) -> rusqlite::Result<()> {
    transaction.execute(
        "INSERT INTO webhook_state (key, value) VALUES (?1, ?2) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

fn abandon_pending(
    transaction: &Transaction<'_>,
    endpoint: Option<&str>,
) -> rusqlite::Result<usize> {
    transaction.execute(
        "UPDATE webhook_deliveries SET state = 'abandoned', updated_at = ?2 \
         WHERE state = 'pending' AND (?1 IS NULL OR endpoint_id = ?1)",
        params![endpoint, now_iso()],
    )
}

fn disable(transaction: &Transaction<'_>, id: &str, reason: &str) -> rusqlite::Result<bool> {
    let changed = transaction.execute(
        "UPDATE webhook_endpoints SET enabled = 0, disabled_reason = ?2, updated_at = ?3 \
         WHERE endpoint_id = ?1 AND enabled = 1",
        params![id, reason, now_iso()],
    )?;
    abandon_pending(transaction, Some(id))?;
    Ok(changed > 0)
}
