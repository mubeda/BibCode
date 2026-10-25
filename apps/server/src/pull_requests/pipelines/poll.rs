//! The pipelines cooperative poller (GitLab): one per `(host, project, list
//! key)`, reference counted across the subscribers that share it. Each
//! `pipelines.subscribe` RPC call is already spawned by the exempt
//! `production/pipelines_rpc.rs`; this module runs the tick loop inside that
//! call instead of spawning a background task (forbidden everywhere else in
//! `pull_requests`, see the `mod.rs` tripwires).
//!
//! A tick reads the list's first page every 20 s and each subscribed
//! pipeline that is not terminal every 10 s (at most three per key, in join
//! order; 20 s after 30 quiet minutes). It stores the rows that changed and
//! names them; the views answer the names with `readSnapshot`. It never
//! reads `count`, jobs or logs. A pipeline seen terminal is read once more
//! and then left.
//!
//! It mirrors the merge request poller's lease, driver hand-off, broadcast
//! and per-subscriber delivery (`gitlab/poll.rs`) and shares its policy that
//! must not diverge: the host-wide 429 ladder, the logout fences and the
//! snapshot store. It differs in one rule: a `forbidden` or `not_found` on
//! one pipeline is about that pipeline, so the poller stops reading it and
//! keeps polling the rest. A refused list ends the key's subscribers; a lost
//! sign-in ends them all.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex, MutexGuard},
    time::Duration,
};

use futures_util::{StreamExt, stream};
use tokio::{sync::broadcast, time::Instant};
use tokio_util::sync::CancellationToken;

use super::{
    DETAIL_KIND, LIST_KIND, PipelineHost, decode_row, detail_fingerprint, detail_key,
    list_fingerprint,
    model::{Changed, Detail, ListInput, ListPage},
    store_row,
};
use crate::{
    persistence::Database,
    pull_requests::{
        backoff::HostBackoff,
        error::PullRequestsOperationError,
        gitlab::poll::WriteOutcome,
        host::{HostContext, HostScope},
        snapshot_store::{self, HostFences, SnapshotStore},
    },
};

/// The list read's cadence, and a quiet pipeline's.
const IDLE: Duration = Duration::from_secs(20);
/// A watched pipeline that is not terminal.
const ACTIVE: Duration = Duration::from_secs(10);
/// After this long without a change, a pipeline drops to 20 s.
const QUIET_AFTER: Duration = Duration::from_secs(30 * 60);
/// Pipelines per list key read on the fast cadence, in join order.
const ACTIVE_PIPELINES: usize = 3;
/// Pipeline reads run in the subscriber's own task, at most this many at once.
const READS_AT_ONCE: usize = 3;
/// Ticks are at least 10 s apart: 16 is about 160 s of events.
const EVENT_CAPACITY: usize = 16;
/// A terminal pipeline is read this many times, then left.
const TERMINAL_READS: u8 = 2;

type Key = (String, String, String);

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|p| p.into_inner())
}

struct Entry {
    shared: Arc<Shared>,
    ref_count: usize,
}

/// One poller per repository and list key; `join`/`release` share one lock,
/// so a lease never resurrects a cancelled poller.
#[derive(Default)]
pub(crate) struct Registry {
    entries: Mutex<HashMap<Key, Entry>>,
}

impl Registry {
    fn join(&self, key: Key, pipeline: Option<u64>) -> Lease<'_> {
        let mut entries = lock(&self.entries);
        let entry = entries.entry(key.clone()).or_insert_with(|| Entry {
            shared: Arc::new(Shared::default()),
            ref_count: 0,
        });
        entry.ref_count += 1;
        let shared = entry.shared.clone();
        if let Some(pipeline) = pipeline {
            shared.watch(pipeline);
        }
        let events = shared.events.subscribe();
        drop(entries);
        Lease {
            registry: self,
            key,
            pipeline,
            shared,
            events,
        }
    }

    /// An action made this pipeline run again: every poller of the project
    /// that watches it reads it on its next tick, even one that had left it
    /// as terminal.
    pub(crate) fn rearm(&self, host: &str, project: &str, pipeline: u64) {
        let entries = lock(&self.entries);
        for (key, entry) in entries.iter() {
            if key.0 != host || key.1 != project {
                continue;
            }
            let watchers = lock(&entry.shared.watchers);
            if !watchers.iter().any(|w| w.pipeline == pipeline) {
                continue;
            }
            let mut state = lock(&entry.shared.state);
            let watched = state.pipelines.entry(pipeline).or_default();
            // Its stored row may still say terminal: it is not checked again.
            *watched = PipelineState {
                checked: true,
                revision: watched.revision,
                ..PipelineState::default()
            };
        }
    }

    fn release(&self, lease: &Lease<'_>) -> Option<Arc<Shared>> {
        let mut entries = lock(&self.entries);
        if let Some(pipeline) = lease.pipeline {
            lease.shared.unwatch(pipeline);
        }
        let entry = entries.get_mut(&lease.key)?;
        entry.ref_count -= 1;
        if entry.ref_count > 0 {
            return None;
        }
        let shared = entry.shared.clone();
        entries.remove(&lease.key);
        Some(shared)
    }
}

