//! Service and poller tests over a fake `PipelineHost`. The poller tests run
//! no process, so they run on every platform; the service tests resolve a
//! checkout through fake `git` and `glab` scripts, so they are Unix only.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use super::{
    model::{
        ActionKind, ActionResult, ActionTarget, Commit, Detail, DetailStage, Job, JobDetail,
        JobGroup, JobKind, JobPermissions, ListInput, ListScope, Permission, PipelineRef, RefKind,
        Refresh, Row, RowPermissions,
    },
    *,
};
use crate::pull_requests::{host::HostFuture, model::PipelineStatus};

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|p| p.into_inner())
}

pub(super) fn row(id: u64, status: PipelineStatus) -> Row {
    Row {
        id,
        label: format!("#{id}"),
        title: Some("Fix the flaky test".into()),
        status,
        warnings: false,
        reason: None,
        terminal: model::is_terminal(status),
        git_ref: PipelineRef {
            kind: RefKind::Branch,
            name: "main".into(),
            number: None,
            url: None,
        },
        sha: "abc1234".into(),
        actor: None,
        badges: vec![],
        created_at: "2026-10-24T10:00:00Z".into(),
        started_at: None,
        finished_at: None,
        duration_seconds: None,
        queued_seconds: None,
        stages: None,
        attempt: None,
        permissions: None,
        url: None,
    }
}

pub(super) fn job(id: u64, status: PipelineStatus) -> Job {
    Job {
        id,
        name: format!("job-{id}"),
        stage: "test".into(),
        kind: JobKind::Build,
        status,
        warnings: false,
        reason: None,
        terminal: model::is_terminal(status),
        started_at: None,
        finished_at: None,
        duration_seconds: None,
        queued_seconds: None,
        permissions: JobPermissions {
            retry: Permission::Denied,
            cancel: Permission::Denied,
            play: Permission::Denied,
        },
        url: None,
        downstream_url: None,
    }
}

pub(super) fn detail(id: u64, status: PipelineStatus, jobs: &[(u64, PipelineStatus)]) -> Detail {
    Detail {
        revision: 0,
        pipeline: row(id, status),
        commit: Commit {
            sha: "abc1234".into(),
            title: None,
            url: None,
        },
        total_jobs: Some(jobs.len() as u64),
        stages: Some(vec![DetailStage {
            name: "test".into(),
            status,
            warnings: false,
            groups: jobs
                .iter()
                .map(|(job_id, job_status)| JobGroup {
                    name: format!("job-{job_id}"),
                    size: 1,
                    status: *job_status,
                    jobs: vec![job(*job_id, *job_status)],
                })
                .collect(),
        }]),
        truncated: false,
        uses_needs: false,
        artifacts: vec![],
    }
}

/// Only the Unix service tests read jobs.
#[cfg(unix)]
pub(super) fn job_detail(id: u64, status: PipelineStatus, log_bytes: Option<u64>) -> JobDetail {
    JobDetail {
        revision: 0,
        job: job(id, status),
        pipeline_id: 4821,
        attempt: None,
        runner: None,
        tags: vec![],
        source: Some("push".into()),
        created_at: "2026-10-24T10:00:00Z".into(),
        artifacts: vec![],
        steps: vec![],
        log_bytes,
        erased: false,
        raw_log_url: Some("https://gitlab.example/team/repo/-/jobs/998/raw".into()),
    }
}

fn failure(
    operation: &str,
    code: &'static str,
    retry_after: Option<u32>,
) -> PullRequestsOperationError {
    let mut error = PullRequestsOperationError::new(operation, code);
    error.retry_after_seconds = retry_after;
    error
}

/// What a fake read answers: a value, or an error code and its provider pause.
#[derive(Clone)]
pub(super) enum Answer<T> {
    Ok(T),
    Err(&'static str, Option<u32>),
}

impl<T: Clone> Answer<T> {
    fn get(&self, operation: &str) -> Result<T, PullRequestsOperationError> {
        match self {
            Self::Ok(value) => Ok(value.clone()),
            Self::Err(code, retry_after) => Err(failure(operation, code, *retry_after)),
        }
    }
}

/// The log a fake host serves: whether it honors ranges, or has none yet.
#[derive(Clone, Default)]
pub(super) struct FakeTrace {
    pub log: Vec<u8>,
    pub ignores_ranges: bool,
    pub missing: bool,
}

/// An in-memory provider that records every read.
#[derive(Default)]
pub(super) struct FakeHost {
    pub calls: Mutex<Vec<String>>,
    pub context: Mutex<Option<HostContext>>,
    pub list: Mutex<Option<Answer<Vec<Row>>>>,
    pub details: Mutex<HashMap<u64, Answer<Detail>>>,
    pub jobs: Mutex<HashMap<u64, Answer<JobDetail>>>,
    pub trace: Mutex<FakeTrace>,
    /// What an action answers; GitLab's job retry by default.
    pub action: Mutex<Option<Answer<ActionResult>>>,
    /// Held reads wait here until notified.
    pub hold: Mutex<Option<Arc<tokio::sync::Notify>>>,
    /// Held trace reads wait here, after taking the log they will answer.
    pub trace_hold: Mutex<Option<Arc<tokio::sync::Notify>>>,
    pub ranged: bool,
}

impl FakeHost {
    pub(super) fn gitlab() -> Arc<Self> {
        Arc::new(Self {
            ranged: true,
            context: Mutex::new(Some(crate::pull_requests::gitlab::pipelines::test_context())),
            list: Mutex::new(Some(Answer::Ok(vec![row(4821, PipelineStatus::Running)]))),
            ..Self::default()
        })
    }

    pub(super) fn calls(&self, prefix: &str) -> usize {
        lock(&self.calls)
            .iter()
            .filter(|call| call.starts_with(prefix))
            .count()
    }

    fn record(&self, call: String) {
        lock(&self.calls).push(call);
    }

    /// Waits while held; a cancelled read stops, as a real process read does.
    async fn held(&self, c: &CancellationToken) -> Result<(), PullRequestsOperationError> {
        let hold = lock(&self.hold).clone();
        if let Some(hold) = hold {
            tokio::select! {
                () = hold.notified() => {}
                () = c.cancelled() => return Err(failure("pipelines.list", "timeout", None)),
            }
        }
        Ok(())
    }
}

impl PipelineHost for FakeHost {
    fn ranged_logs(&self) -> bool {
        self.ranged
    }

    fn known_context(&self, _scope: &HostScope) -> Option<HostContext> {
        lock(&self.context).clone()
    }

    fn list<'a>(
        &'a self,
        _scope: &'a HostScope,
        _context: &'a HostContext,
        input: &'a ListInput,
        with_count: bool,
        c: &'a CancellationToken,
    ) -> HostFuture<'a, ListRead> {
        Box::pin(async move {
            self.record(format!(
                "list cursor={} count={with_count}",
                input.cursor.as_deref().unwrap_or("-")
            ));
            self.held(c).await?;
            let rows = lock(&self.list)
                .clone()
                .unwrap_or(Answer::Ok(vec![]))
                .get("pipelines.list")?;
            Ok(ListRead {
                rows,
                next_cursor: Some("next".into()),
                total: with_count.then_some(Total {
                    count: 42,
                    capped: false,
                }),
                workflows: None,
            })
        })
    }

    fn detail<'a>(
        &'a self,
        _scope: &'a HostScope,
        _context: &'a HostContext,
        pipeline_id: u64,
        _attempt: Option<u64>,
        c: &'a CancellationToken,
    ) -> HostFuture<'a, Detail> {
        Box::pin(async move {
            self.record(format!("detail {pipeline_id}"));
            self.held(c).await?;
            lock(&self.details)
                .get(&pipeline_id)
                .cloned()
                .unwrap_or(Answer::Err("not_found", None))
                .get("pipelines.get")
        })
    }

    fn job<'a>(
        &'a self,
        _scope: &'a HostScope,
        _context: &'a HostContext,
        job_id: u64,
        _c: &'a CancellationToken,
    ) -> HostFuture<'a, JobDetail> {
        Box::pin(async move {
            self.record(format!("job {job_id}"));
            lock(&self.jobs)
                .get(&job_id)
                .cloned()
                .unwrap_or(Answer::Err("not_found", None))
                .get("pipelines.getJob")
        })
    }

    fn trace<'a>(
        &'a self,
        _scope: &'a HostScope,
        job_id: u64,
        _attempt: Option<u64>,
        range: Option<(u64, u64)>,
        _c: &'a CancellationToken,
    ) -> HostFuture<'a, TraceRead> {
        Box::pin(async move {
            let trace = lock(&self.trace).clone();
            match range {
                Some((offset, limit)) => self.record(format!("trace {job_id} {offset}+{limit}")),
                None => self.record(format!("trace {job_id} whole")),
            }
            let hold = lock(&self.trace_hold).take();
            if let Some(hold) = hold {
                hold.notified().await;
            }
            if trace.missing {
                return Err(failure("pipelines.getJobLog", "not_found", None));
            }
            let bytes = match range {
                Some((offset, limit)) if !trace.ignores_ranges => {
                    let start = (offset as usize).min(trace.log.len());
                    let end = (start + limit as usize).min(trace.log.len());
                    trace.log[start..end].to_vec()
                }
                _ => trace.log.clone(),
            };
            Ok(TraceRead { bytes, dropped: 0 })
        })
    }

    fn run_action<'a>(
        &'a self,
        _scope: &'a HostScope,
        _context: &'a HostContext,
        target: ActionTarget,
        action: ActionKind,
        c: &'a CancellationToken,
    ) -> HostFuture<'a, ActionResult> {
        Box::pin(async move {
            self.record(format!("action {target:?} {action:?}"));
            self.held(c).await?;
            lock(&self.action)
                .clone()
                .unwrap_or(Answer::Ok(ActionResult {
                    pipeline_id: Some(4821),
                    job_id: Some(1001),
                }))
                .get(ACTION_OP)
        })
    }
}

/// A pipeline whose actions the host neither granted nor refused (GitHub write).
#[cfg(unix)]
pub(super) fn unknown_permissions(mut detail: Detail) -> Detail {
    detail.pipeline.permissions = Some(RowPermissions {
        retry: Permission::Unknown,
        cancel: Permission::Unknown,
    });
    for stage in detail.stages.iter_mut().flatten() {
        for group in &mut stage.groups {
            for job in &mut group.jobs {
                job.permissions.retry = Permission::Unknown;
            }
        }
    }
    detail
}

#[cfg(unix)]
mod service {
    use super::*;
    use crate::{
        pull_requests::{
            ContextRead,
            host::HostCommandRunner,
            snapshot_store::{Snapshot as StoredSnapshot, SnapshotStore},
        },
        test_support::TestSandbox,
    };

    const HOST: &str = "code.acme.example";

