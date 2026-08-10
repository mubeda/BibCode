use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::Arc,
};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use crate::{
    crypto::sha256_hex,
    git::{GitRepository, HostPathPlatform, normalize_worktree_path_key, worktree_repository_key},
    orchestration::{
        OrchestrationCommand, OrchestrationEngine, OrchestrationError, engine::OptionalNullable,
    },
    persistence::Repositories,
    rpc::{RpcRegistry, RpcRequest, RpcResult, RpcStreamChunk},
    worktree_catalog::{
        AdoptionValidationError, AdoptionValidationErrorReason, CatalogError, CatalogErrorReason,
        CatalogFuture, CatalogHealthySnapshotObserver, CatalogRefreshTrigger,
        WorktreeAdoptionState, WorktreeCatalogService, WorktreeCatalogSnapshot,
        WorktreeDirectoryState, WorktreeRegistrationState,
    },
};

use super::git_vcs::{CatalogMutationFuture, CatalogMutationObserver};

const MAX_BASELINE_PATHS: usize = 512;

#[derive(Clone)]
pub struct WorktreeCatalogRpcServices {
    catalog: WorktreeCatalogService,
    orchestration: OrchestrationEngine,
}

impl WorktreeCatalogRpcServices {
    #[must_use]
    pub fn new(catalog: WorktreeCatalogService, orchestration: OrchestrationEngine) -> Self {
        catalog.set_healthy_snapshot_observer(Arc::new(BranchReconciliationObserver {
            orchestration: orchestration.clone(),
        }));
        Self {
            catalog,
            orchestration,
        }
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

#[derive(Clone)]
pub struct WorktreeCatalogMutationObserver {
    catalog: WorktreeCatalogService,
    repositories: Repositories,
    repository: Arc<GitRepository>,
}

impl WorktreeCatalogMutationObserver {
    #[must_use]
    pub fn new(
        catalog: WorktreeCatalogService,
        repositories: Repositories,
        repository: Arc<GitRepository>,
    ) -> Self {
        Self {
            catalog,
            repositories,
            repository,
        }
    }

    async fn project_ids_for_mutation(
        &self,
        cwd: &Path,
        target: &Path,
    ) -> Result<Vec<String>, String> {
        let cancellation = CancellationToken::new();
        let inventory = self
            .repository
            .worktree_inventory(cwd, &cancellation)
            .await
            .map_err(|error| error.to_string())?;
        let common_dir = tokio::fs::canonicalize(&inventory.common_dir)
            .await
            .map_err(|error| {
                format!(
                    "failed to canonicalize verified Git common directory {}: {error}",
                    inventory.common_dir.display()
                )
            })?;
        let repository_key = worktree_repository_key(&common_dir, host_platform())
            .as_str()
            .to_owned();
        let mut verified_paths = HashSet::new();
        for record in inventory.records {
            verified_paths.insert(normalized_existing_path(&record.path).await);
        }
        let mutation_paths = HashSet::from([
            normalized_existing_path(cwd).await,
            normalized_existing_path(target).await,
        ]);
        let projects = self
            .repositories
            .list_projects()
            .await
            .map_err(|error| error.to_string())?;
        let mut project_ids = Vec::new();
        for project in projects {
            if project.deleted_at.is_some() {
                continue;
            }
            match project.worktree_repository_key.as_deref() {
                Some(pinned) if pinned == repository_key => {
                    project_ids.push(project.project_id);
                    continue;
                }
                Some(_) => continue,
                None => {}
            }
            let Some(projection) = self
                .repositories
                .load_worktree_catalog_projection(project.project_id.clone(), 512)
                .await
                .map_err(|error| error.to_string())?
            else {
                continue;
            };
            if projection.truncated {
                return Err(format!(
                    "project '{}' has too many canonical worktree paths to associate safely",
                    project.project_id
                ));
            }
            let persisted_paths = std::iter::once(PathBuf::from(project.workspace_root))
                .chain(
                    projection
                        .threads
                        .into_iter()
                        .filter(|thread| thread.kind != "panel" && thread.deleted_at.is_none())
                        .filter_map(|thread| thread.worktree_path.map(PathBuf::from)),
                )
                .collect::<Vec<_>>();
            let mut associated = false;
            for path in persisted_paths {
                let path = normalized_existing_path(&path).await;
                if verified_paths.contains(&path) || mutation_paths.contains(&path) {
                    associated = true;
                    break;
                }
            }
            if associated {
                project_ids.push(project.project_id);
            }
        }
        project_ids.sort();
        project_ids.dedup();
        Ok(project_ids)
    }
}

impl CatalogMutationObserver for WorktreeCatalogMutationObserver {
    fn note_managed_creation<'a>(
        &'a self,
        cwd: &'a Path,
        path: &'a Path,
    ) -> CatalogMutationFuture<'a> {
        Box::pin(async move {
            for project_id in self.project_ids_for_mutation(cwd, path).await? {
                self.catalog.note_managed_creation(&project_id, path).await;
                self.catalog.invalidate_after_mutation(&project_id).await;
            }
            Ok(())
        })
    }

