//! `bibcode mcp` (and `<desktop exe> mcp`): a stdio MCP server for outside agents, relaying
//! each message unchanged to this host's BiBCode server at `/mcp` (#139).
//!
//! It finds the server through the endpoint record, proves the listener holds the record's
//! per-boot key before it sends any credential, mints its own narrowed `mcp-client` credential
//! from the data root, and revokes it when it exits. The token lives only in this process's
//! memory: never in argv, the environment, logs or output. `ssh <host> bibcode mcp` reaches
//! that host's loopback server with no tunnel.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt as _, AsyncWrite, AsyncWriteExt},
    sync::{Mutex, mpsc},
    task::JoinHandle,
};
use url::Url;

use super::{
    control::{McpAccess, McpServerSettings, mcp_server_settings},
    endpoint::{EndpointRecord, PROOF_PATH, RECORD_VERSION, hex, proof, unhex},
    protocol,
};
use crate::data_root::ResolvedDataRoot;

/// Where each running relay records its credential's session id, so a later relay can revoke
/// the credential of one that crashed.
pub const CLIENT_RECORDS_DIR: &str = "mcp-clients";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// Longer than the longest wait (50 s) plus its slack.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);

pub const DISABLED_EXIT_MESSAGE: &str = "The MCP server is turned off for this environment. Turn on Settings → Agents → Agent integrations → MCP server.";
pub const NO_SERVER_MESSAGE: &str =
    "No BiBCode server with MCP support is running on this data root. Start or update BiBCode.";
pub const REVOKED_MESSAGE: &str = "BiBCode ended this MCP connection's access. Restart the MCP server in your agent to sign in again.";

/// What `bibcode mcp` was asked to do.
#[derive(Clone, Debug)]
pub struct RelayOptions {
    pub root: ResolvedDataRoot,
    pub dev_url: Option<Url>,
    /// The loopback address to reach the server at; it must name the record's listener.
    pub url: Option<Url>,
    /// A lower ceiling than the environment's `mcpServerAccess`.
    pub access: Option<McpAccess>,
}

impl RelayOptions {
    fn paths(&self) -> crate::persistence::StatePaths {
        let mut config = crate::config::ServerConfig::new(&self.root.effective);
        config.dev_url = self.dev_url.clone();
        crate::persistence::StatePaths::from_config(&config)
    }
}

/// The access level `--access` names.
pub fn parse_access(value: &str) -> Result<McpAccess, String> {
    McpAccess::parse(value).ok_or_else(|| {
        "--access is read-only, approval-required, auto-accept-edits or full-access".to_owned()
    })
}

/// Runs the relay on this process's stdin and stdout and returns the exit code. Errors go to
/// stderr; stdout carries only JSON-RPC.
pub async fn run_mcp_cli(options: RelayOptions) -> i32 {
    let stdin = tokio::io::BufReader::new(tokio::io::stdin());
    let stdout = tokio::io::stdout();
    match run(options, stdin, stdout, shutdown_signal()).await {
        Ok(()) => 0,
        Err(message) => {
            eprintln!("bibcode: {message}");
            1
        }
    }
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let mut terminate = signal(SignalKind::terminate()).ok();
        let mut hangup = signal(SignalKind::hangup()).ok();
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            Some(()) = async { terminate.as_mut()?.recv().await } => {}
            Some(()) = async { hangup.as_mut()?.recv().await } => {}
        }
    }
    #[cfg(windows)]
    {
        let mut close = tokio::signal::windows::ctrl_close().ok();
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            Some(()) = async { close.as_mut()?.recv().await } => {}
        }
    }
}

