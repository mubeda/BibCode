use std::{
    collections::{HashMap, HashSet},
    future::Future,
    hash::{DefaultHasher, Hash, Hasher},
    path::{Path, PathBuf},
    pin::Pin,
    sync::{Arc, Mutex, MutexGuard, Weak},
    time::Duration,
};

#[cfg(test)]
use std::sync::atomic::{AtomicUsize, Ordering};

use futures_util::{StreamExt, stream::FuturesUnordered};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use tokio::{
    sync::{Mutex as AsyncMutex, Semaphore, watch},
    task::JoinHandle,
    time::Instant,
};
use tokio_util::sync::CancellationToken;

use crate::{
    git::{
        GitRepository, GitWorktreeInventory, HostPathPlatform, normalize_worktree_path_key,
        worktree_key, worktree_repository_key,
    },
    persistence::{ProjectionThread, Repositories, WorktreeRepositoryPinOutcome},
};

use super::model::{
    AdoptedWorktreeAvailability, AdoptedWorktreeStatus, CatalogDegradedReason, CatalogError,
    CatalogErrorReason, CatalogRefreshTrigger, CatalogScanStatus, WorktreeAdoptionState,
    WorktreeCatalogSnapshot, WorktreeDescriptor, WorktreeDirectoryState, WorktreeRegistrationState,
    bounded_message,
};

pub(crate) type CatalogFuture<T> = Pin<Box<dyn Future<Output = T> + Send + 'static>>;

pub(crate) trait CatalogProjectionSource: Send + Sync {
    fn load(
        &self,
        project_id: String,
    ) -> CatalogFuture<Result<Option<CatalogProject>, CatalogError>>;
    fn pin_repository_key(
        &self,
        project_id: String,
        repository_key: String,
    ) -> CatalogFuture<Result<Option<CatalogPinOutcome>, CatalogError>>;
}

pub(crate) trait InventorySource: Send + Sync {
    fn inventory(
        &self,
        anchor: PathBuf,
        cancellation: CancellationToken,
    ) -> CatalogFuture<Result<GitWorktreeInventory, ScanFailure>>;
}

pub(crate) trait CatalogFileSystem: Send + Sync {
    fn probe(&self, path: PathBuf) -> CatalogFuture<DirectoryProbeState>;
    fn canonicalize(&self, path: PathBuf) -> CatalogFuture<Result<PathBuf, std::io::Error>>;
    fn shallow_signature(
        &self,
        common_dir: PathBuf,
        known_paths: Vec<PathBuf>,
    ) -> CatalogFuture<CatalogShallowSignature>;
}

