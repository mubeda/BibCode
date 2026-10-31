use std::{
    collections::{BTreeMap, HashMap},
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    sync::Arc,
};

use axum::http::{Method, StatusCode, header};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::http_routes::{
    HttpRouteError, JsonOperation, JsonRouteResponse, McpHttpResponse, RouteContext,
};
use crate::{
    mcp::{
        control::{ClientPrincipal, McpControl, PROVIDER_SCOPES, PrincipalKind, authorize_call},
        protocol::{self, Incoming},
        tools::previews::{snapshot_tool_result, tool_failure},
    },
    preview::{OpenRequestError, PreviewManager},
};

mod device_tools;
pub use device_tools::DeviceTools;
pub(crate) use device_tools::device_tool_descriptors;

const RELAY_LINK_PROOF_TYP: &str = "bibcode-env-link+jwt";
const RELAY_MINT_REQUEST_TYP: &str = "bibcode-cloud-mint+jwt";
const RELAY_HEALTH_REQUEST_TYP: &str = "bibcode-cloud-health+jwt";
const RELAY_MINT_RESPONSE_TYP: &str = "bibcode-env-mint+jwt";
const RELAY_HEALTH_RESPONSE_TYP: &str = "bibcode-env-health+jwt";
const PROOF_MAX_LIFETIME_SECONDS: i64 = 5 * 60;
const PROOF_CLOCK_SKEW_SECONDS: i64 = 60;
const MCP_IDLE_SECONDS: i64 = 30 * 60;
const MCP_LIFETIME_SECONDS: i64 = 8 * 60 * 60;

type StringFuture<T> = Pin<Box<dyn Future<Output = Result<T, String>> + Send + 'static>>;

#[derive(Clone)]
pub struct ConnectMcpConfig {
    pub environment_id: String,
    pub descriptor: Value,
    pub mcp_endpoint: String,
    /// This server's `POST /api/preview/open-url` URL, as a process on this host reaches it.
    pub open_url_endpoint: String,
    pub now_epoch_seconds: Arc<dyn Fn() -> i64 + Send + Sync>,
    pub max_mcp_credentials: usize,
    pub max_mcp_sessions: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DecodedCloudProof {
    pub issuer: String,
    pub subject: String,
    pub audience: String,
    pub jwt_id: String,
    pub issued_at: i64,
    pub expires_at: i64,
    pub environment_id: String,
    pub nonce: String,
    pub scope: Vec<String>,
    pub client_proof_key_thumbprint: Option<String>,
    pub confirmation_thumbprint: Option<String>,
}

type SignFn = Arc<dyn Fn(String, Value) -> StringFuture<String> + Send + Sync>;
type VerifyFn = Arc<
    dyn Fn(String, String, String, String, String, i64) -> StringFuture<DecodedCloudProof>
        + Send
        + Sync,
>;
type KeyPairFn = Arc<dyn Fn() -> StringFuture<(String, String)> + Send + Sync>;

#[derive(Clone)]
pub struct JwtCodec {
    sign: SignFn,
    verify: VerifyFn,
    key_pair: KeyPairFn,
}

impl JwtCodec {
    pub fn new<Sign, SignFut, Verify, VerifyFut, Keys, KeysFut>(
        sign: Sign,
        verify: Verify,
        key_pair: Keys,
    ) -> Self
    where
        Sign: Fn(String, Value) -> SignFut + Send + Sync + 'static,
        SignFut: Future<Output = Result<String, String>> + Send + 'static,
        Verify:
            Fn(String, String, String, String, String, i64) -> VerifyFut + Send + Sync + 'static,
        VerifyFut: Future<Output = Result<DecodedCloudProof, String>> + Send + 'static,
        Keys: Fn() -> KeysFut + Send + Sync + 'static,
        KeysFut: Future<Output = Result<(String, String), String>> + Send + 'static,
    {
        Self {
            sign: Arc::new(move |typ, payload| Box::pin(sign(typ, payload))),
            verify: Arc::new(move |key, typ, token, issuer, audience, now| {
                Box::pin(verify(key, typ, token, issuer, audience, now))
            }),
            key_pair: Arc::new(move || Box::pin(key_pair())),
        }
    }
}

type EndpointFn = Arc<dyn Fn(Value) -> StringFuture<Value> + Send + Sync>;

#[derive(Clone)]
pub struct EndpointRuntime(EndpointFn);

impl EndpointRuntime {
    pub fn new<Apply, Fut>(apply: Apply) -> Self
    where
        Apply: Fn(Value) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<Value, String>> + Send + 'static,
    {
        Self(Arc::new(move |config| Box::pin(apply(config))))
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PairingCredential {
    pub credential: String,
    pub expires_at: String,
}

type PairingFn = Arc<dyn Fn(String) -> StringFuture<PairingCredential> + Send + Sync>;

#[derive(Clone)]
pub struct PairingIssuer(PairingFn);

impl PairingIssuer {
    pub fn new<Issue, Fut>(issue: Issue) -> Self
    where
        Issue: Fn(String) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<PairingCredential, String>> + Send + 'static,
    {
        Self(Arc::new(move |thumbprint| Box::pin(issue(thumbprint))))
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PreviewScope {
    pub environment_id: String,
    pub thread_id: String,
    /// The root thread the agent works for: a chat panel's host, else `thread_id`. Device
    /// tools compare it with a device's owner, so a panel's agent and its host's Device pane
    /// share their devices.
    pub owner_thread_id: String,
    pub provider_session_id: String,
    pub provider_instance_id: String,
}

type PreviewFn = Arc<
    dyn Fn(PreviewScope, String, Value, Option<String>, CancellationToken) -> StringFuture<Value>
        + Send
        + Sync,
>;

#[derive(Clone)]
pub struct PreviewInvoker(PreviewFn);

impl PreviewInvoker {
    pub fn new<Invoke, Fut>(invoke: Invoke) -> Self
    where
        Invoke: Fn(PreviewScope, String, Value, Option<String>, CancellationToken) -> Fut
            + Send
            + Sync
            + 'static,
        Fut: Future<Output = Result<Value, String>> + Send + 'static,
    {
        Self(Arc::new(
            move |scope, operation, input, tab_id, cancellation| {
                Box::pin(invoke(scope, operation, input, tab_id, cancellation))
            },
        ))
    }

    /// Runs one preview operation for the thread `scope` names.
    pub(crate) async fn invoke(
        &self,
        scope: PreviewScope,
        operation: String,
        input: Value,
        tab_id: Option<String>,
        cancellation: CancellationToken,
    ) -> Result<Value, String> {
        (self.0)(scope, operation, input, tab_id, cancellation).await
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct McpIssuedCredential {
    pub environment_id: String,
    pub thread_id: String,
    pub provider_session_id: String,
    pub provider_instance_id: String,
    pub endpoint: String,
    pub authorization_header: String,
    pub expires_at: i64,
}

#[derive(Debug)]
pub struct ConnectMcpError {
    status: StatusCode,
    body: Value,
    headers: BTreeMap<String, String>,
}

impl ConnectMcpError {
    #[must_use]
    pub const fn status(&self) -> StatusCode {
        self.status
    }

    #[must_use]
    pub const fn body(&self) -> &Value {
        &self.body
    }

    #[must_use]
    pub fn into_http(self) -> HttpRouteError {
        let mut error = HttpRouteError::new(self.status, self.body);
        for (name, value) in self.headers {
            error = error.with_header(name, value);
        }
        error
    }

    fn bad_request(message: impl Into<String>) -> Self {
        Self::new(
            StatusCode::BAD_REQUEST,
            "EnvironmentHttpBadRequestError",
            message,
        )
    }

    fn unauthorized(message: impl Into<String>) -> Self {
        Self::new(
            StatusCode::UNAUTHORIZED,
            "EnvironmentHttpUnauthorizedError",
            message,
        )
    }

    fn conflict(message: impl Into<String>) -> Self {
        Self::new(
            StatusCode::CONFLICT,
            "EnvironmentHttpConflictError",
            message,
        )
    }

    fn internal(message: impl Into<String>) -> Self {
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "EnvironmentHttpInternalServerError",
            message,
        )
    }

    fn mcp(status: StatusCode, message: impl Into<String>) -> Self {
        Self::new(status, "McpHttpTransportError", message)
    }

    fn new(status: StatusCode, tag: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            body: json!({ "_tag": tag, "message": message.into() }),
            headers: BTreeMap::new(),
        }
    }

    fn invalid_mcp_credential() -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            body: json!({
                "error": "invalid_mcp_credential",
                "message": "A valid provider-scoped MCP bearer credential is required."
            }),
            headers: BTreeMap::from([(
                header::WWW_AUTHENTICATE.as_str().to_owned(),
                "Bearer".to_owned(),
            )]),
        }
    }

    fn invalid_open_url_credential() -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            body: json!({
                "error": "invalid_open_url_credential",
                "message": "A valid thread-scoped open-url bearer credential is required."
            }),
            headers: BTreeMap::from([(
                header::WWW_AUTHENTICATE.as_str().to_owned(),
                "Bearer".to_owned(),
            )]),
        }
    }

