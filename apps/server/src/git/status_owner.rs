use std::{
    collections::{HashMap, hash_map::Entry},
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    sync::{Arc, Mutex, MutexGuard},
    time::Duration,
};

use tokio::{
    sync::{Mutex as AsyncMutex, OwnedMutexGuard, watch},
    time::Instant,
};
use tokio_util::{sync::CancellationToken, task::TaskTracker};

use super::{
    GitCommandError, GitWatchEvent, GitWatchSubscription, GitWatcherHealth, VcsStatusLocalResult,
    VcsStatusResult,
};

const STATUS_SIGNAL_DEBOUNCE: Duration = Duration::from_millis(125);
pub(crate) const STATUS_SAFETY_INTERVAL: Duration = Duration::from_secs(60);
const STATUS_SAFETY_MAX_INTERVAL: Duration = Duration::from_secs(300);

trait StatusSignalSource: Send {
    fn health(&self) -> GitWatcherHealth;

    fn recv(&mut self) -> impl Future<Output = Option<GitWatchEvent>> + Send;
}

struct WatcherSignalSource {
    watcher: Option<GitWatchSubscription>,
    setup_fallback: bool,
}

impl StatusSignalSource for WatcherSignalSource {
    fn health(&self) -> GitWatcherHealth {
        if self.setup_fallback
            || self
                .watcher
                .as_ref()
                .is_some_and(|watcher| watcher.health() == GitWatcherHealth::FallbackRequired)
        {
            GitWatcherHealth::FallbackRequired
        } else {
            GitWatcherHealth::Healthy
        }
    }

    async fn recv(&mut self) -> Option<GitWatchEvent> {
        match self.watcher.as_mut() {
            Some(watcher) => watcher.recv().await,
            None => std::future::pending().await,
        }
    }
}

pub(crate) async fn run_status_signal_scheduler<F, Fut, T>(
    watcher: Option<GitWatchSubscription>,
    setup_fallback: bool,
    immediate_refreshes: watch::Receiver<u64>,
    cancellation: CancellationToken,
    initial_read_duration: Duration,
    safety_interval: Duration,
    refresh: F,
) -> bool
where
    F: FnMut() -> Fut + Send,
    Fut: Future<Output = T> + Send,
{
    run_status_signal_scheduler_with_source(
        WatcherSignalSource {
            watcher,
            setup_fallback,
        },
        setup_fallback,
        immediate_refreshes,
        cancellation,
        initial_read_duration,
        safety_interval,
        refresh,
    )
    .await
}

async fn run_status_signal_scheduler_with_source<S, F, Fut, T>(
    mut source: S,
    setup_fallback: bool,
    mut immediate_refreshes: watch::Receiver<u64>,
    cancellation: CancellationToken,
    initial_read_duration: Duration,
    safety_interval: Duration,
    mut refresh: F,
) -> bool
where
    S: StatusSignalSource,
    F: FnMut() -> Fut,
    Fut: Future<Output = T>,
{
    let mut watcher_alive = true;
    let mut fallback_required =
        setup_fallback || source.health() == GitWatcherHealth::FallbackRequired;
    let mut signal_version = 0_u64;
    let mut read_signal_version = 0_u64;
    let mut signal_deadline = None;
    let mut safety_deadline =
        Instant::now() + status_safety_delay(initial_read_duration, safety_interval);
    let mut immediate_pending = false;
    let mut read_started_at = None;
    let mut read: Option<Pin<Box<Fut>>> = None;

    loop {
        fallback_required |= source.health() == GitWatcherHealth::FallbackRequired;
        let now = Instant::now();
        if read.is_none() {
            if immediate_refreshes.has_changed().unwrap_or(false) {
                immediate_refreshes.borrow_and_update();
                immediate_pending = true;
            }
            let signal_due = signal_deadline.is_some_and(|deadline| deadline <= now);
            let safety_due = safety_deadline <= now;
            if immediate_pending || signal_due || safety_due {
                immediate_pending = false;
                signal_deadline = None;
                read_signal_version = signal_version;
                read_started_at = Some(now);
                read = Some(Box::pin(refresh()));
                continue;
            }
        }

        tokio::select! {
            biased;
            () = cancellation.cancelled() => break,
            changed = immediate_refreshes.changed() => {
                if changed.is_err() {
                    break;
                }
                immediate_refreshes.borrow_and_update();
                immediate_pending = true;
            }
            event = source.recv(), if watcher_alive => {
                match event {
                    Some(GitWatchEvent::WorkingTree | GitWatchEvent::Metadata) => {
                        signal_version = signal_version.wrapping_add(1);
                        signal_deadline = Some(Instant::now() + STATUS_SIGNAL_DEBOUNCE);
                    }
                    Some(GitWatchEvent::Overflow | GitWatchEvent::Unavailable) => {
                        fallback_required = true;
                    }
                    None => {
                        watcher_alive = false;
                        fallback_required = true;
                    }
                }
            }
            result = wait_for_status_read(&mut read), if read.is_some() => {
                drop(result);
                let duration = Instant::now().saturating_duration_since(
                    read_started_at.take().expect("active status read has a start time"),
                );
                read = None;
                safety_deadline = Instant::now() + status_safety_delay(duration, safety_interval);
                if signal_version == read_signal_version {
                    signal_deadline = None;
                }
            }
            () = wait_for_status_deadline(signal_deadline), if read.is_none() && signal_deadline.is_some() => {}
            () = tokio::time::sleep_until(safety_deadline), if read.is_none() => {}
        }
    }

    fallback_required
}

async fn wait_for_status_read<Fut>(read: &mut Option<Pin<Box<Fut>>>) -> Fut::Output
where
    Fut: Future,
{
    read.as_mut()
        .expect("status read wait requires an active read")
        .as_mut()
        .await
}

async fn wait_for_status_deadline(deadline: Option<Instant>) {
    tokio::time::sleep_until(deadline.expect("status deadline wait requires a deadline")).await;
}

fn status_safety_delay(read_duration: Duration, safety_interval: Duration) -> Duration {
    read_duration.saturating_mul(4).clamp(
        safety_interval,
        STATUS_SAFETY_MAX_INTERVAL.max(safety_interval),
    )
}

#[derive(Clone)]
pub(crate) struct StatusReadOwner {
    inner: Arc<Inner>,
}

struct Inner {
    state: Mutex<State>,
    tasks: TaskTracker,
    #[cfg(test)]
    lease_changed: tokio::sync::Notify,
    #[cfg(test)]
    physical_spawn_gate: Mutex<Option<Arc<PhysicalSpawnGate>>>,
    #[cfg(test)]
    read_execution_gate: Mutex<Option<(StatusOutputKind, Arc<StatusReadExecutionGate>)>>,
}

#[derive(Default)]
struct State {
    closed: bool,
    next_read_id: u64,
    next_worktree_epoch: u64,
    worktrees: HashMap<PathBuf, WorktreeStatusState>,
}

struct WorktreeStatusState {
    epoch: u64,
    mutation_lock: Arc<AsyncMutex<()>>,
    mutation_active: bool,
    pending_mutations: usize,
    read_gate_closed: bool,
    read_gate: watch::Sender<u64>,
    in_flight: HashMap<StatusOutputKind, SharedStatusRead>,
    local_refresh_requests: watch::Sender<u64>,
    trailing_refresh_pending: bool,
    physical_reads_active: usize,
    retire_when_idle: bool,
    #[cfg(test)]
    physical_reads_started: HashMap<StatusOutputKind, usize>,
}

impl WorktreeStatusState {
    fn new(epoch: u64) -> Self {
        let (local_refresh_requests, _) = watch::channel(0);
        let (read_gate, _) = watch::channel(0);
        Self {
            epoch,
            mutation_lock: Arc::new(AsyncMutex::new(())),
            mutation_active: false,
            pending_mutations: 0,
            read_gate_closed: false,
            read_gate,
            in_flight: HashMap::new(),
            local_refresh_requests,
            trailing_refresh_pending: false,
            physical_reads_active: 0,
            retire_when_idle: false,
            #[cfg(test)]
            physical_reads_started: HashMap::new(),
        }
    }
}

