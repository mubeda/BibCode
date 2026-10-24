//! One cooperative poller per `(host, project, list key)`, reference counted
//! across the subscribers that share it. Each `subscribe` RPC call is already
//! spawned by the exempt `production/pull_requests_rpc.rs`; this module runs
//! the tick loop inside that call instead of spawning a background task
//! (forbidden everywhere else in `pull_requests`, see the `mod.rs` tripwires).
//!
//! A tick reads the list page every 20 s and probes every subscribed merge
//! request (`GET merge_requests/:iid`). A number a subscriber has open on
//! Conversation or Pipelines whose pipeline is running is *active*: it is
//! probed, and its pipeline read through GraphQL, every 10 s, and the poller
//! stores one `pipeline` row holding the header, the stages and the jobs. A
//! number that may settle soon (a transient merge status, a push, a pipeline
//! that just finished) is *fast*: probed every 10 s for at most six ticks.
//! At most three numbers per list key are active or fast; the rest are probed
//! every 20 s. The poller never runs the detail, timeline, commits, checks or
//! files reads: it names what changed, and the client answers the names with
//! `readSnapshot` or the unary reads, which store their own rows.
//!
//! Names travel as per-name revisions in the probe row, so every subscriber
//! of a number gets every change, whichever poller saw it first, and catches
//! up after a dropped or lagged event. A 429 backs off every poller of the
//! host (60, 120, then 300 s); a sign-in failure ends the poller.
//!
//! See `docs/plans/2026-10-24-gitlab-live-pipeline-design.md`, which amends
//! `docs/superpowers/specs/2026-10-08-gitlab-merge-request-background-sync-design.md`.

use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex, MutexGuard,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use futures_util::{StreamExt, stream};
use tokio::{sync::broadcast, time::Instant};
use tokio_util::sync::CancellationToken;

use crate::persistence::Database;

use super::{
    GitLabHost,
    parse::{self, Combined, GraphRead, PipelineGraph, Probe},
    refresh::{
        ListFingerprint, ProbeFingerprint, Raised, RefreshNames, detail_refresh, list_changed,
        pipeline_fingerprint,
    },
};
use crate::pull_requests::{
    error::PullRequestsOperationError,
    host::HostScope,
    model::{
        Changed, ListPage, ListQuery, ListRow, Pipeline, PipelineCopy, PipelineStatus,
        PullRequestState, SubscribeTab,
    },
    snapshot_store::{self, HostFences, Snapshot as StoredSnapshot, SnapshotStore},
};

/// The list read's cadence, and an idle number's probe.
const IDLE: Duration = Duration::from_secs(20);
/// An active or fast number's probe (and an active number's pipeline read).
const ACTIVE: Duration = Duration::from_secs(10);
/// After this long with no stage-tier change, an active number drops to 20 s.
const QUIET_AFTER: Duration = Duration::from_secs(30 * 60);
const FAST_TICKS: u8 = 6;
/// Numbers per list key that may be active or fast, in join order.
const ACTIVE_NUMBERS: usize = 3;
/// Probes run in the subscriber's own task, at most this many at once.
const PROBES_AT_ONCE: usize = 3;
/// Fixed 429 backoff ladder: 60s, then 120s, then 300s, holding at 300s for
/// any further consecutive 429. A success resets the ladder to its first
/// step for the next 429.
const BACKOFF_STEPS: [Duration; 3] = [
    Duration::from_secs(60),
    Duration::from_secs(120),
    Duration::from_secs(300),
];
/// Ticks are at least 10 s apart, so 16 is about 160 s of events: a
/// subscriber that falls this far behind has a stuck stream. It skips the
/// lagged ticks instead of blocking the driver and catches up from the next
/// one it receives, because revisions are cumulative.
const EVENT_CAPACITY: usize = 16;
/// The probe row: the fingerprint the next tick compares against, and the
/// per-name revisions as its payload.
const PROBE_KIND: &str = "probe";
pub(crate) const PIPELINE_KIND: &str = "pipeline";
/// GitLab is still computing mergeability, or waiting on the pipeline.
const TRANSIENT_MERGE_STATUSES: [&str; 5] = [
    "unchecked",
    "checking",
    "preparing",
    "approvals_syncing",
    "ci_still_running",
];

type Key = (String, String, String);

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|p| p.into_inner())
}

struct Entry {
    shared: Arc<Shared>,
    ref_count: usize,
}

#[derive(Clone, Copy)]
struct Backoff {
    until: Instant,
    step: usize,
}

/// One poller per repository and list key; `join`/`release` are serialized by
/// the same lock so a lease can never resurrect an already-cancelled poller.
/// The 429 backoff and the logout fence are per lowercased host, because
/// GitLab limits are per user: every poller of the host waits, and a driver
/// hand-off or a re-keyed subscription inherits the deadline.
#[derive(Default)]
pub(crate) struct Registry {
    entries: Mutex<HashMap<Key, Entry>>,
    backoff: Mutex<HashMap<String, Backoff>>,
    fences: HostFences,
}

impl Registry {
    pub(crate) fn fences(&self) -> &HostFences {
        &self.fences
    }

    fn join(&self, key: Key, number: Option<u64>, watching: bool) -> Lease<'_> {
        let mut entries = lock(&self.entries);
        let entry = entries.entry(key.clone()).or_insert_with(|| Entry {
            shared: Arc::new(Shared::default()),
            ref_count: 0,
        });
        entry.ref_count += 1;
        let shared = entry.shared.clone();
        if let Some(number) = number {
            shared.watch(number, watching);
        }
        let events = shared.events.subscribe();
        drop(entries);
        Lease {
            registry: self,
            key,
            number,
            watching,
            shared,
            events,
        }
    }

    fn release(&self, lease: &Lease<'_>) -> Option<Arc<Shared>> {
        let mut entries = lock(&self.entries);
        if let Some(number) = lease.number {
            lease.shared.unwatch(number, lease.watching);
        }
        if let Some(entry) = entries.get_mut(&lease.key) {
            entry.ref_count -= 1;
            if entry.ref_count == 0 {
                let shared = entry.shared.clone();
                entries.remove(&lease.key);
                return Some(shared);
            }
        }
        None
    }

    fn backoff_until(&self, host: &str) -> Option<Instant> {
        lock(&self.backoff).get(host).map(|backoff| backoff.until)
    }

    /// Takes the host's next ladder step and returns its delay.
    fn back_off(&self, host: &str) -> Duration {
        let mut backoff = lock(&self.backoff);
        let entry = backoff.entry(host.to_owned()).or_insert(Backoff {
            until: Instant::now(),
            step: 0,
        });
        let delay = BACKOFF_STEPS[entry.step.min(BACKOFF_STEPS.len() - 1)];
        entry.until = Instant::now() + delay;
        entry.step = (entry.step + 1).min(BACKOFF_STEPS.len() - 1);
        delay
    }

    /// A successful tick clears the host's ladder; true when it was set.
    fn recovered(&self, host: &str) -> bool {
        lock(&self.backoff).remove(host).is_some()
    }
}

struct Lease<'a> {
    registry: &'a Registry,
    key: Key,
    number: Option<u64>,
    watching: bool,
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

/// One subscribed number: its subscribers, and those on Conversation or
/// Pipelines, the tabs that show the pipeline.
struct Watcher {
    number: u64,
    subscribers: usize,
    watching: usize,
}

#[derive(Clone, Copy, Default, Debug, PartialEq, Eq)]
enum Mode {
    #[default]
    Idle,
    Fast,
    Active,
    /// Active, but without a stage-tier change for 30 minutes: every 20 s.
    Quiet,
}

/// The poller's view of one number, kept in `Shared` so a driver hand-off
/// keeps it.
#[derive(Default)]
struct NumberState {
    last_probe: Option<Instant>,
    mode: Mode,
    fast_left: u8,
    last_stage_change: Option<Instant>,
    /// A pipeline GraphQL says is not the diff-head pipeline.
    older: Option<u64>,
    /// A pipeline whose jobs this account cannot read.
    no_jobs: Option<u64>,
    /// The REST and GraphQL reads named different pipelines last time.
    race: bool,
    previous: Option<ProbeFingerprint>,
    raised: Raised,
}

#[derive(Default)]
struct PollState {
    ticked: bool,
    last_list: Option<Instant>,
    failing: bool,
    numbers: HashMap<u64, NumberState>,
}

struct Shared {
    cancellation: CancellationToken,
    driver_lock: tokio::sync::Mutex<()>,
    events: broadcast::Sender<Tick>,
    /// Subscribed numbers in join order, changed under the registry lock.
    /// Lock order: `watchers`, then `state`.
    watchers: Mutex<Vec<Watcher>>,
    state: Mutex<PollState>,
    /// The sign-in failure that ended this poller, for every subscriber.
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
    fn watch(&self, number: u64, watching: bool) {
        let mut watchers = lock(&self.watchers);
        let index = match watchers.iter().position(|w| w.number == number) {
            Some(index) => index,
            None => {
                watchers.push(Watcher {
                    number,
                    subscribers: 0,
                    watching: 0,
                });
                watchers.len() - 1
            }
        };
        watchers[index].subscribers += 1;
        watchers[index].watching += usize::from(watching);
    }

