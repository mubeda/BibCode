use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
    time::Duration,
};

use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use super::{
    GitCommandError, GitRepository, ProviderKind as GitProviderKind, VcsStatusSummary,
    VcsSummaryChangeRequest, canonical_worktree_path_key,
};
use crate::source_control::{
    ChangeRequestState, ProviderKind, PullRequestService, ResolvePullRequestInput,
    SourceControlProviderError, WireOption,
};

const SUMMARY_FRESHNESS: Duration = Duration::from_secs(30);

#[derive(Clone)]
pub struct GitStatusSummaryService {
    inner: Arc<Inner>,
}

struct Inner {
    repository: Arc<GitRepository>,
    pull_requests: PullRequestService,
    freshness: Duration,
    state: Mutex<State>,
    #[cfg(test)]
    entry_changed: tokio::sync::Notify,
    #[cfg(test)]
    refresh_armed: tokio::sync::Notify,
    #[cfg(test)]
    pull_request_test_loader: Mutex<Option<Arc<SummaryPullRequestTestLoader>>>,
}

#[derive(Default)]
struct State {
    next_generation: u64,
    entries: HashMap<String, SummaryEntry>,
}

struct SummaryEntry {
    generation: u64,
    sender: watch::Sender<Option<Result<VcsStatusSummary, GitCommandError>>>,
}

struct RetainedPullRequest {
    reference: String,
    provider: GitProviderKind,
    pull_request: VcsSummaryChangeRequest,
    observed_at: String,
    observed_cycle: u64,
}

#[cfg(test)]
struct SummaryPullRequestTestLoader {
    pull_request: crate::source_control::ResolvedPullRequest,
    calls: std::sync::atomic::AtomicUsize,
    changed: tokio::sync::Notify,
}

#[cfg(test)]
impl SummaryPullRequestTestLoader {
    async fn load(
        &self,
        cancellation: &CancellationToken,
    ) -> Result<Option<crate::source_control::ResolvedPullRequest>, GitCommandError> {
        let call = self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        self.changed.notify_waiters();
        if call == 0 {
            return Ok(Some(self.pull_request.clone()));
        }
        cancellation.cancelled().await;
        Err(summary_error(
            Path::new("/test-summary"),
            "test enrichment was cancelled",
        ))
    }

    async fn wait_for_calls(&self, expected: usize) {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let changed = self.changed.notified();
                if self.calls.load(std::sync::atomic::Ordering::SeqCst) >= expected {
                    return;
                }
                changed.await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("summary enrichment call {expected} deadline"));
    }
}

impl GitStatusSummaryService {
    #[must_use]
    pub fn new(repository: Arc<GitRepository>, pull_requests: PullRequestService) -> Self {
        Self::with_dependencies(repository, pull_requests, SUMMARY_FRESHNESS)
    }

    #[must_use]
    pub fn with_dependencies(
        repository: Arc<GitRepository>,
        pull_requests: PullRequestService,
        freshness: Duration,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                repository,
                pull_requests,
                freshness,
                state: Mutex::new(State::default()),
                #[cfg(test)]
                entry_changed: tokio::sync::Notify::new(),
                #[cfg(test)]
                refresh_armed: tokio::sync::Notify::new(),
                #[cfg(test)]
                pull_request_test_loader: Mutex::new(None),
            }),
        }
    }

    pub async fn subscribe(
        &self,
        cwd: PathBuf,
    ) -> Result<watch::Receiver<Option<Result<VcsStatusSummary, GitCommandError>>>, GitCommandError>
    {
        let key = canonical_worktree_path_key(&cwd)
            .await
            .map_err(|error| summary_error(&cwd, &error.to_string()))?;
        let mut state = self.lock_state();
        if let Some(entry) = state.entries.get(&key)
            && !entry.sender.is_closed()
        {
            return Ok(entry.sender.subscribe());
        }
        let generation = state.next_generation;
        state.next_generation = state.next_generation.wrapping_add(1);
        let (sender, receiver) = watch::channel(None);
        state.entries.insert(
            key.clone(),
            SummaryEntry {
                generation,
                sender: sender.clone(),
            },
        );
        #[cfg(test)]
        self.inner.entry_changed.notify_one();
        drop(state);

        let inner = Arc::clone(&self.inner);
        tokio::spawn(async move {
            run_summary_producer(Arc::clone(&inner), cwd, &sender).await;
            let mut state = inner
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if state
                .entries
                .get(&key)
                .is_some_and(|entry| entry.generation == generation)
            {
                state.entries.remove(&key);
                #[cfg(test)]
                inner.entry_changed.notify_one();
            }
        });
        Ok(receiver)
    }

    #[cfg(test)]
    fn active_cwd_count_for_test(&self) -> usize {
        self.lock_state().entries.len()
    }

    #[cfg(test)]
    async fn wait_for_active_cwd_count_for_test(&self, expected: usize) {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if self.active_cwd_count_for_test() == expected {
                    return;
                }
                self.inner.entry_changed.notified().await;
            }
        })
        .await
        .expect("summary entry-count signal deadline");
    }

    #[cfg(test)]
    async fn wait_for_refresh_armed_for_test(&self) {
        tokio::time::timeout(Duration::from_secs(5), self.inner.refresh_armed.notified())
            .await
            .expect("summary refresh-arm signal deadline");
    }

    #[cfg(test)]
    fn install_pull_request_test_loader(
        &self,
        pull_request: crate::source_control::ResolvedPullRequest,
    ) -> Arc<SummaryPullRequestTestLoader> {
        let loader = Arc::new(SummaryPullRequestTestLoader {
            pull_request,
            calls: std::sync::atomic::AtomicUsize::new(0),
            changed: tokio::sync::Notify::new(),
        });
        *self
            .inner
            .pull_request_test_loader
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(Arc::clone(&loader));
        loader
    }

    fn lock_state(&self) -> MutexGuard<'_, State> {
        self.inner
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

