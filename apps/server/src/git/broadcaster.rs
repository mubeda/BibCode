use std::{
    collections::HashMap,
    future::pending,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
    time::Duration,
};

use tokio::{
    sync::{mpsc, watch},
    time::Instant,
};
use tokio_util::sync::CancellationToken;

use super::{
    GitCommandError, GitRepository, VcsStatusLocalResult, VcsStatusRemoteResult, VcsStatusResult,
    VcsStatusStreamEvent,
};

#[derive(Clone)]
pub struct StatusBroadcaster {
    inner: Arc<Inner>,
}

struct Inner {
    repository: Arc<GitRepository>,
    ref_refresh_interval: Duration,
    local_status_refresh_interval: Duration,
    automatic_remote_refresh_interval: watch::Sender<Duration>,
    subscriber_capacity: usize,
    state: Mutex<State>,
}

const REMOTE_FAILURE_BACKOFF_INITIAL: Duration = Duration::from_secs(30);
const REMOTE_FAILURE_BACKOFF_MAX: Duration = Duration::from_secs(15 * 60);

#[derive(Default)]
struct State {
    next_subscriber_id: u64,
    repositories: HashMap<PathBuf, RepositoryState>,
}

struct RepositoryState {
    local: VcsStatusLocalResult,
    remote: Option<Option<VcsStatusRemoteResult>>,
    subscribers: HashMap<u64, mpsc::Sender<VcsStatusStreamEvent>>,
    local_refresh_requests: watch::Sender<u64>,
    poller_cancellation: CancellationToken,
}

pub struct StatusSubscription {
    receiver: mpsc::Receiver<VcsStatusStreamEvent>,
    cancellation: CancellationToken,
    broadcaster: StatusBroadcaster,
    cwd: PathBuf,
    subscriber_id: u64,
}

impl StatusBroadcaster {
    #[must_use]
    pub fn new(
        repository: Arc<GitRepository>,
        refresh_interval: Duration,
        subscriber_capacity: usize,
    ) -> Self {
        Self::with_refresh_intervals(
            repository,
            refresh_interval,
            refresh_interval,
            subscriber_capacity,
        )
    }

    #[must_use]
    pub fn with_refresh_intervals(
        repository: Arc<GitRepository>,
        ref_refresh_interval: Duration,
        status_refresh_interval: Duration,
        subscriber_capacity: usize,
    ) -> Self {
        let (automatic_remote_refresh_interval, _) = watch::channel(status_refresh_interval);
        Self::with_automatic_remote_refresh_interval(
            repository,
            ref_refresh_interval,
            status_refresh_interval,
            automatic_remote_refresh_interval,
            subscriber_capacity,
        )
    }