    pub(super) async fn new_database() -> Database {
        let database = Database::open_in_memory().await.expect("database");
        database
            .call(|connection| Ok(crate::persistence::run_migrations(connection, None)?))
            .await
            .expect("migrations");
        database
    }

    /// A recorded self-hosted GitLab: `glab` answers the sign-in and context
    /// reads (and logs every call), `git` names the remote. The pipelines
    /// reads themselves go to `fake`.
    struct Bench {
        /// The host the checkout's remote names.
        host: &'static str,
        s: TestSandbox,
        database: Database,
        prs: PullRequestsService,
        service: PipelinesService,
        fake: Arc<FakeHost>,
    }

    async fn bench(name: &str) -> Bench {
        let s = TestSandbox::new(name);
        std::fs::write(
            s.path("project.json"),
            include_str!("../../../tests/fixtures/pull_requests/gitlab_project.json"),
        )
        .unwrap();
        let glab = s.executable_script(
            "glab",
            r#"printf '%s\n' "$*" >> calls
case "$1 $2" in
  '--version ') echo 'glab version 1.114.0' ;;
  'auth status') if [ -e logged-out ]; then echo 'No GitLab instances have been authenticated with glab.' >&2; exit 1; fi
    printf 'code.acme.example\n  ✓ Logged in to code.acme.example as viewer\n' ;;
  'api user') echo '{"id":8,"username":"viewer","name":null}' ;;
  'api version') echo '{"version":"17.9.1"}' ;;
  'api projects/team%2Frepo') cat project.json ;;
  *) exit 64 ;;
esac"#,
            "",
        );
        let git = s.executable_script(
            "git",
            "printf '%s' 'git@code.acme.example:team/repo.git'",
            "",
        );
        let database = new_database().await;
        let prs = PullRequestsService::with_runner(
            HostCommandRunner::new(s.path("state")).with_commands("missing-gh", &glab, &git),
        )
        .with_database(database.clone());
        prs.runner
            .provider_hosts()
            .record(HOST, crate::source_control::ProviderKind::Gitlab);
        let fake = FakeHost::gitlab();
        let service = PipelinesService::with_hosts(prs.clone(), fake.clone(), fake.clone());
        Bench {
            host: HOST,
            s,
            database,
            prs,
            service,
            fake,
        }
    }

    /// A GitHub checkout: `gh` answers the sign-in, the context is
    /// `GitHubContextHost`'s, and the pipelines reads and actions go to `fake`.
    async fn github_bench(name: &str) -> Bench {
        let s = TestSandbox::new(name);
        let gh = s.executable_script(
            "gh",
            r#"case "$1 $2" in
  '--version ') echo 'gh version 2.97.0' ;;
  'auth status') echo '{"hosts":{"github.com":[{"state":"success","active":true,"host":"github.com","login":"viewer"}]}}' ;;
  *) exit 64 ;;
