//! Outbound webhooks (#139, slice X8).
//!
//! A person registers up to 20 HTTPS endpoints per environment in Settings → Agent
//! integrations → Webhooks; with `enableWebhooks` on, the [`Webhooks`] dispatcher posts each
//! matching event to each enabled endpoint, signed with that endpoint's secret.
//!
//! **Sources.** The dispatcher follows durable sources from stored positions, never the
//! in-process broadcast (which drops events under load): X3's change feed, through the same
//! page read `changes_since` uses, from its stored cursor; and the profiler's findings book,
//! from the `lastSeen` second and the `(id, count)` marks it last delivered. Each read's
//! deliveries and its new position are written in one transaction, so a restart neither
//! loses nor repeats a queued event.
//!
//! **Queue.** `webhook_deliveries` rows are the queue and the log. One request at a time per
//! endpoint, oldest first, at most [`MAX_IN_FLIGHT`] endpoints at once. A timeout, connection
//! error, unresolved host, 5xx or 429 is tried again after 30 s, 2, 5, 10 and 15 minutes; any
//! other failure, or the last retry, fails the delivery, and 10 failed deliveries in a row
//! disable the endpoint. At most 10,000 deliveries wait; past that the oldest are abandoned
//! with a warning, and a receiver catches up through `changes_since` and `profiler_findings`.
//!
//! **Off is immediate.** Turning webhooks off, or an endpoint, cancels its request in flight
//! and abandons what it has queued. Webhooks off also forgets the positions, so turning them
//! on again starts from now rather than replaying what happened meanwhile.
//!
//! **Pairing.** Revoking the MCP client an endpoint is paired with disables the endpoint.

pub(crate) mod delivery;
pub(crate) mod events;
mod rpc;
pub(crate) mod signing;
pub(crate) mod store;
#[cfg(test)]
mod tests;

