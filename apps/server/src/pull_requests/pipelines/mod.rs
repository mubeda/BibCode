//! A project's CI pipelines, built the way the Pull Requests module is:
//! every unary read stores the display row `readSnapshot` paints with no
//! host call, GitLab views share one cooperative poller per list key
//! (`poll.rs`), and every read honors the host-wide 429 ladder. Job logs are
//! byte windows (`log.rs`) and never reach the database.
//!
//! The context, sign-in state, logout fences, backoff and snapshot table are
//! the Pull Requests module's own: `PipelinesService` holds that service.
//! See `docs/plans/2026-10-24-pipelines-module-design.md`.

pub(crate) mod log;
pub mod model;
pub(crate) mod poll;

use std::{
    collections::HashMap,
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};

use serde::{Deserialize, Serialize, de::DeserializeOwned};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use self::{
    log::{FullLog, JobFacts, LogKey, RANGE_WINDOW, RangeSupport, SharedTail},
    model::{
        Changed, Detail, GetInput, JobDetail, JobInput, JobLog, JobLogInput, ListInput, ListPage,
        LogChunk, LogFrom, LogUnavailable, LogUnavailableAnswer, Refresh, Row, Snapshot, Stored,
        SubscribeInput, Total,
    },
};
use super::{
    CONTEXT_KIND, PullRequestsService, bounded_read,
    context::{self, ContextRead, DiscoveredHosts},
    error::PullRequestsOperationError,
    host::{HostContext, HostFuture, HostScope},
    model::{Context, PullRequestsProvider},
    snapshot_store::{self, SnapshotStore},
};
use crate::persistence::Database;

pub(crate) const LIST_KIND: &str = "pipelines_list";
pub(crate) const DETAIL_KIND: &str = "pipelines_detail";
pub(crate) const JOB_KIND: &str = "pipelines_job";
/// A list's `count` is reused this long, except on a user read of a first page.
const COUNT_REUSE: Duration = Duration::from_secs(5 * 60);

/// One list page as the provider gave it, before the service stamps it.
pub(crate) struct ListRead {
    pub rows: Vec<Row>,
    pub next_cursor: Option<String>,
    pub total: Option<Total>,
}

/// A trace read: its bytes, and how many bytes of a whole log's head a
/// download dropped to keep its last 16 MiB.
pub(crate) struct TraceRead {
    pub bytes: Vec<u8>,
    pub dropped: u64,
}

fn unavailable<'a, T: 'a>(operation: &'static str) -> HostFuture<'a, T> {
    Box::pin(async move { Err(PullRequestsOperationError::new(operation, "unavailable")) })
}

/// One provider's pipelines reads. Object safe, with every read answering
/// `unavailable` until a provider implements it, as `PullRequestHost` does.
pub(crate) trait PipelineHost: Send + Sync {
    /// The provider reads logs by byte range (GitLab), once proved per host.
    fn ranged_logs(&self) -> bool {
        false
    }

    /// The last good context, with no host call, for the poller.
    fn known_context(&self, _scope: &HostScope) -> Option<HostContext> {
        None
    }

    fn list<'a>(
        &'a self,
        _scope: &'a HostScope,
        _context: &'a HostContext,
        _input: &'a ListInput,
        _with_count: bool,
        _c: &'a CancellationToken,
    ) -> HostFuture<'a, ListRead> {
        unavailable("pipelines.list")
    }

    fn detail<'a>(
        &'a self,
        _scope: &'a HostScope,
        _context: &'a HostContext,
        _pipeline_id: u64,
        _attempt: Option<u64>,
        _c: &'a CancellationToken,
    ) -> HostFuture<'a, Detail> {
        unavailable("pipelines.get")
    }

    fn job<'a>(
        &'a self,
        _scope: &'a HostScope,
        _context: &'a HostContext,
        _job_id: u64,
        _c: &'a CancellationToken,
    ) -> HostFuture<'a, JobDetail> {
        unavailable("pipelines.getJob")
    }

    /// `range` is `(byte_offset, byte_limit)`; `None` downloads the whole log.
    fn trace<'a>(
        &'a self,
        _scope: &'a HostScope,
        _job_id: u64,
        _attempt: Option<u64>,
        _range: Option<(u64, u64)>,
        _c: &'a CancellationToken,
    ) -> HostFuture<'a, TraceRead> {
        unavailable("pipelines.getJobLog")
    }
}

/// GitHub's workflow runs arrive with their own reader; until then every
/// GitHub read answers `unavailable`, and `readSnapshot` still serves rows.
impl PipelineHost for super::github::GitHubHost {}

