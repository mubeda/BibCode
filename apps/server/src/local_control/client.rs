use std::{fmt, io};

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
}

pub(crate) struct CreatedPairing {
    pub environment_id: EnvironmentId,
    pub credential: String,
    pub expires_at: String,
    pub pairing_url: String,
    pub control_protocol_version: u16,
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