struct SharedStatusRead {
    id: u64,
    cancellation: CancellationToken,
    receiver: watch::Receiver<Option<CompletedStatusRead>>,
    leases: usize,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(crate) struct StatusReadKey {
    pub canonical_cwd: PathBuf,
    pub output_kind: StatusOutputKind,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct StatusReadFence {
    canonical_cwd: PathBuf,
    epoch: u64,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub(crate) enum StatusOutputKind {
    Local,
    Full,
}

#[derive(Clone)]
enum StatusReadValue {
    Local(VcsStatusLocalResult),
    Full(VcsStatusResult),
}

#[derive(Clone)]
struct CompletedStatusRead {
    epoch: u64,
    result: Result<StatusReadValue, GitCommandError>,
}

pub(crate) struct StatusReadResult<T> {
    pub value: T,
    key: StatusReadKey,
    epoch: u64,
}

impl<T> StatusReadResult<T> {
    pub(crate) fn fence(&self) -> StatusReadFence {
        StatusReadFence {
            canonical_cwd: self.key.canonical_cwd.clone(),
            epoch: self.epoch,
        }
    }
}

pub(crate) struct StatusReadLease {
    owner: StatusReadOwner,
    key: StatusReadKey,
    read_id: u64,
    receiver: watch::Receiver<Option<CompletedStatusRead>>,
}

enum ReadAdmission {
    Lease(StatusReadLease),
    Waiting(watch::Receiver<u64>),
    Shutdown,
}

struct PendingMutation {
    owner: StatusReadOwner,
    canonical_cwd: PathBuf,
    pending: bool,
}

pub struct StatusMutationGuard {
    owner: StatusReadOwner,
    canonical_cwd: PathBuf,
    mutation_guard: Option<OwnedMutexGuard<()>>,
}

impl StatusReadOwner {
    #[must_use]
    pub(crate) fn new() -> Self {
        Self {
            inner: Arc::new(Inner {
                state: Mutex::new(State::default()),
                tasks: TaskTracker::new(),
                #[cfg(test)]
                lease_changed: tokio::sync::Notify::new(),
                #[cfg(test)]
                physical_spawn_gate: Mutex::new(None),
                #[cfg(test)]
                read_execution_gate: Mutex::new(None),
            }),
        }
    }

    pub(crate) async fn read_local<F, Fut>(
        &self,
        key: StatusReadKey,
        caller_cancellation: &CancellationToken,
        load: F,
    ) -> Result<StatusReadResult<VcsStatusLocalResult>, GitCommandError>
    where
        F: FnOnce(CancellationToken) -> Fut + Send + 'static,
        Fut: Future<Output = Result<VcsStatusLocalResult, GitCommandError>> + Send + 'static,
    {
        debug_assert_eq!(key.output_kind, StatusOutputKind::Local);
        let lease = self
            .acquire(key, caller_cancellation, move |cancellation| async move {
                load(cancellation).await.map(StatusReadValue::Local)
            })
            .await?;
        let (value, key, epoch) = lease.wait(caller_cancellation).await?;
        let StatusReadValue::Local(value) = value else {
            unreachable!("local status key received a full status value");
        };
        Ok(StatusReadResult { value, key, epoch })
    }

    pub(crate) async fn read_full<F, Fut>(
        &self,
        key: StatusReadKey,
        caller_cancellation: &CancellationToken,
        load: F,
    ) -> Result<StatusReadResult<VcsStatusResult>, GitCommandError>
    where
        F: FnOnce(CancellationToken) -> Fut + Send + 'static,
        Fut: Future<Output = Result<VcsStatusResult, GitCommandError>> + Send + 'static,
    {
        debug_assert_eq!(key.output_kind, StatusOutputKind::Full);
        let lease = self
            .acquire(key, caller_cancellation, move |cancellation| async move {
                load(cancellation).await.map(StatusReadValue::Full)
            })
            .await?;
        let (value, key, epoch) = lease.wait(caller_cancellation).await?;
        let StatusReadValue::Full(value) = value else {
            unreachable!("full status key received a local status value");
        };
        Ok(StatusReadResult { value, key, epoch })
    }

    pub(crate) fn publish_if_current<T, R>(
        &self,
        read: StatusReadResult<T>,
        publish: impl FnOnce(&T) -> R,
    ) -> Result<(T, R), GitCommandError> {
        let state = self.lock_state();
        let current = state
            .worktrees
            .get(&read.key.canonical_cwd)
            .is_some_and(|worktree| !worktree.mutation_active && worktree.epoch == read.epoch);
        if !current {
            return Err(read_error(
                &read.key,
                "status read was retired before publication",
            ));
        }
        let published = publish(&read.value);
        Ok((read.value, published))
    }

    pub(crate) async fn acquire_read_fence(
        &self,
        canonical_cwd: &Path,
        caller_cancellation: &CancellationToken,
    ) -> Result<StatusReadFence, GitCommandError> {
        loop {
            let read_gate = {
                let mut state = self.lock_state();
                if state.closed {
                    return Err(status_owner_error(
                        canonical_cwd,
                        "status read owner stopped",
                    ));
                }
                let worktree = activate_worktree(&mut state, canonical_cwd);
                if worktree.read_gate_closed {
                    Some(worktree.read_gate.subscribe())
                } else {
                    return Ok(StatusReadFence {
                        canonical_cwd: canonical_cwd.to_path_buf(),
                        epoch: worktree.epoch,
                    });
                }
            };
            let mut read_gate = read_gate.expect("closed read gate has a receiver");
            tokio::select! {
                biased;
                () = caller_cancellation.cancelled() => {
                    return Err(status_owner_error(canonical_cwd, "status read caller was cancelled"));
                }
                changed = read_gate.changed() => {
                    if changed.is_err() {
                        return Err(status_owner_error(canonical_cwd, "status read owner stopped"));
                    }
                }
            }
        }
    }

    pub(crate) fn publish_if_fence_current<R>(
        &self,
        fence: &StatusReadFence,
        publish: impl FnOnce() -> R,
    ) -> Result<R, GitCommandError> {
        let state = self.lock_state();
        let current = state
            .worktrees
            .get(&fence.canonical_cwd)
            .is_some_and(|worktree| !worktree.mutation_active && worktree.epoch == fence.epoch);
        if !current {
            return Err(status_owner_error(
                &fence.canonical_cwd,
                "status read was retired before publication",
            ));
        }
        Ok(publish())
    }

    pub(crate) async fn begin_mutation(&self, canonical_cwd: PathBuf) -> StatusMutationGuard {
        let (mutation_lock, mut pending) = {
            let mut state = self.lock_state();
            let worktree = activate_worktree(&mut state, &canonical_cwd);
            worktree.pending_mutations = worktree
                .pending_mutations
                .checked_add(1)
                .expect("pending status mutation count exhausted");
            worktree.read_gate_closed = true;
            (
                Arc::clone(&worktree.mutation_lock),
                PendingMutation {
                    owner: self.clone(),
                    canonical_cwd: canonical_cwd.clone(),
                    pending: true,
                },
            )
        };
        let mutation_guard = mutation_lock.lock_owned().await;
        {
            let mut state = self.lock_state();
            let worktree = state
                .worktrees
                .get_mut(&canonical_cwd)
                .expect("pending mutation retains its worktree state");
            worktree.pending_mutations = worktree
                .pending_mutations
                .checked_sub(1)
                .expect("pending status mutation count remains positive");
            worktree.mutation_active = true;
            worktree.epoch = worktree.epoch.wrapping_add(1);
            retire_reads(worktree);
        }
        pending.pending = false;
        StatusMutationGuard {
            owner: self.clone(),
            canonical_cwd,
            mutation_guard: Some(mutation_guard),
        }
    }

    pub(crate) fn subscribe_local_refresh(&self, canonical_cwd: &Path) -> watch::Receiver<u64> {
        activate_worktree(&mut self.lock_state(), canonical_cwd)
            .local_refresh_requests
            .subscribe()
    }

    pub(crate) fn request_local_refresh(&self, canonical_cwd: &Path) {
        activate_worktree(&mut self.lock_state(), canonical_cwd)
            .local_refresh_requests
            .send_modify(|generation| *generation = generation.wrapping_add(1));
        #[cfg(test)]
        self.inner.lease_changed.notify_waiters();
    }

    pub(crate) fn cancel_reads(&self, canonical_cwd: &Path) {
        let mut state = self.lock_state();
        let retire = if let Some(worktree) = state.worktrees.get_mut(canonical_cwd) {
            worktree.epoch = worktree.epoch.wrapping_add(1);
            retire_reads(worktree);
            worktree.retire_when_idle = true;
            worktree_can_retire(worktree)
        } else {
            false
        };
        if retire {
            state.worktrees.remove(canonical_cwd);
        }
    }

    pub(crate) async fn shutdown(&self) {
        #[cfg(test)]
        if let Some(gate) = self
            .inner
            .physical_spawn_gate
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
        {
            gate.observe_shutdown_attempt();
        }
        {
            let mut state = self.lock_state();
            state.closed = true;
            for worktree in state.worktrees.values_mut() {
                worktree.epoch = worktree.epoch.wrapping_add(1);
                retire_reads(worktree);
                worktree
                    .read_gate
                    .send_modify(|generation| *generation = generation.wrapping_add(1));
            }
            self.inner.tasks.close();
        }
        self.inner.tasks.wait().await;
    }

    #[cfg(test)]
    pub(crate) fn lease_count_for_test(&self, key: &StatusReadKey) -> usize {
        self.lock_state()
            .worktrees
            .get(&key.canonical_cwd)
            .and_then(|worktree| worktree.in_flight.get(&key.output_kind))
            .map_or(0, |read| read.leases)
    }

    #[cfg(test)]
    pub(crate) async fn wait_for_lease_count_for_test(&self, key: &StatusReadKey, expected: usize) {
        loop {
            let changed = self.inner.lease_changed.notified();
            if self.lease_count_for_test(key) == expected {
                return;
            }
            changed.await;
        }
    }

    #[cfg(test)]
    pub(crate) fn local_refresh_generation_for_test(&self, canonical_cwd: &Path) -> u64 {
        self.lock_state()
            .worktrees
            .get(canonical_cwd)
            .map_or(0, |worktree| *worktree.local_refresh_requests.borrow())
    }

    #[cfg(test)]
    fn worktree_state_count_for_test(&self) -> usize {
        self.lock_state().worktrees.len()
    }

    #[cfg(test)]
    pub(crate) async fn wait_for_local_refresh_generation_after_for_test(
        &self,
        canonical_cwd: &Path,
        baseline: u64,
    ) {
        loop {
            let changed = self.inner.lease_changed.notified();
            if self.local_refresh_generation_for_test(canonical_cwd) > baseline {
                return;
            }
            changed.await;
        }
    }

    #[cfg(test)]
    pub(crate) fn physical_read_count_for_test(&self, key: &StatusReadKey) -> usize {
        self.lock_state()
            .worktrees
            .get(&key.canonical_cwd)
            .and_then(|worktree| worktree.physical_reads_started.get(&key.output_kind))
            .copied()
            .unwrap_or(0)
    }

    #[cfg(test)]
    pub(crate) async fn wait_for_physical_read_after_for_test(
        &self,
        key: &StatusReadKey,
        baseline: usize,
    ) {
        loop {
            let changed = self.inner.lease_changed.notified();
            if self.physical_read_count_for_test(key) > baseline {
                return;
            }
            changed.await;
        }
    }

    fn finish_mutation_burst_if_idle(&self, canonical_cwd: &Path) {
        let mut state = self.lock_state();
        let Some(worktree) = state.worktrees.get_mut(canonical_cwd) else {
            return;
        };
        if worktree.pending_mutations != 0 || worktree.mutation_active {
            return;
        }
        if worktree_can_retire(worktree) {
            state.worktrees.remove(canonical_cwd);
            return;
        }
        if !worktree.read_gate_closed {
            return;
        }
        if std::mem::take(&mut worktree.trailing_refresh_pending) {
            worktree
                .local_refresh_requests
                .send_modify(|generation| *generation = generation.wrapping_add(1));
        }
        worktree.read_gate_closed = false;
        worktree
            .read_gate
            .send_modify(|generation| *generation = generation.wrapping_add(1));
    }

    async fn acquire<F, Fut>(
        &self,
        key: StatusReadKey,
        caller_cancellation: &CancellationToken,
        load: F,
    ) -> Result<StatusReadLease, GitCommandError>
    where
        F: FnOnce(CancellationToken) -> Fut + Send + 'static,
        Fut: Future<Output = Result<StatusReadValue, GitCommandError>> + Send + 'static,
    {
        let mut load = Some(load);
        loop {
            match self.try_acquire(&key, &mut load) {
                ReadAdmission::Lease(lease) => return Ok(lease),
                ReadAdmission::Shutdown => {
                    return Err(read_error(&key, "status read owner stopped"));
                }
                ReadAdmission::Waiting(mut read_gate) => {
                    tokio::select! {
                        biased;
                        () = caller_cancellation.cancelled() => {
                            return Err(read_error(&key, "status read caller was cancelled"));
                        }
                        changed = read_gate.changed() => {
                            if changed.is_err() {
                                return Err(read_error(&key, "status read owner stopped"));
                            }
                        }
                    }
                }
            }
        }
    }

    fn try_acquire<F, Fut>(&self, key: &StatusReadKey, load: &mut Option<F>) -> ReadAdmission
    where
        F: FnOnce(CancellationToken) -> Fut + Send + 'static,
        Fut: Future<Output = Result<StatusReadValue, GitCommandError>> + Send + 'static,
    {
        let mut state = self.lock_state();
        if state.closed {
            return ReadAdmission::Shutdown;
        }
        let worktree = activate_worktree(&mut state, &key.canonical_cwd);
        if worktree.read_gate_closed {
            return ReadAdmission::Waiting(worktree.read_gate.subscribe());
        }
        if let Some(shared) = state
            .worktrees
            .get_mut(&key.canonical_cwd)
            .and_then(|worktree| worktree.in_flight.get_mut(&key.output_kind))
        {
            shared.leases = shared
                .leases
                .checked_add(1)
                .expect("status read lease count exhausted");
            #[cfg(test)]
            self.inner.lease_changed.notify_waiters();
            return ReadAdmission::Lease(StatusReadLease {
                owner: self.clone(),
                key: key.clone(),
                read_id: shared.id,
                receiver: shared.receiver.clone(),
            });
        }

        let read_id = state.next_read_id;
        state.next_read_id = state.next_read_id.wrapping_add(1);
        let worktree = state
            .worktrees
            .get_mut(&key.canonical_cwd)
            .expect("active worktree status state remains present");
        let epoch = worktree.epoch;
        let cancellation = CancellationToken::new();
        let (sender, receiver) = watch::channel(None);
        let load = load
            .take()
            .expect("status read loader is consumed only by its physical leader");
        worktree.physical_reads_active = worktree
            .physical_reads_active
            .checked_add(1)
            .expect("active physical status read count exhausted");
        #[cfg(test)]
        {
            *worktree
                .physical_reads_started
                .entry(key.output_kind)
                .or_default() += 1;
        }
        worktree.in_flight.insert(
            key.output_kind,
            SharedStatusRead {
                id: read_id,
                cancellation: cancellation.clone(),
                receiver: receiver.clone(),
                leases: 1,
            },
        );
        #[cfg(test)]
        self.inner.lease_changed.notify_waiters();

        #[cfg(test)]
        let physical_spawn_gate = self
            .inner
            .physical_spawn_gate
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        #[cfg(test)]
        let read_execution_gate = self
            .inner
            .read_execution_gate
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_ref()
            .filter(|(output_kind, _)| *output_kind == key.output_kind)
            .map(|(_, gate)| Arc::clone(gate));
        #[cfg(test)]
        if let Some(gate) = physical_spawn_gate {
            gate.block_before_spawn();
        }

        let owner = self.clone();
        let task_key = key.clone();
        self.inner.tasks.spawn(async move {
            #[cfg(test)]
            if let Some(gate) = read_execution_gate
                && !gate.wait_for_release(&cancellation).await
            {
                owner.complete_read(
                    &task_key,
                    read_id,
                    epoch,
                    sender,
                    Err(read_error(&task_key, "status read was cancelled")),
                );
                return;
            }
            let mut load = Box::pin(load(cancellation.clone()));
            let result = tokio::select! {
                biased;
                () = cancellation.cancelled() => None,
                result = &mut load => Some(result),
            };
            match result {
                Some(result) => owner.complete_read(&task_key, read_id, epoch, sender, result),
                None => {
                    owner.complete_read(
                        &task_key,
                        read_id,
                        epoch,
                        sender,
                        Err(read_error(&task_key, "status read was cancelled")),
                    );
                    drop(load.await);
                }
            }
        });
        drop(state);
        ReadAdmission::Lease(StatusReadLease {
            owner: self.clone(),
            key: key.clone(),
            read_id,
            receiver,
        })
    }

    fn complete_read(
        &self,
        key: &StatusReadKey,
        read_id: u64,
        epoch: u64,
        sender: watch::Sender<Option<CompletedStatusRead>>,
        result: Result<StatusReadValue, GitCommandError>,
    ) {
        let mut state = self.lock_state();
        let current = state
            .worktrees
            .get(&key.canonical_cwd)
            .is_some_and(|worktree| !worktree.mutation_active && worktree.epoch == epoch);
        let result = if current {
            result
        } else {
            Err(read_error(key, "status read was retired by a mutation"))
        };
        let retire = if let Some(worktree) = state.worktrees.get_mut(&key.canonical_cwd) {
            worktree.physical_reads_active = worktree
                .physical_reads_active
                .checked_sub(1)
                .expect("active physical status read count remains positive");
            if worktree
                .in_flight
                .get(&key.output_kind)
                .is_some_and(|shared| shared.id == read_id)
            {
                worktree.in_flight.remove(&key.output_kind);
            }
            worktree_can_retire(worktree)
        } else {
            false
        };
        if retire {
            state.worktrees.remove(&key.canonical_cwd);
        }
        #[cfg(test)]
        self.inner.lease_changed.notify_waiters();
        sender.send_replace(Some(CompletedStatusRead { epoch, result }));
    }

    fn release(&self, key: &StatusReadKey, read_id: u64) {
        let mut state = self.lock_state();
        let Some(worktree) = state.worktrees.get_mut(&key.canonical_cwd) else {
            return;
        };
        let Some(shared) = worktree
            .in_flight
            .get_mut(&key.output_kind)
            .filter(|shared| shared.id == read_id)
        else {
            return;
        };
        shared.leases = shared
            .leases
            .checked_sub(1)
            .expect("status read lease count remains positive");
        #[cfg(test)]
        self.inner.lease_changed.notify_waiters();
        if shared.leases != 0 {
            return;
        }
        let cancellation = shared.cancellation.clone();
        worktree.in_flight.remove(&key.output_kind);
        drop(state);
        cancellation.cancel();
    }

    fn lock_state(&self) -> MutexGuard<'_, State> {
        self.inner
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    #[cfg(test)]
    fn install_physical_spawn_gate_for_test(&self) -> Arc<PhysicalSpawnGate> {
        let gate = Arc::new(PhysicalSpawnGate::default());
        *self
            .inner
            .physical_spawn_gate
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(Arc::clone(&gate));
        gate
    }

    #[cfg(test)]
    pub(crate) fn install_read_execution_gate_for_test(
        &self,
        output_kind: StatusOutputKind,
    ) -> Arc<StatusReadExecutionGate> {
        let gate = Arc::new(StatusReadExecutionGate::default());
        *self
            .inner
            .read_execution_gate
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) =
            Some((output_kind, Arc::clone(&gate)));
        gate
    }
}

#[cfg(test)]
pub(crate) struct StatusReadExecutionGate {
    entered: std::sync::atomic::AtomicBool,
    entered_notify: tokio::sync::Notify,
    release: tokio::sync::Semaphore,
}

#[cfg(test)]
impl Default for StatusReadExecutionGate {
    fn default() -> Self {
        Self {
            entered: std::sync::atomic::AtomicBool::new(false),
            entered_notify: tokio::sync::Notify::new(),
            release: tokio::sync::Semaphore::new(0),
        }
    }
}

#[cfg(test)]
impl StatusReadExecutionGate {
    async fn wait_for_release(&self, cancellation: &CancellationToken) -> bool {
        self.entered
            .store(true, std::sync::atomic::Ordering::Release);
        self.entered_notify.notify_waiters();
        tokio::select! {
            biased;
            () = cancellation.cancelled() => false,
            permit = self.release.acquire() => {
                permit.expect("status-read execution gate remains open").forget();
                true
            }
        }
    }

    pub(crate) async fn wait_until_entered(&self) {
        loop {
            let entered = self.entered_notify.notified();
            if self.entered.load(std::sync::atomic::Ordering::Acquire) {
                return;
            }
            entered.await;
        }
    }
}

#[cfg(test)]
#[derive(Default)]
struct PhysicalSpawnGate {
    entered: std::sync::atomic::AtomicBool,
    entered_notify: tokio::sync::Notify,
    shutdown_attempted: std::sync::atomic::AtomicBool,
    shutdown_notify: tokio::sync::Notify,
    released: Mutex<bool>,
    release_notify: std::sync::Condvar,
}

#[cfg(test)]
impl PhysicalSpawnGate {
    fn block_before_spawn(&self) {
        self.entered
            .store(true, std::sync::atomic::Ordering::Release);
        self.entered_notify.notify_waiters();
        let mut released = self.released.lock().expect("physical-spawn gate lock");
        while !*released {
            released = self
                .release_notify
                .wait(released)
                .expect("physical-spawn gate wait");
        }
    }

    async fn wait_until_entered(&self) {
        loop {
            let entered = self.entered_notify.notified();
            if self.entered.load(std::sync::atomic::Ordering::Acquire) {
                return;
            }
            entered.await;
        }
    }

    fn observe_shutdown_attempt(&self) {
        self.shutdown_attempted
            .store(true, std::sync::atomic::Ordering::Release);
        self.shutdown_notify.notify_waiters();
    }

    async fn wait_for_shutdown_attempt(&self) {
        loop {
            let attempted = self.shutdown_notify.notified();
            if self
                .shutdown_attempted
                .load(std::sync::atomic::Ordering::Acquire)
            {
                return;
            }
            attempted.await;
        }
    }

    fn release(&self) {
        *self.released.lock().expect("physical-spawn gate lock") = true;
        self.release_notify.notify_all();
    }
}

impl StatusReadLease {
    async fn wait(
        mut self,
        caller_cancellation: &CancellationToken,
    ) -> Result<(StatusReadValue, StatusReadKey, u64), GitCommandError> {
        loop {
            tokio::select! {
                biased;
                () = caller_cancellation.cancelled() => {
                    return Err(read_error(&self.key, "status read caller was cancelled"));
                }
                changed = self.receiver.changed() => {
                    if changed.is_err() {
                        return Err(read_error(&self.key, "status read owner stopped"));
                    }
                    if let Some(completed) = self.receiver.borrow().clone() {
                        return completed
                            .result
                            .map(|value| (value, self.key.clone(), completed.epoch));
                    }
                }
            }
        }
    }
}

impl Drop for StatusReadLease {
    fn drop(&mut self) {
        self.owner.release(&self.key, self.read_id);
    }
}

impl StatusMutationGuard {
    pub async fn finish(mut self) {
        self.settle();
    }

    fn settle(&mut self) {
        let Some(mutation_guard) = self.mutation_guard.take() else {
            return;
        };
        {
            let mut state = self.owner.lock_state();
            let Some(worktree) = state.worktrees.get_mut(&self.canonical_cwd) else {
                return;
            };
            worktree.epoch = worktree.epoch.wrapping_add(1);
            retire_reads(worktree);
            worktree.mutation_active = false;
            worktree.trailing_refresh_pending = true;
        }
        drop(mutation_guard);
        self.owner
            .finish_mutation_burst_if_idle(&self.canonical_cwd);
    }
}

impl Drop for StatusMutationGuard {
    fn drop(&mut self) {
        self.settle();
    }
}

impl Drop for PendingMutation {
    fn drop(&mut self) {
        if !self.pending {
            return;
        }
        {
            let mut state = self.owner.lock_state();
            let Some(worktree) = state.worktrees.get_mut(&self.canonical_cwd) else {
                return;
            };
            worktree.pending_mutations = worktree
                .pending_mutations
                .checked_sub(1)
                .expect("pending status mutation count remains positive");
        }
        self.owner
            .finish_mutation_burst_if_idle(&self.canonical_cwd);
    }
}

fn activate_worktree<'a>(
    state: &'a mut State,
    canonical_cwd: &Path,
) -> &'a mut WorktreeStatusState {
    let State {
        next_worktree_epoch,
        worktrees,
        ..
    } = state;
    let worktree = match worktrees.entry(canonical_cwd.to_path_buf()) {
        Entry::Occupied(entry) => entry.into_mut(),
        Entry::Vacant(entry) => {
            let epoch = *next_worktree_epoch;
            *next_worktree_epoch = next_worktree_epoch.wrapping_add(1);
            entry.insert(WorktreeStatusState::new(epoch))
        }
    };
    worktree.retire_when_idle = false;
    worktree
}

