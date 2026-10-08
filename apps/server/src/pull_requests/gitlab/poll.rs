//! One poller per `(host, project, list key)`, reference counted across the
//! subscribers that share it. Each `subscribe` RPC call is already spawned by
//! the exempt `production/pull_requests_rpc.rs`; this module runs the tick
//! loop cooperatively inside that call instead of spawning a background task
//! (forbidden everywhere else in `pull_requests`, see the `mod.rs` tripwires).
//!
//! See `docs/superpowers/specs/2026-10-08-gitlab-merge-request-background-sync-design.md`.

use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicI64, Ordering},
    },
    time::Duration,
};

use tokio_util::sync::CancellationToken;

use crate::persistence::Database;

use super::{
    GitLabHost,
    refresh::{ListFingerprint, ProbeFingerprint, RefreshNames, detail_refresh, list_changed},
};
use crate::pull_requests::{
    host::{HostScope, PullRequestHost},
    model::{Changed, Detail, ListQuery, ListRow},
    permissions,
    snapshot_store::{Snapshot as StoredSnapshot, SnapshotStore},
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
        drop(entries);
        Lease {
            registry: self,
            key,
            shared,
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
}

impl Drop for Lease<'_> {
    fn drop(&mut self) {
        if let Some(shared) = self.registry.release(&self.key) {
            shared.cancellation.cancel();
        }
    }
}

#[derive(Default)]
struct Shared {
    cancellation: CancellationToken,
    driver_lock: tokio::sync::Mutex<()>,
    tick: AtomicI64,
}

impl Shared {
    fn next_tick(&self) -> i64 {
        self.tick.fetch_add(1, Ordering::SeqCst) + 1
    }
}