struct Lease<'a> {
    registry: &'a Registry,
    key: Key,
    pipeline: Option<u64>,
    shared: Arc<Shared>,
    events: broadcast::Receiver<Tick>,
}

impl Drop for Lease<'_> {
    fn drop(&mut self) {
        if let Some(shared) = self.registry.release(self) {
            shared.cancellation.cancel();
        }
    }
}

struct Watcher {
    pipeline: u64,
    subscribers: usize,
}

/// The poller's view of one pipeline, kept in `Shared` so a driver hand-off
/// keeps it.
#[derive(Default)]
struct PipelineState {
    last_read: Option<Instant>,
    last_change: Option<Instant>,
    /// Reads that saw it terminal.
    terminal_reads: u8,
    /// Terminal and read again, or refused: never read again.
    done: bool,
    /// Its stored row was checked before the first read.
    checked: bool,
    /// The generation of its last stored row or refusal, cumulative.
    revision: i64,
}

#[derive(Default)]
struct PollState {
    ticked: bool,
    last_list: Option<Instant>,
    failing: bool,
    list_revision: i64,
    pipelines: HashMap<u64, PipelineState>,
}

struct Shared {
    cancellation: CancellationToken,
    driver_lock: tokio::sync::Mutex<()>,
    events: broadcast::Sender<Tick>,
    /// Lock order: `watchers`, then `state`.
    watchers: Mutex<Vec<Watcher>>,
    state: Mutex<PollState>,
    failure: Mutex<Option<PullRequestsOperationError>>,
}

impl Default for Shared {
    fn default() -> Self {
        let (events, _) = broadcast::channel(EVENT_CAPACITY);
        Self {
            cancellation: CancellationToken::new(),
            driver_lock: tokio::sync::Mutex::new(()),
            events,
            watchers: Mutex::default(),
            state: Mutex::default(),
            failure: Mutex::default(),
        }
    }
}

impl Shared {
    fn watch(&self, pipeline: u64) {
        let mut watchers = lock(&self.watchers);
        match watchers.iter_mut().find(|w| w.pipeline == pipeline) {
            Some(watcher) => watcher.subscribers += 1,
            None => watchers.push(Watcher {
                pipeline,
                subscribers: 1,
            }),
        }
    }

    fn unwatch(&self, pipeline: u64) {
        let mut watchers = lock(&self.watchers);
        let Some(index) = watchers.iter().position(|w| w.pipeline == pipeline) else {
            return;
        };
        watchers[index].subscribers = watchers[index].subscribers.saturating_sub(1);
        if watchers[index].subscribers == 0 {
            watchers.remove(index);
            lock(&self.state).pipelines.remove(&pipeline);
        }
    }

