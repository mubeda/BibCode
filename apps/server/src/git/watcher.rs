use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{self, ErrorKind, Write},
    path::{Path, PathBuf},
    process,
    sync::{
        Arc, Mutex, MutexGuard, Weak,
        atomic::{AtomicBool, AtomicU8, AtomicUsize, Ordering},
    },
    time::Duration,
};

use notify::{
    Config, Event, EventKind, RecursiveMode, Watcher,
    event::{AccessKind, AccessMode, MetadataKind, ModifyKind},
};
use tokio::sync::{Notify, watch};
use tokio_util::sync::CancellationToken;

use super::{host_path_platform, normalize_worktree_path_key};

const READINESS_TIMEOUT: Duration = Duration::from_secs(5);
const READINESS_DIRECTORY_PREFIX: &str = "bibcode-git-watch-ready";
static NEXT_READINESS_DIRECTORY_ID: AtomicUsize = AtomicUsize::new(0);

#[cfg(test)]
static NATIVE_WATCHER_TEST_PERMIT: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[cfg(test)]
pub(crate) async fn acquire_native_watcher_test_permit() -> tokio::sync::MutexGuard<'static, ()> {
    NATIVE_WATCHER_TEST_PERMIT.lock().await
}

#[derive(Clone, Debug)]
pub(crate) struct GitWatchRequest {
    pub(crate) worktree_root: PathBuf,
    pub(crate) git_dir: PathBuf,
    pub(crate) common_dir: PathBuf,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum GitWatchEvent {
    WorkingTree,
    Metadata,
    Overflow,
    Unavailable,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum GitWatcherHealth {
    Healthy,
    FallbackRequired,
}

#[derive(Debug, thiserror::Error)]
pub(crate) enum GitWatchError {
    #[error("failed to resolve Git watcher root {path}: {source}")]
    Root {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("Git watcher service is shut down")]
    Shutdown,
}

#[derive(Clone)]
pub(crate) struct GitWatchService {
    inner: Arc<Inner>,
}

struct Inner {
    backend_factory: Arc<dyn GitWatcherBackendFactory>,
    state: Mutex<State>,
    setups: Arc<SetupTracker>,
    setup_cancellation: CancellationToken,
    readiness_timeout: Duration,
}

#[derive(Default)]
struct SetupTracker {
    active: AtomicUsize,
    idle: Notify,
}

#[derive(Default)]
struct SetupCompletion {
    finished: std::sync::atomic::AtomicBool,
    notify: Notify,
}

struct SetupGuard {
    tracker: Arc<SetupTracker>,
    completion: Arc<SetupCompletion>,
}

#[derive(Default)]
struct State {
    shutdown: bool,
    next_generation: u64,
    next_subscriber_id: u64,
    entries: HashMap<GitWatchIdentity, WatchEntry>,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct GitWatchIdentity {
    worktree_root: String,
    git_dir: String,
    common_dir: String,
}

struct WatchEntry {
    generation: u64,
    subscribers: HashSet<u64>,
    sender: watch::Sender<Option<GitWatchEvent>>,
    health: Arc<AtomicU8>,
    backend: Option<Box<dyn GitWatcherBackend>>,
    roots: GitWatchIdentity,
    root_aliases: Vec<GitWatchIdentity>,
    registered_roots: Vec<(String, RecursiveMode)>,
    setup: Arc<SetupCompletion>,
}

struct AdmittedRoots {
    identity: GitWatchIdentity,
    alias: GitWatchIdentity,
    worktree_root: PathBuf,
    git_dir: PathBuf,
    common_dir: PathBuf,
}

pub(crate) struct GitWatchSubscription {
    inner: Weak<Inner>,
    identity: GitWatchIdentity,
    generation: u64,
    subscriber_id: u64,
    receiver: watch::Receiver<Option<GitWatchEvent>>,
    health: Arc<AtomicU8>,
    setup: Arc<SetupCompletion>,
}

type BackendCallback = Arc<dyn Fn(notify::Result<Event>) + Send + Sync>;

trait GitWatcherBackendFactory: Send + Sync {
    fn create(
        &self,
        callback: BackendCallback,
        config: Config,
    ) -> notify::Result<Box<dyn GitWatcherBackend>>;
}

trait GitWatcherBackend: Send {
    fn watch(&mut self, path: &Path, recursive_mode: RecursiveMode) -> notify::Result<()>;
    fn unwatch(&mut self, path: &Path) -> notify::Result<()>;

    fn readiness_probe_written(&mut self, _sentinel: &Path) {}
}

#[cfg(test)]
#[derive(Default)]
pub(super) struct GitWatchSetupGate {
    entered: AtomicBool,
    entered_notify: Notify,
    released: Mutex<bool>,
    release_notify: std::sync::Condvar,
}

#[cfg(test)]
impl GitWatchSetupGate {
    fn block(&self) {
        self.entered.store(true, Ordering::Release);
        self.entered_notify.notify_waiters();
        let mut released = self.released.lock().expect("setup-gate release lock");
        while !*released {
            released = self
                .release_notify
                .wait(released)
                .expect("setup-gate release wait");
        }
    }

    pub(super) async fn wait_until_entered(&self) {
        loop {
            let entered = self.entered_notify.notified();
            if self.entered.load(Ordering::Acquire) {
                return;
            }
            entered.await;
        }
    }

    pub(super) fn release(&self) {
        *self.released.lock().expect("setup-gate release lock") = true;
        self.release_notify.notify_all();
    }
}

#[cfg(test)]
struct GatedWatcherBackendFactory {
    gate: Arc<GitWatchSetupGate>,
}

#[cfg(test)]
struct GatedWatcherBackend {
    callback: BackendCallback,
    gate: Arc<GitWatchSetupGate>,
    watch_calls: usize,
}

#[cfg(test)]
impl GitWatcherBackendFactory for GatedWatcherBackendFactory {
    fn create(
        &self,
        callback: BackendCallback,
        _config: Config,
    ) -> notify::Result<Box<dyn GitWatcherBackend>> {
        Ok(Box::new(GatedWatcherBackend {
            callback,
            gate: Arc::clone(&self.gate),
            watch_calls: 0,
        }))
    }
}

#[cfg(test)]
impl GitWatcherBackend for GatedWatcherBackend {
    fn watch(&mut self, _path: &Path, _recursive_mode: RecursiveMode) -> notify::Result<()> {
        self.watch_calls += 1;
        if self.watch_calls == 1 {
            self.gate.block();
        }
        Ok(())
    }

    fn unwatch(&mut self, _path: &Path) -> notify::Result<()> {
        Ok(())
    }

    fn readiness_probe_written(&mut self, sentinel: &Path) {
        (self.callback)(Ok(
            Event::new(EventKind::Any).add_path(sentinel.to_path_buf())
        ));
    }
}

struct NativeWatcherBackendFactory;

struct NativeWatcherBackend {
    watcher: notify::RecommendedWatcher,
}

impl GitWatcherBackendFactory for NativeWatcherBackendFactory {
    fn create(
        &self,
        callback: BackendCallback,
        config: Config,
    ) -> notify::Result<Box<dyn GitWatcherBackend>> {
        notify::RecommendedWatcher::new(move |event| callback(event), config)
            .map(|watcher| Box::new(NativeWatcherBackend { watcher }) as Box<dyn GitWatcherBackend>)
    }
}

impl GitWatcherBackend for NativeWatcherBackend {
    fn watch(&mut self, path: &Path, recursive_mode: RecursiveMode) -> notify::Result<()> {
        self.watcher.watch(path, recursive_mode)
    }

    fn unwatch(&mut self, path: &Path) -> notify::Result<()> {
        self.watcher.unwatch(path)
    }
}

impl GitWatchService {
    pub(crate) fn new() -> Self {
        Self {
            inner: Arc::new(Inner {
                backend_factory: Arc::new(NativeWatcherBackendFactory),
                state: Mutex::new(State::default()),
                setups: Arc::new(SetupTracker::default()),
                setup_cancellation: CancellationToken::new(),
                readiness_timeout: READINESS_TIMEOUT,
            }),
        }
    }

    #[cfg(test)]
    fn with_backend_factory(backend_factory: Arc<dyn GitWatcherBackendFactory>) -> Self {
        let mut service = Self::new();
        Arc::get_mut(&mut service.inner)
            .expect("new watcher service is uniquely owned")
            .backend_factory = backend_factory;
        service
    }

    #[cfg(test)]
    pub(super) fn blocked_during_setup_for_test() -> (Self, Arc<GitWatchSetupGate>) {
        let gate = Arc::new(GitWatchSetupGate::default());
        let service = Self::with_backend_factory(Arc::new(GatedWatcherBackendFactory {
            gate: Arc::clone(&gate),
        }));
        (service, gate)
    }

    #[cfg(test)]
    pub(super) async fn wait_for_setup_cancellation_for_test(&self) {
        self.inner.setup_cancellation.cancelled().await;
    }

    #[cfg(test)]
    fn with_backend_factory_and_readiness_timeout(
        backend_factory: Arc<dyn GitWatcherBackendFactory>,
        readiness_timeout: Duration,
    ) -> Self {
        let mut service = Self::with_backend_factory(backend_factory);
        Arc::get_mut(&mut service.inner)
            .expect("new watcher service is uniquely owned")
            .readiness_timeout = readiness_timeout;
        service
    }

    pub(crate) async fn subscribe(
        &self,
        request: GitWatchRequest,
    ) -> Result<GitWatchSubscription, GitWatchError> {
        let roots = admit_roots(request).await?;
        let (subscription, install) = {
            let mut state = self.inner.lock_state();
            if state.shutdown {
                return Err(GitWatchError::Shutdown);
            }
            let subscriber_id = state.next_subscriber_id;
            state.next_subscriber_id = state.next_subscriber_id.wrapping_add(1);
            if let Some(entry) = state.entries.get_mut(&roots.identity) {
                if !entry.root_aliases.contains(&roots.alias) {
                    entry.root_aliases.push(roots.alias.clone());
                }
                entry.subscribers.insert(subscriber_id);
                (
                    GitWatchSubscription::new(
                        Arc::downgrade(&self.inner),
                        roots.identity,
                        entry,
                        subscriber_id,
                    ),
                    None,
                )
            } else {
                let generation = state.next_generation;
                state.next_generation = state.next_generation.wrapping_add(1);
                let (sender, receiver) = watch::channel(None);
                let health = Arc::new(AtomicU8::new(0));
                let setup = Arc::new(SetupCompletion::default());
                let watch_roots = watch_roots(&roots);
                let registered_roots = normalize_registered_roots(&watch_roots);
                let mut root_aliases = vec![roots.identity.clone()];
                if roots.alias != roots.identity {
                    root_aliases.push(roots.alias.clone());
                }
                state.entries.insert(
                    roots.identity.clone(),
                    WatchEntry {
                        generation,
                        subscribers: HashSet::from([subscriber_id]),
                        sender,
                        health: Arc::clone(&health),
                        backend: None,
                        roots: roots.identity.clone(),
                        root_aliases,
                        registered_roots,
                        setup: Arc::clone(&setup),
                    },
                );
                (
                    GitWatchSubscription {
                        inner: Arc::downgrade(&self.inner),
                        identity: roots.identity.clone(),
                        generation,
                        subscriber_id,
                        receiver,
                        health,
                        setup: Arc::clone(&setup),
                    },
                    Some((
                        generation,
                        watch_roots,
                        SetupGuard::reserve(Arc::clone(&self.inner.setups), setup),
                    )),
                )
            }
        };
        if let Some((generation, watch_roots, setup)) = install {
            self.install_backend(
                subscription.identity.clone(),
                generation,
                watch_roots,
                setup,
            );
        }
        subscription.setup.wait().await;
        if self.inner.lock_state().shutdown {
            return Err(GitWatchError::Shutdown);
        }
        Ok(subscription)
    }

    #[cfg(test)]
    pub(super) fn active_count_for_test(&self) -> usize {
        self.inner.lock_state().entries.len()
    }

    #[cfg(test)]
    pub(super) fn only_generation_for_test(&self) -> u64 {
        let state = self.inner.lock_state();
        assert_eq!(state.entries.len(), 1, "one watcher entry is active");
        state
            .entries
            .values()
            .next()
            .expect("one watcher entry exists")
            .generation
    }

    #[cfg(test)]
    pub(super) fn force_only_entry_fallback_for_test(&self) {
        let mut state = self.inner.lock_state();
        assert_eq!(state.entries.len(), 1, "one watcher entry is active");
        publish(
            state
                .entries
                .values_mut()
                .next()
                .expect("one watcher entry exists"),
            GitWatchEvent::Overflow,
        );
    }

    #[cfg(test)]
    pub(super) fn only_health_for_test(&self) -> GitWatcherHealth {
        let state = self.inner.lock_state();
        assert_eq!(state.entries.len(), 1, "one watcher entry is active");
        if state
            .entries
            .values()
            .next()
            .expect("one watcher entry exists")
            .health
            .load(Ordering::Acquire)
            == 0
        {
            GitWatcherHealth::Healthy
        } else {
            GitWatcherHealth::FallbackRequired
        }
    }

    #[cfg(test)]
    fn setup_count_for_test(&self) -> usize {
        self.inner.setups.active.load(Ordering::Acquire)
    }

    pub(crate) async fn shutdown(&self) {
        self.inner.setup_cancellation.cancel();
        let entries = {
            let mut state = self.inner.lock_state();
            state.shutdown = true;
            std::mem::take(&mut state.entries)
        };
        drop(entries);
        self.inner.setups.wait_until_idle().await;
    }

    fn install_backend(
        &self,
        identity: GitWatchIdentity,
        generation: u64,
        watch_roots: Vec<(PathBuf, RecursiveMode)>,
        setup: SetupGuard,
    ) {
        let inner = Arc::clone(&self.inner);
        let blocking_inner = Arc::clone(&inner);
        let blocking_identity = identity.clone();
        let setup_cancellation = inner.setup_cancellation.clone();
        let readiness_timeout = inner.readiness_timeout;
        let runtime = tokio::runtime::Handle::current();
        let blocking_task = tokio::task::spawn_blocking(move || {
            let callback_inner = Arc::downgrade(&blocking_inner);
            let callback_identity = blocking_identity;
            let normal_callback = Arc::new(move |event| {
                let Some(inner) = callback_inner.upgrade() else {
                    return;
                };
                inner.handle_backend_event(&callback_identity, generation, event);
            });
            let backend = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                install_backend(
                    blocking_inner.backend_factory.as_ref(),
                    normal_callback,
                    &watch_roots,
                    &setup_cancellation,
                    readiness_timeout,
                    &runtime,
                )
            }))
            .unwrap_or_else(|_| Err(notify::Error::generic("Git watcher setup panicked")));
            (setup, backend)
        });
        drop(tokio::spawn(async move {
            if let Ok((setup, backend)) = blocking_task.await {
                inner.commit_backend(&identity, generation, backend);
                drop(setup);
            }
        }));
    }
}

