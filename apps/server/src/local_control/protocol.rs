use std::{fmt, io, time::Duration};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    time::timeout,
};
use uuid::Uuid;

use crate::package_lifecycle::{PurgeAuthorizationReceipt, PurgePlan};
use crate::persistence::{EnvironmentId, StorageInstanceId};

pub const CONTROL_PROTOCOL_VERSION: u16 = 1;
pub const MAX_CONTROL_FRAME_BYTES: usize = 64 * 1024;
const CONTROL_FRAME_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum ControlRequestBody {
    Status,
    CreatePairing {
        #[serde(skip_serializing_if = "Option::is_none")]
        client_label: Option<String>,
    },
    ServicePrepareUpdate {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        target_version: Option<String>,
    },
    ServiceCommitUpdate {
        operation_id: String,
    },
    StoragePlanPurge {
        environment_name: String,
    },
    StorageAuthorizePurge {
        operation_id: String,
        typed_environment_name: String,
    },
    ServiceStop,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlRequest {
    pub version: u16,
    #[serde(with = "uuid_string")]
    pub request_id: Uuid,
    pub body: ControlRequestBody,
}

#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlResponse {
    pub version: u16,
    #[serde(with = "uuid_string")]
    pub request_id: Uuid,
    pub body: ControlResponseBody,
}

impl fmt::Debug for ControlResponse {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ControlResponse")
            .field("version", &self.version)
            .field("request_id", &self.request_id)
            .field("body", &self.body)
            .finish()
    }
}

#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ControlResponseBody {
    Status {
        environment_id: EnvironmentId,
        storage_instance_id: StorageInstanceId,
        server_version: String,
        environment_name: String,
        bind: String,
        web_assets_verified: bool,
    },
    PairingCreated {
        environment_id: EnvironmentId,
        credential: String,
        expires_at: String,
        pairing_url: String,
    },
    UpdatePrepared {
        operation_id: String,
        environment_id: EnvironmentId,
        storage_instance_id: StorageInstanceId,
        current_version: String,
        backup_id: String,
        backup_schema_version: i64,
        drained_operations: u64,
        expires_at: String,
    },
    UpdateCommitted,
    PurgePlanned {
        plan: PurgePlan,
    },
    PurgeAuthorized {
        authorization: PurgeAuthorizationReceipt,
    },
    StopAccepted {
        #[serde(default)]
        drained_operations: u64,
    },
    Error {
        code: String,
        message: String,
    },
}

impl fmt::Debug for ControlResponseBody {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Status {
                environment_id,
                storage_instance_id,
                server_version,
                environment_name,
                bind,
                web_assets_verified,
            } => formatter
                .debug_struct("Status")
                .field("environment_id", environment_id)
                .field("storage_instance_id", storage_instance_id)
                .field("server_version", server_version)
                .field("environment_name", environment_name)
                .field("bind", bind)
                .field("web_assets_verified", web_assets_verified)
                .finish(),
            Self::PairingCreated {
                environment_id,
                credential: _,
                expires_at,
                pairing_url: _,
            } => formatter
                .debug_struct("PairingCreated")
                .field("environment_id", environment_id)
                .field("credential", &"[redacted]")
                .field("expires_at", expires_at)
                .field("pairing_url", &"[redacted]")
                .finish(),
            Self::UpdatePrepared {
                operation_id,
                environment_id,
                storage_instance_id,
                current_version,
                backup_id,
                backup_schema_version,
                drained_operations,
                expires_at,
            } => formatter
                .debug_struct("UpdatePrepared")
                .field("operation_id", operation_id)
                .field("environment_id", environment_id)
                .field("storage_instance_id", storage_instance_id)
                .field("current_version", current_version)
                .field("backup_id", backup_id)
                .field("backup_schema_version", backup_schema_version)
                .field("drained_operations", drained_operations)
                .field("expires_at", expires_at)
                .finish(),
            Self::UpdateCommitted => formatter.write_str("UpdateCommitted"),
            Self::PurgePlanned { plan } => formatter
                .debug_struct("PurgePlanned")
                .field("plan", plan)
                .finish(),
            Self::PurgeAuthorized { authorization } => formatter
                .debug_struct("PurgeAuthorized")
                .field("authorization", authorization)
                .finish(),
            Self::StopAccepted { drained_operations } => formatter
                .debug_struct("StopAccepted")
                .field("drained_operations", drained_operations)
                .finish(),
            Self::Error { code, message } => formatter
                .debug_struct("Error")
                .field("code", code)
                .field("message", message)
                .finish(),
        }
    }
}

#[derive(Clone, Debug, Error, Eq, PartialEq)]
#[error("{message}")]
pub struct ProtocolError {
    code: &'static str,
    message: &'static str,
    request_id: Option<Uuid>,
}