use std::{
    collections::{BTreeMap, HashMap, HashSet},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::{
    sync::{Notify, broadcast, watch},
    task::{JoinHandle, JoinSet},
};
use tokio_util::sync::CancellationToken;

pub(crate) use rpc::register_webhooks_rpc;

use self::{
    delivery::{Attempt, Failure, Headers, NetPolicy},
    events::Event,
    store::{AttemptRecord, Delivery, Endpoint, NewDelivery, Store},
};
use crate::{
    auth::SecretStore,
    diagnostics::profiler::reader::Reader,
    mcp::control::{McpCapability, McpServerSettings},
    persistence::{Database, Repositories},
};

/// The retry delays after each failed attempt: the first send plus five retries over about 32
/// minutes.
pub(crate) const RETRY_DELAYS: [Duration; 5] = [
    Duration::from_secs(30),
    Duration::from_secs(2 * 60),
    Duration::from_secs(5 * 60),
    Duration::from_secs(10 * 60),
    Duration::from_secs(15 * 60),
];
/// Endpoints with a request in flight at once.
const MAX_IN_FLIGHT: usize = 8;
/// How often the sources are read when nothing wakes the dispatcher sooner.
const POLL: Duration = Duration::from_secs(2);
/// Change-feed pages read per pass, each at most [`FEED_PAGE`] entries.
const FEED_PAGES_PER_PASS: usize = 10;
const FEED_PAGE: usize = 500;
const PRUNE_EVERY: Duration = Duration::from_secs(10 * 60);
/// How long the loop sleeps while webhooks are off, unless the setting or a wake comes first.
const IDLE_WAIT: Duration = Duration::from_secs(60);

/// Where profiler findings are read from: the running server's profiler directory.
pub(crate) type FindingsSource = Arc<dyn Fn() -> Option<Reader> + Send + Sync>;

/// What the dispatcher needs from the runtime.
pub(crate) struct WebhooksConfig {
    pub(crate) database: Database,
    pub(crate) repositories: Repositories,
    pub(crate) secrets: SecretStore,
    pub(crate) environment_id: String,
    /// `enableWebhooks`, live.
    pub(crate) enabled: watch::Receiver<bool>,
    /// The MCP settings, live: `profiler.finding` needs the Diagnostics set.
    pub(crate) mcp: watch::Receiver<McpServerSettings>,
    pub(crate) findings: FindingsSource,
    pub(crate) net: NetPolicy,
    pub(crate) retry_delays: Vec<Duration>,
    pub(crate) poll: Duration,
    /// At most this many deliveries wait; past it the oldest are abandoned.
    pub(crate) max_pending: i64,
}

impl WebhooksConfig {
    /// Production timing and the system resolver.
    pub(crate) fn production(
        database: Database,
        repositories: Repositories,
        secrets: SecretStore,
        environment_id: String,
        enabled: watch::Receiver<bool>,
        mcp: watch::Receiver<McpServerSettings>,
    ) -> Self {
        Self {
            database,
            repositories,
            secrets,
            environment_id,
            enabled,
            mcp,
            findings: Arc::new(crate::diagnostics::profiler::mcp::server_reader),
            net: NetPolicy::system(),
            retry_delays: RETRY_DELAYS.to_vec(),
            poll: POLL,
            max_pending: store::MAX_PENDING,
        }
    }
}

/// The webhook service: the endpoints' administration and the background dispatcher.
#[derive(Clone)]
pub(crate) struct Webhooks {
    inner: Arc<Inner>,
}

struct Inner {
    store: Store,
    repositories: Repositories,
    secrets: SecretStore,
    environment_id: String,
    enabled: watch::Receiver<bool>,
    mcp: watch::Receiver<McpServerSettings>,
    findings: FindingsSource,
    net: NetPolicy,
    retry_delays: Vec<Duration>,
    poll: Duration,
    wake: Notify,
    shutdown: CancellationToken,
    /// One token per endpoint, a child of `shutdown`: cancelling it drops the endpoint's
    /// request in flight.
    endpoint_tokens: Mutex<HashMap<String, CancellationToken>>,
    /// One lock per endpoint, held for each request: the dispatcher's, a test event's and a
    /// redelivery's all take it, so an endpoint never has two requests open.
    send_locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    /// The findings file as last read, so an unchanged book is not parsed again.
    findings_version: Mutex<Option<(u64, Option<SystemTime>)>>,
    task: Mutex<Option<JoinHandle<()>>>,
    /// Loop passes so far: a test counts them to catch a busy loop.
    passes: std::sync::atomic::AtomicU64,
}

/// The dispatcher's position in the findings book: the newest `lastSeen` second it delivered
/// and the `(id, count)` of each finding of that second, since `lastSeen` has whole seconds.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct FindingsPosition {
    last_seen: String,
    marks: BTreeMap<String, u64>,
}

fn now_ms() -> i64 {
    i64::try_from(
        SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
    )
    .unwrap_or(i64::MAX)
}

fn secret_name(endpoint_id: &str) -> String {
    format!("webhook-{endpoint_id}")
}

/// `lastSeen` as an instant for ordering; a value that does not parse sorts first.
fn seen_at(text: &str) -> time::OffsetDateTime {
    time::OffsetDateTime::parse(text, &time::format_description::well_known::Rfc3339)
        .unwrap_or(time::OffsetDateTime::UNIX_EPOCH)
}

impl Webhooks {
    /// Starts the dispatcher.
    pub(crate) fn start(config: WebhooksConfig) -> Self {
        let WebhooksConfig {
            database,
            repositories,
            secrets,
            environment_id,
            enabled,
            mcp,
            findings,
            net,
            retry_delays,
            poll,
            max_pending,
        } = config;
        let webhooks = Self {
            inner: Arc::new(Inner {
                store: Store::new(database, max_pending),
                repositories,
                secrets,
                environment_id,
                enabled,
                mcp,
                findings,
                net,
                retry_delays,
                poll,
                wake: Notify::new(),
                shutdown: CancellationToken::new(),
                endpoint_tokens: Mutex::new(HashMap::new()),
                send_locks: Mutex::new(HashMap::new()),
                findings_version: Mutex::new(None),
                task: Mutex::new(None),
                passes: std::sync::atomic::AtomicU64::new(0),
            }),
        };
        let task = tokio::spawn(run(webhooks.clone()));
        *webhooks.inner.task.lock().expect("task lock") = Some(task);
        webhooks
    }