/// The relay: checks, proves the listener, then serves until `input` ends or `shutdown`
/// fires, and revokes its credential on the way out.
pub async fn run(
    options: RelayOptions,
    input: impl AsyncBufRead + Unpin,
    output: impl AsyncWrite + Unpin + Send + 'static,
    shutdown: impl std::future::Future<Output = ()>,
) -> Result<(), String> {
    let paths = options.paths();
    let settings = read_settings(&paths.settings)?;
    if !settings.enabled {
        return Err(DISABLED_EXIT_MESSAGE.to_owned());
    }
    let access = match options.access {
        Some(asked) if asked > settings.access => {
            return Err(format!(
                "--access {} is above this environment's limit ({}). Raise Settings → Agents → Agent integrations → Agents may, or ask for less.",
                asked.as_str(),
                settings.access.as_str()
            ));
        }
        Some(asked) => asked,
        None => settings.access,
    };
    if let Some(url) = &options.url {
        check_loopback_url(url)?;
    }
    let http = reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(REQUEST_TIMEOUT)
        .no_proxy()
        .build()
        .map_err(|error| error.to_string())?;
    let endpoint = discover(&paths.state_dir, options.url.as_ref(), &http).await?;
    sweep_orphans(&options).await;
    let relay = Arc::new(Relay {
        options,
        state_dir: paths.state_dir.clone(),
        http,
        access,
        endpoint: Mutex::new(endpoint),
        credential: Mutex::new(None),
        legacy_version: std::sync::Mutex::new(None),
    });
    let (lines, receiver) = mpsc::channel::<String>(64);
    let writer = tokio::spawn(write_lines(output, receiver));
    let served = serve(&relay, input, lines, shutdown).await;
    let _ = writer.await;
    relay.revoke().await;
    served
}

fn read_settings(path: &Path) -> Result<McpServerSettings, String> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(serde_json::from_slice::<Value>(&bytes)
            .map(|settings| mcp_server_settings(&settings))
            .unwrap_or_default()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(McpServerSettings::default())
        }
        Err(error) => Err(format!("Could not read {}: {error}", path.display())),
    }
}

/// Slice 1 reaches only this computer's loopback server.
fn check_loopback_url(url: &Url) -> Result<(), String> {
    let loopback = url.scheme() == "http"
        && matches!(
            url.host(),
            Some(url::Host::Domain("localhost"))
                | Some(url::Host::Ipv4(std::net::Ipv4Addr::LOCALHOST))
                | Some(url::Host::Ipv6(std::net::Ipv6Addr::LOCALHOST))
        );
    if loopback {
        Ok(())
    } else {
        Err(format!(
            "--url must name this computer's loopback address (http://127.0.0.1:<port>, http://[::1]:<port> or http://localhost:<port>), not {url}"
        ))
    }
}

/// Whether `url` names `listener`: its address, or `localhost`, on its port.
fn names_listener(url: &Url, listener: std::net::SocketAddr) -> bool {
    let host = match url.host() {
        Some(url::Host::Domain("localhost")) => true,
        Some(url::Host::Ipv4(address)) => std::net::IpAddr::V4(address) == listener.ip(),
        Some(url::Host::Ipv6(address)) => std::net::IpAddr::V6(address) == listener.ip(),
        _ => false,
    };
    host && url.port_or_known_default() == Some(listener.port())
}

struct Endpoint {
    base: Url,
}

/// Reads the record and proves the listener holds its key. No credential exists yet, and none
/// is sent, until this succeeds.
async fn discover(
    state_dir: &Path,
    url: Option<&Url>,
    http: &reqwest::Client,
) -> Result<Endpoint, String> {
    let record = EndpointRecord::read(state_dir)
        .map_err(|error| format!("Could not read the BiBCode endpoint record: {error}"))?
        .filter(|record| record.version >= RECORD_VERSION)
        .ok_or_else(|| NO_SERVER_MESSAGE.to_owned())?;
    if !process_alive(record.pid) {
        return Err(NO_SERVER_MESSAGE.to_owned());
    }
    let key = record.key().ok_or_else(|| NO_SERVER_MESSAGE.to_owned())?;
    // The exact listener the record names. The relay dials this address, never a name, so
    // `localhost` cannot resolve to another listener on the same port.
    let listener = record
        .dial_host
        .as_deref()
        .and_then(|host| host.parse::<std::net::IpAddr>().ok())
        .filter(std::net::IpAddr::is_loopback)
        .map(|host| std::net::SocketAddr::new(host, record.port))
        .ok_or_else(|| {
            "This BiBCode server does not listen on this computer's loopback address.".to_owned()
        })?;
    if let Some(url) = url
        && !names_listener(url, listener)
    {
        return Err(format!(
            "--url {url} is not where this BiBCode server listens ({listener}). Leave out --url to use the server's own address."
        ));
    }
    let base = Url::parse(&format!("http://{listener}/")).map_err(|error| error.to_string())?;
    let not_ours = || format!("The program listening on {base} is not this BiBCode server.");
    let mut nonce = [0_u8; 32];
    getrandom::fill(&mut nonce).map_err(|error| error.to_string())?;
    let answer = http
        .post(
            base.join(PROOF_PATH.trim_start_matches('/'))
                .map_err(|error| error.to_string())?,
        )
        .json(&json!({ "nonce": hex(&nonce) }))
        .send()
        .await
        .map_err(|_| not_ours())?;
    if !answer.status().is_success() {
        return Err(not_ours());
    }
    let answer: Value = answer.json().await.map_err(|_| not_ours())?;
    let expected = proof(&key, &nonce, listener);
    let given = answer["proof"].as_str().and_then(unhex).unwrap_or_default();
    if !bool::from(subtle::ConstantTimeEq::ct_eq(
        given.as_slice(),
        expected.as_slice(),
    )) {
        return Err(not_ours());
    }
    Ok(Endpoint { base })
}