    fn too_many_open_requests(message: String) -> Self {
        Self {
            status: StatusCode::TOO_MANY_REQUESTS,
            body: json!({ "error": "too_many_open_requests", "message": message }),
            headers: BTreeMap::new(),
        }
    }
}

#[derive(Clone)]
pub struct ConnectMcpService {
    database_path: Arc<PathBuf>,
    config: Arc<ConnectMcpConfig>,
    jwt: JwtCodec,
    endpoint: EndpointRuntime,
    pairing: PairingIssuer,
    preview: PreviewInvoker,
    devices: Option<DeviceTools>,
    mcp: Arc<Mutex<McpState>>,
    /// The outside-agent thread tools; `None` serves provider tools only.
    control: Option<McpControl>,
    /// Serializes changes to the stored link and its managed endpoint (link, unlink, and the
    /// startup restore), so a restore never reapplies a config a newer change replaced.
    link_mutation: Arc<Mutex<()>>,
}

#[derive(Clone)]
struct McpCredentialRecord {
    scope: PreviewScope,
    expires_at: i64,
    last_used_at: i64,
}

struct McpSessionRecord {
    credential_hash: String,
    last_used_at: i64,
}

/// A thread-scoped token that only authorizes `POST /api/preview/open-url`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OpenUrlCredential {
    pub token: String,
    pub expires_at: i64,
}

struct OpenUrlRecord {
    thread_id: String,
    expires_at: i64,
}

#[derive(Default)]
struct McpState {
    credentials: HashMap<String, McpCredentialRecord>,
    sessions: HashMap<String, McpSessionRecord>,
    /// Open-url credentials by token hash. Kept apart from `credentials` so neither kind of
    /// token can authenticate the other's route. A thread may hold several (one per provider
    /// session or terminal), so issuing one never revokes another.
    open_url: HashMap<String, OpenUrlRecord>,
}

impl ConnectMcpService {
    pub async fn open(
        database_path: impl AsRef<Path>,
        config: ConnectMcpConfig,
        jwt: JwtCodec,
        endpoint: EndpointRuntime,
        pairing: PairingIssuer,
        preview: PreviewInvoker,
        devices: Option<DeviceTools>,
    ) -> Result<Self, ConnectMcpError> {
        let database_path = database_path.as_ref().to_path_buf();
        let initialize_path = database_path.clone();
        tokio::task::spawn_blocking(move || initialize_database(&initialize_path))
            .await
            .map_err(|error| ConnectMcpError::internal(error.to_string()))?
            .map_err(ConnectMcpError::internal)?;
        Ok(Self {
            database_path: Arc::new(database_path),
            config: Arc::new(config),
            jwt,
            endpoint,
            pairing,
            preview,
            devices,
            mcp: Arc::new(Mutex::new(McpState::default())),
            control: None,
            link_mutation: Arc::default(),
        })
    }

    /// Serves the outside-agent thread tools on `/mcp` too, and lets their preview and device
    /// twins use this service's preview host and devices.
    #[must_use]
    pub fn with_control(mut self, control: McpControl) -> Self {
        control.attach_previews(crate::mcp::tools::previews::PreviewServices {
            environment_id: self.config.environment_id.clone(),
            invoker: self.preview.clone(),
            devices: self.devices.clone(),
        });
        self.control = Some(control);
        self
    }

    pub async fn json(
        &self,
        operation: JsonOperation,
        payload: Option<Value>,
        context: RouteContext,
    ) -> Result<JsonRouteResponse, ConnectMcpError> {
        if context.cancellation.is_cancelled() {
            return Err(ConnectMcpError::bad_request("Request was cancelled."));
        }
        match operation {
            JsonOperation::ConnectLinkProof => {
                self.link_proof(required_payload(payload)?, context).await
            }
            JsonOperation::ConnectRelayConfig => {
                self.relay_config(required_payload(payload)?).await
            }
            JsonOperation::ConnectLinkState => self.link_state().await,
            JsonOperation::ConnectUnlink => self.unlink().await,
            JsonOperation::ConnectHealth => self.health(required_payload(payload)?).await,
            JsonOperation::ConnectMintCredential => {
                self.mint_credential(required_payload(payload)?).await
            }
            _ => Err(ConnectMcpError::bad_request(
                "Unsupported Connect operation.",
            )),
        }
    }

    pub async fn json_http(
        &self,
        operation: JsonOperation,
        payload: Option<Value>,
        context: RouteContext,
    ) -> Result<JsonRouteResponse, HttpRouteError> {
        self.json(operation, payload, context)
            .await
            .map_err(ConnectMcpError::into_http)
    }

    /// A credential for `thread_id`'s provider, scoped to `owner_thread_id`, the thread's root
    /// (a chat panel's host, else the thread). It replaces the thread's earlier credential.
    pub async fn issue_mcp_credential(
        &self,
        thread_id: impl Into<String>,
        owner_thread_id: impl Into<String>,
        provider_instance_id: impl Into<String>,
    ) -> Result<McpIssuedCredential, ConnectMcpError> {
        let now = (self.config.now_epoch_seconds)();
        let mut token_bytes = [0_u8; 32];
        getrandom::fill(&mut token_bytes)
            .map_err(|error| ConnectMcpError::internal(error.to_string()))?;
        let token = URL_SAFE_NO_PAD.encode(token_bytes);
        let token_hash = hash_token(&token);
        let thread_id = thread_id.into();
        let provider_instance_id = provider_instance_id.into();
        let provider_session_id = Uuid::new_v4().to_string();
        let expires_at = now.saturating_add(MCP_LIFETIME_SECONDS);
        let scope = PreviewScope {
            environment_id: self.config.environment_id.clone(),
            thread_id: thread_id.clone(),
            owner_thread_id: owner_thread_id.into(),
            provider_session_id: provider_session_id.clone(),
            provider_instance_id: provider_instance_id.clone(),
        };
        let mut state = self.mcp.lock().await;
        prune_mcp(&mut state, now);
        state
            .credentials
            .retain(|_, record| record.scope.thread_id != thread_id);
        if state.credentials.len() >= self.config.max_mcp_credentials.max(1) {
            return Err(ConnectMcpError::internal(
                "Provider MCP credential capacity exceeded.",
            ));
        }
        state.credentials.insert(
            token_hash,
            McpCredentialRecord {
                scope,
                expires_at,
                last_used_at: now,
            },
        );
        Ok(McpIssuedCredential {
            environment_id: self.config.environment_id.clone(),
            thread_id,
            provider_session_id,
            provider_instance_id,
            endpoint: self.config.mcp_endpoint.clone(),
            authorization_header: format!("Bearer {token}"),
            expires_at,
        })
    }

    pub async fn issue_open_url_credential(
        &self,
        thread_id: &str,
    ) -> Result<OpenUrlCredential, ConnectMcpError> {
        let now = (self.config.now_epoch_seconds)();
        let mut token_bytes = [0_u8; 32];
        getrandom::fill(&mut token_bytes)
            .map_err(|error| ConnectMcpError::internal(error.to_string()))?;
        let token = URL_SAFE_NO_PAD.encode(token_bytes);
        let expires_at = now.saturating_add(MCP_LIFETIME_SECONDS);
        let mut state = self.mcp.lock().await;
        state.open_url.retain(|_, record| record.expires_at >= now);
        if state.open_url.len() >= self.config.max_mcp_credentials.max(1) {
            // ponytail: evicts the soonest-expiring token (a linear scan) rather than refusing,
            // so a busy server never fails a terminal launch; its holder's open-url stops working.
            if let Some(oldest) = state
                .open_url
                .iter()
                .min_by_key(|(_, record)| record.expires_at)
                .map(|(hash, _)| hash.clone())
            {
                state.open_url.remove(&oldest);
            }
        }
        state.open_url.insert(
            hash_token(&token),
            OpenUrlRecord {
                thread_id: thread_id.to_owned(),
                expires_at,
            },
        );
        Ok(OpenUrlCredential { token, expires_at })
    }