impl ProtocolError {
    #[must_use]
    pub const fn code(&self) -> &'static str {
        self.code
    }

    #[must_use]
    pub const fn safe_message(&self) -> &'static str {
        self.message
    }

    #[must_use]
    pub(crate) fn response(&self) -> ControlResponse {
        ControlResponse {
            version: CONTROL_PROTOCOL_VERSION,
            request_id: self.request_id.unwrap_or_else(Uuid::nil),
            body: ControlResponseBody::Error {
                code: self.code.to_owned(),
                message: self.message.to_owned(),
            },
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawControlRequest {
    version: u16,
    #[serde(with = "uuid_string")]
    request_id: Uuid,
    body: Value,
}

pub async fn read_request<R>(reader: &mut R) -> Result<ControlRequest, ProtocolError>
where
    R: AsyncRead + Unpin,
{
    let bytes = read_frame(reader).await?;
    decode_request(&bytes)
}

pub async fn write_request<W>(writer: &mut W, request: &ControlRequest) -> Result<(), ProtocolError>
where
    W: AsyncWrite + Unpin,
{
    write_json_frame(writer, request).await
}

pub async fn read_response<R>(reader: &mut R) -> Result<ControlResponse, ProtocolError>
where
    R: AsyncRead + Unpin,
{
    let bytes = read_frame(reader).await?;
    let response = serde_json::from_slice::<ControlResponse>(&bytes)
        .map_err(|_| protocol_error("invalid_response", "The control response is invalid."))?;
    if response.version != CONTROL_PROTOCOL_VERSION {
        return Err(protocol_error(
            "unsupported_protocol",
            "The control protocol version is not supported.",
        ));
    }
    Ok(response)
}

pub async fn write_response<W>(
    writer: &mut W,
    response: &ControlResponse,
) -> Result<(), ProtocolError>
where
    W: AsyncWrite + Unpin,
{
    write_json_frame(writer, response).await
}

fn decode_request(bytes: &[u8]) -> Result<ControlRequest, ProtocolError> {
    let raw = serde_json::from_slice::<RawControlRequest>(bytes)
        .map_err(|_| protocol_error("invalid_request", "The control request is invalid."))?;
    if raw.version != CONTROL_PROTOCOL_VERSION {
        return Err(ProtocolError {
            code: "unsupported_protocol",
            message: "The control protocol version is not supported.",
            request_id: Some(raw.request_id),
        });
    }

    let command = raw.body.get("type").and_then(Value::as_str);
    if command.is_none() {
        return Err(ProtocolError {
            code: "invalid_request",
            message: "The control request is invalid.",
            request_id: Some(raw.request_id),
        });
    }
    if !matches!(
        command,
        Some(
            "status"
                | "createPairing"
                | "servicePrepareUpdate"
                | "serviceCommitUpdate"
                | "storagePlanPurge"
                | "storageAuthorizePurge"
                | "serviceStop"
        )
    ) {
        return Err(ProtocolError {
            code: "unknown_command",
            message: "The control command is not supported.",
            request_id: Some(raw.request_id),
        });
    }

    let body = serde_json::from_value(raw.body).map_err(|_| ProtocolError {
        code: "invalid_request",
        message: "The control request is invalid.",
        request_id: Some(raw.request_id),
    })?;
    Ok(ControlRequest {
        version: raw.version,
        request_id: raw.request_id,
        body,
    })
}

async fn read_frame<R>(reader: &mut R) -> Result<Vec<u8>, ProtocolError>
where
    R: AsyncRead + Unpin,
{
    timeout(CONTROL_FRAME_TIMEOUT, read_frame_inner(reader))
        .await
        .map_err(|_| protocol_error("timeout", "The control request timed out."))?
}

async fn read_frame_inner<R>(reader: &mut R) -> Result<Vec<u8>, ProtocolError>
where
    R: AsyncRead + Unpin,
{
    let length = reader
        .read_u32()
        .await
        .map_err(|error| incomplete_frame(error.kind()))?;
    let length = usize::try_from(length)
        .map_err(|_| protocol_error("frame_too_large", "The control frame is too large."))?;
    if length == 0 {
        return Err(protocol_error(
            "invalid_request",
            "The control request is invalid.",
        ));
    }
    if length > MAX_CONTROL_FRAME_BYTES {
        return Err(protocol_error(
            "frame_too_large",
            "The control frame is too large.",
        ));
    }
    let mut bytes = vec![0_u8; length];
    reader
        .read_exact(&mut bytes)
        .await
        .map_err(|error| incomplete_frame(error.kind()))?;
    Ok(bytes)
}

async fn write_json_frame<W, T>(writer: &mut W, value: &T) -> Result<(), ProtocolError>
where
    W: AsyncWrite + Unpin,
    T: Serialize + ?Sized,
{
    let bytes = serde_json::to_vec(value).map_err(|_| {
        protocol_error(
            "encoding_failed",
            "The control message could not be encoded.",
        )
    })?;
    if bytes.len() > MAX_CONTROL_FRAME_BYTES {
        return Err(protocol_error(
            "frame_too_large",
            "The control frame is too large.",
        ));
    }
    let length = u32::try_from(bytes.len())
        .map_err(|_| protocol_error("frame_too_large", "The control frame is too large."))?;
    timeout(CONTROL_FRAME_TIMEOUT, async {
        writer.write_u32(length).await?;
        writer.write_all(&bytes).await?;
        writer.flush().await
    })
    .await
    .map_err(|_| protocol_error("timeout", "The control response timed out."))?
    .map_err(|_| protocol_error("write_failed", "The control response could not be written."))
}

fn incomplete_frame(_kind: io::ErrorKind) -> ProtocolError {
    protocol_error(
        "incomplete_frame",
        "The control frame ended before it was complete.",
    )
}

const fn protocol_error(code: &'static str, message: &'static str) -> ProtocolError {
    ProtocolError {
        code,
        message,
        request_id: None,
    }
}

mod uuid_string {
    use serde::{Deserialize, Deserializer, Serializer, de::Error as _};
    use uuid::Uuid;

    pub fn serialize<S>(value: &Uuid, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&value.to_string())
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<Uuid, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Uuid::parse_str(&value).map_err(D::Error::custom)
    }
}