    fn invalidate_after_removal<'a>(
        &'a self,
        cwd: &'a Path,
        path: &'a Path,
    ) -> CatalogMutationFuture<'a> {
        Box::pin(async move {
            for project_id in self.project_ids_for_mutation(cwd, path).await? {
                self.catalog.invalidate_after_mutation(&project_id).await;
            }
            Ok(())
        })
    }
}

async fn normalized_existing_path(path: &Path) -> String {
    let canonical = tokio::fs::canonicalize(path)
        .await
        .unwrap_or_else(|_| path.to_path_buf());
    normalize_worktree_path_key(&canonical, host_platform())
}

fn host_platform() -> HostPathPlatform {
    if cfg!(windows) {
        HostPathPlatform::Windows
    } else {
        HostPathPlatform::Posix
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
    registry.register_unary("worktree.adopt", move |request, _cancellation| {
        let services = adoption_services.clone();
        async move { adopt_worktree(&services, request).await }
    });

    registry.register_unary(
        "worktree.updateDiscoveryPolicy",
        move |request, _cancellation| {
            let services = services.clone();
            async move { update_discovery_policy(&services, request).await }
        },
    );
}

async fn adopt_worktree(services: &WorktreeCatalogRpcServices, request: RpcRequest) -> RpcResult {
    let input = decode::<WorktreeAdoptInput>(request)?;
    let project_id = input.project_id.clone();
    services
        .catalog
        .with_project_mutation_lock(&project_id, || async {
            adopt_worktree_locked(services, input).await
        })
        .await
}

async fn adopt_worktree_locked(
    services: &WorktreeCatalogRpcServices,
    input: WorktreeAdoptInput,
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
        .dispatch(OrchestrationCommand::WorktreeAdoptResolved {
            command_id: input.command_id,
            project_id: input.project_id.clone(),
            worktree_key: resolved.worktree_key,
            path: resolved.path,
            branch: resolved.branch,
            head: resolved.head,
            model_selection: input.thread_defaults.model_selection,
            runtime_mode: input.thread_defaults.runtime_mode,
            interaction_mode: input.thread_defaults.interaction_mode,
        })
        .await
        .map_err(|error| {
            let reason = match &error {
                OrchestrationError::WorktreeOwnershipConflict { .. } => {
                    WorktreeAdoptionErrorReason::OwnershipConflict
                }
                _ => WorktreeAdoptionErrorReason::OrchestrationFailed,
            };
            encode(adoption_error(
                reason,
                format!("Worktree adoption could not be persisted: {error}"),
                Some(snapshot.generation),
            ))
        })?;
    let thread_id = result.thread_id.ok_or_else(|| {
        encode(adoption_error(
            WorktreeAdoptionErrorReason::Internal,
            "Worktree adoption completed without a thread result.",
            Some(snapshot.generation),
        ))
    })?;
    let disposition = result.disposition.ok_or_else(|| {
        encode(adoption_error(
            WorktreeAdoptionErrorReason::Internal,
            "Worktree adoption completed without a disposition.",
            Some(snapshot.generation),
        ))
    })?;
    services
        .catalog
        .invalidate_after_mutation(&input.project_id)
        .await;
    Ok(encode(WorktreeAdoptResult {
        thread_id,
        disposition,
    }))
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
) -> RpcResult {
    let input = decode::<WorktreeDiscoveryPolicyUpdateInput>(request)?;
    let project_id = input.project_id.clone();
    services
        .catalog
        .with_project_mutation_lock(&project_id, || async {
            update_discovery_policy_locked(services, input).await
        })
        .await
}

async fn update_discovery_policy_locked(
    services: &WorktreeCatalogRpcServices,
    input: WorktreeDiscoveryPolicyUpdateInput,
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
    services
        .orchestration
        .dispatch(OrchestrationCommand::ProjectMetaUpdate {
            command_id: input.command_id,
            project_id: input.project_id,
            title: None,
            workspace_root: None,
            default_model_selection: OptionalNullable::Missing,
            scripts: None,
            worktree_discovery: Some(policy_value.clone()),
        })
        .await
        .map_err(|error| encode(policy_error(error.to_string())))?;
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
#[serde(rename_all = "camelCase")]
struct WorktreeCatalogInput {
    project_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorktreeAdoptInput {
    command_id: String,
    project_id: String,
    worktree_key: String,
    expected_generation: u64,
    thread_defaults: WorktreeAdoptThreadDefaults,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorktreeAdoptThreadDefaults {
    model_selection: Value,
    runtime_mode: String,
    interaction_mode: String,
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
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