    #[must_use]
    pub fn open_url_endpoint(&self) -> &str {
        &self.config.open_url_endpoint
    }

    /// Returns the thread an open-url token was issued for, if it is live.
    pub async fn verify_open_url_credential(&self, token: &str) -> Option<String> {
        let now = (self.config.now_epoch_seconds)();
        let mut state = self.mcp.lock().await;
        state.open_url.retain(|_, record| record.expires_at >= now);
        state
            .open_url
            .get(&hash_token(token))
            .map(|record| record.thread_id.clone())
    }

    /// `POST /api/preview/open-url`: bearer open-url token only, body `{ "url": … }`. Answers
    /// `202 { requestId, delivered }`; `delivered` is false when no client could see the
    /// request, so the caller should show the URL itself. A thread with too many unclaimed
    /// requests gets `429`.
    pub async fn open_url(
        &self,
        preview: &PreviewManager,
        body: Vec<u8>,
        context: RouteContext,
    ) -> Result<JsonRouteResponse, ConnectMcpError> {
        let token =
            bearer_token(&context).map_err(|_| ConnectMcpError::invalid_open_url_credential())?;
        let thread_id = self
            .verify_open_url_credential(token)
            .await
            .ok_or_else(ConnectMcpError::invalid_open_url_credential)?;
        let url = serde_json::from_slice::<Value>(&body)
            .ok()
            .and_then(|payload| payload.get("url")?.as_str().map(str::to_owned))
            .ok_or_else(|| ConnectMcpError::bad_request("A string \"url\" is required."))?;
        let receipt =
            preview
                .request_open(&thread_id, &url)
                .await
                .map_err(|error| match error {
                    OpenRequestError::InvalidUrl(error) => {
                        ConnectMcpError::bad_request(error.to_string())
                    }
                    OpenRequestError::TooManyPending => {
                        ConnectMcpError::too_many_open_requests(error.to_string())
                    }
                })?;
        Ok(JsonRouteResponse {
            status: StatusCode::ACCEPTED,
            headers: BTreeMap::new(),
            body: json!({ "requestId": receipt.request_id, "delivered": receipt.delivered }),
        })
    }

    pub async fn open_url_http(
        &self,
        preview: &PreviewManager,
        body: Vec<u8>,
        context: RouteContext,
    ) -> Result<JsonRouteResponse, HttpRouteError> {
        self.open_url(preview, body, context)
            .await
            .map_err(ConnectMcpError::into_http)
    }

    pub async fn revoke_mcp_provider_session(&self, provider_session_id: &str) {
        let mut state = self.mcp.lock().await;
        let hashes = state
            .credentials
            .iter()
            .filter(|(_, record)| record.scope.provider_session_id == provider_session_id)
            .map(|(hash, _)| hash.clone())
            .collect::<Vec<_>>();
        state.credentials.retain(|hash, _| !hashes.contains(hash));
        state
            .sessions
            .retain(|_, session| !hashes.contains(&session.credential_hash));
    }

    pub async fn revoke_all_mcp_credentials(&self) {
        let mut state = self.mcp.lock().await;
        state.credentials.clear();
        state.sessions.clear();
    }

    pub async fn mcp(
        &self,
        method: Method,
        body: Vec<u8>,
        context: RouteContext,
    ) -> Result<McpHttpResponse, ConnectMcpError> {
        match method {
            Method::POST => self.mcp_post(body, context).await,
            Method::DELETE => self.mcp_delete(context).await,
            _ => Err(ConnectMcpError::mcp(
                StatusCode::METHOD_NOT_ALLOWED,
                "Unsupported MCP transport method.",
            )),
        }
    }

    pub async fn mcp_http(
        &self,
        method: Method,
        body: Vec<u8>,
        context: RouteContext,
    ) -> Result<McpHttpResponse, HttpRouteError> {
        self.mcp(method, body, context)
            .await
            .map_err(ConnectMcpError::into_http)
    }

    async fn link_proof(
        &self,
        payload: Value,
        context: RouteContext,
    ) -> Result<JsonRouteResponse, ConnectMcpError> {
        let object = object(&payload)?;
        let challenge = string_field(object, "challenge")?;
        let relay_issuer = normalize_issuer(string_field(object, "relayIssuer")?);
        let endpoint = object.get("endpoint").cloned().ok_or_else(|| {
            ConnectMcpError::bad_request("Managed endpoint configuration is required.")
        })?;
        if endpoint.get("providerKind").and_then(Value::as_str) != Some("cloudflare_tunnel")
            || !allowed_origin(object.get("origin"), &context)
        {
            return Err(ConnectMcpError::bad_request(
                "Invalid managed endpoint origin.",
            ));
        }
        let now = (self.config.now_epoch_seconds)();
        let (_, public_key) = (self.jwt.key_pair)()
            .await
            .map_err(|_| ConnectMcpError::internal("Could not generate environment link proof."))?;
        let signed_payload = json!({
            "iss": format!("bibcode-env:{}", self.config.environment_id),
            "aud": relay_issuer,
            "sub": self.config.environment_id,
            "jti": Uuid::new_v4().to_string(),
            "iat": now,
            "exp": now.saturating_add(PROOF_MAX_LIFETIME_SECONDS),
            "challenge": challenge,
            "descriptor": self.config.descriptor,
            "environmentId": self.config.environment_id,
            "environmentPublicKey": public_key.trim(),
            "endpoint": endpoint,
            "origin": object.get("origin").cloned().unwrap_or(Value::Null),
            "scopes": ["managed_tunnels"]
        });
        let proof = (self.jwt.sign)(RELAY_LINK_PROOF_TYP.into(), signed_payload)
            .await
            .map_err(|_| ConnectMcpError::internal("Could not generate environment link proof."))?;
        credential_response(json!(proof))
    }

