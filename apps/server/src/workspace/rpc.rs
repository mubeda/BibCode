use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use crate::assets::{AssetAccess, AssetError, AssetIssueRequest, AssetResource};
use crate::review::{ReviewDiffPreviewInput, ReviewError, ReviewService};
use crate::worktree_catalog::{
    WorkspaceAdmissionCancellation, WorkspaceAdmissionLease, WorkspaceAvailabilityRegistry,
};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::{Mutex, broadcast};
use tokio_util::sync::CancellationToken;

use super::paths::normalize_root;
use super::watcher::{WatchScope, WatchScopeFuture, WatchSubscription, WorkspaceWatcher};
use super::{EntryKind, SearchLimits, WorkspaceError, WorkspaceSearchIndex, WorkspaceService};

const PROJECT_ENTRIES_MAX_LIMIT: usize = 200;

pub const TASK_SIX_RPC_METHODS: [&str; 11] = [
    "projects.searchEntries",
    "projects.listEntries",
    "projects.readFile",
    "projects.writeFile",
    "projects.createEntry",
    "projects.renameEntry",
    "projects.deleteEntry",
    "projects.duplicateEntry",
    "filesystem.browse",
    "assets.createUrl",
    "review.getDiffPreview",
];

type AssetContextFuture<'a> =
    Pin<Box<dyn Future<Output = Result<Option<PathBuf>, String>> + Send + 'a>>;
pub type WorkspaceMutationFuture<'a> = Pin<Box<dyn Future<Output = ()> + Send + 'a>>;

pub trait AssetContextResolver: Send + Sync {
    fn resolve_workspace_root<'a>(&'a self, thread_id: &'a str) -> AssetContextFuture<'a>;
}

pub trait WorkspaceMutationObserver: Send + Sync {
    fn workspace_mutated<'a>(&'a self, cwd: &'a Path) -> WorkspaceMutationFuture<'a>;
}

#[derive(Clone, Default)]
pub struct WorkspaceRpcDependencies {
    pub asset_access: Option<AssetAccess>,
    pub asset_context_resolver: Option<Arc<dyn AssetContextResolver>>,
    pub review_service: Option<ReviewService>,
    pub mutation_observer: Option<Arc<dyn WorkspaceMutationObserver>>,
}

/// How often a watched root is swept, and how long a burst is collected before it is reported.
///
/// The sweep stats directories rather than files, so the interval trades latency against a cost
/// proportional to the workspace's directory count.
const WATCH_POLL_INTERVAL: Duration = Duration::from_secs(2);
const WATCH_COALESCE_WINDOW: Duration = Duration::from_millis(750);
const WATCH_CHANNEL_CAPACITY: usize = 8;
const WATCH_BROADCAST_CAPACITY: usize = 8;

/// Cached workspace snapshots plus the invalidation counter that fences them.
///
/// A scan runs outside this lock, so an invalidation can arrive while one is in flight. The counter
/// records that, letting a finished scan tell whether the state it observed is still the current one
/// before it publishes.
#[derive(Default)]
struct IndexCache {
    snapshots: HashMap<PathBuf, WorkspaceSearchIndex>,
    generations: HashMap<PathBuf, u64>,
}

impl IndexCache {
    fn invalidate(&mut self, canonical: &Path) {
        self.snapshots.remove(canonical);
        let generation = self.generations.entry(canonical.to_path_buf()).or_default();
        *generation = generation.wrapping_add(1);
    }

    fn generation(&self, canonical: &Path) -> u64 {
        self.generations.get(canonical).copied().unwrap_or_default()
    }
}

/// A live entry-change subscription, together with the workspace admission it runs under.
///
/// The lease is held for the subscription's lifetime so a sweep cannot outlive the availability
/// guard, and `loss_cancellation` is how the caller learns the workspace was fenced -- dropping this
/// releases the lease so a pending removal can proceed.
pub struct EntryChangeSubscription {
    changes: broadcast::Receiver<()>,
    admission: Option<WorkspaceAdmissionLease>,
}

impl EntryChangeSubscription {
    pub async fn recv(&mut self) -> Result<(), broadcast::error::RecvError> {
        self.changes.recv().await
    }

    #[must_use]
    pub fn loss_cancellation(&self) -> Option<WorkspaceAdmissionCancellation> {
        self.admission
            .as_ref()
            .map(WorkspaceAdmissionLease::loss_cancellation)
    }
}

#[derive(Clone)]
pub struct WorkspaceRpc {
    service: WorkspaceService,
    indexes: Arc<Mutex<IndexCache>>,
    /// One lock per root, held across a scan so concurrent callers wait rather than each scanning.
    index_builds: Arc<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>>,
    index_scans: Arc<AtomicU64>,
    dependencies: WorkspaceRpcDependencies,
    availability_registry: Option<WorkspaceAvailabilityRegistry>,
    watches: Arc<Mutex<HashMap<PathBuf, broadcast::Sender<()>>>>,
    watch_timing: (Duration, Duration),
}

/// Supplies the swept directories from the cached index for a root.
///
/// The last non-empty set is retained because invalidating the index empties the cache until a
/// client lists again. Falling back to an empty set in that window would narrow the sweep to the
/// root alone and miss a second change arriving in a nested directory.
struct IndexWatchScope {
    indexes: Arc<Mutex<IndexCache>>,
    last: Arc<Mutex<Vec<String>>>,
}