    #[must_use]
    pub fn with_automatic_remote_refresh_interval(
        repository: Arc<GitRepository>,
        ref_refresh_interval: Duration,
        local_status_refresh_interval: Duration,
        automatic_remote_refresh_interval: watch::Sender<Duration>,
        subscriber_capacity: usize,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                repository,
                ref_refresh_interval,
                local_status_refresh_interval,
                automatic_remote_refresh_interval,
                subscriber_capacity: subscriber_capacity.max(1),
                state: Mutex::new(State::default()),
            }),
        }
    }

    pub async fn subscribe(
        &self,
        cwd: PathBuf,
        cancellation: CancellationToken,
    ) -> Result<StatusSubscription, GitCommandError> {
        let cwd = tokio::fs::canonicalize(&cwd).await.unwrap_or(cwd);
        let local = self
            .inner
            .repository
            .local_status(&cwd, &cancellation)
            .await?;
        let (sender, receiver) = mpsc::channel(self.inner.subscriber_capacity);

        let (subscriber_id, start_poller, poller_cancellation, local_refresh_requests) = {
            let mut state = self.lock_state();
            let subscriber_id = state.next_subscriber_id;
            state.next_subscriber_id = state.next_subscriber_id.wrapping_add(1);
            let start_poller = !state.repositories.contains_key(&cwd);
            let entry = state.repositories.entry(cwd.clone()).or_insert_with(|| {
                let (local_refresh_requests, _) = watch::channel(0);
                RepositoryState {
                    local: local.clone(),
                    remote: None,
                    subscribers: HashMap::new(),
                    local_refresh_requests,
                    poller_cancellation: CancellationToken::new(),
                }
            });
            entry.subscribers.insert(subscriber_id, sender);
            let initial_remote = entry.remote.clone().flatten();
            entry
                .subscribers
                .get(&subscriber_id)
                .expect("subscriber was just registered")
                .try_send(VcsStatusStreamEvent::Snapshot {
                    local,
                    remote: initial_remote.clone(),
                })
                .expect("new bounded subscription has capacity for its snapshot");
            (
                subscriber_id,
                start_poller,
                entry.poller_cancellation.clone(),
                entry.local_refresh_requests.subscribe(),
            )
        };
        if start_poller {
            self.spawn_local_status_poller(
                cwd.clone(),
                poller_cancellation.clone(),
                local_refresh_requests,
            );
            self.spawn_remote_and_ref_poller(cwd.clone(), poller_cancellation);
        }
        Ok(StatusSubscription {
            receiver,
            cancellation,
            broadcaster: self.clone(),
            cwd,
            subscriber_id,
        })
    }

    pub async fn refresh_local(
        &self,
        cwd: &Path,
        cancellation: &CancellationToken,
    ) -> Result<VcsStatusLocalResult, GitCommandError> {
        let cwd = tokio::fs::canonicalize(cwd)
            .await
            .unwrap_or_else(|_| cwd.to_path_buf());
        let local = self
            .inner
            .repository
            .local_status(&cwd, cancellation)
            .await?;
        let event = VcsStatusStreamEvent::LocalUpdated {
            local: local.clone(),
        };
        let mut state = self.lock_state();
        let mut remove_repository = false;
        if let Some(entry) = state.repositories.get_mut(&cwd)
            && entry.local != local
        {
            entry.local = local.clone();
            publish(entry, event);
            remove_repository = entry.subscribers.is_empty();
        }
        if remove_repository && let Some(entry) = state.repositories.remove(&cwd) {
            entry.poller_cancellation.cancel();
        }
        Ok(local)
    }

    pub async fn notify_local_change(&self, cwd: &Path) {
        let cwd = tokio::fs::canonicalize(cwd)
            .await
            .unwrap_or_else(|_| cwd.to_path_buf());
        let mut state = self.lock_state();
        if let Some(entry) = state.repositories.get_mut(&cwd) {
            entry
                .local_refresh_requests
                .send_modify(|generation| *generation = generation.wrapping_add(1));
        }
    }

    async fn refresh_ref(
        &self,
        cwd: &Path,
        cancellation: &CancellationToken,
    ) -> Result<(), GitCommandError> {
        let cwd = tokio::fs::canonicalize(cwd)
            .await
            .unwrap_or_else(|_| cwd.to_path_buf());
        let ref_name = self
            .inner
            .repository
            .current_ref(&cwd, cancellation)
            .await?;
        let mut state = self.lock_state();
        if let Some(entry) = state.repositories.get_mut(&cwd)
            && entry.local.ref_name != ref_name
        {
            entry.local.ref_name = ref_name;
            entry.local.is_default_ref = entry.local.ref_name.is_some()
                && entry.local.ref_name == entry.local.default_ref_name;
            publish(
                entry,
                VcsStatusStreamEvent::LocalUpdated {
                    local: entry.local.clone(),
                },
            );
        }
        Ok(())
    }

    async fn refresh_remote(
        &self,
        cwd: &Path,
        cancellation: &CancellationToken,
        fetch: bool,
    ) -> Result<(), GitCommandError> {
        let remote = if fetch {
            self.inner
                .repository
                .refresh_remote_status(cwd, cancellation)
                .await?
        } else {
            self.inner
                .repository
                .remote_status(cwd, cancellation)
                .await?
        };
        let mut state = self.lock_state();
        let Some(entry) = state.repositories.get_mut(cwd) else {
            return Ok(());
        };
        if entry.remote.as_ref() != Some(&remote) {
            entry.remote = Some(remote.clone());
            publish(entry, VcsStatusStreamEvent::RemoteUpdated { remote });
        }
        if entry.subscribers.is_empty()
            && let Some(entry) = state.repositories.remove(cwd)
        {
            entry.poller_cancellation.cancel();
        }
        Ok(())
    }

    pub async fn refresh_status(
        &self,
        cwd: &Path,
        cancellation: &CancellationToken,
    ) -> Result<VcsStatusResult, GitCommandError> {
        let cwd = tokio::fs::canonicalize(cwd)
            .await
            .unwrap_or_else(|_| cwd.to_path_buf());
        let status = self.inner.repository.status(&cwd, cancellation).await?;
        let remote = status.local.is_repo.then(|| status.remote.clone());
        let event = VcsStatusStreamEvent::Snapshot {
            local: status.local.clone(),
            remote: remote.clone(),
        };
        let mut state = self.lock_state();
        let mut remove_repository = false;
        if let Some(entry) = state.repositories.get_mut(&cwd)
            && (entry.local != status.local || entry.remote.as_ref() != Some(&remote))
        {
            entry.local = status.local.clone();
            entry.remote = Some(remote);
            publish(entry, event);
            remove_repository = entry.subscribers.is_empty();
        }
        if remove_repository && let Some(entry) = state.repositories.remove(&cwd) {
            entry.poller_cancellation.cancel();
        }
        Ok(status)
    }

    #[must_use]
    /// Returns the number of repository polling owners, each of which owns the
    /// local-status and remote/ref worker lifecycles.
    pub fn active_poller_count(&self) -> usize {
        self.lock_state().repositories.len()
    }

    fn spawn_local_status_poller(
        &self,
        cwd: PathBuf,
        cancellation: CancellationToken,
        mut local_refresh_requests: watch::Receiver<u64>,
    ) {
        let broadcaster = self.clone();
        tokio::spawn(async move {
            let local_refresh_interval = broadcaster.inner.local_status_refresh_interval;
            let mut local_status_interval = tokio::time::interval_at(
                Instant::now() + local_refresh_interval,
                local_refresh_interval,
            );
            local_status_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                tokio::select! {
                    _ = cancellation.cancelled() => break,
                    changed = local_refresh_requests.changed() => {
                        if changed.is_err() {
                            break;
                        }
                        local_refresh_requests.borrow_and_update();
                        let _ = broadcaster.refresh_local(&cwd, &cancellation).await;
                    }
                    _ = local_status_interval.tick() => {
                        let _ = broadcaster.refresh_local(&cwd, &cancellation).await;
                    }
                }
            }
        });
    }

    fn spawn_remote_and_ref_poller(&self, cwd: PathBuf, cancellation: CancellationToken) {
        let broadcaster = self.clone();
        tokio::spawn(async move {
            let mut ref_interval = tokio::time::interval(broadcaster.inner.ref_refresh_interval);
            ref_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            let mut automatic_remote_refresh_interval = broadcaster
                .inner
                .automatic_remote_refresh_interval
                .subscribe();
            let configured_interval = *automatic_remote_refresh_interval.borrow_and_update();
            let mut next_remote_fetch =
                (!configured_interval.is_zero()).then(|| Instant::now() + configured_interval);
            let mut failure_backoff = Duration::ZERO;
            let _ = broadcaster.refresh_remote(&cwd, &cancellation, false).await;
            loop {
                tokio::select! {
                    _ = cancellation.cancelled() => break,
                    changed = automatic_remote_refresh_interval.changed() => {
                        if changed.is_err() {
                            break;
                        }
                        failure_backoff = Duration::ZERO;
                        let interval = *automatic_remote_refresh_interval.borrow_and_update();
                        next_remote_fetch = (!interval.is_zero())
                            .then(|| Instant::now() + interval);
                    }
                    _ = wait_for_deadline(next_remote_fetch) => {
                        if broadcaster.refresh_remote(&cwd, &cancellation, true).await.is_ok() {
                            failure_backoff = Duration::ZERO;
                        } else {
                            failure_backoff = next_remote_failure_backoff(failure_backoff);
                        }
                        let interval = *automatic_remote_refresh_interval.borrow();
                        next_remote_fetch = (!interval.is_zero()).then(|| {
                            Instant::now() + interval.max(failure_backoff)
                        });
                    }
                    _ = ref_interval.tick() => {
                        let _ = broadcaster.refresh_ref(&cwd, &cancellation).await;
                    }
                }
            }
        });
    }

    fn release(&self, cwd: &Path, subscriber_id: u64) {
        let mut state = self.lock_state();
        let should_remove = if let Some(entry) = state.repositories.get_mut(cwd) {
            entry.subscribers.remove(&subscriber_id);
            entry.subscribers.is_empty()
        } else {
            false
        };
        if should_remove && let Some(entry) = state.repositories.remove(cwd) {
            entry.poller_cancellation.cancel();
        }
    }

    fn lock_state(&self) -> MutexGuard<'_, State> {
        self.inner
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