    async fn relay_config(&self, payload: Value) -> Result<JsonRouteResponse, ConnectMcpError> {
        let _link_mutation = self.link_mutation.lock().await;
        let object = object(&payload)?;
        let relay_url = string_field(object, "relayUrl")?;
        validate_secure_url(relay_url, "Relay URL")?;
        let relay_issuer = optional_string_field(object, "relayIssuer")?.unwrap_or(relay_url);
        validate_secure_url(relay_issuer, "Relay issuer")?;
        let cloud_user_id = nonempty_field(object, "cloudUserId", "Cloud user id is required.")?;
        let environment_credential = nonempty_field(
            object,
            "environmentCredential",
            "Relay environment credential is required.",
        )?;
        let cloud_mint_public_key = nonempty_field(
            object,
            "cloudMintPublicKey",
            "Cloud mint public key must be a valid Ed25519 public key.",
        )?;
        if !cloud_mint_public_key.contains("BEGIN PUBLIC KEY") {
            return Err(ConnectMcpError::bad_request(
                "Cloud mint public key must be a valid Ed25519 public key.",
            ));
        }
        let existing = self.read_secret("cloud-linked-user-id").await?;
        // A background re-link names the link it set out to refresh; if another client
        // unlinked or re-linked meanwhile (even to the same account), it must not undo that.
        if let Some(required) = optional_string_field(object, "requireLinkGeneration")?
            && self.link_generation().await?.as_deref() != Some(required)
        {
            return Err(ConnectMcpError::conflict(
                "This environment's BiBCode Connect link changed. Link it again from Settings.",
            ));
        }
        if let Some(existing) = existing
            && existing != cloud_user_id
        {
            return Err(ConnectMcpError::conflict(
                "This environment is already linked to a different cloud account. Unlink it before switching accounts.",
            ));
        }
        let endpoint_config = object
            .get("endpointRuntime")
            .cloned()
            .unwrap_or(Value::Null);
        let endpoint_status = (self.endpoint.0)(endpoint_config.clone())
            .await
            .map_err(|_| {
                ConnectMcpError::internal("Managed endpoint runtime could not be started.")
            })?;
        let status = endpoint_status
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("failed");
        if !matches!(status, "disabled" | "running") {
            return Err(ConnectMcpError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "EnvironmentCloudEndpointUnavailableError",
                "Managed endpoint runtime could not be started.",
            ));
        }
        self.replace_link_config(LinkConfig {
            relay_url: relay_url.into(),
            relay_issuer: relay_issuer.into(),
            cloud_user_id: cloud_user_id.into(),
            environment_credential: environment_credential.into(),
            cloud_mint_public_key: cloud_mint_public_key.into(),
            endpoint_runtime: endpoint_config,
            // The relay just pointed the tunnel's ingress at this server's current port.
            origin_port: self.current_origin_port(),
        })
        .await?;
        Ok(JsonRouteResponse::ok(json!({
            "ok": true,
            "endpointRuntimeStatus": endpoint_status
        })))
    }

    async fn link_state(&self) -> Result<JsonRouteResponse, ConnectMcpError> {
        let values = self.read_link_state().await?;
        let endpoint = self.stored_endpoint_runtime().await?;
        let preview_hostnames = endpoint
            .as_ref()
            .and_then(|config| config.get("previewHostnames"))
            .and_then(Value::as_array)
            .is_some_and(|names| !names.is_empty());
        let stale = endpoint.is_some() && self.endpoint_origin_moved().await?;
        let generation = self.link_generation().await?;
        Ok(JsonRouteResponse::ok(json!({
            "linked": values.0.is_some(),
            "cloudUserId": values.0,
            "relayUrl": values.1,
            "relayIssuer": values.2,
            "managedEndpoint": endpoint.is_some(),
            "previewHostnames": preview_hostnames,
            "managedEndpointStale": stale,
            "linkGeneration": generation
        })))
    }

    /// Restarts the managed tunnel from the stored link after a server restart. An unlinked
    /// server, or a link without a managed endpoint, has nothing to restore.
    pub async fn restore_managed_endpoint(&self) -> Result<Option<Value>, ConnectMcpError> {
        let _link_mutation = self.link_mutation.lock().await;
        if self.read_secret("cloud-linked-user-id").await?.is_none() {
            return Ok(None);
        }
        let Some(config) = self.stored_endpoint_runtime().await? else {
            return Ok(None);
        };
        // The tunnel's ingress still points at the port of the last link; a connector for it
        // would report running while reaching nothing. The primary client re-links instead.
        if self.endpoint_origin_moved().await? {
            return Ok(Some(json!({ "status": "stale-origin" })));
        }
        (self.endpoint.0)(config).await.map(Some).map_err(|_| {
            ConnectMcpError::internal("Managed endpoint runtime could not be started.")
        })
    }

    /// Identifies the stored link: every link rotates the relay environment credential, so a
    /// domain-separated digest of it changes with each link without revealing it.
    async fn link_generation(&self) -> Result<Option<String>, ConnectMcpError> {
        Ok(self
            .read_secret("relay-environment-credential")
            .await?
            .map(|credential| {
                let digest = Sha256::digest(format!("bibcode-link-generation:{credential}"));
                URL_SAFE_NO_PAD.encode(&digest[..16])
            }))
    }

    /// This server's own listening port (its MCP endpoint is on the same listener).
    fn current_origin_port(&self) -> Option<u16> {
        self.config
            .mcp_endpoint
            .parse::<axum::http::Uri>()
            .ok()?
            .port_u16()
    }

    /// The stored link's tunnel was provisioned for another port than this server now
    /// listens on (the desktop picks a free port each launch). Links stored before the port
    /// was recorded count as current.
    async fn endpoint_origin_moved(&self) -> Result<bool, ConnectMcpError> {
        let stored = self
            .read_secret("cloud-endpoint-origin-port")
            .await?
            .and_then(|port| port.parse::<u16>().ok());
        Ok(stored.is_some_and(|stored| Some(stored) != self.current_origin_port()))
    }

    /// The stored, non-null managed endpoint runtime config.
    async fn stored_endpoint_runtime(&self) -> Result<Option<Value>, ConnectMcpError> {
        Ok(self
            .read_secret("cloud-endpoint-runtime-config")
            .await?
            .and_then(|stored| serde_json::from_str::<Value>(&stored).ok())
            .filter(|config| !config.is_null()))
    }

    async fn unlink(&self) -> Result<JsonRouteResponse, ConnectMcpError> {
        let _link_mutation = self.link_mutation.lock().await;
        let endpoint_status = (self.endpoint.0)(Value::Null).await.map_err(|_| {
            ConnectMcpError::internal("Could not disable managed endpoint runtime.")
        })?;
        self.clear_link_config().await?;
        Ok(JsonRouteResponse::ok(json!({
            "ok": true,
            "endpointRuntimeStatus": endpoint_status
        })))
    }

    async fn health(&self, payload: Value) -> Result<JsonRouteResponse, ConnectMcpError> {
        let proof_token = string_field(object(&payload)?, "proof")?;
        let linked = self.required_link_material().await?;
        let now = (self.config.now_epoch_seconds)();
        let proof = (self.jwt.verify)(
            linked.cloud_mint_public_key,
            RELAY_HEALTH_REQUEST_TYP.into(),
            proof_token.into(),
            linked.relay_issuer.clone(),
            format!("bibcode-env:{}", self.config.environment_id),
            now,
        )
        .await
        .map_err(|_| ConnectMcpError::unauthorized("Invalid cloud health request."))?;
        validate_cloud_proof(
            &proof,
            &self.config.environment_id,
            &linked.cloud_user_id,
            "environment:status",
            now,
            false,
        )?;
        self.consume_replay("health", &proof.jwt_id, &proof.nonce, now)
            .await
            .map_err(|error| match error.status {
                StatusCode::CONFLICT => {
                    ConnectMcpError::conflict("Cloud health request was already consumed.")
                }
                _ => error,
            })?;
        let checked_at = iso_timestamp(now)?;
        let response_payload = json!({
            "iss": format!("bibcode-env:{}", self.config.environment_id),
            "aud": linked.relay_issuer,
            "sub": self.config.environment_id,
            "jti": Uuid::new_v4().to_string(),
            "iat": now,
            "exp": now.saturating_add(PROOF_MAX_LIFETIME_SECONDS),
            "environmentId": self.config.environment_id,
            "requestNonce": proof.nonce,
            "status":"online",
            "descriptor": self.config.descriptor,
            "checkedAt": checked_at
        });
        let response_proof = (self.jwt.sign)(RELAY_HEALTH_RESPONSE_TYP.into(), response_payload)
            .await
            .map_err(|_| ConnectMcpError::internal("Could not answer cloud health request."))?;
        credential_response(json!({
            "environmentId": self.config.environment_id,
            "status":"online",
            "descriptor": self.config.descriptor,
            "checkedAt": checked_at,
            "proof": response_proof
        }))
    }

    async fn mint_credential(&self, payload: Value) -> Result<JsonRouteResponse, ConnectMcpError> {
        let proof_token = string_field(object(&payload)?, "proof")?;
        let linked = self.required_link_material().await?;
        let now = (self.config.now_epoch_seconds)();
        let proof = (self.jwt.verify)(
            linked.cloud_mint_public_key,
            RELAY_MINT_REQUEST_TYP.into(),
            proof_token.into(),
            linked.relay_issuer.clone(),
            format!("bibcode-env:{}", self.config.environment_id),
            now,
        )
        .await
        .map_err(|_| ConnectMcpError::unauthorized("Invalid cloud mint request."))?;
        validate_cloud_proof(
            &proof,
            &self.config.environment_id,
            &linked.cloud_user_id,
            "environment:connect",
            now,
            true,
        )?;
        self.consume_replay("mint", &proof.jwt_id, &proof.nonce, now)
            .await
            .map_err(|error| match error.status {
                StatusCode::CONFLICT => {
                    ConnectMcpError::conflict("Cloud mint request was already consumed.")
                }
                _ => error,
            })?;
        let thumbprint = proof
            .client_proof_key_thumbprint
            .clone()
            .ok_or_else(|| ConnectMcpError::unauthorized("Invalid cloud mint request."))?;
        let issued = (self.pairing.0)(thumbprint.clone()).await.map_err(|_| {
            ConnectMcpError::internal("Could not issue cloud connection credential.")
        })?;
        let expires_at_seconds = parse_iso_timestamp(&issued.expires_at)?;
        let response_payload = json!({
            "iss": format!("bibcode-env:{}", self.config.environment_id),
            "aud": linked.relay_issuer,
            "sub": self.config.environment_id,
            "jti": Uuid::new_v4().to_string(),
            "iat": now,
            "exp": expires_at_seconds,
            "environmentId": self.config.environment_id,
            "clientProofKeyThumbprint": thumbprint,
            "requestNonce": proof.nonce,
            "credential": issued.credential
        });
        let response_proof = (self.jwt.sign)(RELAY_MINT_RESPONSE_TYP.into(), response_payload)
            .await
            .map_err(|_| {
                ConnectMcpError::internal("Could not issue cloud connection credential.")
            })?;
        credential_response(json!({
            "credential": issued.credential,
            "expiresAt": issued.expires_at,
            "proof": response_proof
        }))
    }

    async fn mcp_post(
        &self,
        body: Vec<u8>,
        context: RouteContext,
    ) -> Result<McpHttpResponse, ConnectMcpError> {
        // The 2026-07-28 transport: a browser page must not reach this endpoint. No BiBCode
        // surface sends an Origin here, and the MCP clients providers run send none.
        if !origin_is_own(&context) {
            return Err(ConnectMcpError::mcp(
                StatusCode::FORBIDDEN,
                "MCP requests from a web page are not accepted.",
            ));
        }
        let token = bearer_token(&context)?.to_owned();
        let token_hash = hash_token(&token);
        let now = (self.config.now_epoch_seconds)();
        let provider_scope = {
            let mut state = self.mcp.lock().await;
            prune_mcp(&mut state, now);
            state.credentials.get_mut(&token_hash).map(|credential| {
                credential.last_used_at = now;
                credential.scope.clone()
            })
        };
        let principal = match provider_scope {
            Some(scope) => McpPrincipal::Provider(scope),
            None => match &self.control {
                Some(control) => McpPrincipal::Client(
                    control
                        .authenticate(&token)
                        .await
                        .ok_or_else(ConnectMcpError::invalid_mcp_credential)?,
                ),
                None => return Err(ConnectMcpError::invalid_mcp_credential()),
            },
        };
        let request = match protocol::parse(&body) {
            Incoming::Ignore => {
                return Ok(McpHttpResponse {
                    status: 202,
                    headers: BTreeMap::new(),
                    body: Vec::new(),
                    stream: None,
                });
            }
            Incoming::Reply(reply) => return mcp_json(StatusCode::BAD_REQUEST, &reply, None),
            Incoming::Request(request) => request,
        };
        if let Err(message) = check_transport_headers(&context, &request) {
            return mcp_json(
                StatusCode::BAD_REQUEST,
                &protocol::failure(
                    request.id,
                    protocol::rpc_error(protocol::HEADER_MISMATCH, &message),
                ),
                None,
            );
        }
        match principal {
            McpPrincipal::Provider(scope) => {
                self.provider_request(request, scope, token_hash, now, context)
                    .await
            }
            McpPrincipal::Client(principal) => {
                let control = self
                    .control
                    .clone()
                    .ok_or_else(ConnectMcpError::invalid_mcp_credential)?;
                client_request(control, request, principal, context).await
            }
        }
    }

    /// A provider's request: legacy sessions as providers already launched use them, or the
    /// modern era with no session. Only `preview_*` and `device_*`, each scope-checked.
    async fn provider_request(
        &self,
        request: protocol::Request,
        scope: PreviewScope,
        token_hash: String,
        now: i64,
        context: RouteContext,
    ) -> Result<McpHttpResponse, ConnectMcpError> {
        let method = request.method.as_str();
        let session_id = if request.modern {
            None
        } else {
            let mut state = self.mcp.lock().await;
            let supplied_session = context
                .headers
                .get("mcp-session-id")
                .and_then(|value| value.to_str().ok());
            Some(if method == "initialize" {
                if state.sessions.len() >= self.config.max_mcp_sessions.max(1) {
                    return Err(ConnectMcpError::mcp(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "MCP session capacity exceeded.",
                    ));
                }
                let session_id = Uuid::new_v4().to_string();
                state.sessions.insert(
                    session_id.clone(),
                    McpSessionRecord {
                        credential_hash: token_hash.clone(),
                        last_used_at: now,
                    },
                );
                session_id
            } else {
                let supplied = supplied_session.ok_or_else(|| {
                    ConnectMcpError::mcp(StatusCode::BAD_REQUEST, "MCP session id is required.")
                })?;
                let session = state.sessions.get_mut(supplied).ok_or_else(|| {
                    ConnectMcpError::mcp(StatusCode::NOT_FOUND, "MCP session was not found.")
                })?;
                if session.credential_hash != token_hash {
                    return Err(ConnectMcpError::invalid_mcp_credential());
                }
                session.last_used_at = now;
                supplied.to_owned()
            })
        };
        if context.cancellation.is_cancelled() && method != "tools/call" {
            return Err(ConnectMcpError::mcp(
                StatusCode::REQUEST_TIMEOUT,
                "MCP request was cancelled.",
            ));
        }
        let params = request.params.as_ref();
        let result = match method {
            "initialize" => Ok(protocol::initialize_result(
                params,
                json!({ "tools": { "listChanged": false } }),
                server_info(),
            )),
            "server/discover" => Ok(protocol::discover_result(
                json!({ "tools": { "listChanged": false } }),
                server_info(),
                PROVIDER_LIST_TTL_MS,
            )),
            "ping" => Ok(json!({})),
            "tools/list" => Ok(protocol::list_result(
                Value::Array(tool_descriptors(
                    self.devices.as_ref().is_some_and(DeviceTools::enabled),
                )),
                PROVIDER_LIST_TTL_MS,
            )),
            "tools/call" => {
                let name = params
                    .and_then(|params| params.get("name"))
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                let timer = crate::diagnostics::profiler::latency::RequestTimer::unary(
                    &crate::mcp::control::timing_name(&name),
                    &[],
                );
                let result = match authorize_call(PrincipalKind::Provider, PROVIDER_SCOPES, &name) {
                    Ok(_) => self.call_tool(params, scope, context.cancellation).await,
                    Err(refusal) => refusal,
                };
                finish_timer(timer, &name, &result);
                log_failure(&name, &result);
                Ok(result)
            }
            _ => Err(protocol::rpc_error(
                protocol::METHOD_NOT_FOUND,
                &format!("Method not found: {method}"),
            )),
        };
        let status = unknown_method_status(&request, &result);
        mcp_json(
            status,
            &protocol::finish(request.id, request.modern, result),
            session_id,
        )
    }

    async fn mcp_delete(&self, context: RouteContext) -> Result<McpHttpResponse, ConnectMcpError> {
        let token_hash = hash_token(bearer_token(&context)?);
        let now = (self.config.now_epoch_seconds)();
        let session_id = context
            .headers
            .get("mcp-session-id")
            .and_then(|value| value.to_str().ok())
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                ConnectMcpError::mcp(StatusCode::BAD_REQUEST, "MCP session id is required.")
            })?;
        let mut state = self.mcp.lock().await;
        prune_mcp(&mut state, now);
        let Some(session) = state.sessions.get(session_id) else {
            return Err(ConnectMcpError::mcp(
                StatusCode::NOT_FOUND,
                "MCP session was not found.",
            ));
        };
        if session.credential_hash != token_hash || !state.credentials.contains_key(&token_hash) {
            return Err(ConnectMcpError::invalid_mcp_credential());
        }
        state.sessions.remove(session_id);
        Ok(McpHttpResponse {
            status: 204,
            headers: BTreeMap::new(),
            body: Vec::new(),
            stream: None,
        })
    }

    async fn call_tool(
        &self,
        params: Option<&Value>,
        scope: PreviewScope,
        cancellation: CancellationToken,
    ) -> Value {
        let name = params
            .and_then(|value| value.get("name"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        let arguments = params
            .and_then(|value| value.get("arguments"))
            .cloned()
            .unwrap_or_else(|| json!({}));
        crate::mcp::tools::previews::run(
            scope,
            name,
            arguments,
            cancellation,
            &self.preview,
            self.devices.as_ref(),
        )
        .await
    }

    async fn read_secret(&self, name: &'static str) -> Result<Option<String>, ConnectMcpError> {
        let path = Arc::clone(&self.database_path);
        tokio::task::spawn_blocking(move || {
            let connection = open_database(path.as_ref())?;
            connection
                .query_row(
                    "SELECT value FROM connect_native_secrets WHERE name = ?1",
                    [name],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|error| error.to_string())
        })
        .await
        .map_err(|error| ConnectMcpError::internal(error.to_string()))?
        .map_err(|_| ConnectMcpError::internal("Could not read environment relay configuration."))
    }

    async fn replace_link_config(&self, config: LinkConfig) -> Result<(), ConnectMcpError> {
        let path = Arc::clone(&self.database_path);
        tokio::task::spawn_blocking(move || write_link_config(path.as_ref(), config))
            .await
            .map_err(|error| ConnectMcpError::internal(error.to_string()))?
            .map_err(|_| {
                ConnectMcpError::internal("Could not persist environment relay configuration.")
            })
    }

    async fn clear_link_config(&self) -> Result<(), ConnectMcpError> {
        let path = Arc::clone(&self.database_path);
        tokio::task::spawn_blocking(move || {
            let mut connection = open_database(path.as_ref())?;
            let transaction = connection.transaction().map_err(|error| error.to_string())?;
            transaction
                .execute(
                    "DELETE FROM connect_native_secrets WHERE name IN ('cloud-linked-user-id','relay-url','relay-issuer','relay-environment-credential','cloud-mint-public-key','cloud-endpoint-runtime-config','cloud-endpoint-origin-port')",
                    [],
                )
                .map_err(|error| error.to_string())?;
            transaction.commit().map_err(|error| error.to_string())
        })
        .await
        .map_err(|error| ConnectMcpError::internal(error.to_string()))?
        .map_err(|_| ConnectMcpError::internal("Could not remove environment relay configuration."))
    }

    async fn read_link_state(
        &self,
    ) -> Result<(Option<String>, Option<String>, Option<String>), ConnectMcpError> {
        let path = Arc::clone(&self.database_path);
        tokio::task::spawn_blocking(move || {
            let connection = open_database(path.as_ref())?;
            let mut result = HashMap::new();
            let mut statement = connection
                .prepare("SELECT name, value FROM connect_native_secrets WHERE name IN ('cloud-linked-user-id','relay-url','relay-issuer')")
                .map_err(|error| error.to_string())?;
            let rows = statement
                .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
                .map_err(|error| error.to_string())?;
            for row in rows {
                let (name, value) = row.map_err(|error| error.to_string())?;
                result.insert(name, value);
            }
            Ok::<_, String>((
                result.remove("cloud-linked-user-id"),
                result.remove("relay-url"),
                result.remove("relay-issuer"),
            ))
        })
        .await
        .map_err(|error| ConnectMcpError::internal(error.to_string()))?
        .map_err(|_| ConnectMcpError::internal("Could not read environment relay configuration."))
    }

    async fn required_link_material(&self) -> Result<LinkMaterial, ConnectMcpError> {
        let path = Arc::clone(&self.database_path);
        tokio::task::spawn_blocking(move || {
            let connection = open_database(path.as_ref())?;
            let read = |name: &str| {
                connection
                    .query_row(
                        "SELECT value FROM connect_native_secrets WHERE name = ?1",
                        [name],
                        |row| row.get::<_, String>(0),
                    )
                    .optional()
                    .map_err(|error| error.to_string())
            };
            let cloud_user_id = read("cloud-linked-user-id")?
                .ok_or_else(|| "linked cloud account is missing".to_owned())?;
            let relay_issuer = read("relay-issuer")?
                .or(read("relay-url")?)
                .ok_or_else(|| "relay issuer is missing".to_owned())?;
            let cloud_mint_public_key = read("cloud-mint-public-key")?
                .ok_or_else(|| "cloud mint public key is missing".to_owned())?;
            Ok::<_, String>(LinkMaterial {
                cloud_user_id,
                relay_issuer: normalize_issuer(&relay_issuer),
                cloud_mint_public_key,
            })
        })
        .await
        .map_err(|error| ConnectMcpError::internal(error.to_string()))?
        .map_err(|_| ConnectMcpError::internal("Could not read environment relay configuration."))
    }

    async fn consume_replay(
        &self,
        kind: &'static str,
        jwt_id: &str,
        nonce: &str,
        now: i64,
    ) -> Result<(), ConnectMcpError> {
        let path = Arc::clone(&self.database_path);
        let jwt_id = jwt_id.to_owned();
        let nonce = nonce.to_owned();
        tokio::task::spawn_blocking(move || {
            let mut connection = open_database(path.as_ref())?;
            let transaction = connection.transaction().map_err(|error| error.to_string())?;
            transaction
                .execute(
                    "DELETE FROM connect_native_replay WHERE consumed_at < ?1",
                    [now.saturating_sub(PROOF_MAX_LIFETIME_SECONDS + PROOF_CLOCK_SKEW_SECONDS)],
                )
                .map_err(|error| error.to_string())?;
            transaction
                .execute(
                    "DELETE FROM connect_native_replay WHERE rowid IN (
                       SELECT rowid FROM connect_native_replay
                       ORDER BY consumed_at DESC, rowid DESC LIMIT -1 OFFSET 4094
                     )",
                    [],
                )
                .map_err(|error| error.to_string())?;
            let first = transaction.execute(
                "INSERT OR IGNORE INTO connect_native_replay(kind, value, consumed_at) VALUES (?1, ?2, ?3)",
                params![format!("{kind}:jti"), jwt_id, now],
            ).map_err(|error| error.to_string())?;
            let second = transaction.execute(
                "INSERT OR IGNORE INTO connect_native_replay(kind, value, consumed_at) VALUES (?1, ?2, ?3)",
                params![format!("{kind}:nonce"), nonce, now],
            ).map_err(|error| error.to_string())?;
            if first != 1 || second != 1 {
                return Err("replay".to_owned());
            }
            transaction.commit().map_err(|error| error.to_string())
        })
        .await
        .map_err(|error| ConnectMcpError::internal(error.to_string()))?
        .map_err(|error| {
            if error == "replay" {
                ConnectMcpError::conflict("Cloud request was already consumed.")
            } else {
                ConnectMcpError::internal("Could not persist cloud request replay state.")
            }
        })
    }
}

