pub mod protocol;

pub(crate) mod client;

#[cfg(unix)]
pub mod unix;

#[cfg(windows)]
pub mod windows;

use std::{sync::Arc, time::Duration};

use thiserror::Error;
use tokio::{
    io::{AsyncRead, AsyncWrite},
    task::JoinHandle,
};
use tokio_util::sync::CancellationToken;

use crate::{
    ServerConfig,
    auth::{AuthService, build_pairing_url},
    maintenance::{RpcAdmissionGate, UpdateMaintenance},
    package_lifecycle::{PurgePlan, PurgePlanSnapshot, PurgePlanStore, inspect_purge_counts},
    persistence::Database,
    persistence::{EnvironmentId, StatePaths, StorageInstanceId},
    production::runtime::ProductionRuntime,
};

use self::protocol::{
    ControlRequestBody, ControlResponse, ControlResponseBody, read_request, write_response,
};

#[derive(Debug, Error)]
pub enum LocalControlError {
    #[error("failed to prepare the local control endpoint: {0}")]
    Prepare(String),
    #[error("the local control listener failed: {0}")]
    Serve(String),
    #[error("the local control task was cancelled unexpectedly")]
    Join(#[source] tokio::task::JoinError),
    #[error("the local control task was already joined")]
    AlreadyJoined,
}

#[derive(Clone)]
pub(crate) struct ControlDispatcher {
    environment_id: EnvironmentId,
    storage_instance_id: StorageInstanceId,
    server_version: String,
    environment_name: String,
    bind: std::net::SocketAddr,
    web_assets_verified: bool,
    data_root: std::path::PathBuf,
    database: Database,
    production_runtime: Option<Arc<ProductionRuntime>>,
    auth: AuthService,
    advertised_base_url: url::Url,
    update_maintenance: Option<Arc<UpdateMaintenance>>,
    admission_gate: RpcAdmissionGate,
    service_stop_drain_timeout: Duration,
    main_shutdown: CancellationToken,
}

pub(crate) struct LocalControlHandle {
    shutdown: CancellationToken,
    task: Option<JoinHandle<Result<(), LocalControlError>>>,
}

pub(crate) struct LocalControlContext {
    pub environment_id: EnvironmentId,
    pub storage_instance_id: StorageInstanceId,
    pub environment_name: String,
    pub bind: std::net::SocketAddr,
    pub web_assets_verified: bool,
    pub data_root: std::path::PathBuf,
    pub database: Database,
    pub production_runtime: Option<Arc<ProductionRuntime>>,
    pub auth: AuthService,
    pub advertised_base_url: String,
    pub update_maintenance: Option<Arc<UpdateMaintenance>>,
    pub admission_gate: RpcAdmissionGate,
    pub main_shutdown: CancellationToken,
}

pub(crate) async fn start(
    config: &ServerConfig,
    _paths: &StatePaths,
    context: LocalControlContext,
) -> Result<LocalControlHandle, LocalControlError> {
    let advertised_base_url = url::Url::parse(&context.advertised_base_url)
        .map_err(|error| LocalControlError::Prepare(error.to_string()))?;
    let dispatcher = ControlDispatcher {
        environment_id: context.environment_id,
        storage_instance_id: context.storage_instance_id,
        server_version: config.server_version.clone(),
        environment_name: context.environment_name,
        bind: context.bind,
        web_assets_verified: context.web_assets_verified,
        data_root: context.data_root,
        database: context.database,
        production_runtime: context.production_runtime,
        auth: context.auth,
        advertised_base_url,
        update_maintenance: context.update_maintenance,
        admission_gate: context.admission_gate,
        service_stop_drain_timeout: config.service_stop_drain_timeout,
        main_shutdown: context.main_shutdown.clone(),
    };
    let shutdown = CancellationToken::new();

    #[cfg(unix)]
    let endpoint = unix::UnixControlEndpoint::bind(_paths, config.managed_service_mode.is_some())
        .map_err(|error| LocalControlError::Prepare(error.to_string()))?;

    #[cfg(windows)]
    let endpoint = windows::WindowsControlEndpoint::bind(context.environment_id)
        .map_err(|error| LocalControlError::Prepare(error.to_string()))?;

    #[cfg(not(any(unix, windows)))]
    compile_error!("the BiBCode local control channel requires Unix or Windows");

    let task_shutdown = shutdown.clone();
    let task_main_shutdown = context.main_shutdown;
    let task = tokio::spawn(async move {
        let result = endpoint
            .serve(dispatcher, task_shutdown, task_main_shutdown.clone())
            .await;
        if result.is_err() {
            task_main_shutdown.cancel();
        }
        result
    });
    Ok(LocalControlHandle {
        shutdown,
        task: Some(task),
    })
}

impl LocalControlHandle {
    pub(crate) fn shutdown(&self) {
        self.shutdown.cancel();
    }

