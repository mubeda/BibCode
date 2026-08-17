use std::{
    collections::HashSet,
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    sync::Arc,
};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use tokio::{
    sync::{Mutex, Semaphore, TryAcquireError, oneshot, watch},
    task::JoinHandle,
};
use tokio_util::sync::CancellationToken;

use crate::{
    crypto::sha256_hex,
    git::{
        CreateWorktreeInput, GitCommandError, GitPrunableWorktree, GitRepository,
        GitWorktreeInventory, GitWorktreeRecord, GitWorktreeRemovalInspection,
        canonical_worktree_path_key, git_worktree_prune_impact_digest, host_path_platform,
        normalize_worktree_path_key, worktree_key, worktree_repository_key,
    },
    orchestration::{
        CommandAdmission, OrchestrationCommand, OrchestrationEngine, OrchestrationError,
        canonical_command_digest,
        engine::{CommandAdmissionClaim, OptionalNullable, WorkspaceOwnershipLease},
    },
    persistence::CommandReceipt,
    rpc::{RpcRegistry, RpcRequest, RpcResult, RpcStreamChunk},
    worktree_catalog::{
        AdoptionValidationError, AdoptionValidationErrorReason, CatalogError, CatalogErrorReason,
        CatalogFuture, CatalogHealthySnapshotObserver, CatalogRefreshTrigger,
        WorkspaceRemovalIdentity, WorktreeAdoptionState, WorktreeCatalogService,
        WorktreeCatalogSnapshot, WorktreeDirectoryState, WorktreeRegistrationState,
    },
};

const MAX_BASELINE_PATHS: usize = 512;
const PRODUCTION_MAX_IN_FLIGHT_WORKTREE_OPERATIONS: usize = 64;

pub type WorktreeRemovalQuiesceFuture =
    Pin<Box<dyn Future<Output = WorktreeRemovalQuiesceLease> + Send + 'static>>;
pub type WorktreeRemovalCleanupAdmissionFuture = Pin<
    Box<
        dyn Future<
                Output = Result<
                    WorktreeRemovalCleanupAdmission,
                    WorktreeRemovalCleanupAdmissionError,
                >,
            > + Send
            + 'static,
    >,
>;

#[derive(Clone)]
pub struct WorktreeRemovalCleanupAdmission {
    _resource: Arc<dyn Send + Sync + 'static>,
}

impl WorktreeRemovalCleanupAdmission {
    fn unlimited() -> Self {
        Self {
            _resource: Arc::new(()),
        }
    }

    pub(crate) fn retaining(resource: impl Send + Sync + 'static) -> Self {
        Self {
            _resource: Arc::new(resource),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorktreeRemovalCleanupAdmissionError {
    Capacity,
}

pub struct WorktreeRemovalQuiesceLease {
    orphan_cleanup_pending: bool,
    cancellation: CancellationToken,
    detached: bool,
}

#[derive(Clone)]
pub struct WorktreeRemovalQuiesceRequest {
    identity: WorkspaceRemovalIdentity,
    project_id: String,
    repository_key: Option<String>,
    known_thread_ids: Vec<String>,
}

impl WorktreeRemovalQuiesceRequest {
    #[must_use]
    pub fn project(
        identity: WorkspaceRemovalIdentity,
        project_id: String,
        known_thread_ids: Vec<String>,
    ) -> Self {
        Self {
            identity,
            project_id,
            repository_key: None,
            known_thread_ids,
        }
    }

    #[must_use]
    pub fn repository(
        identity: WorkspaceRemovalIdentity,
        project_id: String,
        repository_key: String,
        known_thread_ids: Vec<String>,
    ) -> Self {
        Self {
            identity,
            project_id,
            repository_key: Some(repository_key),
            known_thread_ids,
        }
    }

    pub(crate) fn identity(&self) -> &WorkspaceRemovalIdentity {
        &self.identity
    }

    pub(crate) fn project_id(&self) -> &str {
        &self.project_id
    }

    pub(crate) fn repository_key(&self) -> Option<&str> {
        self.repository_key.as_deref()
    }

    pub(crate) fn known_thread_ids(&self) -> &[String] {
        &self.known_thread_ids
    }

    pub(crate) fn replace_identity(&mut self, identity: WorkspaceRemovalIdentity) {
        self.identity = identity;
    }
}

impl WorktreeRemovalQuiesceLease {
    #[must_use]
    pub fn complete() -> Self {
        Self {
            orphan_cleanup_pending: false,
            cancellation: CancellationToken::new(),
            detached: false,
        }
    }

    #[must_use]
    pub fn pending(cancellation: CancellationToken) -> Self {
        Self {
            orphan_cleanup_pending: true,
            cancellation,
            detached: false,
        }
    }

    #[must_use]
    pub fn orphan_cleanup_pending(&self) -> bool {
        self.orphan_cleanup_pending
    }

    pub fn commit_detached(mut self) {
        self.detached = true;
    }
}

impl Drop for WorktreeRemovalQuiesceLease {
    fn drop(&mut self) {
        if !self.detached {
            self.cancellation.cancel();
        }
    }
}

pub trait WorktreeRemovalQuiescer: Send + Sync + 'static {
    fn admit_cleanup(&self) -> WorktreeRemovalCleanupAdmissionFuture {
        Box::pin(async { Ok(WorktreeRemovalCleanupAdmission::unlimited()) })
    }

    fn quiesce(
        &self,
        admission: WorktreeRemovalCleanupAdmission,
        request: WorktreeRemovalQuiesceRequest,
    ) -> WorktreeRemovalQuiesceFuture;
}

pub type WorktreeRemovalGitFuture<T> =
    Pin<Box<dyn Future<Output = Result<T, GitCommandError>> + Send + 'static>>;

pub trait WorktreeRemovalGit: Send + Sync + 'static {
    fn inventory(
        &self,
        anchor: PathBuf,
        cancellation: CancellationToken,
    ) -> WorktreeRemovalGitFuture<GitWorktreeInventory>;
    fn inspect(
        &self,
        anchor: PathBuf,
        record: GitWorktreeRecord,
        cancellation: CancellationToken,
    ) -> WorktreeRemovalGitFuture<GitWorktreeRemovalInspection>;
    fn preview_prune(
        &self,
        anchor: PathBuf,
        cancellation: CancellationToken,
    ) -> WorktreeRemovalGitFuture<Vec<GitPrunableWorktree>>;
    fn remove(
        &self,
        anchor: PathBuf,
        record: GitWorktreeRecord,
        force_dirty: bool,
        cancellation: CancellationToken,
    ) -> WorktreeRemovalGitFuture<()>;
    fn prune(
        &self,
        anchor: PathBuf,
        record: GitWorktreeRecord,
        expected_impact_digest: String,
        cancellation: CancellationToken,
    ) -> WorktreeRemovalGitFuture<()>;
}

impl WorktreeRemovalGit for GitRepository {
    fn inventory(
        &self,
        anchor: PathBuf,
        cancellation: CancellationToken,
    ) -> WorktreeRemovalGitFuture<GitWorktreeInventory> {
        let repository = self.clone();
        Box::pin(async move { repository.worktree_inventory(&anchor, &cancellation).await })
    }

    fn inspect(
        &self,
        anchor: PathBuf,
        record: GitWorktreeRecord,
        cancellation: CancellationToken,
    ) -> WorktreeRemovalGitFuture<GitWorktreeRemovalInspection> {
        let repository = self.clone();
        Box::pin(async move {
            repository
                .inspect_worktree_removal(&anchor, &record, &cancellation)
                .await
        })
    }

    fn preview_prune(
        &self,
        anchor: PathBuf,
        cancellation: CancellationToken,
    ) -> WorktreeRemovalGitFuture<Vec<GitPrunableWorktree>> {
        let repository = self.clone();
        Box::pin(async move {
            repository
                .preview_worktree_prune(&anchor, &cancellation)
                .await
        })
    }

    fn remove(
        &self,
        anchor: PathBuf,
        record: GitWorktreeRecord,
        force_dirty: bool,
        cancellation: CancellationToken,
    ) -> WorktreeRemovalGitFuture<()> {
        let repository = self.clone();
        Box::pin(async move {
            repository
                .remove_worktree_verified(&anchor, &record, force_dirty, &cancellation)
                .await
        })
    }