struct LinkConfig {
    relay_url: String,
    relay_issuer: String,
    cloud_user_id: String,
    environment_credential: String,
    cloud_mint_public_key: String,
    endpoint_runtime: Value,
    /// The local port the tunnel's ingress was provisioned for.
    origin_port: Option<u16>,
}

struct LinkMaterial {
    cloud_user_id: String,
    relay_issuer: String,
    cloud_mint_public_key: String,
}

fn initialize_database(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let connection = open_database(path)?;
    connection
        .execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA synchronous=FULL;
             CREATE TABLE IF NOT EXISTS connect_native_secrets (
               name TEXT PRIMARY KEY NOT NULL,
               value TEXT NOT NULL
             ) STRICT;
             CREATE TABLE IF NOT EXISTS connect_native_replay (
               kind TEXT NOT NULL,
               value TEXT NOT NULL,
               consumed_at INTEGER NOT NULL,
               PRIMARY KEY(kind, value)
             ) STRICT;",
        )
        .map_err(|error| error.to_string())
}

fn open_database(path: &Path) -> Result<Connection, String> {
    let connection = Connection::open(path).map_err(|error| error.to_string())?;
    connection
        .busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|error| error.to_string())?;
    connection
        .execute_batch("PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;")
        .map_err(|error| error.to_string())?;
    Ok(connection)
}

