//! How `bibcode mcp` finds this server and proves it is talking to it (#139).
//!
//! The server writes [`ENDPOINT_RECORD_FILE`] (`server-runtime.json`, mode 0600) in its state
//! directory after it binds and removes it when it stops, only while it is still ours. The
//! record holds a per-boot `proofKey` that exists nowhere else but server memory. Before the
//! relay sends any credential, it posts a fresh nonce to `POST /mcp/endpoint-proof`, which
//! answers `HMAC-SHA256(proofKey, "bibcode-mcp-endpoint-v2" ‖ nonce ‖ local address ‖ port)`.
//! The address and port are the ones the connection reached, and the relay dials exactly the
//! record's `dialHost` and `port`. A listener that forwards the nonce to the real server from
//! another address or port, such as `[::1]:P` while BiBCode listens on `127.0.0.1:P`, gets a
//! proof that does not verify. The route is unauthenticated, accepts only this host's peers,
//! and reveals nothing secret: it signs a nonce the caller chose.
//!
//! The runtime guard is a shared lock, so a second server for the same data root can start on
//! another port. The first live owner keeps the record: a server writes it only when no other
//! server that is still running answers the recorded proof (see [`EndpointRecordFile::claim`]).

use std::{
    io::{self, Write as _},
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
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
/// How long a starting server waits for the recorded owner to answer its proof.
const OWNER_PROBE_TIMEOUT: Duration = Duration::from_secs(2);

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
    /// Writes the record, unless another server that is still running holds it: its pid is
    /// alive and its recorded listener answers the recorded proof. That server keeps MCP
    /// discovery, and this one runs undiscovered by `bibcode mcp` (`Ok(None)`). A record whose
    /// owner is gone, or whose pid now belongs to another program, is replaced.
    pub async fn claim(
        state_dir: &Path,
        local_addr: std::net::SocketAddr,
        boot_id: &str,
        key: &[u8; 32],
    ) -> io::Result<Option<Self>> {
        if let Some(owner) = EndpointRecord::read(state_dir)?
            && owner.boot_id != boot_id
            && owner_is_running(&owner).await
        {
            tracing::warn!(
                "another BiBCode server for this data root is running; MCP discovery stays with it, so `bibcode mcp` does not reach this server"
            );
            return Ok(None);
        }
        Self::write(state_dir, local_addr, boot_id, key).map(Some)
    }

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

/// Whether the record's owner still runs. A proof that does not answer in time counts as
/// running: something holds the recorded listener of a live pid, most likely the owner itself
/// stalled or suspended, and taking the record from it would lose discovery of a running
/// server when this one stops. A refused connection or a wrong proof means it is gone.
async fn owner_is_running(record: &EndpointRecord) -> bool {
    let (Some(listener), Some(key)) = (record.listener(), record.key()) else {
        return false;
    };
    if record.version < RECORD_VERSION || !process_alive(record.pid) {
        return false;
    }
    let http = reqwest::Client::builder()
        .connect_timeout(OWNER_PROBE_TIMEOUT)
        .timeout(OWNER_PROBE_TIMEOUT)
        .no_proxy()
        .build();
    // Being unable to ask is not evidence that the owner is gone.
    let Ok(http) = http else { return true };
    !matches!(prove(&http, listener, &key).await, Ok(Proof::Refused))
}

/// What a listener answered to a fresh nonce.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Proof {
    /// It holds the key.
    Proven,
    /// It refused the connection, has no proof route, or answered a wrong proof.
    Refused,
    /// It did not answer before the client's timeout.
    TimedOut,
}

/// Sends a fresh nonce to `listener`'s proof route and checks the answer against `key`, in
/// constant time. Nothing but the nonce is sent.
pub async fn prove(
    http: &reqwest::Client,
    listener: std::net::SocketAddr,
    key: &[u8; 32],
) -> io::Result<Proof> {
    let mut nonce = [0_u8; NONCE_BYTES];
    getrandom::fill(&mut nonce).map_err(|error| io::Error::other(error.to_string()))?;
    let failed = |error: reqwest::Error| {
        if error.is_timeout() {
            Proof::TimedOut
        } else {
            Proof::Refused
        }
    };
    let answer = match http
        .post(format!("http://{listener}{PROOF_PATH}"))
        .json(&json!({ "nonce": hex(&nonce) }))
        .send()
        .await
    {
        Ok(answer) if answer.status().is_success() => answer,
        Ok(_) => return Ok(Proof::Refused),
        Err(error) => return Ok(failed(error)),
    };
    let answer: Value = match answer.json().await {
        Ok(answer) => answer,
        Err(error) => return Ok(failed(error)),
    };
    let expected = proof(key, &nonce, listener);
    let given = answer["proof"].as_str().and_then(unhex).unwrap_or_default();
    let proven = bool::from(subtle::ConstantTimeEq::ct_eq(
        given.as_slice(),
        expected.as_slice(),
    ));
    Ok(if proven {
        Proof::Proven
    } else {
        Proof::Refused
    })
}