async fn run_summary_producer(
    inner: Arc<Inner>,
    cwd: PathBuf,
    sender: &watch::Sender<Option<Result<VcsStatusSummary, GitCommandError>>>,
) {
    let mut last = None;
    let mut retained_pull_request: Option<RetainedPullRequest> = None;
    let mut next_cycle = 0_u64;
    'producer: loop {
        let cycle = next_cycle;
        next_cycle = next_cycle.wrapping_add(1);
        let cycle_started = tokio::time::Instant::now();
        let deadline = tokio::time::sleep_until(cycle_started + inner.freshness);
        tokio::pin!(deadline);
        let cancellation = CancellationToken::new();
        let read_inner = Arc::clone(&inner);
        let read_cwd = cwd.clone();
        let read_cancellation = cancellation.clone();
        let mut read = tokio::spawn(async move {
            read_inner
                .repository
                .summary_status(&read_cwd, &read_cancellation)
                .await
        });
        let result = tokio::select! {
            biased;
            () = sender.closed() => {
                cancellation.cancel();
                let _ = read.await;
                if sender.receiver_count() == 0 {
                    return;
                }
                continue 'producer;
            }
            () = &mut deadline => {
                cancellation.cancel();
                let _ = read.await;
                publish_stale_at_cycle_boundary(sender, &mut last);
                continue 'producer;
            }
            result = &mut read => result.unwrap_or_else(|error| {
                Err(summary_error(&cwd, &format!("summary task failed: {error}")))
            }),
        };

        let mut base = match result {
            Ok(summary) => summary,
            Err(error) => {
                sender.send_replace(Some(summary_publication(&mut last, Err(error))));
                arm_refresh_for_test(&inner);
                tokio::select! {
                    biased;
                    () = sender.closed() => return,
                    () = &mut deadline => {
                        publish_stale_at_cycle_boundary(sender, &mut last);
                    }
                }
                continue 'producer;
            }
        };
        let fresh_base = base.clone();
        let enrichment = summary_enrichment_input(&base);
        match (&retained_pull_request, &enrichment) {
            (Some(retained), Some((reference, provider)))
                if retained.reference == *reference
                    && retained.provider == *provider
                    && retained.observed_cycle.wrapping_add(1) == cycle =>
            {
                base.pr = Some(retained.pull_request.clone());
                base.observed_at.clone_from(&retained.observed_at);
                base.stale = true;
            }
            _ => retained_pull_request = None,
        }
        sender.send_replace(Some(summary_publication(&mut last, Ok(base))));
        arm_refresh_for_test(&inner);

        let Some((reference, provider)) = enrichment else {
            tokio::select! {
                biased;
                () = sender.closed() => return,
                () = &mut deadline => {
                    publish_stale_at_cycle_boundary(sender, &mut last);
                }
            }
            continue 'producer;
        };

        let enrichment_cancellation = CancellationToken::new();
        let enrichment_inner = Arc::clone(&inner);
        let enrichment_cwd = cwd.clone();
        let read_cancellation = enrichment_cancellation.clone();
        let mut enrichment_read = tokio::spawn(async move {
            load_pull_request(
                &enrichment_inner,
                &enrichment_cwd,
                provider,
                reference,
                &read_cancellation,
            )
            .await
        });
        let enrichment_result = tokio::select! {
            biased;
            () = sender.closed() => {
                enrichment_cancellation.cancel();
                let _ = enrichment_read.await;
                if sender.receiver_count() == 0 {
                    return;
                }
                continue 'producer;
            }
            () = &mut deadline => {
                enrichment_cancellation.cancel();
                let _ = enrichment_read.await;
                publish_stale_at_cycle_boundary(sender, &mut last);
                continue 'producer;
            }
            result = &mut enrichment_read => result.unwrap_or_else(|error| {
                Err(summary_error(&cwd, &format!("summary enrichment task failed: {error}")))
            }),
        };
        match enrichment_result {
            Ok(Some(pull_request)) => {
                let mut enriched = fresh_base;
                apply_pull_request(&mut enriched, pull_request);
                retained_pull_request =
                    enriched.pr.clone().map(|pull_request| RetainedPullRequest {
                        reference: enriched.ref_name.clone().expect("enrichment has named ref"),
                        provider: enriched
                            .source_control_provider
                            .as_ref()
                            .expect("enrichment has provider")
                            .kind,
                        pull_request,
                        observed_at: enriched.observed_at.clone(),
                        observed_cycle: cycle,
                    });
                sender.send_replace(Some(summary_publication(&mut last, Ok(enriched))));
            }
            Ok(None) => {
                retained_pull_request = None;
                sender.send_replace(Some(summary_publication(&mut last, Ok(fresh_base))));
            }
            Err(error) => {
                sender.send_replace(Some(summary_publication(&mut last, Err(error))));
            }
        }
        tokio::select! {
            biased;
            () = sender.closed() => return,
            () = &mut deadline => {
                publish_stale_at_cycle_boundary(sender, &mut last);
            }
        }
    }
}