/// A list's count, per lowercased host, project and list key.
type CountKey = (String, String, String);

/// Server memory the pipelines reads share across service clones: the log
/// cache, the GitLab pollers and the reused list counts.
#[derive(Default)]
pub(crate) struct PipelinesState {
    pub(crate) logs: log::LogCache,
    pub(crate) pollers: poll::Registry,
    counts: Mutex<HashMap<CountKey, (Instant, Total)>>,
}

impl PipelinesState {
    /// Rescan and sign-in changes.
    pub(crate) fn forget_contexts(&self) {
        self.logs.clear();
        self.counts
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clear();
    }

    /// A sign-in failure on one host.
    pub(crate) fn forget_host(&self, host: &str) {
        let host = host.to_ascii_lowercase();
        self.logs.remove_host(&host);
        self.counts
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .retain(|key, _| key.0 != host);
    }

    fn count(&self, key: &CountKey) -> Option<(Duration, Total)> {
        self.counts
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(key)
            .map(|(at, total)| (at.elapsed(), total.clone()))
    }

    fn remember_count(&self, key: CountKey, total: Total) {
        self.counts
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(key, (Instant::now(), total));
    }
}

/// The stored row: the payload, and the account login that read it.
#[derive(Serialize)]
struct StoredRowRef<'a, T> {
    login: &'a str,
    payload: &'a T,
}

#[derive(Deserialize)]
struct StoredRow<T> {
    login: String,
    payload: T,
}

/// A stored row's payload, when the account that read it is `login`.
pub(crate) fn decode_row<T: DeserializeOwned>(payload: &[u8], login: &str) -> Option<T> {
    serde_json::from_slice::<StoredRow<T>>(payload)
        .ok()
        .filter(|row| row.login == login)
        .map(|row| row.payload)
}

pub(crate) fn detail_key(pipeline_id: u64, attempt: Option<u64>) -> String {
    match attempt {
        Some(attempt) => format!("{pipeline_id}:{attempt}"),
        None => pipeline_id.to_string(),
    }
}

/// What a list tick compares: ids, statuses, stage statuses and times.
pub(crate) fn list_fingerprint(rows: &[Row]) -> String {
    let rows: Vec<_> = rows
        .iter()
        .map(|row| {
            (
                row.id,
                row.status,
                row.warnings,
                row.terminal,
                row.stages.as_ref().map(|stages| {
                    stages
                        .iter()
                        .map(|stage| (stage.status, stage.warnings))
                        .collect::<Vec<_>>()
                }),
                &row.started_at,
                &row.finished_at,
            )
        })
        .collect();
    serde_json::to_string(&rows).unwrap_or_default()
}

/// What a pipeline tick compares: its status, and each job's id and status.
pub(crate) fn detail_fingerprint(detail: &Detail) -> String {
    let jobs: Vec<_> = detail
        .jobs()
        .map(|job| (job.id, job.status, job.warnings))
        .collect();
    serde_json::to_string(&(
        detail.pipeline.status,
        detail.pipeline.warnings,
        detail.pipeline.terminal,
        jobs,
    ))
    .unwrap_or_default()
}

/// Stores one display row in the shared snapshot table, fenced and
/// generation ordered as the Pull Requests rows are.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn store_row<T: Serialize>(
    database: &Database,
    fences: &snapshot_store::HostFences,
    scope: &HostScope,
    login: &str,
    kind: &'static str,
    key: &str,
    fingerprint: String,
    value: &T,
    generation: i64,
) -> super::gitlab::poll::WriteOutcome {
    let Ok(payload) = serde_json::to_vec(&StoredRowRef {
        login,
        payload: value,
    }) else {
        return super::gitlab::poll::WriteOutcome::Failed("encode");
    };
    super::gitlab::poll::store(
        database,
        fences,
        &scope.host,
        &scope.repository,
        kind,
        key,
        fingerprint,
        payload,
        generation,
    )
    .await
}

/// The rows a refused read deletes: only the resource that refused.
#[derive(Clone, Debug)]
enum Resource {
    None,
    List(String),
    Pipeline(u64),
    Job(u64),
}

/// The host, its context and its provider reader, for one admitted read.
struct Admitted {
    scope: HostScope,
    context: HostContext,
    host: Arc<dyn PipelineHost>,
}

impl Admitted {
    fn log_key(&self, job: u64, attempt: Option<u64>) -> LogKey {
        LogKey {
            host: self.scope.host.to_ascii_lowercase(),
            login: self.context.account.login.clone(),
            project: self.scope.repository.clone(),
            job,
            attempt,
        }
    }
}