    fn unwatch(&self, number: u64, watching: bool) {
        let mut watchers = lock(&self.watchers);
        let Some(index) = watchers.iter().position(|w| w.number == number) else {
            return;
        };
        let watcher = &mut watchers[index];
        watcher.subscribers = watcher.subscribers.saturating_sub(1);
        watcher.watching = watcher.watching.saturating_sub(usize::from(watching));
        if watcher.subscribers == 0 {
            watchers.remove(index);
            lock(&self.state).numbers.remove(&number);
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

    fn next_delay(&self) -> Duration {
        let watchers = lock(&self.watchers);
        let state = lock(&self.state);
        if !state.ticked {
            // The mount's own live reads cover the start.
            return if watchers.iter().any(|w| w.watching > 0) {
                ACTIVE
            } else {
                IDLE
            };
        }
        let fast = eligible(&watchers).iter().any(|number| {
            state
                .numbers
                .get(number)
                .is_some_and(|s| matches!(s.mode, Mode::Active | Mode::Fast))
        });
        if fast { ACTIVE } else { IDLE }
    }

    /// The numbers due this tick, in join order.
    fn plans(&self, now: Instant) -> Vec<Plan> {
        let watchers = lock(&self.watchers);
        let mut state = lock(&self.state);
        let eligible = eligible(&watchers);
        watchers
            .iter()
            .filter_map(|watcher| {
                let number = watcher.number;
                let s = state.numbers.entry(number).or_default();
                let eligible = eligible.contains(&number);
                let mode = if eligible { s.mode } else { Mode::Idle };
                let due = match mode {
                    Mode::Active | Mode::Fast => true,
                    Mode::Idle | Mode::Quiet => s.last_probe.is_none_or(|at| now - at >= IDLE),
                };
                due.then_some(Plan {
                    number,
                    eligible,
                    was_active: matches!(mode, Mode::Active | Mode::Quiet),
                    seen: s.previous.as_ref().map(|p| p.pipeline_id),
                    older: s.older,
                    no_jobs: s.no_jobs,
                })
            })
            .collect()
    }

    fn raised_numbers(&self) -> Vec<(u64, Raised)> {
        let watchers = lock(&self.watchers);
        let state = lock(&self.state);
        watchers
            .iter()
            .map(|w| {
                (
                    w.number,
                    state
                        .numbers
                        .get(&w.number)
                        .map(|s| s.raised)
                        .unwrap_or_default(),
                )
            })
            .collect()
    }

    /// Records what one probe saw and picks the number's next cadence.
    fn after_probe(
        &self,
        plan: &Plan,
        probe: &Probe,
        graph: &GraphUse,
        write: Option<&NumberWrite>,
        now: Instant,
    ) {
        let mut state = lock(&self.state);
        let s = state.numbers.entry(plan.number).or_default();
        s.last_probe = Some(now);
        if let Some(write) = write {
            s.raised.merge(&write.raised);
        }
        let header_id = match &probe.header {
            Pipeline::Present(p) => Some(p.id),
            _ => None,
        };
        // A new pipeline id clears what was known about the previous one.
        if s.older.is_some() && s.older != header_id {
            s.older = None;
        }
        if s.no_jobs.is_some() && s.no_jobs != header_id {
            s.no_jobs = None;
        }
        let mut flagged = false;
        if let GraphUse::Read(read) = graph {
            match (header_id, read) {
                (Some(id), Some(graph)) if graph.id == id => {
                    s.race = false;
                    if s.older == Some(id) {
                        s.older = None;
                    }
                    if graph.stages.is_none() {
                        s.no_jobs = Some(id);
                    }
                }
                (Some(id), None) => {
                    flagged |= s.older != Some(id);
                    s.older = Some(id);
                    s.race = false;
                }
                (_, Some(_)) => {
                    flagged = true;
                    s.race = true;
                }
                (None, None) => s.race = false,
            }
        }
        let next = &probe.fingerprint;
        let previous = s.previous.as_ref();
        let fingerprint_changed = previous != Some(next);
        if s.mode == Mode::Fast {
            s.fast_left = s.fast_left.saturating_sub(1);
        }
        let open = probe.state == PullRequestState::Open;
        let older_known = header_id.is_some() && s.older == header_id;
        let active = plan.eligible
            && open
            && !older_known
            && matches!(&probe.header, Pipeline::Present(p) if is_active(p.status));
        let transient = TRANSIENT_MERGE_STATUSES.contains(&next.detailed_merge_status.as_str());
        let pushed = previous.is_some_and(|p| {
            p.sha != next.sha && (header_id.is_none() || p.pipeline_id == next.pipeline_id)
        });
        let settled = previous.is_some_and(|p| p.pipeline_status != next.pipeline_status)
            && matches!(&probe.header, Pipeline::Present(p) if is_settled(p.status));
        let condition = transient || pushed || settled || s.race || older_known;
        if !plan.eligible || !open || active || !condition {
            s.fast_left = 0;
        } else if fingerprint_changed || flagged {
            // An episode starts at a change; it lasts at most six fast ticks.
            s.fast_left = FAST_TICKS;
        }
        s.mode = if active {
            let written = write.is_some_and(|w| w.pipeline_written);
            if written || !matches!(s.mode, Mode::Active | Mode::Quiet) {
                s.last_stage_change = Some(now);
            }
            if s.last_stage_change
                .is_some_and(|at| now - at >= QUIET_AFTER)
            {
                Mode::Quiet
            } else {
                Mode::Active
            }
        } else if s.fast_left > 0 {
            Mode::Fast
        } else {
            s.race = false;
            Mode::Idle
        };
        s.previous = Some(next.clone());
    }
}

/// The first `ACTIVE_NUMBERS` numbers, in join order, with a subscriber on
/// Conversation or Pipelines.
fn eligible(watchers: &[Watcher]) -> Vec<u64> {
    watchers
        .iter()
        .filter(|w| w.watching > 0)
        .take(ACTIVE_NUMBERS)
        .map(|w| w.number)
        .collect()
}

/// A pipeline that is on its way. `manual` and `scheduled` wait for a person
/// or a timer, so nothing changes until they act.
fn is_active(status: PipelineStatus) -> bool {
    matches!(
        status,
        PipelineStatus::Created
            | PipelineStatus::Queued
            | PipelineStatus::Waiting
            | PipelineStatus::Running
            | PipelineStatus::Canceling
    )
}

fn is_settled(status: PipelineStatus) -> bool {
    matches!(
        status,
        PipelineStatus::Success
            | PipelineStatus::Failed
            | PipelineStatus::Canceled
            | PipelineStatus::Skipped
            | PipelineStatus::Manual
    )
}

/// One number due this tick, with what the poller knew before probing it.
#[derive(Clone)]
struct Plan {
    number: u64,
    eligible: bool,
    was_active: bool,
    /// The pipeline id this poller's previous probe saw; `None` before one.
    seen: Option<Option<u64>>,
    older: Option<u64>,
    no_jobs: Option<u64>,
}

impl Plan {
    /// Active numbers read the pipeline. The tick that first sees a pipeline
    /// leave the active set reads it once more for the final stages, and a
    /// new pipeline id is read once, so the strip never shows another
    /// pipeline's stages. The mount's own `get` covers the first probe.
    fn reads_pipeline(&self, probe: &Probe) -> bool {
        let Pipeline::Present(p) = &probe.header else {
            return false;
        };
        let active = probe.state == PullRequestState::Open
            && is_active(p.status)
            && self.older != Some(p.id);
        let new_id = self.seen.is_some_and(|seen| seen != Some(p.id));
        self.eligible && self.no_jobs != Some(p.id) && (active || self.was_active || new_id)
    }
}

/// One tick, published to every subscriber of the key: whether the list
/// page changed, and every subscribed number's current revisions.
#[derive(Clone)]
struct Tick {
    list: bool,
    numbers: Vec<(u64, Raised)>,
}

/// What one subscriber has been sent.
struct Delivery {
    number: Option<u64>,
    tab: Option<SubscribeTab>,
    delivered: Raised,
    /// A `list` name an emit could not deliver, sent with the next event.
    list: bool,
}

impl Delivery {
    fn forward(&mut self, tick: &Tick, emit: &(dyn Fn(Changed) -> bool + Send + Sync)) {
        self.list |= tick.list;
        let raised = self.number.and_then(|number| {
            tick.numbers
                .iter()
                .find(|(n, _)| *n == number)
                .map(|(_, raised)| *raised)
        });
        let mut changed = raised
            .map(|raised| raised.newer_than(&self.delivered, self.tab))
            .unwrap_or_default();
        changed.list = self.list;
        if !changed.any() {
            return;
        }
        // Advance only what the stream accepted; the rest is re-sent.
        if emit(changed) {
            self.list = false;
            if let Some(raised) = raised {
                self.delivered.merge(&raised);
            }
        }
    }
}

enum Class {
    RateLimited,
    SignedOut,
    Other,
}

fn classify(error: &PullRequestsOperationError) -> Class {
    match error.code {
        "rate_limited" => Class::RateLimited,
        "not_authenticated" | "forbidden" => Class::SignedOut,
        _ => Class::Other,
    }
}

fn enum_string<T: serde::Serialize>(value: &T) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_default()
}

fn list_row_fingerprint(row: &ListRow) -> ListFingerprint {
    ListFingerprint {
        updated_at: row.updated_at.clone(),
        state: enum_string(&row.state),
        checks_summary: row.checks_summary.as_ref().map(enum_string),
        review_decision: row.review_decision.as_ref().map(enum_string),
        comment_count: row.comment_count,
        approvals: row.approvals.as_ref().map(|a| (a.approved, a.required)),
        unresolved_threads: row.unresolved_threads,
    }
}

fn row_fingerprints(rows: &[ListRow]) -> Vec<ListFingerprint> {
    rows.iter().map(list_row_fingerprint).collect()
}

/// The stored list fingerprint; the unary `list` read stores the same one, so
/// the next tick does not report a page the client has just read as changed.
pub(crate) fn list_fingerprint(page: &ListPage) -> String {
    serde_json::to_string(&row_fingerprints(&page.rows)).unwrap_or_default()
}

/// What happened to one display write.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum WriteOutcome {
    Written,
    /// A row of the same or a newer generation was already stored.
    Older,
    /// The host's fence (a logout or sign-in failure) postdates the read.
    Fenced,
    Failed(&'static str),
}

/// A short, content-free code for a failed write.
fn sqlite_code(error: &rusqlite::Error) -> &'static str {
    use rusqlite::ffi::ErrorCode;
    match error.sqlite_error_code() {
        Some(ErrorCode::DatabaseBusy) => "busy",
        Some(ErrorCode::DatabaseLocked) => "locked",
        Some(ErrorCode::DiskFull) => "disk_full",
        Some(ErrorCode::ReadOnly) => "read_only",
        Some(ErrorCode::ConstraintViolation) => "constraint",
        _ => "sqlite",
    }
}

fn log_failed_write(kind: &str, code: &'static str) {
    tracing::warn!(kind, code, "pull request snapshot write failed");
}

/// Rows key on the lowercased host, matching `read_snapshot` and host
/// deletes. The fence check runs on the database worker, so a logout's delete
/// queued before this write has already raised it.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn store(
    database: &Database,
    fences: &HostFences,
    host: &str,
    project: &str,
    kind: &'static str,
    key: &str,
    fingerprint: String,
    payload: Vec<u8>,
    generation: i64,
) -> WriteOutcome {
    let host = host.to_ascii_lowercase();
    let project = project.to_owned();
    let key = key.to_owned();
    let fences = fences.clone();
    let result = database
        .call(move |connection| {
            if fences.blocks(&host, generation) {
                return Ok(Ok(WriteOutcome::Fenced));
            }
            Ok(SnapshotStore::new(connection)
                .put(StoredSnapshot {
                    host,
                    project,
                    kind: kind.to_owned(),
                    key,
                    fingerprint,
                    payload,
                    observed_at_ms: snapshot_store::now_ms(),
                    generation,
                })
                .map(|written| {
                    if written {
                        WriteOutcome::Written
                    } else {
                        WriteOutcome::Older
                    }
                }))
        })
        .await;
    let outcome = match result {
        Ok(Ok(outcome)) => outcome,
        Ok(Err(error)) => WriteOutcome::Failed(sqlite_code(&error)),
        Err(_) => WriteOutcome::Failed("database"),
    };
    if let WriteOutcome::Failed(code) = outcome {
        log_failed_write(kind, code);
    }
    outcome
}

async fn load_fingerprint(
    database: &Database,
    host: &str,
    project: &str,
    kind: &'static str,
    key: &str,
) -> Option<String> {
    let host = host.to_ascii_lowercase();
    let project = project.to_owned();
    let key = key.to_owned();
    database
        .call(
            move |connection| Ok(SnapshotStore::new(connection).get(&host, &project, kind, &key)?),
        )
        .await
        .ok()
        .flatten()
        .map(|snapshot| snapshot.fingerprint)
}

/// The revisions already stored for `number`: a joining subscriber starts
/// from them, since its mount reads live anyway.
async fn load_raised(database: &Database, host: &str, project: &str, number: u64) -> Raised {
    let host = host.to_ascii_lowercase();
    let project = project.to_owned();
    database
        .call(move |connection| {
            Ok(SnapshotStore::new(connection).get(
                &host,
                &project,
                PROBE_KIND,
                &number.to_string(),
            )?)
        })
        .await
        .ok()
        .flatten()
        .map(|row| Raised::decode(&row.payload))
        .unwrap_or_default()
}

/// What the GraphQL pipeline read gave this tick.
enum GraphUse {
    NotRead,
    Read(Option<PipelineGraph>),
    Failed,
}

/// What the pipeline row is built from this tick.
enum PipelineInput {
    /// Nothing: the GraphQL read failed or named another pipeline.
    Skip,
    /// The REST header alone, written when it moved.
    Header,
    Graph(Option<PipelineGraph>),
}

struct NumberWrite {
    raised: Raised,
    pipeline_written: bool,
}

enum ProbeResult {
    Skipped,
    Failed(PullRequestsOperationError),
    Probed(Box<Probe>, GraphReadResult),
}

type GraphReadResult = Option<Result<Option<PipelineGraph>, PullRequestsOperationError>>;

struct TickInputs<'a> {
    host: &'a GitLabHost,
    database: &'a Database,
    fences: &'a HostFences,
    scope: &'a HostScope,
    list_query: &'a ListQuery,
    list_key: &'a str,
    shared: &'a Shared,
    c: &'a CancellationToken,
}

enum TickEnd {
    Done,
    RateLimited,
    SignedOut(PullRequestsOperationError),
}

struct TickReport {
    tick: Tick,
    end: TickEnd,
    /// The first non-429 failure of the tick: its operation and code.
    failure: Option<(&'static str, &'static str)>,
}

impl TickInputs<'_> {
    fn host_key(&self) -> String {
        self.scope.host.to_ascii_lowercase()
    }

    async fn store_list(&self, page: &ListPage, generation: i64) -> bool {
        let (Ok(fingerprint), Ok(payload)) = (
            serde_json::to_string(&row_fingerprints(&page.rows)),
            serde_json::to_vec(page),
        ) else {
            return false;
        };
        if self.shared.cancellation.is_cancelled() {
            return false;
        }
        store(
            self.database,
            self.fences,
            &self.scope.host,
            &self.scope.repository,
            "list",
            self.list_key,
            fingerprint,
            payload,
            generation,
        )
        .await
            == WriteOutcome::Written
    }

    /// Compares and writes one number's probe and pipeline rows in one
    /// database call, against the latest stored rows, so a poller of another
    /// list key that stored the same observation first is not lost: its
    /// revisions come back instead. `None` when nothing could be written.
    async fn write_number(
        &self,
        number: u64,
        probe: &Probe,
        input: PipelineInput,
        generation: i64,
    ) -> Option<NumberWrite> {
        if self.shared.cancellation.is_cancelled() {
            return None;
        }
        let host = self.host_key();
        let project = self.scope.repository.clone();
        let key = number.to_string();
        let next = probe.fingerprint.clone();
        let header = probe.header.clone();
        let fences = self.fences.clone();
        let result = self
            .database
            .call(move |connection| {
                Ok(write_number_rows(
                    connection, &fences, &host, &project, &key, &next, &header, input, generation,
                ))
            })
            .await;
        match result {
            Ok(Ok(write)) => Some(write),
            Ok(Err((kind, error))) => {
                log_failed_write(kind, sqlite_code(&error));
                None
            }
            Err(_) => {
                log_failed_write(PROBE_KIND, "database");
                None
            }
        }
    }
}

