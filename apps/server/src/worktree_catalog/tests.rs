use std::{
    collections::{HashMap, HashSet, VecDeque},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

use crate::git::{GitWorktreeInventory, GitWorktreeRecord};

use super::service::{
    CatalogFileSystem, CatalogFuture, CatalogProject, CatalogProjectionSource,
    CatalogServiceOptions, CatalogShallowSignature, CatalogThread, DirectoryProbeState,
    InventorySource, ScanFailure,
};
use super::{CatalogRefreshTrigger, WorktreeCatalogService};

#[tokio::test]
async fn anchor_preference_is_primary_then_present_adopted_then_lifetime_common_directory() {
    let projections = Arc::new(FakeProjectionSource::new([project(
        "project-1",
        "/repo/main",
        [thread("thread-1", "/repo/adopted")],
    )]));
    let inventory = Arc::new(FakeInventorySource::new([
        inventory(
            "/repo/common",
            [record("/repo/main", true), record("/repo/adopted", false)],
        ),
        inventory(
            "/repo/common",
            [record("/repo/main", true), record("/repo/adopted", false)],
        ),
        inventory(
            "/repo/common",
            [record("/repo/main", true), record("/repo/adopted", false)],
        ),
    ]));
    let filesystem = Arc::new(FakeFileSystem::new([
        ("/repo/main", DirectoryProbeState::Present),
        ("/repo/adopted", DirectoryProbeState::Present),
        ("/repo/common", DirectoryProbeState::Present),
    ]));
    let service = WorktreeCatalogService::with_dependencies(
        projections,
        inventory.clone(),
        filesystem.clone(),
        CatalogServiceOptions::default(),
    );

    let subscription = service
        .subscribe("project-1")
        .await
        .expect("initial catalog subscription");
    filesystem.set("/repo/main", DirectoryProbeState::Missing);
    service
        .refresh("project-1", CatalogRefreshTrigger::Explicit)
        .await
        .expect("adopted-anchor refresh");
    filesystem.set("/repo/adopted", DirectoryProbeState::Missing);
    service
        .refresh("project-1", CatalogRefreshTrigger::Explicit)
        .await
        .expect("lifetime-anchor refresh");

    assert_eq!(
        inventory.calls(),
        [
            PathBuf::from("/repo/main"),
            PathBuf::from("/repo/adopted"),
            PathBuf::from("/repo/common"),
        ]
    );
    drop(subscription);
}

#[tokio::test]
async fn concurrent_first_subscribers_share_one_bootstrap_scan() {
    let inventory = Arc::new(BlockingInventorySource::new(inventory(
        "/repo/common",
        [record("/repo/main", true)],
    )));
    let service = WorktreeCatalogService::with_dependencies(
        Arc::new(FakeProjectionSource::new([project(
            "project-1",
            "/repo/main",
            [],
        )])),
        inventory.clone(),
        Arc::new(FakeFileSystem::new([(
            "/repo/main",
            DirectoryProbeState::Present,
        )])),
        CatalogServiceOptions::default(),
    );

    let first_service = service.clone();
    let first = tokio::spawn(async move { first_service.subscribe("project-1").await });
    wait_for_count(&inventory.calls, 1).await;
    let second_service = service.clone();
    let second = tokio::spawn(async move { second_service.subscribe("project-1").await });
    tokio::task::yield_now().await;
    inventory.release.add_permits(1);

    let first = first
        .await
        .expect("first subscriber task")
        .expect("first subscriber");
    let second = second
        .await
        .expect("second subscriber task")
        .expect("second subscriber");
    assert_eq!(inventory.calls.load(Ordering::SeqCst), 1);
    assert_eq!(first.latest().generation, second.latest().generation);
}

#[tokio::test]
async fn four_repository_scans_run_concurrently_while_a_fifth_waits() {
    let projects =
        (0..5).map(|index| project(&format!("project-{index}"), &format!("/repo-{index}"), []));
    let states = (0..5)
        .map(|index| (format!("/repo-{index}"), DirectoryProbeState::Present))
        .collect::<Vec<_>>();
    let filesystem = Arc::new(FakeFileSystem::from_owned(states));
    let inventory = Arc::new(ConcurrentInventorySource::default());
    let service = WorktreeCatalogService::with_dependencies(
        Arc::new(FakeProjectionSource::new(projects)),
        inventory.clone(),
        filesystem,
        CatalogServiceOptions::default(),
    );
    let tasks = (0..5)
        .map(|index| {
            let service = service.clone();
            tokio::spawn(async move { service.subscribe(&format!("project-{index}")).await })
        })
        .collect::<Vec<_>>();

    wait_for_count(&inventory.active, 4).await;
    tokio::task::yield_now().await;
    assert_eq!(inventory.active.load(Ordering::SeqCst), 4);
    assert_eq!(inventory.max_active.load(Ordering::SeqCst), 4);
    assert_eq!(inventory.calls.load(Ordering::SeqCst), 4);
    inventory.release.add_permits(5);
    for task in tasks {
        task.await
            .expect("catalog task")
            .expect("catalog subscription");
    }
    assert_eq!(inventory.calls.load(Ordering::SeqCst), 5);
    assert_eq!(inventory.max_active.load(Ordering::SeqCst), 4);
}

#[tokio::test(start_paused = true)]
async fn directory_probes_are_capped_at_eight_and_time_out_to_unknown() {
    let filesystem = Arc::new(BlockingProbeFileSystem::default());
    let records = std::iter::once(record("/repo/main", true))
        .chain((0..20).map(|index| record(&format!("/repo/worktree-{index}"), false)));
    let service = WorktreeCatalogService::with_dependencies(
        Arc::new(FakeProjectionSource::new([project(
            "project-1",
            "/repo/main",
            [],
        )])),
        Arc::new(FakeInventorySource::new([inventory(
            "/repo/common",
            records,
        )])),
        filesystem.clone(),
        Arc::new(CatalogServiceOptions::default()).as_ref().clone(),
    );
    let service_task = service.clone();
    let subscription = tokio::spawn(async move { service_task.subscribe("project-1").await });

    wait_for_count(&filesystem.active, 8).await;
    assert_eq!(filesystem.max_active.load(Ordering::SeqCst), 8);
    for _ in 0..4 {
        tokio::time::advance(Duration::from_secs(1)).await;
        tokio::task::yield_now().await;
    }
    let subscription = subscription
        .await
        .expect("subscription task")
        .expect("catalog subscription");
    assert!(
        subscription
            .latest()
            .worktrees
            .iter()
            .skip(1)
            .all(|worktree| worktree.directory_state == super::WorktreeDirectoryState::Unknown)
    );
}

#[tokio::test]
async fn watch_subscription_delivers_only_the_latest_snapshot_after_lag() {
    let inventory =
        Arc::new(FakeInventorySource::new((0..21).map(|_| {
            inventory("/repo/common", [record("/repo/main", true)])
        })));
    let service = WorktreeCatalogService::with_dependencies(
        Arc::new(FakeProjectionSource::new([project(
            "project-1",
            "/repo/main",
            [],
        )])),
        inventory.clone(),
        Arc::new(FakeFileSystem::new([
            ("/repo/main", DirectoryProbeState::Present),
            ("/repo/common", DirectoryProbeState::Present),
        ])),
        CatalogServiceOptions::default(),
    );
    let mut subscription = service.subscribe("project-1").await.expect("subscription");
    for _ in 0..20 {
        service
            .refresh("project-1", CatalogRefreshTrigger::Explicit)
            .await
            .expect("refresh");
    }

    let latest = subscription.changed().await.expect("latest catalog value");
    assert_eq!(latest.generation, 21);
    assert_eq!(subscription.latest().generation, 21);
}

#[tokio::test]
async fn failed_scan_retains_the_last_authoritative_arrays_and_only_degrades_health() {
    let first = inventory(
        "/repo/common",
        [record("/repo/main", true), record("/repo/external", false)],
    );
    let inventory = Arc::new(FakeInventorySource::new_results([
        Ok(first),
        Err(ScanFailure {
            reason: super::CatalogDegradedReason::GitFailed,
            message: "git worktree list failed".to_owned(),
        }),
    ]));
    let service = WorktreeCatalogService::with_dependencies(
        Arc::new(FakeProjectionSource::new([project(
            "project-1",
            "/repo/main",
            [thread("thread-1", "/repo/external")],
        )])),
        inventory,
        Arc::new(FakeFileSystem::new([
            ("/repo/main", DirectoryProbeState::Present),
            ("/repo/external", DirectoryProbeState::Present),
            ("/repo/common", DirectoryProbeState::Present),
        ])),
        CatalogServiceOptions::default(),
    );
    let subscription = service.subscribe("project-1").await.expect("subscription");
    let authoritative = subscription.latest();

    let degraded = service
        .refresh("project-1", CatalogRefreshTrigger::Explicit)
        .await
        .expect("failed observation still returns retained catalog");

    assert!(!degraded.authoritative);
    assert_eq!(degraded.generation, authoritative.generation);
    assert_eq!(degraded.worktrees, authoritative.worktrees);
    assert_eq!(
        degraded.adopted_workspaces,
        authoritative.adopted_workspaces
    );
    assert!(matches!(
        degraded.scan_status,
        super::CatalogScanStatus::Degraded {
            reason: super::CatalogDegradedReason::GitFailed,
            ..
        }
    ));
}

#[tokio::test]
async fn mutation_epoch_rejects_a_stale_in_flight_result() {
    let inventory = Arc::new(PausingSecondInventorySource::new(inventory(
        "/repo/common",
        [record("/repo/main", true)],
    )));
    let service = WorktreeCatalogService::with_dependencies(
        Arc::new(FakeProjectionSource::new([project(
            "project-1",
            "/repo/main",
            [],
        )])),
        inventory.clone(),
        Arc::new(FakeFileSystem::new([
            ("/repo/main", DirectoryProbeState::Present),
            ("/repo/common", DirectoryProbeState::Present),
        ])),
        CatalogServiceOptions::default(),
    );
    let subscription = service.subscribe("project-1").await.expect("subscription");
    drop(subscription);
    let refresh_service = service.clone();
    let refresh = tokio::spawn(async move {
        refresh_service
            .refresh("project-1", CatalogRefreshTrigger::Explicit)
            .await
    });
    wait_for_count(&inventory.calls, 2).await;
    service.invalidate_after_mutation("project-1").await;
    inventory.release.add_permits(1);

    let error = refresh
        .await
        .expect("refresh task")
        .expect_err("pre-mutation result must be rejected");
    assert_eq!(error.reason, super::CatalogErrorReason::StaleGeneration);
    let latest = service.latest("project-1").await.expect("latest");
    assert_eq!(latest.generation, 1);
    assert!(latest.authoritative);
    assert!(matches!(
        latest.scan_status,
        super::CatalogScanStatus::Ready
    ));
}

#[tokio::test(start_paused = true)]
async fn focus_refresh_uses_the_one_second_result_ttl() {
    let inventory =
        Arc::new(FakeInventorySource::new((0..2).map(|_| {
            inventory("/repo/common", [record("/repo/main", true)])
        })));
    let service = WorktreeCatalogService::with_dependencies(
        Arc::new(FakeProjectionSource::new([project(
            "project-1",
            "/repo/main",
            [],
        )])),
        inventory.clone(),
        Arc::new(FakeFileSystem::new([
            ("/repo/main", DirectoryProbeState::Present),
            ("/repo/common", DirectoryProbeState::Present),
        ])),
        CatalogServiceOptions::default(),
    );
    let subscription = service.subscribe("project-1").await.expect("subscription");
    service
        .refresh("project-1", CatalogRefreshTrigger::Focus)
        .await
        .expect("coalesced focus refresh");
    assert_eq!(inventory.calls().len(), 1);
    tokio::time::advance(Duration::from_secs(1)).await;
    service
        .refresh("project-1", CatalogRefreshTrigger::Focus)
        .await
        .expect("expired focus refresh");
    assert_eq!(inventory.calls().len(), 2);
    drop(subscription);
}

#[tokio::test(start_paused = true)]
async fn managed_creation_suppression_expires_after_thirty_seconds() {
    let inventory = Arc::new(FakeInventorySource::new((0..3).map(|_| {
        inventory(
            "/repo/common",
            [record("/repo/main", true), record("/repo/managed", false)],
        )
    })));
    let service = WorktreeCatalogService::with_dependencies(
        Arc::new(FakeProjectionSource::new([project(
            "project-1",
            "/repo/main",
            [],
        )])),
        inventory.clone(),
        Arc::new(FakeFileSystem::new([
            ("/repo/main", DirectoryProbeState::Present),
            ("/repo/managed", DirectoryProbeState::Present),
            ("/repo/common", DirectoryProbeState::Present),
        ])),
        CatalogServiceOptions::default(),
    );
    let subscription = service.subscribe("project-1").await.expect("subscription");
    service
        .note_managed_creation("project-1", Path::new("/repo/managed"))
        .await;
    let suppressed = service
        .refresh("project-1", CatalogRefreshTrigger::Explicit)
        .await
        .expect("suppressed refresh");
    assert!(!descriptor(&suppressed, "/repo/managed").eligible_for_adoption);

    tokio::time::advance(Duration::from_secs(30)).await;
    let expired = service
        .refresh("project-1", CatalogRefreshTrigger::Explicit)
        .await
        .expect("post-suppression refresh");
    assert!(descriptor(&expired, "/repo/managed").eligible_for_adoption);
    drop(subscription);
}

#[tokio::test]
async fn joins_active_archived_panel_deleted_missing_and_conflicting_threads_on_the_server() {
    let projections = Arc::new(FakeProjectionSource::new([project(
        "project-1",
        "/repo/main",
        [
            thread("active", "/repo/active"),
            archived_thread("archived", "/repo/archived"),
            panel_thread("panel", "/repo/panel"),
            deleted_thread("deleted", "/repo/deleted"),
            thread("missing-registered", "/repo/missing"),
            thread("missing-unregistered", "/repo/absent"),
        ],
    )]));
    let inventory = Arc::new(FakeInventorySource::new((0..2).map(|_| {
        inventory(
            "/repo/common",
            [
                record("/repo/main", true),
                record("/repo/active", false),
                record("/repo/archived", false),
                record("/repo/panel", false),
                record("/repo/deleted", false),
                record("/repo/missing", false),
            ],
        )
    })));
    let service = WorktreeCatalogService::with_dependencies(
        projections.clone(),
        inventory,
        Arc::new(FakeFileSystem::new([
            ("/repo/main", DirectoryProbeState::Present),
            ("/repo/active", DirectoryProbeState::Present),
            ("/repo/archived", DirectoryProbeState::Present),
            ("/repo/panel", DirectoryProbeState::Present),
            ("/repo/deleted", DirectoryProbeState::Present),
            ("/repo/missing", DirectoryProbeState::Missing),
            ("/repo/absent", DirectoryProbeState::Present),
            ("/repo/common", DirectoryProbeState::Present),
        ])),
        CatalogServiceOptions::default(),
    );
    let subscription = service.subscribe("project-1").await.expect("subscription");
    let snapshot = subscription.latest();
    assert_eq!(
        descriptor(&snapshot, "/repo/active")
            .adopted_thread_id
            .as_deref(),
        Some("active")
    );
    assert_eq!(
        descriptor(&snapshot, "/repo/archived").adoption_state,
        super::WorktreeAdoptionState::Archived
    );
    assert!(descriptor(&snapshot, "/repo/panel").eligible_for_adoption);
    assert!(descriptor(&snapshot, "/repo/deleted").eligible_for_adoption);
    assert_eq!(
        adopted(&snapshot, "missing-registered").availability,
        super::AdoptedWorktreeAvailability::MissingRegistered
    );
    assert_eq!(
        adopted(&snapshot, "missing-unregistered").availability,
        super::AdoptedWorktreeAvailability::MissingUnregistered
    );

    projections.set_project(project(
        "project-1",
        "/repo/main",
        [
            thread("active", "/repo/active"),
            thread("conflict", "/repo/active"),
        ],
    ));
    let error = service
        .refresh("project-1", CatalogRefreshTrigger::Explicit)
        .await
        .expect_err("duplicate canonical ownership must be explicit");
    assert_eq!(error.reason, super::CatalogErrorReason::Internal);
    let retained = service.latest("project-1").await.expect("retained catalog");
    assert!(retained.authoritative);
    assert!(matches!(
        retained.scan_status,
        super::CatalogScanStatus::Ready
    ));
    assert_eq!(retained.worktrees, snapshot.worktrees);
}

#[tokio::test]
async fn filesystem_probe_only_reports_directories_as_present() {
    let root = tempfile::tempdir().expect("probe fixture");
    let directory = root.path().join("directory");
    let file = root.path().join("file");
    std::fs::create_dir(&directory).expect("probe directory");
    std::fs::write(&file, "not a directory").expect("probe file");
    let filesystem = super::service::TokioCatalogFileSystem;

    assert_eq!(
        filesystem.probe(directory).await,
        DirectoryProbeState::Present
    );
    assert_eq!(filesystem.probe(file).await, DirectoryProbeState::Unknown);
    assert_eq!(
        filesystem.probe(root.path().join("missing")).await,
        DirectoryProbeState::Missing
    );
}

#[tokio::test(start_paused = true)]
async fn polling_reads_only_shallow_common_git_metadata_and_known_paths_then_stops_and_evicts() {
    let inventory = Arc::new(FakeInventorySource::new([inventory(
        "/repo/common",
        [record("/repo/main", true), record("/repo/external", false)],
    )]));
    let filesystem = Arc::new(FakeFileSystem::new([
        ("/repo/main", DirectoryProbeState::Present),
        ("/repo/external", DirectoryProbeState::Present),
        ("/repo/common", DirectoryProbeState::Present),
    ]));
    let service = WorktreeCatalogService::with_dependencies(
        Arc::new(FakeProjectionSource::new([project(
            "project-1",
            "/repo/main",
            [],
        )])),
        inventory.clone(),
        filesystem.clone(),
        CatalogServiceOptions::default(),
    );
    let subscription = service.subscribe("project-1").await.expect("subscription");
    tokio::task::yield_now().await;
    assert_eq!(service.active_poller_count_for_test(), 1);
    let calls = filesystem.shallow_calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].0, PathBuf::from("/repo/common"));
    assert_eq!(
        calls[0].1.iter().cloned().collect::<HashSet<_>>(),
        [PathBuf::from("/repo/main"), PathBuf::from("/repo/external")]
            .into_iter()
            .collect()
    );

    tokio::time::advance(Duration::from_secs(2)).await;
    tokio::task::yield_now().await;
    assert_eq!(
        inventory.calls().len(),
        1,
        "unchanged signatures must not run Git"
    );

    drop(subscription);
    let poll_calls = filesystem.shallow_calls().len();
    tokio::time::advance(Duration::from_secs(2)).await;
    tokio::task::yield_now().await;
    assert_eq!(service.active_poller_count_for_test(), 0);
    assert_eq!(filesystem.shallow_calls().len(), poll_calls);
    tokio::time::advance(Duration::from_secs(60)).await;
    tokio::task::yield_now().await;
    assert_eq!(service.entry_count_for_test(), 0);
}