/// Whether `pid` is a running process.
fn process_alive(pid: u32) -> bool {
    process_started_at(pid).is_some()
}

/// When `pid` started, in seconds since the epoch, or `None` when no such process runs.
fn process_started_at(pid: u32) -> Option<u64> {
    let pid = sysinfo::Pid::from_u32(pid);
    let mut system = sysinfo::System::new();
    system.refresh_processes_specifics(
        sysinfo::ProcessesToUpdate::Some(&[pid]),
        true,
        sysinfo::ProcessRefreshKind::nothing(),
    );
    system.process(pid).map(sysinfo::Process::start_time)
}

struct Credential {
    token: String,
    session_id: String,
}

struct Relay {
    options: RelayOptions,
    state_dir: PathBuf,
    http: reqwest::Client,
    access: McpAccess,
    endpoint: Mutex<Endpoint>,
    /// Minted on the first request, so its label can name the agent.
    credential: Mutex<Option<Credential>>,
    /// The version a legacy client's `initialize` negotiated.
    legacy_version: std::sync::Mutex<Option<String>>,
}

async fn write_lines(mut output: impl AsyncWrite + Unpin, mut lines: mpsc::Receiver<String>) {
    while let Some(mut line) = lines.recv().await {
        line.push('\n');
        if output.write_all(line.as_bytes()).await.is_err() || output.flush().await.is_err() {
            return;
        }
    }
}