/// A read refused before any host call (the backoff deadline), or a host
/// failure.
enum Failure {
    Held(PullRequestsOperationError),
    Host(PullRequestsOperationError),
}

impl From<PullRequestsOperationError> for Failure {
    fn from(error: PullRequestsOperationError) -> Self {
        Self::Host(error)
    }
}

fn rate_limited(operation: &str, remaining: Duration) -> PullRequestsOperationError {
    let mut error = PullRequestsOperationError::new(operation, "rate_limited");
    error.retry_after_seconds = Some(super::error::retry_seconds(remaining).max(1));
    error
}

fn snapshot_unavailable(operation: &str) -> PullRequestsOperationError {
    let mut error = PullRequestsOperationError::new(operation, "unavailable");
    error.message = "Pipeline snapshots are not available for this host.".into();
    error
}

fn job_facts(job: &JobDetail) -> JobFacts {
    JobFacts {
        terminal: job.job.terminal,
        erased: job.erased,
        log_bytes: job.log_bytes,
        raw_log_url: job.raw_log_url.clone().or_else(|| job.job.url.clone()),
    }
}

fn log_unavailable(reason: LogUnavailable, facts: &JobFacts) -> JobLog {
    JobLog::Unavailable(LogUnavailableAnswer {
        reason,
        url: facts.raw_log_url.clone(),
    })
}

/// A ranged read's answer. `full` says the read filled its window, so more
/// text may follow.
fn ranged_chunk(
    start: u64,
    bytes: &[u8],
    full: bool,
    from: LogFrom,
    facts: Option<&JobFacts>,
) -> JobLog {
    let terminal = facts.is_some_and(|facts| facts.terminal);
    if !terminal
        && full
        && matches!(from, LogFrom::Offset { .. })
        && start + bytes.len() as u64 >= log::LIVE_CATCH_UP
    {
        // Still catching up past four reads: the head stays on screen and the
        // log is read again once the job finishes.
        return JobLog::Unavailable(LogUnavailableAnswer {
            reason: LogUnavailable::TooLargeLive,
            url: facts.and_then(|facts| facts.raw_log_url.clone()),
        });
    }
    let (offset, next_offset, text) =
        log::decode_window(start, bytes, !matches!(from, LogFrom::Offset { .. }));
    let total = facts
        .filter(|facts| facts.terminal)
        .and_then(|facts| facts.log_bytes);
    let complete = terminal
        && !matches!(from, LogFrom::Before { .. })
        && total.map_or(!full, |size| start + bytes.len() as u64 >= size);
    JobLog::Chunk(LogChunk {
        text,
        offset,
        next_offset,
        total_bytes: total,
        complete,
        truncated_head: false,
        // The range path knows line numbers only from the start of the log.
        first_line: (offset == 0).then_some(0),
    })
}

#[derive(Clone)]
pub struct PipelinesService {
    service: PullRequestsService,
    gitlab: Arc<dyn PipelineHost>,
    github: Arc<dyn PipelineHost>,
}

impl PullRequestsService {
    /// The Pipelines reads over this service's context caches, sign-in
    /// state, backoff, fences and snapshot table.
    #[must_use]
    pub fn pipelines(&self) -> PipelinesService {
        PipelinesService {
            gitlab: self.gitlab_host.clone(),
            github: Arc::new(super::github::GitHubHost::new(self.runner.clone())),
            service: self.clone(),
        }
    }
}

impl PipelinesService {
    /// Only the Unix service tests resolve a checkout through fake scripts.
    #[cfg(all(test, unix))]
    pub(crate) fn with_hosts(
        service: PullRequestsService,
        gitlab: Arc<dyn PipelineHost>,
        github: Arc<dyn PipelineHost>,
    ) -> Self {
        Self {
            service,
            gitlab,
            github,
        }
    }

    fn state(&self) -> &PipelinesState {
        &self.service.pipelines
    }

    fn backoff(&self) -> &super::backoff::HostBackoff {
        self.service.pollers.host_backoff()
    }

    fn fences(&self) -> &snapshot_store::HostFences {
        self.service.pollers.fences()
    }

    fn host(&self, scope: &HostScope) -> Arc<dyn PipelineHost> {
        match scope.provider {
            PullRequestsProvider::Github => self.github.clone(),
            PullRequestsProvider::Gitlab => self.gitlab.clone(),
        }
    }

