//! One poller per `(host, project, list key)`, reference counted across the
//! subscribers that share it. Each `subscribe` RPC call is already spawned by
//! the exempt `production/pull_requests_rpc.rs`; this module runs the tick
//! loop cooperatively inside that call instead of spawning a background task
//! (forbidden everywhere else in `pull_requests`, see the `mod.rs` tripwires).
//!
//! A tick reads the list page and one merge-request probe, stores the list
//! page and the probe fingerprint, and names what changed. It never runs the
//! detail, timeline, commits, checks, or files reads: the client answers those
//! names with the unary reads, which store their own snapshots.
//!
//! See `docs/superpowers/specs/2026-10-08-gitlab-merge-request-background-sync-design.md`.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};

use tokio::sync::broadcast;
use tokio_util::sync::CancellationToken;

use crate::persistence::Database;

use super::{
    GitLabHost,
    refresh::{ListFingerprint, ProbeFingerprint, RefreshNames, detail_refresh, list_changed},
};
use crate::pull_requests::{
    host::{HostScope, PullRequestHost},
    model::{Changed, ListPage, ListQuery, ListRow},
    snapshot_store::{self, Snapshot as StoredSnapshot, SnapshotStore},
};

pub(crate) use super::refresh::ActiveTab;

const BASE_DELAY: Duration = Duration::from_secs(20);
/// Fixed 429 backoff ladder: 60s, then 120s, then 300s, holding at 300s for
/// any further consecutive 429. A success resets the ladder to its first
/// step for the next 429.
const BACKOFF_STEPS: [Duration; 3] = [
    Duration::from_secs(60),
    Duration::from_secs(120),
    Duration::from_secs(300),
];
/// Ticks are 20 s apart, so a subscriber that falls this far behind has a
/// stuck stream; it skips the lagged ticks instead of blocking the driver.
const EVENT_CAPACITY: usize = 16;
/// The probe row holds only the fingerprint the next tick compares against.
const PROBE_KIND: &str = "probe";
/// Every tab name a probe can raise; each subscriber keeps its own tab's.
const ALL_TABS: ActiveTab = ActiveTab {
    commits: true,
    files: true,
};

type Key = (String, String, String);

struct Entry {
    shared: Arc<Shared>,
    ref_count: usize,
}

/// One poller per repository and list key; `join`/`release` are serialized by
/// the same lock so a lease can never resurrect an already-cancelled poller.
#[derive(Default)]
pub(crate) struct Registry {
    entries: Mutex<HashMap<Key, Entry>>,
}

impl Registry {
    fn join(&self, key: Key) -> Lease<'_> {
        let mut entries = self.entries.lock().unwrap_or_else(|p| p.into_inner());
        let entry = entries.entry(key.clone()).or_insert_with(|| Entry {
            shared: Arc::new(Shared::default()),
            ref_count: 0,
        });
        entry.ref_count += 1;
        let shared = entry.shared.clone();
        let events = shared.events.subscribe();
        drop(entries);
        Lease {
            registry: self,
            key,
            shared,
            events,
        }
    }

    fn release(&self, key: &Key) -> Option<Arc<Shared>> {
        let mut entries = self.entries.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(entry) = entries.get_mut(key) {
            entry.ref_count -= 1;
            if entry.ref_count == 0 {
                let shared = entry.shared.clone();
                entries.remove(key);
                return Some(shared);
            }
        }
        None
    }
}

struct Lease<'a> {
    registry: &'a Registry,
    key: Key,
    shared: Arc<Shared>,
    events: broadcast::Receiver<Tick>,
}

impl Drop for Lease<'_> {
    fn drop(&mut self) {
        if let Some(shared) = self.registry.release(&self.key) {
            shared.cancellation.cancel();
        }
    }
}

struct Shared {
    cancellation: CancellationToken,
    driver_lock: tokio::sync::Mutex<()>,
    events: broadcast::Sender<Tick>,
}

impl Default for Shared {
    fn default() -> Self {
        let (events, _) = broadcast::channel(EVENT_CAPACITY);
        Self {
            cancellation: CancellationToken::new(),
            driver_lock: tokio::sync::Mutex::new(()),
            events,
        }
    }
}

/// One successful tick, published to every subscriber of the key. Only the
/// driving subscriber's number is probed.
#[derive(Clone)]
struct Tick {
    number: Option<u64>,
    changed: Changed,
}

impl Tick {
    fn for_subscriber(&self, number: Option<u64>, tab: ActiveTab) -> Changed {
        let probed = number.is_some() && number == self.number;
        Changed {
            list: self.changed.list,
            detail: probed && self.changed.detail,
            timeline: probed && self.changed.timeline,
            commits: probed && tab.commits && self.changed.commits,
            checks: probed && self.changed.checks,
            files: probed && tab.files && self.changed.files,
        }
    }
}

enum TickOutcome {
    Success(Changed),
    RateLimited,
    Error,
}