#[derive(Clone)]
struct FakeProjectionSource {
    projects: Arc<Mutex<HashMap<String, CatalogProject>>>,
}

impl FakeProjectionSource {
    fn new(projects: impl IntoIterator<Item = (String, CatalogProject)>) -> Self {
        Self {
            projects: Arc::new(Mutex::new(projects.into_iter().collect())),
        }
    }

    fn set_project(&self, project: (String, CatalogProject)) {
        self.projects
            .lock()
            .expect("fake projects")
            .insert(project.0, project.1);
    }
}

impl CatalogProjectionSource for FakeProjectionSource {
    fn load(
        &self,
        project_id: String,
    ) -> CatalogFuture<Result<Option<CatalogProject>, super::CatalogError>> {
        let project = self
            .projects
            .lock()
            .expect("fake projects")
            .get(&project_id)
            .cloned();
        Box::pin(async move { Ok(project) })
    }
}

struct FakeInventorySource {
    inventories: Mutex<VecDeque<Result<GitWorktreeInventory, ScanFailure>>>,
    calls: Mutex<Vec<PathBuf>>,
}

impl FakeInventorySource {
    fn new(inventories: impl IntoIterator<Item = GitWorktreeInventory>) -> Self {
        Self {
            inventories: Mutex::new(inventories.into_iter().map(Ok).collect()),
            calls: Mutex::new(Vec::new()),
        }
    }