    /// The checkout's host, its backoff deadline, its sign-in and its
    /// context, in that order: a backed-off host gets no call at all.
    async fn admit(
        &self,
        operation: &'static str,
        cwd: &Path,
        c: &CancellationToken,
    ) -> Result<Admitted, Failure> {
        let runner = &self.service.runner;
        let pending = context::resolve_pending_scope(
            runner,
            cwd,
            &DiscoveredHosts::default(),
            ContextRead::Open,
            c,
        )
        .await
        .map_err(|u| Failure::Host(u.operation_error(operation)))?;
        if let Some(remaining) = self.backoff().remaining(&pending.scope.host) {
            return Err(Failure::Held(rate_limited(operation, remaining)));
        }
        pending
            .authenticate(runner, c)
            .await
            .map_err(|u| Failure::Host(u.operation_error(operation)))?;
        let scope = pending.scope;
        let context = self
            .service
            .host(&scope)
            .context(&scope, c)
            .await
            .map_err(|mut error| {
                error.operation = operation.into();
                Failure::Host(error)
            })?;
        Ok(Admitted {
            host: self.host(&scope),
            scope,
            context,
        })
    }

    /// One bounded read: admission, the provider read and its stored row,
    /// then what its failure means for the shared state.
    async fn read<T>(
        &self,
        operation: &'static str,
        cwd: &Path,
        timeout: Duration,
        resource: Resource,
        c: &CancellationToken,
        read: impl AsyncFnOnce(
            &Admitted,
            i64,
            &CancellationToken,
        ) -> Result<T, PullRequestsOperationError>,
    ) -> Result<T, PullRequestsOperationError> {
        let started = Instant::now();
        let generation = snapshot_store::next_generation();
        let admitted_scope: Arc<Mutex<Option<HostScope>>> = Arc::default();
        let captured = admitted_scope.clone();
        let result = bounded_read(operation, timeout, c, |c| async move {
            let admitted = self
                .admit(operation, cwd, &c)
                .await
                .map_err(|failure| match failure {
                    Failure::Held(error) => (error, true),
                    Failure::Host(error) => (error, false),
                });
            let admitted = match admitted {
                Ok(admitted) => admitted,
                Err((error, true)) => return Ok(Err(error)),
                Err((error, false)) => return Err(error),
            };
            *captured.lock().unwrap_or_else(|p| p.into_inner()) = Some(admitted.scope.clone());
            read(&admitted, generation, &c).await.map(Ok)
        })
        .await;
        let scope = admitted_scope
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        match result {
            // Held by the backoff deadline: no host call, and no ladder step.
            Ok(Err(held)) => Err(held),
            Ok(Ok(value)) => {
                if let Some(scope) = &scope {
                    self.backoff().recovered(&scope.host, started);
                }
                Ok(value)
            }
            Err(error) => Err(self
                .failed(operation, error, scope.as_ref(), &resource)
                .await),
        }
    }

    async fn failed(
        &self,
        operation: &'static str,
        mut error: PullRequestsOperationError,
        scope: Option<&HostScope>,
        resource: &Resource,
    ) -> PullRequestsOperationError {
        tracing::warn!(operation, code = error.code, "pipelines read failed");
        let Some(scope) = scope else {
            return error;
        };
        match error.code {
            "rate_limited" => {
                let delay = self.backoff().back_off(
                    &scope.host,
                    error
                        .retry_after_seconds
                        .map(|seconds| Duration::from_secs(seconds.into())),
                );
                error.retry_after_seconds = Some(super::error::retry_seconds(delay));
                tracing::warn!(
                    operation,
                    delay_seconds = delay.as_secs(),
                    "pipelines reads backed off"
                );
            }
            // Only a lost sign-in discredits the shared context and rows.
            "not_authenticated" => {
                self.service
                    .invalidate_failed_context(&error, Some(&scope.host))
                    .await;
            }
            // About this resource, not the login: only its own rows go.
            "forbidden" | "not_found" => self.delete_resource(scope, resource).await,
            _ => {}
        }
        error
    }

    async fn delete_resource(&self, scope: &HostScope, resource: &Resource) {
        let Some(database) = self.service.database.clone() else {
            return;
        };
        let (kind, key, attempts) = match resource {
            Resource::None => return,
            Resource::List(key) => (LIST_KIND, key.clone(), false),
            Resource::Pipeline(id) => (DETAIL_KIND, id.to_string(), true),
            Resource::Job(id) => (JOB_KIND, id.to_string(), false),
        };
        let host = scope.host.to_ascii_lowercase();
        let project = scope.repository.clone();
        let _ = database
            .call(move |connection| {
                Ok(SnapshotStore::new(connection)
                    .delete_keyed(&host, &project, kind, &key, attempts)?)
            })
            .await;
    }