impl WatchScope for IndexWatchScope {
    fn directories(&self, root: PathBuf) -> WatchScopeFuture {
        let indexes = Arc::clone(&self.indexes);
        let last = Arc::clone(&self.last);
        Box::pin(async move {
            let index = indexes.lock().await.snapshots.get(&root).cloned();
            let directories = match index {
                Some(index) => index.directory_paths().await,
                None => Vec::new(),
            };
            let mut last = last.lock().await;
            if directories.is_empty() {
                return last.clone();
            }
            *last = directories.clone();
            directories
        })
    }
}

impl WorkspaceRpc {
    pub fn new(service: WorkspaceService) -> Self {
        Self::with_dependencies(service, WorkspaceRpcDependencies::default())
    }

    pub fn with_dependencies(
        service: WorkspaceService,
        dependencies: WorkspaceRpcDependencies,
    ) -> Self {
        Self {
            service,
            indexes: Arc::new(Mutex::new(IndexCache::default())),
            index_builds: Arc::new(Mutex::new(HashMap::new())),
            index_scans: Arc::new(AtomicU64::new(0)),
            dependencies,
            availability_registry: None,
            watches: Arc::new(Mutex::new(HashMap::new())),
            watch_timing: (WATCH_POLL_INTERVAL, WATCH_COALESCE_WINDOW),
        }
    }

    /// Overrides the change-sweep cadence.
    ///
    /// Exists so tests can drive the sweep faster than the production interval instead of sleeping
    /// on it; production callers keep the defaults.
    #[must_use]
    pub fn with_watch_timing(mut self, poll_interval: Duration, coalesce_window: Duration) -> Self {
        self.watch_timing = (poll_interval, coalesce_window);
        self
    }

    #[must_use]
    pub fn with_availability_registry(
        mut self,
        availability_registry: WorkspaceAvailabilityRegistry,
    ) -> Self {
        self.availability_registry = Some(availability_registry);
        self
    }

    pub async fn handle(&self, method: &str, payload: Value) -> Result<Value, Value> {
        match method {
            "projects.readFile" => {
                let input: PathInput = decode(payload)?;
                let _admission = self.acquire_path(&input.cwd).await?;
                self.service
                    .read_file(Path::new(&input.cwd), &input.relative_path)
                    .await
                    .and_then(encode)
                    .map_err(|error| {
                        error.to_project_wire(
                            "ProjectReadFileError",
                            &input.cwd,
                            &input.relative_path,
                        )
                    })
            }
            "projects.writeFile" => {
                let input: WriteInput = decode(payload)?;
                let admission = self.acquire_path(&input.cwd).await?;
                let _finalization = Self::begin_mutation(admission.as_ref())?;
                let result = self
                    .service
                    .write_file(Path::new(&input.cwd), &input.relative_path, &input.contents)
                    .await;
                match result {
                    Ok(relative_path) => {
                        self.invalidate_index(&input.cwd).await;
                        if let Some(observer) = &self.dependencies.mutation_observer {
                            observer.workspace_mutated(Path::new(&input.cwd)).await;
                        }
                        Ok(json!({ "relativePath": relative_path }))
                    }
                    Err(error) => Err(error.to_project_wire(
                        "ProjectWriteFileError",
                        &input.cwd,
                        &input.relative_path,
                    )),
                }
            }
            "projects.createEntry" => {
                let input: CreateInput = decode(payload)?;
                let admission = self.acquire_path(&input.cwd).await?;
                let _finalization = Self::begin_mutation(admission.as_ref())?;
                let result = self
                    .service
                    .create_entry(Path::new(&input.cwd), &input.relative_path, input.kind)
                    .await;
                match result {
                    Ok(relative_path) => {
                        self.invalidate_index(&input.cwd).await;
                        Ok(json!({ "relativePath": relative_path }))
                    }
                    Err(error) => Err(error.to_project_wire(
                        "ProjectCreateEntryError",
                        &input.cwd,
                        &input.relative_path,
                    )),
                }
            }
            "projects.renameEntry" => {
                let input: RenameInput = decode(payload)?;
                let admission = self.acquire_path(&input.cwd).await?;
                let _finalization = Self::begin_mutation(admission.as_ref())?;
                let result = self
                    .service
                    .rename_entry(
                        Path::new(&input.cwd),
                        &input.from_relative_path,
                        &input.to_relative_path,
                    )
                    .await;
                match result {
                    Ok(relative_path) => {
                        self.invalidate_index(&input.cwd).await;
                        Ok(json!({ "relativePath": relative_path }))
                    }
                    Err(error) => Err(error.to_project_wire(
                        "ProjectRenameEntryError",
                        &input.cwd,
                        &input.from_relative_path,
                    )),
                }
            }
            "projects.deleteEntry" => {
                let input: PathInput = decode(payload)?;
                let admission = self.acquire_path(&input.cwd).await?;
                let _finalization = Self::begin_mutation(admission.as_ref())?;
                let result = self
                    .service
                    .delete_entry(Path::new(&input.cwd), &input.relative_path)
                    .await;
                match result {
                    Ok(relative_path) => {
                        self.invalidate_index(&input.cwd).await;
                        Ok(json!({ "relativePath": relative_path }))
                    }
                    Err(error) => Err(error.to_project_wire(
                        "ProjectDeleteEntryError",
                        &input.cwd,
                        &input.relative_path,
                    )),
                }
            }
            "projects.duplicateEntry" => {
                let input: PathInput = decode(payload)?;
                let admission = self.acquire_path(&input.cwd).await?;
                let _finalization = Self::begin_mutation(admission.as_ref())?;
                let result = self
                    .service
                    .duplicate_entry(Path::new(&input.cwd), &input.relative_path)
                    .await;
                match result {
                    Ok(relative_path) => {
                        self.invalidate_index(&input.cwd).await;
                        Ok(json!({ "relativePath": relative_path }))
                    }
                    Err(error) => Err(error.to_project_wire(
                        "ProjectDuplicateEntryError",
                        &input.cwd,
                        &input.relative_path,
                    )),
                }
            }
            "projects.listEntries" => {
                let input: ListInput = decode(payload)?;
                let _admission = self.acquire_path(&input.cwd).await?;
                // Out-of-band filesystem changes are invisible to the cached snapshot, so a
                // request must opt in before paying for a full rebuild.
                if input.refresh == Some(true) {
                    self.refresh_index(Path::new(&input.cwd)).await;
                }
                let index = self.index(&input.cwd).await.map_err(|error| {
                    entries_wire_error("ProjectListEntriesError", &input.cwd, &error)
                })?;
                let limit = input
                    .limit
                    .map(|limit| limit.clamp(1, PROJECT_ENTRIES_MAX_LIMIT));
                encode(index.list(limit).await).map_err(|error| {
                    entries_wire_error("ProjectListEntriesError", &input.cwd, &error)
                })
            }
            "projects.searchEntries" => {
                let input: SearchInput = decode(payload)?;
                let _admission = self.acquire_path(&input.cwd).await?;
                let index = self.index(&input.cwd).await.map_err(|error| {
                    entries_wire_error("ProjectSearchEntriesError", &input.cwd, &error)
                })?;
                encode(
                    index
                        .search(&input.query, input.limit.min(PROJECT_ENTRIES_MAX_LIMIT))
                        .await,
                )
                .map_err(|error| {
                    entries_wire_error("ProjectSearchEntriesError", &input.cwd, &error)
                })
            }
            "filesystem.browse" => {
                let input: BrowseInput = decode(payload)?;
                let _admission = match &input.cwd {
                    Some(cwd) => self.acquire_path(cwd).await?,
                    None => None,
                };
                self.service
                    .browse(
                        &input.partial_path,
                        input.cwd.as_deref().map(Path::new),
                        input.mode.as_deref() == Some("directory"),
                    )
                    .await
                    .and_then(encode)
                    .map_err(|error| filesystem_wire_error(&input, &error))
            }
            "assets.createUrl" => {
                let input: AssetCreateUrlInput = decode(payload)?;
                self.handle_asset_create_url(input).await
            }
            "review.getDiffPreview" => {
                let input: ReviewDiffPreviewInput = decode(payload)?;
                let _admission = self.acquire_path(&input.cwd).await?;
                self.handle_review_get_diff_preview(input).await
            }
            _ => Err(json!({
                "_tag": "Defect",
                "message": WorkspaceError::UnsupportedMethod(method.to_owned()).to_string(),
            })),
        }
    }