fn write_link_config(path: &Path, config: LinkConfig) -> Result<(), String> {
    let mut connection = open_database(path)?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let values = [
        ("relay-url", config.relay_url),
        ("relay-issuer", config.relay_issuer),
        ("cloud-linked-user-id", config.cloud_user_id),
        (
            "relay-environment-credential",
            config.environment_credential,
        ),
        ("cloud-mint-public-key", config.cloud_mint_public_key),
        (
            "cloud-endpoint-runtime-config",
            config.endpoint_runtime.to_string(),
        ),
        (
            "cloud-endpoint-origin-port",
            config
                .origin_port
                .map(|port| port.to_string())
                .unwrap_or_default(),
        ),
    ];
    for (name, value) in values {
        transaction
            .execute(
                "INSERT INTO connect_native_secrets(name, value) VALUES (?1, ?2)
                 ON CONFLICT(name) DO UPDATE SET value = excluded.value",
                params![name, value],
            )
            .map_err(|error| error.to_string())?;
    }
    transaction.commit().map_err(|error| error.to_string())
}

fn validate_cloud_proof(
    proof: &DecodedCloudProof,
    environment_id: &str,
    cloud_user_id: &str,
    expected_scope: &str,
    now: i64,
    require_confirmation: bool,
) -> Result<(), ConnectMcpError> {
    let confirmation_matches = !require_confirmation
        || proof.client_proof_key_thumbprint.is_some()
            && proof.client_proof_key_thumbprint == proof.confirmation_thumbprint;
    if proof.environment_id != environment_id
        || proof.subject != cloud_user_id
        || proof.scope.as_slice() != [expected_scope]
        || proof.expires_at <= proof.issued_at
        || proof.expires_at.saturating_sub(proof.issued_at) > PROOF_MAX_LIFETIME_SECONDS
        || proof.issued_at > now.saturating_add(PROOF_CLOCK_SKEW_SECONDS)
        || proof.expires_at < now.saturating_sub(PROOF_CLOCK_SKEW_SECONDS)
        || !confirmation_matches
    {
        return Err(ConnectMcpError::unauthorized(if require_confirmation {
            "Invalid cloud mint request."
        } else {
            "Invalid cloud health request."
        }));
    }
    Ok(())
}