async fn wait_for_deadline(deadline: Option<Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(deadline).await,
        None => pending().await,
    }
}

fn next_remote_failure_backoff(current: Duration) -> Duration {
    if current.is_zero() {
        REMOTE_FAILURE_BACKOFF_INITIAL
    } else {
        current.saturating_mul(2).min(REMOTE_FAILURE_BACKOFF_MAX)
    }
}

impl StatusSubscription {
    pub async fn recv(&mut self) -> Option<VcsStatusStreamEvent> {
        tokio::select! {
            _ = self.cancellation.cancelled() => None,
            event = self.receiver.recv() => event,
        }
    }
}

impl Drop for StatusSubscription {
    fn drop(&mut self) {
        self.broadcaster.release(&self.cwd, self.subscriber_id);
    }
}

fn publish(entry: &mut RepositoryState, event: VcsStatusStreamEvent) {
    entry
        .subscribers
        .retain(|_, subscriber| match subscriber.try_send(event.clone()) {
            Ok(()) => true,
            Err(mpsc::error::TrySendError::Full(_)) => false,
            Err(mpsc::error::TrySendError::Closed(_)) => false,
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::{
        BoxGitProcessFuture, GitProcessRunner, ProcessError, ProcessOutput, ProcessRequest,
        ProcessRunner,
    };
    use crate::test_support::TestSandbox;
    use std::{collections::BTreeMap, ffi::OsString, fs, process::Command};
    use tokio::sync::{Semaphore, mpsc};

    struct BlockingRemoteGitRunner {
        command: PathBuf,
        environment: Vec<(OsString, OsString)>,
        expected_git_config: PathBuf,
        remote_started: mpsc::UnboundedSender<()>,
        remote_cancelled: mpsc::UnboundedSender<()>,
        local_status_started: mpsc::UnboundedSender<()>,
        release_remote: Arc<Semaphore>,
    }

    impl GitProcessRunner for BlockingRemoteGitRunner {
        fn run<'a>(
            &'a self,
            mut request: ProcessRequest,
            cancellation: &'a CancellationToken,
        ) -> BoxGitProcessFuture<'a> {
            request.command.clone_from(&self.command);
            let mut environment = self.environment.iter().cloned().collect::<BTreeMap<_, _>>();
            environment.extend(request.env);
            request.env = environment.into_iter().collect();
            assert!(
                request.env.iter().any(|(name, value)| {
                    name == "GIT_CONFIG_GLOBAL" && value == self.expected_git_config.as_os_str()
                }),
                "production Git request did not receive the test-owned global config"
            );
            assert!(request.env.iter().all(|(name, _)| {
                !matches!(
                    name.to_string_lossy().to_ascii_uppercase().as_str(),
                    "GIT_DIR" | "GIT_WORK_TREE" | "GIT_INDEX_FILE" | "GIT_CONFIG_SYSTEM"
                )
            }));
            Box::pin(async move {
                let output = |exit_code: i32, stdout: String| ProcessOutput {
                    exit_code,
                    stdout,
                    stderr: String::new(),
                    stdout_truncated: false,
                    stderr_truncated: false,
                };
                match request.operation.as_str() {
                    "GitVcsDriver.detectRepository" => {
                        return Ok(output(0, "true\n".to_owned()));
                    }
                    "GitVcsDriver.statusDetailsLocal.status" => {
                        let _ = self.local_status_started.send(());
                        let dirty = fs::read_to_string(request.cwd.join("tracked.txt"))
                            .is_ok_and(|contents| contents != "base\n");
                        let mut stdout = "# branch.head main\n".to_owned();
                        if dirty {
                            stdout.push_str(
                                "1 .M N... 100644 100644 100644 deadbeef deadbeef tracked.txt\n",
                            );
                        }
                        return Ok(output(0, stdout));
                    }
                    "GitVcsDriver.statusDetailsLocal.stagedNumstat"
                    | "GitVcsDriver.statusDetailsLocal.remotes" => {
                        return Ok(output(0, String::new()));
                    }
                    "GitVcsDriver.statusDetailsLocal.unstagedNumstat" => {
                        let dirty = fs::read_to_string(request.cwd.join("tracked.txt"))
                            .is_ok_and(|contents| contents != "base\n");
                        return Ok(output(
                            0,
                            if dirty {
                                "1\t1\ttracked.txt\n".to_owned()
                            } else {
                                String::new()
                            },
                        ));
                    }
                    "GitVcsDriver.defaultRef.originHead" => {
                        return Ok(output(1, String::new()));
                    }
                    "GitVcsDriver.defaultRef.candidate" => {
                        let is_main = request
                            .args
                            .last()
                            .is_some_and(|value| value == "refs/heads/main");
                        return Ok(output(i32::from(!is_main), String::new()));
                    }
                    _ => {}
                }
                if request.operation == "GitVcsDriver.statusDetailsRemote.status" {
                    let _ = self.remote_started.send(());
                    tokio::select! {
                        permit = self.release_remote.acquire() => {
                            permit.expect("remote release owner remains alive").forget();
                        }
                        () = cancellation.cancelled() => {
                            let _ = self.remote_cancelled.send(());
                            return Err(ProcessError::Cancelled {
                                operation: request.operation,
                            });
                        }
                    }
                }
                ProcessRunner
                    .run_with_clean_environment_for_test(request, cancellation)
                    .await
            })
        }
    }

    fn isolated_git_environment(sandbox: &TestSandbox) -> (PathBuf, Vec<(OsString, OsString)>) {
        let hooks = sandbox.path("hooks");
        fs::create_dir(&hooks).expect("isolated hooks directory");
        let isolated_config = sandbox.path("isolated-global.gitconfig");
        fs::write(
            &isolated_config,
            format!(
                "[commit]\n\tgpgSign = false\n[core]\n\thooksPath = {}\n",
                hooks.to_string_lossy().replace('\\', "/")
            ),
        )
        .expect("isolated global config");

        let hostile_config = sandbox.path("hostile-global.gitconfig");
        fs::write(
            &hostile_config,
            "[commit]\n\tgpgSign = true\n[core]\n\thooksPath = missing-hooks\n",
        )
        .expect("hostile global config");
        let hostile_git_dir = sandbox.path("hostile-git-dir");
        let hostile_work_tree = sandbox.path("hostile-work-tree");
        let hostile_index = sandbox.path("hostile-index");
        let mut environment = sandbox.environment([
            (
                "GIT_CONFIG_GLOBAL",
                hostile_config.to_string_lossy().into_owned(),
            ),
            (
                "GIT_CONFIG_SYSTEM",
                hostile_config.to_string_lossy().into_owned(),
            ),
            ("GIT_DIR", hostile_git_dir.to_string_lossy().into_owned()),
            (
                "GIT_WORK_TREE",
                hostile_work_tree.to_string_lossy().into_owned(),
            ),
            (
                "GIT_INDEX_FILE",
                hostile_index.to_string_lossy().into_owned(),
            ),
        ]);
        environment.retain(|name, _| {
            !name
                .as_bytes()
                .get(..4)
                .is_some_and(|prefix| prefix.eq_ignore_ascii_case(b"GIT_"))
        });
        environment.extend([
            (
                "GIT_CONFIG_GLOBAL".to_owned(),
                isolated_config.to_string_lossy().into_owned(),
            ),
            ("GIT_CONFIG_NOSYSTEM".to_owned(), "1".to_owned()),
            ("GIT_TERMINAL_PROMPT".to_owned(), "0".to_owned()),
        ]);
        (
            isolated_config,
            environment
                .into_iter()
                .map(|(name, value)| (name.into(), value.into()))
                .collect(),
        )
    }

    fn initialize_test_repository(
        sandbox: &TestSandbox,
        command: &Path,
        environment: &[(OsString, OsString)],
    ) -> PathBuf {
        let repository = sandbox.path("repository");
        fs::create_dir(&repository).expect("temporary Git repository");
        for args in [
            &["init", "--quiet", "-b", "main"][..],
            &["config", "user.name", "BiBCode Test"][..],
            &["config", "user.email", "bibcode@example.invalid"][..],
        ] {
            let output = Command::new(command)
                .args(args)
                .current_dir(&repository)
                .env_clear()
                .envs(environment.iter().cloned())
                .output()
                .expect("Git fixture command starts");
            assert!(
                output.status.success(),
                "git {args:?} failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
        fs::write(repository.join("tracked.txt"), "base\n").expect("clean fixture file");
        for args in [
            &["add", "--", "tracked.txt"][..],
            &["commit", "--quiet", "-m", "initial"][..],
        ] {
            let output = Command::new(command)
                .args(args)
                .current_dir(&repository)
                .env_clear()
                .envs(environment.iter().cloned())
                .output()
                .expect("Git fixture command starts");
            assert!(
                output.status.success(),
                "git {args:?} failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
        repository
    }

    #[test]
    fn subscriber_capacity_is_never_zero() {
        let broadcaster =
            StatusBroadcaster::new(Arc::new(GitRepository::default()), Duration::ZERO, 0);
        assert_eq!(broadcaster.inner.subscriber_capacity, 1);
    }

    #[test]
    fn remote_failure_backoff_is_capped() {
        let mut backoff = Duration::ZERO;
        assert_eq!(
            next_remote_failure_backoff(backoff),
            Duration::from_secs(30)
        );
        for _ in 0..10 {
            backoff = next_remote_failure_backoff(backoff);
        }
        assert_eq!(backoff, REMOTE_FAILURE_BACKOFF_MAX);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn local_invalidation_starts_while_remote_refresh_is_blocked() {
        let sandbox = TestSandbox::new("git-broadcaster-invalidation");
        let command = sandbox.executable_on_path("git");
        let (expected_git_config, environment) = isolated_git_environment(&sandbox);
        let repository = initialize_test_repository(&sandbox, &command, &environment);
        let (remote_started, mut remote_started_rx) = mpsc::unbounded_channel();
        let (remote_cancelled, mut remote_cancelled_rx) = mpsc::unbounded_channel();
        let (local_status_started, mut local_status_started_rx) = mpsc::unbounded_channel();
        let release_remote = Arc::new(Semaphore::new(0));
        let git = GitRepository::with_runner_for_test(Arc::new(BlockingRemoteGitRunner {
            command,
            environment,
            expected_git_config,
            remote_started,
            remote_cancelled,
            local_status_started,
            release_remote: release_remote.clone(),
        }));
        let broadcaster = StatusBroadcaster::with_refresh_intervals(
            Arc::new(git),
            Duration::from_secs(3_600),
            Duration::from_secs(30),
            4,
        );
        let mut subscription = broadcaster
            .subscribe(repository.clone(), CancellationToken::new())
            .await
            .expect("status subscription starts");
        assert!(matches!(
            subscription.recv().await,
            Some(VcsStatusStreamEvent::Snapshot { ref local, .. })
                if !local.has_working_tree_changes
        ));
        local_status_started_rx
            .recv()
            .await
            .expect("initial local status scan was observed");
        tokio::time::timeout(Duration::from_secs(5), remote_started_rx.recv())
            .await
            .expect("initial remote status scan starts")
            .expect("remote status checkpoint owner remains alive");

        fs::write(repository.join("tracked.txt"), "changed in editor\n")
            .expect("mutate tracked fixture file");
        broadcaster.notify_local_change(&repository).await;

        tokio::time::timeout(Duration::from_secs(5), local_status_started_rx.recv())
            .await
            .expect("local invalidation remained blocked behind remote refresh")
            .expect("local status checkpoint owner remains alive");
        let event = tokio::time::timeout(Duration::from_secs(5), subscription.recv())
            .await
            .expect("dirty local status is published while remote refresh remains blocked")
            .expect("status subscription remains open");
        assert!(matches!(
            event,
            VcsStatusStreamEvent::LocalUpdated { local }
                if local.has_working_tree_changes
                    && local.working_tree.files.iter().any(|file| file.path == "tracked.txt")
        ));

        drop(subscription);
        assert_eq!(broadcaster.active_poller_count(), 0);
        tokio::time::timeout(Duration::from_secs(5), remote_cancelled_rx.recv())
            .await
            .expect("final subscriber drop cancels the blocked remote owner")
            .expect("remote cancellation checkpoint owner remains alive");
    }
}