    /// How many full workspace scans have run.
    ///
    /// Concurrent listers of the same cold root must share one scan, and this is the value that
    /// proves it rather than inferring it from timing.
    pub fn index_scans(&self) -> u64 {
        self.index_scans.load(Ordering::Relaxed)
    }

    /// Number of workspace roots currently being swept for out-of-band changes.
    ///
    /// A sweep is only meant to exist while something is subscribed to it, so this is the value that
    /// proves sweeps are retired rather than accumulating for the process lifetime.
    pub async fn active_entry_watches(&self) -> usize {
        self.watches.lock().await.len()
    }

    /// Subscribes to out-of-band changes under `cwd`.
    ///
    /// The signal carries no paths: the index remains the single source of truth for entry data, so
    /// a subscriber re-reads it rather than applying a diff that could drift out of agreement with
    /// it. The first subscriber for a root starts the sweep; it stops once the last one goes away.
    pub async fn subscribe_entry_changes(
        &self,
        cwd: &Path,
    ) -> Result<EntryChangeSubscription, Value> {
        // Admission first, like every other request against a workspace path: a root that is being
        // removed, or already lost, must not acquire a sweep at all.
        let admission = self.acquire_path(&cwd.to_string_lossy()).await?;
        let changes = self
            .subscribe_entry_change_signal(cwd)
            .await
            .map_err(|error| {
                entries_wire_error("ProjectListEntriesError", &cwd.to_string_lossy(), &error)
            })?;
        Ok(EntryChangeSubscription { changes, admission })
    }