fn required_payload(payload: Option<Value>) -> Result<Value, ConnectMcpError> {
    payload.ok_or_else(|| ConnectMcpError::bad_request("Request body is required."))
}

fn object(value: &Value) -> Result<&Map<String, Value>, ConnectMcpError> {
    value
        .as_object()
        .ok_or_else(|| ConnectMcpError::bad_request("Request body must be a JSON object."))
}

fn string_field<'a>(
    object: &'a Map<String, Value>,
    name: &str,
) -> Result<&'a str, ConnectMcpError> {
    object
        .get(name)
        .and_then(Value::as_str)
        .ok_or_else(|| ConnectMcpError::bad_request(format!("{name} must be a string.")))
}

fn optional_string_field<'a>(
    object: &'a Map<String, Value>,
    name: &str,
) -> Result<Option<&'a str>, ConnectMcpError> {
    match object.get(name) {
        None => Ok(None),
        Some(value) => value
            .as_str()
            .map(Some)
            .ok_or_else(|| ConnectMcpError::bad_request(format!("{name} must be a string."))),
    }
}

fn nonempty_field<'a>(
    object: &'a Map<String, Value>,
    name: &str,
    message: &'static str,
) -> Result<&'a str, ConnectMcpError> {
    string_field(object, name).and_then(|value| {
        if value.trim().is_empty() {
            Err(ConnectMcpError::bad_request(message))
        } else {
            Ok(value)
        }
    })
}

fn validate_secure_url(value: &str, label: &str) -> Result<(), ConnectMcpError> {
    let parsed = url::Url::parse(value).map_err(|_| {
        ConnectMcpError::bad_request(format!("{label} must be a secure absolute HTTPS URL."))
    })?;
    if parsed.scheme() != "https"
        || parsed.host_str().is_none()
        || parsed.username() != ""
        || parsed.password().is_some()
    {
        return Err(ConnectMcpError::bad_request(format!(
            "{label} must be a secure absolute HTTPS URL."
        )));
    }
    Ok(())
}

fn normalize_issuer(value: &str) -> String {
    value.trim().trim_end_matches('/').to_owned()
}

fn allowed_origin(origin: Option<&Value>, context: &RouteContext) -> bool {
    let Some(origin) = origin.and_then(Value::as_object) else {
        return false;
    };
    let host = origin
        .get("localHttpHost")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim_matches(['[', ']'])
        .to_ascii_lowercase();
    let port = origin.get("localHttpPort").and_then(Value::as_u64);
    // HTTP/1.1 requests carry an origin-form target, so the authority comes from Host.
    let Some(authority) = context.uri.authority().cloned().or_else(|| {
        context
            .headers
            .get(header::HOST)?
            .to_str()
            .ok()?
            .parse::<axum::http::uri::Authority>()
            .ok()
    }) else {
        return false;
    };
    let request_host = authority
        .host()
        .trim_matches(['[', ']'])
        .to_ascii_lowercase();
    let request_port = authority.port_u16().map(u64::from).unwrap_or(80);
    matches!(host.as_str(), "127.0.0.1" | "::1" | "localhost")
        && matches!(request_host.as_str(), "127.0.0.1" | "::1" | "localhost")
        && port == Some(request_port)
        && !context.headers.contains_key("x-forwarded-host")
        && !context.headers.contains_key("x-forwarded-proto")
}

fn credential_response(body: Value) -> Result<JsonRouteResponse, ConnectMcpError> {
    Ok(JsonRouteResponse {
        status: StatusCode::OK,
        headers: BTreeMap::from([
            ("cache-control".into(), "no-store".into()),
            ("pragma".into(), "no-cache".into()),
        ]),
        body,
    })
}

fn iso_timestamp(epoch_seconds: i64) -> Result<String, ConnectMcpError> {
    time::OffsetDateTime::from_unix_timestamp(epoch_seconds)
        .map_err(|error| ConnectMcpError::internal(error.to_string()))?
        .format(&time::format_description::well_known::Rfc3339)
        .map_err(|error| ConnectMcpError::internal(error.to_string()))
}

fn parse_iso_timestamp(value: &str) -> Result<i64, ConnectMcpError> {
    time::OffsetDateTime::parse(value, &time::format_description::well_known::Rfc3339)
        .map(|timestamp| timestamp.unix_timestamp())
        .map_err(|_| ConnectMcpError::internal("Could not issue cloud connection credential."))
}

fn bearer_token(context: &RouteContext) -> Result<&str, ConnectMcpError> {
    context
        .headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(ConnectMcpError::invalid_mcp_credential)
}