fn worktree_can_retire(worktree: &WorktreeStatusState) -> bool {
    worktree.retire_when_idle
        && worktree.pending_mutations == 0
        && !worktree.mutation_active
        && worktree.physical_reads_active == 0
        && worktree.in_flight.is_empty()
}

fn retire_reads(worktree: &mut WorktreeStatusState) {
    for read in worktree.in_flight.values() {
        read.cancellation.cancel();
    }
    worktree.in_flight.clear();
}

fn read_error(key: &StatusReadKey, detail: &str) -> GitCommandError {
    status_owner_error(&key.canonical_cwd, detail)
}

fn status_owner_error(canonical_cwd: &Path, detail: &str) -> GitCommandError {
    GitCommandError {
        tag: "GitCommandError",
        operation: "GitVcsDriver.statusReadOwner".into(),
        command: "git".into(),
        cwd: canonical_cwd.to_string_lossy().into_owned().into(),
        diagnostics: None,
        detail: detail.into(),
    }
}

#[cfg(test)]
mod tests {
    use std::{
        path::PathBuf,
        sync::{
            Arc,
            atomic::{AtomicU8, AtomicUsize, Ordering},
        },
        task::Poll,
        time::Duration,
    };

    use tokio::sync::{Semaphore, mpsc, oneshot};
    use tokio_util::sync::CancellationToken;