    async fn store<T: Serialize>(
        &self,
        admitted: &Admitted,
        kind: &'static str,
        key: &str,
        fingerprint: String,
        value: &T,
        generation: i64,
    ) {
        let Some(database) = self.service.database.clone() else {
            return;
        };
        store_row(
            &database,
            self.fences(),
            &admitted.scope,
            &admitted.context.account.login,
            kind,
            key,
            fingerprint,
            value,
            generation,
        )
        .await;
    }

    pub async fn list(
        &self,
        input: ListInput,
        c: &CancellationToken,
    ) -> Result<ListPage, PullRequestsOperationError> {
        let operation = "pipelines.list";
        let key = input.snapshot_key();
        let first_page = input.cursor.is_none();
        let resource = if first_page {
            Resource::List(key.clone())
        } else {
            Resource::None
        };
        let cwd = input.cwd.clone();
        self.read(
            operation,
            Path::new(&cwd),
            Duration::from_secs(30),
            resource,
            c,
            async |admitted, generation, c| {
                let count_key = (
                    admitted.scope.host.to_ascii_lowercase(),
                    admitted.scope.repository.clone(),
                    key.clone(),
                );
                let cached = self.state().count(&count_key);
                let with_count = first_page
                    && (input.refresh == Refresh::User
                        || cached.as_ref().is_none_or(|(age, _)| *age >= COUNT_REUSE));
                let read = admitted
                    .host
                    .list(&admitted.scope, &admitted.context, &input, with_count, c)
                    .await?;
                let total = match read.total {
                    Some(total) if with_count => {
                        self.state().remember_count(count_key, total.clone());
                        Some(total)
                    }
                    _ => cached.map(|(_, total)| total),
                };
                let page = ListPage {
                    revision: generation,
                    rows: read.rows,
                    next_cursor: read.next_cursor,
                    total,
                    workflows: None,
                };
                // Only first pages are painted from snapshots.
                if first_page {
                    self.store(
                        admitted,
                        LIST_KIND,
                        &key,
                        list_fingerprint(&page.rows),
                        &page,
                        generation,
                    )
                    .await;
                }
                Ok(page)
            },
        )
        .await
    }

    pub async fn get(
        &self,
        input: GetInput,
        c: &CancellationToken,
    ) -> Result<Detail, PullRequestsOperationError> {
        let operation = "pipelines.get";
        let cwd = input.cwd.clone();
        self.read(
            operation,
            Path::new(&cwd),
            Duration::from_secs(60),
            Resource::Pipeline(input.pipeline_id),
            c,
            async |admitted, generation, c| {
                let mut detail = admitted
                    .host
                    .detail(
                        &admitted.scope,
                        &admitted.context,
                        input.pipeline_id,
                        input.attempt,
                        c,
                    )
                    .await?;
                detail.revision = generation;
                self.store(
                    admitted,
                    DETAIL_KIND,
                    &detail_key(input.pipeline_id, input.attempt),
                    detail_fingerprint(&detail),
                    &detail,
                    generation,
                )
                .await;
                Ok(detail)
            },
        )
        .await
    }

    pub async fn job(
        &self,
        input: JobInput,
        c: &CancellationToken,
    ) -> Result<JobDetail, PullRequestsOperationError> {
        let operation = "pipelines.getJob";
        let cwd = input.cwd.clone();
        self.read(
            operation,
            Path::new(&cwd),
            Duration::from_secs(30),
            Resource::Job(input.job_id),
            c,
            async |admitted, generation, c| {
                let mut job = admitted
                    .host
                    .job(&admitted.scope, &admitted.context, input.job_id, c)
                    .await?;
                job.revision = generation;
                self.state().logs.record_job(
                    &admitted.log_key(input.job_id, job.attempt),
                    job_facts(&job),
                );
                self.store(
                    admitted,
                    JOB_KIND,
                    &input.job_id.to_string(),
                    String::new(),
                    &job,
                    generation,
                )
                .await;
                Ok(job)
            },
        )
        .await
    }