#[derive(Clone, Debug)]
pub(crate) struct CatalogProject {
    pub workspace_root: PathBuf,
    pub baseline_paths: Vec<String>,
    pub threads: Vec<CatalogThread>,
    pub repository_key: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum CatalogPinOutcome {
    Established,
    Matched,
    Mismatch { pinned_repository_key: String },
}

#[derive(Clone, Debug)]
pub(crate) struct CatalogThread {
    pub thread_id: String,
    pub kind: String,
    pub worktree_path: Option<PathBuf>,
    pub branch: Option<String>,
    pub archived: bool,
    pub deleted: bool,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) struct CatalogShallowSignature {
    pub metadata: u64,
    pub availability: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum DirectoryProbeState {
    Present,
    Missing,
    Unknown,
}

#[derive(Clone, Debug)]
pub(crate) struct ScanFailure {
    pub reason: CatalogDegradedReason,
    pub message: String,
}

#[derive(Clone, Debug)]
pub(crate) struct CatalogServiceOptions {
    pub max_worktrees: usize,
    pub max_baseline_paths: usize,
    pub max_repository_scans: usize,
    pub max_directory_probes: usize,
    pub probe_timeout: Duration,
    pub poll_interval: Duration,
    pub result_ttl: Duration,
    pub idle_eviction: Duration,
    pub failed_retry_max: Duration,
    pub managed_creation_suppression: Duration,
}

impl Default for CatalogServiceOptions {
    fn default() -> Self {
        Self {
            max_worktrees: 512,
            max_baseline_paths: 512,
            max_repository_scans: 4,
            max_directory_probes: 8,
            probe_timeout: Duration::from_secs(1),
            poll_interval: Duration::from_secs(2),
            result_ttl: Duration::from_secs(1),
            idle_eviction: Duration::from_secs(60),
            failed_retry_max: Duration::from_secs(30),
            managed_creation_suppression: Duration::from_secs(30),
        }
    }
}

#[derive(Clone)]
pub struct WorktreeCatalogService {
    inner: Arc<Inner>,
}

struct Inner {
    projections: Arc<dyn CatalogProjectionSource>,
    inventory: Arc<dyn InventorySource>,
    filesystem: Arc<dyn CatalogFileSystem>,
    options: CatalogServiceOptions,
    scan_semaphore: Arc<Semaphore>,
    probe_semaphore: Arc<Semaphore>,
    registry: Mutex<Registry>,
    #[cfg(test)]
    final_release_pause: Mutex<Option<FinalReleasePause>>,
    #[cfg(test)]
    mutation_refresh_attempts: AtomicUsize,
}

#[cfg(test)]
struct FinalReleasePause {
    entered: Arc<std::sync::Barrier>,
    resume: Arc<std::sync::Barrier>,
}

#[derive(Default)]
struct Registry {
    aliases: HashMap<String, String>,
    entries: HashMap<String, Arc<CatalogEntry>>,
    repositories: HashMap<String, Weak<RepositoryEntry>>,
    bootstrap_locks: HashMap<String, Arc<AsyncMutex<()>>>,
    mutation_locks: HashMap<String, Weak<AsyncMutex<()>>>,
}

struct CatalogEntry {
    project_id: String,
    repository: Arc<RepositoryEntry>,
    refresh_lock: AsyncMutex<()>,
    poller_ready: watch::Sender<u64>,
    state: Mutex<EntryState>,
}

struct RepositoryEntry {
    common_dir: PathBuf,
    observation_lock: AsyncMutex<()>,
    state: Mutex<RepositoryState>,
}

struct RepositoryState {
    completed_observations: u64,
    last_result: Option<Result<Arc<CompletedObservation>, ScanError>>,
    last_result_anchor: Option<PathBuf>,
    last_result_lifecycle_epoch: Option<u64>,
    lifecycle_epoch: u64,
    subscribers: usize,
    scan_cancellation: CancellationToken,
}

impl Default for RepositoryState {
    fn default() -> Self {
        Self {
            completed_observations: 0,
            last_result: None,
            last_result_anchor: None,
            last_result_lifecycle_epoch: None,
            lifecycle_epoch: 0,
            subscribers: 0,
            scan_cancellation: CancellationToken::new(),
        }
    }
}

struct EntryState {
    snapshot: Arc<WorktreeCatalogSnapshot>,
    last_authoritative: Arc<WorktreeCatalogSnapshot>,
    sender: watch::Sender<Arc<WorktreeCatalogSnapshot>>,
    completed_at: Option<Instant>,
    completed_refreshes: u64,
    last_refresh_result: Option<Result<Arc<WorktreeCatalogSnapshot>, CatalogError>>,
    mutation_epoch: u64,
    lifecycle_epoch: u64,
    subscribers: usize,
    suppressions: HashMap<String, Instant>,
    shallow_signature: Option<CatalogShallowSignature>,
    poller: Option<OwnedTask>,
    eviction: Option<OwnedTask>,
    failure_backoff: Duration,
    next_failure_retry: Option<Instant>,
    scan_cancellation: CancellationToken,
}

pub struct CatalogSubscription {
    receiver: watch::Receiver<Arc<WorktreeCatalogSnapshot>>,
    service: WorktreeCatalogService,
    entry: Arc<CatalogEntry>,
    released: bool,
}

struct SubscriptionReservation {
    receiver: Option<watch::Receiver<Arc<WorktreeCatalogSnapshot>>>,
    service: WorktreeCatalogService,
    entry: Arc<CatalogEntry>,
    first_subscriber: bool,
    lifecycle_epoch: u64,
    committed: bool,
}

struct OwnedTask {
    cancellation: CancellationToken,
    _handle: JoinHandle<()>,
}

impl Drop for OwnedTask {
    fn drop(&mut self) {
        self.cancellation.cancel();
    }
}

#[derive(Clone)]
enum ScanError {
    Failure(ScanFailure),
    Catalog(CatalogError),
    Cancelled,
}

struct CatalogAnchor {
    path: PathBuf,
    is_primary: bool,
}

#[derive(Clone, Copy)]
struct RefreshFence {
    mutation_epoch: u64,
    lifecycle_epoch: Option<u64>,
}

impl From<CatalogError> for ScanError {
    fn from(error: CatalogError) -> Self {
        Self::Catalog(error)
    }
}

impl WorktreeCatalogService {
    #[must_use]
    pub fn new(repositories: Arc<Repositories>, repository: Arc<GitRepository>) -> Self {
        Self::with_dependencies(
            Arc::new(RepositoriesProjectionSource { repositories }),
            Arc::new(GitInventorySource { repository }),
            Arc::new(TokioCatalogFileSystem),
            CatalogServiceOptions::default(),
        )
    }

    pub(crate) fn with_dependencies(
        projections: Arc<dyn CatalogProjectionSource>,
        inventory: Arc<dyn InventorySource>,
        filesystem: Arc<dyn CatalogFileSystem>,
        options: CatalogServiceOptions,
    ) -> Self {
        let max_repository_scans = options.max_repository_scans.max(1);
        let max_directory_probes = options.max_directory_probes.max(1);
        Self {
            inner: Arc::new(Inner {
                projections,
                inventory,
                filesystem,
                options,
                scan_semaphore: Arc::new(Semaphore::new(max_repository_scans)),
                probe_semaphore: Arc::new(Semaphore::new(max_directory_probes)),
                registry: Mutex::new(Registry::default()),
                #[cfg(test)]
                final_release_pause: Mutex::new(None),
                #[cfg(test)]
                mutation_refresh_attempts: AtomicUsize::new(0),
            }),
        }
    }

    pub async fn subscribe(&self, project_id: &str) -> Result<CatalogSubscription, CatalogError> {
        let mut reservation = loop {
            let entry = self.ensure_entry(project_id).await?;
            if let Some(reservation) = self.reserve_subscription(project_id, entry) {
                break reservation;
            }
        };
        self.ensure_poller_started(project_id, &reservation.entry, reservation.lifecycle_epoch);
        if !self
            .await_poller_ready(&reservation.entry, reservation.lifecycle_epoch)
            .await
        {
            return Err(cancelled_error());
        }
        if reservation.first_subscriber {
            self.refresh(project_id, CatalogRefreshTrigger::FirstSubscriber)
                .await?;
        }
        Ok(reservation.commit())
    }

    fn reserve_subscription(
        &self,
        project_id: &str,
        entry: Arc<CatalogEntry>,
    ) -> Option<SubscriptionReservation> {
        let registry = lock(&self.inner.registry);
        if !registry
            .entries
            .get(project_id)
            .is_some_and(|candidate| Arc::ptr_eq(candidate, &entry))
        {
            return None;
        }
        let mut state = lock(&entry.state);
        if let Some(eviction) = state.eviction.take() {
            eviction.cancellation.cancel();
        }
        let first_subscriber = state.subscribers == 0;
        if first_subscriber {
            state.lifecycle_epoch = state.lifecycle_epoch.wrapping_add(1);
            state.scan_cancellation = CancellationToken::new();
        }
        let lifecycle_epoch = state.lifecycle_epoch;
        state.subscribers += 1;
        let mut repository_state = lock(&entry.repository.state);
        if repository_state.subscribers == 0 {
            repository_state.lifecycle_epoch = repository_state.lifecycle_epoch.wrapping_add(1);
            repository_state.scan_cancellation = CancellationToken::new();
        }
        repository_state.subscribers += 1;
        let receiver = state.sender.subscribe();
        drop(repository_state);
        drop(state);
        drop(registry);
        Some(SubscriptionReservation {
            receiver: Some(receiver),
            service: self.clone(),
            entry,
            first_subscriber,
            lifecycle_epoch,
            committed: false,
        })
    }

    pub async fn refresh(
        &self,
        project_id: &str,
        trigger: CatalogRefreshTrigger,
    ) -> Result<Arc<WorktreeCatalogSnapshot>, CatalogError> {
        let entry = self.ensure_entry(project_id).await?;
        let requested_at = Instant::now();
        let (completed_refreshes, cancellation, subscriber_owned, lifecycle_epoch) = {
            let state = lock(&entry.state);
            let subscriber_owned = state.subscribers != 0;
            let cancellation = if subscriber_owned {
                state.scan_cancellation.clone()
            } else {
                CancellationToken::new()
            };
            (
                state.completed_refreshes,
                cancellation,
                subscriber_owned,
                subscriber_owned.then_some(state.lifecycle_epoch),
            )
        };
        #[cfg(test)]
        if trigger == CatalogRefreshTrigger::Mutation {
            self.inner
                .mutation_refresh_attempts
                .fetch_add(1, Ordering::SeqCst);
        }
        let guard = tokio::select! {
            _ = cancellation.cancelled() => return Err(cancelled_error()),
            guard = entry.refresh_lock.lock() => guard,
        };
        let _guard = guard;
        {
            let state = lock(&entry.state);
            if state.completed_refreshes != completed_refreshes {
                let coalesced = state.last_refresh_result.clone().unwrap_or_else(|| {
                    Err(CatalogError::new(
                        CatalogErrorReason::Internal,
                        "A coalesced catalog refresh completed without a result.",
                    ))
                });
                let recover_after_stale = trigger == CatalogRefreshTrigger::Mutation
                    && matches!(
                        &coalesced,
                        Err(error) if error.reason == CatalogErrorReason::StaleGeneration
                    );
                if !recover_after_stale {
                    return coalesced;
                }
            }
            if matches!(
                trigger,
                CatalogRefreshTrigger::FirstSubscriber | CatalogRefreshTrigger::Focus
            ) && state.completed_at.is_some_and(|completed_at| {
                requested_at.duration_since(completed_at) < self.inner.options.result_ttl
            }) {
                return Ok(Arc::clone(&state.snapshot));
            }
        }
        let project = self.load_project(project_id).await?;
        if cancellation.is_cancelled() {
            return Err(cancelled_error());
        }
        let (fence, next_generation, suppressions, previous) = {
            let mut state = lock(&entry.state);
            let now = Instant::now();
            state.suppressions.retain(|_, created_at| {
                now.duration_since(*created_at) < self.inner.options.managed_creation_suppression
            });
            let refreshing = Arc::new(retained_snapshot(
                &state.last_authoritative,
                CatalogScanStatus::Refreshing,
            ));
            state.snapshot = Arc::clone(&refreshing);
            state.sender.send_replace(refreshing);
            (
                RefreshFence {
                    mutation_epoch: state.mutation_epoch,
                    lifecycle_epoch,
                },
                state.last_authoritative.generation + 1,
                state.suppressions.keys().cloned().collect::<HashSet<_>>(),
                Arc::clone(&state.last_authoritative),
            )
        };
        let anchor = match self
            .select_anchor(&project, Some(&entry.repository.common_dir), &cancellation)
            .await
        {
            Ok(Some(anchor)) => anchor,
            Ok(None) => {
                return self.publish_failure(
                    &entry,
                    fence,
                    ScanFailure {
                        reason: CatalogDegradedReason::AnchorUnavailable,
                        message: "No reachable Git catalog anchor is available.".to_owned(),
                    },
                );
            }
            Err(error) => return self.finish_scan_error(&entry, fence, error),
        };
        let observation = self
            .observe_repository(
                &entry.repository,
                anchor.path.clone(),
                project.repository_key.as_deref(),
                &cancellation,
            )
            .await;
        let observation = match observation {
            Ok(observation) => observation,
            Err(error) => return self.finish_scan_error(&entry, fence, error),
        };
        if cancellation.is_cancelled() {
            return self.finish_cancelled(&entry, fence);
        }
        if let Err(error) = self
            .verify_or_establish_repository_key(
                project_id,
                &project,
                &anchor,
                &observation.repository_key,
            )
            .await
        {
            self.restore_after_catalog_error(&entry, fence, &error)?;
            return Err(error);
        }
        let snapshot = match self
            .snapshot_from_observation(
                &project,
                &observation,
                next_generation,
                Some(&previous),
                &suppressions,
                &cancellation,
            )
            .await
        {
            Ok(snapshot) => snapshot,
            Err(error) => return self.finish_scan_error(&entry, fence, error),
        };
        let Some(signature) = self
            .signature_for_snapshot(&entry.repository.common_dir, &snapshot, &cancellation)
            .await
        else {
            return self.finish_cancelled(&entry, fence);
        };
        {
            let mut state = lock(&entry.state);
            if fence
                .lifecycle_epoch
                .is_some_and(|epoch| epoch != state.lifecycle_epoch)
            {
                return Err(cancelled_error());
            }
            if state.mutation_epoch != fence.mutation_epoch {
                return Self::complete_stale_generation(&mut state);
            }
            if subscriber_owned && (state.subscribers == 0 || cancellation.is_cancelled()) {
                let error = cancelled_error();
                state.completed_at = None;
                state.completed_refreshes = state.completed_refreshes.wrapping_add(1);
                state.last_refresh_result = Some(Err(error.clone()));
                return Err(error);
            }
            state.snapshot = Arc::clone(&snapshot);
            state.last_authoritative = Arc::clone(&snapshot);
            state.completed_at = Some(Instant::now());
            state.completed_refreshes = state.completed_refreshes.wrapping_add(1);
            state.last_refresh_result = Some(Ok(Arc::clone(&snapshot)));
            state.shallow_signature = Some(signature);
            state.failure_backoff = Duration::ZERO;
            state.next_failure_retry = None;
            state.sender.send_replace(Arc::clone(&snapshot));
        }
        Ok(snapshot)
    }

    pub async fn latest(&self, project_id: &str) -> Option<Arc<WorktreeCatalogSnapshot>> {
        let entry = self.entry_for_project(project_id)?;
        Some(Arc::clone(&lock(&entry.state).snapshot))
    }

    pub async fn invalidate_after_mutation(&self, project_id: &str) {
        let Some(entry) = self.entry_for_project(project_id) else {
            return;
        };
        let refresh = {
            let mut state = lock(&entry.state);
            state.mutation_epoch = state.mutation_epoch.wrapping_add(1);
            state.completed_at = None;
            if !state.snapshot.authoritative {
                let restored = Arc::clone(&state.last_authoritative);
                state.snapshot = Arc::clone(&restored);
                state.sender.send_replace(restored);
            }
            state.subscribers > 0
        };
        if refresh {
            let service = self.clone();
            let project_id = project_id.to_owned();
            tokio::spawn(async move {
                let _ = service
                    .refresh(&project_id, CatalogRefreshTrigger::Mutation)
                    .await;
            });
        }
    }

    pub async fn note_managed_creation(&self, project_id: &str, path: &Path) {
        let Some(entry) = self.entry_for_project(project_id) else {
            return;
        };
        let path = normalize_worktree_path_key(path, host_platform());
        lock(&entry.state).suppressions.insert(path, Instant::now());
    }

    pub async fn with_project_mutation_lock<T, F, Fut>(&self, project_id: &str, operation: F) -> T
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = T>,
    {
        let lock_key = self
            .load_project(project_id)
            .await
            .ok()
            .and_then(|project| project.repository_key)
            .or_else(|| lock(&self.inner.registry).aliases.get(project_id).cloned())
            .unwrap_or_else(|| format!("unresolved-project:{project_id}"));
        let mutation_lock = {
            let mut registry = lock(&self.inner.registry);
            registry
                .mutation_locks
                .retain(|_, mutation_lock| mutation_lock.strong_count() > 0);
            registry
                .mutation_locks
                .get(&lock_key)
                .and_then(Weak::upgrade)
                .unwrap_or_else(|| {
                    let mutation_lock = Arc::new(AsyncMutex::new(()));
                    registry
                        .mutation_locks
                        .insert(lock_key, Arc::downgrade(&mutation_lock));
                    mutation_lock
                })
        };
        let _guard = mutation_lock.lock().await;
        operation().await
    }

    async fn ensure_entry(&self, project_id: &str) -> Result<Arc<CatalogEntry>, CatalogError> {
        if let Some(entry) = self.entry_for_project(project_id) {
            return Ok(entry);
        }
        let bootstrap_lock = {
            let mut registry = lock(&self.inner.registry);
            Arc::clone(
                registry
                    .bootstrap_locks
                    .entry(project_id.to_owned())
                    .or_insert_with(|| Arc::new(AsyncMutex::new(()))),
            )
        };
        let guard = bootstrap_lock.lock().await;
        if let Some(entry) = self.entry_for_project(project_id) {
            drop(guard);
            self.remove_bootstrap_lock_if_idle(project_id, &bootstrap_lock);
            return Ok(entry);
        }
        let result = async {
            let project = self.load_project(project_id).await?;
            let cancellation = CancellationToken::new();
            let anchor = self
                .select_anchor(&project, None, &cancellation)
                .await
                .map_err(scan_error_for_bootstrap)?
                .ok_or_else(|| {
                    CatalogError::new(
                        CatalogErrorReason::RepositoryUnavailable,
                        "No reachable Git catalog anchor is available.",
                    )
                })?;
            let suppressions = HashSet::new();
            let scan = self
                .scan(
                    &project,
                    anchor.path.clone(),
                    ScanRequest {
                        expected_repository_key: project.repository_key.as_deref(),
                        generation: 1,
                        previous: None,
                        suppressions: &suppressions,
                        cancellation,
                    },
                )
                .await
                .map_err(scan_error_for_bootstrap)?;
            self.verify_or_establish_repository_key(
                project_id,
                &project,
                &anchor,
                &scan.repository_key,
            )
            .await?;
            let mut registry = lock(&self.inner.registry);
            registry
                .repositories
                .retain(|_, repository| repository.strong_count() > 0);
            let repository = registry
                .repositories
                .get(&scan.repository_key)
                .and_then(Weak::upgrade)
                .unwrap_or_else(|| {
                    let repository = Arc::new(RepositoryEntry {
                        common_dir: scan.common_dir.clone(),
                        observation_lock: AsyncMutex::new(()),
                        state: Mutex::new(RepositoryState::default()),
                    });
                    registry
                        .repositories
                        .insert(scan.repository_key.clone(), Arc::downgrade(&repository));
                    repository
                });
            let (sender, _) = watch::channel(Arc::clone(&scan.snapshot));
            let (poller_ready, _) = watch::channel(0);
            let entry = Arc::new(CatalogEntry {
                project_id: project_id.to_owned(),
                repository,
                refresh_lock: AsyncMutex::new(()),
                poller_ready,
                state: Mutex::new(EntryState {
                    snapshot: Arc::clone(&scan.snapshot),
                    last_authoritative: Arc::clone(&scan.snapshot),
                    sender,
                    completed_at: Some(Instant::now()),
                    completed_refreshes: 0,
                    last_refresh_result: None,
                    mutation_epoch: 0,
                    lifecycle_epoch: 0,
                    subscribers: 0,
                    suppressions: HashMap::new(),
                    shallow_signature: None,
                    poller: None,
                    eviction: None,
                    failure_backoff: Duration::ZERO,
                    next_failure_retry: None,
                    scan_cancellation: CancellationToken::new(),
                }),
            });
            registry
                .entries
                .insert(project_id.to_owned(), Arc::clone(&entry));
            registry
                .aliases
                .insert(project_id.to_owned(), scan.repository_key);
            Ok(entry)
        }
        .await;
        drop(guard);
        self.remove_bootstrap_lock_if_idle(project_id, &bootstrap_lock);
        result
    }

    async fn load_project(&self, project_id: &str) -> Result<CatalogProject, CatalogError> {
        let project = self
            .inner
            .projections
            .load(project_id.to_owned())
            .await?
            .ok_or_else(|| {
                CatalogError::new(
                    CatalogErrorReason::ProjectNotFound,
                    format!("Project '{project_id}' was not found."),
                )
            })?;
        if project.baseline_paths.len() > self.inner.options.max_baseline_paths {
            return Err(CatalogError::new(
                CatalogErrorReason::Internal,
                "The project worktree baseline exceeds 512 entries.",
            ));
        }
        Ok(project)
    }

    fn remove_bootstrap_lock_if_idle(&self, project_id: &str, project_lock: &Arc<AsyncMutex<()>>) {
        let mut registry = lock(&self.inner.registry);
        let locks = &mut registry.bootstrap_locks;
        if locks
            .get(project_id)
            .is_some_and(|candidate| Arc::ptr_eq(candidate, project_lock))
            && Arc::strong_count(project_lock) == 2
        {
            locks.remove(project_id);
        }
    }

    async fn select_anchor(
        &self,
        project: &CatalogProject,
        lifetime_common_dir: Option<&Path>,
        cancellation: &CancellationToken,
    ) -> Result<Option<CatalogAnchor>, ScanError> {
        if self.probe(&project.workspace_root, cancellation).await? == DirectoryProbeState::Present
        {
            return Ok(Some(CatalogAnchor {
                path: project.workspace_root.clone(),
                is_primary: true,
            }));
        }
        if project.repository_key.is_none() {
            return Ok(None);
        }
        for thread in canonical_threads(project) {
            let Some(path) = &thread.worktree_path else {
                continue;
            };
            if self.probe(path, cancellation).await? == DirectoryProbeState::Present {
                return Ok(Some(CatalogAnchor {
                    path: path.clone(),
                    is_primary: false,
                }));
            }
        }
        if let Some(common_dir) = lifetime_common_dir
            && self.probe(common_dir, cancellation).await? == DirectoryProbeState::Present
        {
            return Ok(Some(CatalogAnchor {
                path: common_dir.to_path_buf(),
                is_primary: false,
            }));
        }
        Ok(None)
    }

    async fn verify_or_establish_repository_key(
        &self,
        project_id: &str,
        project: &CatalogProject,
        anchor: &CatalogAnchor,
        observed_repository_key: &str,
    ) -> Result<(), CatalogError> {
        if let Some(pinned_repository_key) = project.repository_key.as_deref() {
            if pinned_repository_key == observed_repository_key {
                return Ok(());
            }
            return Err(CatalogError::new(
                CatalogErrorReason::RepositoryUnavailable,
                "The scan anchor does not match the project's durable repository identity.",
            ));
        }
        if !anchor.is_primary {
            return Err(CatalogError::new(
                CatalogErrorReason::RepositoryUnavailable,
                "An unpinned project requires its primary checkout to establish repository identity.",
            ));
        }
        match self
            .inner
            .projections
            .pin_repository_key(project_id.to_owned(), observed_repository_key.to_owned())
            .await?
        {
            Some(CatalogPinOutcome::Established | CatalogPinOutcome::Matched) => Ok(()),
            Some(CatalogPinOutcome::Mismatch { .. }) => Err(CatalogError::new(
                CatalogErrorReason::RepositoryUnavailable,
                "The authoritative primary scan raced with a different durable repository identity.",
            )),
            None => Err(CatalogError::new(
                CatalogErrorReason::ProjectNotFound,
                format!("Project '{project_id}' was not found while pinning repository identity."),
            )),
        }
    }

    async fn scan(
        &self,
        project: &CatalogProject,
        anchor: PathBuf,
        request: ScanRequest<'_>,
    ) -> Result<CompletedScan, ScanError> {
        let ScanRequest {
            expected_repository_key,
            generation,
            previous,
            suppressions,
            cancellation,
        } = request;
        let observation = self
            .observe(anchor, expected_repository_key, cancellation.clone())
            .await?;
        let snapshot = self
            .snapshot_from_observation(
                project,
                &observation,
                generation,
                previous,
                suppressions,
                &cancellation,
            )
            .await?;
        Ok(CompletedScan {
            repository_key: observation.repository_key.clone(),
            common_dir: observation.common_dir.clone(),
            snapshot,
        })
    }

    async fn observe(
        &self,
        anchor: PathBuf,
        expected_repository_key: Option<&str>,
        cancellation: CancellationToken,
    ) -> Result<CompletedObservation, ScanError> {
        let permit = tokio::select! {
            _ = cancellation.cancelled() => return Err(ScanError::Cancelled),
            permit = self.inner.scan_semaphore.acquire() => permit,
        };
        let _permit = permit.map_err(|_| {
            CatalogError::new(CatalogErrorReason::Internal, "Catalog is shutting down.")
        })?;
        let inventory_result = self
            .inner
            .inventory
            .inventory(anchor, cancellation.clone())
            .await;
        if cancellation.is_cancelled() {
            return Err(ScanError::Cancelled);
        }
        let inventory = inventory_result.map_err(ScanError::Failure)?;
        if inventory.records.len() > self.inner.options.max_worktrees {
            return Err(ScanError::Failure(ScanFailure {
                reason: CatalogDegradedReason::OutputLimit,
                message: "Git reported more than 512 worktrees.".to_owned(),
            }));
        }
        let canonicalization = tokio::select! {
            _ = cancellation.cancelled() => return Err(ScanError::Cancelled),
            result = self.inner.filesystem.canonicalize(inventory.common_dir.clone()) => result,
        };
        let common_dir = canonicalization.map_err(|error| {
            ScanError::Failure(ScanFailure {
                reason: CatalogDegradedReason::AnchorUnavailable,
                message: bounded_message(format!(
                    "The common Git directory could not be canonicalized: {error}"
                )),
            })
        })?;
        let platform = host_platform();
        let repository_key = worktree_repository_key(&common_dir, platform)
            .as_str()
            .to_owned();
        if expected_repository_key.is_some_and(|expected| expected != repository_key) {
            return Err(ScanError::Catalog(CatalogError::new(
                CatalogErrorReason::RepositoryUnavailable,
                "The scan anchor resolved to a different Git repository.",
            )));
        }
        Ok(CompletedObservation {
            repository_key,
            common_dir,
            inventory,
        })
    }

    async fn snapshot_from_observation(
        &self,
        project: &CatalogProject,
        observation: &CompletedObservation,
        generation: u64,
        previous: Option<&WorktreeCatalogSnapshot>,
        suppressions: &HashSet<String>,
        cancellation: &CancellationToken,
    ) -> Result<Arc<WorktreeCatalogSnapshot>, ScanError> {
        Ok(Arc::new(
            self.join_snapshot(
                project,
                &observation.inventory,
                SnapshotJoin {
                    common_dir: &observation.common_dir,
                    repository_key: observation.repository_key.clone(),
                    generation,
                    previous,
                    suppressions,
                    cancellation,
                },
            )
            .await?,
        ))
    }

    async fn observe_repository(
        &self,
        repository: &RepositoryEntry,
        anchor: PathBuf,
        expected_repository_key: Option<&str>,
        caller_cancellation: &CancellationToken,
    ) -> Result<Arc<CompletedObservation>, ScanError> {
        let (completed_observations, lifecycle_epoch) = {
            let state = lock(&repository.state);
            (state.completed_observations, state.lifecycle_epoch)
        };
        let guard = tokio::select! {
            _ = caller_cancellation.cancelled() => return Err(ScanError::Cancelled),
            guard = repository.observation_lock.lock() => guard,
        };
        let _guard = guard;
        if caller_cancellation.is_cancelled() {
            return Err(ScanError::Cancelled);
        }
        {
            let state = lock(&repository.state);
            if state.lifecycle_epoch != lifecycle_epoch {
                return Err(ScanError::Cancelled);
            }
            if state.completed_observations != completed_observations
                && state.last_result_lifecycle_epoch == Some(lifecycle_epoch)
                && state.last_result_anchor.as_ref() == Some(&anchor)
            {
                return state.last_result.clone().unwrap_or_else(|| {
                    Err(ScanError::Catalog(CatalogError::new(
                        CatalogErrorReason::Internal,
                        "A shared repository observation completed without a result.",
                    )))
                });
            }
        }
        let cancellation = {
            let state = lock(&repository.state);
            if state.subscribers == 0 {
                caller_cancellation.clone()
            } else {
                state.scan_cancellation.clone()
            }
        };
        let result = self
            .observe(anchor.clone(), expected_repository_key, cancellation)
            .await
            .map(Arc::new);
        let mut state = lock(&repository.state);
        if state.lifecycle_epoch == lifecycle_epoch {
            state.completed_observations = state.completed_observations.wrapping_add(1);
            state.last_result = Some(result.clone());
            state.last_result_anchor = Some(anchor);
            state.last_result_lifecycle_epoch = Some(lifecycle_epoch);
        }
        result
    }

    async fn join_snapshot(
        &self,
        project: &CatalogProject,
        inventory: &GitWorktreeInventory,
        request: SnapshotJoin<'_>,
    ) -> Result<WorktreeCatalogSnapshot, ScanError> {
        let SnapshotJoin {
            common_dir,
            repository_key,
            generation,
            previous,
            suppressions,
            cancellation,
        } = request;
        let platform = host_platform();
        let mut thread_paths: HashMap<String, Vec<&CatalogThread>> = HashMap::new();
        for thread in canonical_threads(project) {
            if let Some(path) = &thread.worktree_path {
                thread_paths
                    .entry(normalize_worktree_path_key(path, platform))
                    .or_default()
                    .push(thread);
            }
        }
        let mut pending_probes = FuturesUnordered::new();
        for path in inventory
            .records
            .iter()
            .map(|record| record.path.clone())
            .chain(canonical_threads(project).filter_map(|thread| thread.worktree_path.clone()))
            .collect::<HashSet<_>>()
        {
            let service = self.clone();
            let cancellation = cancellation.clone();
            pending_probes.push(async move {
                let state = service.probe(&path, &cancellation).await;
                (path, state)
            });
        }
        let mut directory_probes = HashMap::new();
        while let Some((path, state)) = pending_probes.next().await {
            directory_probes.insert(path, state?);
        }
        if thread_paths.values().any(|threads| threads.len() > 1) {
            return Err(ScanError::Catalog(CatalogError::new(
                CatalogErrorReason::Internal,
                "Multiple canonical workspace threads claim the same worktree path.",
            )));
        }

        let mut worktrees = Vec::with_capacity(inventory.records.len());
        let mut matched_threads = HashSet::new();
        for record in &inventory.records {
            let directory_probe = directory_probes
                .get(&record.path)
                .copied()
                .unwrap_or(DirectoryProbeState::Unknown);
            let resolved_path = if directory_probe == DirectoryProbeState::Present {
                self.inner
                    .filesystem
                    .canonicalize(record.path.clone())
                    .await
                    .ok()
            } else {
                None
            };
            let normalized_path = normalize_worktree_path_key(
                resolved_path.as_deref().unwrap_or(record.path.as_path()),
                platform,
            );
            let reported_path = normalize_worktree_path_key(&record.path, platform);
            let record_worktree_key = worktree_key(
                common_dir,
                resolved_path.as_deref().unwrap_or(record.path.as_path()),
                platform,
            )
            .as_str()
            .to_owned();
            let owner = thread_paths
                .get(&normalized_path)
                .or_else(|| thread_paths.get(&reported_path))
                .and_then(|threads| threads.first())
                .copied()
                .or_else(|| {
                    let prior_thread_id = previous?
                        .adopted_workspaces
                        .iter()
                        .find(|workspace| {
                            workspace.worktree_key.as_deref() == Some(record_worktree_key.as_str())
                        })?
                        .thread_id
                        .as_str();
                    canonical_threads(project).find(|thread| thread.thread_id == prior_thread_id)
                });
            if let Some(owner) = owner {
                matched_threads.insert(owner.thread_id.clone());
            }
            let directory_state = match directory_probe {
                DirectoryProbeState::Present if resolved_path.is_some() => {
                    WorktreeDirectoryState::Present
                }
                DirectoryProbeState::Present | DirectoryProbeState::Unknown => {
                    WorktreeDirectoryState::Unknown
                }
                DirectoryProbeState::Missing => WorktreeDirectoryState::Missing,
            };
            let registration_state = if record.is_prunable {
                WorktreeRegistrationState::Prunable
            } else {
                WorktreeRegistrationState::Registered
            };
            let adoption_state = match owner {
                Some(thread) if thread.archived => WorktreeAdoptionState::Archived,
                Some(_) => WorktreeAdoptionState::Active,
                None => WorktreeAdoptionState::None,
            };
            let eligible_for_adoption = registration_state == WorktreeRegistrationState::Registered
                && directory_state == WorktreeDirectoryState::Present
                && !record.is_primary
                && !record.is_bare
                && owner.is_none()
                && !suppressions.contains(&normalized_path);
            worktrees.push(WorktreeDescriptor {
                worktree_key: record_worktree_key,
                path: normalized_path,
                branch: record.branch.clone(),
                head: record.head.clone(),
                is_primary: record.is_primary,
                is_bare: record.is_bare,
                locked: record.locked,
                lock_reason: record.lock_reason.clone(),
                registration_state,
                directory_state,
                adoption_state,
                adopted_thread_id: owner.map(|thread| thread.thread_id.clone()),
                eligible_for_adoption,
            });
        }

        let mut adopted_workspaces = Vec::new();
        for thread in canonical_threads(project) {
            let Some(path) = &thread.worktree_path else {
                continue;
            };
            let normalized = normalize_worktree_path_key(path, platform);
            let descriptor = worktrees.iter().find(|descriptor| {
                descriptor.adopted_thread_id.as_deref() == Some(thread.thread_id.as_str())
                    || descriptor.path == normalized
            });
            let status = if let Some(descriptor) = descriptor {
                AdoptedWorktreeStatus {
                    thread_id: thread.thread_id.clone(),
                    worktree_key: Some(descriptor.worktree_key.clone()),
                    path: descriptor.path.clone(),
                    branch: descriptor.branch.clone().or_else(|| thread.branch.clone()),
                    availability: match descriptor.directory_state {
                        WorktreeDirectoryState::Present => AdoptedWorktreeAvailability::Present,
                        WorktreeDirectoryState::Missing => {
                            AdoptedWorktreeAvailability::MissingRegistered
                        }
                        WorktreeDirectoryState::Unknown => previous
                            .and_then(|snapshot| {
                                snapshot
                                    .adopted_workspaces
                                    .iter()
                                    .find(|workspace| workspace.thread_id == thread.thread_id)
                            })
                            .map_or(
                                AdoptedWorktreeAvailability::VerificationUnavailable,
                                |workspace| workspace.availability,
                            ),
                    },
                    registration_state: Some(descriptor.registration_state),
                    locked: descriptor.locked,
                    lock_reason: descriptor.lock_reason.clone(),
                }
            } else {
                AdoptedWorktreeStatus {
                    thread_id: thread.thread_id.clone(),
                    worktree_key: None,
                    path: normalized,
                    branch: thread.branch.clone(),
                    availability: AdoptedWorktreeAvailability::MissingUnregistered,
                    registration_state: None,
                    locked: false,
                    lock_reason: None,
                }
            };
            adopted_workspaces.push(status);
        }
        if adopted_workspaces.len() > self.inner.options.max_worktrees {
            return Err(ScanError::Catalog(CatalogError::new(
                CatalogErrorReason::Internal,
                "More than 512 adopted workspaces belong to this project.",
            )));
        }
        Ok(WorktreeCatalogSnapshot {
            repository_key,
            generation,
            authoritative: true,
            observed_at: now_iso(),
            scan_status: CatalogScanStatus::Ready,
            worktrees,
            adopted_workspaces,
        })
    }

    async fn probe(
        &self,
        path: &Path,
        cancellation: &CancellationToken,
    ) -> Result<DirectoryProbeState, ScanError> {
        let permit = tokio::select! {
            _ = cancellation.cancelled() => return Err(ScanError::Cancelled),
            permit = self.inner.probe_semaphore.acquire() => permit,
        };
        let Ok(_permit) = permit else {
            return Ok(DirectoryProbeState::Unknown);
        };
        tokio::select! {
            _ = cancellation.cancelled() => Err(ScanError::Cancelled),
            result = tokio::time::timeout(
                self.inner.options.probe_timeout,
                self.inner.filesystem.probe(path.to_path_buf()),
            ) => Ok(result.unwrap_or(DirectoryProbeState::Unknown)),
        }
    }

    fn entry_for_project(&self, project_id: &str) -> Option<Arc<CatalogEntry>> {
        lock(&self.inner.registry).entries.get(project_id).cloned()
    }

    fn publish_failure(
        &self,
        entry: &CatalogEntry,
        fence: RefreshFence,
        failure: ScanFailure,
    ) -> Result<Arc<WorktreeCatalogSnapshot>, CatalogError> {
        let mut state = lock(&entry.state);
        if fence
            .lifecycle_epoch
            .is_some_and(|epoch| epoch != state.lifecycle_epoch)
        {
            return Err(cancelled_error());
        }
        if state.mutation_epoch != fence.mutation_epoch {
            return Self::complete_stale_generation(&mut state);
        }
        let failed_at = now_iso();
        let snapshot = Arc::new(retained_snapshot(
            &state.last_authoritative,
            CatalogScanStatus::Degraded {
                reason: failure.reason,
                message: bounded_message(failure.message),
                failed_at,
                last_authoritative_at: Some(state.last_authoritative.observed_at.clone()),
            },
        ));
        state.failure_backoff = if state.failure_backoff.is_zero() {
            self.inner.options.poll_interval
        } else {
            state
                .failure_backoff
                .saturating_mul(2)
                .min(self.inner.options.failed_retry_max)
        };
        state.next_failure_retry = Some(Instant::now() + state.failure_backoff);
        state.completed_at = Some(Instant::now());
        state.completed_refreshes = state.completed_refreshes.wrapping_add(1);
        state.snapshot = Arc::clone(&snapshot);
        state.last_refresh_result = Some(Ok(Arc::clone(&snapshot)));
        state.sender.send_replace(Arc::clone(&snapshot));
        Ok(snapshot)
    }

    fn restore_after_catalog_error(
        &self,
        entry: &CatalogEntry,
        fence: RefreshFence,
        error: &CatalogError,
    ) -> Result<(), CatalogError> {
        let mut state = lock(&entry.state);
        if fence
            .lifecycle_epoch
            .is_some_and(|epoch| epoch != state.lifecycle_epoch)
        {
            return Err(cancelled_error());
        }
        if state.mutation_epoch != fence.mutation_epoch {
            return Self::complete_stale_generation(&mut state).map(|_| ());
        }
        let restored = if error.reason == CatalogErrorReason::RepositoryUnavailable {
            Arc::new(retained_snapshot(
                &state.last_authoritative,
                CatalogScanStatus::Degraded {
                    reason: CatalogDegradedReason::AnchorUnavailable,
                    message: error.message.clone(),
                    failed_at: now_iso(),
                    last_authoritative_at: Some(state.last_authoritative.observed_at.clone()),
                },
            ))
        } else {
            Arc::clone(&state.last_authoritative)
        };
        state.snapshot = Arc::clone(&restored);
        state.completed_at = Some(Instant::now());
        state.completed_refreshes = state.completed_refreshes.wrapping_add(1);
        state.last_refresh_result = Some(Err(error.clone()));
        state.sender.send_replace(restored);
        Ok(())
    }

    fn finish_cancelled(
        &self,
        entry: &CatalogEntry,
        fence: RefreshFence,
    ) -> Result<Arc<WorktreeCatalogSnapshot>, CatalogError> {
        let error = cancelled_error();
        let mut state = lock(&entry.state);
        if fence
            .lifecycle_epoch
            .is_some_and(|epoch| epoch != state.lifecycle_epoch)
        {
            return Err(error);
        }
        if state.mutation_epoch != fence.mutation_epoch {
            return Self::complete_stale_generation(&mut state);
        }
        state.completed_at = None;
        state.completed_refreshes = state.completed_refreshes.wrapping_add(1);
        state.last_refresh_result = Some(Err(error.clone()));
        Err(error)
    }

    fn finish_scan_error(
        &self,
        entry: &CatalogEntry,
        fence: RefreshFence,
        error: ScanError,
    ) -> Result<Arc<WorktreeCatalogSnapshot>, CatalogError> {
        match error {
            ScanError::Failure(failure) => self.publish_failure(entry, fence, failure),
            ScanError::Catalog(error) => {
                self.restore_after_catalog_error(entry, fence, &error)?;
                Err(error)
            }
            ScanError::Cancelled => self.finish_cancelled(entry, fence),
        }
    }

    fn complete_stale_generation(
        state: &mut EntryState,
    ) -> Result<Arc<WorktreeCatalogSnapshot>, CatalogError> {
        let error = CatalogError::new(
            CatalogErrorReason::StaleGeneration,
            "A catalog mutation invalidated this in-flight refresh.",
        );
        state.completed_at = None;
        state.completed_refreshes = state.completed_refreshes.wrapping_add(1);
        state.last_refresh_result = Some(Err(error.clone()));
        Err(error)
    }

    async fn signature_for_snapshot(
        &self,
        common_dir: &Path,
        snapshot: &WorktreeCatalogSnapshot,
        cancellation: &CancellationToken,
    ) -> Option<CatalogShallowSignature> {
        let known_paths = snapshot
            .worktrees
            .iter()
            .map(|worktree| PathBuf::from(&worktree.path))
            .chain(
                snapshot
                    .adopted_workspaces
                    .iter()
                    .map(|workspace| PathBuf::from(&workspace.path)),
            )
            .collect();
        tokio::select! {
            _ = cancellation.cancelled() => None,
            signature = self.inner.filesystem.shallow_signature(
                common_dir.to_path_buf(),
                known_paths,
            ) => Some(signature),
        }
    }

    fn ensure_poller_started(
        &self,
        project_id: &str,
        entry: &Arc<CatalogEntry>,
        lifecycle_epoch: u64,
    ) {
        let mut state = lock(&entry.state);
        if state.lifecycle_epoch != lifecycle_epoch
            || state.subscribers == 0
            || state.poller.is_some()
        {
            return;
        }
        let snapshot = Arc::clone(&state.last_authoritative);
        let cancellation = CancellationToken::new();
        let weak_inner = Arc::downgrade(&self.inner);
        let weak_entry = Arc::downgrade(entry);
        let project_id = project_id.to_owned();
        let task_cancellation = cancellation.clone();
        let poll_interval = self.inner.options.poll_interval;
        let handle = tokio::spawn(async move {
            let (Some(inner), Some(entry)) = (weak_inner.upgrade(), weak_entry.upgrade()) else {
                return;
            };
            let service = WorktreeCatalogService { inner };
            let Some(signature) = service
                .signature_for_snapshot(&entry.repository.common_dir, &snapshot, &task_cancellation)
                .await
            else {
                return;
            };
            {
                let mut state = lock(&entry.state);
                if state.lifecycle_epoch != lifecycle_epoch
                    || state.subscribers == 0
                    || task_cancellation.is_cancelled()
                {
                    return;
                }
                state.shallow_signature = Some(signature);
            }
            entry.poller_ready.send_replace(lifecycle_epoch);
            loop {
                tokio::select! {
                    _ = task_cancellation.cancelled() => break,
                    _ = tokio::time::sleep(poll_interval) => {}
                }
                let snapshot = Arc::clone(&lock(&entry.state).last_authoritative);
                let Some(observed) = service
                    .signature_for_snapshot(
                        &entry.repository.common_dir,
                        &snapshot,
                        &task_cancellation,
                    )
                    .await
                else {
                    break;
                };
                let trigger = {
                    let mut state = lock(&entry.state);
                    if state.lifecycle_epoch != lifecycle_epoch || state.subscribers == 0 {
                        break;
                    }
                    let previous = state.shallow_signature.replace(observed);
                    let retry_due = state
                        .next_failure_retry
                        .is_some_and(|deadline| Instant::now() >= deadline);
                    match previous {
                        Some(previous) if previous.metadata != observed.metadata => {
                            Some(CatalogRefreshTrigger::MetadataChanged)
                        }
                        Some(previous) if previous.availability != observed.availability => {
                            Some(CatalogRefreshTrigger::AvailabilityChanged)
                        }
                        _ if retry_due => Some(CatalogRefreshTrigger::MetadataChanged),
                        _ => None,
                    }
                };
                if let Some(trigger) = trigger {
                    let _ = service.refresh(&project_id, trigger).await;
                }
            }
        });
        state.poller = Some(OwnedTask {
            cancellation,
            _handle: handle,
        });
    }

    async fn await_poller_ready(&self, entry: &Arc<CatalogEntry>, lifecycle_epoch: u64) -> bool {
        let mut ready = entry.poller_ready.subscribe();
        loop {
            if *ready.borrow() == lifecycle_epoch {
                return true;
            }
            {
                let state = lock(&entry.state);
                if state.lifecycle_epoch != lifecycle_epoch || state.subscribers == 0 {
                    return false;
                }
            }
            self.ensure_poller_started(&entry.project_id, entry, lifecycle_epoch);
            if ready.changed().await.is_err() {
                return false;
            }
        }
    }

    fn release(&self, entry: &Arc<CatalogEntry>) {
        let should_evict = {
            let mut state = lock(&entry.state);
            if state.subscribers == 0 {
                return;
            }
            state.subscribers -= 1;
            let final_subscriber = state.subscribers == 0;
            if final_subscriber {
                if let Some(poller) = state.poller.take() {
                    poller.cancellation.cancel();
                }
                state.scan_cancellation.cancel();
                state.completed_at = None;
            }
            #[cfg(test)]
            self.pause_final_release_for_test(final_subscriber);
            let mut repository_state = lock(&entry.repository.state);
            repository_state.subscribers = repository_state.subscribers.saturating_sub(1);
            if repository_state.subscribers == 0 {
                repository_state.scan_cancellation.cancel();
            }
            final_subscriber
        };
        if !should_evict {
            return;
        }
        let cancellation = CancellationToken::new();
        let task_cancellation = cancellation.clone();
        let weak_inner = Arc::downgrade(&self.inner);
        let weak_entry = Arc::downgrade(entry);
        let project_id = entry.project_id.clone();
        let idle_eviction = self.inner.options.idle_eviction;
        let handle = tokio::spawn(async move {
            tokio::select! {
                _ = task_cancellation.cancelled() => return,
                _ = tokio::time::sleep(idle_eviction) => {}
            }
            let (Some(inner), Some(entry)) = (weak_inner.upgrade(), weak_entry.upgrade()) else {
                return;
            };
            let mut registry = lock(&inner.registry);
            if registry
                .entries
                .get(&project_id)
                .is_some_and(|candidate| Arc::ptr_eq(candidate, &entry))
            {
                if lock(&entry.state).subscribers != 0 {
                    return;
                }
                registry.entries.remove(&project_id);
                registry.aliases.remove(&project_id);
                registry.bootstrap_locks.remove(&project_id);
            }
        });
        lock(&entry.state).eviction = Some(OwnedTask {
            cancellation,
            _handle: handle,
        });
    }

    #[cfg(test)]
    pub(crate) fn active_poller_count_for_test(&self) -> usize {
        lock(&self.inner.registry)
            .entries
            .values()
            .filter(|entry| lock(&entry.state).poller.is_some())
            .count()
    }

    #[cfg(test)]
    pub(crate) fn entry_count_for_test(&self) -> usize {
        lock(&self.inner.registry).entries.len()
    }

    #[cfg(test)]
    pub(crate) fn mutation_refresh_attempt_count_for_test(&self) -> usize {
        self.inner.mutation_refresh_attempts.load(Ordering::SeqCst)
    }

    #[cfg(test)]
    pub(crate) fn pause_next_final_release_for_test(
        &self,
    ) -> (Arc<std::sync::Barrier>, Arc<std::sync::Barrier>) {
        let entered = Arc::new(std::sync::Barrier::new(2));
        let resume = Arc::new(std::sync::Barrier::new(2));
        *lock(&self.inner.final_release_pause) = Some(FinalReleasePause {
            entered: Arc::clone(&entered),
            resume: Arc::clone(&resume),
        });
        (entered, resume)
    }

    #[cfg(test)]
    fn pause_final_release_for_test(&self, final_subscriber: bool) {
        if !final_subscriber {
            return;
        }
        let Some(pause) = lock(&self.inner.final_release_pause).take() else {
            return;
        };
        pause.entered.wait();
        pause.resume.wait();
    }
}

impl SubscriptionReservation {
    fn commit(&mut self) -> CatalogSubscription {
        self.committed = true;
        CatalogSubscription {
            receiver: self
                .receiver
                .take()
                .expect("subscription receiver reserved"),
            service: self.service.clone(),
            entry: Arc::clone(&self.entry),
            released: false,
        }
    }
}

impl Drop for SubscriptionReservation {
    fn drop(&mut self) {
        if !self.committed {
            self.service.release(&self.entry);
        }
    }
}

impl CatalogSubscription {
    #[must_use]
    pub fn latest(&self) -> Arc<WorktreeCatalogSnapshot> {
        Arc::clone(&self.receiver.borrow())
    }

    pub async fn changed(&mut self) -> Option<Arc<WorktreeCatalogSnapshot>> {
        self.receiver.changed().await.ok()?;
        Some(Arc::clone(&self.receiver.borrow_and_update()))
    }
}

impl Drop for CatalogSubscription {
    fn drop(&mut self) {
        if !self.released {
            self.released = true;
            self.service.release(&self.entry);
        }
    }
}

struct CompletedScan {
    repository_key: String,
    common_dir: PathBuf,
    snapshot: Arc<WorktreeCatalogSnapshot>,
}

struct CompletedObservation {
    repository_key: String,
    common_dir: PathBuf,
    inventory: GitWorktreeInventory,
}

struct ScanRequest<'a> {
    expected_repository_key: Option<&'a str>,
    generation: u64,
    previous: Option<&'a WorktreeCatalogSnapshot>,
    suppressions: &'a HashSet<String>,
    cancellation: CancellationToken,
}

struct SnapshotJoin<'a> {
    common_dir: &'a Path,
    repository_key: String,
    generation: u64,
    previous: Option<&'a WorktreeCatalogSnapshot>,
    suppressions: &'a HashSet<String>,
    cancellation: &'a CancellationToken,
}