fn hash_token(token: &str) -> String {
    let digest = Sha256::digest(token.as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn prune_mcp(state: &mut McpState, now: i64) {
    state.credentials.retain(|_, record| {
        record.expires_at >= now && now.saturating_sub(record.last_used_at) <= MCP_IDLE_SECONDS
    });
    let live_credentials = state.credentials.keys().cloned().collect::<Vec<_>>();
    state.sessions.retain(|_, session| {
        live_credentials.contains(&session.credential_hash)
            && now.saturating_sub(session.last_used_at) <= MCP_IDLE_SECONDS
    });
}

/// The two kinds of credential `/mcp` accepts. Any other bearer gets 401.
enum McpPrincipal {
    /// A provider BiBCode launched: the random token in `McpState`.
    Provider(PreviewScope),
    /// An outside agent: a signed `mcp-client` session.
    Client(ClientPrincipal),
}

/// How long a provider may cache its tool list.
const PROVIDER_LIST_TTL_MS: u64 = 60_000;

fn server_info() -> Value {
    json!({ "name": "BiBCode", "version": env!("CARGO_PKG_VERSION") })
}

/// Whether the request carries no `Origin`, or this server's own (from its `Host`).
fn origin_is_own(context: &RouteContext) -> bool {
    let Some(origin) = context.headers.get(header::ORIGIN) else {
        return true;
    };
    let Some(host) = context
        .headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
    else {
        return false;
    };
    origin.to_str().ok().is_some_and(|origin| {
        let origin = origin.trim_end_matches('/');
        origin.eq_ignore_ascii_case(&format!("http://{host}"))
            || origin.eq_ignore_ascii_case(&format!("https://{host}"))
    })
}

/// A modern request names its version, method and (for a call) tool in headers that must
/// match its body; a legacy request may repeat its negotiated version, which must be one this
/// server speaks.
fn check_transport_headers(
    context: &RouteContext,
    request: &protocol::Request,
) -> Result<(), String> {
    let header = |name: &str| {
        context
            .headers
            .get(name)
            .and_then(|value| value.to_str().ok())
    };
    if !request.modern {
        return match header("mcp-protocol-version") {
            Some(version) if !protocol::VERSIONS.contains(&version) => Err(format!(
                "MCP-Protocol-Version {} is not supported",
                protocol::bounded(version)
            )),
            _ => Ok(()),
        };
    }
    if request.method == "server/discover"
        && protocol::modern_version(request.params.as_ref()).is_none()
    {
        return Ok(());
    }
    let version = protocol::modern_version(request.params.as_ref());
    if header("mcp-protocol-version") != version {
        return Err("MCP-Protocol-Version must match the request's protocol version".into());
    }
    if header("mcp-method") != Some(request.method.as_str()) {
        return Err("Mcp-Method must match the request's method".into());
    }
    if request.method == "tools/call" {
        let name = request
            .params
            .as_ref()
            .and_then(|params| params.get("name"))
            .and_then(Value::as_str);
        if header("mcp-name") != name {
            return Err("Mcp-Name must match the called tool's name".into());
        }
    }
    Ok(())
}

/// 404 for an unknown method in the modern era, as the 2026-07-28 transport asks; the legacy
/// era answers it in a 200 body, as before.
fn unknown_method_status(request: &protocol::Request, result: &Result<Value, Value>) -> StatusCode {
    match result {
        Err(error) if request.modern && error["code"] == protocol::METHOD_NOT_FOUND => {
            StatusCode::NOT_FOUND
        }
        _ => StatusCode::OK,
    }
}

fn mcp_json(
    status: StatusCode,
    message: &Value,
    session_id: Option<String>,
) -> Result<McpHttpResponse, ConnectMcpError> {
    let mut headers = BTreeMap::from([("content-type".into(), "application/json".into())]);
    if let Some(session_id) = session_id {
        headers.insert("mcp-session-id".into(), session_id);
    }
    Ok(McpHttpResponse {
        status: status.as_u16(),
        headers,
        body: serde_json::to_vec(message)
            .map_err(|error| ConnectMcpError::internal(error.to_string()))?,
        stream: None,
    })
}

fn finish_timer(
    timer: Option<crate::diagnostics::profiler::latency::RequestTimer>,
    tool: &str,
    result: &Value,
) {
    if let Some(timer) = timer {
        let outcome = if result["isError"] == true {
            "failure"
        } else {
            "success"
        };
        timer.finish(&crate::mcp::control::timing_name(tool), outcome);
    }
}

/// An outside agent's request. Client principals hold no HTTP session: the bearer, a durable
/// session row, identifies the caller, so a restart or an off/on cycle loses nothing.
async fn client_request(
    control: McpControl,
    request: protocol::Request,
    principal: ClientPrincipal,
    context: RouteContext,
) -> Result<McpHttpResponse, ConnectMcpError> {
    let method = request.method.as_str();
    let params = request.params.as_ref();
    let disabled = || {
        Err(json!({
            "code": crate::mcp::control::DISABLED_CODE,
            "message": crate::mcp::control::DISABLED_MESSAGE,
            "data": { "_tag": crate::mcp::control::DISABLED_TAG },
        }))
    };
    let enabled = control.settings().enabled;
    let result = match method {
        "initialize" if enabled => Ok(protocol::initialize_result(
            params,
            json!({ "tools": { "listChanged": false } }),
            server_info(),
        )),
        "server/discover" if enabled => Ok(protocol::discover_result(
            json!({ "tools": { "listChanged": false } }),
            server_info(),
            control.list_ttl_ms(),
        )),
        "ping" => Ok(json!({})),
        "tools/list" if enabled => Ok(protocol::list_result(
            control.tools(&principal),
            control.list_ttl_ms(),
        )),
        "initialize" | "server/discover" | "tools/list" => disabled(),
        "tools/call" => {
            let name = params
                .and_then(|params| params.get("name"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            let arguments = match params.and_then(|params| params.get("arguments")) {
                None | Some(Value::Null) => Map::new(),
                Some(Value::Object(arguments)) => arguments.clone(),
                Some(_) => {
                    return mcp_json(
                        StatusCode::OK,
                        &protocol::failure(
                            request.id,
                            protocol::invalid("arguments must be an object"),
                        ),
                        None,
                    );
                }
            };
            let progress_token = params
                .and_then(|params| params.pointer("/_meta/progressToken"))
                .filter(|token| token.is_string() || token.is_number())
                .cloned();
            if let (true, Some(token)) = (name == "wait_for_thread", progress_token) {
                return Ok(progress_stream(
                    control, request, principal, name, arguments, token,
                ));
            }
            let timer = crate::diagnostics::profiler::latency::RequestTimer::unary(
                &crate::mcp::control::timing_name(&name),
                &[],
            );
            let result = control
                .call(&principal, &name, &arguments, None, context.cancellation)
                .await;
            finish_timer(timer, &name, &result);
            Ok(result)
        }
        _ => Err(protocol::rpc_error(
            protocol::METHOD_NOT_FOUND,
            &format!("Method not found: {method}"),
        )),
    };
    let status = unknown_method_status(&request, &result);
    mcp_json(
        status,
        &protocol::finish(request.id, request.modern, result),
        None,
    )
}

/// Logs a failed provider tool call at the `/mcp` boundary: the tool and the error type only,
/// never its arguments. (`McpControl::call` logs the outside agents' calls.)
fn log_failure(tool: &str, result: &Value) {
    if result["isError"] == true {
        let tag = result["structuredContent"]["error"]["_tag"]
            .as_str()
            .unwrap_or("McpToolError");
        tracing::warn!(tool, error = tag, "MCP tool call failed");
    }
}

/// A `wait_for_thread` call that asked for progress: `text/event-stream`, with each
/// `notifications/progress` and then the result as its own event. Closing the stream cancels
/// the wait, which drops its event receiver.
fn progress_stream(
    control: McpControl,
    request: protocol::Request,
    principal: ClientPrincipal,
    name: String,
    arguments: Map<String, Value>,
    token: Value,
) -> McpHttpResponse {
    let (frames, receiver) = tokio::sync::mpsc::channel::<Vec<u8>>(8);
    let (progress, mut notifications) = tokio::sync::mpsc::channel::<Value>(8);
    let cancellation = CancellationToken::new();
    tokio::spawn(async move {
        let timer = crate::diagnostics::profiler::latency::RequestTimer::unary(
            &crate::mcp::control::timing_name(&name),
            &[],
        );
        let call = control.call(
            &principal,
            &name,
            &arguments,
            Some((progress, token)),
            cancellation.clone(),
        );
        tokio::pin!(call);
        let result = loop {
            tokio::select! {
                result = &mut call => break Some(result),
                () = frames.closed() => {
                    cancellation.cancel();
                    break None;
                }
                Some(notification) = notifications.recv() => {
                    if frames.send(sse_frame(&notification)).await.is_err() {
                        cancellation.cancel();
                        break None;
                    }
                }
            }
        };
        let Some(result) = result else {
            // The client went away: the wait above was dropped with its receiver.
            return;
        };
        finish_timer(timer, &name, &result);
        while let Ok(notification) = notifications.try_recv() {
            let _ = frames.send(sse_frame(&notification)).await;
        }
        let _ = frames
            .send(sse_frame(&protocol::finish(
                request.id,
                request.modern,
                Ok(result),
            )))
            .await;
    });
    McpHttpResponse {
        status: 200,
        headers: BTreeMap::from([
            ("content-type".into(), "text/event-stream".into()),
            ("x-accel-buffering".into(), "no".into()),
        ]),
        body: Vec::new(),
        stream: Some(receiver),
    }
}

fn sse_frame(message: &Value) -> Vec<u8> {
    format!("event: message\ndata: {message}\n\n").into_bytes()
}
fn tool_descriptors(devices_enabled: bool) -> Vec<Value> {
    let mut tools = crate::mcp::tools::previews::preview_tool_descriptors();
    if devices_enabled {
        tools.extend(device_tool_descriptors());
    }
    tools
}

#[cfg(test)]
mod tests;