    fn prune(
        &self,
        anchor: PathBuf,
        record: GitWorktreeRecord,
        expected_impact_digest: String,
        cancellation: CancellationToken,
    ) -> WorktreeRemovalGitFuture<()> {
        let repository = self.clone();
        Box::pin(async move {
            repository
                .prune_worktrees_verified(&anchor, &record, &expected_impact_digest, &cancellation)
                .await
        })
    }
}

#[derive(Default)]
struct NoopWorktreeRemovalQuiescer;

impl WorktreeRemovalQuiescer for NoopWorktreeRemovalQuiescer {
    fn quiesce(
        &self,
        _admission: WorktreeRemovalCleanupAdmission,
        _request: WorktreeRemovalQuiesceRequest,
    ) -> WorktreeRemovalQuiesceFuture {
        Box::pin(async { WorktreeRemovalQuiesceLease::complete() })
    }
}

#[derive(Clone)]
pub struct WorktreeCatalogRpcServices {
    catalog: WorktreeCatalogService,
    orchestration: OrchestrationEngine,
    creation_git: Option<Arc<GitRepository>>,
    removal_quiescer: Arc<dyn WorktreeRemovalQuiescer>,
    removal_git: Option<Arc<dyn WorktreeRemovalGit>>,
    operations: WorktreeCatalogOperationRuntime,
}

#[derive(Clone)]
pub struct WorktreeCatalogOperationRuntime {
    state: Arc<Mutex<WorktreeCatalogOperationState>>,
    admission: Arc<Semaphore>,
}

struct WorktreeCatalogOperationState {
    accepting: bool,
    tasks: Vec<JoinHandle<()>>,
}

impl WorktreeCatalogOperationRuntime {
    fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(WorktreeCatalogOperationState {
                accepting: true,
                tasks: Vec::new(),
            })),
            admission: Arc::new(Semaphore::new(PRODUCTION_MAX_IN_FLIGHT_WORKTREE_OPERATIONS)),
        }
    }

    async fn run(&self, operation: impl Future<Output = RpcResult> + Send + 'static) -> RpcResult {
        let operation_permit = match self.admission.clone().try_acquire_owned() {
            Ok(permit) => permit,
            Err(TryAcquireError::NoPermits) => {
                return Err(encode(WorktreeOperationError::capacity()));
            }
            Err(TryAcquireError::Closed) => {
                return Err(encode(WorktreeOperationError::shutting_down()));
            }
        };
        let (result_sender, result_receiver) = oneshot::channel();
        {
            let mut state = self.state.lock().await;
            if !state.accepting {
                return Err(encode(WorktreeOperationError::shutting_down()));
            }
            state.tasks.retain(|task| !task.is_finished());
            state.tasks.push(tokio::spawn(async move {
                let _operation_permit = operation_permit;
                let _ = result_sender.send(operation.await);
            }));
        }
        result_receiver.await.unwrap_or_else(|_| {
            Err(encode(CatalogError::new(
                CatalogErrorReason::Internal,
                "The server-owned worktree operation ended without a result.",
            )))
        })
    }

    pub async fn shutdown(&self) {
        let tasks = {
            let mut state = self.state.lock().await;
            state.accepting = false;
            self.admission.close();
            std::mem::take(&mut state.tasks)
        };
        for task in tasks {
            let _ = task.await;
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorktreeOperationError {
    #[serde(rename = "_tag")]
    tag: &'static str,
    reason: WorktreeOperationErrorReason,
    message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "kebab-case")]
enum WorktreeOperationErrorReason {
    OperationCapacity,
    OperationShuttingDown,
}

impl WorktreeOperationError {
    fn capacity() -> Self {
        Self {
            tag: "WorktreeOperationError",
            reason: WorktreeOperationErrorReason::OperationCapacity,
            message: "The server is already processing the maximum number of worktree operations."
                .to_owned(),
        }
    }

    fn shutting_down() -> Self {
        Self {
            tag: "WorktreeOperationError",
            reason: WorktreeOperationErrorReason::OperationShuttingDown,
            message: "The worktree operation runtime is shutting down.".to_owned(),
        }
    }
}

impl WorktreeCatalogRpcServices {
    #[must_use]
    pub fn new(catalog: WorktreeCatalogService, orchestration: OrchestrationEngine) -> Self {
        catalog.set_healthy_snapshot_observer(Arc::new(BranchReconciliationObserver {
            orchestration: orchestration.clone(),
        }));
        let creation_git = catalog.git_repository();
        let removal_git = creation_git
            .clone()
            .map(|repository| repository as Arc<dyn WorktreeRemovalGit>);
        Self {
            catalog,
            orchestration,
            creation_git,
            removal_quiescer: Arc::new(NoopWorktreeRemovalQuiescer),
            removal_git,
            operations: WorktreeCatalogOperationRuntime::new(),
        }
    }

    #[must_use]
    pub fn with_removal_quiescer(mut self, quiescer: Arc<dyn WorktreeRemovalQuiescer>) -> Self {
        self.removal_quiescer = quiescer;
        self
    }

    #[must_use]
    pub fn with_removal_git(mut self, git: Arc<dyn WorktreeRemovalGit>) -> Self {
        self.removal_git = Some(git);
        self
    }

    #[must_use]
    pub fn operation_runtime(&self) -> WorktreeCatalogOperationRuntime {
        self.operations.clone()
    }
}

#[derive(Clone)]
struct BranchReconciliationObserver {
    orchestration: OrchestrationEngine,
}

impl CatalogHealthySnapshotObserver for BranchReconciliationObserver {
    fn observe(
        &self,
        project_id: String,
        snapshot: Arc<WorktreeCatalogSnapshot>,
    ) -> CatalogFuture<()> {
        let observer = self.clone();
        Box::pin(async move {
            observer.reconcile(project_id, snapshot).await;
        })
    }
}

impl BranchReconciliationObserver {
    async fn reconcile(&self, project_id: String, snapshot: Arc<WorktreeCatalogSnapshot>) {
        if !snapshot.authoritative
            || !matches!(
                snapshot.scan_status,
                crate::worktree_catalog::CatalogScanStatus::Ready
            )
        {
            return;
        }
        let threads = match self
            .orchestration
            .repositories()
            .list_threads_by_project(project_id.clone())
            .await
        {
            Ok(threads) => threads,
            Err(error) => {
                tracing::warn!(project_id, %error, "could not load adopted threads for branch reconciliation");
                return;
            }
        };
        let mut candidates = snapshot
            .worktrees
            .iter()
            .filter_map(|descriptor| {
                (descriptor.adoption_state == WorktreeAdoptionState::Active)
                    .then_some(descriptor.adopted_thread_id.as_deref())
                    .flatten()
                    .map(|thread_id| {
                        (
                            thread_id.to_owned(),
                            descriptor.branch.clone(),
                            descriptor.head.clone(),
                        )
                    })
            })
            .collect::<Vec<_>>();
        candidates.sort_by(|left, right| left.0.cmp(&right.0));
        candidates.dedup_by(|left, right| left.0 == right.0);
        for (thread_id, branch, head) in candidates {
            let Some(thread) = threads.iter().find(|thread| {
                thread.thread_id == thread_id
                    && thread.kind == "workspace"
                    && thread.archived_at.is_none()
                    && thread.deleted_at.is_none()
                    && thread.worktree_path.is_some()
            }) else {
                continue;
            };
            if thread.branch == branch {
                continue;
            }
            let command_id =
                branch_reconciliation_command_id(&thread_id, branch.as_deref(), head.as_deref());
            if let Err(error) = self
                .orchestration
                .dispatch(OrchestrationCommand::WorktreeBranchReconcileResolved {
                    command_id,
                    project_id: project_id.clone(),
                    thread_id: thread_id.clone(),
                    branch,
                })
                .await
            {
                tracing::warn!(project_id, thread_id, %error, "adopted worktree branch reconciliation failed");
            }
        }
    }
}

fn branch_reconciliation_command_id(
    thread_id: &str,
    branch: Option<&str>,
    head: Option<&str>,
) -> String {
    let mut identity = b"bibcode.worktree.branch-reconcile.v1\0".to_vec();
    identity.extend_from_slice(branch.unwrap_or("<detached>").as_bytes());
    identity.push(0);
    identity.extend_from_slice(head.unwrap_or("<unknown>").as_bytes());
    format!(
        "worktree-branch-reconcile:{thread_id}:{}",
        sha256_hex(identity)
    )
}

async fn acquire_worktree_command_claim(
    orchestration: &OrchestrationEngine,
    command_id: &str,
    cancellation: &CancellationToken,
) -> Result<CommandAdmissionClaim, OrchestrationError> {
    tokio::select! {
        biased;
        () = cancellation.cancelled() => Err(OrchestrationError::Cancelled),
        claim = orchestration.acquire_command_admission(command_id) => claim,
    }
}

pub fn register_worktree_catalog_rpc(
    registry: &mut RpcRegistry,
    services: WorktreeCatalogRpcServices,
) {
    let stream_services = services.clone();
    registry.register_latest_stream("subscribeWorktreeCatalog", move |request, cancellation| {
        catalog_stream(stream_services.clone(), request, cancellation)
    });

    let refresh_services = services.clone();
    registry.register_unary(
        "vcs.refreshWorktreeCatalog",
        move |request, _cancellation| {
            let services = refresh_services.clone();
            async move {
                let input = decode::<WorktreeCatalogInput>(request)?;
                services
                    .catalog
                    .refresh(&input.project_id, CatalogRefreshTrigger::Explicit)
                    .await
                    .map(|snapshot| encode(snapshot.as_ref()))
                    .map_err(encode)
            }
        },
    );

    let adoption_services = services.clone();
    registry.register_unary("worktree.adopt", move |request, cancellation| {
        let services = adoption_services.clone();
        async move { adopt_worktree(&services, request, cancellation).await }
    });

    let create_managed_services = services.clone();
    registry.register_unary("worktree.createManaged", move |request, cancellation| {
        let services = create_managed_services.clone();
        async move { create_managed_worktree(&services, request, cancellation).await }
    });

    let create_panel_services = services.clone();
    registry.register_unary("worktree.createPanel", move |request, cancellation| {
        let services = create_panel_services.clone();
        async move { create_worktree_panel(&services, request, cancellation).await }
    });

    let retarget_services = services.clone();
    registry.register_unary("worktree.retarget", move |request, cancellation| {
        let services = retarget_services.clone();
        async move { retarget_worktree_thread(&services, request, cancellation).await }
    });

    let plan_services = services.clone();
    registry.register_unary("worktree.getRemovalPlan", move |request, cancellation| {
        let services = plan_services.clone();
        async move { get_removal_plan(&services, request, cancellation).await }
    });

    let detach_services = services.clone();
    registry.register_unary(
        "worktree.removeFromBibCode",
        move |request, cancellation| {
            let services = detach_services.clone();
            async move { remove_from_bibcode(&services, request, cancellation).await }
        },
    );

    let removal_services = services.clone();
    registry.register_unary("worktree.remove", move |request, cancellation| {
        let services = removal_services.clone();
        async move { remove_worktree(&services, request, cancellation).await }
    });

    registry.register_unary(
        "worktree.updateDiscoveryPolicy",
        move |request, cancellation| {
            let services = services.clone();
            async move { update_discovery_policy(&services, request, cancellation).await }
        },
    );
}

async fn adopt_worktree(
    services: &WorktreeCatalogRpcServices,
    request: RpcRequest,
    cancellation: CancellationToken,
) -> RpcResult {
    let input = decode::<WorktreeAdoptInput>(request)?;
    let payload_digest = canonical_command_digest(&input).map_err(|_| {
        encode(adoption_error(
            WorktreeAdoptionErrorReason::Internal,
            "The adoption payload could not be admitted.",
            None,
        ))
    })?;
    let command_claim =
        acquire_worktree_command_claim(&services.orchestration, &input.command_id, &cancellation)
            .await
            .map_err(|error| encode(adoption_orchestration_error(error, None)))?;
    if let Some(result) = services
        .orchestration
        .replay_admitted_worktree_adoption(&command_claim, &input.command_id, &payload_digest)
        .await
        .map_err(|error| encode(adoption_orchestration_error(error, None)))?
    {
        return adoption_dispatch_result(result, None);
    }
    let project_id = input.project_id.clone();
    let operation_runtime = services.operations.clone();
    let services = services.clone();
    operation_runtime
        .run(async move {
            let operation_cancellation = cancellation.clone();
            let lock_cancellation = cancellation.clone();
            let catalog = services.catalog.clone();
            catalog
                .with_project_mutation_lock_cancellation(
                    &project_id,
                    &lock_cancellation,
                    || async move {
                        adopt_worktree_locked(
                            &services,
                            input,
                            payload_digest,
                            command_claim,
                            &operation_cancellation,
                        )
                        .await
                    },
                )
                .await
                .unwrap_or_else(|| {
                    Err(encode(adoption_orchestration_error(
                        OrchestrationError::Cancelled,
                        None,
                    )))
                })
        })
        .await
}

async fn adopt_worktree_locked(
    services: &WorktreeCatalogRpcServices,
    input: WorktreeAdoptInput,
    payload_digest: String,
    command_claim: CommandAdmissionClaim,
    cancellation: &CancellationToken,
) -> RpcResult {
    let (mut snapshot, refreshed) = match services.catalog.latest(&input.project_id).await {
        Some(snapshot) => (snapshot, false),
        None => services
            .catalog
            .refresh(&input.project_id, CatalogRefreshTrigger::Explicit)
            .await
            .map(|snapshot| (snapshot, true))
            .map_err(|error| encode(adoption_catalog_error(error, None)))?,
    };
    if !refreshed && (!snapshot.authoritative || snapshot.generation != input.expected_generation) {
        snapshot = services
            .catalog
            .refresh(&input.project_id, CatalogRefreshTrigger::Explicit)
            .await
            .map_err(|error| encode(adoption_catalog_error(error, Some(snapshot.generation))))?;
    }
    if !snapshot.authoritative || input.expected_generation > snapshot.generation {
        return Err(encode(adoption_error(
            WorktreeAdoptionErrorReason::StaleGeneration,
            "The requested catalog generation is no longer usable for adoption.",
            Some(snapshot.generation),
        )));
    }
    let descriptor = snapshot
        .worktrees
        .iter()
        .find(|worktree| worktree.worktree_key == input.worktree_key)
        .ok_or_else(|| {
            encode(adoption_error(
                WorktreeAdoptionErrorReason::WorktreeNotFound,
                "The selected worktree is not present in the current catalog.",
                Some(snapshot.generation),
            ))
        })?;
    let existing_owner = matches!(
        descriptor.adoption_state,
        WorktreeAdoptionState::Active | WorktreeAdoptionState::Archived
    );
    if (!descriptor.eligible_for_adoption && !existing_owner)
        || descriptor.is_primary
        || descriptor.is_bare
        || descriptor.registration_state != WorktreeRegistrationState::Registered
        || descriptor.directory_state != WorktreeDirectoryState::Present
    {
        return Err(encode(adoption_error(
            WorktreeAdoptionErrorReason::Ineligible,
            "The selected worktree is not currently eligible for adoption.",
            Some(snapshot.generation),
        )));
    }
    let resolved = services
        .catalog
        .resolve_adoption_candidate(&input.project_id, &input.worktree_key)
        .await
        .map_err(|error| encode(adoption_validation_error(error)))?;
    let result = services
        .orchestration
        .dispatch_with_admission_and_command_claim_until_handoff(
            OrchestrationCommand::WorktreeAdoptResolved {
                command_id: input.command_id,
                project_id: input.project_id.clone(),
                worktree_key: resolved.worktree_key,
                path: resolved.path,
                branch: resolved.branch,
                head: resolved.head,
                model_selection: input.thread_defaults.model_selection,
                runtime_mode: input.thread_defaults.runtime_mode,
                interaction_mode: input.thread_defaults.interaction_mode,
            },
            CommandAdmission {
                payload_digest,
                attachment_refs: Vec::new(),
                provider_turn: None,
            },
            command_claim,
            cancellation,
        )
        .await
        .map_err(|error| {
            encode(adoption_orchestration_error(
                error,
                Some(snapshot.generation),
            ))
        })?;
    services
        .catalog
        .invalidate_after_mutation(&input.project_id)
        .await;
    adoption_dispatch_result(result, Some(snapshot.generation))
}

async fn replay_thread_operation(
    services: &WorktreeCatalogRpcServices,
    command_claim: &CommandAdmissionClaim,
    command_id: &str,
    payload_digest: &str,
) -> Result<bool, Value> {
    command_claim
        .ensure_owns(command_id)
        .map_err(|error| encode(adoption_orchestration_error(error, None)))?;
    let Some(receipt) = services
        .orchestration
        .repositories()
        .get_command_receipt(command_id.to_owned())
        .await
        .map_err(|_| {
            encode(adoption_error(
                WorktreeAdoptionErrorReason::Internal,
                "The durable command receipt could not be read.",
                None,
            ))
        })?
    else {
        return Ok(false);
    };
    if receipt.payload_digest.as_deref() != Some(payload_digest) {
        return Err(encode(adoption_error(
            WorktreeAdoptionErrorReason::CommandConflict,
            "The command ID was already used for another worktree operation.",
            None,
        )));
    }
    if receipt.status == "accepted" {
        return Ok(true);
    }
    Err(encode(adoption_error(
        WorktreeAdoptionErrorReason::OrchestrationFailed,
        receipt
            .error
            .unwrap_or_else(|| "The previous worktree operation was rejected.".to_owned()),
        None,
    )))
}

async fn create_managed_worktree(
    services: &WorktreeCatalogRpcServices,
    request: RpcRequest,
    cancellation: CancellationToken,
) -> RpcResult {
    let input = decode::<WorktreeCreateManagedInput>(request)?;
    let payload_digest = canonical_command_digest(&input).map_err(|_| {
        encode(adoption_error(
            WorktreeAdoptionErrorReason::Internal,
            "The managed creation payload could not be admitted.",
            None,
        ))
    })?;
    let command_claim =
        acquire_worktree_command_claim(&services.orchestration, &input.command_id, &cancellation)
            .await
            .map_err(|error| encode(adoption_orchestration_error(error, None)))?;
    if replay_thread_operation(services, &command_claim, &input.command_id, &payload_digest).await?
    {
        let thread = services
            .orchestration
            .repositories()
            .get_thread(input.thread_id.clone())
            .await
            .map_err(|_| {
                encode(adoption_error(
                    WorktreeAdoptionErrorReason::Internal,
                    "The managed workspace could not be reloaded.",
                    None,
                ))
            })?
            .and_then(|thread| thread.worktree_path.clone().map(|path| (thread, path)))
            .ok_or_else(|| {
                encode(adoption_error(
                    WorktreeAdoptionErrorReason::OrchestrationFailed,
                    "The accepted managed workspace is no longer available.",
                    None,
                ))
            })?;
        return Ok(encode(WorktreeManagedCreateResult {
            thread_id: input.thread_id,
            path: thread.1,
            ref_name: thread.0.branch.unwrap_or(input.ref_name),
        }));
    }
    let project_id = input.project_id.clone();
    let operation_runtime = services.operations.clone();
    let services = services.clone();
    operation_runtime
        .run(async move {
            let lock_cancellation = cancellation.clone();
            let catalog = services.catalog.clone();
            catalog
                .with_project_mutation_lock_cancellation(
                    &project_id,
                    &lock_cancellation,
                    || async move {
                        create_managed_worktree_locked(
                            &services,
                            input,
                            payload_digest,
                            command_claim,
                            &cancellation,
                        )
                        .await
                    },
                )
                .await
                .unwrap_or_else(|| {
                    Err(encode(adoption_orchestration_error(
                        OrchestrationError::Cancelled,
                        None,
                    )))
                })
        })
        .await
}

async fn create_managed_worktree_locked(
    services: &WorktreeCatalogRpcServices,
    input: WorktreeCreateManagedInput,
    payload_digest: String,
    command_claim: CommandAdmissionClaim,
    cancellation: &CancellationToken,
) -> RpcResult {
    let project = services
        .orchestration
        .repositories()
        .get_project(input.project_id.clone())
        .await
        .map_err(|_| {
            encode(adoption_error(
                WorktreeAdoptionErrorReason::Internal,
                "The project could not be read.",
                None,
            ))
        })?
        .filter(|project| project.deleted_at.is_none())
        .ok_or_else(|| {
            encode(adoption_error(
                WorktreeAdoptionErrorReason::ProjectNotFound,
                "Project was not found.",
                None,
            ))
        })?;
    let repository = services.creation_git.clone().ok_or_else(|| {
        encode(adoption_error(
            WorktreeAdoptionErrorReason::EnvironmentUnsupported,
            "Managed worktree creation is unavailable in this environment.",
            None,
        ))
    })?;
    let created = repository
        .create_worktree(
            CreateWorktreeInput {
                cwd: PathBuf::from(&project.workspace_root),
                ref_name: input.ref_name.clone(),
                new_ref_name: input.new_ref_name.clone(),
                base_ref_name: input.base_ref_name.clone(),
                path: None,
            },
            cancellation,
        )
        .await
        .map_err(encode)?;
    let rollback = created.rollback.clone().ok_or_else(|| {
        encode(adoption_error(
            WorktreeAdoptionErrorReason::Internal,
            "Managed worktree creation completed without exact rollback ownership.",
            None,
        ))
    })?;
    let terminal_cancellation = CancellationToken::new();
    let dispatch = services
        .orchestration
        .dispatch_with_admission_and_command_claim_until_handoff(
            OrchestrationCommand::ThreadCreate {
                command_id: input.command_id,
                thread_id: input.thread_id.clone(),
                project_id: input.project_id.clone(),
                title: input.title,
                kind: Some("workspace".to_owned()),
                model_selection: input.thread_defaults.model_selection,
                runtime_mode: input.thread_defaults.runtime_mode,
                interaction_mode: input.thread_defaults.interaction_mode,
                branch: Some(created.worktree.ref_name.clone()),
                worktree_path: Some(created.worktree.path.clone()),
                created_at: now_iso(),
            },
            CommandAdmission {
                payload_digest,
                attachment_refs: Vec::new(),
                provider_turn: None,
            },
            command_claim,
            &terminal_cancellation,
        )
        .await;
    if let Err(error) = dispatch {
        let rollback = repository
            .rollback_managed_worktree_creation(Path::new(&project.workspace_root), &rollback)
            .await;
        let detail = match rollback {
            Ok(()) => error.to_string(),
            Err(rollback) => format!(
                "{error}; exact managed-worktree rollback also failed: {}",
                rollback.detail
            ),
        };
        return Err(encode(adoption_error(
            WorktreeAdoptionErrorReason::OrchestrationFailed,
            detail,
            None,
        )));
    }
    services
        .catalog
        .note_managed_creation(&input.project_id, &rollback.created_path)
        .await;
    services
        .catalog
        .invalidate_after_mutation(&input.project_id)
        .await;
    Ok(encode(WorktreeManagedCreateResult {
        thread_id: input.thread_id,
        path: created.worktree.path,
        ref_name: created.worktree.ref_name,
    }))
}

async fn create_worktree_panel(
    services: &WorktreeCatalogRpcServices,
    request: RpcRequest,
    cancellation: CancellationToken,
) -> RpcResult {
    let input = decode::<WorktreeCreatePanelInput>(request)?;
    let payload_digest = canonical_command_digest(&input).map_err(|_| {
        encode(adoption_error(
            WorktreeAdoptionErrorReason::Internal,
            "The panel creation payload could not be admitted.",
            None,
        ))
    })?;
    let command_claim =
        acquire_worktree_command_claim(&services.orchestration, &input.command_id, &cancellation)
            .await
            .map_err(|error| encode(adoption_orchestration_error(error, None)))?;
    if replay_thread_operation(services, &command_claim, &input.command_id, &payload_digest).await?
    {
        return Ok(encode(WorktreeThreadResult {
            thread_id: input.thread_id,
        }));
    }
    let repositories = services.orchestration.repositories();
    let host = repositories
        .get_thread(input.host_thread_id.clone())
        .await
        .map_err(|_| {
            encode(adoption_error(
                WorktreeAdoptionErrorReason::Internal,
                "The host thread could not be read.",
                None,
            ))
        })?
        .filter(|thread| thread.deleted_at.is_none())
        .ok_or_else(|| {
            encode(adoption_error(
                WorktreeAdoptionErrorReason::WorktreeNotFound,
                "The host thread was not found.",
                None,
            ))
        })?;
    let project_id = host.project_id;
    let operation_runtime = services.operations.clone();
    let services = services.clone();
    operation_runtime
        .run(async move {
            let lock_cancellation = cancellation.clone();
            let catalog = services.catalog.clone();
            let locked_project_id = project_id.clone();
            catalog
                .with_project_mutation_lock_cancellation(
                    &project_id,
                    &lock_cancellation,
                    || async move {
                        let host = services
                            .orchestration
                            .repositories()
                            .get_thread(input.host_thread_id.clone())
                            .await
                            .map_err(|_| {
                                encode(adoption_error(
                                    WorktreeAdoptionErrorReason::Internal,
                                    "The host thread could not be revalidated.",
                                    None,
                                ))
                            })?
                            .filter(|thread| {
                                thread.deleted_at.is_none()
                                    && thread.project_id == locked_project_id
                            })
                            .ok_or_else(|| {
                                encode(adoption_error(
                                    WorktreeAdoptionErrorReason::WorktreeNotFound,
                                    "The host thread changed before panel creation.",
                                    None,
                                ))
                            })?;
                        let result = services
                            .orchestration
                            .dispatch_with_admission_and_command_claim_until_handoff(
                                OrchestrationCommand::ThreadCreate {
                                    command_id: input.command_id,
                                    thread_id: input.thread_id.clone(),
                                    project_id: locked_project_id.clone(),
                                    title: input.title,
                                    kind: Some("panel".to_owned()),
                                    model_selection: input.thread_defaults.model_selection,
                                    runtime_mode: input.thread_defaults.runtime_mode,
                                    interaction_mode: input.thread_defaults.interaction_mode,
                                    branch: host.branch,
                                    worktree_path: host.worktree_path,
                                    created_at: now_iso(),
                                },
                                CommandAdmission {
                                    payload_digest,
                                    attachment_refs: Vec::new(),
                                    provider_turn: None,
                                },
                                command_claim,
                                &cancellation,
                            )
                            .await
                            .map_err(|error| encode(adoption_orchestration_error(error, None)))?;
                        let _ = result;
                        Ok(encode(WorktreeThreadResult {
                            thread_id: input.thread_id,
                        }))
                    },
                )
                .await
                .unwrap_or_else(|| {
                    Err(encode(adoption_orchestration_error(
                        OrchestrationError::Cancelled,
                        None,
                    )))
                })
        })
        .await
}

async fn retarget_worktree_thread(
    services: &WorktreeCatalogRpcServices,
    request: RpcRequest,
    cancellation: CancellationToken,
) -> RpcResult {
    let input = decode::<WorktreeRetargetInput>(request)?;
    let payload_digest = canonical_command_digest(&input).map_err(|_| {
        encode(adoption_error(
            WorktreeAdoptionErrorReason::Internal,
            "The retarget payload could not be admitted.",
            None,
        ))
    })?;
    let command_claim =
        acquire_worktree_command_claim(&services.orchestration, &input.command_id, &cancellation)
            .await
            .map_err(|error| encode(adoption_orchestration_error(error, None)))?;
    if replay_thread_operation(services, &command_claim, &input.command_id, &payload_digest).await?
    {
        return Ok(encode(WorktreeThreadResult {
            thread_id: input.thread_id,
        }));
    }
    let project_id = input.project_id.clone();
    let operation_runtime = services.operations.clone();
    let services = services.clone();
    operation_runtime
        .run(async move {
            let lock_cancellation = cancellation.clone();
            let catalog = services.catalog.clone();
            let locked_project_id = project_id.clone();
            catalog
                .with_project_mutation_lock_cancellation(
                    &project_id,
                    &lock_cancellation,
                    || async move {
                        let (mut snapshot, refreshed) =
                            match services.catalog.latest(&locked_project_id).await {
                                Some(snapshot) => (snapshot, false),
                                None => services
                                    .catalog
                                    .refresh(&locked_project_id, CatalogRefreshTrigger::Explicit)
                                    .await
                                    .map(|snapshot| (snapshot, true))
                                    .map_err(|error| encode(adoption_catalog_error(error, None)))?,
                            };
                        if !refreshed
                            && (!snapshot.authoritative
                                || snapshot.generation != input.expected_generation)
                        {
                            snapshot = services
                                .catalog
                                .refresh(&locked_project_id, CatalogRefreshTrigger::Explicit)
                                .await
                                .map_err(|error| {
                                    encode(adoption_catalog_error(error, Some(snapshot.generation)))
                                })?;
                        }
                        if !snapshot.authoritative
                            || input.expected_generation > snapshot.generation
                        {
                            return Err(encode(adoption_error(
                                WorktreeAdoptionErrorReason::StaleGeneration,
                                "The selected worktree catalog generation changed.",
                                Some(snapshot.generation),
                            )));
                        }
                        let descriptor = snapshot
                            .worktrees
                            .iter()
                            .find(|descriptor| descriptor.worktree_key == input.worktree_key)
                            .ok_or_else(|| {
                                encode(adoption_error(
                                    WorktreeAdoptionErrorReason::WorktreeNotFound,
                                    "The selected worktree is not present.",
                                    Some(snapshot.generation),
                                ))
                            })?;
                        if descriptor.is_primary
                            || descriptor.is_bare
                            || descriptor.registration_state
                                != WorktreeRegistrationState::Registered
                            || descriptor.directory_state != WorktreeDirectoryState::Present
                            || descriptor
                                .adopted_thread_id
                                .as_deref()
                                .is_some_and(|owner| owner != input.thread_id)
                        {
                            return Err(encode(adoption_error(
                                WorktreeAdoptionErrorReason::OwnershipConflict,
                                "The selected worktree cannot be assigned to this thread.",
                                Some(snapshot.generation),
                            )));
                        }
                        let resolved = services
                            .catalog
                            .resolve_adoption_candidate(&locked_project_id, &input.worktree_key)
                            .await
                            .map_err(|error| encode(adoption_validation_error(error)))?;
                        services
                            .orchestration
                            .dispatch_with_admission_and_command_claim_until_handoff(
                                OrchestrationCommand::ThreadMetaUpdate {
                                    command_id: input.command_id,
                                    thread_id: input.thread_id.clone(),
                                    title: None,
                                    model_selection: None,
                                    branch: OptionalNullable::Present(resolved.branch),
                                    worktree_path: OptionalNullable::Present(Some(resolved.path)),
                                },
                                CommandAdmission {
                                    payload_digest,
                                    attachment_refs: Vec::new(),
                                    provider_turn: None,
                                },
                                command_claim,
                                &cancellation,
                            )
                            .await
                            .map_err(|error| {
                                encode(adoption_orchestration_error(
                                    error,
                                    Some(snapshot.generation),
                                ))
                            })?;
                        services
                            .catalog
                            .invalidate_after_mutation(&locked_project_id)
                            .await;
                        Ok(encode(WorktreeThreadResult {
                            thread_id: input.thread_id,
                        }))
                    },
                )
                .await
                .unwrap_or_else(|| {
                    Err(encode(adoption_orchestration_error(
                        OrchestrationError::Cancelled,
                        None,
                    )))
                })
        })
        .await
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorktreeRemoveFromBibCodeInput {
    command_id: String,
    project_id: String,
    thread_id: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorktreeRemoveInput {
    command_id: String,
    project_id: String,
    thread_id: String,
    mode: WorktreeRemovalMode,
    expected_generation: u64,
    plan_token: String,
    force_dirty: bool,
    confirm_repository_wide_prune: bool,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
enum WorktreeRemovalMode {
    DeleteGitWorktree,
    CleanupStaleRegistration,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorktreeGetRemovalPlanInput {
    project_id: String,
    thread_id: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorktreeRemovalPlan {
    plan_token: String,
    generation: u64,
    availability: &'static str,
    registered: bool,
    locked: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    lock_reason: Option<String>,
    tracked_change_count: u64,
    untracked_file_count: u64,
    prune_impact: Vec<WorktreePruneImpact>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorktreePruneImpact {
    path: String,
    prune_reason: String,
    locked: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    lock_reason: Option<String>,
}

struct ResolvedRemovalPlan {
    wire: WorktreeRemovalPlan,
    anchor: PathBuf,
    repository_key: String,
    record: Option<GitWorktreeRecord>,
    prune_impact: Vec<GitPrunableWorktree>,
}

struct ResolvedRemovalThread {
    path: PathBuf,
    known_thread_ids: Vec<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorktreeRemovalResult {
    thread_removed: bool,
    git_outcome: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
    orphan_cleanup_pending: bool,
}

#[derive(Clone, Copy, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum WorktreeRemovalErrorReason {
    ThreadNotFound,
    EnvironmentUnsupported,
    CommandConflict,
    CleanupCapacity,
    OwnershipConflict,
    StaleGeneration,
    StalePlan,
    DirtyConfirmationRequired,
    PruneConfirmationRequired,
    ProtectedTarget,
    Locked,
    ReplacementConflict,
    RepositoryMismatch,
    GitFailed,
    OrchestrationFailed,
    Internal,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorktreeRemovalError {
    #[serde(rename = "_tag")]
    tag: &'static str,
    reason: WorktreeRemovalErrorReason,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    current_generation: Option<u64>,
}

async fn get_removal_plan(
    services: &WorktreeCatalogRpcServices,
    request: RpcRequest,
    cancellation: CancellationToken,
) -> RpcResult {
    let input = decode::<WorktreeGetRemovalPlanInput>(request)?;
    let project_id = input.project_id.clone();
    let catalog = services.catalog.clone();
    catalog
        .with_project_mutation_lock_cancellation(&project_id, &cancellation, || async {
            let plan = build_removal_plan(
                services,
                &input.project_id,
                &input.thread_id,
                None,
                true,
                &cancellation,
            )
            .await?;
            Ok(encode(plan.wire))
        })
        .await
        .unwrap_or_else(|| {
            Err(encode(removal_orchestration_error(
                OrchestrationError::Cancelled,
            )))
        })
}

async fn remove_from_bibcode(
    services: &WorktreeCatalogRpcServices,
    request: RpcRequest,
    cancellation: CancellationToken,
) -> RpcResult {
    let input = decode::<WorktreeRemoveFromBibCodeInput>(request)?;
    let payload_digest = removal_payload_digest(&input)?;
    let command_claim =
        acquire_worktree_command_claim(&services.orchestration, &input.command_id, &cancellation)
            .await
            .map_err(|error| encode(removal_orchestration_error(error)))?;
    if let Some(result) =
        replay_removal(services, &command_claim, &input.command_id, &payload_digest).await?
    {
        return Ok(encode(result));
    }
    let operation_runtime = services.operations.clone();
    let services = services.clone();
    operation_runtime
        .run(async move {
            remove_from_bibcode_owned(
                &services,
                input,
                payload_digest,
                command_claim,
                cancellation,
            )
            .await
        })
        .await
}

async fn remove_from_bibcode_owned(
    services: &WorktreeCatalogRpcServices,
    input: WorktreeRemoveFromBibCodeInput,
    payload_digest: String,
    command_claim: CommandAdmissionClaim,
    cancellation: CancellationToken,
) -> RpcResult {
    let cleanup_admission = admit_removal_cleanup(services).await?;
    let cleanup_lifecycle = cleanup_admission.clone();
    let reservation = reserve_removal(services, &command_claim, &input, &payload_digest).await?;
    if let Some(result) = reservation.result {
        return Ok(encode(result));
    }
    let project_id = input.project_id.clone();
    let catalog = services.catalog.clone();
    catalog
        .with_project_mutation_lock_cancellation(&project_id, &cancellation, || async {
            if let Some(result) =
                replay_removal(services, &command_claim, &input.command_id, &payload_digest).await?
            {
                return Ok(encode(result));
            }
            let (ownership, resolved) = resolve_removal_thread_with_ownership(
                services,
                &input.project_id,
                &input.thread_id,
            )
            .await?;
            let registry = services.catalog.availability_registry();
            let guard = registry
                .mark_removing(&input.thread_id, &resolved.path)
                .await
                .map_err(encode)?;
            let quiesce = services
                .removal_quiescer
                .quiesce(
                    cleanup_admission,
                    WorktreeRemovalQuiesceRequest::project(
                        guard.identity(),
                        input.project_id.clone(),
                        resolved.known_thread_ids,
                    ),
                )
                .await;
            let orphan_cleanup_pending = quiesce.orphan_cleanup_pending();
            let result = persist_detach(
                services,
                input.command_id,
                input.project_id.clone(),
                input.thread_id.clone(),
                resolved.path.clone(),
                payload_digest,
                "not-requested",
                None,
                orphan_cleanup_pending,
                command_claim.clone(),
                ownership.clone(),
                &cancellation,
            )
            .await?;
            quiesce.commit_detached();
            registry
                .clear_recovered(&input.thread_id, &resolved.path)
                .await
                .map_err(encode)?;
            drop(guard);
            services
                .catalog
                .invalidate_after_mutation(&input.project_id)
                .await;
            drop(cleanup_lifecycle);
            Ok(encode(result))
        })
        .await
        .unwrap_or_else(|| {
            Err(encode(removal_orchestration_error(
                OrchestrationError::Cancelled,
            )))
        })
}

async fn remove_worktree(
    services: &WorktreeCatalogRpcServices,
    request: RpcRequest,
    cancellation: CancellationToken,
) -> RpcResult {
    let input = decode::<WorktreeRemoveInput>(request)?;
    let payload_digest = removal_payload_digest(&input)?;
    let command_claim =
        acquire_worktree_command_claim(&services.orchestration, &input.command_id, &cancellation)
            .await
            .map_err(|error| encode(removal_orchestration_error(error)))?;
    if let Some(result) =
        replay_removal(services, &command_claim, &input.command_id, &payload_digest).await?
    {
        return Ok(encode(result));
    }
    let operation_runtime = services.operations.clone();
    let services = services.clone();
    operation_runtime
        .run(async move {
            remove_worktree_owned(
                &services,
                input,
                payload_digest,
                command_claim,
                cancellation,
            )
            .await
        })
        .await
}

async fn remove_worktree_owned(
    services: &WorktreeCatalogRpcServices,
    input: WorktreeRemoveInput,
    payload_digest: String,
    command_claim: CommandAdmissionClaim,
    cancellation: CancellationToken,
) -> RpcResult {
    let cleanup_admission = admit_removal_cleanup(services).await?;
    let cleanup_lifecycle = cleanup_admission.clone();
    let reservation = reserve_removal(services, &command_claim, &input, &payload_digest).await?;
    if let Some(result) = reservation.result {
        return Ok(encode(result));
    }
    let project_id = input.project_id.clone();
    let catalog = services.catalog.clone();
    catalog
        .with_project_mutation_lock_cancellation(&project_id, &cancellation, || async {
            if let Some(result) =
                replay_removal(services, &command_claim, &input.command_id, &payload_digest).await?
            {
                return Ok(encode(result));
            }
            let (ownership, resolved) = resolve_removal_thread_with_ownership(
                services,
                &input.project_id,
                &input.thread_id,
            )
            .await?;
            let registry = services.catalog.availability_registry();
            let guard = registry
                .mark_removing(&input.thread_id, &resolved.path)
                .await
                .map_err(encode)?;
            let mut plan = build_removal_plan(
                services,
                &input.project_id,
                &input.thread_id,
                Some(input.expected_generation),
                false,
                &cancellation,
            )
            .await?;
            let resumed_git_success = reservation.prepared_retry
                && matches!(input.mode, WorktreeRemovalMode::DeleteGitWorktree)
                && plan.wire.availability == "missing-unregistered";
            if plan.wire.plan_token != input.plan_token && !resumed_git_success {
                return Err(encode(removal_error(
                    WorktreeRemovalErrorReason::StalePlan,
                    "The removal impact changed after it was confirmed.",
                    Some(plan.wire.generation),
                )));
            }
            validate_git_removal_preflight(&input, &plan, resumed_git_success).map_err(encode)?;
            services
                .orchestration
                .prepare_worktree_removal_admission(
                    &command_claim,
                    &input.command_id,
                    &input.project_id,
                    &payload_digest,
                )
                .await
                .map_err(|error| encode(removal_orchestration_error(error)))?;
            let quiesce = services
                .removal_quiescer
                .quiesce(
                    cleanup_admission,
                    WorktreeRemovalQuiesceRequest::repository(
                        guard.identity(),
                        input.project_id.clone(),
                        plan.repository_key.clone(),
                        resolved.known_thread_ids,
                    ),
                )
                .await;
            let orphan_cleanup_pending = quiesce.orphan_cleanup_pending();
            services
                .orchestration
                .verify_prepared_worktree_removal_admission(
                    &command_claim,
                    &input.command_id,
                    &input.project_id,
                    &payload_digest,
                )
                .await
                .map_err(|error| encode(removal_orchestration_error(error)))?;
            if cancellation.is_cancelled() {
                return Err(encode(removal_orchestration_error(
                    OrchestrationError::Cancelled,
                )));
            }
            let terminal_cancellation = CancellationToken::new();
            if !resumed_git_success {
                let trusted_anchor = services
                    .catalog
                    .resolve_trusted_repository_anchor(
                        &input.project_id,
                        &resolved.path,
                        &terminal_cancellation,
                    )
                    .await
                    .map_err(|error| {
                        encode(removal_catalog_error(error, Some(plan.wire.generation)))
                    })?;
                if trusted_anchor.repository_key != plan.repository_key {
                    return Err(encode(removal_error(
                        WorktreeRemovalErrorReason::RepositoryMismatch,
                        "The trusted removal anchor changed repository identity before Git mutation.",
                        Some(plan.wire.generation),
                    )));
                }
                plan.anchor = trusted_anchor.path;
            }
            let git_result = if resumed_git_success {
                Ok(("removed", None))
            } else {
                apply_git_removal(services, &input, &plan, &terminal_cancellation).await
            };
            let (git_outcome, detail) = match git_result {
                Ok(outcome) => outcome,
                Err(error)
                    if matches!(input.mode, WorktreeRemovalMode::CleanupStaleRegistration)
                        && error.reason == WorktreeRemovalErrorReason::GitFailed =>
                {
                    ("failed", Some(error.message))
                }
                Err(error) => return Err(encode(error)),
            };
            let result = persist_detach(
                services,
                input.command_id,
                input.project_id.clone(),
                input.thread_id.clone(),
                resolved.path.clone(),
                payload_digest,
                git_outcome,
                detail,
                orphan_cleanup_pending,
                command_claim.clone(),
                ownership.clone(),
                &terminal_cancellation,
            )
            .await?;
            quiesce.commit_detached();
            registry
                .clear_recovered(&input.thread_id, &resolved.path)
                .await
                .map_err(encode)?;
            drop(guard);
            if matches!(git_outcome, "removed" | "cleaned") {
                services
                    .catalog
                    .invalidate_repository_after_mutation(&input.project_id)
                    .await;
            } else {
                services
                    .catalog
                    .invalidate_after_mutation(&input.project_id)
                    .await;
            }
            drop(cleanup_lifecycle);
            Ok(encode(result))
        })
        .await
        .unwrap_or_else(|| {
            Err(encode(removal_orchestration_error(
                OrchestrationError::Cancelled,
            )))
        })
}

async fn resolve_removal_thread(
    services: &WorktreeCatalogRpcServices,
    project_id: &str,
    thread_id: &str,
) -> Result<ResolvedRemovalThread, Value> {
    let repositories = services.orchestration.repositories();
    let project = repositories
        .get_project(project_id.to_owned())
        .await
        .map_err(|_| encode(removal_internal()))?
        .filter(|project| project.deleted_at.is_none())
        .ok_or_else(|| encode(removal_not_found()))?;
    let thread = repositories
        .get_thread(thread_id.to_owned())
        .await
        .map_err(|_| encode(removal_internal()))?
        .filter(|thread| {
            thread.project_id == project_id
                && thread.kind == "workspace"
                && thread.deleted_at.is_none()
        })
        .ok_or_else(|| encode(removal_not_found()))?;
    let persisted_path = thread
        .worktree_path
        .filter(|path| !path.trim().is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| encode(removal_not_found()))?;
    let path_key = canonical_worktree_path_key(&persisted_path)
        .await
        .map_err(|_| encode(removal_internal()))?;
    let path = PathBuf::from(&path_key);
    let project_threads = repositories
        .list_threads_by_project(project_id.to_owned())
        .await
        .map_err(|_| encode(removal_internal()))?;
    let mut owner_ids = Vec::new();
    for candidate in &project_threads {
        if candidate.kind != "workspace" || candidate.deleted_at.is_some() {
            continue;
        }
        let Some(candidate_path) = candidate.worktree_path.as_deref() else {
            continue;
        };
        let candidate_key = canonical_worktree_path_key(Path::new(candidate_path))
            .await
            .map_err(|_| encode(removal_internal()))?;
        if candidate_key == path_key {
            owner_ids.push(candidate.thread_id.as_str());
        }
    }
    if owner_ids.len() != 1 || owner_ids[0] != thread_id {
        return Err(encode(removal_error(
            WorktreeRemovalErrorReason::OwnershipConflict,
            "Multiple workspace threads claim the removal target.",
            None,
        )));
    }
    let project_root_key = canonical_worktree_path_key(Path::new(&project.workspace_root))
        .await
        .map_err(|_| encode(removal_internal()))?;
    let mut known_thread_ids = Vec::new();
    for candidate in project_threads
        .into_iter()
        .filter(|candidate| candidate.deleted_at.is_none())
    {
        let candidate_key = match candidate.worktree_path.as_deref() {
            Some(candidate_path) => canonical_worktree_path_key(Path::new(candidate_path))
                .await
                .map_err(|_| encode(removal_internal()))?,
            None => project_root_key.clone(),
        };
        if candidate_key == path_key {
            known_thread_ids.push(candidate.thread_id);
        }
    }
    known_thread_ids.push(thread_id.to_owned());
    known_thread_ids.sort();
    known_thread_ids.dedup();
    Ok(ResolvedRemovalThread {
        path,
        known_thread_ids,
    })
}

async fn resolve_removal_thread_with_ownership(
    services: &WorktreeCatalogRpcServices,
    project_id: &str,
    thread_id: &str,
) -> Result<(WorkspaceOwnershipLease, ResolvedRemovalThread), Value> {
    // The first read discovers a server-owned normalized key. The second read is the
    // authoritative ownership preflight and remains protected through Git and detach.
    let candidate = resolve_removal_thread(services, project_id, thread_id).await?;
    let ownership = services
        .orchestration
        .acquire_workspace_removal_ownership(&candidate.path)
        .await
        .map_err(|error| encode(removal_orchestration_error(error)))?;
    let resolved = resolve_removal_thread(services, project_id, thread_id).await?;
    if candidate.path != resolved.path {
        return Err(encode(removal_error(
            WorktreeRemovalErrorReason::OwnershipConflict,
            "Workspace ownership changed during removal preflight.",
            None,
        )));
    }
    Ok((ownership, resolved))
}

async fn build_removal_plan(
    services: &WorktreeCatalogRpcServices,
    project_id: &str,
    thread_id: &str,
    expected_generation: Option<u64>,
    refresh: bool,
    cancellation: &CancellationToken,
) -> Result<ResolvedRemovalPlan, Value> {
    let resolved = resolve_removal_thread(services, project_id, thread_id).await?;
    let path = resolved.path;
    let snapshot = if refresh {
        services
            .catalog
            .refresh(project_id, CatalogRefreshTrigger::Explicit)
            .await
    } else {
        services.catalog.latest(project_id).await.ok_or_else(|| {
            CatalogError::new(CatalogErrorReason::StaleGeneration, "Removal plan expired.")
        })
    }
    .map_err(|error| encode(removal_catalog_error(error, expected_generation)))?;
    if !snapshot.authoritative {
        return Err(encode(removal_error(
            WorktreeRemovalErrorReason::RepositoryMismatch,
            "The repository cannot be verified for removal.",
            Some(snapshot.generation),
        )));
    }
    if expected_generation.is_some_and(|expected| expected != snapshot.generation) {
        return Err(encode(removal_error(
            WorktreeRemovalErrorReason::StaleGeneration,
            "The confirmed catalog generation is no longer current.",
            Some(snapshot.generation),
        )));
    }
    let trusted_anchor = services
        .catalog
        .resolve_trusted_repository_anchor(project_id, &path, cancellation)
        .await
        .map_err(|error| encode(removal_catalog_error(error, Some(snapshot.generation))))?;
    if trusted_anchor.repository_key != snapshot.repository_key {
        return Err(encode(removal_error(
            WorktreeRemovalErrorReason::RepositoryMismatch,
            "The catalog removal anchor no longer matches the confirmed repository.",
            Some(snapshot.generation),
        )));
    }
    let anchor = trusted_anchor.path;
    let repository = services.removal_git.clone().ok_or_else(|| {
        encode(removal_error(
            WorktreeRemovalErrorReason::EnvironmentUnsupported,
            "Native Git removal is unavailable in this environment.",
            Some(snapshot.generation),
        ))
    })?;
    let inventory = repository
        .inventory(anchor.clone(), cancellation.clone())
        .await
        .map_err(|_| encode(removal_git_failed(Some(snapshot.generation))))?;
    let common_dir = tokio::fs::canonicalize(&inventory.common_dir)
        .await
        .map_err(|_| encode(removal_git_failed(Some(snapshot.generation))))?;
    let observed_repository_key = worktree_repository_key(&common_dir, host_path_platform())
        .as_str()
        .to_owned();
    if observed_repository_key != snapshot.repository_key {
        return Err(encode(removal_error(
            WorktreeRemovalErrorReason::RepositoryMismatch,
            "The project repository identity changed during removal planning.",
            Some(snapshot.generation),
        )));
    }
    let path_key = canonical_worktree_path_key(&path)
        .await
        .map_err(|_| encode(removal_git_failed(Some(snapshot.generation))))?;
    let mut record = None;
    for candidate in &inventory.records {
        let candidate_key = canonical_worktree_path_key(&candidate.path)
            .await
            .map_err(|_| encode(removal_git_failed(Some(snapshot.generation))))?;
        if candidate_key == path_key {
            record = Some(candidate.clone());
            break;
        }
    }
    if record
        .as_ref()
        .is_some_and(|record| record.is_primary || record.is_bare)
    {
        return Err(encode(removal_error(
            WorktreeRemovalErrorReason::ProtectedTarget,
            "Primary and bare worktrees cannot be removed.",
            Some(snapshot.generation),
        )));
    }
    let directory_present = match tokio::fs::symlink_metadata(&path).await {
        Ok(_) => true,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(_) => {
            return Err(encode(removal_git_failed(Some(snapshot.generation))));
        }
    };
    if record.is_none() && directory_present {
        return Err(encode(removal_error(
            WorktreeRemovalErrorReason::ReplacementConflict,
            "An unregistered replacement exists at the workspace location.",
            Some(snapshot.generation),
        )));
    }
    let availability = match (&record, directory_present) {
        (Some(_), true) => "present",
        (Some(_), false) => "missing-registered",
        (None, false) => "missing-unregistered",
        (None, true) => unreachable!("replacement conflict returned above"),
    };
    let inspection = if availability == "present" {
        repository
            .inspect(
                anchor.clone(),
                record.as_ref().expect("present record").clone(),
                cancellation.clone(),
            )
            .await
            .map_err(|_| encode(removal_git_failed(Some(snapshot.generation))))?
    } else {
        Default::default()
    };
    let prune_impact = if record.as_ref().is_some_and(|record| record.is_prunable) {
        repository
            .preview_prune(anchor.clone(), cancellation.clone())
            .await
            .map_err(|_| encode(removal_git_failed(Some(snapshot.generation))))?
    } else {
        Vec::new()
    };
    let locked = record.as_ref().is_some_and(|record| record.locked);
    let lock_reason = record
        .as_ref()
        .and_then(|record| record.lock_reason.clone());
    let public_impact = prune_impact
        .iter()
        .map(|impact| WorktreePruneImpact {
            path: normalize_worktree_path_key(&impact.path, host_path_platform()),
            prune_reason: impact.prune_reason.clone(),
            locked: impact.locked,
            lock_reason: impact.lock_reason.clone(),
        })
        .collect::<Vec<_>>();
    let mut wire = WorktreeRemovalPlan {
        plan_token: String::new(),
        generation: snapshot.generation,
        availability,
        registered: record.is_some(),
        locked,
        lock_reason,
        tracked_change_count: inspection.tracked_change_count,
        untracked_file_count: inspection.untracked_file_count,
        prune_impact: public_impact,
    };
    wire.plan_token = removal_plan_token(
        project_id,
        thread_id,
        &anchor,
        &snapshot.repository_key,
        record
            .as_ref()
            .map_or_else(
                || format!("missing:{path_key}"),
                |record| {
                    worktree_key(&common_dir, &record.path, host_path_platform())
                        .as_str()
                        .to_owned()
                },
            )
            .as_str(),
        &wire,
    );
    Ok(ResolvedRemovalPlan {
        wire,
        anchor,
        repository_key: snapshot.repository_key.clone(),
        record,
        prune_impact,
    })
}

async fn apply_git_removal(
    services: &WorktreeCatalogRpcServices,
    input: &WorktreeRemoveInput,
    plan: &ResolvedRemovalPlan,
    cancellation: &CancellationToken,
) -> Result<(&'static str, Option<String>), WorktreeRemovalError> {
    let repository = services.removal_git.clone().ok_or_else(removal_internal)?;
    match input.mode {
        WorktreeRemovalMode::DeleteGitWorktree => {
            if plan.wire.availability != "present" {
                return Err(removal_error(
                    WorktreeRemovalErrorReason::StalePlan,
                    "The worktree is no longer present.",
                    Some(plan.wire.generation),
                ));
            }
            if plan.wire.locked {
                return Err(removal_error(
                    WorktreeRemovalErrorReason::Locked,
                    "The Git worktree registration is locked.",
                    Some(plan.wire.generation),
                ));
            }
            if !input.force_dirty
                && (plan.wire.tracked_change_count != 0 || plan.wire.untracked_file_count != 0)
            {
                return Err(removal_error(
                    WorktreeRemovalErrorReason::DirtyConfirmationRequired,
                    "Dirty worktree deletion requires explicit confirmation.",
                    Some(plan.wire.generation),
                ));
            }
            repository
                .remove(
                    plan.anchor.clone(),
                    plan.record.as_ref().expect("present record").clone(),
                    input.force_dirty,
                    cancellation.clone(),
                )
                .await
                .map_err(|_| removal_git_failed(Some(plan.wire.generation)))?;
            Ok(("removed", None))
        }
        WorktreeRemovalMode::CleanupStaleRegistration => {
            if plan.wire.availability == "present" {
                return Err(removal_error(
                    WorktreeRemovalErrorReason::ProtectedTarget,
                    "A present worktree cannot be treated as stale registration cleanup.",
                    Some(plan.wire.generation),
                ));
            }
            let Some(record) = plan.record.as_ref() else {
                return Ok(("cleaned", None));
            };
            if record.locked {
                return Err(removal_error(
                    WorktreeRemovalErrorReason::Locked,
                    "The stale Git worktree registration is locked.",
                    Some(plan.wire.generation),
                ));
            }
            if repository
                .remove(
                    plan.anchor.clone(),
                    record.clone(),
                    false,
                    cancellation.clone(),
                )
                .await
                .is_ok()
            {
                return Ok(("cleaned", None));
            }
            if plan.prune_impact.is_empty() {
                return Err(removal_git_failed(Some(plan.wire.generation)));
            }
            if !input.confirm_repository_wide_prune {
                return Err(removal_error(
                    WorktreeRemovalErrorReason::PruneConfirmationRequired,
                    "Repository-wide prune impact requires explicit confirmation.",
                    Some(plan.wire.generation),
                ));
            }
            repository
                .prune(
                    plan.anchor.clone(),
                    record.clone(),
                    git_worktree_prune_impact_digest(&plan.prune_impact),
                    cancellation.clone(),
                )
                .await
                .map_err(|_| removal_git_failed(Some(plan.wire.generation)))?;
            Ok(("cleaned", None))
        }
    }
}

fn validate_git_removal_preflight(
    input: &WorktreeRemoveInput,
    plan: &ResolvedRemovalPlan,
    resumed_git_success: bool,
) -> Result<(), WorktreeRemovalError> {
    match input.mode {
        WorktreeRemovalMode::DeleteGitWorktree => {
            if plan.wire.availability != "present" && !resumed_git_success {
                return Err(removal_error(
                    WorktreeRemovalErrorReason::StalePlan,
                    "The worktree is no longer present.",
                    Some(plan.wire.generation),
                ));
            }
            if plan.wire.locked {
                return Err(removal_error(
                    WorktreeRemovalErrorReason::Locked,
                    "The Git worktree registration is locked.",
                    Some(plan.wire.generation),
                ));
            }
            if !input.force_dirty
                && (plan.wire.tracked_change_count != 0 || plan.wire.untracked_file_count != 0)
            {
                return Err(removal_error(
                    WorktreeRemovalErrorReason::DirtyConfirmationRequired,
                    "Dirty worktree deletion requires explicit confirmation.",
                    Some(plan.wire.generation),
                ));
            }
        }
        WorktreeRemovalMode::CleanupStaleRegistration => {
            if plan.wire.availability == "present" {
                return Err(removal_error(
                    WorktreeRemovalErrorReason::ProtectedTarget,
                    "A present worktree cannot be treated as stale registration cleanup.",
                    Some(plan.wire.generation),
                ));
            }
            if plan.wire.locked {
                return Err(removal_error(
                    WorktreeRemovalErrorReason::Locked,
                    "The stale Git worktree registration is locked.",
                    Some(plan.wire.generation),
                ));
            }
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn persist_detach(
    services: &WorktreeCatalogRpcServices,
    command_id: String,
    project_id: String,
    thread_id: String,
    path: PathBuf,
    payload_digest: String,
    git_outcome: &str,
    detail: Option<String>,
    orphan_cleanup_pending: bool,
    command_claim: CommandAdmissionClaim,
    ownership: WorkspaceOwnershipLease,
    cancellation: &CancellationToken,
) -> Result<WorktreeRemovalResult, Value> {
    services
        .orchestration
        .dispatch_with_admission_ownership_and_command_claim_until_handoff(
            OrchestrationCommand::WorktreeDetachResolved {
                command_id,
                project_id,
                thread_id,
                path: path.to_string_lossy().into_owned(),
                git_outcome: git_outcome.to_owned(),
                detail: detail.clone(),
                orphan_cleanup_pending,
            },
            CommandAdmission {
                payload_digest,
                attachment_refs: Vec::new(),
                provider_turn: None,
            },
            command_claim,
            ownership,
            cancellation,
        )
        .await
        .map_err(|error| encode(removal_orchestration_error(error)))?;
    Ok(WorktreeRemovalResult {
        thread_removed: true,
        git_outcome: git_outcome.to_owned(),
        detail,
        orphan_cleanup_pending,
    })
}

async fn replay_removal(
    services: &WorktreeCatalogRpcServices,
    command_claim: &CommandAdmissionClaim,
    command_id: &str,
    payload_digest: &str,
) -> Result<Option<WorktreeRemovalResult>, Value> {
    services
        .orchestration
        .replay_admitted_worktree_removal(command_claim, command_id, payload_digest)
        .await
        .map(|result| {
            result.map(|result| WorktreeRemovalResult {
                thread_removed: result.thread_removed,
                git_outcome: result.git_outcome,
                detail: result.detail,
                orphan_cleanup_pending: result.orphan_cleanup_pending,
            })
        })
        .map_err(|error| encode(removal_orchestration_error(error)))
}

async fn admit_removal_cleanup(
    services: &WorktreeCatalogRpcServices,
) -> Result<WorktreeRemovalCleanupAdmission, Value> {
    services
        .removal_quiescer
        .admit_cleanup()
        .await
        .map_err(|error| match error {
            WorktreeRemovalCleanupAdmissionError::Capacity => encode(removal_error(
                WorktreeRemovalErrorReason::CleanupCapacity,
                "Workspace cleanup capacity is busy; retry the removal.",
                None,
            )),
        })
}

async fn reserve_removal(
    services: &WorktreeCatalogRpcServices,
    command_claim: &CommandAdmissionClaim,
    input: &impl RemovalAdmissionInput,
    payload_digest: &str,
) -> Result<RemovalAdmissionReservation, Value> {
    services
        .orchestration
        .reserve_worktree_removal_admission(
            command_claim,
            input.command_id(),
            input.project_id(),
            payload_digest,
        )
        .await
        .map(|(result, prepared_retry)| RemovalAdmissionReservation {
            result: result.map(|result| WorktreeRemovalResult {
                thread_removed: result.thread_removed,
                git_outcome: result.git_outcome,
                detail: result.detail,
                orphan_cleanup_pending: result.orphan_cleanup_pending,
            }),
            prepared_retry,
        })
        .map_err(|error| encode(removal_orchestration_error(error)))
}

struct RemovalAdmissionReservation {
    result: Option<WorktreeRemovalResult>,
    prepared_retry: bool,
}

trait RemovalAdmissionInput {
    fn command_id(&self) -> &str;
    fn project_id(&self) -> &str;
}

impl RemovalAdmissionInput for WorktreeRemoveFromBibCodeInput {
    fn command_id(&self) -> &str {
        &self.command_id
    }

    fn project_id(&self) -> &str {
        &self.project_id
    }
}

impl RemovalAdmissionInput for WorktreeRemoveInput {
    fn command_id(&self) -> &str {
        &self.command_id
    }

    fn project_id(&self) -> &str {
        &self.project_id
    }
}

fn removal_payload_digest(input: &impl Serialize) -> Result<String, Value> {
    canonical_command_digest(input).map_err(|_| encode(removal_internal()))
}

fn removal_plan_token(
    project_id: &str,
    thread_id: &str,
    anchor: &Path,
    repository_key: &str,
    path_key: &str,
    plan: &WorktreeRemovalPlan,
) -> String {
    let mut fields = vec![
        project_id.to_owned(),
        thread_id.to_owned(),
        normalize_worktree_path_key(anchor, host_path_platform()),
        repository_key.to_owned(),
        path_key.to_owned(),
        plan.generation.to_string(),
        plan.availability.to_owned(),
        plan.registered.to_string(),
        plan.locked.to_string(),
        plan.lock_reason.clone().unwrap_or_default(),
        plan.tracked_change_count.to_string(),
        plan.untracked_file_count.to_string(),
    ];
    let mut impact = plan.prune_impact.clone();
    impact.sort_by(|left, right| {
        left.path
            .cmp(&right.path)
            .then_with(|| left.prune_reason.cmp(&right.prune_reason))
    });
    for entry in impact {
        fields.push(entry.path);
        fields.push(entry.prune_reason);
    }
    let mut input = b"bibcode.worktree.removal-plan.v1".to_vec();
    input.extend_from_slice(&(fields.len() as u64).to_be_bytes());
    for field in fields {
        input.extend_from_slice(&(field.len() as u64).to_be_bytes());
        input.extend_from_slice(field.as_bytes());
    }
    sha256_hex(input)
}

fn removal_error(
    reason: WorktreeRemovalErrorReason,
    message: impl Into<String>,
    current_generation: Option<u64>,
) -> WorktreeRemovalError {
    WorktreeRemovalError {
        tag: "WorktreeRemovalError",
        reason,
        message: crate::worktree_catalog::bounded_message(message.into()),
        current_generation,
    }
}

fn removal_not_found() -> WorktreeRemovalError {
    removal_error(
        WorktreeRemovalErrorReason::ThreadNotFound,
        "The workspace thread was not found.",
        None,
    )
}

fn removal_internal() -> WorktreeRemovalError {
    removal_error(
        WorktreeRemovalErrorReason::Internal,
        "The removal request could not be completed.",
        None,
    )
}

fn removal_git_failed(current_generation: Option<u64>) -> WorktreeRemovalError {
    removal_error(
        WorktreeRemovalErrorReason::GitFailed,
        "Git could not verify the requested worktree mutation.",
        current_generation,
    )
}

fn removal_catalog_error(
    error: CatalogError,
    current_generation: Option<u64>,
) -> WorktreeRemovalError {
    let reason = match error.reason {
        CatalogErrorReason::ProjectNotFound => WorktreeRemovalErrorReason::ThreadNotFound,
        CatalogErrorReason::EnvironmentUnsupported => {
            WorktreeRemovalErrorReason::EnvironmentUnsupported
        }
        CatalogErrorReason::StaleGeneration => WorktreeRemovalErrorReason::StaleGeneration,
        CatalogErrorReason::CommandConflict => WorktreeRemovalErrorReason::CommandConflict,
        CatalogErrorReason::RepositoryUnavailable => WorktreeRemovalErrorReason::RepositoryMismatch,
        CatalogErrorReason::PolicyUpdateFailed | CatalogErrorReason::Internal => {
            WorktreeRemovalErrorReason::Internal
        }
    };
    removal_error(reason, error.message, current_generation)
}

fn removal_orchestration_error(error: OrchestrationError) -> WorktreeRemovalError {
    match error {
        OrchestrationError::CommandConflict { .. } => removal_error(
            WorktreeRemovalErrorReason::CommandConflict,
            "The command ID was already used with a different removal payload.",
            None,
        ),
        OrchestrationError::WorktreeOwnershipConflict { .. }
        | OrchestrationError::WorkspaceOwnershipChanged { .. } => removal_error(
            WorktreeRemovalErrorReason::OwnershipConflict,
            "Workspace ownership conflicts with removal.",
            None,
        ),
        OrchestrationError::Invariant { .. } => removal_internal(),
        error => removal_error(
            WorktreeRemovalErrorReason::OrchestrationFailed,
            format!("Workspace removal could not be persisted: {error}"),
            None,
        ),
    }
}

fn catalog_stream(
    services: WorktreeCatalogRpcServices,
    request: RpcRequest,
    cancellation: CancellationToken,
) -> watch::Receiver<Option<RpcStreamChunk>> {
    let (sender, receiver) = watch::channel(None);
    tokio::spawn(async move {
        let input = match decode::<WorktreeCatalogInput>(request) {
            Ok(input) => input,
            Err(error) => {
                sender.send_replace(Some(Err(error)));
                return;
            }
        };
        let subscription = tokio::select! {
            _ = cancellation.cancelled() => return,
            result = services.catalog.subscribe(&input.project_id) => result,
        };
        let mut subscription = match subscription {
            Ok(subscription) => subscription,
            Err(error) => {
                sender.send_replace(Some(Err(encode(error))));
                return;
            }
        };
        if cancellation.is_cancelled() {
            return;
        }
        sender.send_replace(Some(Ok(vec![encode(
            subscription.initial_latest().as_ref(),
        )])));
        loop {
            tokio::select! {
                _ = cancellation.cancelled() => return,
                snapshot = subscription.changed() => {
                    let Some(snapshot) = snapshot else { return };
                    sender.send_replace(Some(Ok(vec![encode(snapshot.as_ref())])));
                }
            }
        }
    });
    receiver
}

async fn update_discovery_policy(
    services: &WorktreeCatalogRpcServices,
    request: RpcRequest,
    cancellation: CancellationToken,
) -> RpcResult {
    let input = decode::<WorktreeDiscoveryPolicyUpdateInput>(request)?;
    let payload_digest = canonical_command_digest(&input)
        .map_err(|error| encode(policy_error(format!("Policy admission failed: {error}"))))?;
    let command_claim =
        acquire_worktree_command_claim(&services.orchestration, &input.command_id, &cancellation)
            .await
            .map_err(|error| encode(policy_orchestration_error(error)))?;
    let existing_receipt = services
        .orchestration
        .get_command_receipt_with_claim_cancellation(
            &command_claim,
            &input.command_id,
            &cancellation,
        )
        .await
        .map_err(|error| encode(policy_orchestration_error(error)))?;
    let project_id = input.project_id.clone();
    let services = services.clone();
    let mutation_cancellation = cancellation.clone();
    let operation_runtime = services.operations.clone();
    operation_runtime
        .run(async move {
            let operation_cancellation = mutation_cancellation.clone();
            let catalog = services.catalog.clone();
            catalog
                .with_project_mutation_lock_cancellation(
                    &project_id,
                    &mutation_cancellation,
                    || async {
                        update_discovery_policy_locked(
                            &services,
                            input,
                            payload_digest,
                            command_claim,
                            existing_receipt,
                            operation_cancellation,
                        )
                        .await
                    },
                )
                .await
                .unwrap_or_else(|| {
                    Err(encode(policy_orchestration_error(
                        OrchestrationError::Cancelled,
                    )))
                })
        })
        .await
}

async fn update_discovery_policy_locked(
    services: &WorktreeCatalogRpcServices,
    input: WorktreeDiscoveryPolicyUpdateInput,
    payload_digest: String,
    command_claim: CommandAdmissionClaim,
    existing_receipt: Option<CommandReceipt>,
    cancellation: CancellationToken,
) -> RpcResult {
    let project = services
        .orchestration
        .repositories()
        .get_project(input.project_id.clone())
        .await
        .map_err(|error| encode(policy_error(error.to_string())))?
        .filter(|project| project.deleted_at.is_none())
        .ok_or_else(project_not_found)?;
    let mut policy =
        serde_json::from_value::<ProjectWorktreeDiscoveryPolicy>(project.worktree_discovery)
            .map_err(|error| {
                encode(policy_error(format!(
                    "Persisted discovery policy is invalid: {error}"
                )))
            })?;

    if let Some(visibility) = input.visibility {
        policy.visibility = visibility;
    }
    if let Some(dismiss) = input.dismiss_initial_prompt {
        policy.initial_prompt_dismissed_at = dismiss.then(now_iso);
    }
    if let Some(expected_generation) = input.acknowledge_generation {
        let snapshot = services
            .catalog
            .latest(&input.project_id)
            .await
            .ok_or_else(|| encode(stale_generation(expected_generation, None)))?;
        if !snapshot.authoritative || snapshot.generation != expected_generation {
            return Err(encode(stale_generation(
                expected_generation,
                Some(snapshot.generation),
            )));
        }
        policy.baseline_paths = compact_eligible_baseline(&snapshot)?;
    }

    let policy_value = serde_json::to_value(&policy).map_err(|error| {
        encode(policy_error(format!(
            "Discovery policy could not be serialized: {error}"
        )))
    })?;
    let legacy_receipt = existing_receipt
        .as_ref()
        .is_some_and(|receipt| receipt.payload_digest.is_none());
    if let Some(receipt) = existing_receipt.as_ref()
        && receipt.payload_digest.is_none()
        && receipt.status == "accepted"
    {
        services
            .orchestration
            .verify_legacy_worktree_policy_replay(
                &command_claim,
                receipt,
                &input.command_id,
                &input.project_id,
                &policy_value,
            )
            .await
            .map_err(|error| encode(policy_orchestration_error(error)))?;
        return Ok(policy_value);
    }
    let command = OrchestrationCommand::ProjectMetaUpdate {
        command_id: input.command_id,
        project_id: input.project_id,
        title: None,
        workspace_root: None,
        default_model_selection: OptionalNullable::Missing,
        scripts: None,
        worktree_discovery: Some(policy_value.clone()),
    };
    if legacy_receipt {
        services
            .orchestration
            .dispatch_with_command_claim_until_handoff(command, command_claim, &cancellation)
            .await
    } else {
        services
            .orchestration
            .dispatch_with_admission_and_command_claim_until_handoff(
                command,
                CommandAdmission {
                    payload_digest,
                    attachment_refs: Vec::new(),
                    provider_turn: None,
                },
                command_claim,
                &cancellation,
            )
            .await
    }
    .map_err(|error| encode(policy_orchestration_error(error)))?;
    Ok(policy_value)
}

pub fn compact_eligible_baseline(snapshot: &WorktreeCatalogSnapshot) -> Result<Vec<String>, Value> {
    if !snapshot.authoritative {
        return Err(encode(CatalogError::new(
            CatalogErrorReason::StaleGeneration,
            "Discovery candidates can only be acknowledged from an authoritative catalog generation.",
        )));
    }
    let mut seen = HashSet::new();
    Ok(snapshot
        .worktrees
        .iter()
        .filter(|worktree| worktree.eligible_for_adoption)
        .filter(|worktree| seen.insert(worktree.path.clone()))
        .map(|worktree| worktree.path.clone())
        .take(MAX_BASELINE_PATHS)
        .collect())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorktreeCatalogInput {
    project_id: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorktreeAdoptInput {
    command_id: String,
    project_id: String,
    worktree_key: String,
    expected_generation: u64,
    thread_defaults: WorktreeAdoptThreadDefaults,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorktreeAdoptThreadDefaults {
    model_selection: Value,
    runtime_mode: String,
    interaction_mode: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorktreeCreateManagedInput {
    command_id: String,
    project_id: String,
    thread_id: String,
    title: String,
    ref_name: String,
    new_ref_name: Option<String>,
    base_ref_name: Option<String>,
    thread_defaults: WorktreeAdoptThreadDefaults,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorktreeCreatePanelInput {
    command_id: String,
    host_thread_id: String,
    thread_id: String,
    title: String,
    thread_defaults: WorktreeAdoptThreadDefaults,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorktreeRetargetInput {
    command_id: String,
    project_id: String,
    thread_id: String,
    worktree_key: String,
    expected_generation: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorktreeThreadResult {
    thread_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorktreeManagedCreateResult {
    thread_id: String,
    path: String,
    ref_name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorktreeAdoptResult {
    thread_id: String,
    disposition: String,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
enum WorktreeAdoptionErrorReason {
    ProjectNotFound,
    EnvironmentUnsupported,
    WorktreeNotFound,
    StaleGeneration,
    Ineligible,
    WorkspaceMissing,
    RepositoryMismatch,
    OwnershipConflict,
    CommandConflict,
    OrchestrationFailed,
    Internal,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorktreeAdoptionError {
    #[serde(rename = "_tag")]
    tag: &'static str,
    reason: WorktreeAdoptionErrorReason,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    current_generation: Option<u64>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorktreeDiscoveryPolicyUpdateInput {
    command_id: String,
    project_id: String,
    visibility: Option<WorktreeDiscoveryVisibility>,
    acknowledge_generation: Option<u64>,
    dismiss_initial_prompt: Option<bool>,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum WorktreeDiscoveryVisibility {
    Hidden,
    Shown,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectWorktreeDiscoveryPolicy {
    #[serde(default = "hidden_visibility")]
    visibility: WorktreeDiscoveryVisibility,
    #[serde(default)]
    initial_prompt_dismissed_at: Option<String>,
    #[serde(default)]
    baseline_paths: Vec<String>,
}

fn hidden_visibility() -> WorktreeDiscoveryVisibility {
    WorktreeDiscoveryVisibility::Hidden
}

fn decode<T: for<'de> Deserialize<'de>>(request: RpcRequest) -> Result<T, Value> {
    serde_json::from_value(request.payload).map_err(|error| {
        json!({
            "_tag": "RpcRequestInvalid",
            "method": request.tag,
            "detail": error.to_string(),
        })
    })
}

fn encode(value: impl Serialize) -> Value {
    serde_json::to_value(value).unwrap_or_else(|error| {
        json!({
            "_tag": "WorktreeCatalogError",
            "reason": "internal",
            "message": error.to_string(),
        })
    })
}

fn project_not_found() -> Value {
    encode(CatalogError::new(
        CatalogErrorReason::ProjectNotFound,
        "Project was not found.",
    ))
}

fn policy_error(message: String) -> CatalogError {
    CatalogError::new(CatalogErrorReason::PolicyUpdateFailed, message)
}

fn policy_orchestration_error(error: OrchestrationError) -> CatalogError {
    match error {
        OrchestrationError::CommandConflict { .. } => CatalogError::new(
            CatalogErrorReason::CommandConflict,
            "The command ID was already used by another worktree mutation.",
        ),
        error => policy_error(error.to_string()),
    }
}

fn adoption_error(
    reason: WorktreeAdoptionErrorReason,
    message: impl Into<String>,
    current_generation: Option<u64>,
) -> WorktreeAdoptionError {
    WorktreeAdoptionError {
        tag: "WorktreeAdoptionError",
        reason,
        message: crate::worktree_catalog::bounded_message(message.into()),
        current_generation,
    }
}

fn adoption_catalog_error(
    error: CatalogError,
    current_generation: Option<u64>,
) -> WorktreeAdoptionError {
    let reason = match error.reason {
        CatalogErrorReason::ProjectNotFound => WorktreeAdoptionErrorReason::ProjectNotFound,
        CatalogErrorReason::EnvironmentUnsupported => {
            WorktreeAdoptionErrorReason::EnvironmentUnsupported
        }
        CatalogErrorReason::StaleGeneration => WorktreeAdoptionErrorReason::StaleGeneration,
        CatalogErrorReason::RepositoryUnavailable
        | CatalogErrorReason::CommandConflict
        | CatalogErrorReason::PolicyUpdateFailed
        | CatalogErrorReason::Internal => WorktreeAdoptionErrorReason::Internal,
    };
    adoption_error(reason, error.message, current_generation)
}

fn adoption_validation_error(error: AdoptionValidationError) -> WorktreeAdoptionError {
    let reason = match error.reason {
        AdoptionValidationErrorReason::WorktreeNotFound => {
            WorktreeAdoptionErrorReason::WorktreeNotFound
        }
        AdoptionValidationErrorReason::Ineligible => WorktreeAdoptionErrorReason::Ineligible,
        AdoptionValidationErrorReason::WorkspaceMissing => {
            WorktreeAdoptionErrorReason::WorkspaceMissing
        }
        AdoptionValidationErrorReason::RepositoryMismatch => {
            WorktreeAdoptionErrorReason::RepositoryMismatch
        }
        AdoptionValidationErrorReason::CatalogUnavailable => WorktreeAdoptionErrorReason::Internal,
    };
    adoption_error(reason, error.message, error.current_generation)
}

fn adoption_orchestration_error(
    error: OrchestrationError,
    current_generation: Option<u64>,
) -> WorktreeAdoptionError {
    match error {
        OrchestrationError::CommandConflict { .. } => adoption_error(
            WorktreeAdoptionErrorReason::CommandConflict,
            "The command ID was already used with a different adoption payload.",
            current_generation,
        ),
        OrchestrationError::WorktreeOwnershipConflict { .. } => adoption_error(
            WorktreeAdoptionErrorReason::OwnershipConflict,
            "Worktree adoption conflicts with canonical workspace ownership.",
            current_generation,
        ),
        OrchestrationError::Invariant { .. } => adoption_error(
            WorktreeAdoptionErrorReason::Internal,
            "The durable worktree adoption result is invalid.",
            current_generation,
        ),
        error => adoption_error(
            WorktreeAdoptionErrorReason::OrchestrationFailed,
            format!("Worktree adoption could not be persisted: {error}"),
            current_generation,
        ),
    }
}

fn adoption_dispatch_result(
    result: crate::orchestration::engine::DispatchResult,
    current_generation: Option<u64>,
) -> RpcResult {
    let thread_id = result.thread_id.ok_or_else(|| {
        encode(adoption_error(
            WorktreeAdoptionErrorReason::Internal,
            "Worktree adoption completed without a thread result.",
            current_generation,
        ))
    })?;
    let disposition = result.disposition.ok_or_else(|| {
        encode(adoption_error(
            WorktreeAdoptionErrorReason::Internal,
            "Worktree adoption completed without a disposition.",
            current_generation,
        ))
    })?;
    Ok(encode(WorktreeAdoptResult {
        thread_id,
        disposition,
    }))
}

fn stale_generation(expected: u64, current: Option<u64>) -> CatalogError {
    let current = current.map_or_else(|| "unavailable".to_owned(), |value| value.to_string());
    CatalogError::new(
        CatalogErrorReason::StaleGeneration,
        format!(
            "Catalog generation {expected} is no longer authoritative; current generation is {current}."
        ),
    )
}

fn now_iso() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| OffsetDateTime::now_utc().unix_timestamp().to_string())
}

#[cfg(test)]
mod operation_runtime_tests {
    use std::sync::Arc;

    use serde_json::json;
    use tokio::sync::{Notify, Semaphore};

    use super::WorktreeCatalogOperationRuntime;

    const EXPECTED_MAX_IN_FLIGHT_WORKTREE_OPERATIONS: usize = 64;

    #[tokio::test]
    async fn post_handoff_operations_retain_finite_admission_after_waiters_disconnect() {
        let runtime = WorktreeCatalogOperationRuntime::new();
        let entered = Arc::new(Semaphore::new(0));
        let completed = Arc::new(Semaphore::new(0));
        let release = Arc::new(Semaphore::new(0));
        let mut callers = Vec::new();

        for _ in 0..EXPECTED_MAX_IN_FLIGHT_WORKTREE_OPERATIONS {
            let runtime = runtime.clone();
            let entered = entered.clone();
            let completed = completed.clone();
            let release = release.clone();
            callers.push(tokio::spawn(async move {
                runtime
                    .run(async move {
                        entered.add_permits(1);
                        let _permit = release.acquire().await.expect("release remains open");
                        completed.add_permits(1);
                        Ok(json!({ "completed": true }))
                    })
                    .await
            }));
        }

        entered
            .acquire_many(EXPECTED_MAX_IN_FLIGHT_WORKTREE_OPERATIONS as u32)
            .await
            .expect("every admitted operation enters")
            .forget();
        for caller in callers {
            caller.abort();
        }

        let saturated = runtime
            .run(async { Ok(json!({ "mustNotRun": true })) })
            .await
            .expect_err("a full runtime rejects without adding an unbounded waiter");
        assert_eq!(saturated["_tag"], "WorktreeOperationError");
        assert_eq!(saturated["reason"], "operation-capacity");

        release.add_permits(EXPECTED_MAX_IN_FLIGHT_WORKTREE_OPERATIONS);
        completed
            .acquire_many(EXPECTED_MAX_IN_FLIGHT_WORKTREE_OPERATIONS as u32)
            .await
            .expect("every admitted operation completes")
            .forget();
        assert_eq!(
            runtime
                .run(async { Ok(json!({ "admittedAfterCompletion": true })) })
                .await
                .expect("completion releases the owned operation permit"),
            json!({ "admittedAfterCompletion": true })
        );
        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn shutdown_closes_admission_and_drains_the_owned_operation_permit() {
        let runtime = WorktreeCatalogOperationRuntime::new();
        let entered = Arc::new(Notify::new());
        let release = Arc::new(Semaphore::new(0));
        let operation_runtime = runtime.clone();
        let operation_entered = entered.clone();
        let operation_release = release.clone();
        let waiter = tokio::spawn(async move {
            operation_runtime
                .run(async move {
                    operation_entered.notify_one();
                    let _permit = operation_release
                        .acquire()
                        .await
                        .expect("release remains open");
                    Ok(json!({ "completed": true }))
                })
                .await
        });
        entered.notified().await;

        let shutdown_runtime = runtime.clone();
        let shutdown = tokio::spawn(async move { shutdown_runtime.shutdown().await });
        tokio::task::yield_now().await;
        assert!(
            !shutdown.is_finished(),
            "shutdown drains admitted operation owners"
        );

        release.add_permits(1);
        assert_eq!(
            waiter
                .await
                .expect("waiter joins")
                .expect("operation succeeds"),
            json!({ "completed": true })
        );
        shutdown.await.expect("shutdown joins");

        let closed = runtime
            .run(async { Ok(json!({ "mustNotRun": true })) })
            .await
            .expect_err("shutdown rejects new operation ownership");
        assert_eq!(closed["_tag"], "WorktreeOperationError");
        assert_eq!(closed["reason"], "operation-shutting-down");
    }
}