    use super::*;
    use crate::git::{VcsStatusLocalResult, VcsStatusRemoteResult, VcsStatusResult};

    struct TestSignalSource {
        receiver: mpsc::UnboundedReceiver<GitWatchEvent>,
        health: Arc<AtomicU8>,
        observed: mpsc::UnboundedSender<GitWatchEvent>,
    }

    impl StatusSignalSource for TestSignalSource {
        async fn recv(&mut self) -> Option<GitWatchEvent> {
            let event = self.receiver.recv().await;
            if let Some(event) = event {
                let _ = self.observed.send(event);
            }
            event
        }

        fn health(&self) -> GitWatcherHealth {
            if self.health.load(Ordering::SeqCst) == 0 {
                GitWatcherHealth::Healthy
            } else {
                GitWatcherHealth::FallbackRequired
            }
        }
    }

    struct ReadOutcome {
        completed: bool,
        sender: mpsc::UnboundedSender<bool>,
    }

    impl Drop for ReadOutcome {
        fn drop(&mut self) {
            let _ = self.sender.send(self.completed);
        }
    }

    struct StatusSignalHarness {
        signals: mpsc::UnboundedSender<GitWatchEvent>,
        immediate_refreshes: watch::Sender<u64>,
        health: Arc<AtomicU8>,
        observed: mpsc::UnboundedReceiver<GitWatchEvent>,
        read_started: mpsc::UnboundedReceiver<usize>,
        read_outcome: mpsc::UnboundedReceiver<bool>,
        release_read: Arc<Semaphore>,
        cancellation: CancellationToken,
        task: tokio::task::JoinHandle<bool>,
    }