    /// Stops the dispatcher: requests in flight are dropped and stay queued for the next
    /// start. Waits for the task to end.
    pub(crate) async fn shutdown(&self) {
        self.inner.shutdown.cancel();
        let task = self.inner.task.lock().expect("task lock").take();
        if let Some(task) = task
            && let Err(error) = task.await
            && error.is_panic()
        {
            tracing::error!("the webhook dispatcher panicked");
        }
    }

    #[cfg(test)]
    pub(crate) fn passes(&self) -> u64 {
        self.inner.passes.load(std::sync::atomic::Ordering::Relaxed)
    }

    pub(crate) fn enabled(&self) -> bool {
        *self.inner.enabled.borrow()
    }

    pub(crate) fn store(&self) -> &Store {
        &self.inner.store
    }

    fn wake(&self) {
        self.inner.wake.notify_one();
    }

    /// Wakes the dispatcher on every message of `notices` (the Authorized clients changes),
    /// so a revoked paired client's endpoints are disabled at once; the revocation itself is
    /// read from `auth_sessions`, so a missed notice is caught on the next pass.
    pub(crate) fn wake_on<T: Clone + Send + 'static>(&self, mut notices: broadcast::Receiver<T>) {
        let webhooks = self.clone();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    () = webhooks.inner.shutdown.cancelled() => return,
                    notice = notices.recv() => match notice {
                        Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => webhooks.wake(),
                        Err(broadcast::error::RecvError::Closed) => return,
                    },
                }
            }
        });
    }

    fn endpoint_token(&self, endpoint_id: &str) -> CancellationToken {
        self.inner
            .endpoint_tokens
            .lock()
            .expect("token lock")
            .entry(endpoint_id.to_owned())
            .or_insert_with(|| self.inner.shutdown.child_token())
            .clone()
    }

    /// Drops the endpoint's request in flight; later requests get a fresh token.
    fn cancel_endpoint(&self, endpoint_id: &str) {
        if let Some(token) = self
            .inner
            .endpoint_tokens
            .lock()
            .expect("token lock")
            .remove(endpoint_id)
        {
            token.cancel();
        }
    }

    fn cancel_all(&self) {
        for (_, token) in self
            .inner
            .endpoint_tokens
            .lock()
            .expect("token lock")
            .drain()
        {
            token.cancel();
        }
    }

    async fn secret(&self, endpoint_id: &str) -> Option<String> {
        match self.inner.secrets.get(&secret_name(endpoint_id)).await {
            Ok(Some(bytes)) => String::from_utf8(bytes).ok(),
            Ok(None) => None,
            Err(error) => {
                tracing::warn!(endpoint = endpoint_id, %error, "could not read a webhook secret");
                None
            }
        }
    }

    fn send_lock(&self, endpoint_id: &str) -> Arc<tokio::sync::Mutex<()>> {
        self.inner
            .send_locks
            .lock()
            .expect("send lock map")
            .entry(endpoint_id.to_owned())
            .or_default()
            .clone()
    }

    /// Waits for the endpoint's send lock (its request in flight, if any), unless `cancel`
    /// fires first.
    async fn take_turn(
        &self,
        endpoint_id: &str,
        cancel: &CancellationToken,
    ) -> Option<tokio::sync::OwnedMutexGuard<()>> {
        let lock = self.send_lock(endpoint_id);
        tokio::select! {
            biased;
            () = cancel.cancelled() => None,
            turn = lock.lock_owned() => Some(turn),
        }
    }

    /// Sends one delivery once, after the endpoint's request in flight, and returns what
    /// happened, without recording it (a test event and a redelivery).
    async fn attempt(
        &self,
        endpoint: &Endpoint,
        delivery_id: &str,
        event_type: &str,
        body: &str,
        cancel: &CancellationToken,
    ) -> Attempt {
        let Some(_turn) = self.take_turn(&endpoint.id, cancel).await else {
            return Attempt {
                status: None,
                failure: Some(Failure::Cancelled),
                latency_ms: 0,
            };
        };
        self.attempt_holding_turn(endpoint, delivery_id, event_type, body, cancel)
            .await
    }

    /// [`attempt`](Self::attempt) for a caller that holds the endpoint's send lock. It adds
    /// `dropped` to the body while the endpoint has drop batches it was not told about, and a
    /// 2xx acknowledges exactly the batches it carried.
    async fn attempt_holding_turn(
        &self,
        endpoint: &Endpoint,
        delivery_id: &str,
        event_type: &str,
        body: &str,
        cancel: &CancellationToken,
    ) -> Attempt {
        let dropped = match self.inner.store.dropped(&endpoint.id).await {
            Ok(dropped) => dropped,
            Err(error) => {
                tracing::warn!(%error, "could not read a webhook endpoint's dropped deliveries");
                None
            }
        };
        let announced = dropped.as_ref().and_then(|(_, sum)| {
            let mut payload: serde_json::Map<String, Value> = serde_json::from_str(body).ok()?;
            payload.insert("dropped".to_owned(), serde_json::to_value(sum).ok()?);
            Some(Value::Object(payload).to_string())
        });
        let attempt = self
            .send_signed(
                endpoint,
                delivery_id,
                event_type,
                announced.as_deref().unwrap_or(body),
                cancel,
            )
            .await;
        if attempt.failure.is_none()
            && announced.is_some()
            && let Some((batches, _)) = dropped
            && let Err(error) = self
                .inner
                .store
                .acknowledge_dropped(&endpoint.id, batches)
                .await
        {
            tracing::warn!(%error, "could not clear a webhook endpoint's dropped deliveries");
        }
        attempt
    }

    async fn send_signed(
        &self,
        endpoint: &Endpoint,
        delivery_id: &str,
        event_type: &str,
        body: &str,
        cancel: &CancellationToken,
    ) -> Attempt {
        let Some(secret) = self.secret(&endpoint.id).await else {
            // Never sent unsigned; Rotate secret makes a new one.
            return Attempt {
                status: None,
                failure: Some(Failure::SecretMissing),
                latency_ms: 0,
            };
        };
        let timestamp = time::OffsetDateTime::now_utc().unix_timestamp();
        let signature = signing::sign(&secret, timestamp, body.as_bytes());
        delivery::send(
            &self.inner.net,
            &endpoint.url,
            &Headers {
                event_type,
                delivery_id,
                timestamp,
                signature: &signature,
            },
            body.as_bytes(),
            cancel,
        )
        .await
    }

    /// The record of an attempt: a retry time while retries remain and the failure is one
    /// that is tried again.
    fn record(&self, delivery: &Delivery, attempt: &Attempt, health: bool) -> AttemptRecord {
        let attempt_number = usize::try_from(delivery.attempts).unwrap_or(usize::MAX);
        let retry_at_ms = (health && attempt.retryable())
            .then(|| self.inner.retry_delays.get(attempt_number))
            .flatten()
            .map(|delay| now_ms() + i64::try_from(delay.as_millis()).unwrap_or(i64::MAX));
        AttemptRecord {
            delivery_id: delivery.delivery_id.clone(),
            status: attempt.status.map(i64::from),
            error: attempt.failure.map(Failure::tag),
            latency_ms: i64::try_from(attempt.latency_ms).unwrap_or(i64::MAX),
            retry_at_ms,
            counts_toward_health: health,
        }
    }

    /// One queued delivery, as the dispatcher sends it, with the endpoint's send lock when
    /// the dispatcher already took it.
    async fn deliver(&self, delivery: Delivery, turn: Option<tokio::sync::OwnedMutexGuard<()>>) {
        // The token first: an edit committed before the reads below abandoned the row, and
        // one committed after them cancels this token, so a row picked before an edit never
        // goes to the edited destination.
        let cancel = self.endpoint_token(&delivery.endpoint_id);
        let _turn = match turn {
            Some(turn) => turn,
            None => match self.take_turn(&delivery.endpoint_id, &cancel).await {
                Some(turn) => turn,
                None => return,
            },
        };
        match self.inner.store.delivery(&delivery.delivery_id).await {
            Ok(Some(current)) if current.state == store::PENDING => {}
            Ok(_) => return,
            Err(error) => {
                tracing::warn!(%error, "could not read a webhook delivery");
                return;
            }
        }
        let endpoint = match self.inner.store.endpoint(&delivery.endpoint_id).await {
            Ok(Some(endpoint)) if endpoint.enabled => endpoint,
            Ok(_) => return,
            Err(error) => {
                tracing::warn!(%error, "could not read a webhook endpoint");
                return;
            }
        };
        let attempt = self
            .attempt_holding_turn(
                &endpoint,
                &delivery.delivery_id,
                &delivery.event_type,
                &delivery.body,
                &cancel,
            )
            .await;
        // Dropped by off, a disabled endpoint or shutdown: off and disable already abandoned
        // the row, and shutdown leaves it queued for the next start.
        if attempt.failure == Some(Failure::Cancelled) {
            return;
        }
        let record = self.record(&delivery, &attempt, true);
        self.finish(&endpoint, &delivery, &attempt, record).await;
    }

    async fn finish(
        &self,
        endpoint: &Endpoint,
        delivery: &Delivery,
        attempt: &Attempt,
        record: AttemptRecord,
    ) {
        let retrying = record.retry_at_ms.is_some();
        if let Some(failure) = attempt.failure {
            // The URL may carry a token, so it is never logged.
            tracing::warn!(
                endpoint = %endpoint.id,
                status = attempt.status,
                error = failure.tag(),
                attempt = delivery.attempts + 1,
                retrying,
                "webhook delivery failed"
            );
        }
        match self.inner.store.record_attempt(record).await {
            Ok(recorded) if recorded.disabled_endpoint => {
                self.cancel_endpoint(&endpoint.id);
                tracing::warn!(
                    endpoint = %endpoint.id,
                    "webhook endpoint disabled after 10 failed deliveries in a row"
                );
            }
            Ok(_) => {}
            Err(error) => tracing::warn!(%error, "could not record a webhook delivery"),
        }
    }

    /// Reads the change feed from the stored cursor and queues its events.
    async fn follow_feed(&self, endpoints: &[Endpoint]) {
        let store = &self.inner.store;
        let mut cursor = match store.position(store::FEED_POSITION).await {
            Ok(Some(cursor)) => cursor,
            Ok(None) => {
                self.start_feed_at_head().await;
                return;
            }
            Err(error) => {
                tracing::warn!(%error, "could not read the webhook feed position");
                return;
            }
        };
        for _ in 0..FEED_PAGES_PER_PASS {
            let page = match crate::mcp::tools::feed::page_after(
                &self.inner.repositories,
                &cursor,
                None,
                FEED_PAGE,
            )
            .await
            {
                Ok(page) => page,
                Err(crate::mcp::tools::feed::FeedError::Storage(error)) => {
                    tracing::warn!(%error, "could not read the change feed for webhooks");
                    return;
                }
                Err(_) => {
                    tracing::warn!(
                        "the webhook feed position is not this database's; starting from now"
                    );
                    self.start_feed_at_head().await;
                    return;
                }
            };
            if page.activity_dropped {
                tracing::warn!("agent activity the webhook dispatcher had not read was pruned");
            }
            let thread_ids: Vec<String> = page
                .entries
                .iter()
                .filter_map(|entry| entry.get("threadId").and_then(Value::as_str))
                .map(str::to_owned)
                .collect::<HashSet<_>>()
                .into_iter()
                .collect();
            let routes = match store.thread_routes(thread_ids).await {
                Ok(routes) => routes,
                Err(error) => {
                    tracing::warn!(%error, "could not read threads for webhooks");
                    return;
                }
            };
            let events: Vec<Event> = page
                .entries
                .iter()
                .filter_map(|entry| {
                    let route = entry
                        .get("threadId")
                        .and_then(Value::as_str)
                        .and_then(|thread| routes.get(thread).cloned());
                    events::from_feed_entry(entry, route)
                })
                .collect();
            let deliveries = self.address(&events, endpoints);
            let more = page.more;
            // Nothing new: no write, so an idle environment costs one read per pass.
            if deliveries.is_empty() && page.cursor == cursor {
                return;
            }
            if !self
                .queue(
                    deliveries,
                    vec![(store::FEED_POSITION, page.cursor.clone())],
                )
                .await
            {
                return;
            }
            if !more {
                return;
            }
            cursor = page.cursor;
        }
        // More remains: read on at once rather than after the poll interval.
        self.wake();
    }

    async fn start_feed_at_head(&self) {
        match crate::mcp::tools::feed::head(&self.inner.repositories).await {
            Ok(head) => {
                if let Err(error) = self
                    .inner
                    .store
                    .set_position(store::FEED_POSITION, head)
                    .await
                {
                    tracing::warn!(%error, "could not store the webhook feed position");
                }
            }
            Err(error) => tracing::warn!(%error, "could not read the change feed head"),
        }
    }

    /// Reads the findings book and queues each finding that appeared or recurred since the
    /// stored position. While MCP or its Diagnostics set is off nothing is queued (the
    /// receiver's catch-up tool would not exist), but the position still moves.
    async fn follow_findings(&self, endpoints: &[Endpoint]) {
        let Some(reader) = (self.inner.findings)() else {
            return;
        };
        let version = reader.findings_version();
        let stored = match self.inner.store.position(store::FINDINGS_POSITION).await {
            Ok(stored) => {
                stored.and_then(|text| serde_json::from_str::<FindingsPosition>(&text).ok())
            }
            Err(error) => {
                tracing::warn!(%error, "could not read the webhook findings position");
                return;
            }
        };
        if stored.is_some() && *self.inner.findings_version.lock().expect("version lock") == version
        {
            return;
        }
        let findings = match tokio::task::spawn_blocking(move || {
            reader.findings(
                None,
                None,
                usize::from(crate::diagnostics::profiler::reader::MAX_LIMIT),
            )
        })
        .await
        {
            Ok(findings) => findings,
            Err(_) => return,
        };
        let mut book: Vec<(String, u64, String)> = findings
            .iter()
            .filter_map(|finding| {
                Some((
                    finding.get("id")?.as_str()?.to_owned(),
                    finding.get("count")?.as_u64()?,
                    finding.get("lastSeen")?.as_str()?.to_owned(),
                ))
            })
            .collect();
        book.sort_by(|left, right| {
            seen_at(&left.2)
                .cmp(&seen_at(&right.2))
                .then_with(|| left.0.cmp(&right.0))
        });
        let newest = book.last().map(|(_, _, seen)| seen.clone());
        let position_at = |second: &str| FindingsPosition {
            last_seen: second.to_owned(),
            marks: book
                .iter()
                .filter(|(_, _, seen)| seen_at(seen) == seen_at(second))
                .map(|(id, count, _)| (id.clone(), *count))
                .collect(),
        };
        let (fresh, position) = match stored {
            // The first read only marks what is already there.
            None => (
                Vec::new(),
                newest.as_deref().map(position_at).unwrap_or_default(),
            ),
            Some(stored) => {
                let since = seen_at(&stored.last_seen);
                let fresh: Vec<&(String, u64, String)> = book
                    .iter()
                    .filter(|(id, count, seen)| {
                        let at = seen_at(seen);
                        at > since || (at == since && stored.marks.get(id) != Some(count))
                    })
                    .collect();
                let position = match fresh.last() {
                    Some((_, _, seen)) => position_at(seen),
                    None => stored,
                };
                (fresh, position)
            }
        };
        let settings = *self.inner.mcp.borrow();
        let offered = settings.enabled && settings.capabilities.allows(McpCapability::Diagnostics);
        let events: Vec<Event> = if offered {
            fresh
                .iter()
                .map(|(id, count, seen)| events::from_finding(id, *count, seen))
                .collect()
        } else {
            Vec::new()
        };
        let deliveries = self.address(&events, endpoints);
        let position = serde_json::to_string(&position).unwrap_or_default();
        if self
            .queue(deliveries, vec![(store::FINDINGS_POSITION, position)])
            .await
        {
            *self.inner.findings_version.lock().expect("version lock") = version;
        }
    }

    /// One delivery per event and enabled endpoint whose filters match.
    fn address(&self, events: &[Event], endpoints: &[Endpoint]) -> Vec<NewDelivery> {
        let mut deliveries = Vec::new();
        for event in events {
            for endpoint in endpoints.iter().filter(|endpoint| {
                endpoint.enabled
                    && endpoint
                        .event_types
                        .iter()
                        .any(|kind| kind == event.event_type)
                    && endpoint
                        .project_id
                        .as_ref()
                        .is_none_or(|project| event.project_id.as_ref() == Some(project))
            }) {
                deliveries.push(NewDelivery {
                    delivery_id: uuid::Uuid::new_v4().to_string(),
                    endpoint_id: endpoint.id.clone(),
                    event_id: event.id.clone(),
                    event_type: event.event_type.to_owned(),
                    body: event.body(&self.inner.environment_id),
                    addressed: Some(endpoint.fence()),
                });
            }
        }
        deliveries
    }

    /// Queues deliveries with their source's new position; `false` when it could not.
    async fn queue(
        &self,
        deliveries: Vec<NewDelivery>,
        positions: Vec<(&'static str, String)>,
    ) -> bool {
        match self
            .inner
            .store
            .enqueue(deliveries, positions, now_ms())
            .await
        {
            Ok(abandoned) => {
                if abandoned > 0 {
                    tracing::warn!(
                        abandoned,
                        "the webhook queue is full; the oldest deliveries were abandoned"
                    );
                }
                true
            }
            Err(error) => {
                tracing::warn!(%error, "could not queue webhook deliveries");
                false
            }
        }
    }

    /// Disables the endpoints paired with a revoked client.
    async fn client_removed(&self, session_id: &str) {
        match self.inner.store.disable_paired(session_id).await {
            Ok(disabled) => {
                for endpoint in disabled {
                    self.cancel_endpoint(&endpoint);
                    tracing::warn!(
                        endpoint = %endpoint,
                        "webhook endpoint disabled: its paired MCP client was revoked"
                    );
                }
            }
            Err(error) => tracing::warn!(%error, "could not disable paired webhook endpoints"),
        }
    }

    /// Disables the enabled endpoints whose paired client's session is revoked or gone.
    async fn reconcile_pairings(&self) {
        match self.inner.store.orphaned_pairings().await {
            Ok(sessions) => {
                for session in sessions {
                    self.client_removed(&session).await;
                }
            }
            Err(error) => tracing::warn!(%error, "could not check paired webhook clients"),
        }
    }

    /// Webhooks turned off (or found off at start): drop what is in flight, abandon the
    /// queue and forget the positions.
    async fn turned_off(&self) {
        self.cancel_all();
        match self.inner.store.abandon_all_pending().await {
            Ok(0) => {}
            Ok(abandoned) => tracing::info!(
                abandoned,
                "webhooks turned off; queued deliveries abandoned"
            ),
            Err(error) => tracing::warn!(%error, "could not abandon queued webhook deliveries"),
        }
        if let Err(error) = self.inner.store.clear_positions().await {
            tracing::warn!(%error, "could not reset the webhook positions");
        }
        *self.inner.findings_version.lock().expect("version lock") = None;
    }
}