    pub(crate) async fn join(&mut self) -> Result<(), LocalControlError> {
        let task = self.task.take().ok_or(LocalControlError::AlreadyJoined)?;
        match task.await {
            Ok(result) => result,
            Err(error) => Err(LocalControlError::Join(error)),
        }
    }
}

impl Drop for LocalControlHandle {
    fn drop(&mut self) {
        self.shutdown.cancel();
        if let Some(task) = &self.task {
            task.abort();
        }
    }
}

pub(super) async fn serve_stream<S>(
    mut stream: S,
    dispatcher: ControlDispatcher,
    local_shutdown: CancellationToken,
    main_shutdown: CancellationToken,
) where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let request = tokio::select! {
        biased;
        () = local_shutdown.cancelled() => return,
        () = main_shutdown.cancelled() => return,
        result = read_request(&mut stream) => result,
    };
    let (response, stop_after_response) = match request {
        Ok(request) => dispatcher.dispatch(request).await,
        Err(error) => (error.response(), false),
    };
    let _ = write_response(&mut stream, &response).await;
    if stop_after_response {
        dispatcher.main_shutdown.cancel();
    }
}

impl ControlDispatcher {
    async fn dispatch(&self, request: protocol::ControlRequest) -> (ControlResponse, bool) {
        let request_id = request.request_id;
        let body = match request.body {
            ControlRequestBody::Status => ControlResponseBody::Status {
                environment_id: self.environment_id,
                storage_instance_id: self.storage_instance_id,
                server_version: self.server_version.clone(),
                environment_name: self.environment_name.clone(),
                bind: self.bind.to_string(),
                web_assets_verified: self.web_assets_verified,
            },
            ControlRequestBody::CreatePairing { client_label } => {
                match self
                    .auth
                    .issue_environment_administrator_pairing(client_label)
                    .await
                {
                    Ok(pairing) => {
                        let pairing_url =
                            build_pairing_url(&self.advertised_base_url, &pairing.credential);
                        ControlResponseBody::PairingCreated {
                            environment_id: self.environment_id,
                            credential: pairing.credential,
                            expires_at: pairing.expires_at,
                            pairing_url,
                        }
                    }
                    Err(_) => safe_error(
                        "pairing_creation_failed",
                        "The pairing credential could not be created safely.",
                    ),
                }
            }
            ControlRequestBody::ServicePrepareUpdate { target_version } => {
                let Some(maintenance) = &self.update_maintenance else {
                    return (
                        response(
                            request_id,
                            safe_error(
                                "command_unavailable",
                                "Service update preparation is not available for this runtime.",
                            ),
                        ),
                        false,
                    );
                };
                match maintenance.prepare(target_version).await {
                    Ok(prepared) => ControlResponseBody::UpdatePrepared {
                        operation_id: prepared.operation_id,
                        environment_id: prepared.environment_id,
                        storage_instance_id: prepared.storage_instance_id,
                        current_version: prepared.current_version,
                        backup_id: prepared.backup_id,
                        backup_schema_version: prepared.backup_schema_version,
                        drained_operations: prepared.drained_operations,
                        expires_at: prepared.expires_at,
                    },
                    Err(_) => safe_error(
                        "update_preparation_failed",
                        "The service could not prepare safely for update.",
                    ),
                }
            }
            ControlRequestBody::ServiceCommitUpdate { operation_id } => {
                let Some(maintenance) = &self.update_maintenance else {
                    return (
                        response(
                            request_id,
                            safe_error(
                                "command_unavailable",
                                "Service update commit is not available for this runtime.",
                            ),
                        ),
                        false,
                    );
                };
                let Ok(operation_id) = uuid::Uuid::parse_str(&operation_id) else {
                    return (
                        response(
                            request_id,
                            safe_error(
                                "invalid_operation",
                                "The update operation identifier is invalid.",
                            ),
                        ),
                        false,
                    );
                };
                match maintenance.commit(operation_id).await {
                    Ok(()) => {
                        maintenance.shutdown_after_response();
                        return (
                            response(request_id, ControlResponseBody::UpdateCommitted),
                            false,
                        );
                    }
                    Err(_) => safe_error(
                        "update_commit_failed",
                        "The prepared update could not be committed safely.",
                    ),
                }
            }
            ControlRequestBody::StoragePlanPurge { environment_name } => {
                let Some(runtime) = &self.production_runtime else {
                    return (
                        response(
                            request_id,
                            safe_error(
                                "command_unavailable",
                                "Storage purge planning is not available for this runtime.",
                            ),
                        ),
                        false,
                    );
                };
                let counts = match inspect_purge_counts(
                    &self.database,
                    time::OffsetDateTime::now_utc(),
                )
                .await
                {
                    Ok(counts) => counts,
                    Err(_) => {
                        return (
                            response(
                                request_id,
                                safe_error(
                                    "purge_plan_failed",
                                    "The online storage inventory could not be inspected safely.",
                                ),
                            ),
                            false,
                        );
                    }
                };
                let Ok(process_count) = u64::try_from(runtime.active_owned_process_count()) else {
                    return (
                        response(
                            request_id,
                            safe_error(
                                "purge_plan_failed",
                                "The owned-process inventory exceeded the supported bound.",
                            ),
                        ),
                        false,
                    );
                };
                let plan = match PurgePlan::new(PurgePlanSnapshot {
                    environment_id: self.environment_id,
                    storage_instance_id: self.storage_instance_id,
                    environment_name,
                    data_root: self.data_root.clone(),
                    project_count: counts.project_count,
                    worktree_count: counts.worktree_count,
                    process_count,
                    other_paired_client_count: counts.other_paired_client_count,
                    now: time::OffsetDateTime::now_utc(),
                    lifetime: time::Duration::minutes(5),
                }) {
                    Ok(plan) => plan,
                    Err(_) => {
                        return (
                            response(
                                request_id,
                                safe_error(
                                    "invalid_purge_plan",
                                    "The requested environment name or data root is invalid.",
                                ),
                            ),
                            false,
                        );
                    }
                };
                let store = PurgePlanStore::new(&self.data_root);
                match store.persist_plan(&plan).await {
                    Ok(()) => ControlResponseBody::PurgePlanned { plan },
                    Err(_) => safe_error(
                        "purge_plan_failed",
                        "The purge plan could not be persisted safely.",
                    ),
                }
            }
            ControlRequestBody::StorageAuthorizePurge {
                operation_id,
                typed_environment_name,
            } => {
                let Some(runtime) = &self.production_runtime else {
                    return (
                        response(
                            request_id,
                            safe_error(
                                "command_unavailable",
                                "Storage purge authorization is not available for this runtime.",
                            ),
                        ),
                        false,
                    );
                };
                let Ok(plan_id) = uuid::Uuid::parse_str(&operation_id) else {
                    return (
                        response(
                            request_id,
                            safe_error(
                                "invalid_operation",
                                "The purge plan identifier is invalid.",
                            ),
                        ),
                        false,
                    );
                };
                let store = PurgePlanStore::new(&self.data_root);
                let plan = match store.load_plan().await {
                    Ok(Some(plan)) => plan,
                    _ => {
                        return (
                            response(
                                request_id,
                                safe_error(
                                    "purge_plan_stale",
                                    "A fresh online purge plan is required.",
                                ),
                            ),
                            false,
                        );
                    }
                };
                if plan
                    .authorize(
                        plan_id,
                        &typed_environment_name,
                        &self.data_root,
                        time::OffsetDateTime::now_utc(),
                    )
                    .is_err()
                {
                    return (
                        response(
                            request_id,
                            safe_error(
                                "purge_confirmation_failed",
                                "Purge confirmation did not match the fresh plan or removal guards remain.",
                            ),
                        ),
                        false,
                    );
                }
                let deadline = tokio::time::Instant::now() + self.service_stop_drain_timeout;
                if self.admission_gate.close_and_drain(deadline).await.is_err() {
                    return (
                        response(
                            request_id,
                            safe_error(
                                "purge_drain_failed",
                                "The server could not drain active mutations before purge.",
                            ),
                        ),
                        false,
                    );
                }
                let fresh_counts =
                    inspect_purge_counts(&self.database, time::OffsetDateTime::now_utc()).await;
                let fresh_process_count = u64::try_from(runtime.active_owned_process_count());
                let inventory_matches = matches!(
                    (fresh_counts, fresh_process_count),
                    (Ok(counts), Ok(process_count))
                        if counts.project_count == plan.project_count
                            && counts.worktree_count == plan.worktree_count
                            && counts.other_paired_client_count == plan.other_paired_client_count
                            && process_count == plan.process_count
                );
                if !inventory_matches {
                    let _ = self.admission_gate.release();
                    return (
                        response(
                            request_id,
                            safe_error(
                                "purge_plan_stale",
                                "Host state changed; request a fresh online purge plan.",
                            ),
                        ),
                        false,
                    );
                }
                match store
                    .authorize(
                        plan_id,
                        &typed_environment_name,
                        time::OffsetDateTime::now_utc(),
                    )
                    .await
                {
                    Ok(authorization) => {
                        return (
                            response(
                                request_id,
                                ControlResponseBody::PurgeAuthorized { authorization },
                            ),
                            true,
                        );
                    }
                    Err(_) => {
                        let _ = self.admission_gate.release();
                        safe_error(
                            "purge_authorization_failed",
                            "The purge authorization could not be persisted safely.",
                        )
                    }
                }
            }
            ControlRequestBody::ServiceStop => {
                let deadline = tokio::time::Instant::now() + self.service_stop_drain_timeout;
                return match self.admission_gate.close_and_drain(deadline).await {
                    Ok(drained_operations) => (
                        response(
                            request_id,
                            ControlResponseBody::StopAccepted { drained_operations },
                        ),
                        true,
                    ),
                    Err(_) => (
                        response(
                            request_id,
                            safe_error(
                                "service_drain_failed",
                                "The service could not drain safely before the deadline.",
                            ),
                        ),
                        true,
                    ),
                };
            }
        };
        (response(request_id, body), false)
    }
}

fn response(request_id: uuid::Uuid, body: ControlResponseBody) -> ControlResponse {
    ControlResponse {
        version: protocol::CONTROL_PROTOCOL_VERSION,
        request_id,
        body,
    }
}

fn safe_error(code: &str, message: &str) -> ControlResponseBody {
    ControlResponseBody::Error {
        code: code.to_owned(),
        message: message.to_owned(),
    }
}

pub(super) const MAX_CONTROL_CONNECTIONS: usize = 16;
pub(super) const CONNECTION_DRAIN_TIMEOUT: Duration = Duration::from_secs(40);