    async fn subscribe_entry_change_signal(
        &self,
        cwd: &Path,
    ) -> Result<broadcast::Receiver<()>, WorkspaceError> {
        let canonical = normalize_root(cwd, false).await?;
        // An existing sweep is already tracking this root, so its baseline and the snapshot are
        // already consistent; join it without paying for another scan.
        if let Some(sender) = self.watches.lock().await.get(&canonical) {
            return Ok(sender.subscribe());
        }
        // Starting a sweep is a resync point. The sweep derives its directories from the snapshot,
        // so the snapshot has to exist -- and it has to be no older than the baseline about to be
        // stamped. A cached snapshot may predate changes made while nothing was watching, and those
        // are already on disk when the baseline is taken, so they could never surface as a
        // difference. Rebuild rather than inherit that blind spot.
        self.refresh_index(cwd).await;
        self.index(&cwd.to_string_lossy()).await?;
        let mut watches = self.watches.lock().await;
        // Re-check: another subscriber may have installed a sweep while this one was scanning.
        if let Some(sender) = watches.get(&canonical) {
            return Ok(sender.subscribe());
        }
        let (sender, receiver) = broadcast::channel(WATCH_BROADCAST_CAPACITY);
        watches.insert(canonical.clone(), sender.clone());
        drop(watches);

        let (poll_interval, coalesce_window) = self.watch_timing;
        let watcher = WorkspaceWatcher::new(poll_interval, coalesce_window, WATCH_CHANNEL_CAPACITY);
        let scope = Arc::new(IndexWatchScope {
            indexes: Arc::clone(&self.indexes),
            last: Arc::new(Mutex::new(Vec::new())),
        });
        let subscription = watcher.watch(canonical.clone(), scope).await;
        let indexes = Arc::clone(&self.indexes);
        let watches = Arc::clone(&self.watches);
        tokio::spawn(async move {
            Self::run_watch(
                canonical,
                subscription,
                sender,
                indexes,
                watches,
                poll_interval,
            )
            .await;
        });
        Ok(receiver)
    }

    async fn run_watch(
        canonical: PathBuf,
        mut subscription: WatchSubscription,
        sender: broadcast::Sender<()>,
        indexes: Arc<Mutex<IndexCache>>,
        watches: Arc<Mutex<HashMap<PathBuf, broadcast::Sender<()>>>>,
        poll_interval: Duration,
    ) {
        let mut idle_check = tokio::time::interval(poll_interval);
        idle_check.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tokio::select! {
                event = subscription.recv() => {
                    if event.is_none() {
                        break;
                    }
                    // Drop the snapshot before announcing, so a subscriber that lists immediately
                    // cannot be served the stale index the signal is telling it to replace.
                    indexes.lock().await.invalidate(&canonical);
                    // A send failure means every receiver has gone; nothing is left to serve.
                    if sender.send(()).is_err() {
                        break;
                    }
                }
                // Losing the last receiver is otherwise invisible until the next filesystem event,
                // which on a quiet workspace never comes — the sweep would outlive the panel that
                // asked for it, and on an in-process server the whole run.
                _ = idle_check.tick() => {
                    if Self::retire_idle_watch(&canonical, &sender, &watches).await {
                        subscription.cancel();
                        return;
                    }
                }
            }
        }
        subscription.cancel();
        Self::retire_watch(&canonical, &sender, &watches).await;
    }

    /// Retires the watch when nothing is listening. Returns whether it was retired.
    ///
    /// The receiver count is re-checked while holding the registry lock, which is the same lock a
    /// new subscriber takes before calling `subscribe`, so a subscriber arriving concurrently either
    /// keeps this watch alive or installs its own.
    async fn retire_idle_watch(
        canonical: &Path,
        sender: &broadcast::Sender<()>,
        watches: &Arc<Mutex<HashMap<PathBuf, broadcast::Sender<()>>>>,
    ) -> bool {
        let mut watches = watches.lock().await;
        if sender.receiver_count() > 0 {
            return false;
        }
        if watches
            .get(canonical)
            .is_some_and(|current| current.same_channel(sender))
        {
            watches.remove(canonical);
        }
        true
    }

    async fn retire_watch(
        canonical: &Path,
        sender: &broadcast::Sender<()>,
        watches: &Arc<Mutex<HashMap<PathBuf, broadcast::Sender<()>>>>,
    ) {
        let mut watches = watches.lock().await;
        // Only retire the entry still registered for this root: a later subscriber may already have
        // replaced it after the last receiver went away.
        if watches
            .get(canonical)
            .is_some_and(|current| current.same_channel(sender))
        {
            watches.remove(canonical);
        }
    }

    pub async fn refresh_index(&self, cwd: &Path) {
        let Ok(canonical) = normalize_root(cwd, false).await else {
            return;
        };
        self.indexes.lock().await.invalidate(&canonical);
    }

    async fn acquire_path(&self, cwd: &str) -> Result<Option<WorkspaceAdmissionLease>, Value> {
        let Some(registry) = &self.availability_registry else {
            return Ok(None);
        };
        registry
            .acquire_path_admission([Path::new(cwd)])
            .await
            .map(Some)
            .map_err(workspace_unavailable_wire)
    }

    async fn acquire_thread(
        &self,
        thread_id: &str,
    ) -> Result<Option<WorkspaceAdmissionLease>, Value> {
        let Some(registry) = &self.availability_registry else {
            return Ok(None);
        };
        registry
            .acquire_admission(thread_id, std::iter::empty())
            .await
            .map(Some)
            .map_err(workspace_unavailable_wire)
    }

    fn begin_mutation(
        admission: Option<&WorkspaceAdmissionLease>,
    ) -> Result<Option<crate::persistence::CommitPermit>, Value> {
        admission
            .map(WorkspaceAdmissionLease::begin_finalization)
            .transpose()
            .map_err(workspace_unavailable_wire)
    }

    async fn index(&self, cwd: &str) -> Result<WorkspaceSearchIndex, WorkspaceError> {
        let canonical = normalize_root(Path::new(cwd), false).await?;
        if let Some(index) = self.indexes.lock().await.snapshots.get(&canonical).cloned() {
            return Ok(index);
        }
        // Single-flight per root. Without it every concurrent lister runs its own full scan of the
        // same tree, which on a large workspace is seconds of duplicated work per caller.
        let build = {
            let mut builds = self.index_builds.lock().await;
            Arc::clone(builds.entry(canonical.clone()).or_default())
        };
        let _building = build.lock().await;
        // The caller that held the lock may have finished while this one waited.
        if let Some(index) = self.indexes.lock().await.snapshots.get(&canonical).cloned() {
            return Ok(index);
        }
        let generation = self.indexes.lock().await.generation(&canonical);
        let index = WorkspaceSearchIndex::new(canonical.clone(), SearchLimits::default());
        self.index_scans.fetch_add(1, Ordering::Relaxed);
        index.refresh(CancellationToken::new()).await?;
        let mut cache = self.indexes.lock().await;
        // Publish only when nothing invalidated while the scan ran. An invalidation that arrived
        // mid-scan describes a state this snapshot never observed, so caching it would serve data
        // already known to be stale; leaving the slot empty makes the next request rebuild.
        if cache.generation(&canonical) == generation {
            cache.snapshots.insert(canonical, index.clone());
        }
        Ok(index)
    }

    async fn invalidate_index(&self, cwd: &str) {
        let Ok(canonical) = tokio::fs::canonicalize(cwd).await else {
            return;
        };
        self.indexes.lock().await.invalidate(&canonical);
    }

    async fn handle_asset_create_url(&self, input: AssetCreateUrlInput) -> Result<Value, Value> {
        let asset_access = self
            .dependencies
            .asset_access
            .as_ref()
            .ok_or_else(|| defect("assets.createUrl is not configured"))?;
        let mut admissions = Vec::new();
        let workspace_root = match &input.resource {
            AssetResource::WorkspaceFile { thread_id, .. } => {
                if let Some(admission) = self.acquire_thread(thread_id).await? {
                    admissions.push(admission);
                }
                let resolver = self
                    .dependencies
                    .asset_context_resolver
                    .as_ref()
                    .ok_or_else(|| {
                        defect("assets.createUrl requires a workspace context resolver")
                    })?;
                match resolver.resolve_workspace_root(thread_id).await {
                    Ok(Some(root)) => {
                        if let Some(admission) = self.acquire_path(&root.to_string_lossy()).await? {
                            admissions.push(admission);
                        }
                        Some(root)
                    }
                    Ok(None) => {
                        return Err(asset_wire(
                            &input.resource,
                            "AssetWorkspaceContextNotFoundError",
                        ));
                    }
                    Err(message) => {
                        let mut value =
                            asset_wire(&input.resource, "AssetWorkspaceContextResolutionError");
                        value
                            .as_object_mut()
                            .expect("asset error")
                            .insert("detail".to_owned(), json!(message));
                        return Err(value);
                    }
                }
            }
            AssetResource::ProjectFavicon { cwd } => {
                if let Some(admission) = self.acquire_path(cwd).await? {
                    admissions.push(admission);
                }
                None
            }
            AssetResource::Attachment { .. } => None,
        };
        let issued = asset_access
            .issue(AssetIssueRequest {
                resource: input.resource.clone(),
                workspace_root,
            })
            .await
            .map_err(|error| asset_wire_from_error(&input.resource, &error))?;
        drop(admissions);
        encode(issued).map_err(|error| defect(&error.to_string()))
    }

    async fn handle_review_get_diff_preview(
        &self,
        input: ReviewDiffPreviewInput,
    ) -> Result<Value, Value> {
        let review_service = self
            .dependencies
            .review_service
            .as_ref()
            .ok_or_else(|| defect("review.getDiffPreview is not configured"))?;
        let result = review_service
            .get_diff_preview(input)
            .await
            .map_err(review_wire_error)?;
        encode(result).map_err(|error| defect(&error.to_string()))
    }
}