    fn calls(&self) -> Vec<PathBuf> {
        self.calls.lock().expect("inventory calls").clone()
    }

    fn new_results(
        inventories: impl IntoIterator<Item = Result<GitWorktreeInventory, ScanFailure>>,
    ) -> Self {
        Self {
            inventories: Mutex::new(inventories.into_iter().collect()),
            calls: Mutex::new(Vec::new()),
        }
    }
}

impl InventorySource for FakeInventorySource {
    fn inventory(
        &self,
        anchor: PathBuf,
        _cancellation: CancellationToken,
    ) -> CatalogFuture<Result<GitWorktreeInventory, ScanFailure>> {
        self.calls.lock().expect("inventory calls").push(anchor);
        let inventory = self
            .inventories
            .lock()
            .expect("fake inventories")
            .pop_front()
            .expect("configured fake inventory");
        Box::pin(async move { inventory })
    }
}

#[derive(Clone)]
struct FakeFileSystem {
    states: Arc<Mutex<HashMap<PathBuf, DirectoryProbeState>>>,
    shallow_calls: Arc<Mutex<Vec<ShallowCall>>>,
}

type ShallowCall = (PathBuf, Vec<PathBuf>);

impl FakeFileSystem {
    fn new(states: impl IntoIterator<Item = (&'static str, DirectoryProbeState)>) -> Self {
        Self {
            states: Arc::new(Mutex::new(
                states
                    .into_iter()
                    .map(|(path, state)| (PathBuf::from(path), state))
                    .collect(),
            )),
            shallow_calls: Arc::new(Mutex::new(Vec::new())),
        }
    }

    fn from_owned(states: impl IntoIterator<Item = (String, DirectoryProbeState)>) -> Self {
        Self {
            states: Arc::new(Mutex::new(
                states
                    .into_iter()
                    .map(|(path, state)| (PathBuf::from(path), state))
                    .collect(),
            )),
            shallow_calls: Arc::new(Mutex::new(Vec::new())),
        }
    }

    fn set(&self, path: impl AsRef<Path>, state: DirectoryProbeState) {
        self.states
            .lock()
            .expect("probe states")
            .insert(path.as_ref().to_path_buf(), state);
    }

    fn shallow_calls(&self) -> Vec<(PathBuf, Vec<PathBuf>)> {
        self.shallow_calls
            .lock()
            .expect("shallow signature calls")
            .clone()
    }
}

struct BlockingInventorySource {
    response: GitWorktreeInventory,
    calls: Arc<AtomicUsize>,
    release: Arc<Semaphore>,
}

impl BlockingInventorySource {
    fn new(response: GitWorktreeInventory) -> Self {
        Self {
            response,
            calls: Arc::new(AtomicUsize::new(0)),
            release: Arc::new(Semaphore::new(0)),
        }
    }
}

impl InventorySource for BlockingInventorySource {
    fn inventory(
        &self,
        _anchor: PathBuf,
        _cancellation: CancellationToken,
    ) -> CatalogFuture<Result<GitWorktreeInventory, ScanFailure>> {
        let response = self.response.clone();
        let calls = Arc::clone(&self.calls);
        let release = Arc::clone(&self.release);
        Box::pin(async move {
            calls.fetch_add(1, Ordering::SeqCst);
            release.acquire().await.expect("inventory release").forget();
            Ok(response)
        })
    }
}

struct ConcurrentInventorySource {
    calls: Arc<AtomicUsize>,
    active: Arc<AtomicUsize>,
    max_active: Arc<AtomicUsize>,
    release: Arc<Semaphore>,
}

impl Default for ConcurrentInventorySource {
    fn default() -> Self {
        Self {
            calls: Arc::new(AtomicUsize::new(0)),
            active: Arc::new(AtomicUsize::new(0)),
            max_active: Arc::new(AtomicUsize::new(0)),
            release: Arc::new(Semaphore::new(0)),
        }
    }
}

impl InventorySource for ConcurrentInventorySource {
    fn inventory(
        &self,
        anchor: PathBuf,
        _cancellation: CancellationToken,
    ) -> CatalogFuture<Result<GitWorktreeInventory, ScanFailure>> {
        let calls = Arc::clone(&self.calls);
        let active = Arc::clone(&self.active);
        let max_active = Arc::clone(&self.max_active);
        let release = Arc::clone(&self.release);
        Box::pin(async move {
            calls.fetch_add(1, Ordering::SeqCst);
            let now_active = active.fetch_add(1, Ordering::SeqCst) + 1;
            max_active.fetch_max(now_active, Ordering::SeqCst);
            release.acquire().await.expect("inventory release").forget();
            active.fetch_sub(1, Ordering::SeqCst);
            Ok(inventory(
                &format!("{}/.git", anchor.display()),
                [GitWorktreeRecord {
                    path: anchor,
                    head: Some("abc123".to_owned()),
                    branch: Some("main".to_owned()),
                    is_primary: true,
                    is_bare: false,
                    locked: false,
                    lock_reason: None,
                    is_prunable: false,
                    prunable_reason: None,
                }],
            ))
        })
    }
}

#[derive(Default)]
struct BlockingProbeFileSystem {
    active: Arc<AtomicUsize>,
    max_active: Arc<AtomicUsize>,
}

impl CatalogFileSystem for BlockingProbeFileSystem {
    fn probe(&self, path: PathBuf) -> CatalogFuture<DirectoryProbeState> {
        let active = Arc::clone(&self.active);
        let max_active = Arc::clone(&self.max_active);
        Box::pin(async move {
            if path == Path::new("/repo/main") {
                return DirectoryProbeState::Present;
            }
            let now_active = active.fetch_add(1, Ordering::SeqCst) + 1;
            max_active.fetch_max(now_active, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_secs(60)).await;
            active.fetch_sub(1, Ordering::SeqCst);
            DirectoryProbeState::Present
        })
    }