fn scan_error_for_bootstrap(error: ScanError) -> CatalogError {
    match error {
        ScanError::Failure(failure) => {
            CatalogError::new(CatalogErrorReason::RepositoryUnavailable, failure.message)
        }
        ScanError::Catalog(error) => error,
        ScanError::Cancelled => cancelled_error(),
    }
}

fn cancelled_error() -> CatalogError {
    CatalogError::new(
        CatalogErrorReason::RepositoryUnavailable,
        "Catalog work was cancelled after its final subscriber detached.",
    )
}

fn retained_snapshot(
    authoritative: &WorktreeCatalogSnapshot,
    scan_status: CatalogScanStatus,
) -> WorktreeCatalogSnapshot {
    WorktreeCatalogSnapshot {
        repository_key: authoritative.repository_key.clone(),
        generation: authoritative.generation,
        authoritative: false,
        observed_at: now_iso(),
        scan_status,
        worktrees: authoritative.worktrees.clone(),
        adopted_workspaces: authoritative.adopted_workspaces.clone(),
    }
}

fn canonical_threads(project: &CatalogProject) -> impl Iterator<Item = &CatalogThread> {
    project
        .threads
        .iter()
        .filter(|thread| thread.kind != "panel" && !thread.deleted)
}

fn host_platform() -> HostPathPlatform {
    if cfg!(windows) {
        HostPathPlatform::Windows
    } else {
        HostPathPlatform::Posix
    }
}