async fn serve(
    relay: &Arc<Relay>,
    mut input: impl AsyncBufRead + Unpin,
    lines: mpsc::Sender<String>,
    shutdown: impl std::future::Future<Output = ()>,
) -> Result<(), String> {
    tokio::pin!(shutdown);
    let mut in_flight: HashMap<String, JoinHandle<()>> = HashMap::new();
    let mut line = Vec::new();
    loop {
        line.clear();
        let mut bounded = (&mut input).take(protocol::MAX_LINE_BYTES);
        let read = tokio::select! {
            () = &mut shutdown => break,
            read = bounded.read_until(b'\n', &mut line) => read,
        };
        match read {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        in_flight.retain(|_, task| !task.is_finished());
        if line.len() as u64 == protocol::MAX_LINE_BYTES && line.last() != Some(&b'\n') {
            // Skip the rest of the long line.
            let mut rest = Vec::new();
            let _ = input.read_until(b'\n', &mut rest).await;
            let _ = lines
                .send(
                    protocol::failure(
                        Value::Null,
                        protocol::rpc_error(
                            protocol::PARSE_ERROR,
                            "Parse error: a message longer than 4 MiB",
                        ),
                    )
                    .to_string(),
                )
                .await;
            continue;
        }
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        let Ok(message) = serde_json::from_slice::<Value>(&line) else {
            let _ = lines
                .send(
                    protocol::failure(
                        Value::Null,
                        protocol::rpc_error(protocol::PARSE_ERROR, "Parse error"),
                    )
                    .to_string(),
                )
                .await;
            continue;
        };
        // The stdio cancellation drops that request's HTTP body: on HTTP, closing is the
        // cancellation.
        if protocol::notification_method(&message) == Some("notifications/cancelled") {
            if let Some(task) = message
                .pointer("/params/requestId")
                .map(Value::to_string)
                .and_then(|id| in_flight.remove(&id))
            {
                task.abort();
            }
            continue;
        }
        let key = message.get("id").map(Value::to_string);
        let relay = Arc::clone(relay);
        let lines = lines.clone();
        let task = tokio::spawn(async move {
            if let Some(response) = relay.forward(message, &lines).await {
                let _ = lines.send(response).await;
            }
        });
        if let Some(key) = key {
            in_flight.insert(key, task);
        }
    }
    for (_, task) in in_flight {
        task.abort();
    }
    Ok(())
}

enum Sent {
    Response(reqwest::Response),
    Unauthorized,
    Unreachable(String),
}

impl Relay {
    /// Posts one message and returns the line to answer with, if any; event-stream frames
    /// before the result are written as they come.
    async fn forward(&self, message: Value, lines: &mpsc::Sender<String>) -> Option<String> {
        let id = message.get("id").cloned();
        let method = message
            .get("method")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let failure = |error: Value| {
            id.clone()
                .map(|id| protocol::failure(id, error).to_string())
        };
        let token = match self.credential(&message).await {
            Ok(token) => token,
            Err(error) => return failure(protocol::rpc_error(protocol::INTERNAL_ERROR, &error)),
        };
        let mut sent = self.post(&message, &token).await;
        if matches!(sent, Sent::Unreachable(_)) {
            // A restart may have moved the port: read the record again, prove it, retry once.
            if let Err(error) = self.rediscover().await {
                return failure(protocol::rpc_error(protocol::INTERNAL_ERROR, &error));
            }
            sent = self.post(&message, &token).await;
        }
        let response = match sent {
            Sent::Response(response) => response,
            // Never re-mint: the user may have revoked this client on purpose.
            Sent::Unauthorized => {
                return id.map(|id| {
                    if method.as_deref() == Some("tools/call") {
                        json!({ "jsonrpc": "2.0", "id": id, "result": protocol::tool_failure(REVOKED_MESSAGE) }).to_string()
                    } else {
                        protocol::failure(id, protocol::rpc_error(protocol::INTERNAL_ERROR, REVOKED_MESSAGE)).to_string()
                    }
                });
            }
            Sent::Unreachable(error) => {
                return failure(protocol::rpc_error(protocol::INTERNAL_ERROR, &error));
            }
        };
        id.as_ref()?;
        let streamed = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.starts_with("text/event-stream"));
        if streamed {
            return self.relay_events(response, lines).await;
        }
        let status = response.status();
        let body = response.bytes().await.ok()?;
        match serde_json::from_slice::<Value>(&body) {
            Ok(reply) if reply.get("jsonrpc").is_some() => {
                if method.as_deref() == Some("initialize")
                    && let Some(version) = reply
                        .pointer("/result/protocolVersion")
                        .and_then(Value::as_str)
                {
                    *self
                        .legacy_version
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner) =
                        Some(version.to_owned());
                }
                Some(reply.to_string())
            }
            Ok(error) => failure(protocol::rpc_error(
                protocol::INTERNAL_ERROR,
                error["message"]
                    .as_str()
                    .unwrap_or("BiBCode refused the request."),
            )),
            Err(_) => failure(protocol::rpc_error(
                protocol::INTERNAL_ERROR,
                &format!("BiBCode answered {status} with no MCP message."),
            )),
        }
    }

    /// Writes each `data:` message of an event stream as its own line; the last is the result.
    async fn relay_events(
        &self,
        mut response: reqwest::Response,
        lines: &mpsc::Sender<String>,
    ) -> Option<String> {
        let mut buffer = String::new();
        let mut last = None;
        while let Ok(Some(chunk)) = response.chunk().await {
            buffer.push_str(&String::from_utf8_lossy(&chunk));
            while let Some(end) = buffer.find("\n\n") {
                let frame: String = buffer.drain(..end + 2).collect();
                let data: Vec<&str> = frame
                    .lines()
                    .filter_map(|line| line.strip_prefix("data:"))
                    .map(str::trim_start)
                    .collect();
                if data.is_empty() {
                    continue;
                }
                let message = data.join("\n");
                if let Some(previous) = last.replace(message) {
                    let _ = lines.send(previous).await;
                }
            }
        }
        last
    }

    async fn post(&self, message: &Value, token: &str) -> Sent {
        let base = self.endpoint.lock().await.base.clone();
        let Ok(url) = base.join("mcp") else {
            return Sent::Unreachable("The BiBCode address is not valid.".to_owned());
        };
        let mut request = self
            .http
            .post(url)
            .bearer_auth(token)
            .header(
                reqwest::header::ACCEPT,
                "application/json, text/event-stream",
            )
            .json(message);
        let method = message
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let params = message.get("params");
        if let Some(version) = protocol::modern_version(params) {
            request = request
                .header("MCP-Protocol-Version", version)
                .header("Mcp-Method", method);
            if let Some(name) = params
                .and_then(|params| params.get("name"))
                .and_then(Value::as_str)
            {
                request = request.header("Mcp-Name", name);
            }
        } else if let Some(version) = self
            .legacy_version
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
        {
            request = request.header("MCP-Protocol-Version", version);
        }
        match request.send().await {
            Ok(response) if response.status() == reqwest::StatusCode::UNAUTHORIZED => {
                Sent::Unauthorized
            }
            Ok(response) => Sent::Response(response),
            Err(error) if error.is_connect() => Sent::Unreachable(
                "BiBCode is not reachable; start it again, then retry.".to_owned(),
            ),
            Err(error) => Sent::Unreachable(format!("BiBCode did not answer: {error}")),
        }
    }

    async fn rediscover(&self) -> Result<(), String> {
        let endpoint = discover(&self.state_dir, self.options.url.as_ref(), &self.http).await?;
        *self.endpoint.lock().await = endpoint;
        Ok(())
    }

    /// The credential, minted on the first request: a 60 s link from the data root, exchanged
    /// at once over loopback, labelled with the agent's name.
    async fn credential(&self, first: &Value) -> Result<String, String> {
        let mut credential = self.credential.lock().await;
        if let Some(credential) = credential.as_ref() {
            return Ok(credential.token.clone());
        }
        let name = first
            .pointer("/params/clientInfo/name")
            .or_else(|| first.pointer("/params/_meta/io.modelcontextprotocol~1clientInfo/name"))
            .and_then(Value::as_str)
            .map(|name| {
                name.chars()
                    .filter(|c| !c.is_control())
                    .take(60)
                    .collect::<String>()
            })
            .filter(|name| !name.trim().is_empty())
            .unwrap_or_else(|| "agent".to_owned());
        let minted = mint(&self.options, &format!("MCP · {name}"), self.access).await?;
        let base = self.endpoint.lock().await.base.clone();
        let exchanged = self
            .http
            .post(
                base.join("oauth/token")
                    .map_err(|error| error.to_string())?,
            )
            .form(&[
                ("grant_type", crate::auth::TOKEN_GRANT_TYPE),
                ("subject_token", minted.as_str()),
                ("subject_token_type", crate::auth::BOOTSTRAP_TOKEN_TYPE),
                ("requested_token_type", crate::auth::ACCESS_TOKEN_TYPE),
                ("client_device_type", "desktop"),
            ])
            .send()
            .await
            .map_err(|error| format!("Could not sign in to BiBCode: {error}"))?;
        if !exchanged.status().is_success() {
            return Err(format!(
                "BiBCode refused this MCP server's sign-in ({}).",
                exchanged.status()
            ));
        }
        let exchanged: Value = exchanged
            .json()
            .await
            .map_err(|error| format!("Could not sign in to BiBCode: {error}"))?;
        let token = exchanged["access_token"]
            .as_str()
            .ok_or("BiBCode returned no credential.")?
            .to_owned();
        let session_id =
            session_id_of(&token).ok_or("BiBCode returned a credential this relay cannot read.")?;
        record_client(&self.state_dir, &session_id);
        *credential = Some(Credential {
            token: token.clone(),
            session_id,
        });
        Ok(token)
    }

    /// Revokes this relay's credential through the data root and removes its record.
    async fn revoke(&self) {
        let Some(credential) = self.credential.lock().await.take() else {
            return;
        };
        if let Err(error) =
            revoke_sessions(&self.options, std::slice::from_ref(&credential.session_id)).await
        {
            eprintln!("bibcode: could not revoke this MCP connection's credential: {error}");
            return;
        }
        let _ = std::fs::remove_file(client_record_path(&self.state_dir, &credential.session_id));
    }
}