    fn outcome(&self) -> Result<(), PullRequestsOperationError> {
        match lock(&self.failure).clone() {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    fn fail(&self, error: PullRequestsOperationError) {
        *lock(&self.failure) = Some(error);
        self.cancellation.cancel();
    }

    /// The first `ACTIVE_PIPELINES` watched pipelines still read, in join
    /// order: a terminal or refused one gives its place to the next.
    fn eligible(watchers: &[Watcher], state: &PollState) -> Vec<u64> {
        watchers
            .iter()
            .map(|w| w.pipeline)
            .filter(|id| !state.pipelines.get(id).is_some_and(|p| p.done))
            .take(ACTIVE_PIPELINES)
            .collect()
    }

    fn cadence(state: &PipelineState, now: Instant) -> Duration {
        if state.last_change.is_some_and(|at| now - at >= QUIET_AFTER) {
            IDLE
        } else {
            ACTIVE
        }
    }

    fn next_delay(&self) -> Duration {
        let watchers = lock(&self.watchers);
        let state = lock(&self.state);
        if !state.ticked {
            // The mount's own unary reads cover the start.
            return if watchers.is_empty() { IDLE } else { ACTIVE };
        }
        let now = Instant::now();
        Self::eligible(&watchers, &state)
            .iter()
            .map(|id| {
                state
                    .pipelines
                    .get(id)
                    .map_or(ACTIVE, |pipeline| Self::cadence(pipeline, now))
            })
            .min()
            .unwrap_or(IDLE)
    }

    /// The watched pipelines due this tick.
    fn due(&self, now: Instant) -> Vec<(u64, bool)> {
        let watchers = lock(&self.watchers);
        let mut state = lock(&self.state);
        Self::eligible(&watchers, &state)
            .into_iter()
            .filter_map(|id| {
                let pipeline = state.pipelines.entry(id).or_default();
                let due = !pipeline.done
                    && pipeline
                        .last_read
                        .is_none_or(|at| now - at >= Self::cadence(pipeline, now));
                due.then_some((id, pipeline.checked))
            })
            .collect()
    }

    fn tick(&self) -> Tick {
        let watchers = lock(&self.watchers);
        let state = lock(&self.state);
        Tick {
            list: state.list_revision,
            pipelines: watchers
                .iter()
                .map(|w| {
                    (
                        w.pipeline,
                        state.pipelines.get(&w.pipeline).map_or(0, |p| p.revision),
                    )
                })
                .collect(),
        }
    }
}

/// One tick, published to every subscriber of the key: the cumulative
/// revisions of the list and of every watched pipeline.
#[derive(Clone)]
struct Tick {
    list: i64,
    pipelines: Vec<(u64, i64)>,
}

/// What one subscriber has been sent.
struct Delivery {
    pipeline: Option<u64>,
    list: i64,
    pipeline_revision: i64,
}

impl Delivery {
    fn forward(&mut self, tick: &Tick, emit: &(dyn Fn(Changed) -> bool + Send + Sync)) {
        let revision = self.pipeline.and_then(|id| {
            tick.pipelines
                .iter()
                .find(|(pipeline, _)| *pipeline == id)
                .map(|(_, revision)| *revision)
        });
        let changed = Changed {
            list: tick.list > self.list,
            pipeline: revision.is_some_and(|revision| revision > self.pipeline_revision),
        };
        if !changed.any() {
            return;
        }
        // Advance only what the stream accepted; the rest is re-sent with the
        // next tick, which carries every revision cumulatively.
        if emit(changed) {
            self.list = self.list.max(tick.list);
            if let Some(revision) = revision {
                self.pipeline_revision = self.pipeline_revision.max(revision);
            }
        }
    }
}

enum Class {
    RateLimited(Option<Duration>),
    SignedOut,
    Refused,
    Other,
}

fn classify(error: &PullRequestsOperationError) -> Class {
    match error.code {
        "rate_limited" => Class::RateLimited(
            error
                .retry_after_seconds
                .map(|seconds| Duration::from_secs(seconds.into())),
        ),
        "not_authenticated" => Class::SignedOut,
        "forbidden" | "not_found" => Class::Refused,
        _ => Class::Other,
    }
}

/// What a subscriber needs to drive the key's poller.
pub(crate) struct PollInputs<'a> {
    pub registry: &'a Registry,
    pub host: &'a dyn PipelineHost,
    pub database: &'a Database,
    pub fences: &'a HostFences,
    pub backoff: &'a HostBackoff,
    pub scope: &'a HostScope,
    /// The list's first page.
    pub list: &'a ListInput,
    pub list_key: &'a str,
}

enum TickEnd {
    Done,
    RateLimited(Option<Duration>),
    /// A lost sign-in, or a refused list: every subscriber of the key ends.
    Ended(PullRequestsOperationError),
}

struct TickReport {
    end: TickEnd,
    /// The first other failure of the tick: its code.
    failure: Option<&'static str>,
}

async fn stored(
    database: &Database,
    scope: &HostScope,
    kind: &'static str,
    key: String,
) -> Option<snapshot_store::Snapshot> {
    let host = scope.host.to_ascii_lowercase();
    let project = scope.repository.clone();
    database
        .call(
            move |connection| Ok(SnapshotStore::new(connection).get(&host, &project, kind, &key)?),
        )
        .await
        .ok()
        .flatten()
}

/// A stored row a tick need not write again: the same fingerprint, read by
/// the same account. A row another account stored never paints for this
/// one, so it is replaced even when nothing changed on the host.
fn unchanged(row: &snapshot_store::Snapshot, fingerprint: &str, login: &str) -> bool {
    row.fingerprint == fingerprint
        && decode_row::<serde::de::IgnoredAny>(&row.payload, login).is_some()
}

impl PollInputs<'_> {
    async fn tick_list(
        &self,
        shared: &Shared,
        context: &HostContext,
        generation: i64,
        c: &CancellationToken,
    ) -> Result<(), PullRequestsOperationError> {
        let read = self
            .host
            .list(self.scope, context, self.list, false, c)
            .await?;
        let fingerprint = list_fingerprint(&read.rows);
        let row = stored(
            self.database,
            self.scope,
            LIST_KIND,
            self.list_key.to_owned(),
        )
        .await;
        if row
            .as_ref()
            .is_some_and(|row| unchanged(row, &fingerprint, &context.account.login))
        {
            return Ok(());
        }
        // The poller never reads `count`: it keeps the stored total.
        let total = row
            .and_then(|row| decode_row::<ListPage>(&row.payload, &context.account.login))
            .and_then(|page| page.total);
        let page = ListPage {
            revision: generation,
            rows: read.rows,
            next_cursor: read.next_cursor,
            total,
            workflows: None,
        };
        if shared.cancellation.is_cancelled() {
            return Ok(());
        }
        if store_row(
            self.database,
            self.fences,
            self.scope,
            &context.account.login,
            LIST_KIND,
            self.list_key,
            fingerprint,
            &page,
            generation,
        )
        .await
            == WriteOutcome::Written
        {
            lock(&shared.state).list_revision = generation;
        }
        Ok(())
    }