/// The body of `write_number`, on the database worker, in one transaction.
#[allow(clippy::too_many_arguments)]
fn write_number_rows(
    connection: &mut rusqlite::Connection,
    fences: &HostFences,
    host: &str,
    project: &str,
    key: &str,
    next: &ProbeFingerprint,
    header: &Pipeline,
    input: PipelineInput,
    generation: i64,
) -> Result<NumberWrite, (&'static str, rusqlite::Error)> {
    let transaction = connection
        .transaction()
        .map_err(|error| (PROBE_KIND, error))?;
    let store = SnapshotStore::new(&transaction);
    let stored_probe = store
        .get(host, project, PROBE_KIND, key)
        .map_err(|error| (PROBE_KIND, error))?;
    let stored_raised = stored_probe
        .as_ref()
        .map(|row| Raised::decode(&row.payload))
        .unwrap_or_default();
    let unchanged = NumberWrite {
        raised: stored_raised,
        pipeline_written: false,
    };
    // A logout fenced this read, or a tick that started later already stored.
    if fences.blocks(host, generation)
        || stored_probe
            .as_ref()
            .is_some_and(|row| row.generation >= generation)
    {
        return Ok(unchanged);
    }
    let previous: Option<ProbeFingerprint> = stored_probe
        .as_ref()
        .and_then(|row| serde_json::from_str(&row.fingerprint).ok());
    let names = previous
        .as_ref()
        .map_or_else(RefreshNames::all, |previous| detail_refresh(previous, next));
    let mut raised = stored_raised;
    let mut pipeline_written = false;
    let header_moved = previous.as_ref().is_none_or(|p| {
        p.pipeline_id != next.pipeline_id
            || p.pipeline_status != next.pipeline_status
            || p.pipeline_warnings != next.pipeline_warnings
    });
    // The header alone is written only when it moved since a stored probe: a
    // first probe leaves the mount's own `get` copy, which has the stages.
    let build = match &input {
        PipelineInput::Skip => false,
        PipelineInput::Header => previous.is_some() && header_moved,
        PipelineInput::Graph(_) => true,
    };
    let stored_pipeline = if build {
        store
            .get(host, project, PIPELINE_KIND, key)
            .map_err(|error| (PIPELINE_KIND, error))?
    } else {
        None
    };
    if build {
        let lends_stages = !matches!(input, PipelineInput::Graph(Some(_)));
        let stored_copy: Option<PipelineCopy> = stored_pipeline
            .as_ref()
            .filter(|_| lends_stages)
            .and_then(|row| serde_json::from_slice(&row.payload).ok());
        let graph = match &input {
            PipelineInput::Graph(graph) => GraphRead::Read(graph.as_ref()),
            _ => GraphRead::Missing,
        };
        if let Combined::Copy(pipeline) =
            parse::combine_pipeline(header, graph, stored_copy.as_ref().map(|c| &c.pipeline))
        {
            let checks = match &input {
                PipelineInput::Graph(Some(graph)) => graph.checks.clone().map(|mut checks| {
                    checks.revision = Some(generation);
                    checks
                }),
                _ => None,
            };
            let copy = PipelineCopy {
                revision: generation,
                pipeline,
                checks,
            };
            let fingerprint = pipeline_fingerprint(&copy);
            if stored_pipeline.as_ref().map(|row| row.fingerprint.as_str())
                != Some(fingerprint.as_str())
                && let Ok(payload) = serde_json::to_vec(&copy)
                && store
                    .put(StoredSnapshot {
                        host: host.to_owned(),
                        project: project.to_owned(),
                        kind: PIPELINE_KIND.into(),
                        key: key.to_owned(),
                        fingerprint,
                        payload,
                        observed_at_ms: snapshot_store::now_ms(),
                        generation,
                    })
                    .map_err(|error| (PIPELINE_KIND, error))?
            {
                raised.pipeline = generation;
                pipeline_written = true;
            }
        }
    }
    raised.raise(&names, generation);
    if (previous.as_ref() != Some(next) || raised != stored_raised)
        && let (Ok(fingerprint), Ok(payload)) =
            (serde_json::to_string(next), serde_json::to_vec(&raised))
    {
        store
            .put(StoredSnapshot {
                host: host.to_owned(),
                project: project.to_owned(),
                kind: PROBE_KIND.into(),
                key: key.to_owned(),
                fingerprint,
                payload,
                observed_at_ms: snapshot_store::now_ms(),
                generation,
            })
            .map_err(|error| (PROBE_KIND, error))?;
    }
    transaction.commit().map_err(|error| (PROBE_KIND, error))?;
    Ok(NumberWrite {
        raised,
        pipeline_written,
    })
}

async fn run_tick(t: &TickInputs<'_>, generation: i64) -> TickReport {
    let started = Instant::now();
    let mut failure = None;
    let mut list = false;
    let list_due = {
        let mut state = lock(&t.shared.state);
        state.ticked = true;
        let due = state.last_list.is_none_or(|at| started - at >= IDLE);
        if due {
            state.last_list = Some(started);
        }
        due
    };
    if list_due {
        let previous: Vec<ListFingerprint> = load_fingerprint(
            t.database,
            &t.scope.host,
            &t.scope.repository,
            "list",
            t.list_key,
        )
        .await
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();
        let read = t
            .host
            .poll_list(
                t.scope,
                t.list_query,
                |rows| list_changed(&previous, &row_fingerprints(rows)),
                t.c,
            )
            .await;
        match read {
            Ok((page, changed)) => {
                list = changed && t.store_list(&page, generation).await;
            }
            Err(error) => match classify(&error) {
                Class::RateLimited => {
                    return TickReport {
                        tick: Tick {
                            list,
                            numbers: t.shared.raised_numbers(),
                        },
                        end: TickEnd::RateLimited,
                        failure,
                    };
                }
                Class::SignedOut => {
                    return TickReport {
                        tick: Tick {
                            list,
                            numbers: Vec::new(),
                        },
                        end: TickEnd::SignedOut(error),
                        failure,
                    };
                }
                Class::Other => failure = Some(("pullRequests.list", error.code)),
            },
        }
    }

    let plans = t.shared.plans(started);
    let stop = AtomicBool::new(false);
    let stops = |error: &PullRequestsOperationError| {
        if matches!(classify(error), Class::RateLimited | Class::SignedOut) {
            stop.store(true, Ordering::Relaxed);
        }
    };
    let results: Vec<(Plan, ProbeResult)> = stream::iter(plans)
        .map(|plan| {
            let stop = &stop;
            let stops = &stops;
            async move {
                if stop.load(Ordering::Relaxed) {
                    return (plan, ProbeResult::Skipped);
                }
                match t.host.probe(t.scope, plan.number, t.c).await {
                    Err(error) => {
                        stops(&error);
                        (plan, ProbeResult::Failed(error))
                    }
                    Ok(probe) => {
                        let graph = if plan.reads_pipeline(&probe) {
                            let graph = t.host.pipeline_graph(t.scope, plan.number, t.c).await;
                            if let Err(error) = &graph {
                                stops(error);
                            }
                            Some(graph)
                        } else {
                            None
                        };
                        (plan, ProbeResult::Probed(Box::new(probe), graph))
                    }
                }
            }
        })
        .buffered(PROBES_AT_ONCE)
        .collect()
        .await;

    let mut end = TickEnd::Done;
    for (plan, result) in results {
        let (probe, graph) = match result {
            ProbeResult::Skipped => continue,
            ProbeResult::Failed(error) => {
                // One number's failure neither drops a stored list change nor
                // another number's names.
                match classify(&error) {
                    Class::RateLimited => {
                        if matches!(end, TickEnd::Done) {
                            end = TickEnd::RateLimited;
                        }
                    }
                    Class::SignedOut => end = TickEnd::SignedOut(error),
                    Class::Other => {
                        failure.get_or_insert(("pullRequests.subscribe", error.code));
                    }
                }
                continue;
            }
            ProbeResult::Probed(probe, graph) => (probe, graph),
        };
        if matches!(end, TickEnd::SignedOut(_)) {
            continue;
        }
        let graph = match graph {
            None => GraphUse::NotRead,
            Some(Ok(graph)) => GraphUse::Read(graph),
            Some(Err(error)) => {
                match classify(&error) {
                    Class::RateLimited => {
                        if matches!(end, TickEnd::Done) {
                            end = TickEnd::RateLimited;
                        }
                    }
                    Class::SignedOut => {
                        end = TickEnd::SignedOut(error);
                        continue;
                    }
                    Class::Other => {
                        failure.get_or_insert(("pullRequests.subscribe", error.code));
                    }
                }
                GraphUse::Failed
            }
        };
        let header_id = match &probe.header {
            Pipeline::Present(p) => Some(p.id),
            _ => None,
        };
        let input = match &graph {
            GraphUse::NotRead => PipelineInput::Header,
            GraphUse::Failed => PipelineInput::Skip,
            // A push or a same-commit rerun between the two reads: no copy
            // this tick, and the number stays fast until they agree.
            GraphUse::Read(Some(read)) if Some(read.id) != header_id => PipelineInput::Skip,
            GraphUse::Read(read) => PipelineInput::Graph(read.clone()),
        };
        let write = t.write_number(plan.number, &probe, input, generation).await;
        t.shared
            .after_probe(&plan, &probe, &graph, write.as_ref(), started);
    }
    let numbers = if matches!(end, TickEnd::SignedOut(_)) {
        Vec::new()
    } else {
        t.shared.raised_numbers()
    };
    TickReport {
        tick: Tick { list, numbers },
        end,
        failure,
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
/// every other subscriber for this key has already left. At most one
/// subscriber per key drives host reads at a time: the rest wait for the
/// driver lock, so a dropped driver hands the loop to another live subscriber
/// instead of stopping it. Every subscriber, driving or waiting, receives each
/// tick and emits what it has not been sent yet. A sign-in failure from any
/// read ends the poller, and every subscriber returns it.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn run_subscriber(
    registry: &Registry,
    host: &GitLabHost,
    database: &Database,
    scope: &HostScope,
    list_query: &ListQuery,
    list_key: &str,
    number: Option<u64>,
    tab: Option<SubscribeTab>,
    emit: &(dyn Fn(Changed) -> bool + Send + Sync),
    c: &CancellationToken,
) -> Result<(), PullRequestsOperationError> {
    let host_key = scope.host.to_ascii_lowercase();
    let key = (
        host_key.clone(),
        scope.repository.clone(),
        list_key.to_owned(),
    );
    let watching = matches!(tab, Some(SubscribeTab::Conversation | SubscribeTab::Checks));
    let mut lease = registry.join(key, number, watching);
    let shared = lease.shared.clone();
    // The client stands its own refresh timer down on this first success.
    emit(Changed::default());
    let delivered = match number {
        Some(number) => load_raised(database, &host_key, &scope.repository, number).await,
        None => Raised::default(),
    };
    #[cfg(all(test, unix))]
    test_progress::JOINED.with(|joined| joined.set(joined.get() + 1));
    let mut delivery = Delivery {
        number,
        tab,
        delivered,
        list: false,
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
    let inputs = TickInputs {
        host,
        database,
        fences: registry.fences(),
        scope,
        list_query,
        list_key,
        shared: &shared,
        c,
    };
    loop {
        let mut deadline = Instant::now() + shared.next_delay();
        if let Some(until) = registry.backoff_until(&host_key) {
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
            // Another poller of this host may have backed off meanwhile.
            match registry.backoff_until(&host_key) {
                Some(until) if until > Instant::now() => deadline = until,
                _ => break,
            }
        }
        if c.is_cancelled() || shared.cancellation.is_cancelled() {
            return shared.outcome();
        }
        let generation = snapshot_store::next_generation();
        #[cfg(all(test, unix))]
        let ticking = test_progress::Ticking::enter();
        let report = run_tick(&inputs, generation).await;
        let _ = shared.events.send(report.tick);
        #[cfg(all(test, unix))]
        drop(ticking);
        if c.is_cancelled() {
            continue;
        }
        let failed = match report.end {
            TickEnd::SignedOut(error) => {
                tracing::warn!(
                    code = error.code,
                    "a sign-in failure ended the GitLab poller"
                );
                shared.fail(error.clone());
                return Err(error);
            }
            TickEnd::RateLimited => {
                let delay = registry.back_off(&host_key);
                Some(("pullRequests.subscribe", "rate_limited", delay))
            }
            TickEnd::Done => report
                .failure
                .map(|(operation, code)| (operation, code, shared.next_delay())),
        };
        let mut state = lock(&shared.state);
        match failed {
            Some((operation, code, delay)) => {
                if !state.failing {
                    state.failing = true;
                    tracing::warn!(
                        operation,
                        code,
                        delay_seconds = delay.as_secs(),
                        "GitLab poller ticks are failing"
                    );
                }
            }
            None => {
                let was_backing_off = registry.recovered(&host_key);
                if state.failing || was_backing_off {
                    state.failing = false;
                    tracing::debug!("GitLab poller ticks recovered");
                }
            }
        }
    }
}

/// Progress the paused-clock tests wait on instead of a fixed amount of real
/// time, per test thread: subscribers that finished joining, and ticks in
/// flight. A tick in flight is the only work a test cannot see from outside.
#[cfg(all(test, unix))]
mod test_progress {
    use std::cell::Cell;

    thread_local! {
        pub(super) static JOINED: Cell<usize> = const { Cell::new(0) };
        pub(super) static TICKING: Cell<usize> = const { Cell::new(0) };
    }

    /// Counts one tick from its start until its event is broadcast, or until
    /// the subscriber driving it is dropped mid-tick.
    pub(super) struct Ticking;

    impl Ticking {
        pub(super) fn enter() -> Self {
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

#[cfg(all(test, unix))]
fn default_list_query(cwd: &std::path::Path) -> ListQuery {
    use crate::pull_requests::model::{ListSort, ListState};
    ListQuery {
        cwd: cwd.to_string_lossy().into_owned(),
        state: ListState::Open,
        search: None,
        author: None,
        assignee: None,
        reviewer: None,
        review_status: None,
        draft: None,
        labels: vec![],
        milestone: None,
        target_branch: None,
        sort: ListSort::Newest,
        cursor: None,
        refresh_totals: false,
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::{
        persistence::{Database, run_migrations},
        pull_requests::{
            host::{HostCommandRunner, PullRequestHost},
            model::PullRequestsProvider,
        },
        test_support::TestSandbox,
    };
    use futures_util::future::poll_immediate;
    use serde_json::{Value, json};
    use std::{fs, future::Future, pin::Pin};

    const MR: &str = "api projects/gitlab-org%2Fcli/merge_requests/";

    fn fixture() -> (TestSandbox, GitLabHost, HostScope) {
        let s = TestSandbox::new("pr-gitlab-poll");
        for (name, body) in [
            (
                "detail.json",
                include_str!("../../../tests/fixtures/pull_requests/gitlab_detail.json"),
            ),
            (
                "approvals.json",
                include_str!("../../../tests/fixtures/pull_requests/gitlab_approvals.json"),
            ),
            (
                "reviewers.json",
                include_str!("../../../tests/fixtures/pull_requests/gitlab_reviewers.json"),
            ),
            (
                "project.json",
                include_str!("../../../tests/fixtures/pull_requests/gitlab_project.json"),
            ),
        ] {
            fs::write(s.path(name), body).unwrap();
        }
        fs::write(s.path("version"), "17.9.1").unwrap();
        fs::write(s.path("list.json"), "[]").unwrap();
        fs::write(s.path("discussions.json"), "[]").unwrap();
        fs::write(
            s.path("metadata.json"),
            json!({"data":{"project":{"mergeRequest":{"commitCount":2,"resolvableDiscussionsCount":1,"diffStatsSummary":{"additions":7,"deletions":3,"fileCount":2},"sourceProject":{"fullPath":"contributor/cli"},"userPermissions":{"createNote":true,"pushToSourceBranch":false}}}}}).to_string(),
        )
        .unwrap();
        fs::write(
            s.path("timeline.json"),
            json!({"data":{"project":{"mergeRequest":{
                "userPermissions":{"createNote":true},
                "discussions":{"nodes":[],"pageInfo":{"hasNextPage":false,"endCursor":null}}
            }}}})
            .to_string(),
        )
        .unwrap();
        fs::write(
            s.path("pipelines.json"),
            json!([{"id":9,"project_id":2,"web_url":"https://gitlab.com/pipeline/9"}]).to_string(),
        )
        .unwrap();
        fs::write(
            s.path("jobs.json"),
            json!([{"name":"compile","stage":"build","status":"success","web_url":"https://gitlab.com/job/1","started_at":null,"finished_at":null,"duration":4.5}]).to_string(),
        )
        .unwrap();
        // A probe answers `mr-<n>.json`, else the shared detail body; a GraphQL
        // pipeline read answers `graph-<n>.json`, else "no diff-head pipeline".
        let glab = s.executable_script(
            "glab",
            r##"
printf '%s\n' "$*" >> calls
case "$1 $2" in
  'api user') echo '{"id":8,"username":"viewer","name":null}' ;;
  'api version') printf '{"version":"%s"}\n' "$(cat version)" ;;
  'api projects/gitlab-org%2Fcli') cat project.json ;;
  'mr list')
    if [ -e mr-list-wait ]; then
      while [ ! -e release ]; do sleep 0.02; done
    fi
    if [ -e rate-limited ]; then echo 'HTTP 429' >&2; exit 1; fi
    if [ -e list-error ]; then echo 'HTTP 404' >&2; exit 1; fi
    if [ -e list-signed-out ]; then echo 'HTTP 401' >&2; exit 1; fi
    cat list.json ;;
  'api -i') if [ -e totals-rate-limited ]; then echo 'HTTP 429' >&2; exit 1; fi
    printf 'HTTP/2 200 OK\r\nx-total: 0\r\n\r\n[]' ;;
  'api projects/gitlab-org%2Fcli/merge_requests/3941/approvals') cat approvals.json ;;
  'api projects/gitlab-org%2Fcli/merge_requests/3941/reviewers') cat reviewers.json ;;
  'api projects/gitlab-org%2Fcli/merge_requests/3941/approval_state') echo 'HTTP 404' >&2; exit 1 ;;
  'api projects/gitlab-org%2Fcli/merge_requests/3941/award_emoji?per_page=100&page=1') echo '[]' ;;
  'api projects/gitlab-org%2Fcli/merge_requests/3941/closes_issues?per_page=100') echo '[]' ;;
  'api projects/gitlab-org%2Fcli/merge_requests/3941/resource_label_events?per_page=100') echo '[]' ;;
  'api projects/gitlab-org%2Fcli/merge_requests/3941/resource_milestone_events?per_page=100') echo '[]' ;;
  'api projects/gitlab-org%2Fcli/merge_requests/3941/resource_state_events?per_page=100') echo '[]' ;;
  'api projects/gitlab-org%2Fcli/merge_requests/3941/pipelines?per_page=1') cat pipelines.json ;;
  'api projects/gitlab-org%2Fcli/merge_requests/'*)
    n="${2##*/}"
    if [ -e "probe-error-$n" ]; then cat "probe-error-$n" >&2; exit 1; fi
    if [ -e "mr-$n.json" ]; then cat "mr-$n.json"; else cat detail.json; fi ;;
  'api projects/2/pipelines/9/jobs?per_page=100') cat jobs.json ;;
  'api --method') test "$5" = -H && test "$6" = 'Content-Type: application/json' && test "$7" = --input || exit 65
    if grep -q 'PullRequestsGitLabPipeline' "$8"; then
      n=$(sed -n 's/.*"iid":"\([0-9]*\)".*/\1/p' "$8")
      printf '%s\n' "$n" >> graph-calls
      if [ -e graph-wait ]; then
        while [ ! -e graph-release ]; do sleep 0.02; done
      fi
      if [ -e "graph-error-$n" ]; then cat "graph-error-$n" >&2; exit 1; fi
      if [ -e "graph-$n.json" ]; then cat "graph-$n.json"
      else echo '{"data":{"project":{"mergeRequest":{"headPipeline":null}}}}'; fi
    elif grep -q 'PullRequestsGitLabTimeline' "$8"; then cat timeline.json; else cat metadata.json; fi ;;
  *) exit 64 ;;