    impl StatusSignalHarness {
        async fn new(initial_read_duration: Duration, setup_fallback: bool) -> Self {
            let (signals, receiver) = mpsc::unbounded_channel();
            let health = Arc::new(AtomicU8::new(u8::from(setup_fallback)));
            let (observed_sender, observed) = mpsc::unbounded_channel();
            let (read_started_sender, read_started) = mpsc::unbounded_channel();
            let (read_outcome_sender, read_outcome) = mpsc::unbounded_channel();
            let release_read = Arc::new(Semaphore::new(0));
            let cancellation = CancellationToken::new();
            let (immediate_refreshes, immediate_refresh_receiver) = watch::channel(0);
            let (ready_sender, ready_receiver) = oneshot::channel();
            let source = TestSignalSource {
                receiver,
                health: Arc::clone(&health),
                observed: observed_sender,
            };
            let task_cancellation = cancellation.clone();
            let task_release = Arc::clone(&release_read);
            let mut read_id = 0usize;
            let task = tokio::spawn(async move {
                ready_sender.send(()).expect("scheduler ready receiver");
                run_status_signal_scheduler_with_source(
                    source,
                    setup_fallback,
                    immediate_refresh_receiver,
                    task_cancellation,
                    initial_read_duration,
                    STATUS_SAFETY_INTERVAL,
                    move || {
                        read_id += 1;
                        let read_id = read_id;
                        let read_started_sender = read_started_sender.clone();
                        let read_outcome_sender = read_outcome_sender.clone();
                        let release_read = Arc::clone(&task_release);
                        async move {
                            let mut outcome = ReadOutcome {
                                completed: false,
                                sender: read_outcome_sender,
                            };
                            read_started_sender
                                .send(read_id)
                                .expect("read start receiver");
                            release_read
                                .acquire()
                                .await
                                .expect("read release remains open")
                                .forget();
                            outcome.completed = true;
                            outcome
                        }
                    },
                )
                .await
            });
            ready_receiver.await.expect("scheduler reports ready");
            Self {
                signals,
                immediate_refreshes,
                health,
                observed,
                read_started,
                read_outcome,
                release_read,
                cancellation,
                task,
            }
        }

        fn signal(&self, event: GitWatchEvent) {
            if matches!(event, GitWatchEvent::Overflow | GitWatchEvent::Unavailable) {
                self.health.store(1, Ordering::SeqCst);
            }
            self.signals.send(event).expect("scheduler signal receiver");
        }

        fn refresh_immediately(&self) {
            self.immediate_refreshes
                .send_modify(|generation| *generation = generation.wrapping_add(1));
        }

        async fn signal_and_wait(&mut self, event: GitWatchEvent) {
            self.signal(event);
            assert_eq!(
                self.observed
                    .recv()
                    .await
                    .expect("scheduler consumes event"),
                event
            );
        }

        fn require_fallback_with_latest_ordinary_signal(&self) {
            self.health.store(1, Ordering::SeqCst);
            self.signals
                .send(GitWatchEvent::WorkingTree)
                .expect("scheduler signal receiver");
        }

        fn assert_no_read(&mut self) {
            assert!(
                self.read_started.try_recv().is_err(),
                "status read started before its exact deadline"
            );
        }

        async fn read_started(&mut self, expected: usize) {
            assert_eq!(
                self.read_started.recv().await.expect("status read starts"),
                expected
            );
        }

        async fn finish_read(&mut self) {
            self.release_read.add_permits(1);
            assert!(
                self.read_outcome
                    .recv()
                    .await
                    .expect("status read reports completion")
            );
        }

        async fn cancel(mut self) -> bool {
            self.cancellation.cancel();
            let fallback = self.task.await.expect("scheduler task joins");
            assert!(self.read_started.try_recv().is_err());
            fallback
        }
    }

    #[tokio::test(start_paused = true)]
    async fn watcher_burst_runs_once_at_the_125_ms_trailing_edge() {
        let mut harness = StatusSignalHarness::new(Duration::ZERO, false).await;
        for _ in 0..10 {
            harness.signal(GitWatchEvent::WorkingTree);
        }

        tokio::time::advance(Duration::from_millis(124)).await;
        harness.assert_no_read();
        tokio::time::advance(Duration::from_millis(1)).await;
        harness.read_started(1).await;
        harness.finish_read().await;

        assert!(!harness.cancel().await);
    }