    /// Stores a changed pipeline row; true when it was written.
    async fn store_pipeline(
        &self,
        shared: &Shared,
        context: &HostContext,
        detail: &mut Detail,
        generation: i64,
    ) -> bool {
        let key = detail_key(detail.pipeline.id, None);
        let fingerprint = detail_fingerprint(detail);
        let row = stored(self.database, self.scope, DETAIL_KIND, key.clone()).await;
        if row.is_some_and(|row| unchanged(&row, &fingerprint, &context.account.login))
            || shared.cancellation.is_cancelled()
        {
            return false;
        }
        detail.revision = generation;
        store_row(
            self.database,
            self.fences,
            self.scope,
            &context.account.login,
            DETAIL_KIND,
            &key,
            fingerprint,
            detail,
            generation,
        )
        .await
            == WriteOutcome::Written
    }

    /// A pipeline this account cannot read: its rows go, and it is named
    /// once so its view shows the refusal.
    async fn refuse_pipeline(&self, id: u64) {
        let host = self.scope.host.to_ascii_lowercase();
        let project = self.scope.repository.clone();
        let _ = self
            .database
            .call(move |connection| {
                Ok(SnapshotStore::new(connection).delete_keyed(
                    &host,
                    &project,
                    DETAIL_KIND,
                    &id.to_string(),
                    true,
                )?)
            })
            .await;
    }