fn publish_stale_at_cycle_boundary(
    sender: &watch::Sender<Option<Result<VcsStatusSummary, GitCommandError>>>,
    last: &mut Option<VcsStatusSummary>,
) {
    let Some(last) = last else {
        return;
    };
    if !last.stale {
        last.stale = true;
        sender.send_replace(Some(Ok(last.clone())));
    }
}

#[cfg(test)]
fn arm_refresh_for_test(inner: &Inner) {
    inner.refresh_armed.notify_one();
}

#[cfg(not(test))]
fn arm_refresh_for_test(_inner: &Inner) {}

fn summary_publication(
    last: &mut Option<VcsStatusSummary>,
    result: Result<VcsStatusSummary, GitCommandError>,
) -> Result<VcsStatusSummary, GitCommandError> {
    match result {
        Ok(summary) => {
            *last = Some(summary.clone());
            Ok(summary)
        }
        Err(error) => last.clone().map_or(Err(error), |mut stale| {
            stale.stale = true;
            Ok(stale)
        }),
    }
}

fn summary_error(cwd: &Path, detail: &str) -> GitCommandError {
    GitCommandError {
        tag: "GitCommandError",
        operation: "GitVcsDriver.summaryStatus".into(),
        command: "git".into(),
        cwd: cwd.to_string_lossy().into_owned().into(),
        diagnostics: None,
        detail: detail.into(),
    }
}

fn summary_enrichment_input(summary: &VcsStatusSummary) -> Option<(String, GitProviderKind)> {
    let reference = summary.ref_name.clone()?;
    let provider = summary.source_control_provider.as_ref()?.kind;
    (provider != GitProviderKind::Unknown).then_some((reference, provider))
}

async fn load_pull_request(
    inner: &Inner,
    cwd: &Path,
    provider: GitProviderKind,
    reference: String,
    cancellation: &CancellationToken,
) -> Result<Option<crate::source_control::ResolvedPullRequest>, GitCommandError> {
    #[cfg(test)]
    let test_loader = {
        inner
            .pull_request_test_loader
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    };
    #[cfg(test)]
    if let Some(loader) = test_loader {
        return loader.load(cancellation).await;
    }
    inner
        .pull_requests
        .resolve_current_optional(
            ResolvePullRequestInput {
                cwd: cwd.to_path_buf(),
                provider: source_control_provider_kind(provider),
                reference,
            },
            cancellation,
        )
        .await
        .map_err(provider_summary_error)
}

fn provider_summary_error(error: SourceControlProviderError) -> GitCommandError {
    GitCommandError {
        tag: "GitCommandError",
        operation: error.operation,
        command: error.command.unwrap_or_else(|| "source-control".into()),
        cwd: error.cwd,
        diagnostics: None,
        detail: error.detail,
    }
}

fn apply_pull_request(
    summary: &mut VcsStatusSummary,
    pull_request: crate::source_control::ResolvedPullRequest,
) {
    let Some(reference) = summary.ref_name.as_deref() else {
        return;
    };
    let Some(provider) = summary.source_control_provider.as_ref() else {
        return;
    };
    if pull_request.head_branch != reference || pull_request.state != ChangeRequestState::Open {
        return;
    }
    summary.pr = Some(VcsSummaryChangeRequest {
        provider: provider.kind,
        number: pull_request.number,
        title: pull_request.title,
        url: pull_request.url,
        base_ref_name: pull_request.base_branch,
        head_ref_name: pull_request.head_branch,
        state: "open".to_owned(),
        updated_at: WireOption(None),
    });
}