fn now_iso() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| OffsetDateTime::now_utc().unix_timestamp().to_string())
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

struct RepositoriesProjectionSource {
    repositories: Arc<Repositories>,
}

impl CatalogProjectionSource for RepositoriesProjectionSource {
    fn load(
        &self,
        project_id: String,
    ) -> CatalogFuture<Result<Option<CatalogProject>, CatalogError>> {
        let repositories = Arc::clone(&self.repositories);
        Box::pin(async move {
            let Some(projection) = repositories
                .load_worktree_catalog_projection(project_id.clone(), 512)
                .await
                .map_err(persistence_error)?
            else {
                return Ok(None);
            };
            if projection.truncated {
                return Err(CatalogError::new(
                    CatalogErrorReason::Internal,
                    "More than 512 adopted workspaces belong to this project.",
                ));
            }
            let project = projection.project;
            if project.deleted_at.is_some() {
                return Ok(None);
            }
            let baseline_paths = match project.worktree_discovery.get("baselinePaths") {
                None => Vec::new(),
                Some(serde_json::Value::Array(values)) => values
                    .iter()
                    .map(|value| {
                        value
                            .as_str()
                            .filter(|value| !value.trim().is_empty())
                            .map(str::to_owned)
                            .ok_or_else(|| {
                                CatalogError::new(
                                    CatalogErrorReason::Internal,
                                    "The persisted worktree discovery baseline is malformed.",
                                )
                            })
                    })
                    .collect::<Result<Vec<_>, _>>()?,
                Some(_) => {
                    return Err(CatalogError::new(
                        CatalogErrorReason::Internal,
                        "The persisted worktree discovery baseline is malformed.",
                    ));
                }
            };
            Ok(Some(CatalogProject {
                workspace_root: PathBuf::from(project.workspace_root),
                baseline_paths,
                threads: projection.threads.into_iter().map(catalog_thread).collect(),
                repository_key: project.worktree_repository_key,
            }))
        })
    }