impl SetupGuard {
    fn reserve(tracker: Arc<SetupTracker>, completion: Arc<SetupCompletion>) -> Self {
        tracker.active.fetch_add(1, Ordering::AcqRel);
        Self {
            tracker,
            completion,
        }
    }
}

impl Drop for SetupGuard {
    fn drop(&mut self) {
        self.completion.finish();
        if self.tracker.active.fetch_sub(1, Ordering::AcqRel) == 1 {
            self.tracker.idle.notify_waiters();
        }
    }
}

impl SetupCompletion {
    fn finish(&self) {
        self.finished.store(true, Ordering::Release);
        self.notify.notify_waiters();
    }

    async fn wait(&self) {
        loop {
            let notified = self.notify.notified();
            if self.finished.load(Ordering::Acquire) {
                return;
            }
            notified.await;
        }
    }
}

impl SetupTracker {
    async fn wait_until_idle(&self) {
        loop {
            let notified = self.idle.notified();
            if self.active.load(Ordering::Acquire) == 0 {
                return;
            }
            notified.await;
        }
    }
}

impl Inner {
    fn lock_state(&self) -> MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn release(&self, identity: &GitWatchIdentity, generation: u64, subscriber_id: u64) {
        let removed = {
            let mut state = self.lock_state();
            let Some(entry) = state.entries.get_mut(identity) else {
                return;
            };
            if entry.generation != generation {
                return;
            }
            entry.subscribers.remove(&subscriber_id);
            entry
                .subscribers
                .is_empty()
                .then(|| state.entries.remove(identity))
                .flatten()
        };
        drop(removed);
    }

    fn handle_backend_event(
        &self,
        identity: &GitWatchIdentity,
        generation: u64,
        event: notify::Result<Event>,
    ) {
        let mut state = self.lock_state();
        let Some(entry) = state.entries.get_mut(identity) else {
            return;
        };
        if entry.generation != generation {
            return;
        }
        let event = match event {
            Ok(event) => {
                #[cfg(windows)]
                if entry.backend.is_none()
                    && windows_installing_nested_root_artifact(&event, &entry.registered_roots)
                {
                    return;
                }
                classify_event(
                    &event,
                    &entry.roots,
                    &entry.root_aliases,
                    &entry.registered_roots,
                    host_path_platform(),
                )
            }
            Err(_) => Some(GitWatchEvent::Unavailable),
        };
        if let Some(event) = event {
            publish(entry, event);
        }
    }

    fn commit_backend(
        &self,
        identity: &GitWatchIdentity,
        generation: u64,
        backend: notify::Result<Box<dyn GitWatcherBackend>>,
    ) {
        let mut state = self.lock_state();
        match state.entries.get_mut(identity) {
            Some(entry) if entry.generation == generation => match backend {
                Ok(backend) => entry.backend = Some(backend),
                Err(_) => publish(entry, GitWatchEvent::Unavailable),
            },
            _ => {
                drop(state);
                drop(backend);
            }
        }
    }
}

impl Drop for Inner {
    fn drop(&mut self) {
        self.setup_cancellation.cancel();
        let state = self
            .state
            .get_mut()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.shutdown = true;
        state.entries.clear();
    }
}

impl Drop for GitWatchSubscription {
    fn drop(&mut self) {
        if let Some(inner) = self.inner.upgrade() {
            inner.release(&self.identity, self.generation, self.subscriber_id);
        }
    }
}

impl GitWatchSubscription {
    fn new(
        inner: Weak<Inner>,
        identity: GitWatchIdentity,
        entry: &WatchEntry,
        subscriber_id: u64,
    ) -> Self {
        Self {
            inner,
            identity,
            generation: entry.generation,
            subscriber_id,
            receiver: entry.sender.subscribe(),
            health: Arc::clone(&entry.health),
            setup: Arc::clone(&entry.setup),
        }
    }

    pub(crate) async fn recv(&mut self) -> Option<GitWatchEvent> {
        loop {
            if self.receiver.changed().await.is_err() {
                return None;
            }
            if let Some(event) = *self.receiver.borrow_and_update() {
                return Some(event);
            }
        }
    }

    #[cfg(test)]
    pub(crate) fn try_recv(&mut self) -> Option<GitWatchEvent> {
        self.take_current()
    }

    pub(crate) fn health(&self) -> GitWatcherHealth {
        if self.health.load(Ordering::Acquire) == 0 {
            GitWatcherHealth::Healthy
        } else {
            GitWatcherHealth::FallbackRequired
        }
    }

    #[cfg(test)]
    fn take_current(&mut self) -> Option<GitWatchEvent> {
        if !self.receiver.has_changed().unwrap_or(false) {
            return None;
        }
        *self.receiver.borrow_and_update()
    }
}

fn install_backend(
    factory: &dyn GitWatcherBackendFactory,
    normal_callback: BackendCallback,
    watch_roots: &[(PathBuf, RecursiveMode)],
    cancellation: &CancellationToken,
    readiness_timeout: Duration,
    runtime: &tokio::runtime::Handle,
) -> notify::Result<Box<dyn GitWatcherBackend>> {
    let readiness = Arc::new(ReadinessAcknowledgement::default());
    let probe = create_readiness_probe(watch_roots)?;
    let sentinel_key = normalize_worktree_path_key(&probe.sentinel, host_path_platform());
    let callback_readiness = Arc::clone(&readiness);
    let callback = Arc::new(move |event: notify::Result<Event>| {
        let is_readiness = event.as_ref().is_ok_and(|event| {
            event
                .paths
                .iter()
                .any(|path| normalize_worktree_path_key(path, host_path_platform()) == sentinel_key)
        });
        normal_callback(event);
        if is_readiness {
            callback_readiness.observe();
        }
    });
    let config = Config::default().with_follow_symlinks(false);
    let mut backend = match factory.create(callback, config) {
        Ok(backend) => backend,
        Err(error) => {
            cleanup_readiness_files(&probe)?;
            return Err(error);
        }
    };
    let mut installed = Vec::<PathBuf>::new();
    for (path, recursive_mode) in watch_roots {
        if let Err(error) = backend.watch(path, *recursive_mode) {
            for path in installed.iter().rev() {
                let _ = backend.unwatch(path);
            }
            cleanup_readiness_files(&probe)?;
            return Err(error);
        }
        installed.push(path.clone());
    }
    if let Err(error) = backend.watch(&probe.root, RecursiveMode::NonRecursive) {
        for path in installed.iter().rev() {
            let _ = backend.unwatch(path);
        }
        cleanup_readiness_files(&probe)?;
        return Err(error);
    }
    let readiness_result = (|| {
        let mut sentinel = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&probe.sentinel)
            .map_err(notify::Error::io)?;
        sentinel
            .write_all(b"ready")
            .and_then(|()| sentinel.sync_all())
            .map_err(notify::Error::io)?;
        drop(sentinel);
        backend.readiness_probe_written(&probe.sentinel);
        runtime.block_on(async {
            tokio::select! {
                biased;
                () = cancellation.cancelled() => {
                    Err(notify::Error::generic("Git watcher readiness was cancelled"))
                }
                result = tokio::time::timeout(readiness_timeout, readiness.wait()) => {
                    result.map_err(|_| notify::Error::generic("Git watcher readiness timed out"))
                }
            }
        })
    })();
    let readiness_unwatch = backend.unwatch(&probe.root);
    let readiness_cleanup = cleanup_readiness_files(&probe);
    if let Err(error) = readiness_result
        .and(readiness_unwatch)
        .and(readiness_cleanup)
    {
        for path in installed.iter().rev() {
            let _ = backend.unwatch(path);
        }
        return Err(error);
    }
    Ok(backend)
}

#[derive(Default)]
struct ReadinessAcknowledgement {
    observed: AtomicBool,
    notify: Notify,
}

impl ReadinessAcknowledgement {
    fn observe(&self) {
        self.observed.store(true, Ordering::Release);
        self.notify.notify_waiters();
    }