fn source_control_provider_kind(provider: GitProviderKind) -> ProviderKind {
    match provider {
        GitProviderKind::Github => ProviderKind::Github,
        GitProviderKind::Gitlab => ProviderKind::Gitlab,
        GitProviderKind::AzureDevops => ProviderKind::AzureDevops,
        GitProviderKind::Bitbucket => ProviderKind::Bitbucket,
        GitProviderKind::Unknown => ProviderKind::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::PathBuf,
        sync::{
            Arc,
            atomic::{AtomicBool, AtomicUsize, Ordering},
        },
        time::Duration,
    };

    #[cfg(windows)]
    use std::ffi::OsString;

    use sysinfo::{Pid, ProcessesToUpdate, System};
    use tokio::sync::{Semaphore, SemaphorePermit, watch};
    use tokio_util::sync::CancellationToken;

    use super::{GitStatusSummaryService, apply_pull_request, summary_error, summary_publication};
    use crate::{
        git::{
            BoxGitProcessFuture, GitCommandError, GitProcessRunner, GitRepository, ProcessError,
            ProcessOutput, ProcessRequest, ProviderKind as GitProviderKind,
            SourceControlProviderInfo, VcsStatusSummary,
        },
        source_control::{ChangeRequestState, ProviderCommandSpec, PullRequestService},
        test_support::TestSandbox,
    };

    static SUMMARY_PROVIDER_PROCESS_PERMIT: Semaphore = Semaphore::const_new(1);

    async fn acquire_summary_provider_process_permit() -> SemaphorePermit<'static> {
        SUMMARY_PROVIDER_PROCESS_PERMIT
            .acquire()
            .await
            .expect("summary provider process permit remains open")
    }

    struct SummaryRunner {
        status_calls: AtomicUsize,
        fail_status: AtomicBool,
        fail_provider: AtomicBool,
        detached: AtomicBool,
        has_provider: AtomicBool,
        block_status: AtomicBool,
        cancelled_status_reads: AtomicUsize,
        status_started: tokio::sync::Notify,
    }

    impl SummaryRunner {
        fn new() -> Self {
            Self {
                status_calls: AtomicUsize::new(0),
                fail_status: AtomicBool::new(false),
                fail_provider: AtomicBool::new(false),
                detached: AtomicBool::new(false),
                has_provider: AtomicBool::new(false),
                block_status: AtomicBool::new(false),
                cancelled_status_reads: AtomicUsize::new(0),
                status_started: tokio::sync::Notify::new(),
            }
        }

        fn set_detached(&self) {
            self.detached.store(true, Ordering::Release);
        }

        fn set_provider(&self) {
            self.has_provider.store(true, Ordering::Release);
        }

        fn output(exit_code: i32, stdout: &str) -> ProcessOutput {
            ProcessOutput {
                exit_code,
                stdout: stdout.to_owned(),
                stderr: String::new(),
                stdout_truncated: false,
                stderr_truncated: false,
            }
        }

        fn failure(operation: &str) -> ProcessError {
            ProcessError::Timeout {
                operation: operation.to_owned(),
                timeout_ms: 30_000,
            }
        }
    }

    impl GitProcessRunner for SummaryRunner {
        fn run<'a>(
            &'a self,
            request: ProcessRequest,
            cancellation: &'a CancellationToken,
        ) -> BoxGitProcessFuture<'a> {
            Box::pin(async move {
                match request.operation.as_str() {
                    "GitVcsDriver.summaryStatus.status" => {
                        self.status_calls.fetch_add(1, Ordering::AcqRel);
                        if self.block_status.load(Ordering::Acquire) {
                            self.status_started.notify_one();
                            cancellation.cancelled().await;
                            self.cancelled_status_reads.fetch_add(1, Ordering::AcqRel);
                            return Err(ProcessError::Cancelled {
                                operation: request.operation,
                            });
                        }
                        if self.fail_status.load(Ordering::Acquire) {
                            return Err(Self::failure(&request.operation));
                        }
                        let stdout = if self.detached.load(Ordering::Acquire) {
                            "# branch.oid 0123456789abcdef0123456789abcdef01234567\n# branch.head (detached)\n"
                        } else {
                            "# branch.oid 0123456789abcdef0123456789abcdef01234567\n# branch.head feature/test\n? untracked.txt\n"
                        };
                        self.status_started.notify_one();
                        Ok(Self::output(0, stdout))
                    }
                    "GitVcsDriver.remoteProvider" => {
                        if self.fail_provider.load(Ordering::Acquire) {
                            return Err(Self::failure(&request.operation));
                        }
                        Ok(if self.has_provider.load(Ordering::Acquire) {
                            Self::output(0, "https://github.com/acme/repository.git\n")
                        } else {
                            Self::output(1, "")
                        })
                    }
                    operation => panic!("unexpected summary operation {operation}"),
                }
            })
        }
    }

    async fn wait_for_calls(runner: &SummaryRunner, expected: usize) {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if runner.status_calls.load(Ordering::Acquire) >= expected {
                    return;
                }
                runner.status_started.notified().await;
            }
        })
        .await
        .unwrap_or_else(|_| {
            panic!(
                "summary read-start {expected} deadline at {} calls",
                runner.status_calls.load(Ordering::Acquire)
            )
        });
    }

    async fn wait_for_change(
        receiver: &mut watch::Receiver<Option<Result<VcsStatusSummary, GitCommandError>>>,
        label: &str,
    ) {
        tokio::time::timeout(Duration::from_secs(5), receiver.changed())
            .await
            .unwrap_or_else(|_| panic!("{label} deadline"))
            .expect("summary producer remains open");
    }

    async fn next_summary(
        receiver: &mut watch::Receiver<Option<Result<VcsStatusSummary, GitCommandError>>>,
    ) -> VcsStatusSummary {
        if receiver.borrow().is_none() {
            wait_for_change(receiver, "initial summary publication").await;
        }
        receiver
            .borrow_and_update()
            .clone()
            .expect("summary publication")
            .expect("summary succeeds")
    }

    async fn wait_for_summary(
        receiver: &mut watch::Receiver<Option<Result<VcsStatusSummary, GitCommandError>>>,
        label: &str,
        predicate: impl Fn(&VcsStatusSummary) -> bool,
    ) -> VcsStatusSummary {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let Some(Ok(summary)) = receiver.borrow_and_update().as_ref()
                    && predicate(summary)
                {
                    return summary.clone();
                }
                receiver
                    .changed()
                    .await
                    .expect("summary producer remains open");
            }
        })
        .await
        .unwrap_or_else(|_| panic!("{label} deadline"))
    }

    fn provider_command_fixture(
        sandbox: &TestSandbox,
        name: &str,
        unix_contents: &str,
        windows_contents: &str,
    ) -> ProviderCommandSpec {
        let script = sandbox.executable_script(name, unix_contents, windows_contents);
        #[cfg(unix)]
        {
            ProviderCommandSpec::new("/bin/sh", [script.into_os_string()])
        }
        #[cfg(windows)]
        {
            ProviderCommandSpec::new(
                std::env::var_os("ComSpec").unwrap_or_else(|| "cmd.exe".into()),
                [
                    OsString::from("/D"),
                    OsString::from("/C"),
                    script.into_os_string(),
                ],
            )
        }
    }

    async fn wait_for_pid_file(path: &std::path::Path) -> u32 {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let Ok(value) = tokio::fs::read_to_string(path).await
                    && let Ok(pid) = value.trim().parse()
                {
                    return pid;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("provider PID marker deadline")
    }

    fn process_exists(pid: u32) -> bool {
        let pid = Pid::from_u32(pid);
        let mut system = System::new();
        system.refresh_processes(ProcessesToUpdate::Some(&[pid]), true);
        system.process(pid).is_some()
    }

    async fn wait_for_process_exit(pid: u32) {
        tokio::time::timeout(Duration::from_secs(5), async {
            while process_exists(pid) {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("provider child exit deadline");
    }

    #[tokio::test(start_paused = true)]
    async fn shares_one_latest_value_producer_per_cwd_and_refreshes_at_thirty_seconds() {
        let sandbox = TestSandbox::new("summary-sharing");
        let cwd = sandbox.path("repo");
        fs::create_dir(&cwd).expect("summary cwd");
        let alias = cwd.join("..").join("repo");
        let runner = Arc::new(SummaryRunner::new());
        let service = GitStatusSummaryService::with_dependencies(
            Arc::new(GitRepository::with_runner_for_test(runner.clone())),
            PullRequestService::default(),
            Duration::from_secs(30),
        );
        let mut first = service
            .subscribe(cwd.clone())
            .await
            .expect("first subscription");
        let mut second = service.subscribe(alias).await.expect("alias subscription");

        wait_for_calls(&runner, 1).await;
        assert_eq!(
            next_summary(&mut first).await,
            next_summary(&mut second).await
        );
        assert_eq!(service.active_cwd_count_for_test(), 1);
        service.wait_for_refresh_armed_for_test().await;

        tokio::time::advance(Duration::from_secs(29)).await;
        assert_eq!(runner.status_calls.load(Ordering::Acquire), 1);
        tokio::time::advance(Duration::from_secs(1)).await;
        wait_for_calls(&runner, 2).await;
        wait_for_change(&mut first, "thirty-second publication").await;
        assert!(!next_summary(&mut first).await.stale);

        drop(first);
        assert_eq!(service.active_cwd_count_for_test(), 1);
        drop(second);
        service.wait_for_active_cwd_count_for_test(0).await;

        let mut reconnected = service
            .subscribe(cwd)
            .await
            .expect("reconnected subscription");
        wait_for_calls(&runner, 3).await;
        assert!(!next_summary(&mut reconnected).await.stale);
    }

    #[tokio::test(start_paused = true)]
    async fn completed_pr_is_carried_only_into_the_next_cycle_base() {
        let sandbox = TestSandbox::new("summary-cycle-retained-pr");
        let cwd = sandbox.path("repo");
        fs::create_dir(&cwd).expect("summary cwd");
        let runner = Arc::new(SummaryRunner::new());
        runner.set_provider();
        let service = GitStatusSummaryService::with_dependencies(
            Arc::new(GitRepository::with_runner_for_test(runner.clone())),
            PullRequestService::default(),
            Duration::from_secs(30),
        );
        let loader =
            service.install_pull_request_test_loader(crate::source_control::ResolvedPullRequest {
                number: 42,
                title: "Summary PR".to_owned(),
                url: "https://github.com/acme/repository/pull/42".to_owned(),
                base_branch: "main".to_owned(),
                head_branch: "feature/test".to_owned(),
                state: ChangeRequestState::Open,
            });
        let mut receiver = service.subscribe(cwd).await.expect("summary subscription");

        let first = wait_for_summary(&mut receiver, "cycle zero enrichment", |summary| {
            !summary.stale && summary.pr.is_some()
        })
        .await;
        loader.wait_for_calls(1).await;
        let first_observed_at = first.observed_at.clone();
        let first_pr = first.pr.clone();

        tokio::time::advance(Duration::from_secs(30)).await;
        wait_for_calls(&runner, 2).await;
        loader.wait_for_calls(2).await;
        let carried = wait_for_summary(&mut receiver, "cycle one carried base", |summary| {
            summary.stale && summary.pr.is_some()
        })
        .await;
        assert_eq!(carried.pr, first_pr);
        assert_eq!(carried.observed_at, first_observed_at);

        tokio::time::advance(Duration::from_secs(30)).await;
        wait_for_calls(&runner, 3).await;
        loader.wait_for_calls(3).await;
        let expired = wait_for_summary(&mut receiver, "cycle two fresh base", |summary| {
            !summary.stale && summary.pr.is_none()
        })
        .await;
        assert!(expired.pr.is_none());
        assert_ne!(expired.observed_at, first_observed_at);

        drop(receiver);
        service.wait_for_active_cwd_count_for_test(0).await;
    }

    #[test]
    fn retains_the_last_summary_as_stale_on_git_or_provider_failure() {
        let initial = VcsStatusSummary {
            is_repo: true,
            ref_name: Some("feature/test".to_owned()),
            detached_head: None,
            has_working_tree_changes: true,
            source_control_provider: None,
            pr: None,
            observed_at: "2026-08-20T12:00:00Z".to_owned(),
            stale: false,
        };
        let mut last = None;
        assert_eq!(
            summary_publication(&mut last, Ok(initial.clone())).expect("initial summary"),
            initial
        );

        for detail in ["Git status failed", "provider discovery failed"] {
            let stale = summary_publication(
                &mut last,
                Err(summary_error(PathBuf::from("/repo").as_path(), detail)),
            )
            .expect("last summary remains available");
            assert!(stale.stale);
            assert_eq!(stale.observed_at, initial.observed_at);
            assert_eq!(stale.ref_name, initial.ref_name);
        }
    }

    #[tokio::test]
    async fn final_subscriber_cancels_and_awaits_the_in_flight_read_before_removal() {
        let runner = Arc::new(SummaryRunner::new());
        runner.block_status.store(true, Ordering::Release);
        let service = GitStatusSummaryService::with_dependencies(
            Arc::new(GitRepository::with_runner_for_test(runner.clone())),
            PullRequestService::default(),
            Duration::from_secs(30),
        );
        let receiver = service
            .subscribe(PathBuf::from("/repo"))
            .await
            .expect("summary subscription");
        tokio::time::timeout(Duration::from_secs(5), runner.status_started.notified())
            .await
            .expect("blocked summary read-start deadline");

        drop(receiver);
        service.wait_for_active_cwd_count_for_test(0).await;

        assert_eq!(runner.cancelled_status_reads.load(Ordering::Acquire), 1);
    }

    #[tokio::test]
    async fn initial_read_failure_is_an_error_not_a_clean_summary() {
        let runner = Arc::new(SummaryRunner::new());
        runner.fail_status.store(true, Ordering::Release);
        let service = GitStatusSummaryService::with_dependencies(
            Arc::new(GitRepository::with_runner_for_test(runner)),
            PullRequestService::default(),
            Duration::from_secs(30),
        );
        let mut receiver = service
            .subscribe(PathBuf::from("/repo"))
            .await
            .expect("summary subscription");

        wait_for_change(&mut receiver, "initial failure publication").await;
        assert!(
            receiver
                .borrow_and_update()
                .as_ref()
                .expect("publication")
                .is_err()
        );
    }

    #[tokio::test]
    async fn initial_provider_config_failure_is_an_error_not_provider_absence() {
        let runner = Arc::new(SummaryRunner::new());
        runner.fail_provider.store(true, Ordering::Release);
        let service = GitStatusSummaryService::with_dependencies(
            Arc::new(GitRepository::with_runner_for_test(runner)),
            PullRequestService::default(),
            Duration::from_secs(30),
        );
        let mut receiver = service
            .subscribe(PathBuf::from("/repo"))
            .await
            .expect("summary subscription");

        wait_for_change(&mut receiver, "initial provider failure publication").await;
        let error = receiver
            .borrow_and_update()
            .clone()
            .expect("provider failure publication")
            .expect_err("provider config failure must not become a clean summary");
        assert_eq!(error.operation.as_ref(), "GitVcsDriver.remoteProvider");
    }

    #[tokio::test(start_paused = true)]
    async fn provider_config_failure_retains_exact_stale_value_then_recovers_fresh() {
        let runner = Arc::new(SummaryRunner::new());
        let service = GitStatusSummaryService::with_dependencies(
            Arc::new(GitRepository::with_runner_for_test(runner.clone())),
            PullRequestService::default(),
            Duration::from_secs(30),
        );
        let mut receiver = service
            .subscribe(PathBuf::from("/repo"))
            .await
            .expect("summary subscription");
        let initial = next_summary(&mut receiver).await;
        service.wait_for_refresh_armed_for_test().await;

        runner.fail_provider.store(true, Ordering::Release);
        tokio::time::advance(Duration::from_secs(30)).await;
        wait_for_calls(&runner, 2).await;
        wait_for_change(&mut receiver, "stale provider-config publication").await;
        let stale = next_summary(&mut receiver).await;
        assert_eq!(stale.observed_at, initial.observed_at);
        assert_eq!(stale.ref_name, initial.ref_name);
        assert_eq!(
            stale.source_control_provider,
            initial.source_control_provider
        );
        assert_eq!(stale.pr, initial.pr);
        assert!(stale.stale);
        service.wait_for_refresh_armed_for_test().await;

        runner.fail_provider.store(false, Ordering::Release);
        tokio::time::advance(Duration::from_secs(30)).await;
        wait_for_calls(&runner, 3).await;
        wait_for_change(&mut receiver, "provider-config recovery publication").await;
        let recovered = next_summary(&mut receiver).await;
        assert!(!recovered.stale);
        assert!(recovered.source_control_provider.is_none());
        assert!(recovered.pr.is_none());
    }

    #[tokio::test]
    async fn enriches_pr_only_for_the_matching_named_branch() {
        let _provider_process_permit = acquire_summary_provider_process_permit().await;
        let sandbox = TestSandbox::new("summary-pr");
        let marker = sandbox.path("pr-called.txt");
        let json = r#"[{"number":42,"title":"Summary PR","url":"https://github.com/acme/repository/pull/42","baseRefName":"main","headRefName":"feature/test","state":"OPEN"}]"#;
        let command = provider_command_fixture(
            &sandbox,
            "summary-pr",
            &format!(
                "printf 'called\\n' >> '{}'; printf '%s\\n' '{}'",
                marker.display(),
                json
            ),
            &format!(
                "@echo off\necho called>>\"{}\"\necho {}",
                marker.display(),
                json
            ),
        );
        let runner = Arc::new(SummaryRunner::new());
        runner.set_provider();
        let service = GitStatusSummaryService::with_dependencies(
            Arc::new(GitRepository::with_runner_for_test(runner.clone())),
            PullRequestService::with_provider_command_specs_for_test(
                command.clone(),
                command.clone(),
                command,
            ),
            Duration::from_secs(2),
        );
        let mut receiver = service
            .subscribe(sandbox.root().to_path_buf())
            .await
            .expect("PR summary subscription");

        let base = next_summary(&mut receiver).await;
        assert!(
            base.pr.is_none(),
            "base Git state publishes before PR lookup"
        );
        let named = wait_for_summary(&mut receiver, "named PR enrichment", |summary| {
            summary.pr.is_some()
        })
        .await;
        let pr = named.pr.expect("named branch PR");
        assert_eq!(pr.number, 42);
        assert_eq!(pr.head_ref_name, "feature/test");
        assert_eq!(
            fs::read_to_string(&marker)
                .expect("PR marker")
                .lines()
                .collect::<Vec<_>>(),
            ["called"]
        );

        runner.set_detached();
        service.wait_for_refresh_armed_for_test().await;
        wait_for_calls(&runner, 2).await;
        let detached = wait_for_summary(&mut receiver, "detached publication", |summary| {
            !summary.stale && summary.ref_name.is_none() && summary.pr.is_none()
        })
        .await;
        assert!(detached.pr.is_none());
        assert_eq!(
            fs::read_to_string(marker)
                .expect("PR marker")
                .lines()
                .collect::<Vec<_>>(),
            ["called"]
        );
    }

    #[tokio::test]
    async fn delayed_pr_enrichment_cannot_delay_the_base_or_next_cycle() {
        let _provider_process_permit = acquire_summary_provider_process_permit().await;
        let sandbox = TestSandbox::new("summary-delayed-pr");
        let pid_path = sandbox.path("provider.pid");
        let command = provider_command_fixture(
            &sandbox,
            "summary-delayed-pr",
            &format!(
                "printf '%s' \"$$\" > '{}'; while :; do sleep 1; done",
                pid_path.display()
            ),
            &format!(
                "@echo off\r\npowershell.exe -NoProfile -Command \"Set-Content -NoNewline -LiteralPath '{}' -Value $PID; Start-Sleep -Seconds 30\"\r\n",
                pid_path.display()
            ),
        );
        let runner = Arc::new(SummaryRunner::new());
        runner.set_provider();
        let service = GitStatusSummaryService::with_dependencies(
            Arc::new(GitRepository::with_runner_for_test(runner.clone())),
            PullRequestService::with_provider_command_specs_for_test(
                command.clone(),
                command.clone(),
                command,
            ),
            Duration::from_secs(4),
        );
        let mut receiver = service
            .subscribe(sandbox.root().to_path_buf())
            .await
            .expect("delayed PR subscription");

        let first = next_summary(&mut receiver).await;
        assert!(!first.stale);
        assert!(first.pr.is_none());
        let first_observed_at = first.observed_at;
        let first_child = wait_for_pid_file(&pid_path).await;
        wait_for_calls(&runner, 2).await;
        let second = wait_for_summary(&mut receiver, "next base observation", |summary| {
            !summary.stale && summary.observed_at != first_observed_at
        })
        .await;
        assert_ne!(second.observed_at, first_observed_at);
        wait_for_process_exit(first_child).await;

        drop(receiver);
        service.wait_for_active_cwd_count_for_test(0).await;
    }

    #[tokio::test]
    async fn provider_child_error_retains_pr_then_successful_absence_clears_it() {
        let _provider_process_permit = acquire_summary_provider_process_permit().await;
        let sandbox = TestSandbox::new("summary-pr-recovery");
        let state = sandbox.path("provider-state.txt");
        fs::write(&state, "valid").expect("provider state");
        let json = r#"[{"number":42,"title":"Summary PR","url":"https://github.com/acme/repository/pull/42","baseRefName":"main","headRefName":"feature/test","state":"OPEN"}]"#;
        let command = provider_command_fixture(
            &sandbox,
            "summary-pr-recovery",
            &format!(
                "case \"$(cat '{}')\" in error) exit 7;; none) printf '%s\\n' '[]';; *) printf '%s\\n' '{}';; esac",
                state.display(),
                json
            ),
            &format!(
                "@echo off\r\nset /p STATE=<\"{}\"\r\nif \"%STATE%\"==\"error\" exit /b 7\r\nif \"%STATE%\"==\"none\" (\r\n  echo []\r\n  exit /b 0\r\n)\r\necho {}\r\n",
                state.display(),
                json
            ),
        );
        let runner = Arc::new(SummaryRunner::new());
        runner.set_provider();
        let service = GitStatusSummaryService::with_dependencies(
            Arc::new(GitRepository::with_runner_for_test(runner.clone())),
            PullRequestService::with_provider_command_specs_for_test(
                command.clone(),
                command.clone(),
                command,
            ),
            Duration::from_secs(2),
        );
        let mut receiver = service
            .subscribe(sandbox.root().to_path_buf())
            .await
            .expect("PR recovery subscription");
        let initial = wait_for_summary(&mut receiver, "initial PR enrichment", |summary| {
            summary.pr.is_some()
        })
        .await;
        assert_eq!(initial.pr.as_ref().map(|pr| pr.number), Some(42));
        service.wait_for_refresh_armed_for_test().await;

        fs::write(&state, "error").expect("provider error state");
        wait_for_calls(&runner, 2).await;
        let stale = wait_for_summary(&mut receiver, "stale PR publication", |summary| {
            summary.stale && summary.pr.is_some()
        })
        .await;
        assert!(stale.stale);
        assert_eq!(stale.observed_at, initial.observed_at);
        assert_eq!(stale.pr, initial.pr);
        service.wait_for_refresh_armed_for_test().await;

        fs::write(&state, "none").expect("provider absence state");
        wait_for_calls(&runner, 3).await;
        let recovered = wait_for_summary(&mut receiver, "PR recovery publication", |summary| {
            !summary.stale && summary.pr.is_none()
        })
        .await;
        assert!(!recovered.stale);
        assert!(recovered.pr.is_none());
    }

    #[tokio::test]
    async fn final_subscriber_cancels_and_awaits_a_real_provider_child_tree() {
        let _provider_process_permit = acquire_summary_provider_process_permit().await;
        let sandbox = TestSandbox::new("summary-provider-cancellation");
        let pid_path = sandbox.path("provider.pid");
        let command = provider_command_fixture(
            &sandbox,
            "summary-provider-blocked",
            &format!(
                "printf '%s' \"$$\" > '{}'; while :; do sleep 1; done",
                pid_path.display()
            ),
            &format!(
                "@echo off\r\npowershell.exe -NoProfile -Command \"Set-Content -NoNewline -LiteralPath '{}' -Value $PID; Start-Sleep -Seconds 30\"\r\n",
                pid_path.display()
            ),
        );
        let runner = Arc::new(SummaryRunner::new());
        runner.set_provider();
        let service = GitStatusSummaryService::with_dependencies(
            Arc::new(GitRepository::with_runner_for_test(runner)),
            PullRequestService::with_provider_command_specs_for_test(
                command.clone(),
                command.clone(),
                command,
            ),
            Duration::from_secs(30),
        );
        let receiver = service
            .subscribe(sandbox.root().to_path_buf())
            .await
            .expect("blocked provider subscription");
        let child_pid = wait_for_pid_file(&pid_path).await;
        assert!(process_exists(child_pid));

        drop(receiver);
        service.wait_for_active_cwd_count_for_test(0).await;
        wait_for_process_exit(child_pid).await;
    }

    #[test]
    fn attaches_only_an_open_pr_for_the_matching_named_branch() {
        let provider = SourceControlProviderInfo {
            kind: GitProviderKind::Github,
            name: "GitHub".to_owned(),
            base_url: "https://github.com".to_owned(),
        };
        let pull_request = || crate::source_control::ResolvedPullRequest {
            number: 42,
            title: "Summary PR".to_owned(),
            url: "https://github.com/acme/repository/pull/42".to_owned(),
            base_branch: "main".to_owned(),
            head_branch: "feature/test".to_owned(),
            state: ChangeRequestState::Open,
        };
        let mut named = VcsStatusSummary {
            is_repo: true,
            ref_name: Some("feature/test".to_owned()),
            detached_head: None,
            has_working_tree_changes: false,
            source_control_provider: Some(provider.clone()),
            pr: None,
            observed_at: "2026-08-20T12:00:00Z".to_owned(),
            stale: false,
        };
        apply_pull_request(&mut named, pull_request());
        assert_eq!(named.pr.as_ref().map(|pr| pr.number), Some(42));

        let mut detached = VcsStatusSummary {
            ref_name: None,
            detached_head: Some("0123456789abcdef0123456789abcdef01234567".to_owned()),
            source_control_provider: Some(provider),
            pr: None,
            ..named
        };
        apply_pull_request(&mut detached, pull_request());
        assert!(detached.pr.is_none());
    }
}