    pub async fn job_log(
        &self,
        input: JobLogInput,
        c: &CancellationToken,
    ) -> Result<JobLog, PullRequestsOperationError> {
        let operation = "pipelines.getJobLog";
        let cwd = input.cwd.clone();
        // A whole download has 90 s; a job read before it, 30 s.
        self.read(
            operation,
            Path::new(&cwd),
            Duration::from_secs(150),
            Resource::Job(input.job_id),
            c,
            async |admitted, generation, c| {
                let key = admitted.log_key(input.job_id, input.attempt);
                let ranged = admitted.host.ranged_logs()
                    && self.state().logs.range_support(&key.host) == RangeSupport::Supported;
                if ranged {
                    self.ranged_log(admitted, &key, &input, c).await
                } else {
                    self.downloaded_log(admitted, &key, &input, generation, c)
                        .await
                }
            },
        )
        .await
    }

    /// The job's facts from a read by this account within 30 s, or a new
    /// job read (`fresh` always reads).
    async fn facts(
        &self,
        admitted: &Admitted,
        key: &LogKey,
        fresh: bool,
        c: &CancellationToken,
    ) -> Result<JobFacts, PullRequestsOperationError> {
        if !fresh && let Some(facts) = self.state().logs.recent_job(key) {
            return Ok(facts);
        }
        let job = admitted
            .host
            .job(&admitted.scope, &admitted.context, key.job, c)
            .await
            .map_err(|mut error| {
                error.operation = "pipelines.getJobLog".into();
                error
            })?;
        let facts = job_facts(&job);
        self.state().logs.record_job(key, facts.clone());
        Ok(facts)
    }

    /// GitLab answers 404 both for a missing job and for a job with no log
    /// yet: the job read tells them apart.
    async fn missing_log(
        &self,
        admitted: &Admitted,
        key: &LogKey,
        c: &CancellationToken,
    ) -> Result<JobLog, PullRequestsOperationError> {
        let facts = self.facts(admitted, key, true, c).await?;
        let reason = if facts.erased {
            LogUnavailable::Erased
        } else if !facts.terminal {
            LogUnavailable::NotStarted
        } else {
            LogUnavailable::NoOutput
        };
        Ok(log_unavailable(reason, &facts))
    }

    /// The full-download path: one download per log into `LogCache`, served
    /// in 1 MiB windows from the end.
    async fn downloaded_log(
        &self,
        admitted: &Admitted,
        key: &LogKey,
        input: &JobLogInput,
        generation: i64,
        c: &CancellationToken,
    ) -> Result<JobLog, PullRequestsOperationError> {
        let logs = &self.state().logs;
        if let Some(log) = logs.cached(key) {
            // A memory answer needs a job read by this account within 30 s.
            self.facts(admitted, key, false, c).await?;
            return Ok(JobLog::Chunk(log.window(input.from)));
        }
        let facts = self.facts(admitted, key, false, c).await?;
        if facts.erased {
            return Ok(log_unavailable(LogUnavailable::Erased, &facts));
        }
        let terminal = facts.terminal;
        let download = async {
            let read = admitted
                .host
                .trace(&admitted.scope, key.job, key.attempt, None, c)
                .await?;
            Ok(FullLog {
                bytes: Arc::new(read.bytes),
                base: read.dropped,
                complete: terminal,
                downloaded_at: Instant::now(),
            })
        };
        let log = match logs
            .get_or_download(
                key.clone(),
                self.fences(),
                generation,
                c,
                || PullRequestsOperationError::new("pipelines.getJobLog", "timeout"),
                download,
            )
            .await
        {
            Ok(log) => log,
            Err(error) if error.code == "not_found" => {
                return self.missing_log(admitted, key, c).await;
            }
            Err(error) => return Err(error),
        };
        if admitted.host.ranged_logs()
            && logs.range_support(&key.host) == RangeSupport::Unknown
            && log.base == 0
            && log.bytes.len() >= 2
        {
            self.probe_ranges(admitted, key, c).await;
        }
        Ok(JobLog::Chunk(log.window(input.from)))
    }

    /// One `byte_offset=1&byte_limit=1` read proves whether the host honors
    /// ranges: one byte back, it does; more, it ignores them. Until a probe
    /// answers, the host stays on the full-download path.
    async fn probe_ranges(&self, admitted: &Admitted, key: &LogKey, c: &CancellationToken) {
        if let Ok(read) = admitted
            .host
            .trace(&admitted.scope, key.job, key.attempt, Some((1, 1)), c)
            .await
        {
            self.state().logs.set_range_support(
                &key.host,
                if read.bytes.len() == 1 {
                    RangeSupport::Supported
                } else {
                    RangeSupport::Unsupported
                },
            );
        }
    }