fn decode<T: for<'de> Deserialize<'de>>(payload: Value) -> Result<T, Value> {
    serde_json::from_value(payload).map_err(|error| {
        json!({
            "_tag": "InvalidRequest",
            "message": error.to_string(),
        })
    })
}

fn workspace_unavailable_wire(error: impl serde::Serialize) -> Value {
    serde_json::to_value(error).expect("workspace availability error serializes")
}

fn encode<T: serde::Serialize>(value: T) -> Result<Value, WorkspaceError> {
    serde_json::to_value(value).map_err(|error| WorkspaceError::InvalidRequest(error.to_string()))
}

fn entries_wire_error(tag: &str, cwd: &str, error: &WorkspaceError) -> Value {
    json!({
        "_tag": tag,
        "cwd": cwd,
        "failure": match error {
            WorkspaceError::RootNotFound { .. } => "workspace_root_not_found",
            WorkspaceError::RootNotDirectory { .. } => "workspace_root_not_directory",
            WorkspaceError::Cancelled => "search_index_scan_timed_out",
            _ => "search_index_search_failed",
        },
        "message": error.to_string(),
    })
}

fn filesystem_wire_error(input: &BrowseInput, error: &WorkspaceError) -> Value {
    json!({
        "_tag": "FilesystemBrowseError",
        "partialPath": input.partial_path,
        "cwd": input.cwd,
        "failure": match error {
            WorkspaceError::WindowsPathUnsupported { .. } => "windows_path_unsupported",
            WorkspaceError::CurrentProjectRequired { .. } => "current_project_required",
            _ => "read_directory_failed",
        },
        "message": error.to_string(),
    })
}