    fn canonicalize(&self, path: PathBuf) -> CatalogFuture<Result<PathBuf, std::io::Error>> {
        Box::pin(async move { Ok(path) })
    }

    fn shallow_signature(
        &self,
        _common_dir: PathBuf,
        _known_paths: Vec<PathBuf>,
    ) -> CatalogFuture<CatalogShallowSignature> {
        Box::pin(async { CatalogShallowSignature::default() })
    }
}

struct PausingSecondInventorySource {
    response: GitWorktreeInventory,
    calls: Arc<AtomicUsize>,
    release: Arc<Semaphore>,
}

impl PausingSecondInventorySource {
    fn new(response: GitWorktreeInventory) -> Self {
        Self {
            response,
            calls: Arc::new(AtomicUsize::new(0)),
            release: Arc::new(Semaphore::new(0)),
        }
    }
}

impl InventorySource for PausingSecondInventorySource {
    fn inventory(
        &self,
        _anchor: PathBuf,
        _cancellation: CancellationToken,
    ) -> CatalogFuture<Result<GitWorktreeInventory, ScanFailure>> {
        let call = self.calls.fetch_add(1, Ordering::SeqCst) + 1;
        let response = self.response.clone();
        let release = Arc::clone(&self.release);
        Box::pin(async move {
            if call > 1 {
                release
                    .acquire()
                    .await
                    .expect("second scan release")
                    .forget();
            }
            Ok(response)
        })
    }
}

async fn wait_for_count(value: &AtomicUsize, expected: usize) {
    for _ in 0..10_000 {
        if value.load(Ordering::SeqCst) >= expected {
            return;
        }
        tokio::task::yield_now().await;
    }
    panic!("counter did not reach {expected}");
}

impl CatalogFileSystem for FakeFileSystem {
    fn probe(&self, path: PathBuf) -> CatalogFuture<DirectoryProbeState> {
        let state = self
            .states
            .lock()
            .expect("probe states")
            .get(&path)
            .copied()
            .unwrap_or(DirectoryProbeState::Missing);
        Box::pin(async move { state })
    }

