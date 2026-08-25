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
    maintenance::UpdateMaintenance,
    persistence::{EnvironmentId, StatePaths, StorageInstanceId},
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
    auth: AuthService,
    advertised_base_url: url::Url,
    update_maintenance: Option<Arc<UpdateMaintenance>>,
    main_shutdown: CancellationToken,
}

pub(crate) struct LocalControlHandle {
    shutdown: CancellationToken,
    task: Option<JoinHandle<Result<(), LocalControlError>>>,
}

pub(crate) struct LocalControlContext {
    pub environment_id: EnvironmentId,
    pub storage_instance_id: StorageInstanceId,
    pub auth: AuthService,
    pub advertised_base_url: String,
    pub update_maintenance: Option<Arc<UpdateMaintenance>>,
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
        auth: context.auth,
        advertised_base_url,
        update_maintenance: context.update_maintenance,
        main_shutdown: context.main_shutdown.clone(),
    };
    let shutdown = CancellationToken::new();

    #[cfg(unix)]
    let endpoint = unix::UnixControlEndpoint::bind(_paths, config.managed_service_launch)
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
            ControlRequestBody::ServicePrepareUpdate => {
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
                match maintenance.prepare().await {
                    Ok(prepared) => ControlResponseBody::UpdatePrepared {
                        operation_id: prepared.operation_id,
                        backup_id: prepared.backup_id,
                        drained_operations: prepared.drained_operations,
                        expires_at: prepared.expires_at,
                    },
                    Err(_) => safe_error(
                        "update_preparation_failed",
                        "The service could not prepare safely for update.",
                    ),
                }
            }
            ControlRequestBody::ServiceStop => {
                return (
                    response(request_id, ControlResponseBody::StopAccepted),
                    true,
                );
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