    /// The range path (GitLab, proved): a window of at most 512,000 bytes
    /// per read. Followers of one running log share its last tail for 4 s.
    async fn ranged_log(
        &self,
        admitted: &Admitted,
        key: &LogKey,
        input: &JobLogInput,
        c: &CancellationToken,
    ) -> Result<JobLog, PullRequestsOperationError> {
        let logs = &self.state().logs;
        match input.from {
            LogFrom::Offset { offset } if input.refresh == Refresh::Follow => {
                logs.with_tail(
                    key,
                    c,
                    || PullRequestsOperationError::new("pipelines.getJobLog", "timeout"),
                    async |tail: &mut Option<SharedTail>| {
                        if let Some(shared) = tail.as_ref()
                            && let Some((start, bytes)) = shared.answer(offset)
                        {
                            let bytes = bytes.to_vec();
                            let facts = self.facts(admitted, key, false, c).await?;
                            return Ok(ranged_chunk(
                                start,
                                &bytes,
                                false,
                                input.from,
                                Some(&facts),
                            ));
                        }
                        let read = match self
                            .range_read(admitted, key, offset, RANGE_WINDOW, c)
                            .await?
                        {
                            RangeAnswer::Window(read) => read,
                            RangeAnswer::Done(answer) => return Ok(answer),
                        };
                        let full = read.len() as u64 >= RANGE_WINDOW;
                        let bytes = Arc::new(read);
                        *tail = Some(SharedTail {
                            offset,
                            bytes: bytes.clone(),
                            full,
                            read_at: Instant::now(),
                        });
                        let facts = logs.recent_job(key);
                        Ok(ranged_chunk(
                            offset,
                            &bytes,
                            full,
                            input.from,
                            facts.as_ref(),
                        ))
                    },
                )
                .await
            }
            from => {
                let facts = self.facts(admitted, key, false, c).await?;
                if facts.erased {
                    return Ok(log_unavailable(LogUnavailable::Erased, &facts));
                }
                let (start, limit) = match from {
                    LogFrom::Tail => {
                        let size = facts.log_bytes.filter(|_| facts.terminal);
                        (
                            size.map_or(0, |size| size.saturating_sub(RANGE_WINDOW)),
                            RANGE_WINDOW,
                        )
                    }
                    LogFrom::Offset { offset } => (offset, RANGE_WINDOW),
                    LogFrom::Before { offset } => {
                        let start = offset.saturating_sub(RANGE_WINDOW);
                        (start, offset - start)
                    }
                };
                if limit == 0 {
                    return Ok(ranged_chunk(start, &[], false, from, Some(&facts)));
                }
                match self.range_read(admitted, key, start, limit, c).await? {
                    RangeAnswer::Window(read) => {
                        let full = read.len() as u64 >= limit;
                        Ok(ranged_chunk(start, &read, full, from, Some(&facts)))
                    }
                    RangeAnswer::Done(answer) => Ok(answer),
                }
            }
        }
    }

    /// One ranged read. A body longer than its limit proves the host ignores
    /// ranges after all: it is kept as the whole log and served from memory.
    async fn range_read(
        &self,
        admitted: &Admitted,
        key: &LogKey,
        start: u64,
        limit: u64,
        c: &CancellationToken,
    ) -> Result<RangeAnswer, PullRequestsOperationError> {
        let read = match admitted
            .host
            .trace(
                &admitted.scope,
                key.job,
                key.attempt,
                Some((start, limit)),
                c,
            )
            .await
        {
            Ok(read) => read,
            Err(error) if error.code == "not_found" => {
                return Ok(RangeAnswer::Done(self.missing_log(admitted, key, c).await?));
            }
            Err(error) => return Err(error),
        };
        if read.bytes.len() as u64 <= limit {
            return Ok(RangeAnswer::Window(read.bytes));
        }
        let logs = &self.state().logs;
        logs.set_range_support(&key.host, RangeSupport::Unsupported);
        let terminal = logs.recent_job(key).is_some_and(|facts| facts.terminal);
        let log = FullLog {
            bytes: Arc::new(read.bytes),
            base: read.dropped,
            complete: terminal,
            downloaded_at: Instant::now(),
        };
        let kept = log.clone();
        let log = logs
            .get_or_download(
                key.clone(),
                self.fences(),
                snapshot_store::next_generation(),
                c,
                || PullRequestsOperationError::new("pipelines.getJobLog", "timeout"),
                async move { Ok(kept) },
            )
            .await
            .unwrap_or(log);
        Ok(RangeAnswer::Done(JobLog::Chunk(
            log.window(LogFrom::Offset { offset: start }),
        )))
    }