esac
"##,
            "",
        );
        let host = GitLabHost::new(Arc::new(
            HostCommandRunner::new(s.path("state")).with_commands("missing-gh", &glab, "git"),
        ));
        let scope = HostScope {
            cwd: s.root().into(),
            host: "gitlab.com".into(),
            repository: "gitlab-org/cli".into(),
            provider: PullRequestsProvider::Gitlab,
        };
        (s, host, scope)
    }

    async fn new_database() -> Database {
        let database = Database::open_in_memory().await.expect("database");
        database
            .call(|connection| Ok(run_migrations(connection, None)?))
            .await
            .expect("migrations");
        database
    }

    fn calls(s: &TestSandbox) -> Vec<String> {
        fs::read_to_string(s.path("calls"))
            .unwrap_or_default()
            .lines()
            .map(str::to_owned)
            .collect()
    }

    fn count(s: &TestSandbox, prefix: &str) -> usize {
        calls(s)
            .iter()
            .filter(|line| line.starts_with(prefix))
            .count()
    }

    /// Probes of one number: the bare `GET merge_requests/:iid`.
    fn probes(s: &TestSandbox, number: u64) -> usize {
        let probe = format!("{MR}{number} ");
        calls(s)
            .iter()
            .filter(|line| line.starts_with(&probe))
            .count()
    }

    /// GraphQL pipeline reads, per number.
    fn graph_reads(s: &TestSandbox, number: u64) -> usize {
        fs::read_to_string(s.path("graph-calls"))
            .unwrap_or_default()
            .lines()
            .filter(|line| *line == number.to_string())
            .count()
    }

    fn lists(s: &TestSandbox) -> usize {
        count(s, "mr list")
    }

    /// A subscriber future, driven by hand instead of a forbidden spawned task
    /// (see the module doc comment): the `pullRequests.subscribe` RPC call is
    /// already spawned once by the exempt production RPC layer, and in tests
    /// that single caller task is this test function itself.
    ///
    /// `result` keeps what the inner future returned, because polling a
    /// completed `async fn` again panics, and a cancelled subscriber can
    /// finish inside any `drive`/`drive_until` call.
    struct Subscriber<'a> {
        future: Pin<Box<dyn Future<Output = Result<(), PullRequestsOperationError>> + 'a>>,
        result: Option<Result<(), PullRequestsOperationError>>,
    }

    #[allow(clippy::too_many_arguments)]
    fn pin_subscriber<'a>(
        registry: &'a Registry,
        host: &'a GitLabHost,
        database: &'a Database,
        scope: &'a HostScope,
        list_query: &'a ListQuery,
        list_key: &'a str,
        number: Option<u64>,
        tab: Option<SubscribeTab>,
        emit: &'a (dyn Fn(Changed) -> bool + Send + Sync),
        c: &'a CancellationToken,
    ) -> Subscriber<'a> {
        CREATED.with(|created| created.set(created.get() + 1));
        Subscriber {
            future: Box::pin(run_subscriber(
                registry, host, database, scope, list_query, list_key, number, tab, emit, c,
            )),
            result: None,
        }
    }

    thread_local! {
        /// Subscribers this test thread created, against `test_progress::JOINED`.
        static CREATED: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    }

    /// Every created subscriber has finished joining (its first database read)
    /// and no tick is in flight.
    fn settled() -> bool {
        test_progress::TICKING.with(|ticking| ticking.get()) == 0
            && test_progress::JOINED.with(|joined| joined.get())
                >= CREATED.with(|created| created.get())
    }

    async fn poll_all(subscribers: &mut [Subscriber<'_>]) {
        for subscriber in subscribers.iter_mut() {
            if subscriber.result.is_none()
                && let Some(result) = poll_immediate(subscriber.future.as_mut()).await
            {
                subscriber.result = Some(result);
            }
        }
    }

    /// Advances every subscriber as far as it can go without blocking, then
    /// yields so the timer/process reactor can make the next step ready.
    ///
    /// A subscriber mid-tick can be parked waiting on the database's own OS
    /// worker thread, which is genuinely separate from this paused tokio
    /// clock. `tokio::task::yield_now` only reschedules this task; it never
    /// yields real wall-clock time, so a tight busy loop of nothing else can
    /// starve that other thread of the real scheduling it needs to respond.
    /// The tiny real sleep gives it that chance without slowing down the
    /// common case, where the condition is already satisfied after the
    /// first iteration or two.
    ///
    /// A tick that came due starts on the first poll after the clock moved,
    /// so this waits until every subscriber has joined and no tick is in
    /// flight (however slow a loaded machine runs the fake `glab`), then
    /// polls a little longer so every subscriber forwards the last event.
    async fn drive(subscribers: &mut [Subscriber<'_>]) {
        drive_for(subscribers, 20).await;
        for _ in 0..30_000 {
            if settled() {
                break;
            }
            poll_all(subscribers).await;
            std::thread::sleep(Duration::from_millis(1));
            tokio::task::yield_now().await;
        }
        drive_for(subscribers, 20).await;
    }

    /// Polls for a fixed number of rounds, for a tick deliberately held open.
    async fn drive_for(subscribers: &mut [Subscriber<'_>], rounds: usize) {
        for _ in 0..rounds {
            poll_all(subscribers).await;
            std::thread::sleep(Duration::from_millis(1));
            tokio::task::yield_now().await;
        }
    }

    async fn drive_until(subscribers: &mut [Subscriber<'_>], mut condition: impl FnMut() -> bool) {
        for _ in 0..5000 {
            poll_all(subscribers).await;
            if condition() {
                return;
            }
            std::thread::sleep(Duration::from_millis(1));
            tokio::task::yield_now().await;
        }
        panic!("condition never became true");
    }

    /// Advances the paused clock by `seconds`, then lets every subscriber run
    /// what became due.
    async fn tick(subscribers: &mut [Subscriber<'_>], seconds: u64) {
        tokio::time::advance(Duration::from_secs(seconds)).await;
        drive(subscribers).await;
    }

    fn mr_value(s: &TestSandbox, number: u64) -> Value {
        let path = s.path(format!("mr-{number}.json"));
        let raw = fs::read_to_string(&path)
            .unwrap_or_else(|_| fs::read_to_string(s.path("detail.json")).unwrap());
        let mut value: Value = serde_json::from_str(&raw).unwrap();
        value["iid"] = json!(number);
        value
    }

    /// Edits the probe body one number answers.
    fn write_mr(s: &TestSandbox, number: u64, edit: impl FnOnce(&mut Value)) {
        let mut value = mr_value(s, number);
        edit(&mut value);
        fs::write(s.path(format!("mr-{number}.json")), value.to_string()).unwrap();
    }

    fn head_pipeline(value: &mut Value, id: u64, status: &str) {
        value["head_pipeline"] = json!({
            "id": id,
            "status": status,
            "ref": format!("refs/merge-requests/{}/head", value["iid"]),
            "sha": value["sha"],
            "updated_at": "2026-10-24T10:00:00Z",
            "detailed_status": {"group": status},
        });
    }

    /// The GraphQL pipeline answer: one job per stage, in the stage's status.
    fn write_graph(s: &TestSandbox, number: u64, id: u64, stages: &[(&str, &str)]) {
        let nodes: Vec<Value> = stages
            .iter()
            .map(|(name, status)| {
                json!({
                    "name": name,
                    "status": status,
                    "detailedStatus": {"name": status.to_ascii_uppercase()},
                    "jobs": {
                        "pageInfo": {"hasNextPage": false},
                        "nodes": [{
                            "name": format!("{name}-job"),
                            "status": status.to_ascii_uppercase(),
                            "allowFailure": false,
                            "webPath": format!("/gitlab-org/cli/-/jobs/{id}"),
                            "startedAt": null,
                            "finishedAt": null,
                            "duration": null,
                            "downstreamPipeline": null,
                        }],
                    },
                })
            })
            .collect();
        fs::write(
            s.path(format!("graph-{number}.json")),
            json!({"data":{"project":{"mergeRequest":{"headPipeline":{
                "id": format!("gid://gitlab/Ci::Pipeline/{id}"),
                "status": "RUNNING",
                "stages": {"nodes": nodes},
            }}}}})
            .to_string(),
        )
        .unwrap();
    }

    /// A merge request whose pipeline `id` runs, with matching GraphQL stages.
    fn running(s: &TestSandbox, number: u64, id: u64) {
        write_mr(s, number, |v| {
            head_pipeline(v, id, "running");
            v["detailed_merge_status"] = json!("ci_still_running");
        });
        write_graph(s, number, id, &[("build", "success"), ("test", "running")]);
    }

    fn probe_of(s: &TestSandbox, number: u64) -> ProbeFingerprint {
        parse::probe(&mr_value(s, number), None, "pullRequests.subscribe")
            .unwrap()
            .fingerprint
    }

    async fn seed_probe(
        database: &Database,
        scope: &HostScope,
        number: u64,
        probe: &ProbeFingerprint,
    ) {
        let host = scope.host.clone();
        let project = scope.repository.clone();
        let fingerprint = serde_json::to_string(probe).unwrap();
        database
            .call(move |connection| {
                Ok(SnapshotStore::new(connection).put(StoredSnapshot {
                    host,
                    project,
                    kind: PROBE_KIND.into(),
                    key: number.to_string(),
                    fingerprint,
                    payload: Vec::new(),
                    observed_at_ms: 0,
                    generation: 0,
                })?)
            })
            .await
            .unwrap();
    }

    async fn stored(
        database: &Database,
        host: &str,
        project: &str,
        kind: &str,
        key: &str,
    ) -> Option<StoredSnapshot> {
        let host = host.to_owned();
        let project = project.to_owned();
        let kind = kind.to_owned();
        let key = key.to_owned();
        database
            .call(move |connection| {
                Ok(SnapshotStore::new(connection).get(&host, &project, &kind, &key)?)
            })
            .await
            .unwrap()
    }

    /// Like `stored`, but safe to call while subscriber futures are still
    /// alive and resting on a timer: a bare `.await` on the database's
    /// cross-thread response can make the single paused-time test task
    /// genuinely park, and tokio's paused clock then auto-advances straight
    /// to the nearest pending subscriber sleep to unblock it, silently
    /// firing an extra tick before the test ever calls `advance` itself.
    /// Driving the subscribers on every iteration keeps the task always
    /// runnable instead, so parking (and the auto-advance) never happens.
    async fn stored_while_driving(
        subscribers: &mut [Subscriber<'_>],
        database: &Database,
        host: &str,
        project: &str,
        kind: &str,
        key: &str,
    ) -> Option<StoredSnapshot> {
        let mut future = Box::pin(stored(database, host, project, kind, key));
        for _ in 0..200 {
            poll_all(subscribers).await;
            if let Some(result) = poll_immediate(future.as_mut()).await {
                return result;
            }
            std::thread::sleep(Duration::from_millis(1));
            tokio::task::yield_now().await;
        }
        panic!("stored() query never completed");
    }

    /// Runs any database call while driving the subscribers (see above).
    async fn while_driving<T>(
        subscribers: &mut [Subscriber<'_>],
        future: impl Future<Output = T>,
    ) -> T {
        let mut future = Box::pin(future);
        for _ in 0..200 {
            poll_all(subscribers).await;
            if let Some(result) = poll_immediate(future.as_mut()).await {
                return result;
            }
            std::thread::sleep(Duration::from_millis(1));
            tokio::task::yield_now().await;
        }
        panic!("the call never completed");
    }

    type Log = Arc<Mutex<Vec<Changed>>>;

    fn emitter(log: &Log) -> impl Fn(Changed) -> bool + Send + Sync + use<> {
        let log = log.clone();
        move |changed: Changed| {
            lock(&log).push(changed);
            true
        }
    }

    /// The events after the connected one every subscriber receives on join.
    fn ticks(log: &Log) -> Vec<Changed> {
        let log = lock(log);
        assert_eq!(
            log.first(),
            Some(&Changed::default()),
            "the first event is the all-false connected event"
        );
        log[1..].to_vec()
    }

    fn list_json(updated_at: &str) -> String {
        json!([{
            "iid": 1,
            "title": "x",
            "state": "opened",
            "draft": false,
            "author": {"username": "a"},
            "created_at": "2024-01-01T00:00:00Z",
            "updated_at": updated_at,
            "source_branch": "a",
            "target_branch": "main",
            "labels": [],
            "user_notes_count": 0,
            "web_url": "https://gitlab.com/x"
        }])
        .to_string()
    }

    fn stored_copy(row: &StoredSnapshot) -> PipelineCopy {
        serde_json::from_slice(&row.payload).unwrap()
    }

    /// One poller fixture: the sandbox, host, scope, database and list key.
    struct Bench {
        s: TestSandbox,
        host: GitLabHost,
        scope: HostScope,
        database: Database,
        registry: Registry,
        list_query: ListQuery,
        list_key: String,
    }

    async fn bench() -> Bench {
        let (s, host, scope) = fixture();
        let list_query = default_list_query(s.root());
        let list_key = list_query.snapshot_key();
        Bench {
            database: new_database().await,
            registry: Registry::default(),
            s,
            host,
            scope,
            list_query,
            list_key,
        }
    }

    impl Bench {
        fn subscriber<'a>(
            &'a self,
            number: Option<u64>,
            tab: Option<SubscribeTab>,
            emit: &'a (dyn Fn(Changed) -> bool + Send + Sync),
            c: &'a CancellationToken,
        ) -> Subscriber<'a> {
            pin_subscriber(
                &self.registry,
                &self.host,
                &self.database,
                &self.scope,
                &self.list_query,
                &self.list_key,
                number,
                tab,
                emit,
                c,
            )
        }

        fn row<'a>(
            &'a self,
            subscribers: &'a mut [Subscriber<'_>],
            kind: &'a str,
            key: &'a str,
        ) -> impl Future<Output = Option<StoredSnapshot>> + 'a {
            stored_while_driving(
                subscribers,
                &self.database,
                &self.scope.host,
                &self.scope.repository,
                kind,
                key,
            )
        }
    }

    #[tokio::test(start_paused = true)]
    async fn gitlab_poller_two_subscribers_cause_one_list_command_per_tick() {
        let b = bench().await;
        let log1 = Log::default();
        let log2 = Log::default();
        let (emit1, emit2) = (emitter(&log1), emitter(&log2));
        let (c1, c2) = (CancellationToken::new(), CancellationToken::new());
        let mut subs = [
            b.subscriber(None, None, &emit1, &c1),
            b.subscriber(None, None, &emit2, &c2),
        ];
        drive(&mut subs).await;
        tokio::time::advance(Duration::from_secs(20)).await;
        drive_until(&mut subs, || lists(&b.s) >= 1).await;
        drive(&mut subs).await;
        assert_eq!(lists(&b.s), 1, "two subscribers share one tick");
        c1.cancel();
        c2.cancel();
        drive(&mut subs).await;
    }

    #[tokio::test(start_paused = true)]
    async fn gitlab_poller_dropping_the_last_subscriber_leaves_the_log_unchanged_for_a_further_20s()
    {
        let b = bench().await;
        let log = Log::default();
        let emit = emitter(&log);
        let c = CancellationToken::new();
        let mut subs = [b.subscriber(None, None, &emit, &c)];
        drive(&mut subs).await;
        tokio::time::advance(Duration::from_secs(20)).await;
        drive_until(&mut subs, || lists(&b.s) >= 1).await;
        drive(&mut subs).await;
        let after_first_tick = lists(&b.s);
        assert_eq!(after_first_tick, 1);
        drop(subs);
        tokio::time::advance(Duration::from_secs(20)).await;
        assert_eq!(
            lists(&b.s),
            after_first_tick,
            "no subscriber remains to drive another tick"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn gitlab_poller_first_tick_waits_10s_on_conversation_and_20s_elsewhere() {
        for (tab, first) in [
            (Some(SubscribeTab::Conversation), 10),
            (Some(SubscribeTab::Checks), 10),
            (Some(SubscribeTab::Commits), 20),
            (Some(SubscribeTab::Files), 20),
            (None, 20),
        ] {
            let b = bench().await;
            let log = Log::default();
            let emit = emitter(&log);
            let c = CancellationToken::new();
            let mut subs = [b.subscriber(Some(3941), tab, &emit, &c)];
            drive(&mut subs).await;
            tokio::time::advance(Duration::from_millis(first * 1000 - 1)).await;
            drive(&mut subs).await;
            assert_eq!(lists(&b.s), 0, "{tab:?} must not run before {first}s");
            tokio::time::advance(Duration::from_millis(1)).await;
            drive_until(&mut subs, || lists(&b.s) >= 1).await;
            c.cancel();
            drive(&mut subs).await;
        }
    }

    #[tokio::test(start_paused = true)]
    async fn gitlab_poller_running_pipeline_on_conversation_probes_every_10s_and_lists_every_20s() {
        let b = bench().await;
        running(&b.s, 3941, 50);
        let log = Log::default();
        let emit = emitter(&log);
        let c = CancellationToken::new();
        let mut subs = [b.subscriber(Some(3941), Some(SubscribeTab::Conversation), &emit, &c)];
        drive(&mut subs).await;
        for _ in 0..3 {
            tick(&mut subs, 10).await;
        }
        assert_eq!(
            probes(&b.s, 3941),
            3,
            "an active number is probed every 10 s"
        );
        assert_eq!(graph_reads(&b.s, 3941), 3, "and its pipeline read with it");
        assert_eq!(lists(&b.s), 2, "the list keeps its 20 s cadence");
        assert_eq!(
            count(&b.s, &format!("{MR}3941/approvals")),
            0,
            "no pipeline tick runs the detail join"
        );
        let row = b.row(&mut subs, PIPELINE_KIND, "3941").await.unwrap();
        let copy = stored_copy(&row);
        assert_eq!(copy.revision, row.generation);
        let Pipeline::Present(pipeline) = copy.pipeline else {
            panic!("a present pipeline");
        };
        assert_eq!(
            (pipeline.id, pipeline.status),
            (50, PipelineStatus::Running)
        );
        assert_eq!(pipeline.is_for_head, Some(true));
        let stages = pipeline.stages.unwrap();
        assert_eq!(stages[1].name, "test");
        assert_eq!(stages[1].status, PipelineStatus::Running);
        let checks = copy.checks.expect("the active read carries the jobs");
        assert_eq!(checks.revision, Some(row.generation));
        assert_eq!(checks.groups[0].name, "build");
        c.cancel();
        drive(&mut subs).await;
    }

    #[tokio::test(start_paused = true)]
    async fn gitlab_poller_two_subscribers_of_a_number_cause_one_pipeline_read_per_tick() {
        let b = bench().await;
        running(&b.s, 3941, 50);
        let (log1, log2) = (Log::default(), Log::default());
        let (emit1, emit2) = (emitter(&log1), emitter(&log2));
        let c = CancellationToken::new();
        let mut subs = [
            b.subscriber(Some(3941), Some(SubscribeTab::Conversation), &emit1, &c),
            b.subscriber(Some(3941), Some(SubscribeTab::Checks), &emit2, &c),
        ];
        drive(&mut subs).await;
        tick(&mut subs, 10).await;
        tick(&mut subs, 10).await;
        assert_eq!(probes(&b.s, 3941), 2);
        assert_eq!(graph_reads(&b.s, 3941), 2, "one pipeline read per tick");
        assert!(
            [&log1, &log2]
                .iter()
                .all(|log| ticks(log).iter().any(|changed| changed.pipeline)),
            "both subscribers hear the pipeline row"
        );
        c.cancel();
        drive(&mut subs).await;
    }

    #[tokio::test(start_paused = true)]
    async fn gitlab_poller_commits_tab_manual_or_scheduled_pipeline_never_reads_the_pipeline() {
        for (status, tab) in [
            ("running", SubscribeTab::Commits),
            ("running", SubscribeTab::Files),
            ("manual", SubscribeTab::Conversation),
            ("scheduled", SubscribeTab::Checks),
        ] {
            let b = bench().await;
            write_mr(&b.s, 3941, |v| head_pipeline(v, 50, status));
            write_graph(&b.s, 3941, 50, &[("test", status)]);
            let log = Log::default();
            let emit = emitter(&log);
            let c = CancellationToken::new();
            let mut subs = [b.subscriber(Some(3941), Some(tab), &emit, &c)];
            drive(&mut subs).await;
            for _ in 0..6 {
                tick(&mut subs, 10).await;
            }
            assert_eq!(graph_reads(&b.s, 3941), 0, "{status} on {tab:?}");
            assert!(
                probes(&b.s, 3941) >= 2,
                "{status} on {tab:?} is still probed"
            );
            assert!(
                probes(&b.s, 3941) <= 3,
                "{status} on {tab:?} stays at the idle 20 s cadence"
            );
            c.cancel();
            drive(&mut subs).await;
        }
    }

    #[tokio::test(start_paused = true)]
    async fn gitlab_poller_stage_only_change_writes_one_row_then_emits_pipeline_without_detail() {
        let b = bench().await;
        running(&b.s, 3941, 50);
        seed_probe(&b.database, &b.scope, 3941, &probe_of(&b.s, 3941)).await;
        let log = Log::default();
        let emit = emitter(&log);
        let c = CancellationToken::new();
        let mut subs = [b.subscriber(Some(3941), Some(SubscribeTab::Conversation), &emit, &c)];
        drive(&mut subs).await;
        tick(&mut subs, 10).await;
        let first = b.row(&mut subs, PIPELINE_KIND, "3941").await.unwrap();
        assert_eq!(
            ticks(&log),
            vec![Changed {
                pipeline: true,
                ..Changed::default()
            }]
        );
        write_graph(&b.s, 3941, 50, &[("build", "success"), ("test", "success")]);
        tick(&mut subs, 10).await;
        let second = b.row(&mut subs, PIPELINE_KIND, "3941").await.unwrap();
        assert!(second.generation > first.generation, "the row was written");
        assert_eq!(
            ticks(&log)[1..],
            [Changed {
                pipeline: true,
                ..Changed::default()
            }],
            "a stage change names only `pipeline`"
        );
        tick(&mut subs, 10).await;
        let third = b.row(&mut subs, PIPELINE_KIND, "3941").await.unwrap();
        assert_eq!(
            third.generation, second.generation,
            "an unchanged read writes nothing"
        );
        assert_eq!(ticks(&log).len(), 2, "and emits nothing");
        assert_eq!(count(&b.s, &format!("{MR}3941/approvals")), 0);
        c.cancel();
        drive(&mut subs).await;
    }

    #[tokio::test(start_paused = true)]
    async fn gitlab_poller_pipeline_turning_terminal_reads_the_final_stages_once() {
        let b = bench().await;
        running(&b.s, 3941, 50);
        let log = Log::default();
        let emit = emitter(&log);
        let c = CancellationToken::new();
        let mut subs = [b.subscriber(Some(3941), Some(SubscribeTab::Conversation), &emit, &c)];
        drive(&mut subs).await;
        tick(&mut subs, 10).await;
        assert_eq!(graph_reads(&b.s, 3941), 1);
        write_mr(&b.s, 3941, |v| {
            head_pipeline(v, 50, "success");
            v["detailed_merge_status"] = json!("mergeable");
        });
        write_graph(&b.s, 3941, 50, &[("build", "success"), ("test", "success")]);
        tick(&mut subs, 10).await;
        assert_eq!(graph_reads(&b.s, 3941), 2, "the final stages are read once");
        for _ in 0..4 {
            tick(&mut subs, 10).await;
        }
        assert_eq!(
            graph_reads(&b.s, 3941),
            2,
            "a finished pipeline is not read again"
        );
        let row = b.row(&mut subs, PIPELINE_KIND, "3941").await.unwrap();
        let Pipeline::Present(pipeline) = stored_copy(&row).pipeline else {
            panic!("a present pipeline");
        };
        assert_eq!(pipeline.status, PipelineStatus::Success);
        assert!(
            pipeline
                .stages
                .unwrap()
                .iter()
                .all(|stage| stage.status == PipelineStatus::Success)
        );
        c.cancel();
        drive(&mut subs).await;
    }

    #[tokio::test(start_paused = true)]
    async fn gitlab_poller_push_with_no_pipeline_probes_fast_and_shows_the_new_pipeline_within_one_tick()
     {
        let b = bench().await;
        write_mr(&b.s, 3941, |v| {
            v["sha"] = json!("head-1");
            head_pipeline(v, 50, "success");
        });
        seed_probe(&b.database, &b.scope, 3941, &probe_of(&b.s, 3941)).await;
        let log = Log::default();
        let emit = emitter(&log);
        let c = CancellationToken::new();
        let mut subs = [b.subscriber(Some(3941), Some(SubscribeTab::Conversation), &emit, &c)];
        drive(&mut subs).await;
        tick(&mut subs, 10).await;
        assert_eq!(probes(&b.s, 3941), 1);
        // A push: the old pipeline stays the head pipeline until GitLab
        // creates one for the new commit.
        write_mr(&b.s, 3941, |v| v["sha"] = json!("head-2"));
        tick(&mut subs, 20).await;
        assert_eq!(probes(&b.s, 3941), 2);
        assert!(ticks(&log).iter().any(|changed| changed.detail));
        // The number is fast now: the new pipeline shows on the next 10 s tick.
        write_mr(&b.s, 3941, |v| head_pipeline(v, 51, "running"));
        write_graph(&b.s, 3941, 51, &[("test", "running")]);
        tick(&mut subs, 10).await;
        assert_eq!(
            probes(&b.s, 3941),
            3,
            "a fast tick probes 10 s after the push"
        );
        let row = b.row(&mut subs, PIPELINE_KIND, "3941").await.unwrap();
        let Pipeline::Present(pipeline) = stored_copy(&row).pipeline else {
            panic!("the new pipeline");
        };
        assert_eq!(pipeline.id, 51);
        assert_eq!(pipeline.is_for_head, Some(true));
        let last = ticks(&log).last().cloned().unwrap();
        assert!(last.pipeline && last.checks && !last.detail);
        c.cancel();
        drive(&mut subs).await;
    }

    #[tokio::test(start_paused = true)]
    async fn gitlab_poller_transient_merge_status_probes_fast_for_at_most_six_ticks() {
        let b = bench().await;
        write_mr(&b.s, 3941, |v| {
            v["detailed_merge_status"] = json!("checking")
        });
        let log = Log::default();
        let emit = emitter(&log);
        let c = CancellationToken::new();
        let mut subs = [b.subscriber(Some(3941), Some(SubscribeTab::Conversation), &emit, &c)];
        drive(&mut subs).await;
        tick(&mut subs, 10).await;
        assert_eq!(
            probes(&b.s, 3941),
            1,
            "the episode starts at the first probe"
        );
        for fast in 1..=6 {
            tick(&mut subs, 10).await;
            assert_eq!(probes(&b.s, 3941), 1 + fast, "fast tick {fast}");
        }
        tick(&mut subs, 10).await;
        assert_eq!(probes(&b.s, 3941), 7, "six fast ticks at most");
        tick(&mut subs, 10).await;
        assert_eq!(probes(&b.s, 3941), 8, "then the idle 20 s cadence");
        assert_eq!(
            graph_reads(&b.s, 3941),
            0,
            "the fast state reads no pipeline"
        );
        c.cancel();
        drive(&mut subs).await;
    }

    #[tokio::test(start_paused = true)]
    async fn gitlab_poller_thirty_quiet_minutes_halve_the_active_rate() {
        let b = bench().await;
        running(&b.s, 3941, 50);
        let log = Log::default();
        let emit = emitter(&log);
        let c = CancellationToken::new();
        let mut subs = [b.subscriber(Some(3941), Some(SubscribeTab::Conversation), &emit, &c)];
        drive(&mut subs).await;
        tick(&mut subs, 10).await;
        tick(&mut subs, 30 * 60).await;
        assert_eq!(probes(&b.s, 3941), 2);
        assert_eq!(graph_reads(&b.s, 3941), 2);
        tick(&mut subs, 10).await;
        assert_eq!(
            probes(&b.s, 3941),
            2,
            "after 30 quiet minutes the 10 s tick stops"
        );
        tick(&mut subs, 10).await;
        assert_eq!(probes(&b.s, 3941), 3, "both reads drop to every 20 s");
        assert_eq!(graph_reads(&b.s, 3941), 3);
        // The next stage change restores the 10 s cadence.
        write_graph(&b.s, 3941, 50, &[("build", "success"), ("test", "failed")]);
        tick(&mut subs, 20).await;
        tick(&mut subs, 10).await;
        assert_eq!(probes(&b.s, 3941), 5, "a stage change brings 10 s back");
        c.cancel();
        drive(&mut subs).await;
    }

    #[tokio::test(start_paused = true)]
    async fn gitlab_poller_staggered_pollers_with_different_filters_both_deliver_a_shared_number_change()
     {
        let b = bench().await;
        seed_probe(&b.database, &b.scope, 3941, &probe_of(&b.s, 3941)).await;
        let mut other_query = b.list_query.clone();
        other_query.target_branch = Some("main".into());
        let other_key = other_query.snapshot_key();
        let (log_a, log_b) = (Log::default(), Log::default());
        let (emit_a, emit_b) = (emitter(&log_a), emitter(&log_b));
        let c = CancellationToken::new();
        let mut subs = vec![b.subscriber(Some(3941), None, &emit_a, &c)];
        drive(&mut subs).await;
        tick(&mut subs, 5).await;
        subs.push(pin_subscriber(
            &b.registry,
            &b.host,
            &b.database,
            &b.scope,
            &other_query,
            &other_key,
            Some(3941),
            None,
            &emit_b,
            &c,
        ));
        drive(&mut subs).await;
        // Both pollers have probed the unchanged number once.
        tick(&mut subs, 15).await;
        tick(&mut subs, 5).await;
        assert_eq!(probes(&b.s, 3941), 2);
        write_mr(&b.s, 3941, |v| {
            v["updated_at"] = json!("2026-10-24T11:00:00Z")
        });
        // Poller A sees the change first and stores the new fingerprint ...
        tick(&mut subs, 15).await;
        assert!(ticks(&log_a).iter().any(|changed| changed.detail));
        // ... and poller B, finding it already stored, still delivers it.
        tick(&mut subs, 5).await;
        assert_eq!(probes(&b.s, 3941), 4);
        assert!(
            ticks(&log_b)
                .iter()
                .any(|changed| changed.detail && changed.timeline),
            "the second poller's subscribers get the change too"
        );
        c.cancel();
        drive(&mut subs).await;
    }

    #[tokio::test(start_paused = true)]
    async fn gitlab_poller_undelivered_event_is_resent_on_the_next_tick() {
        let b = bench().await;
        let stale = ProbeFingerprint {
            updated_at: "2020-01-01T00:00:00Z".into(),
            ..probe_of(&b.s, 3941)
        };
        seed_probe(&b.database, &b.scope, 3941, &stale).await;
        fs::write(b.s.path("list.json"), list_json("2024-01-01T00:00:00Z")).unwrap();
        let log = Log::default();
        let full = Arc::new(AtomicBool::new(true));
        let emit = {
            let log = log.clone();
            let full = full.clone();
            move |changed: Changed| {
                // The connected event always fits in an empty stream.
                if changed.any() && full.load(Ordering::SeqCst) {
                    return false;
                }
                lock(&log).push(changed);
                true
            }
        };
        let c = CancellationToken::new();
        let mut subs = [b.subscriber(Some(3941), None, &emit, &c)];
        drive(&mut subs).await;
        tick(&mut subs, 20).await;
        assert!(ticks(&log).is_empty(), "the stream was full");
        full.store(false, Ordering::SeqCst);
        tick(&mut subs, 20).await;
        let resent = ticks(&log);
        assert_eq!(resent.len(), 1, "{resent:?}");
        assert!(
            resent[0].list && resent[0].detail && resent[0].timeline,
            "the held list name and the undelivered names come with the next tick"
        );
        tick(&mut subs, 20).await;
        assert_eq!(ticks(&log).len(), 1, "delivered names are not sent again");
        c.cancel();
        drive(&mut subs).await;
    }

    #[tokio::test(start_paused = true)]
    async fn gitlab_poller_lagged_receiver_catches_up_from_revisions() {
        let b = bench().await;
        let stale = ProbeFingerprint {
            updated_at: "2020-01-01T00:00:00Z".into(),
            ..probe_of(&b.s, 3941)
        };
        seed_probe(&b.database, &b.scope, 3941, &stale).await;
        let (driver_log, lagging_log) = (Log::default(), Log::default());
        let (driver_emit, lagging_emit) = (emitter(&driver_log), emitter(&lagging_log));
        let c = CancellationToken::new();
        let mut subs = vec![
            b.subscriber(None, None, &driver_emit, &c),
            b.subscriber(Some(3941), None, &lagging_emit, &c),
        ];
        drive(&mut subs).await;
        // Only the driver runs: more ticks than the broadcast holds pass the
        // waiting subscriber by.
        for _ in 0..(EVENT_CAPACITY + 2) {
            tokio::time::advance(Duration::from_secs(20)).await;
            drive(&mut subs[..1]).await;
        }
        assert!(probes(&b.s, 3941) >= EVENT_CAPACITY + 2);
        assert_eq!(
            lock(&lagging_log).len(),
            1,
            "only the connected event so far"
        );
        drive(&mut subs).await;
        assert!(
            ticks(&lagging_log)
                .iter()
                .any(|changed| changed.detail && changed.timeline),
            "the lagged subscriber catches up on the first change"
        );
        c.cancel();
        drive(&mut subs).await;
    }

    #[tokio::test(start_paused = true)]
    async fn gitlab_poller_rate_limited_backs_off_60s_then_120s_then_300s_then_resets_on_success() {
        let b = bench().await;
        fs::write(b.s.path("rate-limited"), "").unwrap();
        let log = Log::default();
        let emit = emitter(&log);
        let c = CancellationToken::new();
        let mut subs = [b.subscriber(None, None, &emit, &c)];
        let s = &b.s;
        drive(&mut subs).await;
        tokio::time::advance(Duration::from_secs(20)).await;
        drive_until(&mut subs, || lists(s) >= 1).await;
        drive(&mut subs).await;
        assert_eq!(lists(s), 1);
        tokio::time::advance(Duration::from_secs(59)).await;
        drive(&mut subs).await;
        assert_eq!(lists(s), 1, "a 429 backs off to 60s, not 20s");
        tokio::time::advance(Duration::from_secs(1)).await;
        drive_until(&mut subs, || lists(s) >= 2).await;
        drive(&mut subs).await;
        tokio::time::advance(Duration::from_secs(119)).await;
        drive(&mut subs).await;
        assert_eq!(lists(s), 2, "a second 429 backs off to 120s");
        tokio::time::advance(Duration::from_secs(1)).await;
        drive_until(&mut subs, || lists(s) >= 3).await;
        drive(&mut subs).await;
        tokio::time::advance(Duration::from_secs(299)).await;
        drive(&mut subs).await;
        assert_eq!(lists(s), 3, "a third 429 backs off to 300s, not 240s");
        assert!(
            ticks(&log).is_empty(),
            "a 429 tick must never call emit beyond the connected event"
        );
        tokio::time::advance(Duration::from_secs(1)).await;
        drive_until(&mut subs, || lists(s) >= 4).await;
        drive(&mut subs).await;
        tokio::time::advance(Duration::from_secs(299)).await;
        drive(&mut subs).await;
        assert_eq!(
            lists(s),
            4,
            "the delay stays at 300s for any further consecutive 429"
        );
        fs::remove_file(s.path("rate-limited")).unwrap();
        fs::write(s.path("list.json"), list_json("2024-01-01T00:00:00Z")).unwrap();
        tokio::time::advance(Duration::from_secs(1)).await;
        drive_until(&mut subs, || lists(s) >= 5).await;
        drive_until(&mut subs, || lock(&log).len() >= 2).await;
        assert_eq!(ticks(&log).len(), 1, "a successful tick must emit");
        fs::write(s.path("rate-limited"), "").unwrap();
        tokio::time::advance(Duration::from_secs(19)).await;
        drive(&mut subs).await;
        assert_eq!(
            lists(s),
            5,
            "a success schedules its own next tick after 20s"
        );
        tokio::time::advance(Duration::from_secs(1)).await;
        drive_until(&mut subs, || lists(s) >= 6).await;
        drive(&mut subs).await;
        tokio::time::advance(Duration::from_secs(59)).await;
        drive(&mut subs).await;
        assert_eq!(
            lists(s),
            6,
            "the 429 after a success backs off to 60s again, not 300s"
        );
        tokio::time::advance(Duration::from_secs(1)).await;
        drive_until(&mut subs, || lists(s) >= 7).await;
    }

    #[tokio::test(start_paused = true)]
    async fn gitlab_poller_rate_limited_totals_read_backs_off_the_host() {
        let b = bench().await;
        fs::write(b.s.path("totals-rate-limited"), "").unwrap();
        let log = Log::default();
        let emit = emitter(&log);
        let c = CancellationToken::new();
        let mut subs = [b.subscriber(None, None, &emit, &c)];
        drive(&mut subs).await;
        tick(&mut subs, 20).await;
        assert_eq!(lists(&b.s), 1);
        assert!(count(&b.s, "api -i") >= 1, "the totals were read");
        tick(&mut subs, 59).await;
        assert_eq!(lists(&b.s), 1, "a totals 429 backs the host off to 60 s");
        assert!(ticks(&log).is_empty());
        tick(&mut subs, 1).await;
        assert_eq!(lists(&b.s), 2);
        c.cancel();
        drive(&mut subs).await;
    }

    #[tokio::test(start_paused = true)]
    async fn gitlab_poller_reuses_totals_past_30s_and_reloads_them_on_a_list_change_or_after_5_minutes()
     {
        let b = bench().await;
        fs::write(b.s.path("list.json"), list_json("2024-01-01T00:00:00Z")).unwrap();
        let log = Log::default();
        let emit = emitter(&log);
        let c = CancellationToken::new();
        let mut subs = [b.subscriber(None, None, &emit, &c)];
        drive(&mut subs).await;
        tick(&mut subs, 20).await;
        assert_eq!(count(&b.s, "api -i"), 3, "the first tick reads the totals");
        for _ in 0..4 {
            tick(&mut subs, 20).await;
        }
        assert_eq!(
            count(&b.s, "api -i"),
            3,
            "an unchanged page reuses them past the 30 s unary bound"
        );
        fs::write(b.s.path("list.json"), list_json("2024-01-02T00:00:00Z")).unwrap();
        tick(&mut subs, 20).await;
        assert_eq!(count(&b.s, "api -i"), 6, "a changed page reloads them");
        for _ in 0..15 {
            tick(&mut subs, 20).await;
        }
        assert_eq!(count(&b.s, "api -i"), 9, "a 5-minute-old copy reloads");
        c.cancel();
        drive(&mut subs).await;
    }

    #[tokio::test(start_paused = true)]
    async fn gitlab_poller_backoff_survives_driver_hand_off_and_re_key_at_each_ladder_step() {
        let b = bench().await;
        fs::write(b.s.path("rate-limited"), "").unwrap();
        let mut other_query = b.list_query.clone();
        other_query.target_branch = Some("main".into());
        let other_key = other_query.snapshot_key();
        let log = Log::default();
        let emit = emitter(&log);
        let (c1, c2, c3) = (
            CancellationToken::new(),
            CancellationToken::new(),
            CancellationToken::new(),
        );
        let mut subs = vec![
            b.subscriber(None, None, &emit, &c1),
            b.subscriber(None, None, &emit, &c2),
        ];
        drive(&mut subs).await;
        tick(&mut subs, 20).await;
        assert_eq!(lists(&b.s), 1, "step one: a 429");
        // The driver leaves; the waiting subscriber takes over the loop.
        c1.cancel();
        tick(&mut subs, 20).await;
        assert_eq!(lists(&b.s), 1, "a hand-off inherits the 60 s deadline");
        tick(&mut subs, 40).await;
        assert_eq!(lists(&b.s), 2, "step two: a second 429, 120 s");
        // Re-keyed: a new poller for another list key of the same host.
        c2.cancel();
        drive(&mut subs).await;
        subs.push(pin_subscriber(
            &b.registry,
            &b.host,
            &b.database,
            &b.scope,
            &other_query,
            &other_key,
            None,
            None,
            &emit,
            &c3,
        ));
        drive(&mut subs).await;
        tick(&mut subs, 100).await;
        assert_eq!(
            lists(&b.s),
            2,
            "a re-keyed poller waits out the host's deadline"
        );
        tick(&mut subs, 20).await;
        assert_eq!(lists(&b.s), 3, "step three: 300 s");
        tick(&mut subs, 299).await;
        assert_eq!(lists(&b.s), 3);
        tick(&mut subs, 1).await;
        assert_eq!(lists(&b.s), 4, "and it holds at 300 s");
        c3.cancel();
        drive(&mut subs).await;
    }

    #[tokio::test(start_paused = true)]
    async fn gitlab_poller_auth_failure_ends_every_subscriber() {
        let b = bench().await;
        fs::write(b.s.path("list-signed-out"), "").unwrap();
        let (log1, log2) = (Log::default(), Log::default());
        let (emit1, emit2) = (emitter(&log1), emitter(&log2));
        let c = CancellationToken::new();
        let mut subs = [
            b.subscriber(Some(3941), Some(SubscribeTab::Conversation), &emit1, &c),
            b.subscriber(None, None, &emit2, &c),
        ];
        drive(&mut subs).await;
        tokio::time::advance(Duration::from_secs(10)).await;
        for _ in 0..5000 {
            poll_all(&mut subs).await;
            if subs_done(&subs) {
                break;
            }
            std::thread::sleep(Duration::from_millis(1));
            tokio::task::yield_now().await;
        }
        for subscriber in &subs {
            let error = subscriber.result.clone().unwrap().unwrap_err();
            assert_eq!(error.code, "not_authenticated");
        }
        tick(&mut subs, 60).await;
        assert_eq!(lists(&b.s), 1, "the ended poller reads nothing more");
    }

    #[tokio::test(start_paused = true)]
    async fn gitlab_poller_generic_host_error_does_not_emit() {
        let b = bench().await;
        fs::write(b.s.path("list-error"), "").unwrap();
        let log = Log::default();
        let emit = emitter(&log);
        let c = CancellationToken::new();
        let mut subs = [b.subscriber(None, None, &emit, &c)];
        drive(&mut subs).await;
        tick(&mut subs, 20).await;
        assert_eq!(lists(&b.s), 1);
        assert!(
            ticks(&log).is_empty(),
            "a non-429 host error must never call emit beyond the connected event"
        );
        tick(&mut subs, 20).await;
        assert_eq!(
            lists(&b.s),
            2,
            "a generic error retries at the base 20s delay, not the 429 ladder"
        );
        assert!(ticks(&log).is_empty());
        c.cancel();
        drive(&mut subs).await;
    }

    fn subs_done(subs: &[Subscriber<'_>]) -> bool {
        subs.iter().all(|subscriber| subscriber.result.is_some())
    }

    #[tokio::test(start_paused = true)]
    async fn gitlab_poller_logout_during_a_delayed_successful_pipeline_read_writes_nothing() {
        let b = bench().await;
        running(&b.s, 3941, 50);
        fs::write(b.s.path("graph-wait"), "").unwrap();
        let log = Log::default();
        let emit = emitter(&log);
        let c = CancellationToken::new();
        let mut subs = [b.subscriber(Some(3941), Some(SubscribeTab::Conversation), &emit, &c)];
        drive(&mut subs).await;
        tokio::time::advance(Duration::from_secs(10)).await;
        drive_until(&mut subs, || graph_reads(&b.s, 3941) >= 1).await;
        // The logout lands while the pipeline read is still out.
        b.registry.fences().raise(&b.scope.host);
        fs::write(b.s.path("graph-release"), "").unwrap();
        drive(&mut subs).await;
        assert!(b.row(&mut subs, PIPELINE_KIND, "3941").await.is_none());
        assert!(b.row(&mut subs, PROBE_KIND, "3941").await.is_none());
        assert!(ticks(&log).is_empty(), "a fenced read names nothing");
        c.cancel();
        drive(&mut subs).await;
    }

    #[tokio::test(start_paused = true)]
    async fn gitlab_poller_unary_get_checks_interleaved_with_a_poller_write_keeps_the_newer_copy() {
        let b = bench().await;
        running(&b.s, 3941, 50);
        let log = Log::default();
        let emit = emitter(&log);
        let c = CancellationToken::new();
        let mut subs = [b.subscriber(Some(3941), Some(SubscribeTab::Checks), &emit, &c)];
        drive(&mut subs).await;
        // A unary getChecks starts (and takes its generation) before the tick.
        let unary_started = snapshot_store::next_generation();
        tick(&mut subs, 10).await;
        let row = b.row(&mut subs, PIPELINE_KIND, "3941").await.unwrap();
        let poller = stored_copy(&row);
        // ... and answers after it, stamped with the older revision.
        let unary = b.host.checks(&b.scope, 3941, &c);
        let mut unary = while_driving(&mut subs, unary).await.unwrap();
        unary.revision = Some(unary_started);
        assert!(
            poller.checks.as_ref().unwrap().revision > unary.revision,
            "the poller's copy outranks the read that started first, whichever answered last"
        );
        assert!(poller.revision > unary_started);
        c.cancel();
        drive(&mut subs).await;
    }

    #[tokio::test(start_paused = true)]
    async fn gitlab_poller_failed_pipeline_write_raises_no_name() {
        let b = bench().await;
        running(&b.s, 3941, 50);
        seed_probe(&b.database, &b.scope, 3941, &probe_of(&b.s, 3941)).await;
        b.database
            .call(|connection| {
                connection.execute_batch(
                    "CREATE TRIGGER refuse_pipeline BEFORE INSERT ON pull_request_snapshots
                     WHEN NEW.kind = 'pipeline' BEGIN SELECT RAISE(ABORT, 'refused'); END;",
                )?;
                Ok(())
            })
            .await
            .unwrap();
        let log = Log::default();
        let emit = emitter(&log);
        let c = CancellationToken::new();
        let mut subs = [b.subscriber(Some(3941), Some(SubscribeTab::Conversation), &emit, &c)];
        drive(&mut subs).await;
        tick(&mut subs, 10).await;
        assert_eq!(graph_reads(&b.s, 3941), 1);
        assert!(ticks(&log).is_empty(), "a failed write raises no name");
        let probe = b.row(&mut subs, PROBE_KIND, "3941").await.unwrap();
        assert_eq!(probe.generation, 0, "the probe row rolled back with it");
        let database = b.database.clone();
        while_driving(
            &mut subs,
            database.call(|connection| {
                connection.execute_batch("DROP TRIGGER refuse_pipeline;")?;
                Ok(())
            }),
        )
        .await
        .unwrap();
        tick(&mut subs, 10).await;
        assert!(
            ticks(&log).iter().any(|changed| changed.pipeline),
            "the next tick writes and names it"
        );
        c.cancel();
        drive(&mut subs).await;
    }

    #[tokio::test(start_paused = true)]
    async fn gitlab_poller_probe_error_still_emits_a_stored_list_change() {
        let b = bench().await;
        fs::write(b.s.path("list.json"), list_json("2024-01-01T00:00:00Z")).unwrap();
        fs::write(b.s.path("probe-error-3941"), "HTTP 500").unwrap();
        let log = Log::default();
        let emit = emitter(&log);
        let c = CancellationToken::new();
        let mut subs = [b.subscriber(Some(3941), None, &emit, &c)];
        drive(&mut subs).await;
        tick(&mut subs, 20).await;
        assert_eq!(probes(&b.s, 3941), 1);
        assert_eq!(
            ticks(&log),
            vec![Changed {
                list: true,
                ..Changed::default()
            }]
        );
        c.cancel();
        drive(&mut subs).await;
    }

    #[tokio::test(start_paused = true)]
    async fn gitlab_poller_four_numbers_are_probed_and_three_are_active() {
        let b = bench().await;
        for number in 1..=4 {
            running(&b.s, number, 100 + number);
        }
        let logs: Vec<Log> = (0..4).map(|_| Log::default()).collect();
        let emits: Vec<_> = logs.iter().map(emitter).collect();
        let c = CancellationToken::new();
        let mut subs: Vec<_> = (1..=4)
            .map(|number| {
                b.subscriber(
                    Some(number),
                    Some(SubscribeTab::Conversation),
                    &emits[number as usize - 1],
                    &c,
                )
            })
            .collect();
        drive(&mut subs).await;
        tick(&mut subs, 10).await;
        assert!(
            (1..=4).all(|number| probes(&b.s, number) == 1),
            "all four probed"
        );
        assert!((1..=3).all(|number| graph_reads(&b.s, number) == 1));
        assert_eq!(graph_reads(&b.s, 4), 0, "the fourth stays idle");
        tick(&mut subs, 10).await;
        assert!((1..=3).all(|number| probes(&b.s, number) == 2));
        assert_eq!(probes(&b.s, 4), 1, "an idle number is probed every 20 s");
        tick(&mut subs, 10).await;
        assert_eq!(probes(&b.s, 4), 2);
        assert_eq!(graph_reads(&b.s, 4), 0);
        c.cancel();
        drive(&mut subs).await;
    }

    #[tokio::test(start_paused = true)]
    async fn gitlab_poller_non_driver_detail_subscriber_receives_its_numbers_names() {
        let b = bench().await;
        let stale = ProbeFingerprint {
            updated_at: "2020-01-01T00:00:00Z".into(),
            ..probe_of(&b.s, 3941)
        };
        seed_probe(&b.database, &b.scope, 3941, &stale).await;
        let (list_log, detail_log) = (Log::default(), Log::default());
        let (list_emit, detail_emit) = (emitter(&list_log), emitter(&detail_log));
        let c = CancellationToken::new();
        // The module's list drives; a right-panel tab has the number open. The
        // driver scheduled its first tick before that tab joined: 20 s.
        let mut subs = [
            b.subscriber(None, None, &list_emit, &c),
            b.subscriber(
                Some(3941),
                Some(SubscribeTab::Conversation),
                &detail_emit,
                &c,
            ),
        ];
        drive(&mut subs).await;
        tick(&mut subs, 20).await;
        assert_eq!(
            probes(&b.s, 3941),
            1,
            "the waiting subscriber's number is probed"
        );
        assert!(
            ticks(&detail_log)
                .iter()
                .any(|changed| changed.detail && changed.timeline)
        );
        assert!(ticks(&list_log).iter().all(|changed| !changed.detail));
        c.cancel();
        drive(&mut subs).await;
    }

    #[tokio::test(start_paused = true)]
    async fn gitlab_poller_unchanged_probe_writes_no_detail_and_emits_no_detail_bit() {
        let b = bench().await;
        seed_probe(&b.database, &b.scope, 3941, &probe_of(&b.s, 3941)).await;
        let log = Log::default();
        let emit = emitter(&log);
        let c = CancellationToken::new();
        let mut subs = [b.subscriber(Some(3941), None, &emit, &c)];
        drive(&mut subs).await;
        tokio::time::advance(Duration::from_secs(20)).await;
        drive_until(&mut subs, || probes(&b.s, 3941) >= 1).await;
        drive(&mut subs).await;
        assert!(lock(&log).iter().all(|changed| !changed.detail));
        let row = b.row(&mut subs, PROBE_KIND, "3941").await.unwrap();
        assert_eq!(row.generation, 0, "an unchanged probe rewrites nothing");
        assert!(b.row(&mut subs, "detail", "3941").await.is_none());
        assert!(
            b.row(&mut subs, PIPELINE_KIND, "3941").await.is_none(),
            "an unmoved header writes no pipeline row"
        );
        assert_eq!(
            count(&b.s, &format!("{MR}3941/approvals")),
            0,
            "an unchanged probe never runs the unary detail method"
        );
        c.cancel();
        drive(&mut subs).await;
    }

    #[tokio::test(start_paused = true)]
    async fn gitlab_poller_changed_updated_at_emits_detail_and_timeline_without_the_detail_join() {
        let b = bench().await;
        let stale = ProbeFingerprint {
            updated_at: "2020-01-01T00:00:00Z".into(),
            ..probe_of(&b.s, 3941)
        };
        seed_probe(&b.database, &b.scope, 3941, &stale).await;
        let log = Log::default();
        let emit = emitter(&log);
        let c = CancellationToken::new();
        let mut subs = [b.subscriber(Some(3941), None, &emit, &c)];
        drive(&mut subs).await;
        tokio::time::advance(Duration::from_secs(20)).await;
        drive_until(&mut subs, || lock(&log).len() >= 2).await;
        drive(&mut subs).await;
        let changed = ticks(&log)[0].clone();
        assert!(changed.detail && changed.timeline);
        assert!(!changed.commits && !changed.checks && !changed.files && !changed.pipeline);
        assert_eq!(
            count(&b.s, &format!("{MR}3941/approvals")),
            0,
            "the client answers `detail` with the unary read; the poller never joins"
        );
        assert_eq!(count(&b.s, "api --method"), 0, "no GraphQL read either");
        assert!(
            b.row(&mut subs, "detail", "3941").await.is_none(),
            "the probe body is never stored as detail"
        );
        let probe = b.row(&mut subs, PROBE_KIND, "3941").await.unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&probe.fingerprint).unwrap()["updated_at"],
            mr_value(&b.s, 3941)["updated_at"],
            "the next tick compares against the new probe"
        );
        assert!(
            Raised::decode(&probe.payload).detail > 0,
            "the revisions ride along"
        );
        c.cancel();
        drive(&mut subs).await;
    }

    #[tokio::test(start_paused = true)]
    async fn gitlab_poller_changed_pipeline_id_in_one_bucket_emits_checks_and_pipeline_without_detail()
     {
        let b = bench().await;
        let mut stale = probe_of(&b.s, 3941);
        stale.pipeline_id = Some(1);
        seed_probe(&b.database, &b.scope, 3941, &stale).await;
        let log = Log::default();
        let emit = emitter(&log);
        let c = CancellationToken::new();
        let mut subs = [b.subscriber(Some(3941), None, &emit, &c)];
        drive(&mut subs).await;
        tokio::time::advance(Duration::from_secs(20)).await;
        drive_until(&mut subs, || lock(&log).len() >= 2).await;
        drive(&mut subs).await;
        let changed = ticks(&log)[0].clone();
        assert!(changed.checks && changed.pipeline, "{changed:?}");
        assert!(!changed.detail && !changed.timeline && !changed.commits && !changed.files);
        assert_eq!(
            count(&b.s, &format!("{MR}3941/pipelines?per_page=1")),
            0,
            "the client answers `checks` with the unary read"
        );
        c.cancel();
        drive(&mut subs).await;
    }

    #[tokio::test]
    async fn gitlab_poller_a_list_write_with_generation_1_does_not_replace_generation_2() {
        let database = new_database().await;
        let fences = HostFences::default();
        assert_eq!(
            store(
                &database,
                &fences,
                "gitlab.com",
                "team/repo",
                "list",
                "key",
                "fp-2".into(),
                b"second".to_vec(),
                2,
            )
            .await,
            WriteOutcome::Written
        );
        assert_eq!(
            store(
                &database,
                &fences,
                "gitlab.com",
                "team/repo",
                "list",
                "key",
                "fp-1".into(),
                b"first".to_vec(),
                1,
            )
            .await,
            WriteOutcome::Older
        );
        let row = stored(&database, "gitlab.com", "team/repo", "list", "key")
            .await
            .unwrap();
        assert_eq!(row.payload, b"second".to_vec());
        assert_eq!(row.generation, 2);
        let fence = fences.raise("gitlab.com");
        assert_eq!(
            store(
                &database,
                &fences,
                "GitLab.com",
                "team/repo",
                "list",
                "key",
                "fp-3".into(),
                b"third".to_vec(),
                fence,
            )
            .await,
            WriteOutcome::Fenced,
            "a read that started before a logout writes nothing"
        );
    }

    #[tokio::test]
    async fn gitlab_poller_run_tick_drops_the_list_write_once_the_shared_cancellation_has_fired() {
        let (s, host, scope) = fixture();
        fs::write(s.path("list.json"), list_json("2024-01-01T00:00:00Z")).unwrap();
        let database = new_database().await;
        let list_query = default_list_query(s.root());
        let list_key = list_query.snapshot_key();
        // The host-call token stays live, so the list read runs and succeeds
        // normally; only the poller-wide (last-subscriber-left) token is
        // already cancelled, simulating a tick that is still mid-flight
        // after every subscriber has gone.
        let c = CancellationToken::new();
        let shared = Shared::default();
        shared.cancellation.cancel();
        let fences = HostFences::default();
        let inputs = TickInputs {
            host: &host,
            database: &database,
            fences: &fences,
            scope: &scope,
            list_query: &list_query,
            list_key: &list_key,
            shared: &shared,
            c: &c,
        };
        let report = run_tick(&inputs, 1).await;
        assert!(matches!(report.end, TickEnd::Done));
        assert_eq!(lists(&s), 1, "the host call still ran to completion");
        let row = stored(&database, &scope.host, &scope.repository, "list", &list_key).await;
        assert!(
            row.is_none(),
            "the write must be dropped once the shared poller-wide cancellation has fired, \
             even though the host call itself completed and the per-call token never cancelled"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn gitlab_poller_a_second_subscriber_still_receives_the_write_when_only_the_drivers_own_token_cancels()
     {
        // Two subscribers share one poller; only one of them actually drives
        // host reads at a time (see `run_subscriber`'s doc comment).
        // Cancelling *that* subscriber's own token must not cancel the
        // shared, poller-wide cancellation the registry only fires once
        // every subscriber has left: with a second subscriber still alive,
        // the poller must hand driving off and keep writing snapshots, not
        // freeze on the driver's last write.
        let b = bench().await;
        fs::write(b.s.path("list.json"), list_json("2024-01-01T00:00:00Z")).unwrap();
        let (log1, log2) = (Log::default(), Log::default());
        let (emit1, emit2) = (emitter(&log1), emitter(&log2));
        let (c1, c2) = (CancellationToken::new(), CancellationToken::new());
        // Only the first subscriber exists for tick 1, so it is unambiguously
        // the one that acquires the driver lock.
        let mut subs = vec![b.subscriber(None, None, &emit1, &c1)];
        drive(&mut subs).await;
        tokio::time::advance(Duration::from_secs(20)).await;
        drive_until(&mut subs, || lists(&b.s) >= 1).await;
        drive(&mut subs).await;
        assert_eq!(lists(&b.s), 1, "the first tick runs normally");
        let first_generation = b
            .row(&mut subs, "list", &b.list_key)
            .await
            .map(|row| row.generation)
            .expect("the first tick's own write must land before either token is cancelled");
        // The second subscriber joins only now and parks on the driver lock.
        subs.push(b.subscriber(None, None, &emit2, &c2));
        drive(&mut subs).await;
        // The driving subscriber disconnects right after its first tick.
        c1.cancel();
        drive(&mut subs).await;
        fs::write(b.s.path("list.json"), list_json("2024-01-02T00:00:00Z")).unwrap();
        tokio::time::advance(Duration::from_secs(20)).await;
        drive_until(&mut subs, || lists(&b.s) >= 2).await;
        drive(&mut subs).await;
        assert_eq!(
            lists(&b.s),
            2,
            "the surviving subscriber must take over driving and run a second tick"
        );
        let row = b.row(&mut subs, "list", &b.list_key).await;
        assert!(
            row.is_some_and(|row| row.generation > first_generation),
            "a second subscriber is still active, so the shared poller-wide cancellation never \
             fired; the second tick's write must still land"
        );
        assert!(
            lock(&log2).iter().any(|changed| changed.list),
            "the surviving subscriber must have emitted the second tick's result"
        );
        drop(subs);
    }

    #[tokio::test(start_paused = true)]
    async fn gitlab_poller_cancelling_during_put_drops_that_put() {
        let b = bench().await;
        fs::write(b.s.path("mr-list-wait"), "").unwrap();
        let log = Log::default();
        let emit = emitter(&log);
        let c = CancellationToken::new();
        let mut subs = [b.subscriber(None, None, &emit, &c)];
        drive(&mut subs).await;
        tokio::time::advance(Duration::from_secs(20)).await;
        // The list read is held open until `release`: only start the tick.
        drive_for(&mut subs, 200).await;
        c.cancel();
        drive(&mut subs).await;
        fs::write(b.s.path("release"), "").unwrap();
        drive(&mut subs).await;
        drop(subs);
        let row = stored(
            &b.database,
            &b.scope.host,
            &b.scope.repository,
            "list",
            &b.list_key,
        )
        .await;
        assert!(row.is_none(), "cancelling mid-flight drops the pending put");
    }

    #[tokio::test(start_paused = true)]
    async fn gitlab_poller_emits_one_all_false_event_when_a_lease_is_acquired() {
        let b = bench().await;
        let log = Log::default();
        let emit = emitter(&log);
        let c = CancellationToken::new();
        let mut subs = [b.subscriber(Some(3941), None, &emit, &c)];
        drive(&mut subs).await;
        assert_eq!(*lock(&log), vec![Changed::default()]);
        assert!(
            calls(&b.s).is_empty(),
            "the connected event needs no host read"
        );
        c.cancel();
        drive(&mut subs).await;
    }

    #[tokio::test(start_paused = true)]
    async fn gitlab_poller_a_later_poller_stores_a_change_over_rows_an_earlier_poller_left() {
        let b = bench().await;
        fs::write(b.s.path("list.json"), list_json("2024-01-01T00:00:00Z")).unwrap();
        let log = Log::default();
        let emit = emitter(&log);
        let first_c = CancellationToken::new();
        let mut first = [b.subscriber(None, None, &emit, &first_c)];
        drive(&mut first).await;
        tokio::time::advance(Duration::from_secs(20)).await;
        drive_until(&mut first, || lock(&log).len() >= 2).await;
        let earlier = b
            .row(&mut first, "list", &b.list_key)
            .await
            .expect("the first poller stores its page");
        drop(first);
        fs::write(b.s.path("list.json"), list_json("2024-01-02T00:00:00Z")).unwrap();
        let second_c = CancellationToken::new();
        let mut second = [b.subscriber(None, None, &emit, &second_c)];
        drive(&mut second).await;
        tokio::time::advance(Duration::from_secs(20)).await;
        drive_until(&mut second, || lock(&log).len() >= 4).await;
        assert_eq!(lists(&b.s), 2);
        let later = b.row(&mut second, "list", &b.list_key).await.unwrap();
        assert!(later.generation > earlier.generation);
        assert!(
            String::from_utf8(later.payload)
                .unwrap()
                .contains("2024-01-02T00:00:00Z"),
            "a new poller's tick counter must not lose to the rows an earlier one left"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn gitlab_poller_every_subscriber_of_the_key_receives_list_events_and_only_its_number_gets_detail_names()
     {
        let b = bench().await;
        fs::write(b.s.path("list.json"), list_json("2024-01-01T00:00:00Z")).unwrap();
        let (driver_log, list_log, files_log) = (Log::default(), Log::default(), Log::default());
        let (driver_emit, list_emit, files_emit) = (
            emitter(&driver_log),
            emitter(&list_log),
            emitter(&files_log),
        );
        let c = CancellationToken::new();
        let mut subs = [
            b.subscriber(Some(3941), None, &driver_emit, &c),
            b.subscriber(None, None, &list_emit, &c),
            b.subscriber(Some(3941), Some(SubscribeTab::Files), &files_emit, &c),
        ];
        drive(&mut subs).await;
        tokio::time::advance(Duration::from_secs(20)).await;
        drive_until(&mut subs, || {
            [&driver_log, &list_log, &files_log]
                .iter()
                .all(|log| lock(log).len() >= 2)
        })
        .await;
        drive(&mut subs).await;
        assert_eq!(lists(&b.s), 1, "one poller drives the key");
        assert_eq!(probes(&b.s, 3941), 1, "one probe per subscribed number");
        let first_probe = Changed {
            list: true,
            detail: true,
            timeline: true,
            commits: false,
            checks: true,
            files: false,
            pipeline: false,
        };
        assert_eq!(ticks(&driver_log), vec![first_probe.clone()]);
        assert_eq!(
            ticks(&list_log),
            vec![Changed {
                list: true,
                ..Changed::default()
            }],
            "a subscriber with no open number still hears the list change"
        );
        assert_eq!(
            ticks(&files_log),
            vec![Changed {
                files: true,
                ..first_probe
            }],
            "a subscriber of the number keeps its own tab's names"
        );
        c.cancel();
        drive(&mut subs).await;
    }
}