esac"#,
            "",
        );
        let git = s.executable_script("git", "printf '%s' 'git@github.com:team/repo.git'", "");
        let database = new_database().await;
        let context_host = Arc::new(GitHubContextHost);
        let prs = PullRequestsService {
            github: context_host.clone(),
            gitlab: context_host,
            database: Some(database.clone()),
            ..PullRequestsService::with_runner(
                HostCommandRunner::new(s.path("state")).with_commands(&gh, "missing-glab", &git),
            )
        };
        let fake = FakeHost::gitlab();
        let service = PipelinesService::with_hosts(prs.clone(), fake.clone(), fake.clone());
        Bench {
            host: "github.com",
            s,
            database,
            prs,
            service,
            fake,
        }
    }

    impl Bench {
        fn glab_calls(&self) -> usize {
            std::fs::read_to_string(self.s.path("calls"))
                .unwrap_or_default()
                .lines()
                .count()
        }

        fn cwd(&self) -> String {
            self.s.root().to_string_lossy().into_owned()
        }

        fn list_input(&self, refresh: Refresh, cursor: Option<&str>) -> ListInput {
            ListInput {
                cwd: self.cwd(),
                scope: ListScope::All,
                git_ref: None,
                workflow_id: None,
                cursor: cursor.map(str::to_owned),
                refresh,
            }
        }

        fn get_input(&self, id: u64) -> GetInput {
            GetInput {
                cwd: self.cwd(),
                pipeline_id: id,
                attempt: None,
                refresh: Refresh::User,
            }
        }

        fn log_input(&self, from: LogFrom, refresh: Refresh) -> JobLogInput {
            JobLogInput {
                cwd: self.cwd(),
                job_id: 998,
                attempt: None,
                from,
                refresh,
            }
        }

        fn snapshot_input(&self, pipeline: Option<u64>, job: Option<u64>) -> SubscribeInput {
            SubscribeInput {
                list: self.list_input(Refresh::User, None),
                pipeline_id: pipeline,
                attempt: None,
                job_id: job,
            }
        }

        async fn row(&self, kind: &'static str, key: &str) -> Option<StoredSnapshot> {
            let key = key.to_owned();
            let host = self.host;
            self.database
                .call(move |connection| {
                    Ok(SnapshotStore::new(connection).get(host, "team/repo", kind, &key)?)
                })
                .await
                .unwrap()
        }

        async fn put(&self, kind: &'static str, key: &str, payload: Vec<u8>) {
            let key = key.to_owned();
            let host = self.host;
            self.database
                .call(move |connection| {
                    Ok(SnapshotStore::new(connection).put(StoredSnapshot {
                        host: host.into(),
                        project: "team/repo".into(),
                        kind: kind.into(),
                        key,
                        fingerprint: "fp".into(),
                        payload,
                        observed_at_ms: 1,
                        generation: 1,
                    })?)
                })
                .await
                .unwrap();
        }

        /// The panel's own context read, which stores the context row.
        async fn open(&self) {
            self.prs
                .context(self.s.root(), ContextRead::Open, &CancellationToken::new())
                .await
                .unwrap();
        }
    }

    fn c() -> CancellationToken {
        CancellationToken::new()
    }

    #[tokio::test]
    async fn pipelines_reads_during_host_backoff_answer_rate_limited_with_zero_host_calls() {
        let b = bench("pipelines-held").await;
        b.prs.pollers.host_backoff().back_off(HOST, None);
        let before = b.glab_calls();
        let list = b
            .service
            .list(b.list_input(Refresh::Timer, None), &c())
            .await;
        let log = b
            .service
            .job_log(
                b.log_input(LogFrom::Offset { offset: 0 }, Refresh::Follow),
                &c(),
            )
            .await;
        let get = b.service.get(b.get_input(4821), &c()).await;
        for error in [list.unwrap_err(), log.unwrap_err(), get.unwrap_err()] {
            assert_eq!(error.code, "rate_limited");
            let seconds = error
                .retry_after_seconds
                .expect("the pause rides on the error");
            assert!((50..=60).contains(&seconds), "{seconds}");
        }
        assert_eq!(b.glab_calls(), before, "no glab call while backed off");
        assert!(lock(&b.fake.calls).is_empty(), "no pipelines read either");
        // Held reads take no further ladder step.
        assert!(b.prs.pollers.host_backoff().remaining(HOST).unwrap() <= Duration::from_secs(60));
    }

    #[tokio::test]
    async fn a_pipelines_429_backs_off_the_shared_host_ladder_with_the_later_provider_pause() {
        let b = bench("pipelines-429").await;
        *lock(&b.fake.list) = Some(Answer::Err("rate_limited", Some(900)));
        let error = b
            .service
            .list(b.list_input(Refresh::User, None), &c())
            .await
            .unwrap_err();
        assert_eq!(error.retry_after_seconds, Some(900));
        // The merge request poller's registry holds the same ladder.
        let remaining = b.prs.pollers.host_backoff().remaining(HOST).unwrap();
        assert!(remaining > Duration::from_secs(800), "{remaining:?}");
        b.prs.pollers.host_backoff().recovered(HOST, Instant::now());

        // Without a provider answer the ladder step applies.
        *lock(&b.fake.list) = Some(Answer::Err("rate_limited", None));
        let error = b
            .service
            .list(b.list_input(Refresh::User, None), &c())
            .await
            .unwrap_err();
        assert_eq!(error.retry_after_seconds, Some(60));
    }

    #[tokio::test]
    async fn a_lost_sign_in_invalidates_the_context_and_deletes_the_host_rows() {
        let b = bench("pipelines-signed-out").await;
        b.put("detail", "3941", b"{}".to_vec()).await;
        b.put(DETAIL_KIND, "4821", b"{}".to_vec()).await;
        *lock(&b.fake.list) = Some(Answer::Err("not_authenticated", None));
        let error = b
            .service
            .list(b.list_input(Refresh::User, None), &c())
            .await
            .unwrap_err();
        assert_eq!(error.code, "not_authenticated");
        assert!(b.row("detail", "3941").await.is_none());
        assert!(b.row(DETAIL_KIND, "4821").await.is_none());
    }

    #[tokio::test]
    async fn a_refused_pipeline_keeps_the_pull_requests_context_and_rows_and_drops_only_its_own() {
        let b = bench("pipelines-refused").await;
        b.open().await;
        b.put("detail", "3941", b"{}".to_vec()).await;
        b.put(DETAIL_KIND, "4821", b"{}".to_vec()).await;
        b.put(DETAIL_KIND, "4822", b"{}".to_vec()).await;
        b.put(JOB_KIND, "998", b"{}".to_vec()).await;
        lock(&b.fake.details).insert(4821, Answer::Err("forbidden", None));
        let before = b.glab_calls();
        let error = b.service.get(b.get_input(4821), &c()).await.unwrap_err();
        assert_eq!(error.code, "forbidden");
        let error = b
            .service
            .job(
                JobInput {
                    cwd: b.cwd(),
                    job_id: 998,
                    refresh: Refresh::User,
                },
                &c(),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, "not_found");
        assert!(b.row(DETAIL_KIND, "4821").await.is_none());
        assert!(b.row(JOB_KIND, "998").await.is_none());
        assert!(b.row(DETAIL_KIND, "4822").await.is_some());
        assert!(b.row("detail", "3941").await.is_some());
        assert!(b.row(CONTEXT_KIND, "").await.is_some());
        // The cached context still answers: no `api user` was read again.
        assert_eq!(
            std::fs::read_to_string(b.s.path("calls"))
                .unwrap()
                .lines()
                .skip(before)
                .filter(|line| line.starts_with("api user"))
                .count(),
            0
        );
    }

    #[tokio::test]
    async fn unary_reads_store_the_rows_read_snapshot_paints_with_zero_host_calls() {
        let b = bench("pipelines-stored").await;
        b.open().await;
        lock(&b.fake.details).insert(
            4821,
            Answer::Ok(detail(
                4821,
                PipelineStatus::Running,
                &[(998, PipelineStatus::Running)],
            )),
        );
        lock(&b.fake.jobs).insert(
            998,
            Answer::Ok(job_detail(998, PipelineStatus::Running, None)),
        );
        let page = b
            .service
            .list(b.list_input(Refresh::User, None), &c())
            .await
            .unwrap();
        let pipeline = b.service.get(b.get_input(4821), &c()).await.unwrap();
        let job = b
            .service
            .job(
                JobInput {
                    cwd: b.cwd(),
                    job_id: 998,
                    refresh: Refresh::User,
                },
                &c(),
            )
            .await
            .unwrap();
        assert!(
            page.revision > 0
                && pipeline.revision > page.revision
                && job.revision > pipeline.revision
        );
        let (glab, fake) = (b.glab_calls(), lock(&b.fake.calls).len());
        let snapshot = b
            .service
            .read_snapshot(b.snapshot_input(Some(4821), Some(998)), &c())
            .await
            .unwrap();
        assert_eq!(snapshot.list.map(|row| row.payload), Some(page));
        assert_eq!(
            snapshot.detail.map(|row| row.payload),
            Some(pipeline.clone())
        );
        assert_eq!(snapshot.job.map(|row| row.payload), Some(job));
        assert_eq!(
            (b.glab_calls(), lock(&b.fake.calls).len()),
            (glab, fake),
            "zero host calls"
        );
        // The stored row's generation is the revision the read answered.
        assert_eq!(
            b.row(DETAIL_KIND, "4821").await.unwrap().generation,
            pipeline.revision
        );
    }

    #[tokio::test]
    async fn only_first_pages_are_stored_and_count_is_reused_off_user_reads() {
        let b = bench("pipelines-first-pages").await;
        b.open().await;
        let first = b
            .service
            .list(b.list_input(Refresh::User, None), &c())
            .await
            .unwrap();
        assert_eq!(first.total.as_ref().map(|t| t.count), Some(42));
        let key = b.list_input(Refresh::User, None).snapshot_key();
        let stored = b.row(LIST_KIND, &key).await.unwrap().generation;
        let later = b
            .service
            .list(b.list_input(Refresh::Timer, Some("next")), &c())
            .await
            .unwrap();
        assert_eq!(later.total, first.total, "a later page reuses the count");
        assert_eq!(
            b.row(LIST_KIND, &key).await.unwrap().generation,
            stored,
            "page two is not stored"
        );
        b.service
            .list(b.list_input(Refresh::Timer, None), &c())
            .await
            .unwrap();
        b.service
            .list(b.list_input(Refresh::User, None), &c())
            .await
            .unwrap();
        assert_eq!(
            lock(&b.fake.calls).as_slice(),
            [
                "list cursor=- count=true",
                "list cursor=next count=false",
                "list cursor=- count=false",
                "list cursor=- count=true",
            ],
            "count on a user read of a first page; reused by a timer read within 5 min"
        );
    }

    #[tokio::test]
    async fn a_row_stored_under_another_account_is_not_painted() {
        let b = bench("pipelines-other-account").await;
        b.open().await;
        let other = serde_json::to_vec(&serde_json::json!({
            "login": "someone-else",
            "payload": detail(4821, PipelineStatus::Success, &[]),
        }))
        .unwrap();
        b.put(DETAIL_KIND, "4821", other).await;
        let snapshot = b
            .service
            .read_snapshot(b.snapshot_input(Some(4821), None), &c())
            .await
            .unwrap();
        assert!(snapshot.detail.is_none());
        let mine = serde_json::to_vec(&serde_json::json!({
            "login": "viewer",
            "payload": detail(4821, PipelineStatus::Success, &[]),
        }))
        .unwrap();
        let key = "4821";
        let database = b.database.clone();
        database
            .call(move |connection| {
                Ok(SnapshotStore::new(connection).put(StoredSnapshot {
                    host: HOST.into(),
                    project: "team/repo".into(),
                    kind: DETAIL_KIND.into(),
                    key: key.into(),
                    fingerprint: "fp".into(),
                    payload: mine,
                    observed_at_ms: 2,
                    generation: 2,
                })?)
            })
            .await
            .unwrap();
        let snapshot = b
            .service
            .read_snapshot(b.snapshot_input(Some(4821), None), &c())
            .await
            .unwrap();
        assert!(
            snapshot.detail.is_some(),
            "the signed-in account's row paints"
        );
    }

    #[tokio::test]
    async fn a_read_that_started_before_a_logout_writes_nothing_and_an_older_read_never_wins() {
        let b = bench("pipelines-fenced").await;
        b.open().await;
        lock(&b.fake.details).insert(4821, Answer::Ok(detail(4821, PipelineStatus::Running, &[])));
        let release = Arc::new(tokio::sync::Notify::new());
        *lock(&b.fake.hold) = Some(release.clone());
        let token = c();
        let read = b.service.get(b.get_input(4821), &token);
        let logout = async {
            while b.fake.calls("detail") == 0 {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            b.prs.delete_host_snapshots(HOST).await;
            release.notify_one();
        };
        let (result, ()) = tokio::join!(read, logout);
        result.unwrap();
        assert!(
            b.row(DETAIL_KIND, "4821").await.is_none(),
            "the fenced write is skipped"
        );

        // A slower read that started first never replaces a newer row.
        let slow = b.service.get(b.get_input(4821), &token);
        let fast = async {
            while b.fake.calls("detail") < 2 {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            *lock(&b.fake.hold) = None;
            let newer = b.service.get(b.get_input(4821), &c()).await.unwrap();
            release.notify_one();
            newer
        };
        let (older, newer) = tokio::join!(slow, fast);
        let (older, newer) = (older.unwrap(), newer);
        assert!(older.revision < newer.revision);
        assert_eq!(
            b.row(DETAIL_KIND, "4821").await.unwrap().generation,
            newer.revision
        );
    }

    #[tokio::test]
    async fn rescan_leaves_the_pipelines_rows_and_clears_the_logs() {
        let b = bench("pipelines-rescan").await;
        b.open().await;
        b.put(DETAIL_KIND, "4821", b"{}".to_vec()).await;
        b.prs
            .pipelines
            .logs
            .set_range_support(HOST, RangeSupport::Unsupported);
        lock(&b.fake.jobs).insert(
            998,
            Answer::Ok(job_detail(998, PipelineStatus::Success, Some(5))),
        );
        lock(&b.fake.trace).log = b"done\n".to_vec();
        b.service
            .job_log(b.log_input(LogFrom::Tail, Refresh::User), &c())
            .await
            .unwrap();
        let key = LogKey {
            host: HOST.into(),
            login: "viewer".into(),
            project: "team/repo".into(),
            job: 998,
            attempt: None,
        };
        assert!(b.prs.pipelines.logs.cached(&key).is_some());
        let _ = b.prs.context(b.s.root(), ContextRead::Rescan, &c()).await;
        assert!(
            b.row(DETAIL_KIND, "4821").await.is_some(),
            "rescan keeps rows"
        );
        assert!(
            b.prs.pipelines.logs.cached(&key).is_none(),
            "rescan drops logs"
        );
    }

    #[tokio::test]
    async fn a_cancelled_read_stops_and_answers_timeout() {
        let b = bench("pipelines-cancel").await;
        b.open().await;
        *lock(&b.fake.hold) = Some(Arc::new(tokio::sync::Notify::new()));
        let token = CancellationToken::new();
        let read = b.service.list(b.list_input(Refresh::User, None), &token);
        let cancel = async {
            while b.fake.calls("list") == 0 {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            token.cancel();
        };
        let (result, ()) = tokio::join!(read, cancel);
        assert_eq!(result.unwrap_err().code, "timeout");
    }

    fn chunk(log: JobLog) -> LogChunk {
        match log {
            JobLog::Chunk(chunk) => chunk,
            JobLog::Unavailable(answer) => panic!("unavailable: {answer:?}"),
        }
    }

    fn reason(log: JobLog) -> LogUnavailable {
        match log {
            JobLog::Unavailable(answer) => answer.reason,
            JobLog::Chunk(chunk) => panic!("a chunk at {}", chunk.offset),
        }
    }

    #[tokio::test]
    async fn an_unproven_host_downloads_once_probes_one_byte_and_then_reads_ranges() {
        let b = bench("pipelines-probe").await;
        b.open().await;
        lock(&b.fake.jobs).insert(
            998,
            Answer::Ok(job_detail(998, PipelineStatus::Success, Some(12))),
        );
        lock(&b.fake.trace).log = b"hello\nworld\n".to_vec();
        let first = chunk(
            b.service
                .job_log(b.log_input(LogFrom::Tail, Refresh::User), &c())
                .await
                .unwrap(),
        );
        assert_eq!(
            (first.text.as_str(), first.first_line),
            ("hello\nworld\n", Some(0))
        );
        assert!(first.complete);
        assert_eq!(
            lock(&b.fake.calls).as_slice(),
            ["job 998", "trace 998 whole", "trace 998 1+1"]
        );
        assert_eq!(
            b.prs.pipelines.logs.range_support(HOST),
            RangeSupport::Supported
        );
        // A proved host reads ranges: a later job's tail is one ranged read.
        lock(&b.fake.jobs).insert(
            999,
            Answer::Ok(job_detail(999, PipelineStatus::Success, Some(12))),
        );
        let mut input = b.log_input(LogFrom::Tail, Refresh::User);
        input.job_id = 999;
        let tail = chunk(b.service.job_log(input, &c()).await.unwrap());
        assert_eq!((tail.offset, tail.text.as_str()), (0, "hello\nworld\n"));
        assert!(tail.complete);
        assert_eq!(b.fake.calls("trace 999 0+512000"), 1);
    }

    #[tokio::test]
    async fn a_host_that_ignores_ranges_is_never_followed_from_next_offset() {
        let b = bench("pipelines-ignored-ranges").await;
        b.open().await;
        lock(&b.fake.jobs).insert(
            998,
            Answer::Ok(job_detail(998, PipelineStatus::Running, None)),
        );
        *lock(&b.fake.trace) = FakeTrace {
            log: b"step one\nstep two\n".to_vec(),
            ignores_ranges: true,
            missing: false,
        };
        let first = chunk(
            b.service
                .job_log(b.log_input(LogFrom::Tail, Refresh::User), &c())
                .await
                .unwrap(),
        );
        assert_eq!(
            b.prs.pipelines.logs.range_support(HOST),
            RangeSupport::Unsupported
        );
        let next = chunk(
            b.service
                .job_log(
                    b.log_input(
                        LogFrom::Offset {
                            offset: first.next_offset,
                        },
                        Refresh::Follow,
                    ),
                    &c(),
                )
                .await
                .unwrap(),
        );
        assert_eq!(next.text, "", "no duplicated bytes");
        assert_eq!(b.fake.calls("trace"), 2, "the download and the probe only");
    }

    #[tokio::test]
    async fn a_later_body_over_its_byte_limit_marks_the_host_unsupported() {
        let b = bench("pipelines-long-body").await;
        b.open().await;
        b.prs
            .pipelines
            .logs
            .set_range_support(HOST, RangeSupport::Supported);
        lock(&b.fake.jobs).insert(
            998,
            Answer::Ok(job_detail(998, PipelineStatus::Success, None)),
        );
        *lock(&b.fake.trace) = FakeTrace {
            log: vec![b'x'; 600_000],
            ignores_ranges: true,
            missing: false,
        };
        let answer = chunk(
            b.service
                .job_log(
                    b.log_input(LogFrom::Offset { offset: 0 }, Refresh::User),
                    &c(),
                )
                .await
                .unwrap(),
        );
        assert_eq!(answer.offset, 0);
        assert_eq!(answer.next_offset, 600_000);
        assert_eq!(
            b.prs.pipelines.logs.range_support(HOST),
            RangeSupport::Unsupported
        );
    }

    #[tokio::test]
    async fn a_running_ranged_log_stops_after_four_catch_up_reads_with_too_large_live() {
        let b = bench("pipelines-too-large-live").await;
        b.open().await;
        b.prs
            .pipelines
            .logs
            .set_range_support(HOST, RangeSupport::Supported);
        lock(&b.fake.jobs).insert(
            998,
            Answer::Ok(job_detail(998, PipelineStatus::Running, None)),
        );
        lock(&b.fake.trace).log = vec![b'a'; 3_000_000];
        let mut answer = b
            .service
            .job_log(b.log_input(LogFrom::Tail, Refresh::User), &c())
            .await
            .unwrap();
        let mut reads = 1;
        while let JobLog::Chunk(read) = &answer {
            assert!(!read.complete);
            answer = b
                .service
                .job_log(
                    b.log_input(
                        LogFrom::Offset {
                            offset: read.next_offset,
                        },
                        Refresh::Follow,
                    ),
                    &c(),
                )
                .await
                .unwrap();
            reads += 1;
            assert!(reads <= 4, "catch-up is bounded");
        }
        assert_eq!(reason(answer), LogUnavailable::TooLargeLive);
        assert_eq!(b.fake.calls("trace"), 4, "about 2 MB on open");
    }

    #[tokio::test]
    async fn followers_inside_the_last_4s_tail_share_it_with_zero_trace_reads() {
        let b = bench("pipelines-shared-tail").await;
        b.open().await;
        b.prs
            .pipelines
            .logs
            .set_range_support(HOST, RangeSupport::Supported);
        lock(&b.fake.jobs).insert(
            998,
            Answer::Ok(job_detail(998, PipelineStatus::Running, None)),
        );
        lock(&b.fake.trace).log = b"line 1\nline 2\n".to_vec();
        b.service
            .job(
                JobInput {
                    cwd: b.cwd(),
                    job_id: 998,
                    refresh: Refresh::User,
                },
                &c(),
            )
            .await
            .unwrap();
        let follow = |offset| b.log_input(LogFrom::Offset { offset }, Refresh::Follow);
        let first = chunk(b.service.job_log(follow(7), &c()).await.unwrap());
        assert_eq!(first.text, "line 2\n");
        let second = chunk(b.service.job_log(follow(7), &c()).await.unwrap());
        assert_eq!(second, first);
        let at_end = chunk(b.service.job_log(follow(14), &c()).await.unwrap());
        assert_eq!(at_end.text, "");
        assert_eq!(b.fake.calls("trace"), 1, "one host read for every follower");
        assert_eq!(b.fake.calls("job"), 1, "the job read authorizes them");
    }

    #[tokio::test]
    async fn a_downloaded_running_log_over_2mib_is_downloaded_again_once_the_job_finishes() {
        let b = bench("pipelines-big-running-log").await;
        b.open().await;
        b.prs
            .pipelines
            .logs
            .set_range_support(HOST, RangeSupport::Unsupported);
        lock(&b.fake.jobs).insert(
            998,
            Answer::Ok(job_detail(998, PipelineStatus::Running, None)),
        );
        let mut running = vec![b'a'; log::LIVE_REDOWNLOAD_MAX];
        running.push(b'\n');
        lock(&b.fake.trace).log = running.clone();
        let first = chunk(
            b.service
                .job_log(b.log_input(LogFrom::Tail, Refresh::User), &c())
                .await
                .unwrap(),
        );
        assert!(!first.complete);
        // Live updates pause over 2 MiB: a running re-read answers from memory.
        b.service
            .job_log(b.log_input(LogFrom::Tail, Refresh::User), &c())
            .await
            .unwrap();
        assert_eq!(b.fake.calls("trace 998 whole"), 1);
        // Following past the kept end says live updates paused instead of
        // answering empty windows.
        let follow = b
            .service
            .job_log(
                b.log_input(
                    LogFrom::Offset {
                        offset: first.next_offset,
                    },
                    Refresh::Follow,
                ),
                &c(),
            )
            .await
            .unwrap();
        assert!(
            matches!(
                follow,
                JobLog::Unavailable(LogUnavailableAnswer {
                    reason: LogUnavailable::TooLargeLive,
                    ..
                })
            ),
            "{follow:?}"
        );
        assert_eq!(b.fake.calls("trace 998 whole"), 1);
        // The job finishes with its last lines; the job page reads it once.
        let mut finished = running;
        finished.extend_from_slice(b"Job succeeded\n");
        let size = finished.len() as u64;
        lock(&b.fake.trace).log = finished;
        lock(&b.fake.jobs).insert(
            998,
            Answer::Ok(job_detail(998, PipelineStatus::Success, Some(size))),
        );
        b.service
            .job(
                JobInput {
                    cwd: b.cwd(),
                    job_id: 998,
                    refresh: Refresh::User,
                },
                &c(),
            )
            .await
            .unwrap();
        let last = chunk(
            b.service
                .job_log(b.log_input(LogFrom::Tail, Refresh::User), &c())
                .await
                .unwrap(),
        );
        assert_eq!(b.fake.calls("trace 998 whole"), 2, "the final log is read");
        assert!(last.complete);
        assert!(last.text.ends_with("Job succeeded\n"));
    }

    #[tokio::test]
    async fn a_final_read_that_beats_the_job_refresh_still_reads_the_finished_log() {
        let b = bench("pipelines-final-read-race").await;
        b.open().await;
        b.prs
            .pipelines
            .logs
            .set_range_support(HOST, RangeSupport::Unsupported);
        lock(&b.fake.jobs).insert(
            998,
            Answer::Ok(job_detail(998, PipelineStatus::Running, None)),
        );
        let mut running = vec![b'a'; log::LIVE_REDOWNLOAD_MAX];
        running.push(b'\n');
        lock(&b.fake.trace).log = running.clone();
        b.service
            .job_log(b.log_input(LogFrom::Tail, Refresh::User), &c())
            .await
            .unwrap();
        // The job finishes; the page's final read arrives before its job read.
        let mut finished = running;
        finished.extend_from_slice(b"Job succeeded\n");
        let size = finished.len() as u64;
        lock(&b.fake.trace).log = finished;
        lock(&b.fake.jobs).insert(
            998,
            Answer::Ok(job_detail(998, PipelineStatus::Success, Some(size))),
        );
        let last = chunk(
            b.service
                .job_log(b.log_input(LogFrom::Tail, Refresh::User), &c())
                .await
                .unwrap(),
        );
        assert!(last.complete);
        assert!(last.text.ends_with("Job succeeded\n"));
    }

    #[tokio::test]
    async fn a_finished_read_that_waits_on_a_running_download_reads_the_finished_log() {
        let b = bench("pipelines-final-read-waits").await;
        b.open().await;
        b.prs
            .pipelines
            .logs
            .set_range_support(HOST, RangeSupport::Unsupported);
        lock(&b.fake.jobs).insert(
            998,
            Answer::Ok(job_detail(998, PipelineStatus::Running, None)),
        );
        let mut running = vec![b'a'; log::LIVE_REDOWNLOAD_MAX];
        running.push(b'\n');
        lock(&b.fake.trace).log = running.clone();
        let token = c();
        let release = Arc::new(tokio::sync::Notify::new());
        *lock(&b.fake.trace_hold) = Some(release.clone());
        // One window downloads the running log; the job finishes meanwhile and
        // another window's final read waits for that download.
        let first = b
            .service
            .job_log(b.log_input(LogFrom::Tail, Refresh::User), &token);
        let last = async {
            while b.fake.calls("trace 998 whole") == 0 {
                tokio::task::yield_now().await;
                std::thread::sleep(Duration::from_millis(1));
            }
            let mut finished = running.clone();
            finished.extend_from_slice(b"Job succeeded\n");
            let size = finished.len() as u64;
            lock(&b.fake.trace).log = finished;
            lock(&b.fake.jobs).insert(
                998,
                Answer::Ok(job_detail(998, PipelineStatus::Success, Some(size))),
            );
            let read = b
                .service
                .job_log(b.log_input(LogFrom::Tail, Refresh::User), &token);
            let unblock = async {
                while b.fake.calls("job") < 2 {
                    tokio::task::yield_now().await;
                    std::thread::sleep(Duration::from_millis(1));
                }
                for _ in 0..20 {
                    tokio::task::yield_now().await;
                    std::thread::sleep(Duration::from_millis(1));
                }
                release.notify_one();
            };
            tokio::join!(read, unblock).0
        };
        let (first, last) = tokio::join!(first, last);
        assert!(!chunk(first.unwrap()).complete);
        let last = chunk(last.unwrap());
        assert!(last.complete);
        assert!(last.text.ends_with("Job succeeded\n"));
    }

    #[tokio::test]
    async fn a_memory_answer_older_than_30s_reads_the_job_first_and_a_403_refuses_the_text() {
        let b = bench("pipelines-authorized").await;
        b.open().await;
        b.prs
            .pipelines
            .logs
            .set_range_support(HOST, RangeSupport::Unsupported);
        lock(&b.fake.jobs).insert(
            998,
            Answer::Ok(job_detail(998, PipelineStatus::Success, Some(5))),
        );
        lock(&b.fake.trace).log = b"done\n".to_vec();
        b.service
            .job_log(b.log_input(LogFrom::Tail, Refresh::User), &c())
            .await
            .unwrap();
        assert_eq!(b.fake.calls("job"), 1);
        b.prs
            .pipelines
            .logs
            .age_job_reads(log::AUTHORIZATION_WINDOW);
        lock(&b.fake.jobs).insert(998, Answer::Err("forbidden", None));
        let error = b
            .service
            .job_log(b.log_input(LogFrom::Tail, Refresh::User), &c())
            .await
            .unwrap_err();
        assert_eq!(error.code, "forbidden", "not the cached text");
        assert_eq!(
            b.fake.calls("trace"),
            1,
            "the log itself was not read again"
        );
    }

    #[tokio::test]
    async fn a_trace_404_is_told_apart_by_the_job_read() {
        let b = bench("pipelines-trace-404").await;
        b.open().await;
        lock(&b.fake.trace).missing = true;
        for (status, erased, expected) in [
            (PipelineStatus::Running, false, LogUnavailable::NotStarted),
            (PipelineStatus::Queued, false, LogUnavailable::NotStarted),
            (PipelineStatus::Failed, true, LogUnavailable::Erased),
            (PipelineStatus::Success, false, LogUnavailable::NoOutput),
        ] {
            let mut job = job_detail(998, status, None);
            job.erased = erased;
            lock(&b.fake.jobs).insert(998, Answer::Ok(job));
            b.prs.pipelines.logs.clear();
            let answer = b
                .service
                .job_log(b.log_input(LogFrom::Tail, Refresh::User), &c())
                .await
                .unwrap();
            assert_eq!(reason(answer), expected, "{status:?} erased={erased}");
        }
        lock(&b.fake.jobs).remove(&998);
        b.prs.pipelines.logs.clear();
        let error = b
            .service
            .job_log(b.log_input(LogFrom::Tail, Refresh::User), &c())
            .await
            .unwrap_err();
        assert_eq!(error.code, "not_found", "only a 404 on the job itself");
    }

    fn action_input(b: &Bench, target: ActionTarget, action: ActionKind) -> RunActionInput {
        RunActionInput {
            cwd: b.cwd(),
            target,
            action,
        }
    }

    #[tokio::test]
    async fn a_double_click_sends_one_action_and_both_receive_the_new_job() {
        let b = bench("pipelines-action-once").await;
        let hold = Arc::new(tokio::sync::Notify::new());
        *lock(&b.fake.hold) = Some(hold.clone());
        let input = action_input(&b, ActionTarget::Job { id: 998 }, ActionKind::Retry);
        let token = c();
        let first = b.service.run_action(input.clone(), &token);
        let second = b.service.run_action(input.clone(), &token);
        let release = async {
            // Both clicks reach the flight before the host answers.
            while b.fake.calls("action") == 0 {
                tokio::task::yield_now().await;
                std::thread::sleep(Duration::from_millis(1));
            }
            for _ in 0..50 {
                tokio::task::yield_now().await;
                std::thread::sleep(Duration::from_millis(1));
            }
            hold.notify_waiters();
        };
        let (first, second, ()) = tokio::join!(first, second, release);
        let expected = ActionResult {
            pipeline_id: Some(4821),
            job_id: Some(1001),
        };
        assert_eq!(first.unwrap(), expected);
        assert_eq!(second.unwrap(), expected);
        assert_eq!(b.fake.calls("action"), 1, "one request for a double click");
        *lock(&b.fake.hold) = None;
        // A later click is a new action.
        b.service.run_action(input, &c()).await.unwrap();
        assert_eq!(b.fake.calls("action"), 2);
    }

    #[tokio::test]
    async fn an_action_during_host_backoff_is_refused_with_no_host_call_and_a_429_backs_off() {
        let b = bench("pipelines-action-held").await;
        let input = action_input(&b, ActionTarget::Job { id: 998 }, ActionKind::Retry);
        *lock(&b.fake.action) = Some(Answer::Err("rate_limited", Some(60)));
        let error = b.service.run_action(input.clone(), &c()).await.unwrap_err();
        assert_eq!(error.code, "rate_limited");
        assert_eq!(error.operation, "pipelines.runAction");
        assert_eq!(
            error.message,
            "GitLab allows a job three retries a minute. Try again in 60 s."
        );
        assert!(b.prs.pollers.host_backoff().remaining(HOST).is_some());
        let error = b.service.run_action(input, &c()).await.unwrap_err();
        assert_eq!(error.code, "rate_limited");
        assert_eq!(b.fake.calls("action"), 1, "a paused host gets no POST");
    }

    #[tokio::test]
    async fn a_github_refusal_is_remembered_until_rescan_and_keeps_the_context_and_rows() {
        let b = github_bench("pipelines-action-refused").await;
        b.open().await;
        b.put("detail", "3941", b"{}".to_vec()).await;
        lock(&b.fake.details).insert(
            4821,
            Answer::Ok(unknown_permissions(detail(
                4821,
                PipelineStatus::Failed,
                &[(998, PipelineStatus::Failed)],
            ))),
        );
        b.service.get(b.get_input(4821), &c()).await.unwrap();
        *lock(&b.fake.action) = Some(Answer::Err("forbidden", None));
        let input = action_input(&b, ActionTarget::Pipeline { id: 4821 }, ActionKind::Retry);
        let error = b.service.run_action(input.clone(), &c()).await.unwrap_err();
        assert_eq!(error.code, "forbidden");
        assert_eq!(
            error.message,
            "GitHub refused: this sign-in can't run Actions for this repository. A \
             fine-grained token needs Actions write."
        );
        // A refused action is not a lost sign-in.
        assert!(b.row(CONTEXT_KIND, "").await.is_some());
        assert!(b.row("detail", "3941").await.is_some());
        assert!(b.row(DETAIL_KIND, "4821").await.is_some());

        // Remembered: the next click is refused with no host call, and every
        // read and stored copy of the repository shows the action denied.
        let again = b.service.run_action(input, &c()).await.unwrap_err();
        assert_eq!(again.code, "forbidden");
        assert_eq!(b.fake.calls("action"), 1);
        let shown = b.service.get(b.get_input(4821), &c()).await.unwrap();
        let permissions = shown.pipeline.permissions.clone().unwrap();
        assert_eq!(
            (permissions.retry, permissions.cancel),
            (Permission::Denied, Permission::Unknown)
        );
        assert_eq!(
            shown.jobs().next().unwrap().permissions.retry,
            Permission::Denied
        );
        let painted = b
            .service
            .read_snapshot(b.snapshot_input(Some(4821), None), &c())
            .await
            .unwrap()
            .detail
            .unwrap()
            .payload;
        assert_eq!(
            painted.pipeline.permissions.unwrap().retry,
            Permission::Denied
        );
        // The stored copy keeps the host's own answer.
        let stored: Detail =
            decode_row(&b.row(DETAIL_KIND, "4821").await.unwrap().payload, "viewer").unwrap();
        assert_eq!(
            stored.pipeline.permissions.unwrap().retry,
            Permission::Unknown
        );

        let _ = b.prs.context(b.s.root(), ContextRead::Rescan, &c()).await;
        let shown = b.service.get(b.get_input(4821), &c()).await.unwrap();
        assert_eq!(
            shown.pipeline.permissions.unwrap().retry,
            Permission::Unknown,
            "a rescan forgets the refusal"
        );
    }

    /// GitLab reports its permissions on every read, and answers 403 for a
    /// job whose state moved on too: its refusal is shown, not remembered.
    #[tokio::test]
    async fn a_gitlab_refusal_is_shown_and_not_remembered() {
        let b = bench("pipelines-action-gitlab-refused").await;
        b.open().await;
        lock(&b.fake.details).insert(
            4821,
            Answer::Ok(unknown_permissions(detail(
                4821,
                PipelineStatus::Failed,
                &[(998, PipelineStatus::Failed)],
            ))),
        );
        *lock(&b.fake.action) = Some(Answer::Err("forbidden", None));
        let input = action_input(&b, ActionTarget::Pipeline { id: 4821 }, ActionKind::Retry);
        let error = b.service.run_action(input.clone(), &c()).await.unwrap_err();
        assert_eq!(
            error.message,
            "GitLab refused: this account can't retry this pipeline."
        );
        assert!(b.row(CONTEXT_KIND, "").await.is_some());
        b.service.run_action(input, &c()).await.unwrap_err();
        assert_eq!(
            b.fake.calls("action"),
            2,
            "the next click asks GitLab again"
        );
        let shown = b.service.get(b.get_input(4821), &c()).await.unwrap();
        assert_eq!(
            shown.pipeline.permissions.unwrap().retry,
            Permission::Unknown
        );
    }

    #[tokio::test]
    async fn a_missing_target_says_so_and_drops_only_its_rows() {
        let b = bench("pipelines-action-missing").await;
        b.put(JOB_KIND, "998", b"{}".to_vec()).await;
        b.put(DETAIL_KIND, "4821", b"{}".to_vec()).await;
        *lock(&b.fake.action) = Some(Answer::Err("not_found", None));
        let error = b
            .service
            .run_action(
                action_input(&b, ActionTarget::Job { id: 998 }, ActionKind::Play),
                &c(),
            )
            .await
            .unwrap_err();
        assert_eq!(error.message, "This job no longer exists.");
        assert!(b.row(JOB_KIND, "998").await.is_none());
        assert!(b.row(DETAIL_KIND, "4821").await.is_some());
    }

    #[test]
    fn a_github_refusal_names_actions_write() {
        assert_eq!(
            refusal_message(
                PullRequestsProvider::Github,
                ActionTarget::Pipeline { id: 1 },
                ActionKind::Cancel,
            ),
            "GitHub refused: this sign-in can't run Actions for this repository. A \
             fine-grained token needs Actions write."
        );
    }

    #[tokio::test]
    async fn github_rows_are_stored_and_painted_and_its_stream_is_unavailable() {
        let s = TestSandbox::new("pipelines-github");
        let gh = s.executable_script(
            "gh",
            r#"case "$1 $2" in
  '--version ') echo 'gh version 2.97.0' ;;
  'auth status') echo '{"hosts":{"github.com":[{"state":"success","active":true,"host":"github.com","login":"viewer"}]}}' ;;
  *) exit 64 ;;
esac"#,
            "",
        );
        let git = s.executable_script("git", "printf '%s' 'git@github.com:team/repo.git'", "");
        let database = new_database().await;
        let context_host = Arc::new(GitHubContextHost);
        let prs = PullRequestsService {
            github: context_host.clone(),
            gitlab: context_host,
            database: Some(database.clone()),
            ..PullRequestsService::with_runner(
                HostCommandRunner::new(s.path("state")).with_commands(&gh, "missing-glab", &git),
            )
        };
        let fake = FakeHost::gitlab();
        lock(&fake.details).insert(31, Answer::Ok(detail(31, PipelineStatus::Success, &[])));
        let service = PipelinesService::with_hosts(prs.clone(), fake.clone(), fake);
        // The panel's stored context, as `pullRequests.getContext` leaves it.
        prs.context(s.root(), ContextRead::Open, &c())
            .await
            .unwrap();
        let cwd = s.root().to_string_lossy().into_owned();
        let stored = service
            .get(
                GetInput {
                    cwd: cwd.clone(),
                    pipeline_id: 31,
                    attempt: None,
                    refresh: Refresh::User,
                },
                &c(),
            )
            .await
            .unwrap();
        let input = SubscribeInput {
            list: ListInput {
                cwd,
                scope: ListScope::All,
                git_ref: None,
                workflow_id: None,
                cursor: None,
                refresh: Refresh::User,
            },
            pipeline_id: Some(31),
            attempt: None,
            job_id: None,
        };
        let snapshot = service.read_snapshot(input.clone(), &c()).await.unwrap();
        assert_eq!(snapshot.detail.map(|row| row.payload), Some(stored));
        let refused = service
            .subscribe(input, &|_| true, &c())
            .await
            .expect_err("GitHub routes do not poll");
        assert_eq!(refused.code, "unavailable");
    }

    /// GitHub's reads through `gh api`: the list keeps its Workflow choices on
    /// a timer page that skips them, its rows paint from storage, a finished
    /// job's log downloads whole, and a running job's log is GitHub's to show.
    #[tokio::test]
    async fn github_reads_store_their_rows_keep_workflows_and_leave_a_running_log_to_github() {
        let s = TestSandbox::new("pipelines-github-runs");
        std::fs::write(
            s.path("runs.json"),
            include_str!("../../../tests/fixtures/pull_requests/github_runs.json"),
        )
        .unwrap();
        let job: serde_json::Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/pull_requests/github_job.json"
        ))
        .unwrap();
        std::fs::write(s.path("job.json"), job.to_string()).unwrap();
        let mut running = job;
        running["id"] = serde_json::json!(600);
        running["status"] = serde_json::json!("in_progress");
        running["conclusion"] = serde_json::Value::Null;
        std::fs::write(s.path("running-job.json"), running.to_string()).unwrap();
        let gh = s.executable_script(
            "gh",
            r#"case "$1 $2" in
  '--version ') echo 'gh version 2.97.0' ;;
  'auth status') echo '{"hosts":{"github.com":[{"state":"success","active":true,"host":"github.com","login":"viewer"}]}}' ;;
  'api -i') printf '%s\n' "$7" >> calls
    case "$7" in
      */actions/workflows\?*) printf 'HTTP/2 200 OK\r\n\r\n{"total_count":1,"workflows":[{"id":77,"name":"CI"}]}' ;;
      */actions/runs\?*) printf 'HTTP/2 200 OK\r\n\r\n'; cat runs.json ;;
      */actions/jobs/502) printf 'HTTP/2 200 OK\r\n\r\n'; cat job.json ;;
      */actions/jobs/600) printf 'HTTP/2 200 OK\r\n\r\n'; cat running-job.json ;;
      *) exit 64 ;;
    esac ;;
  'api -H') printf '%s\n' "$6" >> calls; printf 'log line\n' ;;
  *) exit 64 ;;