    async fn wait(&self) {
        loop {
            let notified = self.notify.notified();
            if self.observed.load(Ordering::Acquire) {
                return;
            }
            notified.await;
        }
    }
}

struct ReadinessProbe {
    root: PathBuf,
    sentinel: PathBuf,
}

fn create_readiness_probe(
    admitted_roots: &[(PathBuf, RecursiveMode)],
) -> notify::Result<ReadinessProbe> {
    create_readiness_probe_with(
        admitted_roots,
        &std::env::temp_dir(),
        |path| fs::create_dir(path),
        |path| fs::canonicalize(path),
        |path| fs::remove_dir(path),
    )
}

fn create_readiness_probe_with<Create, Canonicalize, Remove>(
    admitted_roots: &[(PathBuf, RecursiveMode)],
    temporary_root: &Path,
    create_dir: Create,
    canonicalize: Canonicalize,
    remove_dir: Remove,
) -> notify::Result<ReadinessProbe>
where
    Create: Fn(&Path) -> io::Result<()>,
    Canonicalize: Fn(&Path) -> io::Result<PathBuf>,
    Remove: Fn(&Path) -> io::Result<()>,
{
    for _ in 0..1_024 {
        let id = NEXT_READINESS_DIRECTORY_ID.fetch_add(1, Ordering::Relaxed);
        let root = temporary_root.join(format!(
            "{READINESS_DIRECTORY_PREFIX}-{}-{id}",
            process::id()
        ));
        match create_dir(&root) {
            Ok(()) => {
                let root = match canonicalize(&root) {
                    Ok(root) => root,
                    Err(error) => {
                        return Err(readiness_probe_failure(
                            &root,
                            notify::Error::io(error),
                            &remove_dir,
                        ));
                    }
                };
                let root_key = normalize_worktree_path_key(&root, host_path_platform());
                if admitted_roots.iter().any(|(admitted, _)| {
                    let admitted = normalize_worktree_path_key(admitted, host_path_platform());
                    relative_to_root(&root_key, &admitted).is_some()
                }) {
                    return Err(readiness_probe_failure(
                        &root,
                        notify::Error::generic(
                            "Git watcher readiness directory overlaps an admitted root",
                        ),
                        &remove_dir,
                    ));
                }
                return Ok(ReadinessProbe {
                    sentinel: root.join("ready"),
                    root,
                });
            }
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
            Err(error) => return Err(notify::Error::io(error)),
        }
    }
    Err(notify::Error::generic(
        "Git watcher readiness directory allocation was exhausted",
    ))
}

fn readiness_probe_failure(
    root: &Path,
    primary: notify::Error,
    remove_dir: &impl Fn(&Path) -> io::Result<()>,
) -> notify::Error {
    match remove_dir(root) {
        Ok(()) => primary,
        Err(error) if error.kind() == ErrorKind::NotFound => primary,
        Err(cleanup) => notify::Error::generic(&format!(
            "{primary}; readiness probe cleanup failed for {}: {cleanup}",
            root.display()
        )),
    }
}

fn cleanup_readiness_files(probe: &ReadinessProbe) -> notify::Result<()> {
    let sentinel = match fs::remove_file(&probe.sentinel) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(notify::Error::io(error)),
    };
    let root = fs::remove_dir(&probe.root).map_err(notify::Error::io);
    sentinel.and(root)
}

#[cfg(test)]
fn is_readiness_directory(path: &Path) -> bool {
    path.file_name().is_some_and(|name| {
        name.to_string_lossy()
            .starts_with(READINESS_DIRECTORY_PREFIX)
    })
}

fn publish(entry: &mut WatchEntry, event: GitWatchEvent) {
    if matches!(event, GitWatchEvent::Overflow | GitWatchEvent::Unavailable) {
        entry.health.store(1, Ordering::Release);
    }
    entry.sender.send_replace(Some(event));
}

async fn admit_roots(request: GitWatchRequest) -> Result<AdmittedRoots, GitWatchError> {
    let platform = host_path_platform();
    let alias = identity_for_paths(
        &request.worktree_root,
        &request.git_dir,
        &request.common_dir,
        platform,
    );
    let (worktree_root, git_dir, common_dir) = tokio::try_join!(
        canonical_root(request.worktree_root),
        canonical_root(request.git_dir),
        canonical_root(request.common_dir),
    )?;
    Ok(AdmittedRoots {
        identity: identity_for_paths(&worktree_root, &git_dir, &common_dir, platform),
        alias,
        worktree_root,
        git_dir,
        common_dir,
    })
}

fn identity_for_paths(
    worktree_root: impl AsRef<Path>,
    git_dir: impl AsRef<Path>,
    common_dir: impl AsRef<Path>,
    platform: super::HostPathPlatform,
) -> GitWatchIdentity {
    GitWatchIdentity {
        worktree_root: normalize_worktree_path_key(worktree_root.as_ref(), platform),
        git_dir: normalize_worktree_path_key(git_dir.as_ref(), platform),
        common_dir: normalize_worktree_path_key(common_dir.as_ref(), platform),
    }
}

fn classify_event(
    event: &Event,
    roots: &GitWatchIdentity,
    root_aliases: &[GitWatchIdentity],
    registered_roots: &[(String, RecursiveMode)],
    platform: super::HostPathPlatform,
) -> Option<GitWatchEvent> {
    if event.need_rescan() {
        return Some(GitWatchEvent::Overflow);
    }
    if !event_may_change_status(event.kind) {
        return None;
    }
    if event.paths.is_empty() {
        return Some(GitWatchEvent::Unavailable);
    }
    let mut working_tree = false;
    for path in &event.paths {
        let path = normalize_event_path_key(path, roots, root_aliases, platform);
        let registered_mode = registered_roots
            .iter()
            .find_map(|(registered, mode)| (registered == &path).then_some(*mode));
        if matches!(
            event.kind,
            EventKind::Remove(_) | EventKind::Modify(ModifyKind::Name(_))
        ) && registered_mode.is_some()
        {
            return Some(GitWatchEvent::Unavailable);
        }
        if let Some(relative) = relative_to_root(&path, &roots.git_dir)
            .or_else(|| relative_to_root(&path, &roots.common_dir))
        {
            if metadata_relative_is_relevant(relative) {
                return Some(GitWatchEvent::Metadata);
            }
            continue;
        }
        let Some(relative) = relative_to_root(&path, &roots.worktree_root) else {
            continue;
        };
        if relative == ".git" || relative.starts_with(".git/") {
            return Some(GitWatchEvent::Metadata);
        }
        working_tree = true;
    }
    working_tree.then_some(GitWatchEvent::WorkingTree)
}

fn normalize_event_path_key(
    path: &Path,
    roots: &GitWatchIdentity,
    root_aliases: &[GitWatchIdentity],
    platform: super::HostPathPlatform,
) -> String {
    let path = normalize_worktree_path_key(path, platform);
    for aliases in root_aliases {
        for (alias, canonical) in [
            (&aliases.git_dir, &roots.git_dir),
            (&aliases.common_dir, &roots.common_dir),
            (&aliases.worktree_root, &roots.worktree_root),
        ] {
            if let Some(relative) = relative_to_root(&path, alias) {
                return if relative.is_empty() {
                    canonical.clone()
                } else {
                    format!("{canonical}/{relative}")
                };
            }
        }
    }
    path
}

#[cfg(windows)]
fn windows_installing_nested_root_artifact(
    event: &Event,
    registered_roots: &[(String, RecursiveMode)],
) -> bool {
    if event.kind != EventKind::Modify(ModifyKind::Any) || event.paths.len() != 1 {
        return false;
    }
    let path = normalize_worktree_path_key(&event.paths[0], host_path_platform());
    registered_roots.iter().any(|(registered, mode)| {
        *mode == RecursiveMode::Recursive
            && registered == &path
            && registered_roots.iter().any(|(parent, parent_mode)| {
                *parent_mode == RecursiveMode::NonRecursive
                    && parent != registered
                    && relative_to_root(registered, parent).is_some()
            })
    })
}

fn event_may_change_status(kind: EventKind) -> bool {
    match kind {
        EventKind::Access(AccessKind::Close(AccessMode::Write)) => true,
        EventKind::Access(_) => false,
        EventKind::Modify(ModifyKind::Metadata(MetadataKind::AccessTime)) => false,
        EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_) => true,
        EventKind::Any | EventKind::Other => true,
    }
}

fn relative_to_root<'a>(path: &'a str, root: &str) -> Option<&'a str> {
    if path == root {
        return Some("");
    }
    let remainder = path.strip_prefix(root)?;
    remainder.strip_prefix('/')
}

fn metadata_relative_is_relevant(relative: &str) -> bool {
    relative
        .split('/')
        .next()
        .is_none_or(|component| !component.eq_ignore_ascii_case("objects"))
}

async fn canonical_root(path: PathBuf) -> Result<PathBuf, GitWatchError> {
    tokio::fs::canonicalize(&path)
        .await
        .map_err(|source| GitWatchError::Root { path, source })
}

fn watch_roots(roots: &AdmittedRoots) -> Vec<(PathBuf, RecursiveMode)> {
    let mut watched = vec![(roots.worktree_root.clone(), RecursiveMode::Recursive)];
    for metadata_root in [&roots.git_dir, &roots.common_dir] {
        if watch_root_is_covered(metadata_root, &watched) {
            continue;
        }
        watched.push((metadata_root.clone(), RecursiveMode::NonRecursive));
    }
    let refs_root = roots.common_dir.join("refs");
    if !watch_root_is_covered(&refs_root, &watched) {
        watched.push((refs_root, RecursiveMode::Recursive));
    }
    watched
}

fn watch_root_is_covered(candidate: &Path, watched: &[(PathBuf, RecursiveMode)]) -> bool {
    watched.iter().any(|(root, mode)| {
        candidate == root || (*mode == RecursiveMode::Recursive && candidate.starts_with(root))
    })
}

fn normalize_registered_roots(
    watch_roots: &[(PathBuf, RecursiveMode)],
) -> Vec<(String, RecursiveMode)> {
    let platform = host_path_platform();
    watch_roots
        .iter()
        .map(|(path, mode)| (normalize_worktree_path_key(path, platform), *mode))
        .collect()
}