fn classify(error: &crate::pull_requests::error::PullRequestsOperationError) -> TickOutcome {
    if error.code == "rate_limited" {
        TickOutcome::RateLimited
    } else {
        TickOutcome::Error
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

fn list_fingerprints(page: &ListPage) -> Vec<ListFingerprint> {
    page.rows.iter().map(list_row_fingerprint).collect()
}

/// The stored list fingerprint; the unary `list` read stores the same one, so
/// the next tick does not report a page the client has just read as changed.
pub(crate) fn list_fingerprint(page: &ListPage) -> String {
    serde_json::to_string(&list_fingerprints(page)).unwrap_or_default()
}

/// Rows key on the lowercased host, matching `read_snapshot` and host deletes.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn store(
    database: &Database,
    host: &str,
    project: &str,
    kind: &'static str,
    key: &str,
    fingerprint: String,
    payload: Vec<u8>,
    generation: i64,
) {
    let host = host.to_ascii_lowercase();
    let project = project.to_owned();
    let key = key.to_owned();
    let _ = database
        .call(move |connection| {
            SnapshotStore::new(connection).put(StoredSnapshot {
                host,
                project,
                kind: kind.to_owned(),
                key,
                fingerprint,
                payload,
                observed_at_ms: snapshot_store::now_ms(),
                generation,
            })?;
            Ok(())
        })
        .await;
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

#[allow(clippy::too_many_arguments)]
async fn run_tick(
    host: &GitLabHost,
    database: &Database,
    scope: &HostScope,
    list_query: &ListQuery,
    list_key: &str,
    number: Option<u64>,
    generation: i64,
    c: &CancellationToken,
    shared_cancel: &CancellationToken,
) -> TickOutcome {
    let mut changed = Changed::default();

    let page = match host.list(scope, list_query, c).await {
        Ok(page) => page,
        Err(error) => {
            return classify(&error);
        }
    };
    let next_list_fp = list_fingerprints(&page);
    let previous_list_fp: Vec<ListFingerprint> =
        load_fingerprint(database, &scope.host, &scope.repository, "list", list_key)
            .await
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default();
    if list_changed(&previous_list_fp, &next_list_fp)
        && !shared_cancel.is_cancelled()
        && let (Ok(fingerprint), Ok(payload)) = (
            serde_json::to_string(&next_list_fp),
            serde_json::to_vec(&page),
        )
    {
        store(
            database,
            &scope.host,
            &scope.repository,
            "list",
            list_key,
            fingerprint,
            payload,
            generation,
        )
        .await;
        changed.list = true;
    }

    let Some(number) = number else {
        return TickOutcome::Success(changed);
    };

    let next_probe = match host.probe(scope, number, c).await {
        Ok(probe) => probe,
        Err(error) => {
            return classify(&error);
        }
    };
    let key = number.to_string();
    let previous_probe: Option<ProbeFingerprint> =
        load_fingerprint(database, &scope.host, &scope.repository, PROBE_KIND, &key)
            .await
            .and_then(|raw| serde_json::from_str(&raw).ok());
    let names = match &previous_probe {
        Some(previous) => detail_refresh(previous, &next_probe, ALL_TABS),
        // Nothing has been probed for this number yet: name everything so a
        // change between the client's open and this first probe is re-read.
        None => RefreshNames {
            detail: true,
            timeline: true,
            commits: true,
            checks: true,
            files: true,
        },
    };
    let any = names.detail || names.timeline || names.commits || names.checks || names.files;
    if any
        && !shared_cancel.is_cancelled()
        && let Ok(fingerprint) = serde_json::to_string(&next_probe)
    {
        store(
            database,
            &scope.host,
            &scope.repository,
            PROBE_KIND,
            &key,
            fingerprint,
            Vec::new(),
            generation,
        )
        .await;
        changed.detail = names.detail;
        changed.timeline = names.timeline;
        changed.commits = names.commits;
        changed.checks = names.checks;
        changed.files = names.files;
    }

    TickOutcome::Success(changed)
}

/// Forwards every published tick until `wait` resolves; `None` means the
/// subscriber or the whole poller was cancelled first.
async fn forward_until<T>(
    events: &mut broadcast::Receiver<Tick>,
    wait: impl std::future::Future<Output = T>,
    forward: &impl Fn(&Tick),
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
/// tick's list name; detail names reach only subscribers of the probed number.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn run_subscriber(
    registry: &Registry,
    host: &GitLabHost,
    database: &Database,
    scope: &HostScope,
    list_query: &ListQuery,
    list_key: &str,
    number: Option<u64>,
    tab: ActiveTab,
    emit: &(dyn Fn(Changed) + Send + Sync),
    c: &CancellationToken,
) {
    let key = (
        scope.host.to_ascii_lowercase(),
        scope.repository.clone(),
        list_key.to_owned(),
    );
    let mut lease = registry.join(key);
    let shared = lease.shared.clone();
    // The client stands its own refresh timer down on this first success.
    emit(Changed::default());
    let forward = |tick: &Tick| emit(tick.for_subscriber(number, tab));
    let Some(_permit) = forward_until(
        &mut lease.events,
        shared.driver_lock.lock(),
        &forward,
        c,
        &shared.cancellation,
    )
    .await
    else {
        return;
    };
    let mut delay = BASE_DELAY;
    let mut backoff_index: usize = 0;
    loop {
        if forward_until(
            &mut lease.events,
            tokio::time::sleep(delay),
            &forward,
            c,
            &shared.cancellation,
        )
        .await
        .is_none()
        {
            return;
        }
        if c.is_cancelled() || shared.cancellation.is_cancelled() {
            return;
        }
        let generation = snapshot_store::next_generation();
        let outcome = run_tick(
            host,
            database,
            scope,
            list_query,
            list_key,
            number,
            generation,
            c,
            &shared.cancellation,
        )
        .await;
        match outcome {
            TickOutcome::Success(changed) => {
                let _ = shared.events.send(Tick { number, changed });
                delay = BASE_DELAY;
                backoff_index = 0;
            }
            TickOutcome::RateLimited => {
                delay = BACKOFF_STEPS[backoff_index];
                backoff_index = (backoff_index + 1).min(BACKOFF_STEPS.len() - 1);
            }
            TickOutcome::Error => {
                delay = BASE_DELAY;
            }
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
        pull_requests::{host::HostCommandRunner, model::PullRequestsProvider},
        test_support::TestSandbox,
    };
    use futures_util::future::poll_immediate;
    use serde_json::{Value, json};
    use std::{
        fs,
        future::Future,
        pin::Pin,
        sync::{Arc, Mutex},
    };

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
    cat list.json ;;
  'api -i') printf 'HTTP/2 200 OK\r\nx-total: 0\r\n\r\n[]' ;;
  'api projects/gitlab-org%2Fcli/merge_requests/3941') cat detail.json ;;
  'api projects/gitlab-org%2Fcli/merge_requests/3941/approvals') cat approvals.json ;;
  'api projects/gitlab-org%2Fcli/merge_requests/3941/reviewers') cat reviewers.json ;;
  'api projects/gitlab-org%2Fcli/merge_requests/3941/approval_state') echo 'HTTP 404' >&2; exit 1 ;;
  'api projects/gitlab-org%2Fcli/merge_requests/3941/award_emoji?per_page=100&page=1') echo '[]' ;;
  'api projects/gitlab-org%2Fcli/merge_requests/3941/closes_issues?per_page=100') echo '[]' ;;
  'api projects/gitlab-org%2Fcli/merge_requests/3941/resource_label_events?per_page=100') echo '[]' ;;
  'api projects/gitlab-org%2Fcli/merge_requests/3941/resource_milestone_events?per_page=100') echo '[]' ;;
  'api projects/gitlab-org%2Fcli/merge_requests/3941/resource_state_events?per_page=100') echo '[]' ;;
  'api projects/gitlab-org%2Fcli/merge_requests/3941/pipelines?per_page=1') cat pipelines.json ;;
  'api projects/2/pipelines/9/jobs?per_page=100') cat jobs.json ;;
  'api --method') test "$5" = -H && test "$6" = 'Content-Type: application/json' && test "$7" = --input || exit 65
    if grep -q 'PullRequestsGitLabTimeline' "$8"; then cat timeline.json; else cat metadata.json; fi ;;
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

    /// A subscriber future, driven by hand instead of a forbidden spawned task
    /// (see the module doc comment): the `pullRequests.subscribe` RPC call is
    /// already spawned once by the exempt production RPC layer, and in tests
    /// that single caller task is this test function itself.
    ///
    /// `done` remembers whether the inner future already returned, because
    /// polling a completed `async fn` again panics, and a cancelled
    /// subscriber can finish inside any `drive`/`drive_until` call.
    struct Subscriber<'a> {
        future: Pin<Box<dyn Future<Output = ()> + 'a>>,
        done: bool,
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
        tab: ActiveTab,
        emit: &'a (dyn Fn(Changed) + Send + Sync),
        c: &'a CancellationToken,
    ) -> Subscriber<'a> {
        Subscriber {
            future: Box::pin(run_subscriber(
                registry, host, database, scope, list_query, list_key, number, tab, emit, c,
            )),
            done: false,
        }
    }

    async fn poll_all(subscribers: &mut [Subscriber<'_>]) {
        for subscriber in subscribers.iter_mut() {
            if !subscriber.done && poll_immediate(subscriber.future.as_mut()).await.is_some() {
                subscriber.done = true;
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
    async fn drive(subscribers: &mut [Subscriber<'_>]) {
        for _ in 0..200 {
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

    fn tab_none() -> ActiveTab {
        ActiveTab {
            commits: false,
            files: false,
        }
    }

    fn probe_of(value: &Value) -> ProbeFingerprint {
        ProbeFingerprint {
            updated_at: value["updated_at"].as_str().unwrap().to_owned(),
            user_notes_count: value["user_notes_count"].as_u64().unwrap_or(0),
            pipeline_id: value["head_pipeline"]["id"].as_u64(),
            pipeline_status: value["head_pipeline"]["status"].as_str().map(str::to_owned),
        }
    }

    async fn seed_probe(
        database: &Database,
        host: &str,
        project: &str,
        number: u64,
        probe: &ProbeFingerprint,
    ) {
        let host = host.to_owned();
        let project = project.to_owned();
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

    fn emitter(log: &Arc<Mutex<Vec<Changed>>>) -> impl Fn(Changed) + Send + Sync {
        let log = log.clone();
        move |changed: Changed| {
            log.lock().unwrap_or_else(|p| p.into_inner()).push(changed);
        }
    }

    /// The events after the connected one every subscriber receives on join.
    fn ticks(log: &Arc<Mutex<Vec<Changed>>>) -> Vec<Changed> {
        let log = log.lock().unwrap();
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

    #[tokio::test(start_paused = true)]
    async fn gitlab_poller_two_subscribers_cause_one_list_command_per_tick() {
        let (s, host, scope) = fixture();
        let database = new_database().await;
        let registry = Registry::default();
        let list_query = default_list_query(s.root());
        let list_key = list_query.snapshot_key();
        let log1 = Arc::new(Mutex::new(Vec::new()));
        let log2 = Arc::new(Mutex::new(Vec::new()));
        let emit1 = emitter(&log1);
        let emit2 = emitter(&log2);
        let c1 = CancellationToken::new();
        let c2 = CancellationToken::new();
        let mut subs = [
            pin_subscriber(
                &registry,
                &host,
                &database,
                &scope,
                &list_query,
                &list_key,
                None,
                tab_none(),
                &emit1,
                &c1,
            ),
            pin_subscriber(
                &registry,
                &host,
                &database,
                &scope,
                &list_query,
                &list_key,
                None,
                tab_none(),
                &emit2,
                &c2,
            ),
        ];
        drive(&mut subs).await;
        tokio::time::advance(Duration::from_secs(20)).await;
        drive_until(&mut subs, || count(&s, "mr list") >= 1).await;
        drive(&mut subs).await;
        assert_eq!(count(&s, "mr list"), 1, "two subscribers share one tick");
        c1.cancel();
        c2.cancel();
        drive(&mut subs).await;
    }

    #[tokio::test(start_paused = true)]
    async fn gitlab_poller_dropping_the_last_subscriber_leaves_the_log_unchanged_for_a_further_20s()
    {
        let (s, host, scope) = fixture();
        let database = new_database().await;
        let registry = Registry::default();
        let list_query = default_list_query(s.root());
        let list_key = list_query.snapshot_key();
        let log = Arc::new(Mutex::new(Vec::new()));
        let emit = emitter(&log);
        let c = CancellationToken::new();
        let mut subs = [pin_subscriber(
            &registry,
            &host,
            &database,
            &scope,
            &list_query,
            &list_key,
            None,
            tab_none(),
            &emit,
            &c,
        )];
        drive(&mut subs).await;
        tokio::time::advance(Duration::from_secs(20)).await;
        drive_until(&mut subs, || count(&s, "mr list") >= 1).await;
        drive(&mut subs).await;
        let after_first_tick = count(&s, "mr list");
        assert_eq!(after_first_tick, 1);
        drop(subs);
        tokio::time::advance(Duration::from_secs(20)).await;
        assert_eq!(
            count(&s, "mr list"),
            after_first_tick,
            "no subscriber remains to drive another tick"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn gitlab_poller_first_command_runs_at_least_20s_after_subscribe() {
        let (s, host, scope) = fixture();
        let database = new_database().await;
        let registry = Registry::default();
        let list_query = default_list_query(s.root());
        let list_key = list_query.snapshot_key();
        let log = Arc::new(Mutex::new(Vec::new()));
        let emit = emitter(&log);
        let c = CancellationToken::new();
        let mut subs = [pin_subscriber(
            &registry,
            &host,
            &database,
            &scope,
            &list_query,
            &list_key,
            None,
            tab_none(),
            &emit,
            &c,
        )];
        drive(&mut subs).await;
        tokio::time::advance(Duration::from_millis(19_999)).await;
        drive(&mut subs).await;
        assert_eq!(count(&s, "mr list"), 0, "must not run before 20s elapse");
        tokio::time::advance(Duration::from_millis(1)).await;
        drive_until(&mut subs, || count(&s, "mr list") >= 1).await;
    }

    #[tokio::test(start_paused = true)]
    async fn gitlab_poller_unchanged_probe_writes_no_detail_and_emits_no_detail_bit() {
        let (s, host, scope) = fixture();
        let database = new_database().await;
        let detail: Value =
            serde_json::from_str(&fs::read_to_string(s.path("detail.json")).unwrap()).unwrap();
        seed_probe(
            &database,
            &scope.host,
            &scope.repository,
            3941,
            &probe_of(&detail),
        )
        .await;
        let registry = Registry::default();
        let list_query = default_list_query(s.root());
        let list_key = list_query.snapshot_key();
        let log = Arc::new(Mutex::new(Vec::new()));
        let emit = emitter(&log);
        let c = CancellationToken::new();
        let mut subs = [pin_subscriber(
            &registry,
            &host,
            &database,
            &scope,
            &list_query,
            &list_key,
            Some(3941),
            tab_none(),
            &emit,
            &c,
        )];
        drive(&mut subs).await;
        tokio::time::advance(Duration::from_secs(20)).await;
        drive_until(&mut subs, || {
            count(&s, "api projects/gitlab-org%2Fcli/merge_requests/3941") >= 1
        })
        .await;
        drive(&mut subs).await;
        assert!(log.lock().unwrap().iter().all(|changed| !changed.detail));
        let row = stored(
            &database,
            &scope.host,
            &scope.repository,
            PROBE_KIND,
            "3941",
        )
        .await
        .unwrap();
        assert_eq!(row.generation, 0, "an unchanged probe rewrites nothing");
        assert!(
            stored(&database, &scope.host, &scope.repository, "detail", "3941")
                .await
                .is_none()
        );
        assert_eq!(
            count(
                &s,
                "api projects/gitlab-org%2Fcli/merge_requests/3941/approvals"
            ),
            0,
            "an unchanged probe never runs the unary detail method"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn gitlab_poller_changed_updated_at_emits_detail_and_timeline_without_the_detail_join() {
        let (s, host, scope) = fixture();
        let database = new_database().await;
        let detail: Value =
            serde_json::from_str(&fs::read_to_string(s.path("detail.json")).unwrap()).unwrap();
        let mut stale = probe_of(&detail);
        stale.updated_at = "2020-01-01T00:00:00Z".into();
        seed_probe(&database, &scope.host, &scope.repository, 3941, &stale).await;
        let registry = Registry::default();
        let list_query = default_list_query(s.root());
        let list_key = list_query.snapshot_key();
        let log = Arc::new(Mutex::new(Vec::new()));
        let emit = emitter(&log);
        let c = CancellationToken::new();
        let mut subs = [pin_subscriber(
            &registry,
            &host,
            &database,
            &scope,
            &list_query,
            &list_key,
            Some(3941),
            tab_none(),
            &emit,
            &c,
        )];
        drive(&mut subs).await;
        tokio::time::advance(Duration::from_secs(20)).await;
        drive_until(&mut subs, || log.lock().unwrap().len() >= 2).await;
        drive(&mut subs).await;
        let changed = ticks(&log)[0].clone();
        assert!(changed.detail && changed.timeline);
        assert!(!changed.commits && !changed.checks && !changed.files);
        assert_eq!(
            count(
                &s,
                "api projects/gitlab-org%2Fcli/merge_requests/3941/approvals"
            ),
            0,
            "the client answers `detail` with the unary read; the poller never joins"
        );
        assert_eq!(
            count(&s, "api --method"),
            0,
            "no GraphQL timeline read either"
        );
        assert!(
            stored(&database, &scope.host, &scope.repository, "detail", "3941")
                .await
                .is_none(),
            "the probe body is never stored as detail"
        );
        let probe = stored(
            &database,
            &scope.host,
            &scope.repository,
            PROBE_KIND,
            "3941",
        )
        .await
        .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&probe.fingerprint).unwrap()["updated_at"],
            detail["updated_at"],
            "the next tick compares against the new probe"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn gitlab_poller_changed_pipeline_id_with_the_same_updated_at_emits_checks_and_detail_only()
     {
        let (s, host, scope) = fixture();
        let database = new_database().await;
        let detail: Value =
            serde_json::from_str(&fs::read_to_string(s.path("detail.json")).unwrap()).unwrap();
        let mut stale = probe_of(&detail);
        stale.pipeline_id = Some(1);
        seed_probe(&database, &scope.host, &scope.repository, 3941, &stale).await;
        let registry = Registry::default();
        let list_query = default_list_query(s.root());
        let list_key = list_query.snapshot_key();
        let log = Arc::new(Mutex::new(Vec::new()));
        let emit = emitter(&log);
        let c = CancellationToken::new();
        let mut subs = [pin_subscriber(
            &registry,
            &host,
            &database,
            &scope,
            &list_query,
            &list_key,
            Some(3941),
            tab_none(),
            &emit,
            &c,
        )];
        drive(&mut subs).await;
        tokio::time::advance(Duration::from_secs(20)).await;
        drive_until(&mut subs, || log.lock().unwrap().len() >= 2).await;
        drive(&mut subs).await;
        let changed = ticks(&log)[0].clone();
        assert!(changed.detail && changed.checks);
        assert!(!changed.timeline && !changed.commits && !changed.files);
        assert_eq!(
            count(
                &s,
                "api projects/gitlab-org%2Fcli/merge_requests/3941/pipelines?per_page=1"
            ),
            0,
            "the client answers `checks` with the unary read"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn gitlab_poller_rate_limited_backs_off_60s_then_120s_then_300s_then_resets_on_success() {
        let (s, host, scope) = fixture();
        fs::write(s.path("rate-limited"), "").unwrap();
        let database = new_database().await;
        let registry = Registry::default();
        let list_query = default_list_query(s.root());
        let list_key = list_query.snapshot_key();
        let log = Arc::new(Mutex::new(Vec::new()));
        let emit = emitter(&log);
        let c = CancellationToken::new();
        let mut subs = [pin_subscriber(
            &registry,
            &host,
            &database,
            &scope,
            &list_query,
            &list_key,
            None,
            tab_none(),
            &emit,
            &c,
        )];
        drive(&mut subs).await;
        tokio::time::advance(Duration::from_secs(20)).await;
        drive_until(&mut subs, || count(&s, "mr list") >= 1).await;
        drive(&mut subs).await;
        assert_eq!(count(&s, "mr list"), 1);
        tokio::time::advance(Duration::from_secs(59)).await;
        drive(&mut subs).await;
        assert_eq!(count(&s, "mr list"), 1, "a 429 backs off to 60s, not 20s");
        tokio::time::advance(Duration::from_secs(1)).await;
        drive_until(&mut subs, || count(&s, "mr list") >= 2).await;
        drive(&mut subs).await;
        assert_eq!(count(&s, "mr list"), 2);
        tokio::time::advance(Duration::from_secs(119)).await;
        drive(&mut subs).await;
        assert_eq!(count(&s, "mr list"), 2, "a second 429 backs off to 120s");
        tokio::time::advance(Duration::from_secs(1)).await;
        drive_until(&mut subs, || count(&s, "mr list") >= 3).await;
        drive(&mut subs).await;
        assert_eq!(count(&s, "mr list"), 3);
        tokio::time::advance(Duration::from_secs(299)).await;
        drive(&mut subs).await;
        assert_eq!(
            count(&s, "mr list"),
            3,
            "a third 429 backs off to 300s, not 240s"
        );
        assert!(
            ticks(&log).is_empty(),
            "a 429 tick must never call emit beyond the connected event"
        );
        tokio::time::advance(Duration::from_secs(1)).await;
        drive_until(&mut subs, || count(&s, "mr list") >= 4).await;
        drive(&mut subs).await;
        assert_eq!(count(&s, "mr list"), 4);
        tokio::time::advance(Duration::from_secs(299)).await;
        drive(&mut subs).await;
        assert_eq!(
            count(&s, "mr list"),
            4,
            "the delay stays at 300s for any further consecutive 429"
        );
        tokio::time::advance(Duration::from_secs(1)).await;
        drive_until(&mut subs, || count(&s, "mr list") >= 5).await;
        drive(&mut subs).await;
        assert_eq!(count(&s, "mr list"), 5);

        // Let the next tick succeed, then resume rate limiting: the next 429
        // must back off to 60s again, not continue from 300s. The pending
        // tick is still scheduled 300s out from the last 429, so it must
        // wait out that full delay before it can succeed.
        fs::remove_file(s.path("rate-limited")).unwrap();
        tokio::time::advance(Duration::from_secs(299)).await;
        drive(&mut subs).await;
        assert_eq!(
            count(&s, "mr list"),
            5,
            "the pending tick still waits out its 300s delay"
        );
        tokio::time::advance(Duration::from_secs(1)).await;
        drive_until(&mut subs, || count(&s, "mr list") >= 6).await;
        drive(&mut subs).await;
        assert_eq!(count(&s, "mr list"), 6);
        drive_until(&mut subs, || log.lock().unwrap().len() >= 2).await;
        assert_eq!(ticks(&log).len(), 1, "a successful tick must emit");
        fs::write(s.path("rate-limited"), "").unwrap();
        tokio::time::advance(Duration::from_secs(19)).await;
        drive(&mut subs).await;
        assert_eq!(
            count(&s, "mr list"),
            6,
            "a success schedules its own next tick after 20s"
        );
        tokio::time::advance(Duration::from_secs(1)).await;
        drive_until(&mut subs, || count(&s, "mr list") >= 7).await;
        drive(&mut subs).await;
        assert_eq!(count(&s, "mr list"), 7);
        tokio::time::advance(Duration::from_secs(59)).await;
        drive(&mut subs).await;
        assert_eq!(
            count(&s, "mr list"),
            7,
            "the 429 after a success backs off to 60s again, not 300s"
        );
        tokio::time::advance(Duration::from_secs(1)).await;
        drive_until(&mut subs, || count(&s, "mr list") >= 8).await;
    }

    #[tokio::test(start_paused = true)]
    async fn gitlab_poller_generic_host_error_does_not_emit() {
        let (s, host, scope) = fixture();
        fs::write(s.path("list-error"), "").unwrap();
        let database = new_database().await;
        let registry = Registry::default();
        let list_query = default_list_query(s.root());
        let list_key = list_query.snapshot_key();
        let log = Arc::new(Mutex::new(Vec::new()));
        let emit = emitter(&log);
        let c = CancellationToken::new();
        let mut subs = [pin_subscriber(
            &registry,
            &host,
            &database,
            &scope,
            &list_query,
            &list_key,
            None,
            tab_none(),
            &emit,
            &c,
        )];
        drive(&mut subs).await;
        tokio::time::advance(Duration::from_secs(20)).await;
        drive_until(&mut subs, || count(&s, "mr list") >= 1).await;
        drive(&mut subs).await;
        assert_eq!(count(&s, "mr list"), 1);
        assert!(
            ticks(&log).is_empty(),
            "a non-429 host error must never call emit beyond the connected event"
        );
        tokio::time::advance(Duration::from_secs(20)).await;
        drive_until(&mut subs, || count(&s, "mr list") >= 2).await;
        drive(&mut subs).await;
        assert_eq!(
            count(&s, "mr list"),
            2,
            "a generic error backs off at the base 20s delay, not the 429 ladder"
        );
        assert!(ticks(&log).is_empty());
    }

    #[tokio::test]
    async fn gitlab_poller_a_list_write_with_generation_1_does_not_replace_generation_2() {
        let database = new_database().await;
        store(
            &database,
            "gitlab.com",
            "team/repo",
            "list",
            "key",
            "fp-2".into(),
            b"second".to_vec(),
            2,
        )
        .await;
        store(
            &database,
            "gitlab.com",
            "team/repo",
            "list",
            "key",
            "fp-1".into(),
            b"first".to_vec(),
            1,
        )
        .await;
        let row = stored(&database, "gitlab.com", "team/repo", "list", "key")
            .await
            .unwrap();
        assert_eq!(row.payload, b"second".to_vec());
        assert_eq!(row.generation, 2);
    }

    #[tokio::test]
    async fn gitlab_poller_run_tick_drops_the_list_write_once_the_shared_cancellation_has_fired() {
        let (s, host, scope) = fixture();
        fs::write(
            s.path("list.json"),
            json!([{
                "iid": 1,
                "title": "x",
                "state": "opened",
                "draft": false,
                "author": {"username": "a"},
                "created_at": "2024-01-01T00:00:00Z",
                "updated_at": "2024-01-01T00:00:00Z",
                "source_branch": "a",
                "target_branch": "main",
                "labels": [],
                "user_notes_count": 0,
                "web_url": "https://gitlab.com/x"
            }])
            .to_string(),
        )
        .unwrap();
        let database = new_database().await;
        let list_query = default_list_query(s.root());
        let list_key = list_query.snapshot_key();
        // The host-call token stays live, so `host.list` runs and succeeds
        // normally; only the poller-wide (last-subscriber-left) token is
        // already cancelled, simulating a tick that is still mid-flight
        // after every subscriber has gone.
        let c = CancellationToken::new();
        let shared_cancel = CancellationToken::new();
        shared_cancel.cancel();

        let outcome = run_tick(
            &host,
            &database,
            &scope,
            &list_query,
            &list_key,
            None,
            1,
            &c,
            &shared_cancel,
        )
        .await;

        assert!(matches!(outcome, TickOutcome::Success(_)));
        assert_eq!(
            count(&s, "mr list"),
            1,
            "the host call still ran to completion"
        );
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
        // host reads at a time (see `run_subscriber`'s module doc comment).
        // Cancelling *that* subscriber's own token must not cancel the
        // shared, poller-wide cancellation the registry only fires once
        // every subscriber has left: with a second subscriber still alive,
        // the poller must hand driving off and keep writing snapshots, not
        // freeze on the driver's last write.
        let (s, host, scope) = fixture();
        fs::write(
            s.path("list.json"),
            json!([{
                "iid": 1,
                "title": "x",
                "state": "opened",
                "draft": false,
                "author": {"username": "a"},
                "created_at": "2024-01-01T00:00:00Z",
                "updated_at": "2024-01-01T00:00:00Z",
                "source_branch": "a",
                "target_branch": "main",
                "labels": [],
                "user_notes_count": 0,
                "web_url": "https://gitlab.com/x"
            }])
            .to_string(),
        )
        .unwrap();
        let database = new_database().await;
        let registry = Registry::default();
        let list_query = default_list_query(s.root());
        let list_key = list_query.snapshot_key();
        let log1 = Arc::new(Mutex::new(Vec::new()));
        let log2 = Arc::new(Mutex::new(Vec::new()));
        let emit1 = emitter(&log1);
        let emit2 = emitter(&log2);
        let c1 = CancellationToken::new();
        let c2 = CancellationToken::new();

        // Only the first subscriber exists for tick 1, so it is unambiguously
        // the one that acquires the driver lock: no race to disambiguate
        // which subscriber actually drove the tick.
        let mut subs = vec![pin_subscriber(
            &registry,
            &host,
            &database,
            &scope,
            &list_query,
            &list_key,
            None,
            tab_none(),
            &emit1,
            &c1,
        )];
        drive(&mut subs).await;
        tokio::time::advance(Duration::from_secs(20)).await;
        drive_until(&mut subs, || count(&s, "mr list") >= 1).await;
        drive(&mut subs).await;
        assert_eq!(count(&s, "mr list"), 1, "the first tick runs normally");
        let first_generation = stored_while_driving(
            &mut subs,
            &database,
            &scope.host,
            &scope.repository,
            "list",
            &list_key,
        )
        .await
        .map(|row| row.generation)
        .expect("the first tick's own write must land before either token is cancelled");

        // The second subscriber joins only now, after tick 1 has already
        // landed: it shares the same poller key and bumps the registry's ref
        // count, but it parks on the driver lock the first subscriber still
        // holds instead of driving anything itself.
        subs.push(pin_subscriber(
            &registry,
            &host,
            &database,
            &scope,
            &list_query,
            &list_key,
            None,
            tab_none(),
            &emit2,
            &c2,
        ));
        drive(&mut subs).await;

        // The driving subscriber disconnects (cancels its own token) right
        // after its first tick. Its loop only notices at the top of the next
        // iteration, so this does not retroactively undo tick 1's write.
        c1.cancel();
        drive(&mut subs).await;

        // Change the list content so the next tick's write is observable
        // against a *different* fingerprint than tick 1's, and advance to
        // let the surviving subscriber (never cancelled) pick up the driver
        // lock the departing one just released and run the next tick itself.
        fs::write(
            s.path("list.json"),
            json!([{
                "iid": 1,
                "title": "x",
                "state": "opened",
                "draft": false,
                "author": {"username": "a"},
                "created_at": "2024-01-01T00:00:00Z",
                "updated_at": "2024-01-02T00:00:00Z",
                "source_branch": "a",
                "target_branch": "main",
                "labels": [],
                "user_notes_count": 0,
                "web_url": "https://gitlab.com/x"
            }])
            .to_string(),
        )
        .unwrap();
        tokio::time::advance(Duration::from_secs(20)).await;
        drive_until(&mut subs, || count(&s, "mr list") >= 2).await;
        drive(&mut subs).await;
        assert_eq!(
            count(&s, "mr list"),
            2,
            "the surviving subscriber must take over driving and run a second tick"
        );
        let row = stored_while_driving(
            &mut subs,
            &database,
            &scope.host,
            &scope.repository,
            "list",
            &list_key,
        )
        .await;
        assert!(
            row.is_some_and(|row| row.generation > first_generation),
            "a second subscriber is still active, so the shared poller-wide cancellation never \
             fired; the second tick's write must still land even though the driving \
             subscriber's own token cancelled, instead of leaving tick 1's stale row in place"
        );

        // Confirms the surviving subscriber (never cancelled) is the one
        // that actually took over driving, rather than some other path.
        assert!(
            log2.lock().unwrap().iter().any(|changed| changed.list),
            "the surviving subscriber must have emitted the second tick's result"
        );

        drop(subs);
    }

    #[tokio::test(start_paused = true)]
    async fn gitlab_poller_cancelling_during_put_drops_that_put() {
        let (s, host, scope) = fixture();
        fs::write(s.path("mr-list-wait"), "").unwrap();
        let database = new_database().await;
        let registry = Registry::default();
        let list_query = default_list_query(s.root());
        let list_key = list_query.snapshot_key();
        let log = Arc::new(Mutex::new(Vec::new()));
        let emit = emitter(&log);
        let c = CancellationToken::new();
        let mut subs = [pin_subscriber(
            &registry,
            &host,
            &database,
            &scope,
            &list_query,
            &list_key,
            None,
            tab_none(),
            &emit,
            &c,
        )];
        drive(&mut subs).await;
        tokio::time::advance(Duration::from_secs(20)).await;
        drive(&mut subs).await;
        c.cancel();
        drive(&mut subs).await;
        fs::write(s.path("release"), "").unwrap();
        drive(&mut subs).await;
        drop(subs);
        let row = stored(&database, &scope.host, &scope.repository, "list", &list_key).await;
        assert!(row.is_none(), "cancelling mid-flight drops the pending put");
    }

    #[tokio::test(start_paused = true)]
    async fn gitlab_poller_emits_one_all_false_event_when_a_lease_is_acquired() {
        let (s, host, scope) = fixture();
        let database = new_database().await;
        let registry = Registry::default();
        let list_query = default_list_query(s.root());
        let list_key = list_query.snapshot_key();
        let log = Arc::new(Mutex::new(Vec::new()));
        let emit = emitter(&log);
        let c = CancellationToken::new();
        let mut subs = [pin_subscriber(
            &registry,
            &host,
            &database,
            &scope,
            &list_query,
            &list_key,
            Some(3941),
            tab_none(),
            &emit,
            &c,
        )];
        drive(&mut subs).await;
        assert_eq!(*log.lock().unwrap(), vec![Changed::default()]);
        assert!(
            calls(&s).is_empty(),
            "the connected event needs no host read"
        );
        c.cancel();
        drive(&mut subs).await;
    }

    #[tokio::test(start_paused = true)]
    async fn gitlab_poller_a_later_poller_stores_a_change_over_rows_an_earlier_poller_left() {
        let (s, host, scope) = fixture();
        fs::write(s.path("list.json"), list_json("2024-01-01T00:00:00Z")).unwrap();
        let database = new_database().await;
        let registry = Registry::default();
        let list_query = default_list_query(s.root());
        let list_key = list_query.snapshot_key();
        let log = Arc::new(Mutex::new(Vec::new()));
        let emit = emitter(&log);

        let first_c = CancellationToken::new();
        let mut first = [pin_subscriber(
            &registry,
            &host,
            &database,
            &scope,
            &list_query,
            &list_key,
            None,
            tab_none(),
            &emit,
            &first_c,
        )];
        drive(&mut first).await;
        tokio::time::advance(Duration::from_secs(20)).await;
        drive_until(&mut first, || log.lock().unwrap().len() >= 2).await;
        let earlier = stored_while_driving(
            &mut first,
            &database,
            &scope.host,
            &scope.repository,
            "list",
            &list_key,
        )
        .await
        .expect("the first poller stores its page");
        drop(first);

        fs::write(s.path("list.json"), list_json("2024-01-02T00:00:00Z")).unwrap();
        let second_c = CancellationToken::new();
        let mut second = [pin_subscriber(
            &registry,
            &host,
            &database,
            &scope,
            &list_query,
            &list_key,
            None,
            tab_none(),
            &emit,
            &second_c,
        )];
        drive(&mut second).await;
        tokio::time::advance(Duration::from_secs(20)).await;
        drive_until(&mut second, || log.lock().unwrap().len() >= 4).await;
        assert_eq!(count(&s, "mr list"), 2);
        let later = stored_while_driving(
            &mut second,
            &database,
            &scope.host,
            &scope.repository,
            "list",
            &list_key,
        )
        .await
        .unwrap();
        assert!(later.generation > earlier.generation);
        assert!(
            String::from_utf8(later.payload)
                .unwrap()
                .contains("2024-01-02T00:00:00Z"),
            "a new poller's tick counter must not lose to the rows an earlier one left"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn gitlab_poller_every_subscriber_of_the_key_receives_list_events_and_only_the_probed_number_gets_detail_names()
     {
        let (s, host, scope) = fixture();
        fs::write(s.path("list.json"), list_json("2024-01-01T00:00:00Z")).unwrap();
        let database = new_database().await;
        let registry = Registry::default();
        let list_query = default_list_query(s.root());
        let list_key = list_query.snapshot_key();
        let driver_log = Arc::new(Mutex::new(Vec::new()));
        let list_log = Arc::new(Mutex::new(Vec::new()));
        let files_log = Arc::new(Mutex::new(Vec::new()));
        let driver_emit = emitter(&driver_log);
        let list_emit = emitter(&list_log);
        let files_emit = emitter(&files_log);
        let c = CancellationToken::new();
        let mut subs = [
            pin_subscriber(
                &registry,
                &host,
                &database,
                &scope,
                &list_query,
                &list_key,
                Some(3941),
                tab_none(),
                &driver_emit,
                &c,
            ),
            pin_subscriber(
                &registry,
                &host,
                &database,
                &scope,
                &list_query,
                &list_key,
                None,
                tab_none(),
                &list_emit,
                &c,
            ),
            pin_subscriber(
                &registry,
                &host,
                &database,
                &scope,
                &list_query,
                &list_key,
                Some(3941),
                ActiveTab {
                    commits: false,
                    files: true,
                },
                &files_emit,
                &c,
            ),
        ];
        drive(&mut subs).await;
        tokio::time::advance(Duration::from_secs(20)).await;
        drive_until(&mut subs, || {
            [&driver_log, &list_log, &files_log]
                .iter()
                .all(|log| log.lock().unwrap().len() >= 2)
        })
        .await;
        drive(&mut subs).await;
        assert_eq!(count(&s, "mr list"), 1, "one poller drives the key");
        assert_eq!(
            count(&s, "api projects/gitlab-org%2Fcli/merge_requests/3941"),
            1,
            "one probe for the driver's number"
        );
        let first_probe = Changed {
            list: true,
            detail: true,
            timeline: true,
            commits: false,
            checks: true,
            files: false,
        };
        assert_eq!(ticks(&driver_log), vec![first_probe.clone()]);
        assert_eq!(
            ticks(&list_log),
            vec![Changed {
                list: true,
                ..Changed::default()
            }],
            "a waiting subscriber with no open number still hears the list change"
        );
        assert_eq!(
            ticks(&files_log),
            vec![Changed {
                files: true,
                ..first_probe
            }],
            "a waiting subscriber of the probed number keeps its own tab's names"
        );
        c.cancel();
        drive(&mut subs).await;
    }
}