    fn pin_repository_key(
        &self,
        project_id: String,
        repository_key: String,
    ) -> CatalogFuture<Result<Option<CatalogPinOutcome>, CatalogError>> {
        let repositories = Arc::clone(&self.repositories);
        Box::pin(async move {
            repositories
                .pin_project_worktree_repository_key(project_id, repository_key)
                .await
                .map_err(persistence_error)
                .map(|outcome| {
                    outcome.map(|outcome| match outcome {
                        WorktreeRepositoryPinOutcome::Established => CatalogPinOutcome::Established,
                        WorktreeRepositoryPinOutcome::Matched => CatalogPinOutcome::Matched,
                        WorktreeRepositoryPinOutcome::Mismatch {
                            pinned_repository_key,
                        } => CatalogPinOutcome::Mismatch {
                            pinned_repository_key,
                        },
                    })
                })
        })
    }
}

fn catalog_thread(thread: ProjectionThread) -> CatalogThread {
    CatalogThread {
        thread_id: thread.thread_id,
        kind: thread.kind,
        worktree_path: thread.worktree_path.map(PathBuf::from),
        branch: thread.branch,
        archived: thread.archived_at.is_some(),
        deleted: thread.deleted_at.is_some(),
    }
}

fn persistence_error(error: crate::persistence::PersistenceError) -> CatalogError {
    CatalogError::new(
        CatalogErrorReason::Internal,
        format!("Failed to read catalog projections: {error}"),
    )
}