    async fn run_tick(
        &self,
        shared: &Shared,
        generation: i64,
        c: &CancellationToken,
    ) -> TickReport {
        let started = Instant::now();
        let mut failure = None;
        // Rows carry the login of the context the reads ran under; without a
        // known one the poller reads and writes nothing.
        let Some(context) = self.host.known_context(self.scope) else {
            return TickReport {
                end: TickEnd::Done,
                failure: None,
            };
        };
        let list_due = {
            let mut state = lock(&shared.state);
            state.ticked = true;
            let due = state.last_list.is_none_or(|at| started - at >= IDLE);
            if due {
                state.last_list = Some(started);
            }
            due
        };
        if list_due && let Err(error) = self.tick_list(shared, &context, generation, c).await {
            match classify(&error) {
                Class::RateLimited(hint) => {
                    return TickReport {
                        end: TickEnd::RateLimited(hint),
                        failure,
                    };
                }
                Class::SignedOut | Class::Refused => {
                    return TickReport {
                        end: TickEnd::Ended(error),
                        failure,
                    };
                }
                Class::Other => failure = Some(error.code),
            }
        }

        let mut due = Vec::new();
        for (id, checked) in shared.due(started) {
            if !checked {
                // The mount's own `get` stored the row: a pipeline already
                // terminal there is not read at all.
                let row =
                    stored(self.database, self.scope, DETAIL_KIND, detail_key(id, None)).await;
                let terminal = row
                    .and_then(|row| decode_row::<Detail>(&row.payload, &context.account.login))
                    .is_some_and(|detail| detail.pipeline.terminal);
                let mut state = lock(&shared.state);
                let pipeline = state.pipelines.entry(id).or_default();
                pipeline.checked = true;
                if terminal {
                    pipeline.done = true;
                    continue;
                }
            }
            due.push(id);
        }
        let results: Vec<(u64, Result<Detail, PullRequestsOperationError>)> = stream::iter(due)
            .map(|id| {
                let context = &context;
                async move { (id, self.host.detail(self.scope, context, id, None, c).await) }
            })
            .buffered(READS_AT_ONCE)
            .collect()
            .await;

        let mut end = TickEnd::Done;
        for (id, result) in results {
            match result {
                Ok(mut detail) => {
                    let terminal = detail.pipeline.terminal;
                    let written = self
                        .store_pipeline(shared, &context, &mut detail, generation)
                        .await;
                    let mut state = lock(&shared.state);
                    let pipeline = state.pipelines.entry(id).or_default();
                    pipeline.last_read = Some(started);
                    if written || pipeline.last_change.is_none() {
                        pipeline.last_change = Some(started);
                    }
                    if written {
                        pipeline.revision = generation;
                    }
                    if terminal {
                        pipeline.terminal_reads += 1;
                        pipeline.done = pipeline.terminal_reads >= TERMINAL_READS;
                    }
                }
                Err(error) => match classify(&error) {
                    Class::RateLimited(hint) => {
                        if matches!(end, TickEnd::Done) {
                            end = TickEnd::RateLimited(hint);
                        }
                    }
                    Class::SignedOut => end = TickEnd::Ended(error),
                    Class::Refused => {
                        self.refuse_pipeline(id).await;
                        let mut state = lock(&shared.state);
                        let pipeline = state.pipelines.entry(id).or_default();
                        pipeline.done = true;
                        pipeline.revision = generation;
                    }
                    Class::Other => {
                        failure.get_or_insert(error.code);
                        lock(&shared.state)
                            .pipelines
                            .entry(id)
                            .or_default()
                            .last_read = Some(started);
                    }
                },
            }
        }
        TickReport { end, failure }
    }
}

/// Forwards every published tick until `wait` resolves; `None` means the
/// subscriber or the whole poller was cancelled first.
async fn forward_until<T>(
    events: &mut broadcast::Receiver<Tick>,
    wait: impl std::future::Future<Output = T>,
    forward: &mut impl FnMut(&Tick),
    c: &CancellationToken,
    shared_cancel: &CancellationToken,
) -> Option<T> {
    tokio::pin!(wait);
    loop {
        tokio::select! {
            biased;
            () = c.cancelled() => return None,
            () = shared_cancel.cancelled() => return None,
            value = &mut wait => return Some(value),
            received = events.recv() => match received {
                Ok(tick) => forward(&tick),
                // The next received tick carries every revision missed.
                Err(broadcast::error::RecvError::Lagged(_)) => {}
                Err(broadcast::error::RecvError::Closed) => return None,
            },
        }
    }
}