    #[tokio::test(start_paused = true)]
    async fn watcher_signal_at_124_ms_resets_the_125_ms_debounce() {
        let mut harness = StatusSignalHarness::new(Duration::ZERO, false).await;
        harness.signal(GitWatchEvent::WorkingTree);
        tokio::time::advance(Duration::from_millis(124)).await;
        harness.signal(GitWatchEvent::Metadata);
        tokio::time::advance(Duration::from_millis(124)).await;
        harness.assert_no_read();

        tokio::time::advance(Duration::from_millis(1)).await;
        harness.read_started(1).await;
        harness.finish_read().await;

        assert!(!harness.cancel().await);
    }

    #[tokio::test(start_paused = true)]
    async fn signals_during_a_physical_read_retain_exactly_one_trailing_read() {
        let mut harness = StatusSignalHarness::new(Duration::ZERO, false).await;
        harness.signal(GitWatchEvent::WorkingTree);
        tokio::time::advance(Duration::from_millis(125)).await;
        harness.read_started(1).await;

        for _ in 0..10 {
            harness.signal(GitWatchEvent::Metadata);
        }
        tokio::time::advance(Duration::from_millis(125)).await;
        harness.assert_no_read();
        harness.finish_read().await;
        harness.read_started(2).await;
        harness.finish_read().await;
        harness.assert_no_read();

        assert!(!harness.cancel().await);
    }

    #[tokio::test(start_paused = true)]
    async fn immediate_refresh_during_a_physical_read_runs_one_trailing_read() {
        let mut harness = StatusSignalHarness::new(Duration::ZERO, true).await;
        harness.signal(GitWatchEvent::WorkingTree);
        tokio::time::advance(Duration::from_millis(125)).await;
        harness.read_started(1).await;

        harness.refresh_immediately();
        harness.finish_read().await;
        harness.read_started(2).await;
        harness.finish_read().await;
        harness.assert_no_read();

        assert!(harness.cancel().await);
    }

    #[tokio::test(start_paused = true)]
    async fn missed_watcher_event_converges_at_the_60_second_safety_deadline() {
        let mut harness = StatusSignalHarness::new(Duration::ZERO, false).await;
        tokio::time::advance(Duration::from_secs(59)).await;
        harness.assert_no_read();

        tokio::time::advance(Duration::from_secs(1)).await;
        harness.read_started(1).await;
        harness.finish_read().await;

        assert!(!harness.cancel().await);
    }

    #[tokio::test(start_paused = true)]
    async fn slow_read_caps_the_next_safety_delay_at_five_minutes_then_fast_read_resets_it() {
        let mut harness = StatusSignalHarness::new(Duration::ZERO, false).await;
        harness.signal(GitWatchEvent::WorkingTree);
        tokio::time::advance(Duration::from_millis(125)).await;
        harness.read_started(1).await;
        tokio::time::advance(Duration::from_secs(90)).await;
        harness.finish_read().await;

        tokio::time::advance(Duration::from_secs(299)).await;
        harness.assert_no_read();
        tokio::time::advance(Duration::from_secs(1)).await;
        harness.read_started(2).await;
        tokio::time::advance(Duration::from_secs(1)).await;
        harness.finish_read().await;

        tokio::time::advance(Duration::from_secs(59)).await;
        harness.assert_no_read();
        tokio::time::advance(Duration::from_secs(1)).await;
        harness.read_started(3).await;
        harness.finish_read().await;

        assert!(!harness.cancel().await);
    }

    #[tokio::test(start_paused = true)]
    async fn overflow_unavailable_and_latest_ordinary_events_keep_fallback_sticky() {
        let mut overflow = StatusSignalHarness::new(Duration::ZERO, false).await;
        overflow.signal(GitWatchEvent::Overflow);
        overflow.require_fallback_with_latest_ordinary_signal();
        tokio::time::advance(Duration::from_millis(125)).await;
        overflow.read_started(1).await;
        overflow.finish_read().await;
        assert!(overflow.cancel().await);

        let mut unavailable = StatusSignalHarness::new(Duration::ZERO, false).await;
        unavailable
            .signal_and_wait(GitWatchEvent::Unavailable)
            .await;
        assert!(unavailable.cancel().await);

        let setup_unavailable = StatusSignalHarness::new(Duration::ZERO, true).await;
        assert!(setup_unavailable.cancel().await);
    }

    #[tokio::test(start_paused = true)]
    async fn final_release_drops_the_active_read_and_reattach_has_a_fresh_scheduler() {
        let mut first = StatusSignalHarness::new(Duration::ZERO, false).await;
        first.signal(GitWatchEvent::WorkingTree);
        tokio::time::advance(Duration::from_millis(125)).await;
        first.read_started(1).await;
        first.cancellation.cancel();
        assert!(
            !first
                .read_outcome
                .recv()
                .await
                .expect("active read is dropped")
        );
        assert!(!first.task.await.expect("first scheduler joins"));

        let mut second = StatusSignalHarness::new(Duration::ZERO, false).await;
        tokio::time::advance(Duration::from_secs(59)).await;
        second.assert_no_read();
        second.signal(GitWatchEvent::Metadata);
        tokio::time::advance(Duration::from_millis(125)).await;
        second.read_started(1).await;
        second.finish_read().await;
        assert!(!second.cancel().await);
    }

    #[tokio::test]
    async fn concurrent_readers_share_one_physical_load() {
        let owner = StatusReadOwner::new();
        let key = status_key(StatusOutputKind::Full);
        let loads = Arc::new(AtomicUsize::new(0));
        let release = Arc::new(Semaphore::new(0));
        let first = spawn_blocked_full_read(
            owner.clone(),
            key.clone(),
            Arc::clone(&loads),
            Arc::clone(&release),
        );
        wait_for_loads(&loads, 1).await;
        let second = spawn_blocked_full_read(owner, key, Arc::clone(&loads), Arc::clone(&release));

        tokio::task::yield_now().await;
        assert_eq!(loads.load(Ordering::SeqCst), 1);
        release.add_permits(1);
        assert_eq!(
            first.await.expect("first read task").unwrap().value,
            clean_status()
        );
        assert_eq!(
            second.await.expect("second read task").unwrap().value,
            clean_status()
        );
    }

    #[tokio::test]
    async fn mutation_retires_the_old_read_and_signals_one_trailing_refresh() {
        let owner = StatusReadOwner::new();
        let canonical_cwd = PathBuf::from("/repo");
        let loads = Arc::new(AtomicUsize::new(0));
        let read = {
            let owner = owner.clone();
            let loads = Arc::clone(&loads);
            let canonical_cwd = canonical_cwd.clone();
            tokio::spawn(async move {
                owner
                    .read_full(
                        StatusReadKey {
                            canonical_cwd,
                            output_kind: StatusOutputKind::Full,
                        },
                        &CancellationToken::new(),
                        move |_| async move {
                            loads.fetch_add(1, Ordering::SeqCst);
                            std::future::pending().await
                        },
                    )
                    .await
            })
        };
        while loads.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
        let mut trailing_refreshes = owner.subscribe_local_refresh(&canonical_cwd);

        let mutation = owner.begin_mutation(canonical_cwd).await;

        assert!(read.await.expect("read task").is_err());
        mutation.finish().await;
        trailing_refreshes
            .changed()
            .await
            .expect("trailing refresh owner remains open");
        assert_eq!(*trailing_refreshes.borrow_and_update(), 1);
    }