fn asset_wire(resource: &AssetResource, tag: &str) -> Value {
    json!({
        "_tag": tag,
        "resource": resource,
        "message": asset_message(tag),
    })
}

fn asset_message(tag: &str) -> &'static str {
    match tag {
        "AssetWorkspaceContextNotFoundError" => "Workspace context was not found.",
        "AssetWorkspaceContextResolutionError" => "Failed to resolve workspace context.",
        "AssetWorkspaceRootNormalizationError" => "Failed to normalize the workspace root.",
        "AssetWorkspacePathValidationError" => {
            "Workspace file path must be relative to the project root."
        }
        "AssetPreviewTypeValidationError" => "Only browser documents and images can be previewed.",
        "AssetWorkspaceAssetInspectionError" => "Failed to inspect the workspace asset.",
        "AssetWorkspaceAssetNotFoundError" => "Workspace asset was not found.",
        "AssetWorkspaceResolutionError" => "Failed to resolve workspace.",
        "AssetAttachmentNotFoundError" => "Attachment was not found.",
        "AssetProjectFaviconResolutionError" => "Failed to resolve project favicon.",
        "AssetProjectFaviconInspectionError" => "Failed to inspect the project favicon.",
        "AssetProjectFaviconNotFoundError" => "Project favicon was not found.",
        "AssetSigningKeyLoadError" => "Failed to load the asset signing key.",
        _ => "Asset access failed.",
    }
}

fn asset_wire_from_error(resource: &AssetResource, error: &AssetError) -> Value {
    match error {
        AssetError::WorkspaceContextRequired => {
            asset_wire(resource, "AssetWorkspaceContextNotFoundError")
        }
        AssetError::UnsupportedPreviewType(_) => {
            asset_wire(resource, "AssetPreviewTypeValidationError")
        }
        AssetError::NotFound(_) => match resource {
            AssetResource::WorkspaceFile { .. } => {
                asset_wire(resource, "AssetWorkspaceAssetNotFoundError")
            }
            AssetResource::Attachment { .. } => {
                asset_wire(resource, "AssetAttachmentNotFoundError")
            }
            AssetResource::ProjectFavicon { .. } => {
                asset_wire(resource, "AssetProjectFaviconNotFoundError")
            }
        },
        AssetError::Workspace(workspace_error) => match resource {
            AssetResource::ProjectFavicon { .. } => match workspace_error {
                WorkspaceError::RootNotFound { .. } | WorkspaceError::RootNotDirectory { .. } => {
                    asset_wire(resource, "AssetWorkspaceRootNormalizationError")
                }
                _ => asset_wire(resource, "AssetProjectFaviconInspectionError"),
            },
            _ => match workspace_error {
                WorkspaceError::RootNotFound { .. } | WorkspaceError::RootNotDirectory { .. } => {
                    asset_wire(resource, "AssetWorkspaceRootNormalizationError")
                }
                WorkspaceError::PathOutsideRoot { .. }
                | WorkspaceError::ResolvedPathOutsideRoot { .. } => {
                    asset_wire(resource, "AssetWorkspacePathValidationError")
                }
                _ => asset_wire(resource, "AssetWorkspaceAssetInspectionError"),
            },
        },
        AssetError::Encoding(_) => asset_wire(resource, "AssetSigningKeyLoadError"),
    }
}

fn review_wire_error(error: ReviewError) -> Value {
    json!({
        "_tag": "Defect",
        "message": error.to_string(),
    })
}