/// Runs one subscriber's share of the poll loop until `c` is cancelled or
/// the poller ends. At most one subscriber per key drives host reads at a
/// time; the rest wait for the driver lock and take over if it leaves. Every
/// subscriber receives each tick and emits what it has not been sent yet.
pub(crate) async fn run_subscriber(
    inputs: &PollInputs<'_>,
    pipeline: Option<u64>,
    emit: &(dyn Fn(Changed) -> bool + Send + Sync),
    c: &CancellationToken,
) -> Result<(), PullRequestsOperationError> {
    let host_key = inputs.scope.host.to_ascii_lowercase();
    let key = (
        host_key.clone(),
        inputs.scope.repository.clone(),
        inputs.list_key.to_owned(),
    );
    let mut lease = inputs.registry.join(key, pipeline);
    let shared = lease.shared.clone();
    // The client stands its own refresh timer down on this first event.
    emit(Changed::default());
    // A joining subscriber is not sent the rows its `readSnapshot` painted.
    let list = stored(
        inputs.database,
        inputs.scope,
        LIST_KIND,
        inputs.list_key.to_owned(),
    )
    .await
    .map_or(0, |row| row.generation);
    let pipeline_revision = match pipeline {
        Some(id) => stored(
            inputs.database,
            inputs.scope,
            DETAIL_KIND,
            detail_key(id, None),
        )
        .await
        .map_or(0, |row| row.generation),
        None => 0,
    };
    #[cfg(test)]
    test_progress::JOINED.with(|joined| joined.set(joined.get() + 1));
    let mut delivery = Delivery {
        pipeline,
        list,
        pipeline_revision,
    };
    let mut forward = |tick: &Tick| delivery.forward(tick, emit);
    let Some(_permit) = forward_until(
        &mut lease.events,
        shared.driver_lock.lock(),
        &mut forward,
        c,
        &shared.cancellation,
    )
    .await
    else {
        return shared.outcome();
    };
    loop {
        let mut deadline = Instant::now() + shared.next_delay();
        if let Some(until) = inputs.backoff.backoff_until(&host_key) {
            deadline = deadline.max(until);
        }
        loop {
            if forward_until(
                &mut lease.events,
                tokio::time::sleep_until(deadline),
                &mut forward,
                c,
                &shared.cancellation,
            )
            .await
            .is_none()
            {
                return shared.outcome();
            }
            // Another reader of this host may have backed off meanwhile.
            match inputs.backoff.backoff_until(&host_key) {
                Some(until) if until > Instant::now() => deadline = until,
                _ => break,
            }
        }
        if c.is_cancelled() || shared.cancellation.is_cancelled() {
            return shared.outcome();
        }
        let generation = snapshot_store::next_generation();
        let started = Instant::now();
        #[cfg(test)]
        let ticking = test_progress::Ticking::enter();
        let report = inputs.run_tick(&shared, generation, c).await;
        let _ = shared.events.send(shared.tick());
        #[cfg(test)]
        drop(ticking);
        if c.is_cancelled() {
            continue;
        }
        let failed = match report.end {
            TickEnd::Ended(error) => {
                tracing::warn!(code = error.code, "the GitLab pipelines poller ended");
                shared.fail(error.clone());
                return Err(error);
            }
            TickEnd::RateLimited(hint) => {
                let delay = inputs.backoff.back_off(&host_key, hint);
                Some(("rate_limited", delay))
            }
            TickEnd::Done => report.failure.map(|code| (code, shared.next_delay())),
        };
        let mut state = lock(&shared.state);
        match failed {
            Some((code, delay)) => {
                if !state.failing {
                    state.failing = true;
                    tracing::warn!(
                        operation = "pipelines.subscribe",
                        code,
                        delay_seconds = delay.as_secs(),
                        "GitLab pipelines poller ticks are failing"
                    );
                }
            }
            None => {
                let was_backing_off = inputs.backoff.recovered(&host_key, started);
                if state.failing || was_backing_off {
                    state.failing = false;
                    tracing::debug!("GitLab pipelines poller ticks recovered");
                }
            }
        }
    }
}

/// Progress the paused-clock tests wait on instead of real time, per test
/// thread: subscribers that finished joining, and ticks in flight.
#[cfg(test)]
pub(super) mod test_progress {
    use std::cell::Cell;

    thread_local! {
        pub(crate) static JOINED: Cell<usize> = const { Cell::new(0) };
        pub(crate) static TICKING: Cell<usize> = const { Cell::new(0) };
    }

    pub(crate) struct Ticking;

    impl Ticking {
        pub(crate) fn enter() -> Self {
            TICKING.with(|ticking| ticking.set(ticking.get() + 1));
            Self
        }
    }

    impl Drop for Ticking {
        fn drop(&mut self) {
            TICKING.with(|ticking| ticking.set(ticking.get().saturating_sub(1)));
        }
    }
}