/// Whether `pid` is a running process.
#[must_use]
pub fn process_alive(pid: u32) -> bool {
    process_started_at(pid).is_some()
}

/// When `pid` started, in seconds since the epoch, or `None` when no such process runs.
#[must_use]
pub fn process_started_at(pid: u32) -> Option<u64> {
    let pid = sysinfo::Pid::from_u32(pid);
    let mut system = sysinfo::System::new();
    system.refresh_processes_specifics(
        sysinfo::ProcessesToUpdate::Some(&[pid]),
        true,
        sysinfo::ProcessRefreshKind::nothing(),
    );
    system.process(pid).map(sysinfo::Process::start_time)
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

    /// The exact loopback listener the record names, as an address, so a name such as
    /// `localhost` cannot resolve to another listener on the same port.
    #[must_use]
    pub fn listener(&self) -> Option<std::net::SocketAddr> {
        self.dial_host
            .as_deref()
            .and_then(|host| host.parse::<std::net::IpAddr>().ok())
            .filter(std::net::IpAddr::is_loopback)
            .map(|host| std::net::SocketAddr::new(host, self.port))
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

    /// Another server's record: `pid`, listening on `127.0.0.1:port`.
    fn others_record(dir: &Path, pid: u32, port: u16) {
        let record = json!({
            "version": RECORD_VERSION,
            "pid": pid,
            "dialHost": "127.0.0.1",
            "port": port,
            "bootId": "other",
            "startedAt": "",
            "proofKey": hex(&[3_u8; 32]),
        });
        std::fs::write(dir.join(ENDPOINT_RECORD_FILE), record.to_string()).unwrap();
    }

    async fn claim(dir: &Path) -> Option<EndpointRecordFile> {
        EndpointRecordFile::claim(dir, "127.0.0.1:1".parse().unwrap(), "ours", &[9_u8; 32])
            .await
            .unwrap()
    }

    fn boot_id(dir: &Path) -> String {
        EndpointRecord::read(dir).unwrap().unwrap().boot_id
    }

    /// A listener that never answers, as a stalled or suspended owner does.
    async fn silent_listener() -> tokio::net::TcpListener {
        tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap()
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_dead_owners_record_is_replaced() {
        let dir = tempfile::tempdir().unwrap();
        let mut exited = std::process::Command::new("true").spawn().unwrap();
        let pid = exited.id();
        exited.wait().unwrap();
        // Something still holds the port; the dead pid alone settles it.
        let held = silent_listener().await;
        others_record(dir.path(), pid, held.local_addr().unwrap().port());
        let ours = claim(dir.path()).await;
        assert!(ours.is_some());
        assert_eq!(boot_id(dir.path()), "ours");
    }

    /// A live pid whose recorded listener is gone, such as a pid the system gave to another
    /// program, does not pin the record.
    #[tokio::test]
    async fn a_live_pid_without_its_listener_loses_the_record() {
        let dir = tempfile::tempdir().unwrap();
        let port = silent_listener().await.local_addr().unwrap().port();
        others_record(dir.path(), std::process::id(), port);
        let ours = claim(dir.path()).await;
        assert!(ours.is_some());
        assert_eq!(boot_id(dir.path()), "ours");
    }

    /// An owner that does not answer within the probe's timeout keeps the record, and the
    /// starting server waits no longer than that timeout.
    #[tokio::test]
    async fn an_owner_that_does_not_answer_in_time_keeps_the_record() {
        let dir = tempfile::tempdir().unwrap();
        let held = silent_listener().await;
        others_record(
            dir.path(),
            std::process::id(),
            held.local_addr().unwrap().port(),
        );
        let started = std::time::Instant::now();
        assert!(claim(dir.path()).await.is_none());
        assert!(started.elapsed() < OWNER_PROBE_TIMEOUT * 3, "bounded");
        assert_eq!(boot_id(dir.path()), "other");
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