/// The `sid` in a session token's base64url JSON payload.
fn session_id_of(token: &str) -> Option<String> {
    use base64::Engine as _;
    let payload = token.split('.').next()?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .ok()?;
    serde_json::from_slice::<Value>(&bytes).ok()?["sid"]
        .as_str()
        .map(str::to_owned)
}

fn client_record_path(state_dir: &Path, session_id: &str) -> PathBuf {
    state_dir
        .join(CLIENT_RECORDS_DIR)
        .join(format!("{session_id}.json"))
}

/// `{ pid, processStartedAt }` for this relay, with no secret.
fn record_client(state_dir: &Path, session_id: &str) {
    let path = client_record_path(state_dir, session_id);
    let written = path
        .parent()
        .map_or(Ok(()), std::fs::create_dir_all)
        .and_then(|()| {
            std::fs::write(
                &path,
                json!({
                    "pid": std::process::id(),
                    "processStartedAt": process_started_at(std::process::id()),
                })
                .to_string(),
            )
        });
    if let Err(error) = written {
        eprintln!("bibcode: could not record this MCP connection: {error}");
    }
}

async fn open_store(
    options: &RelayOptions,
) -> Result<
    (
        crate::persistence::StoreRuntimeGuard,
        crate::persistence::Database,
    ),
    String,