#[cfg(test)]
mod tests {
    use std::sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    };

    use notify::{
        Event, EventKind,
        event::{AccessKind, DataChange, Flag, ModifyKind, RenameMode},
    };

    use super::*;
    use crate::git::HostPathPlatform;

    #[derive(Clone, Default)]
    struct FakeWatcherBackendFactory {
        state: Arc<FakeBackendState>,
    }

    #[derive(Default)]
    struct FakeBackendState {
        callbacks: Mutex<Vec<BackendCallback>>,
        configs: Mutex<Vec<Config>>,
        watches: Mutex<Vec<(usize, PathBuf, RecursiveMode)>>,
        all_watches: Mutex<Vec<(usize, PathBuf, RecursiveMode)>>,
        unwatches: Mutex<Vec<(usize, PathBuf)>>,
        all_unwatches: Mutex<Vec<(usize, PathBuf)>>,
        created: AtomicUsize,
        dropped: AtomicUsize,
        fail_watch_at: AtomicUsize,
        suppress_readiness_callback: AtomicBool,
        readiness_probe_writes: AtomicUsize,
        readiness_probe_written: Notify,
        emit_nested_root_modify_any_during_watch: AtomicBool,
        watch_barrier: Mutex<Option<Arc<SetupBarrier>>>,
    }

    #[derive(Default)]
    struct SetupBarrier {
        entered: std::sync::atomic::AtomicBool,
        entered_notify: tokio::sync::Notify,
        released: Mutex<bool>,
        release_notify: std::sync::Condvar,
    }

    impl SetupBarrier {
        fn block(&self) {
            self.entered.store(true, Ordering::Release);
            self.entered_notify.notify_waiters();
            let mut released = self.released.lock().expect("barrier release lock");
            while !*released {
                released = self
                    .release_notify
                    .wait(released)
                    .expect("barrier release wait");
            }
        }

        async fn wait_until_entered(&self) {
            loop {
                let notified = self.entered_notify.notified();
                if self.entered.load(Ordering::Acquire) {
                    return;
                }
                notified.await;
            }
        }

        fn release(&self) {
            *self.released.lock().expect("barrier release lock") = true;
            self.release_notify.notify_all();
        }
    }

    #[test]
    fn readiness_canonicalize_failure_reports_cleanup_failure_without_losing_the_root() {
        let removed = Mutex::new(Vec::new());
        let error = create_readiness_probe_with(
            &[],
            Path::new("temporary"),
            |_| Ok(()),
            |_| {
                Err(io::Error::new(
                    ErrorKind::PermissionDenied,
                    "canonicalize denied",
                ))
            },
            |root| {
                removed
                    .lock()
                    .expect("removed roots lock")
                    .push(root.to_path_buf());
                Err(io::Error::other("cleanup denied"))
            },
        );
        let error = match error {
            Err(error) => error,
            Ok(_) => panic!("canonicalization and cleanup both fail"),
        };

        let detail = error.to_string();
        assert!(detail.contains("canonicalize denied"), "{detail}");
        assert!(detail.contains("cleanup denied"), "{detail}");
        let removed = removed.into_inner().expect("removed roots lock");
        assert_eq!(removed.len(), 1);
        assert!(is_readiness_directory(&removed[0]));
    }

    #[test]
    fn readiness_overlap_reports_cleanup_failure_for_the_canonical_root() {
        let admitted = tempfile::tempdir().expect("admitted root");
        let admitted = fs::canonicalize(admitted.path()).expect("canonical admitted root");
        let canonical_probe = admitted.join("probe");
        let removed = Mutex::new(Vec::new());
        let error = create_readiness_probe_with(
            &[(admitted, RecursiveMode::Recursive)],
            Path::new("temporary"),
            |_| Ok(()),
            |_| Ok(canonical_probe.clone()),
            |root| {
                removed
                    .lock()
                    .expect("removed roots lock")
                    .push(root.to_path_buf());
                Err(io::Error::other("overlap cleanup denied"))
            },
        );
        let error = match error {
            Err(error) => error,
            Ok(_) => panic!("overlap and cleanup both fail"),
        };

        let detail = error.to_string();
        assert!(detail.contains("overlaps an admitted root"), "{detail}");
        assert!(detail.contains("overlap cleanup denied"), "{detail}");
        assert_eq!(
            removed.into_inner().expect("removed roots lock"),
            [canonical_probe]
        );
    }

    struct FakeWatcherBackend {
        id: usize,
        watch_calls: usize,
        state: Arc<FakeBackendState>,
    }

    impl FakeWatcherBackendFactory {
        fn failing_on_watch(call: usize) -> Self {
            let factory = Self::default();
            factory.state.fail_watch_at.store(call, Ordering::Relaxed);
            factory
        }

        fn blocked_during_watch() -> (Self, Arc<SetupBarrier>) {
            let factory = Self::default();
            let barrier = Arc::new(SetupBarrier::default());
            *factory
                .state
                .watch_barrier
                .lock()
                .expect("watch barrier lock") = Some(Arc::clone(&barrier));
            (factory, barrier)
        }

        fn emitting_nested_root_modify_any_during_watch() -> Self {
            let factory = Self::default();
            factory
                .state
                .emit_nested_root_modify_any_during_watch
                .store(true, Ordering::Relaxed);
            factory
        }

        fn emit(&self, backend: usize, event: notify::Result<Event>) {
            let callback = self.state.callbacks.lock().expect("callbacks lock")[backend].clone();
            callback(event);
        }

        fn created(&self) -> usize {
            self.state.created.load(Ordering::Relaxed)
        }

        fn dropped(&self) -> usize {
            self.state.dropped.load(Ordering::Relaxed)
        }

        fn configs(&self) -> Vec<Config> {
            self.state.configs.lock().expect("configs lock").clone()
        }
    }

    impl GitWatcherBackendFactory for FakeWatcherBackendFactory {
        fn create(
            &self,
            callback: BackendCallback,
            config: Config,
        ) -> notify::Result<Box<dyn GitWatcherBackend>> {
            let id = self.state.created.fetch_add(1, Ordering::Relaxed);
            self.state
                .configs
                .lock()
                .expect("configs lock")
                .push(config);
            self.state
                .callbacks
                .lock()
                .expect("callbacks lock")
                .push(callback);
            Ok(Box::new(FakeWatcherBackend {
                id,
                watch_calls: 0,
                state: Arc::clone(&self.state),
            }))
        }
    }

    impl GitWatcherBackend for FakeWatcherBackend {
        fn watch(&mut self, path: &Path, recursive_mode: RecursiveMode) -> notify::Result<()> {
            self.watch_calls += 1;
            if self.watch_calls == 1
                && let Some(barrier) = self
                    .state
                    .watch_barrier
                    .lock()
                    .expect("watch barrier lock")
                    .clone()
            {
                barrier.block();
            }
            if self.state.fail_watch_at.load(Ordering::Relaxed) == self.watch_calls {
                return Err(notify::Error::generic("injected watch failure"));
            }
            self.state
                .all_watches
                .lock()
                .expect("all watches lock")
                .push((self.id, path.to_path_buf(), recursive_mode));
            if !is_readiness_directory(path) {
                self.state.watches.lock().expect("watches lock").push((
                    self.id,
                    path.to_path_buf(),
                    recursive_mode,
                ));
            }
            if self
                .state
                .emit_nested_root_modify_any_during_watch
                .load(Ordering::Relaxed)
                && recursive_mode == RecursiveMode::Recursive
                && self.watch_calls > 1
            {
                let callback =
                    self.state.callbacks.lock().expect("callbacks lock")[self.id].clone();
                callback(Ok(
                    Event::new(EventKind::Modify(ModifyKind::Any)).add_path(path.to_path_buf())
                ));
            }
            Ok(())
        }

        fn unwatch(&mut self, path: &Path) -> notify::Result<()> {
            self.state
                .all_unwatches
                .lock()
                .expect("all unwatches lock")
                .push((self.id, path.to_path_buf()));
            if !is_readiness_directory(path) {
                self.state
                    .unwatches
                    .lock()
                    .expect("unwatches lock")
                    .push((self.id, path.to_path_buf()));
            }
            Ok(())
        }

        fn readiness_probe_written(&mut self, sentinel: &Path) {
            self.state
                .readiness_probe_writes
                .fetch_add(1, Ordering::SeqCst);
            self.state.readiness_probe_written.notify_waiters();
            if self
                .state
                .suppress_readiness_callback
                .load(Ordering::SeqCst)
            {
                return;
            }
            let callback = self.state.callbacks.lock().expect("callbacks lock")[self.id].clone();
            callback(Ok(
                Event::new(EventKind::Any).add_path(sentinel.to_path_buf())
            ));
        }
    }

    impl Drop for FakeWatcherBackend {
        fn drop(&mut self) {
            self.state.dropped.fetch_add(1, Ordering::Relaxed);
        }
    }

    fn request(worktree: &Path, git_dir: &Path, common_dir: &Path) -> GitWatchRequest {
        GitWatchRequest {
            worktree_root: worktree.to_path_buf(),
            git_dir: git_dir.to_path_buf(),
            common_dir: common_dir.to_path_buf(),
        }
    }

    async fn expect_fake_event(
        subscription: &mut GitWatchSubscription,
        expected: GitWatchEvent,
        context: &str,
    ) {
        let actual = tokio::time::timeout(Duration::from_secs(1), subscription.recv())
            .await
            .unwrap_or_else(|_| panic!("fake watcher event deadline: {context}"))
            .unwrap_or_else(|| panic!("fake watcher closed: {context}"));
        assert_eq!(actual, expected, "{context}");
    }

    async fn expect_native_event(subscription: &mut GitWatchSubscription, expected: GitWatchEvent) {
        let actual = tokio::time::timeout(std::time::Duration::from_secs(5), subscription.recv())
            .await
            .expect("native watcher event deadline")
            .expect("native watcher remains open");
        assert_eq!(actual, expected);
    }

    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
    static NATIVE_READINESS_ID: AtomicUsize = AtomicUsize::new(0);

    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
    #[derive(Default)]
    struct NativeReadiness {
        observed: AtomicBool,
        notify: Notify,
    }

    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
    impl NativeReadiness {
        fn observe(&self) {
            self.observed.store(true, Ordering::Release);
            self.notify.notify_waiters();
        }

        async fn wait(&self) {
            loop {
                let notified = self.notify.notified();
                if self.observed.load(Ordering::Acquire) {
                    return;
                }
                notified.await;
            }
        }
    }

    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
    #[derive(Clone)]
    struct NativeReadinessRegistration {
        root: PathBuf,
        sentinel: PathBuf,
        sentinel_key: String,
        readiness: Arc<NativeReadiness>,
    }

    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
    #[derive(Default)]
    struct NativeReadinessState {
        registrations: Mutex<Vec<NativeReadinessRegistration>>,
    }

    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
    impl NativeReadinessState {
        fn registrations(&self) -> Vec<NativeReadinessRegistration> {
            self.registrations
                .lock()
                .expect("native readiness registrations lock")
                .iter()
                .filter(|registration| !is_readiness_directory(&registration.root))
                .cloned()
                .collect()
        }

        fn intercept(&self, event: &notify::Result<Event>) -> Option<Vec<Arc<NativeReadiness>>> {
            let event = event.as_ref().ok()?;
            if event.paths.is_empty() {
                return None;
            }
            let registrations = self
                .registrations
                .lock()
                .expect("native readiness registrations lock");
            event
                .paths
                .iter()
                .map(|path| {
                    let key = normalize_worktree_path_key(path, host_path_platform());
                    registrations
                        .iter()
                        .find(|registration| registration.sentinel_key == key)
                        .map(|registration| Arc::clone(&registration.readiness))
                })
                .collect()
        }
    }

    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
    struct NativeReadinessBackendFactory {
        id: usize,
        state: Arc<NativeReadinessState>,
    }

    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
    impl NativeReadinessBackendFactory {
        fn new(state: Arc<NativeReadinessState>) -> Self {
            Self {
                id: NATIVE_READINESS_ID.fetch_add(1, Ordering::Relaxed),
                state,
            }
        }
    }

    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
    impl GitWatcherBackendFactory for NativeReadinessBackendFactory {
        fn create(
            &self,
            callback: BackendCallback,
            config: Config,
        ) -> notify::Result<Box<dyn GitWatcherBackend>> {
            let state = Arc::clone(&self.state);
            let callback = Arc::new(move |event: notify::Result<Event>| {
                if let Some(readiness) = state.intercept(&event) {
                    for signal in readiness {
                        signal.observe();
                    }
                    return;
                }
                callback(event);
            });
            let backend = NativeWatcherBackendFactory.create(callback, config)?;
            Ok(Box::new(NativeReadinessBackend {
                id: self.id,
                backend,
                state: Arc::clone(&self.state),
            }))
        }
    }

    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
    struct NativeReadinessBackend {
        id: usize,
        backend: Box<dyn GitWatcherBackend>,
        state: Arc<NativeReadinessState>,
    }

    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
    impl GitWatcherBackend for NativeReadinessBackend {
        fn watch(&mut self, path: &Path, recursive_mode: RecursiveMode) -> notify::Result<()> {
            self.backend.watch(path, recursive_mode)?;
            let index = self
                .state
                .registrations
                .lock()
                .expect("native readiness registrations lock")
                .len();
            let sentinel = path.join(format!(".bibcode-watcher-ready-{}-{index}", self.id));
            self.state
                .registrations
                .lock()
                .expect("native readiness registrations lock")
                .push(NativeReadinessRegistration {
                    root: path.to_path_buf(),
                    sentinel_key: normalize_worktree_path_key(&sentinel, host_path_platform()),
                    sentinel,
                    readiness: Arc::new(NativeReadiness::default()),
                });
            Ok(())
        }

        fn unwatch(&mut self, path: &Path) -> notify::Result<()> {
            self.backend.unwatch(path)
        }
    }

    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
    struct NativeFixture {
        subscription: GitWatchSubscription,
        _service: GitWatchService,
        worktree: PathBuf,
        git_dir: PathBuf,
        common_dir: PathBuf,
        upstream_dir: PathBuf,
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        rename_source: PathBuf,
        readiness: Arc<NativeReadinessState>,
        _root: tempfile::TempDir,
        _native_test_guard: tokio::sync::MutexGuard<'static, ()>,
    }

    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
    impl NativeFixture {
        async fn new(seed_worktree_file: Option<(&str, &[u8])>) -> Self {
            let native_test_guard = acquire_native_watcher_test_permit().await;
            let root = tempfile::tempdir().expect("watch fixture");
            let worktree = root.path().join("worktree");
            let git_dir = root.path().join("git-dir");
            let common_dir = root.path().join("common-dir");
            let upstream_dir = common_dir.join("refs/remotes/origin");
            #[cfg(any(target_os = "linux", target_os = "macos"))]
            let rename_source = root.path().join("rename-source.txt");
            for path in [&worktree, &git_dir, &upstream_dir] {
                std::fs::create_dir_all(path).expect("watch root");
            }
            #[cfg(any(target_os = "linux", target_os = "macos"))]
            std::fs::write(&rename_source, b"first").expect("rename source");
            if let Some((name, contents)) = seed_worktree_file {
                let path = worktree.join(name);
                if let Some(parent) = path.parent() {
                    std::fs::create_dir_all(parent).expect("seed worktree parent");
                }
                std::fs::write(path, contents).expect("seed worktree file");
            }
            let readiness = Arc::new(NativeReadinessState::default());
            let service = GitWatchService::with_backend_factory(Arc::new(
                NativeReadinessBackendFactory::new(Arc::clone(&readiness)),
            ));
            let mut subscription = service
                .subscribe(request(&worktree, &git_dir, &common_dir))
                .await
                .expect("native watch subscription");
            let registrations = readiness.registrations();
            assert_eq!(registrations.len(), 4, "every actual root is probed");
            for registration in &registrations {
                assert_eq!(
                    registration.sentinel.parent(),
                    Some(registration.root.as_path())
                );
                std::fs::write(&registration.sentinel, b"ready")
                    .expect("native readiness sentinel");
            }
            for registration in &registrations {
                tokio::time::timeout(
                    std::time::Duration::from_secs(5),
                    registration.readiness.wait(),
                )
                .await
                .expect("native readiness deadline");
            }
            for registration in &registrations {
                std::fs::remove_file(&registration.sentinel)
                    .expect("remove native readiness sentinel");
            }
            assert_eq!(subscription.try_recv(), None);
            assert_eq!(subscription.health(), GitWatcherHealth::Healthy);
            Self {
                subscription,
                _service: service,
                worktree,
                git_dir,
                common_dir,
                upstream_dir,
                #[cfg(any(target_os = "linux", target_os = "macos"))]
                rename_source,
                readiness,
                _root: root,
                _native_test_guard: native_test_guard,
            }
        }

        async fn expect(&mut self, expected: GitWatchEvent) {
            expect_native_event(&mut self.subscription, expected).await;
        }

        fn readiness_registration_count(&self) -> usize {
            self.readiness.registrations().len()
        }

        fn readiness_acknowledgement_count(&self) -> usize {
            self.readiness
                .registrations()
                .iter()
                .filter(|registration| registration.readiness.observed.load(Ordering::Acquire))
                .count()
        }
    }

    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
    #[tokio::test]
    async fn native_readiness_probes_every_registered_root_without_publication() {
        let mut fixture = NativeFixture::new(None).await;
        assert_eq!(fixture.readiness_registration_count(), 4);
        assert_eq!(fixture.readiness_acknowledgement_count(), 4);
        assert_eq!(fixture.subscription.try_recv(), None);
        assert_eq!(fixture.subscription.health(), GitWatcherHealth::Healthy);
    }

    #[tokio::test]
    async fn canonical_aliases_share_one_backend_until_the_final_subscriber_leaves() {
        let root = tempfile::tempdir().expect("watch fixture");
        let worktree = root.path().join("worktree");
        let git_dir = worktree.join(".git");
        std::fs::create_dir_all(&git_dir).expect("Git directory");

        let backend = FakeWatcherBackendFactory::default();
        let service = GitWatchService::with_backend_factory(Arc::new(backend.clone()));
        let first = service
            .subscribe(request(&worktree, &git_dir, &git_dir))
            .await
            .expect("first watch");
        let alias = worktree.join("..").join("worktree");
        let second = service
            .subscribe(request(&alias, &alias.join(".git"), &alias.join(".git")))
            .await
            .expect("alias watch");

        assert_eq!(service.active_count_for_test(), 1);
        assert_eq!(backend.created(), 1);
        assert_eq!(
            backend.state.watches.lock().expect("watches lock").len(),
            1,
            "the recursive worktree watch covers an in-tree main-checkout Git directory"
        );
        drop(first);
        assert_eq!(service.active_count_for_test(), 1);
        assert_eq!(backend.dropped(), 0);
        drop(second);
        assert_eq!(service.active_count_for_test(), 0);
        assert_eq!(backend.dropped(), 1);
    }

    #[tokio::test]
    async fn readiness_root_is_registered_last_outside_user_roots_then_removed_without_publication()
    {
        let root = tempfile::tempdir().expect("watch fixture");
        let worktree = root.path().join("worktree");
        let git_dir = worktree.join(".git");
        std::fs::create_dir_all(&git_dir).expect("Git directory");
        let canonical_worktree = std::fs::canonicalize(&worktree).expect("canonical worktree");
        let canonical_git_dir = std::fs::canonicalize(&git_dir).expect("canonical Git directory");
        let backend = FakeWatcherBackendFactory::default();
        let service = GitWatchService::with_backend_factory(Arc::new(backend.clone()));

        let mut subscription = service
            .subscribe(request(&worktree, &git_dir, &git_dir))
            .await
            .expect("watch subscription");

        let watches = backend
            .state
            .all_watches
            .lock()
            .expect("all watches lock")
            .clone();
        assert_eq!(watches.len(), 2);
        assert_eq!(
            watches[0],
            (0, canonical_worktree.clone(), RecursiveMode::Recursive)
        );
        let readiness_root = &watches[1].1;
        assert_eq!(watches[1].2, RecursiveMode::NonRecursive);
        assert!(is_readiness_directory(readiness_root));
        assert!(!readiness_root.starts_with(&canonical_worktree));
        assert!(!readiness_root.starts_with(&canonical_git_dir));
        assert_eq!(
            backend.state.readiness_probe_writes.load(Ordering::SeqCst),
            1
        );
        assert_eq!(
            backend
                .state
                .all_unwatches
                .lock()
                .expect("all unwatches lock")
                .as_slice(),
            &[(0, readiness_root.clone())]
        );
        assert!(!readiness_root.exists());
        assert_eq!(subscription.try_recv(), None);
        assert_eq!(subscription.health(), GitWatcherHealth::Healthy);
    }

    #[tokio::test]
    async fn readiness_timeout_cleans_temp_watch_and_returns_sticky_fallback_subscription() {
        let root = tempfile::tempdir().expect("watch fixture");
        let worktree = root.path().join("worktree");
        let git_dir = worktree.join(".git");
        std::fs::create_dir_all(&git_dir).expect("Git directory");
        let backend = FakeWatcherBackendFactory::default();
        backend
            .state
            .suppress_readiness_callback
            .store(true, Ordering::SeqCst);
        let service = GitWatchService::with_backend_factory_and_readiness_timeout(
            Arc::new(backend.clone()),
            Duration::from_millis(50),
        );

        let mut subscription = tokio::time::timeout(
            Duration::from_secs(5),
            service.subscribe(request(&worktree, &git_dir, &git_dir)),
        )
        .await
        .expect("readiness timeout remains bounded")
        .expect("readiness timeout degrades instead of failing subscription");

        assert_eq!(subscription.health(), GitWatcherHealth::FallbackRequired);
        assert_eq!(subscription.recv().await, Some(GitWatchEvent::Unavailable));
        let readiness_root = backend
            .state
            .all_watches
            .lock()
            .expect("all watches lock")
            .last()
            .expect("readiness root was registered")
            .1
            .clone();
        assert!(is_readiness_directory(&readiness_root));
        assert!(
            backend
                .state
                .all_unwatches
                .lock()
                .expect("all unwatches lock")
                .iter()
                .any(|(_, path)| path == &readiness_root)
        );
        assert!(!readiness_root.exists());
    }

    #[tokio::test]
    async fn backend_configuration_disables_recursive_symlink_following() {
        let root = tempfile::tempdir().expect("watch fixture");
        let worktree = root.path().join("worktree");
        let git_dir = worktree.join(".git");
        std::fs::create_dir_all(&git_dir).expect("Git directory");
        let backend = FakeWatcherBackendFactory::default();
        let service = GitWatchService::with_backend_factory(Arc::new(backend.clone()));

        let _subscription = service
            .subscribe(request(&worktree, &git_dir, &git_dir))
            .await
            .expect("watch subscription");

        assert_eq!(backend.configs().len(), 1);
        assert!(!backend.configs()[0].follow_symlinks());
    }

    #[tokio::test]
    async fn registered_worktree_root_removal_requires_fallback() {
        let root = tempfile::tempdir().expect("watch fixture");
        let worktree = root.path().join("worktree");
        let git_dir = worktree.join(".git");
        std::fs::create_dir_all(&git_dir).expect("Git directory");
        let backend = FakeWatcherBackendFactory::default();
        let service = GitWatchService::with_backend_factory(Arc::new(backend.clone()));
        let mut subscription = service
            .subscribe(request(&worktree, &git_dir, &git_dir))
            .await
            .expect("watch subscription");
        let registered_worktree = backend.state.watches.lock().expect("watches lock")[0]
            .1
            .clone();

        backend.emit(
            0,
            Ok(
                Event::new(EventKind::Remove(notify::event::RemoveKind::Folder))
                    .add_path(registered_worktree),
            ),
        );

        assert_eq!(subscription.recv().await, Some(GitWatchEvent::Unavailable));
        assert_eq!(subscription.health(), GitWatcherHealth::FallbackRequired);
    }

    #[tokio::test]
    async fn every_linked_registered_root_loss_requires_fallback_but_child_removal_does_not() {
        let root = tempfile::tempdir().expect("watch fixture");
        let worktree = root.path().join("worktree");
        let git_dir = root.path().join("main.git/worktrees/topic");
        let common_dir = root.path().join("main.git");
        std::fs::create_dir_all(&worktree).expect("worktree");
        std::fs::create_dir_all(&git_dir).expect("Git directory");
        std::fs::create_dir_all(common_dir.join("refs")).expect("refs directory");
        let backend = FakeWatcherBackendFactory::default();
        let service = GitWatchService::with_backend_factory(Arc::new(backend.clone()));
        let mut subscription = service
            .subscribe(request(&worktree, &git_dir, &common_dir))
            .await
            .expect("linked watch subscription");
        let watches = backend.state.watches.lock().expect("watches lock").clone();
        assert_eq!(watches.len(), 4);

        for (index, (_, registered_root, _)) in watches.iter().enumerate() {
            let event = if index % 2 == 0 {
                Event::new(EventKind::Remove(notify::event::RemoveKind::Folder))
                    .add_path(registered_root.clone())
            } else {
                Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::Both)))
                    .add_path(registered_root.clone())
                    .add_path(registered_root.with_extension("retired"))
            };
            backend.emit(0, Ok(event));
            expect_fake_event(
                &mut subscription,
                GitWatchEvent::Unavailable,
                &format!("registered root {index} loss must require fallback"),
            )
            .await;
        }

        backend.emit(
            0,
            Ok(
                Event::new(EventKind::Remove(notify::event::RemoveKind::File))
                    .add_path(worktree.join("ordinary-child.txt")),
            ),
        );
        expect_fake_event(
            &mut subscription,
            GitWatchEvent::WorkingTree,
            "ordinary child removal remains a working-tree signal",
        )
        .await;
        assert_eq!(subscription.health(), GitWatcherHealth::FallbackRequired);
    }

    #[tokio::test]
    async fn nested_root_modify_any_is_suppressed_only_during_windows_installation() {
        let root = tempfile::tempdir().expect("watch fixture");
        let worktree = root.path().join("worktree");
        let git_dir = root.path().join("main.git/worktrees/topic");
        let common_dir = root.path().join("main.git");
        let refs_dir = common_dir.join("refs");
        for path in [&worktree, &git_dir, &refs_dir] {
            std::fs::create_dir_all(path).expect("watch root");
        }
        let backend = FakeWatcherBackendFactory::emitting_nested_root_modify_any_during_watch();
        let service = GitWatchService::with_backend_factory(Arc::new(backend.clone()));
        let mut subscription = service
            .subscribe(request(&worktree, &git_dir, &common_dir))
            .await
            .expect("watch subscription");
        let registered = backend.state.watches.lock().expect("watches lock").clone();
        let refs_root = registered
            .iter()
            .find_map(|(_, path, mode)| {
                (*mode == RecursiveMode::Recursive && path.ends_with("refs")).then(|| path.clone())
            })
            .expect("recursive refs registration");

        #[cfg(windows)]
        assert_eq!(
            subscription.try_recv(),
            None,
            "the synchronous Windows setup artifact is private"
        );
        #[cfg(not(windows))]
        assert_eq!(
            subscription.try_recv(),
            Some(GitWatchEvent::Metadata),
            "non-Windows platforms never suppress the event"
        );

        let event = Event::new(EventKind::Modify(ModifyKind::Any)).add_path(refs_root.clone());
        backend.emit(0, Ok(event.clone()));
        assert_eq!(
            subscription.try_recv(),
            Some(GitWatchEvent::Metadata),
            "the identical event after backend commit remains observable"
        );

        let aliases = identity_for_paths(&worktree, &git_dir, &common_dir, host_path_platform());
        let roots = identity_for_paths(
            std::fs::canonicalize(&worktree).expect("canonical worktree"),
            std::fs::canonicalize(&git_dir).expect("canonical Git directory"),
            std::fs::canonicalize(&common_dir).expect("canonical common directory"),
            host_path_platform(),
        );
        let root_aliases = [roots.clone(), aliases];
        let registered = registered
            .into_iter()
            .map(|(_, path, mode)| {
                (
                    normalize_worktree_path_key(&path, host_path_platform()),
                    mode,
                )
            })
            .collect::<Vec<_>>();

        assert_eq!(
            classify_event(
                &event,
                &roots,
                &root_aliases,
                &registered,
                host_path_platform(),
            ),
            Some(GitWatchEvent::Metadata),
            "the classifier never permanently suppresses this metadata shape"
        );

        for event in [
            Event::new(EventKind::Create(notify::event::CreateKind::File))
                .add_path(refs_root.join("heads/new")),
            Event::new(EventKind::Remove(notify::event::RemoveKind::File))
                .add_path(refs_root.join("heads/old")),
            Event::new(EventKind::Modify(ModifyKind::Data(DataChange::Content)))
                .add_path(refs_root.join("heads/main")),
            Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::Both)))
                .add_path(refs_root.join("heads/main.lock"))
                .add_path(refs_root.join("heads/main")),
        ] {
            assert_eq!(
                classify_event(
                    &event,
                    &roots,
                    &root_aliases,
                    &registered,
                    host_path_platform(),
                ),
                Some(GitWatchEvent::Metadata),
                "child create, delete, content, and rename changes remain invalidating"
            );
        }
    }

    #[tokio::test]
    async fn removed_and_recreated_refs_root_stays_fallback_until_reattachment() {
        let root = tempfile::tempdir().expect("watch fixture");
        let worktree = root.path().join("worktree");
        let git_dir = root.path().join("main.git/worktrees/topic");
        let common_dir = root.path().join("main.git");
        let refs_dir = common_dir.join("refs");
        std::fs::create_dir_all(&worktree).expect("worktree");
        std::fs::create_dir_all(&git_dir).expect("Git directory");
        std::fs::create_dir_all(&refs_dir).expect("refs directory");
        let backend = FakeWatcherBackendFactory::default();
        let service = GitWatchService::with_backend_factory(Arc::new(backend.clone()));
        let mut first = service
            .subscribe(request(&worktree, &git_dir, &common_dir))
            .await
            .expect("first watch generation");
        let registered_refs = backend
            .state
            .watches
            .lock()
            .expect("watches lock")
            .iter()
            .find_map(|(_, path, mode)| {
                (*mode == RecursiveMode::Recursive && path.ends_with("refs")).then(|| path.clone())
            })
            .expect("registered refs root");

        std::fs::remove_dir_all(&refs_dir).expect("remove refs root");
        backend.emit(
            0,
            Ok(
                Event::new(EventKind::Remove(notify::event::RemoveKind::Folder))
                    .add_path(registered_refs.clone()),
            ),
        );
        assert_eq!(first.recv().await, Some(GitWatchEvent::Unavailable));
        std::fs::create_dir_all(&refs_dir).expect("recreate refs root");
        backend.emit(
            0,
            Ok(
                Event::new(EventKind::Create(notify::event::CreateKind::Folder))
                    .add_path(registered_refs.clone()),
            ),
        );
        assert_eq!(first.recv().await, Some(GitWatchEvent::Metadata));
        assert_eq!(first.health(), GitWatcherHealth::FallbackRequired);
        drop(first);

        let mut replacement = service
            .subscribe(request(&worktree, &git_dir, &common_dir))
            .await
            .expect("replacement generation");
        assert_eq!(replacement.health(), GitWatcherHealth::Healthy);
        backend.emit(
            0,
            Ok(
                Event::new(EventKind::Remove(notify::event::RemoveKind::Folder))
                    .add_path(registered_refs),
            ),
        );
        assert_eq!(replacement.try_recv(), None);
        assert_eq!(replacement.health(), GitWatcherHealth::Healthy);
        backend.emit(
            1,
            Ok(
                Event::new(EventKind::Remove(notify::event::RemoveKind::File))
                    .add_path(refs_dir.join("heads/main")),
            ),
        );
        assert_eq!(replacement.recv().await, Some(GitWatchEvent::Metadata));
        assert_eq!(replacement.health(), GitWatcherHealth::Healthy);
    }

    #[tokio::test]
    async fn shutdown_waits_for_canceled_blocking_setup_to_drop_its_backend() {
        let root = tempfile::tempdir().expect("watch fixture");
        let worktree = root.path().join("worktree");
        let git_dir = worktree.join(".git");
        std::fs::create_dir_all(&git_dir).expect("Git directory");
        let (backend, barrier) = FakeWatcherBackendFactory::blocked_during_watch();
        let service = GitWatchService::with_backend_factory(Arc::new(backend.clone()));
        let subscribing_service = service.clone();
        let subscribe = tokio::spawn(async move {
            subscribing_service
                .subscribe(request(&worktree, &git_dir, &git_dir))
                .await
        });

        barrier.wait_until_entered().await;
        assert_eq!(service.setup_count_for_test(), 1);
        subscribe.abort();
        let join_error = match subscribe.await {
            Err(error) => error,
            Ok(_) => panic!("subscribe task was not canceled"),
        };
        assert!(join_error.is_cancelled());

        let mut shutdown = Box::pin(service.shutdown());
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(50), &mut shutdown)
                .await
                .is_err(),
            "shutdown must retain ownership of a canceled subscribe's blocking setup"
        );
        assert_eq!(backend.dropped(), 0);

        barrier.release();
        tokio::time::timeout(std::time::Duration::from_secs(5), shutdown)
            .await
            .expect("shutdown waits only until setup releases");
        assert_eq!(backend.dropped(), 1);
        assert_eq!(service.setup_count_for_test(), 0);
    }

    #[tokio::test]
    async fn canonical_alias_subscribe_waits_for_the_shared_blocking_setup() {
        let root = tempfile::tempdir().expect("watch fixture");
        let worktree = root.path().join("worktree");
        let git_dir = worktree.join(".git");
        std::fs::create_dir_all(&git_dir).expect("Git directory");
        let (backend, barrier) = FakeWatcherBackendFactory::blocked_during_watch();
        let service = GitWatchService::with_backend_factory(Arc::new(backend.clone()));
        let first_service = service.clone();
        let first_worktree = worktree.clone();
        let first_git_dir = git_dir.clone();
        let first = tokio::spawn(async move {
            first_service
                .subscribe(request(&first_worktree, &first_git_dir, &first_git_dir))
                .await
        });
        barrier.wait_until_entered().await;

        let alias = worktree.join("..").join("worktree");
        let alias_service = service.clone();
        let second = tokio::spawn(async move {
            alias_service
                .subscribe(request(&alias, &alias.join(".git"), &alias.join(".git")))
                .await
        });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        let completed_before_setup = second.is_finished();
        barrier.release();
        assert!(
            !completed_before_setup,
            "an alias must not report a healthy subscription before shared setup completes"
        );
        let first = first
            .await
            .expect("first join")
            .expect("first subscription");
        let second = second
            .await
            .expect("second join")
            .expect("second subscription");
        assert_eq!(backend.created(), 1);
        drop(first);
        drop(second);
    }

    #[tokio::test]
    async fn retains_only_the_latest_pending_signal_without_losing_later_identical_events() {
        let root = tempfile::tempdir().expect("watch fixture");
        let worktree = root.path().join("worktree");
        let git_dir = root.path().join("git-dir");
        let common_dir = root.path().join("common-dir");
        for path in [&worktree, &git_dir, &common_dir] {
            std::fs::create_dir_all(path).expect("watch root");
        }
        let backend = FakeWatcherBackendFactory::default();
        let service = GitWatchService::with_backend_factory(Arc::new(backend.clone()));
        let mut subscription = service
            .subscribe(request(&worktree, &git_dir, &common_dir))
            .await
            .expect("watch subscription");

        backend.emit(
            0,
            Ok(
                Event::new(EventKind::Create(notify::event::CreateKind::File))
                    .add_path(worktree.join("tracked.txt")),
            ),
        );
        backend.emit(
            0,
            Ok(
                Event::new(EventKind::Modify(ModifyKind::Data(DataChange::Content)))
                    .add_path(git_dir.join("HEAD")),
            ),
        );
        assert_eq!(subscription.recv().await, Some(GitWatchEvent::Metadata));
        assert_eq!(subscription.try_recv(), None);

        backend.emit(
            0,
            Ok(
                Event::new(EventKind::Modify(ModifyKind::Data(DataChange::Content)))
                    .add_path(git_dir.join("HEAD")),
            ),
        );
        assert_eq!(subscription.recv().await, Some(GitWatchEvent::Metadata));
    }

    #[tokio::test]
    async fn fallback_health_is_sticky_for_late_subscribers_until_a_new_generation() {
        let root = tempfile::tempdir().expect("watch fixture");
        let worktree = root.path().join("worktree");
        let git_dir = worktree.join(".git");
        std::fs::create_dir_all(&git_dir).expect("Git directory");
        let backend = FakeWatcherBackendFactory::default();
        let service = GitWatchService::with_backend_factory(Arc::new(backend.clone()));
        let mut first = service
            .subscribe(request(&worktree, &git_dir, &git_dir))
            .await
            .expect("first subscriber");

        backend.emit(0, Ok(Event::new(EventKind::Other).set_flag(Flag::Rescan)));
        expect_fake_event(
            &mut first,
            GitWatchEvent::Overflow,
            "overflow signal is observable before later ordinary events",
        )
        .await;
        backend.emit(
            0,
            Ok(
                Event::new(EventKind::Modify(ModifyKind::Data(DataChange::Content)))
                    .add_path(worktree.join("tracked.txt")),
            ),
        );
        expect_fake_event(
            &mut first,
            GitWatchEvent::WorkingTree,
            "ordinary events continue after sticky fallback health",
        )
        .await;
        assert_eq!(first.health(), GitWatcherHealth::FallbackRequired);

        let late = service
            .subscribe(request(&worktree, &git_dir, &git_dir))
            .await
            .expect("late subscriber");
        assert_eq!(late.health(), GitWatcherHealth::FallbackRequired);
        drop(first);
        drop(late);

        let mut replacement = service
            .subscribe(request(&worktree, &git_dir, &git_dir))
            .await
            .expect("replacement generation");
        assert_eq!(replacement.health(), GitWatcherHealth::Healthy);
        backend.emit(0, Ok(Event::new(EventKind::Other).set_flag(Flag::Rescan)));
        assert_eq!(replacement.try_recv(), None);
        assert_eq!(replacement.health(), GitWatcherHealth::Healthy);

        backend.emit(
            1,
            Ok(
                Event::new(EventKind::Modify(ModifyKind::Data(DataChange::Content)))
                    .add_path(worktree.join("tracked.txt")),
            ),
        );
        assert_eq!(replacement.recv().await, Some(GitWatchEvent::WorkingTree));
        assert_eq!(replacement.health(), GitWatcherHealth::Healthy);
    }

    #[tokio::test]
    async fn overflow_and_backend_errors_require_fallback_without_clean_publication() {
        let root = tempfile::tempdir().expect("watch fixture");
        let worktree = root.path().join("worktree");
        let git_dir = root.path().join("git-dir");
        for path in [&worktree, &git_dir] {
            std::fs::create_dir_all(path).expect("watch root");
        }
        let backend = FakeWatcherBackendFactory::default();
        let service = GitWatchService::with_backend_factory(Arc::new(backend.clone()));
        let mut subscription = service
            .subscribe(request(&worktree, &git_dir, &git_dir))
            .await
            .expect("watch subscription");

        backend.emit(0, Ok(Event::new(EventKind::Other).set_flag(Flag::Rescan)));
        assert_eq!(subscription.recv().await, Some(GitWatchEvent::Overflow));
        assert_eq!(subscription.health(), GitWatcherHealth::FallbackRequired);

        backend.emit(0, Err(notify::Error::generic("backend interrupted")));
        assert_eq!(subscription.recv().await, Some(GitWatchEvent::Unavailable));
        assert_eq!(subscription.health(), GitWatcherHealth::FallbackRequired);

        backend.emit(0, Ok(Event::new(EventKind::Other)));
        assert_eq!(
            subscription.recv().await,
            Some(GitWatchEvent::Unavailable),
            "a pathless interruption cannot be classified as a clean no-op"
        );
    }

    #[tokio::test]
    async fn backend_creation_failure_publishes_unavailable() {
        struct UnavailableBackendFactory;

        impl GitWatcherBackendFactory for UnavailableBackendFactory {
            fn create(
                &self,
                _callback: BackendCallback,
                _config: Config,
            ) -> notify::Result<Box<dyn GitWatcherBackend>> {
                Err(notify::Error::generic("injected backend creation failure"))
            }
        }

        let root = tempfile::tempdir().expect("watch fixture");
        let worktree = root.path().join("worktree");
        let git_dir = root.path().join("git-dir");
        for path in [&worktree, &git_dir] {
            std::fs::create_dir_all(path).expect("watch root");
        }
        let service = GitWatchService::with_backend_factory(Arc::new(UnavailableBackendFactory));
        let mut subscription = service
            .subscribe(request(&worktree, &git_dir, &git_dir))
            .await
            .expect("fallback subscription remains available");

        assert_eq!(subscription.recv().await, Some(GitWatchEvent::Unavailable));
        assert_eq!(subscription.health(), GitWatcherHealth::FallbackRequired);
    }

    #[tokio::test]
    async fn partial_setup_rolls_back_and_publishes_unavailable() {
        let root = tempfile::tempdir().expect("watch fixture");
        let worktree = root.path().join("worktree");
        let git_dir = root.path().join("git-dir");
        let common_dir = root.path().join("common-dir");
        for path in [&worktree, &git_dir, &common_dir] {
            std::fs::create_dir_all(path).expect("watch root");
        }
        let backend = FakeWatcherBackendFactory::failing_on_watch(2);
        let service = GitWatchService::with_backend_factory(Arc::new(backend.clone()));
        let mut subscription = service
            .subscribe(request(&worktree, &git_dir, &common_dir))
            .await
            .expect("fallback subscription remains available");

        assert_eq!(subscription.recv().await, Some(GitWatchEvent::Unavailable));
        assert_eq!(subscription.health(), GitWatcherHealth::FallbackRequired);
        assert_eq!(
            backend
                .state
                .unwatches
                .lock()
                .expect("unwatches lock")
                .len(),
            1
        );
        assert_eq!(backend.dropped(), 1);
    }

    #[tokio::test]
    async fn retired_generation_callbacks_cannot_publish_into_reattachment() {
        let root = tempfile::tempdir().expect("watch fixture");
        let worktree = root.path().join("worktree");
        let git_dir = root.path().join("git-dir");
        for path in [&worktree, &git_dir] {
            std::fs::create_dir_all(path).expect("watch root");
        }
        let backend = FakeWatcherBackendFactory::default();
        let service = GitWatchService::with_backend_factory(Arc::new(backend.clone()));
        let first = service
            .subscribe(request(&worktree, &git_dir, &git_dir))
            .await
            .expect("first generation");
        drop(first);
        let mut second = service
            .subscribe(request(&worktree, &git_dir, &git_dir))
            .await
            .expect("second generation");
        let event = || {
            Ok(
                Event::new(EventKind::Modify(ModifyKind::Data(DataChange::Content)))
                    .add_path(worktree.join("tracked.txt")),
            )
        };

        backend.emit(0, event());
        assert_eq!(second.try_recv(), None);
        backend.emit(1, event());
        assert_eq!(second.recv().await, Some(GitWatchEvent::WorkingTree));
        assert_eq!(backend.created(), 2);
        assert_eq!(backend.dropped(), 1);
    }

    #[tokio::test]
    async fn linked_worktree_watches_nested_common_refs_without_duplicate_roots() {
        let root = tempfile::tempdir().expect("watch fixture");
        let worktree = root.path().join("worktree");
        let git_dir = root.path().join("main.git/worktrees/topic");
        let common_dir = root.path().join("main.git");
        let upstream_dir = common_dir.join("refs/remotes/origin");
        for path in [&worktree, &git_dir, &upstream_dir] {
            std::fs::create_dir_all(path).expect("watch root");
        }
        let backend = FakeWatcherBackendFactory::default();
        let service = GitWatchService::with_backend_factory(Arc::new(backend.clone()));
        let mut subscription = service
            .subscribe(request(&worktree, &git_dir, &common_dir))
            .await
            .expect("linked-worktree watch");

        let watches = backend.state.watches.lock().expect("watches lock").clone();
        let canonical_worktree = std::fs::canonicalize(&worktree).expect("canonical worktree");
        let canonical_git_dir = std::fs::canonicalize(&git_dir).expect("canonical Git directory");
        let canonical_common_dir =
            std::fs::canonicalize(&common_dir).expect("canonical common directory");
        assert_eq!(
            watches,
            vec![
                (0, canonical_worktree, RecursiveMode::Recursive),
                (0, canonical_git_dir, RecursiveMode::NonRecursive),
                (0, canonical_common_dir.clone(), RecursiveMode::NonRecursive),
                (
                    0,
                    canonical_common_dir.join("refs"),
                    RecursiveMode::Recursive,
                ),
            ]
        );
        backend.emit(
            0,
            Ok(
                Event::new(EventKind::Modify(ModifyKind::Data(DataChange::Content)))
                    .add_path(upstream_dir.join("main")),
            ),
        );
        expect_fake_event(
            &mut subscription,
            GitWatchEvent::Metadata,
            "nested common ref changes publish metadata",
        )
        .await;
    }

    #[tokio::test]
    async fn dropping_the_service_reaps_the_backend_and_late_callbacks_are_inert() {
        let root = tempfile::tempdir().expect("watch fixture");
        let worktree = root.path().join("worktree");
        let git_dir = root.path().join("git-dir");
        for path in [&worktree, &git_dir] {
            std::fs::create_dir_all(path).expect("watch root");
        }
        let backend = FakeWatcherBackendFactory::default();
        let service = GitWatchService::with_backend_factory(Arc::new(backend.clone()));
        let mut subscription = service
            .subscribe(request(&worktree, &git_dir, &git_dir))
            .await
            .expect("watch subscription");

        drop(service);
        assert_eq!(backend.dropped(), 1);
        let callback_backend = backend.clone();
        std::thread::spawn(move || {
            callback_backend.emit(
                0,
                Ok(
                    Event::new(EventKind::Modify(ModifyKind::Data(DataChange::Content)))
                        .add_path(worktree.join("late.txt")),
                ),
            );
        })
        .join()
        .expect("late callback thread");
        assert_eq!(subscription.recv().await, None);
    }

    #[tokio::test]
    async fn shutdown_reaps_all_backends_rejects_reattachment_and_ignores_late_callbacks() {
        let root = tempfile::tempdir().expect("watch fixture");
        let worktree = root.path().join("worktree");
        let git_dir = root.path().join("git-dir");
        for path in [&worktree, &git_dir] {
            std::fs::create_dir_all(path).expect("watch root");
        }
        let backend = FakeWatcherBackendFactory::default();
        let service = GitWatchService::with_backend_factory(Arc::new(backend.clone()));
        let mut subscription = service
            .subscribe(request(&worktree, &git_dir, &git_dir))
            .await
            .expect("watch subscription");

        service.shutdown().await;
        assert_eq!(service.active_count_for_test(), 0);
        assert_eq!(backend.dropped(), 1);
        backend.emit(
            0,
            Ok(
                Event::new(EventKind::Modify(ModifyKind::Data(DataChange::Content)))
                    .add_path(worktree.join("late.txt")),
            ),
        );
        assert_eq!(subscription.recv().await, None);
        assert!(matches!(
            service
                .subscribe(request(&worktree, &git_dir, &git_dir))
                .await,
            Err(GitWatchError::Shutdown)
        ));
    }

    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
    #[tokio::test]
    async fn native_backend_observes_atomic_create_and_rename() {
        let mut fixture = NativeFixture::new(None).await;
        let temporary = fixture.worktree.join("tracked.txt.tmp");
        let tracked = fixture.worktree.join("tracked.txt");
        std::fs::write(&temporary, b"first").expect("atomic temporary write");
        std::fs::rename(&temporary, &tracked).expect("atomic rename");
        fixture.expect(GitWatchEvent::WorkingTree).await;
    }

    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
    #[tokio::test]
    async fn native_backend_observes_content_modify() {
        use std::io::Write;

        let mut fixture = NativeFixture::new(Some(("tracked.txt", b"first"))).await;
        let tracked = fixture.worktree.join("tracked.txt");
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&tracked)
            .expect("open tracked file");
        file.write_all(b" second").expect("content write");
        file.sync_all().expect("flush content write");
        drop(file);
        fixture.expect(GitWatchEvent::WorkingTree).await;
    }

    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
    #[tokio::test]
    async fn native_backend_observes_content_modify_with_nested_git_directory() {
        use std::io::Write;

        let _native_test_guard = acquire_native_watcher_test_permit().await;
        let root = tempfile::tempdir().expect("nested Git watch fixture");
        let worktree = root.path().join("worktree");
        let git_dir = worktree.join(".git");
        std::fs::create_dir_all(git_dir.join("refs")).expect("nested Git directory");
        let tracked = worktree.join("tracked.txt");
        std::fs::write(&tracked, b"first").expect("seed tracked file");
        let readiness = Arc::new(NativeReadinessState::default());
        let service = GitWatchService::with_backend_factory(Arc::new(
            NativeReadinessBackendFactory::new(Arc::clone(&readiness)),
        ));
        let mut subscription = service
            .subscribe(request(&worktree, &git_dir, &git_dir))
            .await
            .expect("nested native watch subscription");
        let registrations = readiness.registrations();
        assert_eq!(
            registrations.len(),
            1,
            "recursive worktree covers nested Git roots"
        );
        std::fs::write(&registrations[0].sentinel, b"ready").expect("native readiness sentinel");
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            registrations[0].readiness.wait(),
        )
        .await
        .expect("nested native readiness deadline");
        std::fs::remove_file(&registrations[0].sentinel).expect("remove native readiness sentinel");
        assert_eq!(subscription.try_recv(), None);

        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&tracked)
            .expect("open tracked file");
        file.write_all(b" second").expect("content write");
        file.sync_all().expect("flush content write");
        drop(file);
        expect_native_event(&mut subscription, GitWatchEvent::WorkingTree).await;
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[tokio::test]
    async fn native_backend_observes_rename() {
        let mut fixture = NativeFixture::new(None).await;
        let renamed = fixture.worktree.join("renamed.txt");
        std::fs::rename(&fixture.rename_source, &renamed).expect("tracked rename");
        fixture.expect(GitWatchEvent::WorkingTree).await;
    }

    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
    #[tokio::test]
    async fn native_backend_observes_delete() {
        let mut fixture = NativeFixture::new(Some(("obsolete/tracked.txt", b"first"))).await;
        std::fs::remove_dir_all(fixture.worktree.join("obsolete")).expect("tracked delete");
        fixture.expect(GitWatchEvent::WorkingTree).await;
    }

    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
    #[tokio::test]
    async fn native_backend_observes_head() {
        let mut fixture = NativeFixture::new(None).await;
        std::fs::write(fixture.git_dir.join("HEAD"), b"ref: refs/heads/main\n")
            .expect("HEAD write");
        fixture.expect(GitWatchEvent::Metadata).await;
    }

    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
    #[tokio::test]
    async fn native_backend_observes_index() {
        let mut fixture = NativeFixture::new(None).await;
        std::fs::write(fixture.git_dir.join("index"), b"index contents").expect("index write");
        fixture.expect(GitWatchEvent::Metadata).await;
    }

    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
    #[tokio::test]
    async fn native_backend_observes_packed_refs() {
        let mut fixture = NativeFixture::new(None).await;
        let lock = fixture.common_dir.join("packed-refs.lock");
        std::fs::write(&lock, b"# pack-refs with: peeled fully-peeled\n")
            .expect("packed refs lock write");
        std::fs::rename(lock, fixture.common_dir.join("packed-refs")).expect("packed refs commit");
        fixture.expect(GitWatchEvent::Metadata).await;
    }

    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
    #[tokio::test]
    async fn native_backend_observes_nested_refs() {
        let mut fixture = NativeFixture::new(None).await;
        std::fs::write(fixture.upstream_dir.join("main"), b"0123456789abcdef\n")
            .expect("nested upstream ref write");
        fixture.expect(GitWatchEvent::Metadata).await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn native_backend_does_not_follow_worktree_symlink_to_an_outside_target() {
        use std::os::unix::fs::symlink;

        let _native_test_guard = acquire_native_watcher_test_permit().await;
        let root = tempfile::tempdir().expect("watch fixture");
        let worktree = root.path().join("worktree");
        let outside = root.path().join("outside");
        let git_dir = root.path().join("git-dir");
        let common_dir = root.path().join("common-dir");
        for path in [&worktree, &outside, &git_dir, &common_dir.join("refs")] {
            std::fs::create_dir_all(path).expect("watch root");
        }
        symlink(&outside, worktree.join("outside-link")).expect("outside symlink");
        let service = GitWatchService::new();
        let mut subscription = service
            .subscribe(request(&worktree, &git_dir, &common_dir))
            .await
            .expect("native watch subscription");

        std::fs::write(outside.join("not-in-worktree.txt"), b"outside")
            .expect("outside target write");
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(300), subscription.recv())
                .await
                .is_err(),
            "outside-target activity must not traverse the worktree symlink"
        );
    }

    #[test]
    fn fake_platform_shapes_classify_mutations_without_escaping_admitted_roots() {
        let windows = identity_for_paths(
            r"C:\repo",
            r"C:\repo\.git",
            r"C:\repo\.git",
            HostPathPlatform::Windows,
        );
        let linux = identity_for_paths(
            "/repo",
            "/repo/.git/worktrees/topic",
            "/repo/.git",
            HostPathPlatform::Posix,
        );
        let macos = identity_for_paths(
            "/Users/dev/repo",
            "/Users/dev/repo/.git/worktrees/topic",
            "/Users/dev/repo/.git",
            HostPathPlatform::Posix,
        );
        let windows_registered = vec![(windows.worktree_root.clone(), RecursiveMode::Recursive)];
        let linux_registered = vec![
            (linux.worktree_root.clone(), RecursiveMode::Recursive),
            (linux.git_dir.clone(), RecursiveMode::NonRecursive),
            (linux.common_dir.clone(), RecursiveMode::NonRecursive),
            (
                format!("{}/refs", linux.common_dir),
                RecursiveMode::Recursive,
            ),
        ];
        let macos_registered = vec![
            (macos.worktree_root.clone(), RecursiveMode::Recursive),
            (macos.git_dir.clone(), RecursiveMode::NonRecursive),
            (macos.common_dir.clone(), RecursiveMode::NonRecursive),
            (
                format!("{}/refs", macos.common_dir),
                RecursiveMode::Recursive,
            ),
        ];

        assert_eq!(
            classify_event(
                &Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::Both)))
                    .add_path(r"C:\repo\tracked.txt.tmp".into())
                    .add_path(r"C:\repo\tracked.txt".into()),
                &windows,
                std::slice::from_ref(&windows),
                &windows_registered,
                HostPathPlatform::Windows,
            ),
            Some(GitWatchEvent::WorkingTree)
        );
        assert_eq!(
            classify_event(
                &Event::new(EventKind::Modify(ModifyKind::Data(DataChange::Content)))
                    .add_path("/repo/.git/worktrees/topic/HEAD".into()),
                &linux,
                std::slice::from_ref(&linux),
                &linux_registered,
                HostPathPlatform::Posix,
            ),
            Some(GitWatchEvent::Metadata)
        );
        assert_eq!(
            classify_event(
                &Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::Both)))
                    .add_path("/repo/tracked.txt".into())
                    .add_path("/repo/.git/worktrees/topic/index".into()),
                &linux,
                std::slice::from_ref(&linux),
                &linux_registered,
                HostPathPlatform::Posix,
            ),
            Some(GitWatchEvent::Metadata),
            "one backend burst touching Git metadata invalidates metadata even when it also touches the worktree"
        );
        assert_eq!(
            classify_event(
                &Event::new(EventKind::Modify(ModifyKind::Data(DataChange::Content)))
                    .add_path(r"C:\repo\..\outside\tracked.txt".into()),
                &windows,
                std::slice::from_ref(&windows),
                &windows_registered,
                HostPathPlatform::Windows,
            ),
            None
        );
        assert_eq!(
            classify_event(
                &Event::new(EventKind::Any)
                    .add_path("/Users/dev/repo/.git/refs/remotes/origin/main".into()),
                &macos,
                std::slice::from_ref(&macos),
                &macos_registered,
                HostPathPlatform::Posix,
            ),
            Some(GitWatchEvent::Metadata)
        );
        assert_eq!(
            classify_event(
                &Event::new(EventKind::Modify(ModifyKind::Data(DataChange::Content)))
                    .add_path("/repo-other/tracked.txt".into()),
                &linux,
                std::slice::from_ref(&linux),
                &linux_registered,
                HostPathPlatform::Posix,
            ),
            None,
            "lexical containment rejects sibling roots with a shared prefix"
        );
        assert_eq!(
            classify_event(
                &Event::new(EventKind::Access(AccessKind::Close(AccessMode::Write)))
                    .add_path(r"C:\repo\tracked.txt.tmp".into()),
                &windows,
                std::slice::from_ref(&windows),
                &windows_registered,
                HostPathPlatform::Windows,
            ),
            Some(GitWatchEvent::WorkingTree),
            "temporary names remain invalidating for write-close events"
        );
        assert_eq!(
            classify_event(
                &Event::new(EventKind::Access(AccessKind::Read))
                    .add_path(r"C:\repo\tracked.txt.tmp".into()),
                &windows,
                std::slice::from_ref(&windows),
                &windows_registered,
                HostPathPlatform::Windows,
            ),
            None
        );
    }
}
