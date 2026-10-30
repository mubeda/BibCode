//! How `bibcode mcp` finds this server and proves it is talking to it (#139).
//!
//! The server writes [`ENDPOINT_RECORD_FILE`] (`server-runtime.json`, mode 0600) in its state
//! directory after it binds, as the runtime-guard owner, and removes it when it stops. The
//! record holds a per-boot `proofKey` that exists nowhere else but server memory. Before the
//! relay sends any credential, it posts a fresh nonce to `POST /mcp/endpoint-proof`, which
//! answers `HMAC-SHA256(proofKey, "bibcode-mcp-endpoint-v2" ‖ nonce ‖ local address ‖ port)`.
//! The address and port are the ones the connection reached, and the relay dials exactly the
//! record's `dialHost` and `port`. A listener that forwards the nonce to the real server from
//! another address or port, such as `[::1]:P` while BiBCode listens on `127.0.0.1:P`, gets a
//! proof that does not verify. The route is unauthenticated, accepts only this host's peers,
//! and reveals nothing secret: it signs a nonce the caller chose.

use std::{
    io::{self, Write as _},
    path::{Path, PathBuf},
    sync::Arc,
};

use axum::{
    body::to_bytes,
    extract::Request,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use hmac::{Hmac, KeyInit as _, Mac as _};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::Sha256;
use uuid::Uuid;

pub const ENDPOINT_RECORD_FILE: &str = "server-runtime.json";
pub const PROOF_PATH: &str = "/mcp/endpoint-proof";
/// The record version whose proof binds the listener's address; a relay refuses an older one.
pub const RECORD_VERSION: u32 = 2;
const PROOF_CONTEXT: &[u8] = b"bibcode-mcp-endpoint-v2";
const NONCE_BYTES: usize = 32;

/// A per-boot proof key.
pub type ProofKey = Arc<[u8; 32]>;

pub fn new_proof_key() -> io::Result<ProofKey> {
    let mut key = [0_u8; 32];
    getrandom::fill(&mut key).map_err(|error| io::Error::other(error.to_string()))?;
    Ok(Arc::new(key))
}

/// The proof for `nonce` on a listener reached at `listener`. An IPv4 address mapped into
/// IPv6, as a dual-stack listener sees it, is the IPv4 address.
#[must_use]
pub fn proof(key: &[u8; 32], nonce: &[u8], listener: std::net::SocketAddr) -> [u8; 32] {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("HMAC accepts any key length");
    mac.update(PROOF_CONTEXT);
    mac.update(nonce);
    match listener.ip().to_canonical() {
        std::net::IpAddr::V4(address) => {
            mac.update(&[4]);
            mac.update(&address.octets());
        }
        std::net::IpAddr::V6(address) => {
            mac.update(&[6]);
            mac.update(&address.octets());
        }
    }
    mac.update(&listener.port().to_be_bytes());
    mac.finalize().into_bytes().into()
}

#[must_use]
pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[must_use]
pub fn unhex(text: &str) -> Option<Vec<u8>> {
    if !text.len().is_multiple_of(2) {
        return None;
    }
    (0..text.len())
        .step_by(2)
        .map(|at| u8::from_str_radix(text.get(at..at + 2)?, 16).ok())
        .collect()
}

/// The loopback address that reaches a listener bound to `bind`: the bind address itself for a
/// loopback bind, the same family's loopback for a wildcard bind, and `None` when it listens
/// only on other interfaces.
#[must_use]
pub fn dial_host(bind: std::net::IpAddr) -> Option<std::net::IpAddr> {
    match bind.to_canonical() {
        address if address.is_loopback() => Some(address),
        std::net::IpAddr::V4(address) if address.is_unspecified() => {
            Some(std::net::Ipv4Addr::LOCALHOST.into())
        }
        std::net::IpAddr::V6(address) if address.is_unspecified() => {
            Some(std::net::Ipv6Addr::LOCALHOST.into())
        }
        _ => None,
    }
}

/// [`ENDPOINT_RECORD_FILE`] while the server runs; dropping it removes the file, unless a later
/// server has written its own since.
pub struct EndpointRecordFile {
    path: PathBuf,
    boot_id: String,
}

impl EndpointRecordFile {
    /// Writes the record readable by its owner only, through a temporary file and a rename,
    /// so a relay never reads half of it.
    pub fn write(
        state_dir: &Path,
        local_addr: std::net::SocketAddr,
        boot_id: &str,
        key: &[u8; 32],
    ) -> io::Result<Self> {
        let path = state_dir.join(ENDPOINT_RECORD_FILE);
        let temporary = state_dir.join(format!(
            ".{ENDPOINT_RECORD_FILE}.{}",
            Uuid::new_v4().simple()
        ));
        let started_at = time::OffsetDateTime::now_utc()
            .format(&time::format_description::well_known::Rfc3339)
            .unwrap_or_default();
        let document = json!({
            "version": RECORD_VERSION,
            "pid": std::process::id(),
            "dialHost": dial_host(local_addr.ip()),
            "port": local_addr.port(),
            "bootId": boot_id,
            "startedAt": started_at,
            "proofKey": hex(key),
        });
        let written = (|| {
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt as _;
                options.mode(0o600);
            }
            let mut file = options.open(&temporary)?;
            file.write_all(document.to_string().as_bytes())?;
            file.sync_all()?;
            std::fs::rename(&temporary, &path)
        })();
        if let Err(error) = written {
            let _ = std::fs::remove_file(&temporary);
            return Err(error);
        }
        Ok(Self {
            path,
            boot_id: boot_id.to_owned(),
        })
    }
}