    #[tokio::test]
    async fn read_admitted_during_mutation_waits_for_settlement_before_starting() {
        let owner = StatusReadOwner::new();
        let canonical_cwd = PathBuf::from("/repo");
        let key = StatusReadKey {
            canonical_cwd: canonical_cwd.clone(),
            output_kind: StatusOutputKind::Full,
        };
        let mutation = owner.begin_mutation(canonical_cwd).await;
        let loads = Arc::new(AtomicUsize::new(0));
        let mut load = Some({
            let loads = Arc::clone(&loads);
            move |_| async move {
                loads.fetch_add(1, Ordering::SeqCst);
                Ok(StatusReadValue::Full(clean_status()))
            }
        });

        let mut read_gate = match owner.try_acquire(&key, &mut load) {
            ReadAdmission::Waiting(read_gate) => read_gate,
            ReadAdmission::Lease(_) => panic!("read started while mutation was active"),
            ReadAdmission::Shutdown => panic!("active owner unexpectedly stopped"),
        };
        assert_eq!(loads.load(Ordering::SeqCst), 0);

        mutation.finish().await;
        read_gate
            .changed()
            .await
            .expect("read gate owner remains open");
        let lease = match owner.try_acquire(&key, &mut load) {
            ReadAdmission::Lease(lease) => lease,
            ReadAdmission::Waiting(_) => panic!("read remained blocked after settlement"),
            ReadAdmission::Shutdown => panic!("active owner unexpectedly stopped"),
        };
        let (value, key, epoch) = lease
            .wait(&CancellationToken::new())
            .await
            .expect("post-mutation read completes");
        let StatusReadValue::Full(value) = value else {
            panic!("full read returned local status")
        };
        let mut published = false;
        owner
            .publish_if_current(StatusReadResult { value, key, epoch }, |_| published = true)
            .expect("post-mutation read publishes");
        assert!(published);
        assert_eq!(loads.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn publication_fence_waits_for_mutation_and_rejects_the_next_epoch() {
        let owner = StatusReadOwner::new();
        let canonical_cwd = PathBuf::from("/repo");
        let mutation = owner.begin_mutation(canonical_cwd.clone()).await;
        let cancellation = CancellationToken::new();
        let mut fence = Box::pin(owner.acquire_read_fence(&canonical_cwd, &cancellation));

        assert!(matches!(futures_util::poll!(&mut fence), Poll::Pending));
        mutation.finish().await;
        let fence = fence.await.expect("post-mutation fence is admitted");
        owner
            .publish_if_fence_current(&fence, || ())
            .expect("fence is current before another mutation");

        let mutation = owner.begin_mutation(canonical_cwd).await;
        assert!(owner.publish_if_fence_current(&fence, || ()).is_err());
        mutation.finish().await;
    }

    #[tokio::test]
    async fn queued_mutations_emit_one_post_burst_refresh_and_local_load() {
        let owner = StatusReadOwner::new();
        let canonical_cwd = PathBuf::from("/repo");
        let key = StatusReadKey {
            canonical_cwd: canonical_cwd.clone(),
            output_kind: StatusOutputKind::Local,
        };
        let mut trailing_refreshes = owner.subscribe_local_refresh(&canonical_cwd);
        let first = owner.begin_mutation(canonical_cwd.clone()).await;
        let mut second = Box::pin(owner.begin_mutation(canonical_cwd));
        assert!(matches!(futures_util::poll!(&mut second), Poll::Pending));
        let loads = Arc::new(AtomicUsize::new(0));
        let mut load = Some({
            let loads = Arc::clone(&loads);
            move |_| async move {
                loads.fetch_add(1, Ordering::SeqCst);
                Ok(StatusReadValue::Local(
                    VcsStatusLocalResult::non_repository(),
                ))
            }
        });
        let mut read_gate = match owner.try_acquire(&key, &mut load) {
            ReadAdmission::Waiting(read_gate) => read_gate,
            ReadAdmission::Lease(_) => panic!("read started during first mutation"),
            ReadAdmission::Shutdown => panic!("active owner unexpectedly stopped"),
        };

        first.finish().await;
        assert!(
            !trailing_refreshes
                .has_changed()
                .expect("trailing refresh owner remains open")
        );
        assert!(
            !read_gate
                .has_changed()
                .expect("read gate owner remains open")
        );

        let second = second.await;
        assert!(!read_gate.has_changed().expect("read gate remains closed"));
        second.finish().await;
        trailing_refreshes
            .changed()
            .await
            .expect("one post-burst trailing refresh signal");
        assert_eq!(*trailing_refreshes.borrow_and_update(), 1);
        read_gate
            .changed()
            .await
            .expect("final mutation opens the read gate");
        let lease = match owner.try_acquire(&key, &mut load) {
            ReadAdmission::Lease(lease) => lease,
            ReadAdmission::Waiting(_) => panic!("read remained blocked after final mutation"),
            ReadAdmission::Shutdown => panic!("active owner unexpectedly stopped"),
        };
        lease
            .wait(&CancellationToken::new())
            .await
            .expect("post-queue read completes");
        assert_eq!(loads.load(Ordering::SeqCst), 1);
        assert!(
            !trailing_refreshes
                .has_changed()
                .expect("trailing refresh owner remains open")
        );
    }

    #[tokio::test]
    async fn canceled_queued_admission_preserves_one_post_burst_refresh_and_local_load() {
        let owner = StatusReadOwner::new();
        let canonical_cwd = PathBuf::from("/repo");
        let key = StatusReadKey {
            canonical_cwd: canonical_cwd.clone(),
            output_kind: StatusOutputKind::Local,
        };
        let mut trailing_refreshes = owner.subscribe_local_refresh(&canonical_cwd);
        let first = owner.begin_mutation(canonical_cwd.clone()).await;
        let mut cancelled = Box::pin(owner.begin_mutation(canonical_cwd));
        assert!(matches!(futures_util::poll!(&mut cancelled), Poll::Pending));
        let loads = Arc::new(AtomicUsize::new(0));
        let mut load = Some({
            let loads = Arc::clone(&loads);
            move |_| async move {
                loads.fetch_add(1, Ordering::SeqCst);
                Ok(StatusReadValue::Local(
                    VcsStatusLocalResult::non_repository(),
                ))
            }
        });
        let mut read_gate = match owner.try_acquire(&key, &mut load) {
            ReadAdmission::Waiting(read_gate) => read_gate,
            ReadAdmission::Lease(_) => panic!("read started during active mutation"),
            ReadAdmission::Shutdown => panic!("active owner unexpectedly stopped"),
        };

        drop(cancelled);
        assert!(!read_gate.has_changed().expect("read gate remains owned"));
        first.finish().await;
        trailing_refreshes
            .changed()
            .await
            .expect("one trailing refresh survives canceled admission");
        assert_eq!(*trailing_refreshes.borrow_and_update(), 1);
        read_gate
            .changed()
            .await
            .expect("read gate opens after the remaining mutation settles");

        let lease = match owner.try_acquire(&key, &mut load) {
            ReadAdmission::Lease(lease) => lease,
            ReadAdmission::Waiting(_) => panic!("read remained blocked after canceled admission"),
            ReadAdmission::Shutdown => panic!("active owner unexpectedly stopped"),
        };
        lease
            .wait(&CancellationToken::new())
            .await
            .expect("post-cancellation local read completes");
        assert_eq!(loads.load(Ordering::SeqCst), 1);
        assert!(
            !trailing_refreshes
                .has_changed()
                .expect("trailing refresh owner remains open")
        );
    }

    #[tokio::test]
    async fn local_and_full_reads_use_independent_physical_workers() {
        let owner = StatusReadOwner::new();
        let loads = Arc::new(AtomicUsize::new(0));
        let release = Arc::new(Semaphore::new(0));
        let full = spawn_blocked_full_read(
            owner.clone(),
            status_key(StatusOutputKind::Full),
            Arc::clone(&loads),
            Arc::clone(&release),
        );
        let local = spawn_blocked_local_read(
            owner,
            status_key(StatusOutputKind::Local),
            Arc::clone(&loads),
            Arc::clone(&release),
        );
        wait_for_loads(&loads, 2).await;

        release.add_permits(2);
        assert_eq!(
            full.await.expect("full read task").unwrap().value,
            clean_status()
        );
        assert_eq!(
            local.await.expect("local read task").unwrap().value,
            VcsStatusLocalResult::non_repository()
        );
    }

    #[tokio::test]
    async fn reader_after_final_release_starts_a_new_physical_load() {
        let owner = StatusReadOwner::new();
        let key = StatusReadKey {
            canonical_cwd: PathBuf::from("/repo"),
            output_kind: StatusOutputKind::Full,
        };
        let loads = Arc::new(AtomicUsize::new(0));
        let first = {
            let loads = Arc::clone(&loads);
            owner
                .acquire(
                    key.clone(),
                    &CancellationToken::new(),
                    move |_| async move {
                        loads.fetch_add(1, Ordering::SeqCst);
                        std::future::pending().await
                    },
                )
                .await
                .expect("first lease")
        };
        while loads.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
        drop(first);

        let second = {
            let loads = Arc::clone(&loads);
            owner
                .acquire(key, &CancellationToken::new(), move |_| async move {
                    loads.fetch_add(1, Ordering::SeqCst);
                    std::future::pending().await
                })
                .await
                .expect("second lease")
        };

        tokio::time::timeout(Duration::from_secs(1), async {
            while loads.load(Ordering::SeqCst) != 2 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("the replacement physical load starts");
        drop(second);
    }

    #[tokio::test]
    async fn first_caller_cancellation_preserves_the_second_lease() {
        let owner = StatusReadOwner::new();
        let key = StatusReadKey {
            canonical_cwd: PathBuf::from("/repo"),
            output_kind: StatusOutputKind::Full,
        };
        let (physical_started, physical_cancellation) = oneshot::channel();
        let first = owner
            .acquire(
                key.clone(),
                &CancellationToken::new(),
                move |cancellation| async move {
                    physical_started
                        .send(cancellation)
                        .expect("physical cancellation receiver remains open");
                    std::future::pending().await
                },
            )
            .await
            .expect("first lease");
        let second = owner
            .acquire(key, &CancellationToken::new(), |_| async move {
                panic!("the second lease must share the first physical load")
            })
            .await
            .expect("second lease");
        let physical_cancellation = physical_cancellation
            .await
            .expect("physical load publishes its cancellation token");
        let first_cancellation = CancellationToken::new();
        first_cancellation.cancel();

        assert!(first.wait(&first_cancellation).await.is_err());
        assert!(!physical_cancellation.is_cancelled());
        drop(second);
    }

    #[tokio::test]
    async fn final_lease_release_cancels_the_physical_read() {
        let owner = StatusReadOwner::new();
        let key = StatusReadKey {
            canonical_cwd: PathBuf::from("/repo"),
            output_kind: StatusOutputKind::Full,
        };
        let (physical_started, physical_cancellation) = oneshot::channel();
        let lease = owner
            .acquire(
                key,
                &CancellationToken::new(),
                move |cancellation| async move {
                    physical_started
                        .send(cancellation)
                        .expect("physical cancellation receiver remains open");
                    std::future::pending().await
                },
            )
            .await
            .expect("lease");
        let physical_cancellation = physical_cancellation
            .await
            .expect("physical load publishes its cancellation token");

        drop(lease);

        assert!(physical_cancellation.is_cancelled());
    }

    #[tokio::test]
    async fn final_lifecycle_cancellation_releases_idle_worktree_state() {
        let owner = StatusReadOwner::new();
        let cwd = PathBuf::from("/repo/retired");
        let _refresh = owner.subscribe_local_refresh(&cwd);
        assert_eq!(owner.worktree_state_count_for_test(), 1);

        owner.cancel_reads(&cwd);

        assert_eq!(owner.worktree_state_count_for_test(), 0);
    }

    #[tokio::test]
    async fn lifecycle_cancellation_releases_state_after_an_active_mutation_finishes() {
        let owner = StatusReadOwner::new();
        let cwd = PathBuf::from("/repo/mutating");
        let mutation = owner.begin_mutation(cwd.clone()).await;

        owner.cancel_reads(&cwd);
        assert_eq!(owner.worktree_state_count_for_test(), 1);

        mutation.finish().await;

        assert_eq!(owner.worktree_state_count_for_test(), 0);
    }

    #[tokio::test]
    async fn shutdown_waits_for_a_cancellation_ignoring_physical_read_to_finish() {
        let owner = StatusReadOwner::new();
        let key = status_key(StatusOutputKind::Local);
        let (physical_started, physical_started_rx) = oneshot::channel();
        let release_physical = Arc::new(Semaphore::new(0));
        let read = {
            let owner = owner.clone();
            let release_physical = Arc::clone(&release_physical);
            tokio::spawn(async move {
                owner
                    .read_local(key, &CancellationToken::new(), move |_| async move {
                        physical_started
                            .send(())
                            .expect("physical-start receiver remains open");
                        release_physical
                            .acquire()
                            .await
                            .expect("physical-finish release remains open")
                            .forget();
                        Ok(VcsStatusLocalResult::non_repository())
                    })
                    .await
            })
        };
        physical_started_rx.await.expect("physical read starts");

        let shutdown = {
            let owner = owner.clone();
            tokio::spawn(async move { owner.shutdown().await })
        };
        assert!(
            read.await.expect("status-read waiter joins").is_err(),
            "shutdown retires the subscription waiter"
        );
        assert!(
            !shutdown.is_finished(),
            "shutdown must still own the cancellation-ignoring physical worker"
        );

        release_physical.add_permits(1);
        shutdown.await.expect("status owner shutdown joins");
        let loads_after_shutdown = Arc::new(AtomicUsize::new(0));
        let loads = Arc::clone(&loads_after_shutdown);
        assert!(
            owner
                .read_local(
                    status_key(StatusOutputKind::Local),
                    &CancellationToken::new(),
                    move |_| async move {
                        loads.fetch_add(1, Ordering::SeqCst);
                        Ok(VcsStatusLocalResult::non_repository())
                    },
                )
                .await
                .is_err(),
            "closed status owner rejects new reads"
        );
        assert_eq!(loads_after_shutdown.load(Ordering::SeqCst), 0);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn shutdown_cannot_pass_an_admitted_physical_read_before_it_is_tracked() {
        let owner = StatusReadOwner::new();
        let gate = owner.install_physical_spawn_gate_for_test();
        let read = {
            let owner = owner.clone();
            tokio::spawn(async move {
                owner
                    .read_local(
                        status_key(StatusOutputKind::Local),
                        &CancellationToken::new(),
                        |_| async move { Ok(VcsStatusLocalResult::non_repository()) },
                    )
                    .await
            })
        };
        gate.wait_until_entered().await;
        let admission_remains_locked = owner.inner.state.try_lock().is_err();
        if !admission_remains_locked {
            gate.release();
            let _ = read.await;
            owner.shutdown().await;
            panic!("physical task insertion is not atomic with read admission");
        }
        let shutdown = {
            let owner = owner.clone();
            tokio::spawn(async move { owner.shutdown().await })
        };
        gate.wait_for_shutdown_attempt().await;

        if shutdown.is_finished() {
            gate.release();
            shutdown.await.expect("unfenced shutdown joins");
            let _ = read.await;
            panic!("shutdown passed an admitted read before tracker insertion");
        }

        gate.release();
        let _ = read.await.expect("status-read waiter joins");
        shutdown.await.expect("status owner shutdown joins");
    }

    fn status_key(output_kind: StatusOutputKind) -> StatusReadKey {
        StatusReadKey {
            canonical_cwd: PathBuf::from("/repo"),
            output_kind,
        }
    }

    async fn wait_for_loads(loads: &AtomicUsize, expected: usize) {
        while loads.load(Ordering::SeqCst) != expected {
            tokio::task::yield_now().await;
        }
    }

    fn spawn_blocked_full_read(
        owner: StatusReadOwner,
        key: StatusReadKey,
        loads: Arc<AtomicUsize>,
        release: Arc<Semaphore>,
    ) -> tokio::task::JoinHandle<Result<StatusReadResult<VcsStatusResult>, GitCommandError>> {
        tokio::spawn(async move {
            owner
                .read_full(key, &CancellationToken::new(), move |_| async move {
                    loads.fetch_add(1, Ordering::SeqCst);
                    release
                        .acquire()
                        .await
                        .expect("release remains open")
                        .forget();
                    Ok(clean_status())
                })
                .await
        })
    }

    fn spawn_blocked_local_read(
        owner: StatusReadOwner,
        key: StatusReadKey,
        loads: Arc<AtomicUsize>,
        release: Arc<Semaphore>,
    ) -> tokio::task::JoinHandle<Result<StatusReadResult<VcsStatusLocalResult>, GitCommandError>>
    {
        tokio::spawn(async move {
            owner
                .read_local(key, &CancellationToken::new(), move |_| async move {
                    loads.fetch_add(1, Ordering::SeqCst);
                    release
                        .acquire()
                        .await
                        .expect("release remains open")
                        .forget();
                    Ok(VcsStatusLocalResult::non_repository())
                })
                .await
        })
    }

    fn clean_status() -> VcsStatusResult {
        VcsStatusResult {
            local: VcsStatusLocalResult::non_repository(),
            remote: VcsStatusRemoteResult {
                has_upstream: false,
                ahead_count: 0,
                behind_count: 0,
                ahead_of_default_count: Some(0),
                pr: None,
            },
        }
    }
}