    /// The stored list, pipeline and job rows the route shows, read from the
    /// database with no `glab` or `gh` call. A row paints only for the login
    /// in the host's stored context.
    pub async fn read_snapshot(
        &self,
        input: SubscribeInput,
        c: &CancellationToken,
    ) -> Result<Snapshot, PullRequestsOperationError> {
        let operation = "pipelines.readSnapshot";
        self.service.restore_recorded_hosts().await;
        bounded_read(operation, Duration::from_secs(30), c, |c| async move {
            // A database read needs the host's identity, not a signed-in CLI.
            let pending = context::resolve_pending_scope(
                &self.service.runner,
                Path::new(&input.list.cwd),
                &DiscoveredHosts::default(),
                ContextRead::Open,
                &c,
            )
            .await
            .map_err(|u| u.operation_error(operation))?;
            let Some(database) = self.service.database.clone() else {
                return Err(snapshot_unavailable(operation));
            };
            let host = pending.scope.host.to_ascii_lowercase();
            let project = pending.scope.repository.clone();
            let list_key = input.list.snapshot_key();
            let detail = input.pipeline_id.map(|id| detail_key(id, input.attempt));
            let job = input.job_id.map(|id| id.to_string());
            let rows = database
                .call(move |connection| {
                    let store = SnapshotStore::new(connection);
                    let context = store.get(&host, &project, CONTEXT_KIND, "")?;
                    let list = store.get(&host, &project, LIST_KIND, &list_key)?;
                    let detail = match &detail {
                        Some(key) => store.get(&host, &project, DETAIL_KIND, key)?,
                        None => None,
                    };
                    let job = match &job {
                        Some(key) => store.get(&host, &project, JOB_KIND, key)?,
                        None => None,
                    };
                    Ok((context, list, detail, job))
                })
                .await
                .map_err(|_| snapshot_unavailable(operation))?;
            let (context, list, detail, job) = rows;
            let Some(login) = context.and_then(|row| {
                match serde_json::from_slice::<Context>(&row.payload).ok()? {
                    Context::Available { account, .. } => Some(account.login),
                    Context::Unavailable { .. } => None,
                }
            }) else {
                return Ok(Snapshot::default());
            };
            fn paint<T: DeserializeOwned>(
                row: Option<snapshot_store::Snapshot>,
                login: &str,
            ) -> Option<Stored<T>> {
                let row = row?;
                Some(Stored {
                    payload: decode_row(&row.payload, login)?,
                    observed_at: row.observed_at_ms.max(0) as u64,
                })
            }
            Ok(Snapshot {
                list: paint(list, &login),
                detail: paint(detail, &login),
                job: paint(job, &login),
            })
        })
        .await
    }

    /// GitLab only: joins the cooperative poller of the list key. `emit`
    /// answers whether the stream accepted the event.
    pub async fn subscribe(
        &self,
        input: SubscribeInput,
        emit: &(dyn Fn(Changed) -> bool + Send + Sync),
        c: &CancellationToken,
    ) -> Result<(), PullRequestsOperationError> {
        let operation = "pipelines.subscribe";
        let pending = context::resolve_pending_scope(
            &self.service.runner,
            Path::new(&input.list.cwd),
            &DiscoveredHosts::default(),
            ContextRead::Open,
            c,
        )
        .await
        .map_err(|u| u.operation_error(operation))?;
        let scope = pending.scope;
        let database = match (&self.service.database, scope.provider) {
            (Some(database), PullRequestsProvider::Gitlab) => database.clone(),
            _ => return Err(snapshot_unavailable(operation)),
        };
        let list = input.list.first_page();
        let list_key = list.snapshot_key();
        let host = self.host(&scope);
        let result = poll::run_subscriber(
            &poll::PollInputs {
                registry: &self.state().pollers,
                host: host.as_ref(),
                database: &database,
                fences: self.fences(),
                backoff: self.backoff(),
                scope: &scope,
                list: &list,
                list_key: &list_key,
            },
            input.pipeline_id,
            emit,
            c,
        )
        .await;
        if let Err(error) = &result {
            match error.code {
                "not_authenticated" => {
                    self.service
                        .invalidate_failed_context(error, Some(&scope.host))
                        .await;
                }
                "forbidden" | "not_found" => {
                    self.delete_resource(&scope, &Resource::List(list_key))
                        .await;
                }
                _ => {}
            }
        }
        result
    }
}

enum RangeAnswer {
    Window(Vec<u8>),
    Done(JobLog),
}

#[cfg(test)]
mod tests;