enum TickOutcome {
    Success,
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

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
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

#[allow(clippy::too_many_arguments)]
async fn store(
    database: &Database,
    host: &str,
    project: &str,
    kind: &'static str,
    key: &str,
    fingerprint: String,
    payload: Vec<u8>,
    generation: i64,
) {
    let host = host.to_owned();
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
                observed_at_ms: now_ms(),
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
    let host = host.to_owned();
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

/// Mirrors `PullRequestsService::get`'s permission computation: the poller
/// stores the same shape the unary `pullRequests.get` RPC answers.
async fn full_detail(
    host: &GitLabHost,
    scope: &HostScope,
    number: u64,
    c: &CancellationToken,
) -> Result<Detail, crate::pull_requests::error::PullRequestsOperationError> {
    let context = host.context(scope, c).await?;
    let raw = host.detail(scope, number, &context, c).await?;
    let (permissions, readiness) = permissions::compute(&raw.inputs);
    let mut detail = raw.detail_without_permissions;
    for reviewer in &mut detail.reviewers {
        reviewer.can_rerequest = permissions::can_rerequest(&permissions, reviewer.state);
    }
    detail.permissions = permissions;
    detail.readiness = readiness;
    Ok(detail)
}

#[allow(clippy::too_many_arguments)]
async fn run_tick(
    host: &GitLabHost,
    database: &Database,
    scope: &HostScope,
    list_query: &ListQuery,
    list_key: &str,
    number: Option<u64>,
    tab: ActiveTab,
    generation: i64,
    emit: &(dyn Fn(Changed) + Send + Sync),
    c: &CancellationToken,
    shared_cancel: &CancellationToken,
) -> TickOutcome {
    let mut changed = Changed {
        list: false,
        detail: false,
        timeline: false,
        commits: false,
        checks: false,
        files: false,
    };

    let page = match host.list(scope, list_query, c).await {
        Ok(page) => page,
        Err(error) => {
            return classify(&error);
        }
    };
    let next_list_fp: Vec<ListFingerprint> = page.rows.iter().map(list_row_fingerprint).collect();
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
        emit(changed);
        return TickOutcome::Success;
    };

    let next_probe = match host.probe(scope, number, c).await {
        Ok(probe) => probe,
        Err(error) => {
            return classify(&error);
        }
    };
    let key = number.to_string();
    let previous_probe: Option<ProbeFingerprint> =
        load_fingerprint(database, &scope.host, &scope.repository, "detail", &key)
            .await
            .and_then(|raw| serde_json::from_str(&raw).ok());
    let names = match &previous_probe {
        Some(previous) => detail_refresh(previous, &next_probe, tab),
        // Nothing has ever been read for this number: fetch everything the
        // active tab needs instead of waiting for a second, differing probe.
        None => RefreshNames {
            detail: true,
            timeline: true,
            commits: tab.commits,
            checks: true,
            files: tab.files,
        },
    };

    if names.detail {
        match full_detail(host, scope, number, c).await {
            Ok(detail) => {
                if !shared_cancel.is_cancelled()
                    && let (Ok(fingerprint), Ok(payload)) = (
                        serde_json::to_string(&next_probe),
                        serde_json::to_vec(&detail),
                    )
                {
                    store(
                        database,
                        &scope.host,
                        &scope.repository,
                        "detail",
                        &key,
                        fingerprint,
                        payload,
                        generation,
                    )
                    .await;
                    changed.detail = true;
                }
            }
            Err(error) => {
                return classify(&error);
            }
        }
    }
    if names.timeline {
        match host.timeline(scope, number, c).await {
            Ok(timeline) => {
                if !shared_cancel.is_cancelled()
                    && let Ok(payload) = serde_json::to_vec(&timeline)
                {
                    store(
                        database,
                        &scope.host,
                        &scope.repository,
                        "timeline",
                        &key,
                        probe_fingerprint_json(&next_probe),
                        payload,
                        generation,
                    )
                    .await;
                    changed.timeline = true;
                }
            }
            Err(error) => {
                return classify(&error);
            }
        }
    }
    if names.commits {
        match host.commits(scope, number, c).await {
            Ok(commits) => {
                if !shared_cancel.is_cancelled()
                    && let Ok(payload) = serde_json::to_vec(&commits)
                {
                    store(
                        database,
                        &scope.host,
                        &scope.repository,
                        "commits",
                        &key,
                        probe_fingerprint_json(&next_probe),
                        payload,
                        generation,
                    )
                    .await;
                    changed.commits = true;
                }
            }
            Err(error) => {
                return classify(&error);
            }
        }
    }
    if names.checks {
        match host.checks(scope, number, c).await {
            Ok(checks) => {
                if !shared_cancel.is_cancelled()
                    && let Ok(payload) = serde_json::to_vec(&checks)
                {
                    store(
                        database,
                        &scope.host,
                        &scope.repository,
                        "checks",
                        &key,
                        probe_fingerprint_json(&next_probe),
                        payload,
                        generation,
                    )
                    .await;
                    changed.checks = true;
                }
            }
            Err(error) => {
                return classify(&error);
            }
        }
    }
    if names.files {
        match host.files(scope, number, c).await {
            Ok(files) => {
                if !shared_cancel.is_cancelled()
                    && let Ok(payload) = serde_json::to_vec(&files)
                {
                    store(
                        database,
                        &scope.host,
                        &scope.repository,
                        "files",
                        &key,
                        probe_fingerprint_json(&next_probe),
                        payload,
                        generation,
                    )
                    .await;
                    changed.files = true;
                }
            }
            Err(error) => {
                return classify(&error);
            }
        }
    }

    emit(changed);
    TickOutcome::Success
}

fn probe_fingerprint_json(probe: &ProbeFingerprint) -> String {
    serde_json::to_string(probe).unwrap_or_default()
}

/// Runs one subscriber's share of the poll loop until `c` is cancelled or
/// every other subscriber for this key has already left. At most one
/// subscriber per key drives host reads at a time: the rest wait for the
/// driver lock, so a dropped driver hands the loop to another live subscriber
/// instead of stopping it.
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
    let lease = registry.join(key);
    let _permit = tokio::select! {
        biased;
        () = c.cancelled() => return,
        () = lease.shared.cancellation.cancelled() => return,
        permit = lease.shared.driver_lock.lock() => permit,
    };
    let mut delay = BASE_DELAY;
    let mut backoff_index: usize = 0;
    loop {
        tokio::select! {
            biased;
            () = c.cancelled() => return,
            () = lease.shared.cancellation.cancelled() => return,
            () = tokio::time::sleep(delay) => {}
        }
        if c.is_cancelled() || lease.shared.cancellation.is_cancelled() {
            return;
        }
        let generation = lease.shared.next_tick();
        let outcome = run_tick(
            host,
            database,
            scope,
            list_query,
            list_key,
            number,
            tab,
            generation,
            emit,
            c,
            &lease.shared.cancellation,
        )
        .await;
        match outcome {
            TickOutcome::Success => {
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

#[cfg(test)]
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
                    kind: "detail".into(),
                    key: number.to_string(),
                    fingerprint,
                    payload: b"{}".to_vec(),
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
        let row = stored(&database, &scope.host, &scope.repository, "detail", "3941")
            .await
            .unwrap();
        assert_eq!(
            row.payload,
            b"{}".to_vec(),
            "the seeded placeholder payload must remain untouched"
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
    async fn gitlab_poller_changed_updated_at_emits_detail_and_timeline_and_stores_the_detail_payload()
     {
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
        drive_until(&mut subs, || !log.lock().unwrap().is_empty()).await;
        drive(&mut subs).await;
        let changed = log.lock().unwrap()[0].clone();
        assert!(changed.detail && changed.timeline);
        assert!(!changed.commits && !changed.checks && !changed.files);
        assert!(
            count(
                &s,
                "api projects/gitlab-org%2Fcli/merge_requests/3941/approvals"
            ) >= 1,
            "the unary detail method ran"
        );
        let row = stored(&database, &scope.host, &scope.repository, "detail", "3941")
            .await
            .unwrap();
        let payload: Value = serde_json::from_slice(&row.payload).unwrap();
        assert!(
            payload.get("permissions").is_some() && payload.get("readiness").is_some(),
            "the stored payload is the detail response, not the probe JSON"
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
        drive_until(&mut subs, || !log.lock().unwrap().is_empty()).await;
        drive(&mut subs).await;
        let changed = log.lock().unwrap()[0].clone();
        assert!(changed.detail && changed.checks);
        assert!(!changed.timeline && !changed.commits && !changed.files);
        assert_eq!(
            count(
                &s,
                "api projects/gitlab-org%2Fcli/merge_requests/3941/pipelines?per_page=1"
            ),
            1
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
            log.lock().unwrap().is_empty(),
            "a 429 tick must never call emit"
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
        assert!(
            !log.lock().unwrap().is_empty(),
            "a successful tick must emit"
        );
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
            log.lock().unwrap().is_empty(),
            "a non-429 host error must never call emit either"
        );
        tokio::time::advance(Duration::from_secs(20)).await;
        drive_until(&mut subs, || count(&s, "mr list") >= 2).await;
        drive(&mut subs).await;
        assert_eq!(
            count(&s, "mr list"),
            2,
            "a generic error backs off at the base 20s delay, not the 429 ladder"
        );
        assert!(log.lock().unwrap().is_empty());
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
        let log = Arc::new(Mutex::new(Vec::new()));
        let emit = emitter(&log);
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
            tab_none(),
            1,
            &emit,
            &c,
            &shared_cancel,
        )
        .await;

        assert!(matches!(outcome, TickOutcome::Success));
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
        let row = stored_while_driving(
            &mut subs,
            &database,
            &scope.host,
            &scope.repository,
            "list",
            &list_key,
        )
        .await;
        assert_eq!(
            row.map(|row| row.generation),
            Some(1),
            "the first tick's own write must land before either token is cancelled"
        );

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
        assert_eq!(
            row.map(|row| row.generation),
            Some(2),
            "a second subscriber is still active, so the shared poller-wide cancellation never \
             fired; the second tick's write must still land even though the driving \
             subscriber's own token cancelled, instead of leaving tick 1's stale row in place"
        );

        // Confirms the surviving subscriber (never cancelled) is the one
        // that actually took over driving, rather than some other path.
        assert!(
            !log2.lock().unwrap().is_empty(),
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
}