/// The dispatcher's loop: read the sources, start due deliveries, sleep until something is
/// due, a source may have changed, a setting changed or a client was removed.
async fn run(webhooks: Webhooks) {
    let inner = webhooks.inner.clone();
    let mut enabled_signal = inner.enabled.clone();
    let mut was_enabled: Option<bool> = None;
    let mut in_flight: JoinSet<String> = JoinSet::new();
    let mut busy: HashSet<String> = HashSet::new();
    let mut last_prune: Option<tokio::time::Instant> = None;
    match inner.store.fail_interrupted_sends().await {
        Ok(0) => {}
        Ok(interrupted) => tracing::warn!(
            interrupted,
            "webhook test or redelivery sends were cut off by a stop"
        ),
        Err(error) => tracing::warn!(%error, "could not close interrupted webhook sends"),
    }
    loop {
        inner
            .passes
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        if inner.shutdown.is_cancelled() {
            break;
        }
        let enabled = *enabled_signal.borrow_and_update();
        if was_enabled != Some(enabled) {
            if !enabled {
                webhooks.turned_off().await;
            }
            was_enabled = Some(enabled);
        }
        // Off, nothing is read: the loop waits for the setting (or a wake) and checks again
        // at most once a minute.
        let mut wait = if enabled { inner.poll } else { IDLE_WAIT };
        if enabled {
            // Before any delivery: a revoked paired client's endpoints never get another.
            webhooks.reconcile_pairings().await;
            match inner.store.endpoints().await {
                Ok(endpoints) => {
                    webhooks.follow_feed(&endpoints).await;
                    webhooks.follow_findings(&endpoints).await;
                }
                Err(error) => tracing::warn!(%error, "could not read webhook endpoints"),
            }
            // A slot goes only to an endpoint whose send lock is free now: one held by a test
            // event or a redelivery is skipped (its end wakes the loop), so a waiter never
            // takes a slot from an endpoint that is ready.
            let mut held: Vec<String> = Vec::new();
            if in_flight.len() < MAX_IN_FLIGHT {
                match inner
                    .store
                    .due(now_ms(), busy.iter().cloned().collect(), usize::MAX)
                    .await
                {
                    Ok(due) => {
                        for delivery in due {
                            if in_flight.len() >= MAX_IN_FLIGHT {
                                break;
                            }
                            let Ok(turn) =
                                webhooks.send_lock(&delivery.endpoint_id).try_lock_owned()
                            else {
                                held.push(delivery.endpoint_id.clone());
                                continue;
                            };
                            busy.insert(delivery.endpoint_id.clone());
                            let webhooks = webhooks.clone();
                            in_flight.spawn(async move {
                                let endpoint = delivery.endpoint_id.clone();
                                webhooks.deliver(delivery, Some(turn)).await;
                                endpoint
                            });
                        }
                    }
                    Err(error) => tracing::warn!(%error, "could not read due webhook deliveries"),
                }
            }
            // With every slot taken, the next completion wakes the loop, not a due time.
            if in_flight.len() < MAX_IN_FLIGHT
                && let Ok(Some(next)) = inner
                    .store
                    .next_due_ms(busy.iter().chain(&held).cloned().collect())
                    .await
            {
                let until = u64::try_from(next.saturating_sub(now_ms())).unwrap_or(0);
                wait = wait.min(Duration::from_millis(until.max(50)));
            }
            if last_prune.is_none_or(|at| at.elapsed() >= PRUNE_EVERY) {
                last_prune = Some(tokio::time::Instant::now());
                if let Err(error) = inner.store.prune().await {
                    tracing::warn!(%error, "could not prune the webhook delivery log");
                }
            }
        }
        tokio::select! {
            () = inner.shutdown.cancelled() => break,
            _ = enabled_signal.changed() => {}
            () = inner.wake.notified() => {}
            Some(done) = in_flight.join_next(), if !in_flight.is_empty() => {
                if let Ok(endpoint) = done {
                    busy.remove(&endpoint);
                }
            }
            () = tokio::time::sleep(wait) => {}
        }
    }
    // Shutdown cancelled every endpoint token; the requests end at once.
    while in_flight.join_next().await.is_some() {}
}