esac"#,
            "",
        );
        let git = s.executable_script("git", "printf '%s' 'git@github.com:team/repo.git'", "");
        let database = new_database().await;
        let context_host = Arc::new(GitHubContextHost);
        let runner =
            HostCommandRunner::new(s.path("state")).with_commands(&gh, "missing-glab", &git);
        let github = Arc::new(crate::pull_requests::github::GitHubHost::new(Arc::new(
            runner.clone(),
        )));
        let prs = PullRequestsService {
            github: context_host.clone(),
            gitlab: context_host,
            database: Some(database.clone()),
            ..PullRequestsService::with_runner(runner)
        };
        let service = PipelinesService::with_hosts(prs.clone(), FakeHost::gitlab(), github);
        prs.context(s.root(), ContextRead::Open, &c())
            .await
            .unwrap();
        let cwd = s.root().to_string_lossy().into_owned();
        let calls = || {
            std::fs::read_to_string(s.path("calls"))
                .unwrap_or_default()
                .lines()
                .map(str::to_owned)
                .collect::<Vec<_>>()
        };
        let mut list = ListInput {
            cwd: cwd.clone(),
            scope: ListScope::All,
            git_ref: None,
            workflow_id: None,
            cursor: None,
            refresh: Refresh::User,
        };
        let opened = service.list(list.clone(), &c()).await.unwrap();
        let workflows = Some(vec![model::Workflow {
            id: 77,
            name: "CI".into(),
        }]);
        assert_eq!(opened.workflows, workflows);
        assert_eq!(opened.rows[0].label, "CI #312");
        list.refresh = Refresh::Timer;
        let timer = service.list(list.clone(), &c()).await.unwrap();
        assert_eq!(timer.workflows, workflows, "a timer page keeps the filter");
        assert_eq!(
            calls()
                .iter()
                .filter(|call| call.contains("/actions/workflows?"))
                .count(),
            1,
            "workflows are read with the count only"
        );
        let snapshot = service
            .read_snapshot(
                SubscribeInput {
                    list,
                    pipeline_id: None,
                    attempt: None,
                    job_id: None,
                },
                &c(),
            )
            .await
            .unwrap();
        assert_eq!(snapshot.list.map(|row| row.payload), Some(timer));

        let log = |job_id| JobLogInput {
            cwd: cwd.clone(),
            job_id,
            attempt: Some(2),
            from: LogFrom::Tail,
            refresh: Refresh::User,
        };
        match service.job_log(log(502), &c()).await.unwrap() {
            JobLog::Chunk(chunk) => {
                assert_eq!(chunk.text, "log line\n");
                assert!(chunk.complete);
                assert_eq!(chunk.first_line, Some(0));
            }
            other => panic!("expected the finished log, got {other:?}"),
        }
        assert_eq!(
            service.job_log(log(600), &c()).await.unwrap(),
            JobLog::Unavailable(LogUnavailableAnswer {
                reason: LogUnavailable::LiveOnHost,
                url: Some("https://github.com/team/repo/actions/runs/9001/job/600".into()),
            })
        );
        let logs: Vec<_> = calls()
            .into_iter()
            .filter(|call| call.ends_with("/logs"))
            .collect();
        assert_eq!(
            logs,
            ["repos/team/repo/actions/jobs/502/logs"],
            "a running job's log is never downloaded"
        );
    }

    /// A GitHub host whose context read answers with no CLI call.
    struct GitHubContextHost;

    impl crate::pull_requests::host::PullRequestHost for GitHubContextHost {
        fn kind(&self) -> crate::source_control::ProviderKind {
            crate::source_control::ProviderKind::Github
        }
        fn capabilities(
            &self,
            _: Option<&crate::pull_requests::host::HostVersion>,
        ) -> crate::pull_requests::model::HostCapabilities {
            crate::pull_requests::permissions::tests::github_inputs().capabilities
        }
        fn context<'a>(
            &'a self,
            scope: &'a HostScope,
            _: &'a CancellationToken,
        ) -> HostFuture<'a, HostContext> {
            let mut context = crate::pull_requests::gitlab::pipelines::test_context();
            context.provider = PullRequestsProvider::Github;
            context.host = scope.host.clone();
            context.account.login = "viewer".into();
            context.web_url = "https://github.com/team/repo".into();
            Box::pin(async move { Ok(context) })
        }
        fn vocabulary<'a>(
            &'a self,
            _: &'a HostScope,
            _: crate::pull_requests::model::VocabularyKind,
            _: Option<&'a str>,
            _: &'a CancellationToken,
        ) -> HostFuture<'a, crate::pull_requests::model::Vocabulary> {
            unreachable!()
        }
        fn list<'a>(
            &'a self,
            _: &'a HostScope,
            _: &'a crate::pull_requests::model::ListQuery,
            _: &'a CancellationToken,
        ) -> HostFuture<'a, crate::pull_requests::model::ListPage> {
            unreachable!()
        }
        fn head_ref_spec(&self, _: u64) -> String {
            unreachable!()
        }
    }

    /// A lost sign-in on a poller read ends the stream and deletes the
    /// host's rows; a refused list deletes only its own row.
    #[tokio::test(start_paused = true)]
    async fn a_poller_sign_in_failure_deletes_the_host_rows_and_a_refused_list_its_row() {
        use futures_util::future::poll_immediate;
        let b = bench("pipelines-subscribe-signed-out").await;
        b.put("detail", "3941", b"{}".to_vec()).await;
        for (code, deleted) in [("forbidden", false), ("not_authenticated", true)] {
            let key = b.list_input(Refresh::User, None).snapshot_key();
            b.put(LIST_KIND, &key, b"{}".to_vec()).await;
            *lock(&b.fake.list) = Some(Answer::Err(code, None));
            let input = b.snapshot_input(None, None);
            let joined = poll::test_progress::JOINED.with(|joined| joined.get());
            let token = c();
            let mut subscriber = Box::pin(b.service.subscribe(input, &|_| true, &token));
            let mut result = None;
            // The clock moves only once `git` has answered and the poller
            // joined, so no process deadline fires early.
            for step in 0..5000 {
                result = poll_immediate(subscriber.as_mut()).await;
                if result.is_some() {
                    break;
                }
                let has_joined = poll::test_progress::JOINED.with(|j| j.get()) > joined;
                if has_joined && step % 100 == 99 {
                    tokio::time::advance(Duration::from_secs(20)).await;
                }
                std::thread::sleep(Duration::from_millis(1));
                tokio::task::yield_now().await;
            }
            assert_eq!(result.expect("the stream ended").unwrap_err().code, code);
            assert!(b.row(LIST_KIND, &key).await.is_none(), "{code}");
            assert_eq!(b.row("detail", "3941").await.is_none(), deleted, "{code}");
        }
    }
}