struct GitInventorySource {
    repository: Arc<GitRepository>,
}

impl InventorySource for GitInventorySource {
    fn inventory(
        &self,
        anchor: PathBuf,
        cancellation: CancellationToken,
    ) -> CatalogFuture<Result<GitWorktreeInventory, ScanFailure>> {
        let repository = Arc::clone(&self.repository);
        Box::pin(async move {
            repository
                .worktree_inventory(&anchor, &cancellation)
                .await
                .map_err(|error| ScanFailure {
                    reason: degraded_reason(&error.detail),
                    message: bounded_message(error.to_string()),
                })
        })
    }
}

fn degraded_reason(detail: &str) -> CatalogDegradedReason {
    let detail = detail.to_ascii_lowercase();
    if detail.contains("timed out") {
        CatalogDegradedReason::TimedOut
    } else if detail.contains("output")
        && (detail.contains("limit") || detail.contains("truncated"))
    {
        CatalogDegradedReason::OutputLimit
    } else if detail.contains("malformed") || detail.contains("invalid") {
        CatalogDegradedReason::MalformedOutput
    } else if detail.contains("spawn") || detail.contains("not found") {
        CatalogDegradedReason::GitUnavailable
    } else {
        CatalogDegradedReason::GitFailed
    }
}

pub(super) struct TokioCatalogFileSystem;