    fn canonicalize(&self, path: PathBuf) -> CatalogFuture<Result<PathBuf, std::io::Error>> {
        Box::pin(async move { Ok(path) })
    }

    fn shallow_signature(
        &self,
        common_dir: PathBuf,
        known_paths: Vec<PathBuf>,
    ) -> CatalogFuture<CatalogShallowSignature> {
        self.shallow_calls
            .lock()
            .expect("shallow signature calls")
            .push((common_dir, known_paths));
        Box::pin(async { CatalogShallowSignature::default() })
    }
}

fn project(
    project_id: &str,
    workspace_root: &str,
    threads: impl IntoIterator<Item = CatalogThread>,
) -> (String, CatalogProject) {
    (
        project_id.to_owned(),
        CatalogProject {
            workspace_root: PathBuf::from(workspace_root),
            baseline_paths: Vec::new(),
            threads: threads.into_iter().collect(),
        },
    )
}

fn thread(thread_id: &str, worktree_path: &str) -> CatalogThread {
    CatalogThread {
        thread_id: thread_id.to_owned(),
        kind: "workspace".to_owned(),
        worktree_path: Some(PathBuf::from(worktree_path)),
        branch: Some("feature".to_owned()),
        archived: false,
        deleted: false,
    }
}

fn archived_thread(thread_id: &str, worktree_path: &str) -> CatalogThread {
    CatalogThread {
        archived: true,
        ..thread(thread_id, worktree_path)
    }
}

fn panel_thread(thread_id: &str, worktree_path: &str) -> CatalogThread {
    CatalogThread {
        kind: "panel".to_owned(),
        ..thread(thread_id, worktree_path)
    }
}

fn deleted_thread(thread_id: &str, worktree_path: &str) -> CatalogThread {
    CatalogThread {
        deleted: true,
        ..thread(thread_id, worktree_path)
    }
}

fn descriptor<'a>(
    snapshot: &'a super::WorktreeCatalogSnapshot,
    path: &str,
) -> &'a super::WorktreeDescriptor {
    snapshot
        .worktrees
        .iter()
        .find(|worktree| worktree.path == path)
        .expect("worktree descriptor")
}

fn adopted<'a>(
    snapshot: &'a super::WorktreeCatalogSnapshot,
    thread_id: &str,
) -> &'a super::AdoptedWorktreeStatus {
    snapshot
        .adopted_workspaces
        .iter()
        .find(|workspace| workspace.thread_id == thread_id)
        .expect("adopted workspace status")
}

fn inventory(
    common_dir: &str,
    records: impl IntoIterator<Item = GitWorktreeRecord>,
) -> GitWorktreeInventory {
    GitWorktreeInventory {
        common_dir: PathBuf::from(common_dir),
        records: records.into_iter().collect(),
        nul_delimited: true,
    }
}

fn record(path: &str, is_primary: bool) -> GitWorktreeRecord {
    GitWorktreeRecord {
        path: PathBuf::from(path),
        head: Some("abc123".to_owned()),
        branch: Some(if is_primary { "main" } else { "feature" }.to_owned()),
        is_primary,
        is_bare: false,
        locked: false,
        lock_reason: None,
        is_prunable: false,
        prunable_reason: None,
    }
}