mod poller {
    use super::{poll::PollInputs, *};
    use crate::pull_requests::{
        backoff::HostBackoff,
        snapshot_store::{HostFences, Snapshot as StoredSnapshot},
    };
    use futures_util::future::poll_immediate;
    use std::{future::Future, pin::Pin};

    struct Bench {
        registry: poll::Registry,
        host: Arc<FakeHost>,
        database: Database,
        fences: HostFences,
        backoff: Arc<HostBackoff>,
        scope: HostScope,
        list: ListInput,
        list_key: String,
    }

    async fn bench() -> Bench {
        let database = Database::open_in_memory().await.expect("database");
        database
            .call(|connection| Ok(crate::persistence::run_migrations(connection, None)?))
            .await
            .expect("migrations");
        let list = ListInput {
            cwd: "/repo".into(),
            scope: ListScope::All,
            git_ref: None,
            workflow_id: None,
            cursor: None,
            refresh: Refresh::Timer,
        };
        Bench {
            registry: poll::Registry::default(),
            host: FakeHost::gitlab(),
            database,
            fences: HostFences::default(),
            backoff: Arc::default(),
            scope: HostScope {
                cwd: "/repo".into(),
                host: "gitlab.example".into(),
                repository: "team/repo".into(),
                provider: PullRequestsProvider::Gitlab,
            },
            list_key: list.snapshot_key(),
            list,
        }
    }