impl CatalogFileSystem for TokioCatalogFileSystem {
    fn probe(&self, path: PathBuf) -> CatalogFuture<DirectoryProbeState> {
        Box::pin(async move {
            match tokio::fs::metadata(path).await {
                Ok(metadata) if metadata.is_dir() => DirectoryProbeState::Present,
                Ok(_) => DirectoryProbeState::Unknown,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    DirectoryProbeState::Missing
                }
                Err(_) => DirectoryProbeState::Unknown,
            }
        })
    }

    fn canonicalize(&self, path: PathBuf) -> CatalogFuture<Result<PathBuf, std::io::Error>> {
        Box::pin(tokio::fs::canonicalize(path))
    }

    fn shallow_signature(
        &self,
        common_dir: PathBuf,
        known_paths: Vec<PathBuf>,
    ) -> CatalogFuture<CatalogShallowSignature> {
        Box::pin(async move {
            let mut metadata = DefaultHasher::new();
            common_dir.hash(&mut metadata);
            let worktrees = common_dir.join("worktrees");
            hash_metadata(&worktrees, &mut metadata).await;
            if let Ok(mut entries) = tokio::fs::read_dir(&worktrees).await {
                let mut children = Vec::new();
                while children.len() <= 512 {
                    match entries.next_entry().await {
                        Ok(Some(entry)) => children.push(entry.path()),
                        Ok(None) | Err(_) => break,
                    }
                }
                children.sort();
                for child in children {
                    child.hash(&mut metadata);
                    hash_metadata(&child.join("gitdir"), &mut metadata).await;
                    hash_metadata(&child.join("locked"), &mut metadata).await;
                }
            }
            let mut availability = DefaultHasher::new();
            let mut known_paths = known_paths;
            known_paths.sort();
            known_paths.dedup();
            for path in known_paths {
                path.hash(&mut availability);
                hash_metadata(&path, &mut availability).await;
            }
            CatalogShallowSignature {
                metadata: metadata.finish(),
                availability: availability.finish(),
            }
        })
    }
}

async fn hash_metadata(path: &Path, hasher: &mut DefaultHasher) {
    match tokio::fs::symlink_metadata(path).await {
        Ok(metadata) => {
            true.hash(hasher);
            metadata.len().hash(hasher);
            metadata.is_dir().hash(hasher);
            metadata.is_file().hash(hasher);
            metadata.modified().ok().hash(hasher);
        }
        Err(error) => {
            false.hash(hasher);
            format!("{:?}", error.kind()).hash(hasher);
        }
    }
}