fn defect(message: &str) -> Value {
    json!({
        "_tag": "Defect",
        "message": message,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListInput {
    cwd: String,
    limit: Option<usize>,
    refresh: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PathInput {
    cwd: String,
    relative_path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WriteInput {
    cwd: String,
    relative_path: String,
    contents: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateInput {
    cwd: String,
    relative_path: String,
    kind: EntryKind,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenameInput {
    cwd: String,
    from_relative_path: String,
    to_relative_path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchInput {
    cwd: String,
    query: String,
    limit: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowseInput {
    partial_path: String,
    cwd: Option<String>,
    mode: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AssetCreateUrlInput {
    resource: AssetResource,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worktree_catalog::{AdoptedWorktreeAvailability, WorkspaceLossTransition};
    use std::time::Duration;

    struct PausingMutationObserver {
        entered: Arc<tokio::sync::Semaphore>,
        release: Arc<tokio::sync::Semaphore>,
    }

    impl WorkspaceMutationObserver for PausingMutationObserver {
        fn workspace_mutated<'a>(&'a self, _cwd: &'a Path) -> WorkspaceMutationFuture<'a> {
            let entered = self.entered.clone();
            let release = self.release.clone();
            Box::pin(async move {
                entered.add_permits(1);
                release
                    .acquire()
                    .await
                    .expect("mutation observer release")
                    .forget();
            })
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn paused_workspace_write_retains_admission_until_the_rpc_finishes() {
        let root = tempfile::tempdir().expect("workspace root");
        let physical_root = std::fs::canonicalize(root.path()).expect("canonical workspace root");
        let registry = WorkspaceAvailabilityRegistry::new();
        let observer = Arc::new(PausingMutationObserver {
            entered: Arc::new(tokio::sync::Semaphore::new(0)),
            release: Arc::new(tokio::sync::Semaphore::new(0)),
        });
        let rpc = WorkspaceRpc::with_dependencies(
            WorkspaceService::default(),
            WorkspaceRpcDependencies {
                mutation_observer: Some(observer.clone()),
                ..WorkspaceRpcDependencies::default()
            },
        )
        .with_availability_registry(registry.clone());
        let writing = tokio::spawn(async move {
            rpc.handle(
                "projects.writeFile",
                json!({
                    "cwd":physical_root,
                    "relativePath":"paused.txt",
                    "contents":"complete before removal"
                }),
            )
            .await
        });
        observer
            .entered
            .acquire()
            .await
            .expect("write reaches mutation observer")
            .forget();

        let removal_registry = registry.clone();
        let removal_path = root.path().to_path_buf();
        let mut removal = tokio::spawn(async move {
            removal_registry
                .mark_removing("workspace-thread", &removal_path)
                .await
        });
        assert!(
            tokio::time::timeout(Duration::from_millis(100), &mut removal)
                .await
                .is_err(),
            "Removing cannot finalize while the admitted write RPC is paused"
        );
        assert!(!writing.is_finished());
        observer.release.add_permits(1);
        writing
            .await
            .expect("write task joins")
            .expect("write RPC succeeds");
        drop(removal.await.expect("removal task joins"));
        assert_eq!(
            std::fs::read_to_string(root.path().join("paused.txt")).expect("written file"),
            "complete before removal"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn workspace_rpc_admissions_span_operations_and_mutation_finalization() {
        let root = tempfile::tempdir().expect("workspace root");
        let registry = WorkspaceAvailabilityRegistry::new();
        let rpc = WorkspaceRpc::new(WorkspaceService::default())
            .with_availability_registry(registry.clone());
        let physical_root = std::fs::canonicalize(root.path()).expect("canonical workspace root");
        let admission = rpc
            .acquire_path(&root.path().to_string_lossy())
            .await
            .expect("path admitted")
            .expect("configured registry returns a lease");
        let transition = WorkspaceLossTransition {
            thread_id: "workspace-thread".to_owned(),
            repository_key: "repository-key".to_owned(),
            generation: 1,
            path: physical_root.clone(),
            availability: AdoptedWorktreeAvailability::MissingRegistered,
        };
        let loss_registry = registry.clone();
        let loss_transition = transition.clone();
        let loss_cancellation = admission.loss_cancellation();
        let loss =
            tokio::spawn(async move { loss_registry.mark_unavailable(loss_transition).await });
        assert!(
            loss.await
                .expect("loss task joins")
                .expect("physical identity resolves")
        );
        assert!(loss_cancellation.is_cancelled());
        drop(admission);
        registry
            .clear_recovered("workspace-thread", &physical_root)
            .await
            .expect("physical identity resolves");

        let admission = rpc
            .acquire_path(&root.path().to_string_lossy())
            .await
            .expect("path admitted before the next loss")
            .expect("configured registry returns a lease");
        let finalization = WorkspaceRpc::begin_mutation(Some(&admission))
            .expect("mutation finalization begins")
            .expect("configured registry returns a finalization permit");
        let loss_registry = registry.clone();
        let removal_path = physical_root.clone();
        let mut loss = tokio::spawn(async move {
            loss_registry
                .mark_removing("workspace-thread", &removal_path)
                .await
        });
        assert!(
            tokio::time::timeout(Duration::from_millis(100), &mut loss)
                .await
                .is_err(),
            "workspace loss waits until the filesystem mutation's final commit window ends"
        );
        drop(finalization);
        drop(admission);
        drop(loss.await.expect("final loss task joins"));
    }

    #[tokio::test]
    async fn rpc_error_mappers_cover_workspace_filesystem_and_asset_variants() {
        let missing_root = std::env::temp_dir().join("bibcode-missing-workspace-rpc-root");
        let missing_cwd = missing_root.to_string_lossy().into_owned();
        let rpc = WorkspaceRpc::new(WorkspaceService::default());
        for (method, payload, tag) in [
            (
                "projects.readFile",
                json!({"cwd":missing_cwd,"relativePath":"missing.txt"}),
                "ProjectReadFileError",
            ),
            (
                "projects.writeFile",
                json!({"cwd":missing_cwd,"relativePath":"missing.txt","contents":"x"}),
                "ProjectWriteFileError",
            ),
            (
                "projects.createEntry",
                json!({"cwd":missing_cwd,"relativePath":"missing.txt","kind":"file"}),
                "ProjectCreateEntryError",
            ),
            (
                "projects.renameEntry",
                json!({"cwd":missing_cwd,"fromRelativePath":"from.txt","toRelativePath":"to.txt"}),
                "ProjectRenameEntryError",
            ),
            (
                "projects.deleteEntry",
                json!({"cwd":missing_cwd,"relativePath":"missing.txt"}),
                "ProjectDeleteEntryError",
            ),
            (
                "projects.duplicateEntry",
                json!({"cwd":missing_cwd,"relativePath":"missing.txt"}),
                "ProjectDuplicateEntryError",
            ),
            (
                "projects.listEntries",
                json!({"cwd":missing_cwd}),
                "ProjectListEntriesError",
            ),
            (
                "projects.searchEntries",
                json!({"cwd":missing_cwd,"query":"x","limit":10}),
                "ProjectSearchEntriesError",
            ),
        ] {
            let error = rpc.handle(method, payload).await.unwrap_err();
            assert_eq!(error["_tag"], tag);
        }
        rpc.refresh_index(&missing_root).await;
        rpc.invalidate_index(&missing_cwd).await;

        let root_error = WorkspaceError::RootNotFound {
            path: missing_root.clone(),
        };
        assert_eq!(
            entries_wire_error("Entries", &missing_cwd, &root_error)["failure"],
            "workspace_root_not_found"
        );
        assert_eq!(
            entries_wire_error(
                "Entries",
                &missing_cwd,
                &WorkspaceError::RootNotDirectory {
                    path: missing_root.clone(),
                },
            )["failure"],
            "workspace_root_not_directory"
        );
        assert_eq!(
            entries_wire_error("Entries", &missing_cwd, &WorkspaceError::Cancelled)["failure"],
            "search_index_scan_timed_out"
        );
        assert_eq!(
            entries_wire_error(
                "Entries",
                &missing_cwd,
                &WorkspaceError::InvalidRequest("bad".to_owned()),
            )["failure"],
            "search_index_search_failed"
        );

        let browse = BrowseInput {
            partial_path: "relative".to_owned(),
            cwd: None,
            mode: None,
        };
        assert_eq!(
            filesystem_wire_error(
                &browse,
                &WorkspaceError::WindowsPathUnsupported {
                    partial_path: "C:\\temp".to_owned(),
                },
            )["failure"],
            "windows_path_unsupported"
        );
        assert_eq!(
            filesystem_wire_error(
                &browse,
                &WorkspaceError::CurrentProjectRequired {
                    partial_path: "relative".to_owned(),
                },
            )["failure"],
            "current_project_required"
        );
        assert_eq!(
            filesystem_wire_error(&browse, &WorkspaceError::Cancelled)["failure"],
            "read_directory_failed"
        );

        for tag in [
            "AssetWorkspaceContextNotFoundError",
            "AssetWorkspaceContextResolutionError",
            "AssetWorkspaceRootNormalizationError",
            "AssetWorkspacePathValidationError",
            "AssetPreviewTypeValidationError",
            "AssetWorkspaceAssetInspectionError",
            "AssetWorkspaceAssetNotFoundError",
            "AssetWorkspaceResolutionError",
            "AssetAttachmentNotFoundError",
            "AssetProjectFaviconResolutionError",
            "AssetProjectFaviconInspectionError",
            "AssetProjectFaviconNotFoundError",
            "AssetSigningKeyLoadError",
            "UnknownAssetError",
        ] {
            assert!(!asset_message(tag).is_empty());
        }

        let workspace = AssetResource::WorkspaceFile {
            thread_id: "thread-1".to_owned(),
            path: "preview.html".to_owned(),
        };
        let attachment = AssetResource::Attachment {
            attachment_id: "attachment-1".to_owned(),
        };
        let favicon = AssetResource::ProjectFavicon {
            cwd: missing_cwd.clone(),
        };
        let operation_error = || {
            WorkspaceError::operation(
                "stat",
                missing_root.clone(),
                std::io::Error::other("failed"),
            )
        };
        for (resource, error, tag) in [
            (
                &workspace,
                AssetError::WorkspaceContextRequired,
                "AssetWorkspaceContextNotFoundError",
            ),
            (
                &workspace,
                AssetError::UnsupportedPreviewType("txt".to_owned()),
                "AssetPreviewTypeValidationError",
            ),
            (
                &workspace,
                AssetError::NotFound("missing".to_owned()),
                "AssetWorkspaceAssetNotFoundError",
            ),
            (
                &attachment,
                AssetError::NotFound("missing".to_owned()),
                "AssetAttachmentNotFoundError",
            ),
            (
                &favicon,
                AssetError::NotFound("missing".to_owned()),
                "AssetProjectFaviconNotFoundError",
            ),
            (
                &workspace,
                AssetError::Workspace(WorkspaceError::RootNotFound {
                    path: missing_root.clone(),
                }),
                "AssetWorkspaceRootNormalizationError",
            ),
            (
                &workspace,
                AssetError::Workspace(WorkspaceError::PathOutsideRoot {
                    relative_path: "../outside".to_owned(),
                }),
                "AssetWorkspacePathValidationError",
            ),
            (
                &workspace,
                AssetError::Workspace(operation_error()),
                "AssetWorkspaceAssetInspectionError",
            ),
            (
                &favicon,
                AssetError::Workspace(WorkspaceError::RootNotDirectory {
                    path: missing_root.clone(),
                }),
                "AssetWorkspaceRootNormalizationError",
            ),
            (
                &favicon,
                AssetError::Workspace(operation_error()),
                "AssetProjectFaviconInspectionError",
            ),
        ] {
            assert_eq!(asset_wire_from_error(resource, &error)["_tag"], tag);
        }
        let encoding = serde_json::from_str::<Value>("").unwrap_err();
        assert_eq!(
            asset_wire_from_error(&workspace, &AssetError::Encoding(encoding))["_tag"],
            "AssetSigningKeyLoadError"
        );
        assert_eq!(
            review_wire_error(ReviewError::Backend("failed".to_owned()))["_tag"],
            "Defect"
        );
        assert_eq!(defect("failed")["message"], "failed");
    }
}
