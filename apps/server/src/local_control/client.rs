use std::{fmt, io, net::SocketAddr};

#[cfg(windows)]
use std::time::Duration;

use thiserror::Error;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

use crate::{
    ResolvedDataRoot, ServerConfig,
    persistence::{EnvironmentId, StatePaths},
};

use super::protocol::{
    CONTROL_PROTOCOL_VERSION, ControlRequest, ControlRequestBody, ControlResponseBody,
    ProtocolError, read_response, write_request,
};

#[derive(Debug, Error)]
pub(crate) enum ControlClientError {
    #[error("the selected data root does not contain a BiBCode environment")]
    EnvironmentMissing,
    #[error("the selected data root has an invalid BiBCode environment identity")]
    EnvironmentIdentityInvalid(#[source] io::Error),
    #[error("the BiBCode server is not running for the selected data root")]
    ServerNotRunning,
    #[error("the protected local control endpoint cannot be reached")]
    EndpointUnavailable(#[source] io::Error),
    #[error("the protected local control exchange failed")]
    Protocol(#[source] ProtocolError),
    #[error("the protected local control response did not match the request")]
    ResponseMismatch,
    #[error("the server rejected pairing creation")]
    PairingRejected,
    #[error("the protected local control response was not a valid pairing credential")]
    InvalidPairingResponse,
    #[error("the pairing credential reply has already expired")]
    PairingExpired,
    #[error("the server rejected the service drain request")]
    ServiceStopRejected,
    #[error("the protected local control response was not a valid service stop acknowledgement")]
    InvalidServiceStopResponse,
    #[error("the protected local control response was not a valid status document")]
    InvalidStatusResponse,
    #[error("the server rejected package update preparation")]
    UpdatePrepareRejected,
    #[error("the protected local control response was not a valid prepared update")]
    InvalidUpdatePrepareResponse,
    #[error("the server rejected the prepared package update commit")]
    UpdateCommitRejected,
    #[error("the protected local control response was not a valid update commit acknowledgement")]
    InvalidUpdateCommitResponse,
    #[error("the server rejected storage purge planning")]
    PurgePlanRejected,
    #[error("the protected local control response was not a valid purge plan")]
    InvalidPurgePlanResponse,
    #[error("the server rejected storage purge authorization")]
    PurgeAuthorizationRejected,
    #[error("the protected local control response was not a valid purge authorization")]
    InvalidPurgeAuthorizationResponse,
}

pub(crate) struct CreatedPairing {
    pub environment_id: EnvironmentId,
    pub credential: String,
    pub expires_at: String,
    pub pairing_url: String,
    pub control_protocol_version: u16,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ControlStatus {
    pub environment_id: EnvironmentId,
    pub storage_instance_id: crate::persistence::StorageInstanceId,
    pub server_version: String,
    pub environment_name: String,
    pub bind: SocketAddr,
    pub web_assets_verified: bool,
    pub control_protocol_version: u16,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct PreparedUpdate {
    pub operation_id: Uuid,
    pub environment_id: EnvironmentId,
    pub storage_instance_id: crate::persistence::StorageInstanceId,
    pub current_version: String,
    pub backup_id: Uuid,
    pub backup_schema_version: i64,
    pub drained_operations: u64,
    pub expires_at: String,
}

impl fmt::Debug for CreatedPairing {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CreatedPairing")
            .field("environment_id", &self.environment_id)
            .field("credential", &"[redacted]")
            .field("expires_at", &self.expires_at)
            .field("pairing_url", &"[redacted]")
            .field("control_protocol_version", &self.control_protocol_version)
            .finish()
    }
}

pub(crate) async fn create_pairing(
    root: &ResolvedDataRoot,
    client_label: Option<String>,
) -> Result<CreatedPairing, ControlClientError> {
    let paths = StatePaths::from_config(&ServerConfig::new(&root.effective));
    let environment_id = read_environment_id(&paths).await?;
    let request = ControlRequest {
        version: CONTROL_PROTOCOL_VERSION,
        request_id: Uuid::new_v4(),
        body: ControlRequestBody::CreatePairing { client_label },
    };
    let response = exchange(&paths, environment_id, &request).await?;
    if response.request_id != request.request_id {
        return Err(ControlClientError::ResponseMismatch);
    }
    let ControlResponseBody::PairingCreated {
        environment_id: response_environment_id,
        credential,
        expires_at,
        pairing_url,
    } = response.body
    else {
        return if matches!(response.body, ControlResponseBody::Error { .. }) {
            Err(ControlClientError::PairingRejected)
        } else {
            Err(ControlClientError::InvalidPairingResponse)
        };
    };
    if response_environment_id != environment_id || credential.is_empty() {
        return Err(ControlClientError::InvalidPairingResponse);
    }
    let expires = OffsetDateTime::parse(&expires_at, &Rfc3339)
        .map_err(|_| ControlClientError::InvalidPairingResponse)?;
    let now = OffsetDateTime::now_utc();
    if expires <= now {
        return Err(ControlClientError::PairingExpired);
    }
    if expires > now + time::Duration::minutes(5) + time::Duration::seconds(5) {
        return Err(ControlClientError::InvalidPairingResponse);
    }
    validate_pairing_url(&pairing_url, &credential)?;
    Ok(CreatedPairing {
        environment_id,
        credential,
        expires_at,
        pairing_url,
        control_protocol_version: response.version,
    })
}

pub(crate) async fn stop_service(root: &ResolvedDataRoot) -> Result<u64, ControlClientError> {
    let paths = StatePaths::from_config(&ServerConfig::new(&root.effective));
    let environment_id = read_environment_id(&paths).await?;
    let request = ControlRequest {
        version: CONTROL_PROTOCOL_VERSION,
        request_id: Uuid::new_v4(),
        body: ControlRequestBody::ServiceStop,
    };
    let response = exchange(&paths, environment_id, &request).await?;
    if response.request_id != request.request_id {
        return Err(ControlClientError::ResponseMismatch);
    }
    match response.body {
        ControlResponseBody::StopAccepted { drained_operations } => Ok(drained_operations),
        ControlResponseBody::Error { .. } => Err(ControlClientError::ServiceStopRejected),
        _ => Err(ControlClientError::InvalidServiceStopResponse),
    }
}

pub(crate) async fn status(root: &ResolvedDataRoot) -> Result<ControlStatus, ControlClientError> {
    let paths = StatePaths::from_config(&ServerConfig::new(&root.effective));
    let environment_id = read_environment_id(&paths).await?;
    let request = ControlRequest {
        version: CONTROL_PROTOCOL_VERSION,
        request_id: Uuid::new_v4(),
        body: ControlRequestBody::Status,
    };
    let response = exchange(&paths, environment_id, &request).await?;
    if response.request_id != request.request_id {
        return Err(ControlClientError::ResponseMismatch);
    }
    let response_version = response.version;
    let ControlResponseBody::Status {
        environment_id: response_environment_id,
        storage_instance_id,
        server_version,
        environment_name,
        bind,
        web_assets_verified,
    } = response.body
    else {
        return Err(ControlClientError::InvalidStatusResponse);
    };
    let bind = bind
        .parse::<SocketAddr>()
        .map_err(|_| ControlClientError::InvalidStatusResponse)?;
    if response_environment_id != environment_id
        || server_version.trim().is_empty()
        || environment_name.trim().is_empty()
        || !bind.ip().is_loopback()
    {
        return Err(ControlClientError::InvalidStatusResponse);
    }
    Ok(ControlStatus {
        environment_id,
        storage_instance_id,
        server_version,
        environment_name,
        bind,
        web_assets_verified,
        control_protocol_version: response_version,
    })
}

pub(crate) async fn prepare_update(
    root: &ResolvedDataRoot,
    target_version: String,
) -> Result<PreparedUpdate, ControlClientError> {
    let paths = StatePaths::from_config(&ServerConfig::new(&root.effective));
    let environment_id = read_environment_id(&paths).await?;
    let request = ControlRequest {
        version: CONTROL_PROTOCOL_VERSION,
        request_id: Uuid::new_v4(),
        body: ControlRequestBody::ServicePrepareUpdate {
            target_version: Some(target_version),
        },
    };
    let response = exchange(&paths, environment_id, &request).await?;
    if response.request_id != request.request_id {
        return Err(ControlClientError::ResponseMismatch);
    }
    let ControlResponseBody::UpdatePrepared {
        operation_id,
        environment_id: response_environment_id,
        storage_instance_id,
        current_version,
        backup_id,
        backup_schema_version,
        drained_operations,
        expires_at,
    } = response.body
    else {
        return if matches!(response.body, ControlResponseBody::Error { .. }) {
            Err(ControlClientError::UpdatePrepareRejected)
        } else {
            Err(ControlClientError::InvalidUpdatePrepareResponse)
        };
    };
    let operation_id = Uuid::parse_str(&operation_id)
        .map_err(|_| ControlClientError::InvalidUpdatePrepareResponse)?;
    let backup_id = Uuid::parse_str(&backup_id)
        .map_err(|_| ControlClientError::InvalidUpdatePrepareResponse)?;
    let expires = OffsetDateTime::parse(&expires_at, &Rfc3339)
        .map_err(|_| ControlClientError::InvalidUpdatePrepareResponse)?;
    if response_environment_id != environment_id
        || current_version.trim().is_empty()
        || backup_schema_version < 0
        || expires <= OffsetDateTime::now_utc()
    {
        return Err(ControlClientError::InvalidUpdatePrepareResponse);
    }
    Ok(PreparedUpdate {
        operation_id,
        environment_id,
        storage_instance_id,
        current_version,
        backup_id,
        backup_schema_version,
        drained_operations,
        expires_at,
    })
}

pub(crate) async fn commit_update(
    root: &ResolvedDataRoot,
    operation_id: Uuid,
) -> Result<(), ControlClientError> {
    let paths = StatePaths::from_config(&ServerConfig::new(&root.effective));
    let environment_id = read_environment_id(&paths).await?;
    let request = ControlRequest {
        version: CONTROL_PROTOCOL_VERSION,
        request_id: Uuid::new_v4(),
        body: ControlRequestBody::ServiceCommitUpdate {
            operation_id: operation_id.to_string(),
        },
    };
    let response = exchange(&paths, environment_id, &request).await?;
    if response.request_id != request.request_id {
        return Err(ControlClientError::ResponseMismatch);
    }
    match response.body {
        ControlResponseBody::UpdateCommitted => Ok(()),
        ControlResponseBody::Error { .. } => Err(ControlClientError::UpdateCommitRejected),
        _ => Err(ControlClientError::InvalidUpdateCommitResponse),
    }
}

pub(crate) async fn plan_purge(
    root: &ResolvedDataRoot,
    environment_name: String,
) -> Result<crate::package_lifecycle::PurgePlan, ControlClientError> {
    let paths = StatePaths::from_config(&ServerConfig::new(&root.effective));
    let environment_id = read_environment_id(&paths).await?;
    let request = ControlRequest {
        version: CONTROL_PROTOCOL_VERSION,
        request_id: Uuid::new_v4(),
        body: ControlRequestBody::StoragePlanPurge { environment_name },
    };
    let response = exchange(&paths, environment_id, &request).await?;
    if response.request_id != request.request_id {
        return Err(ControlClientError::ResponseMismatch);
    }
    let ControlResponseBody::PurgePlanned { plan } = response.body else {
        return if matches!(response.body, ControlResponseBody::Error { .. }) {
            Err(ControlClientError::PurgePlanRejected)
        } else {
            Err(ControlClientError::InvalidPurgePlanResponse)
        };
    };
    if plan.environment_id != environment_id || plan.data_root != root.effective {
        return Err(ControlClientError::InvalidPurgePlanResponse);
    }
    Ok(plan)
}

pub(crate) async fn authorize_purge(
    root: &ResolvedDataRoot,
    plan_id: Uuid,
    typed_environment_name: String,
) -> Result<crate::package_lifecycle::PurgeAuthorizationReceipt, ControlClientError> {
    let paths = StatePaths::from_config(&ServerConfig::new(&root.effective));
    let environment_id = read_environment_id(&paths).await?;
    let request = ControlRequest {
        version: CONTROL_PROTOCOL_VERSION,
        request_id: Uuid::new_v4(),
        body: ControlRequestBody::StorageAuthorizePurge {
            operation_id: plan_id.to_string(),
            typed_environment_name,
        },
    };
    let response = exchange(&paths, environment_id, &request).await?;
    if response.request_id != request.request_id {
        return Err(ControlClientError::ResponseMismatch);
    }
    let ControlResponseBody::PurgeAuthorized { authorization } = response.body else {
        return if matches!(response.body, ControlResponseBody::Error { .. }) {
            Err(ControlClientError::PurgeAuthorizationRejected)
        } else {
            Err(ControlClientError::InvalidPurgeAuthorizationResponse)
        };
    };
    if authorization.plan_id != plan_id
        || authorization.environment_id != environment_id
        || authorization.data_root != root.effective
    {
        return Err(ControlClientError::InvalidPurgeAuthorizationResponse);
    }
    Ok(authorization)
}

async fn read_environment_id(paths: &StatePaths) -> Result<EnvironmentId, ControlClientError> {
    let marker = match tokio::fs::read_to_string(&paths.environment_id).await {
        Ok(marker) => marker,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Err(ControlClientError::EnvironmentMissing);
        }
        Err(error) => return Err(ControlClientError::EnvironmentIdentityInvalid(error)),
    };
    let value = Uuid::parse_str(marker.trim()).map_err(|error| {
        ControlClientError::EnvironmentIdentityInvalid(io::Error::new(
            io::ErrorKind::InvalidData,
            error,
        ))
    })?;
    Ok(EnvironmentId::from_uuid(value))
}

fn validate_pairing_url(pairing_url: &str, credential: &str) -> Result<(), ControlClientError> {
    let pairing_url =
        url::Url::parse(pairing_url).map_err(|_| ControlClientError::InvalidPairingResponse)?;
    if pairing_url.query().is_some() {
        return Err(ControlClientError::InvalidPairingResponse);
    }
    if pairing_url.path() != "/pair" {
        return Err(ControlClientError::InvalidPairingResponse);
    }
    let fragment_credential = pairing_url.fragment().and_then(|fragment| {
        url::form_urlencoded::parse(fragment.as_bytes())
            .find_map(|(key, value)| (key == "token").then(|| value.into_owned()))
    });
    if fragment_credential.as_deref() != Some(credential) {
        return Err(ControlClientError::InvalidPairingResponse);
    }
    Ok(())
}

#[cfg(unix)]
async fn exchange(
    paths: &StatePaths,
    _environment_id: EnvironmentId,
    request: &ControlRequest,
) -> Result<super::protocol::ControlResponse, ControlClientError> {
    let endpoint_exists = match tokio::fs::symlink_metadata(&paths.control_socket).await {
        Ok(_) => true,
        Err(error) if error.kind() == io::ErrorKind::NotFound => false,
        Err(error) => return Err(ControlClientError::EndpointUnavailable(error)),
    };
    if !endpoint_exists {
        return Err(ControlClientError::ServerNotRunning);
    }
    let mut stream = tokio::net::UnixStream::connect(&paths.control_socket)
        .await
        .map_err(ControlClientError::EndpointUnavailable)?;
    write_request(&mut stream, request)
        .await
        .map_err(ControlClientError::Protocol)?;
    read_response(&mut stream)
        .await
        .map_err(ControlClientError::Protocol)
}

#[cfg(windows)]
async fn exchange(
    _paths: &StatePaths,
    environment_id: EnvironmentId,
    request: &ControlRequest,
) -> Result<super::protocol::ControlResponse, ControlClientError> {
    use tokio::net::windows::named_pipe::ClientOptions;
    use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_PIPE_BUSY};

    let name = super::windows::pipe_name(environment_id);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    let mut stream = loop {
        match ClientOptions::new().open(&name) {
            Ok(client) => break client,
            Err(error)
                if error.raw_os_error() == Some(ERROR_PIPE_BUSY as i32)
                    && tokio::time::Instant::now() < deadline =>
            {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            Err(error) if error.raw_os_error() == Some(ERROR_FILE_NOT_FOUND as i32) => {
                return Err(ControlClientError::ServerNotRunning);
            }
            Err(error) => return Err(ControlClientError::EndpointUnavailable(error)),
        }
    };
    write_request(&mut stream, request)
        .await
        .map_err(ControlClientError::Protocol)?;
    read_response(&mut stream)
        .await
        .map_err(ControlClientError::Protocol)
}
