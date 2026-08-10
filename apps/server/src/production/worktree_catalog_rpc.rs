use std::{collections::HashSet, path::Path};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::{
    orchestration::{OrchestrationCommand, OrchestrationEngine, engine::OptionalNullable},
    persistence::Repositories,
    rpc::{RpcRegistry, RpcRequest, RpcResult, RpcStreamChunk},
    worktree_catalog::{
        CatalogError, CatalogErrorReason, CatalogRefreshTrigger, WorktreeCatalogService,
        WorktreeCatalogSnapshot,
    },
};

use super::git_vcs::{CatalogMutationFuture, CatalogMutationObserver};

const STREAM_CAPACITY: usize = 8;
const MAX_BASELINE_PATHS: usize = 512;

#[derive(Clone)]
pub struct WorktreeCatalogRpcServices {
    catalog: WorktreeCatalogService,
    orchestration: OrchestrationEngine,
}

impl WorktreeCatalogRpcServices {
    #[must_use]
    pub fn new(catalog: WorktreeCatalogService, orchestration: OrchestrationEngine) -> Self {
        Self {
            catalog,
            orchestration,
        }
    }
}

#[derive(Clone)]
pub struct WorktreeCatalogMutationObserver {
    catalog: WorktreeCatalogService,
    repositories: Repositories,
}

impl WorktreeCatalogMutationObserver {
    #[must_use]
    pub fn new(catalog: WorktreeCatalogService, repositories: Repositories) -> Self {
        Self {
            catalog,
            repositories,
        }
    }

    async fn project_id_for_cwd(&self, cwd: &Path) -> Result<Option<String>, String> {
        let cwd = cwd.to_string_lossy();
        self.repositories
            .list_projects()
            .await
            .map_err(|error| error.to_string())
            .map(|projects| {
                projects
                    .into_iter()
                    .find(|project| {
                        project.deleted_at.is_none() && project.workspace_root == cwd.as_ref()
                    })
                    .map(|project| project.project_id)
            })
    }
}

impl CatalogMutationObserver for WorktreeCatalogMutationObserver {
    fn note_managed_creation<'a>(
        &'a self,
        cwd: &'a Path,
        path: &'a Path,
    ) -> CatalogMutationFuture<'a> {
        Box::pin(async move {
            let Some(project_id) = self.project_id_for_cwd(cwd).await? else {
                return Ok(());
            };
            self.catalog.note_managed_creation(&project_id, path).await;
            self.catalog.invalidate_after_mutation(&project_id).await;
            Ok(())
        })
    }

    fn invalidate_after_removal<'a>(
        &'a self,
        cwd: &'a Path,
        _path: &'a Path,
    ) -> CatalogMutationFuture<'a> {
        Box::pin(async move {
            let Some(project_id) = self.project_id_for_cwd(cwd).await? else {
                return Ok(());
            };
            self.catalog.invalidate_after_mutation(&project_id).await;
            Ok(())
        })
    }
}

pub fn register_worktree_catalog_rpc(
    registry: &mut RpcRegistry,
    services: WorktreeCatalogRpcServices,
) {
    let stream_services = services.clone();
    registry.register_stream("subscribeWorktreeCatalog", move |request, cancellation| {
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

    registry.register_unary(
        "worktree.updateDiscoveryPolicy",
        move |request, _cancellation| {
            let services = services.clone();
            async move { update_discovery_policy(&services, request).await }
        },
    );
}

fn catalog_stream(
    services: WorktreeCatalogRpcServices,
    request: RpcRequest,
    cancellation: CancellationToken,
) -> mpsc::Receiver<RpcStreamChunk> {
    let (sender, receiver) = mpsc::channel(STREAM_CAPACITY);
    tokio::spawn(async move {
        let input = match decode::<WorktreeCatalogInput>(request) {
            Ok(input) => input,
            Err(error) => {
                let _ = sender.send(Err(error)).await;
                return;
            }
        };
        let mut subscription = match services.catalog.subscribe(&input.project_id).await {
            Ok(subscription) => subscription,
            Err(error) => {
                let _ = sender.send(Err(encode(error))).await;
                return;
            }
        };
        if sender
            .send(Ok(vec![encode(subscription.latest().as_ref())]))
            .await
            .is_err()
        {
            return;
        }
        loop {
            tokio::select! {
                _ = cancellation.cancelled() => return,
                snapshot = subscription.changed() => {
                    let Some(snapshot) = snapshot else { return };
                    if sender.send(Ok(vec![encode(snapshot.as_ref())])).await.is_err() {
                        return;
                    }
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