impl Drop for EndpointRecordFile {
    fn drop(&mut self) {
        let ours = std::fs::read(&self.path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .is_some_and(|document| document["bootId"] == self.boot_id.as_str());
        if ours && let Err(error) = std::fs::remove_file(&self.path) {
            tracing::warn!(%error, "could not remove the MCP endpoint record");
        }
    }
}

/// The record as a relay reads it.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointRecord {
    pub version: u32,
    pub pid: u32,
    pub dial_host: Option<String>,
    pub port: u16,
    pub boot_id: String,
    pub proof_key: String,
}

impl EndpointRecord {
    pub fn read(state_dir: &Path) -> io::Result<Option<Self>> {
        match std::fs::read(state_dir.join(ENDPOINT_RECORD_FILE)) {
            Ok(bytes) => Ok(serde_json::from_slice(&bytes).ok()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error),
        }
    }

    #[must_use]
    pub fn key(&self) -> Option<[u8; 32]> {
        unhex(&self.proof_key)?.try_into().ok()
    }
}

#[derive(Deserialize)]
struct ProofRequest {
    nonce: String,
}

/// `POST /mcp/endpoint-proof`. It reads no bearer.
pub(crate) async fn proof_http(
    key: Option<ProofKey>,
    connection: crate::http::ConnectionInfo,
    request: Request,
) -> Response {
    let refuse = |status: StatusCode, message: &str| {
        (
            status,
            axum::Json(json!({ "_tag": "McpEndpointProofError", "message": message })),
        )
            .into_response()
    };
    let Some(key) = key else {
        return refuse(
            StatusCode::SERVICE_UNAVAILABLE,
            "This server has no MCP endpoint.",
        );
    };
    let Ok(axum::extract::ConnectInfo(addrs)) = connection else {
        return refuse(StatusCode::FORBIDDEN, "Only this computer may ask.");
    };
    let forwarded = request
        .headers()
        .keys()
        .any(|name| crate::production::diagnostic_logs_relay::is_forwarding_header(name.as_str()));
    let Some(local) = addrs
        .local
        .filter(|_| addrs.peer.ip().is_loopback() && !forwarded)
    else {
        return refuse(
            StatusCode::FORBIDDEN,
            "MCP endpoint proofs are answered only on this computer's loopback address.",
        );
    };
    let Ok(body) = to_bytes(request.into_body(), 1024).await else {
        return refuse(StatusCode::PAYLOAD_TOO_LARGE, "The request is too large.");
    };
    let Some(nonce) = serde_json::from_slice::<ProofRequest>(&body)
        .ok()
        .and_then(|request| unhex(&request.nonce))
        .filter(|nonce| nonce.len() == NONCE_BYTES)
    else {
        return refuse(StatusCode::BAD_REQUEST, "nonce must be 32 bytes of hex.");
    };
    let mut response =
        axum::Json(json!({ "proof": hex(&proof(&key, &nonce, local)) })).into_response();
    response.headers_mut().insert(
        axum::http::header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("no-store"),
    );
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_proof_binds_the_address_the_port_and_the_nonce() {
        let key = [7_u8; 32];
        let nonce = [1_u8; 32];
        let at = |text: &str| text.parse::<std::net::SocketAddr>().unwrap();
        let v4 = at("127.0.0.1:3773");
        assert_eq!(proof(&key, &nonce, v4), proof(&key, &nonce, v4));
        assert_ne!(
            proof(&key, &nonce, v4),
            proof(&key, &nonce, at("127.0.0.1:3774"))
        );
        assert_ne!(proof(&key, &nonce, v4), proof(&key, &[2_u8; 32], v4));
        // The same port on the other family's loopback, or another loopback address, is
        // another listener.
        assert_ne!(
            proof(&key, &nonce, v4),
            proof(&key, &nonce, at("[::1]:3773"))
        );
        assert_ne!(
            proof(&key, &nonce, v4),
            proof(&key, &nonce, at("127.0.0.2:3773"))
        );
        // A dual-stack listener sees an IPv4 peer's address mapped into IPv6.
        assert_eq!(
            proof(&key, &nonce, v4),
            proof(&key, &nonce, at("[::ffff:127.0.0.1]:3773"))
        );
        assert_eq!(unhex(&hex(&nonce)).unwrap(), nonce);
    }

    #[test]
    fn a_wildcard_bind_dials_its_loopback_and_another_interface_none() {
        let dial_host =
            |bind: &str| super::dial_host(bind.parse().unwrap()).map(|ip| ip.to_string());
        let some = |text: &str| Some(text.to_owned());
        assert_eq!(dial_host("0.0.0.0"), some("127.0.0.1"));
        assert_eq!(dial_host("::"), some("::1"));
        assert_eq!(dial_host("127.0.0.1"), some("127.0.0.1"));
        // A loopback bind is dialed exactly where it listens.
        assert_eq!(dial_host("127.0.0.2"), some("127.0.0.2"));
        assert_eq!(dial_host("::1"), some("::1"));
        assert_eq!(dial_host("192.168.1.4"), None);
    }

    #[test]
    fn the_record_is_owner_only_and_removed_only_while_it_is_ours() {
        let dir = tempfile::tempdir().unwrap();
        let key = [9_u8; 32];
        let first = EndpointRecordFile::write(
            dir.path(),
            "127.0.0.1:3773".parse().unwrap(),
            "boot-1",
            &key,
        )
        .unwrap();
        let record = EndpointRecord::read(dir.path()).unwrap().unwrap();
        assert_eq!(record.port, 3773);
        assert_eq!(record.dial_host.as_deref(), Some("127.0.0.1"));
        assert_eq!(record.key(), Some(key));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = std::fs::metadata(dir.path().join(ENDPOINT_RECORD_FILE))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        let second = EndpointRecordFile::write(
            dir.path(),
            "127.0.0.1:3774".parse().unwrap(),
            "boot-2",
            &key,
        )
        .unwrap();
        drop(first);
        assert_eq!(
            EndpointRecord::read(dir.path()).unwrap().unwrap().port,
            3774
        );
        drop(second);
        assert!(EndpointRecord::read(dir.path()).unwrap().is_none());
    }
}