> {
    let guard = crate::persistence::StoreRuntimeGuard::acquire(&options.root.effective)
        .await
        .map_err(|error| error.to_string())?;
    let database = crate::persistence::Database::open_existing(&options.paths().database)
        .await
        .map_err(|error| error.to_string())?;
    Ok((guard, database))
}

async fn mint(options: &RelayOptions, label: &str, access: McpAccess) -> Result<String, String> {
    let (_guard, database) = open_store(options).await?;
    let repositories = crate::persistence::Repositories::new(database.clone());
    let issued =
        crate::auth::issue_mcp_pairing_link(&repositories, label.to_owned(), access.as_str())
            .await
            .map_err(|error| {
                format!("Could not issue this MCP connection's credential: {error:?}")
            });
    database.close().await;
    issued.map(|issued| issued.credential)
}

async fn revoke_sessions(options: &RelayOptions, session_ids: &[String]) -> Result<(), String> {
    let (_guard, database) = open_store(options).await?;
    let repositories = crate::persistence::Repositories::new(database.clone());
    let now = crate::auth::format_iso(crate::auth::now_ms());
    let mut outcome = Ok(());
    for session_id in session_ids {
        if let Err(error) = repositories
            .revoke_auth_session(session_id.clone(), now.clone())
            .await
        {
            outcome = Err(error.to_string());
        }
    }
    database.close().await;
    outcome
}

/// Revokes and forgets the credentials of relays whose process is gone.
async fn sweep_orphans(options: &RelayOptions) {
    let dir = options.paths().state_dir.join(CLIENT_RECORDS_DIR);
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    let mut orphans = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(session_id) = path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .filter(|_| {
                path.extension()
                    .is_some_and(|extension| extension == "json")
            })
            .map(str::to_owned)
        else {
            continue;
        };
        let record = std::fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .unwrap_or_default();
        let alive = record["pid"]
            .as_u64()
            .and_then(|pid| u32::try_from(pid).ok())
            .and_then(process_started_at)
            .is_some_and(|started| record["processStartedAt"].as_u64() == Some(started));
        if !alive {
            orphans.push((session_id, path));
        }
    }
    if orphans.is_empty() {
        return;
    }
    let ids: Vec<String> = orphans.iter().map(|(id, _)| id.clone()).collect();
    if revoke_sessions(options, &ids).await.is_ok() {
        for (_, path) in orphans {
            let _ = std::fs::remove_file(path);
        }
    }
}

#[cfg(test)]
mod tests;