    type Log = Arc<Mutex<Vec<Changed>>>;

    struct Subscriber<'a> {
        future: Pin<Box<dyn Future<Output = Result<(), PullRequestsOperationError>> + 'a>>,
        result: Option<Result<(), PullRequestsOperationError>>,
    }

    thread_local! {
        static CREATED: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    }

    impl Bench {
        fn inputs(&self) -> PollInputs<'_> {
            PollInputs {
                registry: &self.registry,
                host: self.host.as_ref(),
                database: &self.database,
                fences: &self.fences,
                backoff: &self.backoff,
                scope: &self.scope,
                list: &self.list,
                list_key: &self.list_key,
            }
        }

        fn subscriber<'a>(
            &'a self,
            inputs: &'a PollInputs<'a>,
            pipeline: Option<u64>,
            emit: &'a (dyn Fn(Changed) -> bool + Send + Sync),
            c: &'a CancellationToken,
        ) -> Subscriber<'a> {
            CREATED.with(|created| created.set(created.get() + 1));
            Subscriber {
                future: Box::pin(poll::run_subscriber(inputs, pipeline, emit, c)),
                result: None,
            }
        }

        fn running(&self, id: u64) {
            lock(&self.host.details).insert(
                id,
                Answer::Ok(detail(
                    id,
                    PipelineStatus::Running,
                    &[(id * 10, PipelineStatus::Running)],
                )),
            );
        }

        fn set(&self, id: u64, status: PipelineStatus) {
            let job_status = if model::is_terminal(status) {
                status
            } else {
                PipelineStatus::Running
            };
            lock(&self.host.details)
                .insert(id, Answer::Ok(detail(id, status, &[(id * 10, job_status)])));
        }

        async fn stored(&self, kind: &'static str, key: &str) -> Option<StoredSnapshot> {
            let key = key.to_owned();
            self.database
                .call(move |connection| {
                    Ok(SnapshotStore::new(connection).get(
                        "gitlab.example",
                        "team/repo",
                        kind,
                        &key,
                    )?)
                })
                .await
                .unwrap()
        }
    }

    fn settled() -> bool {
        poll::test_progress::TICKING.with(|ticking| ticking.get()) == 0
            && poll::test_progress::JOINED.with(|joined| joined.get())
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

    /// Advances every subscriber as far as it goes without blocking. The
    /// database answers on its own thread, so a tiny real sleep lets it run
    /// while the paused clock stays where the test put it.
    async fn drive(subscribers: &mut [Subscriber<'_>]) {
        for _ in 0..20 {
            poll_all(subscribers).await;
            std::thread::sleep(Duration::from_millis(1));
            tokio::task::yield_now().await;
        }
        for _ in 0..30_000 {
            if settled() {
                break;
            }
            poll_all(subscribers).await;
            std::thread::sleep(Duration::from_millis(1));
            tokio::task::yield_now().await;
        }
        for _ in 0..20 {
            poll_all(subscribers).await;
            std::thread::sleep(Duration::from_millis(1));
            tokio::task::yield_now().await;
        }
    }

    async fn tick(subscribers: &mut [Subscriber<'_>], seconds: u64) {
        tokio::time::advance(Duration::from_secs(seconds)).await;
        drive(subscribers).await;
    }

    /// Runs a database call while the subscribers keep being driven, so the
    /// paused clock never auto-advances into an extra tick.
    async fn while_driving<T>(
        subscribers: &mut [Subscriber<'_>],
        future: impl Future<Output = T>,
    ) -> T {
        let mut future = Box::pin(future);
        for _ in 0..2000 {
            poll_all(subscribers).await;
            if let Some(result) = poll_immediate(future.as_mut()).await {
                return result;
            }
            std::thread::sleep(Duration::from_millis(1));
            tokio::task::yield_now().await;
        }
        panic!("the call never completed");
    }

    fn emitter(log: &Log) -> impl Fn(Changed) -> bool + Send + Sync + use<> {
        let log = log.clone();
        move |changed| {
            lock(&log).push(changed);
            true
        }
    }

    /// The events after the all-false one every subscriber is sent on join.
    fn ticks(log: &Log) -> Vec<Changed> {
        let log = lock(log);
        assert_eq!(
            log.first(),
            Some(&Changed::default()),
            "the first event is all false"
        );
        log[1..].to_vec()
    }

    #[tokio::test(start_paused = true)]
    async fn pipelines_poller_two_subscribers_share_one_driver_and_one_list_read_per_tick() {
        let b = bench().await;
        let inputs = b.inputs();
        let (log1, log2) = (Log::default(), Log::default());
        let (emit1, emit2) = (emitter(&log1), emitter(&log2));
        let (c1, c2) = (CancellationToken::new(), CancellationToken::new());
        let mut subs = [
            b.subscriber(&inputs, None, &emit1, &c1),
            b.subscriber(&inputs, None, &emit2, &c2),
        ];
        drive(&mut subs).await;
        assert_eq!(b.host.calls("list"), 0, "the first tick waits one period");
        tick(&mut subs, 20).await;
        assert_eq!(b.host.calls("list"), 1, "two subscribers share one tick");
        assert_eq!(
            b.host.calls("list cursor=- count=false"),
            1,
            "never a count"
        );
        let changed = Changed {
            list: true,
            pipeline: false,
            refused: None,
        };
        assert_eq!(ticks(&log1), [changed]);
        assert_eq!(ticks(&log2), [changed]);
        // An unchanged page is not stored again and names nothing.
        tick(&mut subs, 20).await;
        assert_eq!(b.host.calls("list"), 2);
        assert_eq!(ticks(&log1).len(), 1);

        // The driver leaves; the other subscriber takes the loop over.
        c1.cancel();
        drive(&mut subs).await;
        assert!(subs[0].result.is_some());
        lock(&b.host.list).replace(Answer::Ok(vec![row(4822, PipelineStatus::Running)]));
        tick(&mut subs, 20).await;
        assert_eq!(b.host.calls("list"), 3);
        assert_eq!(ticks(&log2), [changed, changed]);
        c2.cancel();
        drive(&mut subs).await;
    }

    #[tokio::test(start_paused = true)]
    async fn pipelines_poller_reads_a_running_pipeline_every_10s_and_a_terminal_one_once_more() {
        let b = bench().await;
        b.running(4821);
        let inputs = b.inputs();
        let log = Log::default();
        let emit = emitter(&log);
        let c = CancellationToken::new();
        let mut subs = [b.subscriber(&inputs, Some(4821), &emit, &c)];
        drive(&mut subs).await;
        tick(&mut subs, 10).await;
        assert_eq!(b.host.calls("detail 4821"), 1);
        let stored = while_driving(&mut subs, b.stored(DETAIL_KIND, "4821"))
            .await
            .unwrap();
        let payload: Detail = decode_row(&stored.payload, "ana").expect("stamped with the login");
        assert_eq!(payload.revision, stored.generation);
        assert!(ticks(&log).iter().any(|changed| changed.pipeline));
        tick(&mut subs, 10).await;
        assert_eq!(b.host.calls("detail 4821"), 2, "every 10 s while running");
        let named = ticks(&log).iter().filter(|c| c.pipeline).count();
        assert_eq!(named, 1, "an unchanged read names nothing");

        b.set(4821, PipelineStatus::Success);
        tick(&mut subs, 10).await;
        assert_eq!(b.host.calls("detail 4821"), 3);
        tick(&mut subs, 10).await;
        assert_eq!(
            b.host.calls("detail 4821"),
            4,
            "read once more after terminal"
        );
        for _ in 0..3 {
            tick(&mut subs, 20).await;
        }
        assert_eq!(b.host.calls("detail 4821"), 4, "then left");
        assert!(b.host.calls("list") >= 3, "the list keeps polling");
        c.cancel();
        drive(&mut subs).await;
    }

    #[tokio::test(start_paused = true)]
    async fn pipelines_poller_reads_at_most_three_pipelines_and_skips_one_stored_terminal() {
        let b = bench().await;
        for id in [1, 2, 3, 4] {
            b.running(id);
        }
        let terminal = serde_json::to_vec(&serde_json::json!({
            "login": "ana",
            "payload": detail(5, PipelineStatus::Success, &[]),
        }))
        .unwrap();
        b.database
            .call(move |connection| {
                Ok(SnapshotStore::new(connection).put(StoredSnapshot {
                    host: "gitlab.example".into(),
                    project: "team/repo".into(),
                    kind: DETAIL_KIND.into(),
                    key: "5".into(),
                    fingerprint: String::new(),
                    payload: terminal,
                    observed_at_ms: 1,
                    generation: 1,
                })?)
            })
            .await
            .unwrap();
        let inputs = b.inputs();
        let emit = |_| true;
        let c = CancellationToken::new();
        let mut subs = [
            b.subscriber(&inputs, Some(5), &emit, &c),
            b.subscriber(&inputs, Some(1), &emit, &c),
            b.subscriber(&inputs, Some(2), &emit, &c),
            b.subscriber(&inputs, Some(3), &emit, &c),
            b.subscriber(&inputs, Some(4), &emit, &c),
        ];
        drive(&mut subs).await;
        tick(&mut subs, 10).await;
        tick(&mut subs, 10).await;
        assert_eq!(b.host.calls("detail 5"), 0, "its stored row is terminal");
        // The terminal one gives its place to the next once its row is seen.
        assert_eq!(
            [1, 2, 3, 4].map(|id| b.host.calls(&format!("detail {id}"))),
            [2, 2, 1, 0],
            "at most three, in join order"
        );
        c.cancel();
        drive(&mut subs).await;
    }

    #[tokio::test(start_paused = true)]
    async fn pipelines_poller_thirty_quiet_minutes_drop_a_pipeline_to_20s() {
        let b = bench().await;
        b.running(4821);
        let inputs = b.inputs();
        let emit = |_| true;
        let c = CancellationToken::new();
        let mut subs = [b.subscriber(&inputs, Some(4821), &emit, &c)];
        drive(&mut subs).await;
        for _ in 0..180 {
            tick(&mut subs, 10).await;
        }
        let quiet = b.host.calls("detail 4821");
        assert!((179..=181).contains(&quiet), "{quiet}");
        for _ in 0..12 {
            tick(&mut subs, 10).await;
        }
        let reads = b.host.calls("detail 4821") - quiet;
        assert!((5..=6).contains(&reads), "every 20 s once quiet: {reads}");
        c.cancel();
        drive(&mut subs).await;
    }

    #[tokio::test(start_paused = true)]
    async fn pipelines_poller_an_undelivered_event_is_resent_and_a_joiner_is_not_sent_what_it_painted()
     {
        let b = bench().await;
        let inputs = b.inputs();
        let accept = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let log = Log::default();
        let refusing = {
            let (log, accept) = (log.clone(), accept.clone());
            move |changed: Changed| {
                if !changed.any() || accept.load(std::sync::atomic::Ordering::SeqCst) {
                    lock(&log).push(changed);
                    true
                } else {
                    false
                }
            }
        };
        let c = CancellationToken::new();
        let mut subs = [b.subscriber(&inputs, None, &refusing, &c)];
        drive(&mut subs).await;
        tick(&mut subs, 20).await;
        assert_eq!(ticks(&log), [], "the stream refused the event");
        accept.store(true, std::sync::atomic::Ordering::SeqCst);
        tick(&mut subs, 20).await;
        assert_eq!(
            ticks(&log),
            [Changed {
                list: true,
                pipeline: false,
                refused: None,
            }],
            "re-sent with the next tick"
        );

        // A subscriber joining after the row was stored is not sent it.
        let late_log = Log::default();
        let late_emit = emitter(&late_log);
        let late_c = CancellationToken::new();
        let late = b.subscriber(&inputs, None, &late_emit, &late_c);
        let mut subs = [subs.into_iter().next().unwrap(), late];
        drive(&mut subs).await;
        tick(&mut subs, 20).await;
        assert_eq!(ticks(&late_log), []);
        c.cancel();
        late_c.cancel();
        drive(&mut subs).await;
    }

    #[tokio::test(start_paused = true)]
    async fn pipelines_poller_a_lagged_receiver_catches_up_from_revisions() {
        let b = bench().await;
        b.running(4821);
        let inputs = b.inputs();
        let (driver_log, lagging_log) = (Log::default(), Log::default());
        let (driver_emit, lagging_emit) = (emitter(&driver_log), emitter(&lagging_log));
        let c = CancellationToken::new();
        let mut driver = [b.subscriber(&inputs, Some(4821), &driver_emit, &c)];
        drive(&mut driver).await;
        let mut lagging = b.subscriber(&inputs, Some(4821), &lagging_emit, &c);
        // Let the late subscriber join, then stop polling it.
        while_driving(&mut driver, async {
            for _ in 0..200 {
                if poll_immediate(lagging.future.as_mut()).await.is_some() {
                    break;
                }
                if settled() {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await;
        for step in 0..20 {
            if step == 10 {
                b.set(4821, PipelineStatus::Failed);
            }
            tick(&mut driver, 10).await;
        }
        assert!(ticks(&driver_log).iter().filter(|c| c.pipeline).count() >= 2);
        let mut subs = [lagging];
        drive(&mut subs).await;
        tick(&mut driver, 20).await;
        drive(&mut subs).await;
        assert!(
            ticks(&lagging_log).iter().any(|changed| changed.pipeline),
            "the lagged receiver still learns the pipeline changed"
        );
        c.cancel();
        drive(&mut driver).await;
        drive(&mut subs).await;
    }

    #[tokio::test(start_paused = true)]
    async fn pipelines_poller_a_429_backs_off_every_reader_of_the_host_and_waits_for_the_deadline()
    {
        let b = bench().await;
        let inputs = b.inputs();
        lock(&b.host.list).replace(Answer::Err("rate_limited", Some(600)));
        let emit = |_| true;
        let c = CancellationToken::new();
        let mut subs = [b.subscriber(&inputs, None, &emit, &c)];
        drive(&mut subs).await;
        tick(&mut subs, 20).await;
        assert_eq!(b.host.calls("list"), 1);
        let remaining = b.backoff.remaining("gitlab.example").unwrap();
        assert!(
            remaining > Duration::from_secs(500),
            "the provider's 600 s: {remaining:?}"
        );
        lock(&b.host.list).replace(Answer::Ok(vec![]));
        for _ in 0..25 {
            tick(&mut subs, 20).await;
        }
        assert_eq!(b.host.calls("list"), 1, "no read before the deadline");
        tick(&mut subs, 120).await;
        assert_eq!(b.host.calls("list"), 2);
        assert_eq!(
            b.backoff.remaining("gitlab.example"),
            None,
            "a success recovers"
        );
        c.cancel();
        drive(&mut subs).await;
    }

    #[tokio::test(start_paused = true)]
    async fn pipelines_poller_a_refused_pipeline_is_named_once_and_left_while_the_list_polls() {
        let b = bench().await;
        lock(&b.host.details).insert(4821, Answer::Err("forbidden", None));
        let inputs = b.inputs();
        let log = Log::default();
        let emit = emitter(&log);
        let c = CancellationToken::new();
        let mut subs = [b.subscriber(&inputs, Some(4821), &emit, &c)];
        drive(&mut subs).await;
        tick(&mut subs, 10).await;
        tick(&mut subs, 10).await;
        for _ in 0..3 {
            tick(&mut subs, 20).await;
        }
        assert_eq!(b.host.calls("detail 4821"), 1, "never read again");
        assert!(
            b.host.calls("list") >= 3,
            "the rest of the key keeps polling"
        );
        let named: Vec<Changed> = ticks(&log).into_iter().filter(|c| c.pipeline).collect();
        assert_eq!(named.len(), 1, "named once");
        // Its stored row is gone: the event says why, so the view can say so.
        assert_eq!(named[0].refused, Some(model::Refusal::Forbidden));
        assert!(
            ticks(&log)
                .iter()
                .all(|c| c.pipeline || c.refused.is_none()),
            "only the pipeline name carries it"
        );
        assert!(subs[0].result.is_none(), "the subscriber stays");
        c.cancel();
        drive(&mut subs).await;
    }

    #[tokio::test(start_paused = true)]
    async fn pipelines_poller_a_window_that_joins_after_a_refusal_is_told_it_too() {
        let b = bench().await;
        lock(&b.host.details).insert(4821, Answer::Err("not_found", None));
        let inputs = b.inputs();
        let (first_log, late_log) = (Log::default(), Log::default());
        let (first_emit, late_emit) = (emitter(&first_log), emitter(&late_log));
        let (c1, c2) = (CancellationToken::new(), CancellationToken::new());
        let mut first = [b.subscriber(&inputs, Some(4821), &first_emit, &c1)];
        drive(&mut first).await;
        tick(&mut first, 10).await;
        let [first] = first;
        let mut subs = [first, b.subscriber(&inputs, Some(4821), &late_emit, &c2)];
        drive(&mut subs).await;
        tick(&mut subs, 20).await;
        assert_eq!(b.host.calls("detail 4821"), 1, "never read again");
        assert!(
            ticks(&late_log)
                .iter()
                .any(|c| c.pipeline && c.refused == Some(model::Refusal::NotFound)),
            "the late window learns the pipeline is gone"
        );
        c1.cancel();
        c2.cancel();
        drive(&mut subs).await;
    }

    #[tokio::test(start_paused = true)]
    async fn pipelines_poller_a_sign_in_failure_ends_every_subscriber() {
        let b = bench().await;
        lock(&b.host.list).replace(Answer::Err("not_authenticated", None));
        let inputs = b.inputs();
        let emit = |_| true;
        let c = CancellationToken::new();
        let mut subs = [
            b.subscriber(&inputs, None, &emit, &c),
            b.subscriber(&inputs, Some(4821), &emit, &c),
        ];
        drive(&mut subs).await;
        tick(&mut subs, 20).await;
        for subscriber in &subs {
            assert_eq!(
                subscriber
                    .result
                    .as_ref()
                    .expect("ended")
                    .as_ref()
                    .unwrap_err()
                    .code,
                "not_authenticated"
            );
        }
    }

    #[tokio::test(start_paused = true)]
    async fn pipelines_poller_without_a_known_context_reads_and_writes_nothing() {
        let b = bench().await;
        *lock(&b.host.context) = None;
        let inputs = b.inputs();
        let emit = |_| true;
        let c = CancellationToken::new();
        let mut subs = [b.subscriber(&inputs, None, &emit, &c)];
        drive(&mut subs).await;
        tick(&mut subs, 20).await;
        assert!(lock(&b.host.calls).is_empty());
        c.cancel();
        drive(&mut subs).await;
    }

    #[tokio::test(start_paused = true)]
    async fn pipelines_poller_reads_a_left_terminal_pipeline_again_once_an_action_rearms_it() {
        let b = bench().await;
        b.set(4821, PipelineStatus::Failed);
        let inputs = b.inputs();
        let emit = |_| true;
        let c = CancellationToken::new();
        let mut subs = [b.subscriber(&inputs, Some(4821), &emit, &c)];
        drive(&mut subs).await;
        tick(&mut subs, 10).await;
        tick(&mut subs, 10).await;
        tick(&mut subs, 20).await;
        assert_eq!(
            b.host.calls("detail 4821"),
            2,
            "terminal: read once more, then left"
        );

        // A retry made it run again.
        b.running(4821);
        b.registry.rearm("gitlab.example", "team/repo", 4821);
        // The same id in another project is another pipeline.
        b.registry.rearm("gitlab.example", "team/other", 4821);
        tick(&mut subs, 20).await;
        assert_eq!(b.host.calls("detail 4821"), 3);
        tick(&mut subs, 10).await;
        assert_eq!(b.host.calls("detail 4821"), 4, "every 10 s while running");
        c.cancel();
        drive(&mut subs).await;
    }

    #[tokio::test(start_paused = true)]
    async fn pipelines_poller_replaces_unchanged_rows_stored_under_another_account() {
        let b = bench().await;
        // Another account stored what this one is about to read.
        let rows = vec![row(4821, PipelineStatus::Running)];
        let page = ListPage {
            revision: 1,
            rows: rows.clone(),
            next_cursor: Some("next".into()),
            total: None,
            workflows: None,
        };
        let generation = snapshot_store::next_generation();
        store_row(
            &b.database,
            &b.fences,
            &b.scope,
            "previous-account",
            LIST_KIND,
            &b.list_key,
            list_fingerprint(&rows),
            &page,
            generation,
        )
        .await;
        b.running(4821);
        let stored_detail = detail(
            4821,
            PipelineStatus::Running,
            &[(48210, PipelineStatus::Running)],
        );
        store_row(
            &b.database,
            &b.fences,
            &b.scope,
            "previous-account",
            DETAIL_KIND,
            "4821",
            detail_fingerprint(&stored_detail),
            &stored_detail,
            generation,
        )
        .await;
        let login = b.host.known_context(&b.scope).unwrap().account.login;
        let inputs = b.inputs();
        let log = Log::default();
        let emit = emitter(&log);
        let c = CancellationToken::new();
        let mut subs = [b.subscriber(&inputs, Some(4821), &emit, &c)];
        drive(&mut subs).await;
        tick(&mut subs, 10).await;
        let list = while_driving(&mut subs, b.stored(LIST_KIND, &b.list_key)).await;
        assert!(
            decode_row::<ListPage>(&list.unwrap().payload, &login).is_some(),
            "the list row now paints for the signed-in account"
        );
        let pipeline = while_driving(&mut subs, b.stored(DETAIL_KIND, "4821")).await;
        assert!(decode_row::<Detail>(&pipeline.unwrap().payload, &login).is_some());
        assert_eq!(
            ticks(&log),
            [Changed {
                list: true,
                pipeline: true,
                refused: None,
            }]
        );
        c.cancel();
        drive(&mut subs).await;
    }
}
