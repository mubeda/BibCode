use serde::{Deserialize, Serialize};

pub const SCOPE_ORCHESTRATION_READ: &str = "orchestration:read";
pub const SCOPE_ORCHESTRATION_OPERATE: &str = "orchestration:operate";
pub const SCOPE_TERMINAL_OPERATE: &str = "terminal:operate";
pub const SCOPE_REVIEW_WRITE: &str = "review:write";
pub const SCOPE_ACCESS_READ: &str = "access:read";
pub const SCOPE_ACCESS_WRITE: &str = "access:write";
pub const SCOPE_RELAY_READ: &str = "relay:read";
pub const SCOPE_RELAY_WRITE: &str = "relay:write";
/// Only `server.downloadDiagnosticLogs`: the credential `bibcode diagnostics pair` holds (#202).
pub const SCOPE_DIAGNOSTICS_READ: &str = "diagnostics:read";

pub const ALL_SCOPES: &[&str] = &[
    SCOPE_ORCHESTRATION_READ,
    SCOPE_ORCHESTRATION_OPERATE,
    SCOPE_TERMINAL_OPERATE,
    SCOPE_REVIEW_WRITE,
    SCOPE_ACCESS_READ,
    SCOPE_ACCESS_WRITE,
    SCOPE_RELAY_READ,
    SCOPE_RELAY_WRITE,
    SCOPE_DIAGNOSTICS_READ,
];

/// The scopes of an outside agent's MCP credential (#139): never `terminal:operate`,
/// `access:*` or `relay:*`.
pub const MCP_CLIENT_SCOPES: &[&str] = &[SCOPE_ORCHESTRATION_READ, SCOPE_ORCHESTRATION_OPERATE];

/// The one scope a diagnostics-only pairing offer grants.
pub const DIAGNOSTICS_SCOPES: &[&str] = &[SCOPE_DIAGNOSTICS_READ];

/// Whether a credential holding `granted` may do what `required` allows. Exact match, plus
/// one implication: `orchestration:read` already reads the redacted diagnostic bundle, so it
/// satisfies `diagnostics:read`. The implication is one-way.
#[must_use]
pub fn scope_satisfies<S: AsRef<str>>(granted: &[S], required: &str) -> bool {
    granted.iter().any(|scope| {
        let scope = scope.as_ref();
        scope == required
            || (required == SCOPE_DIAGNOSTICS_READ && scope == SCOPE_ORCHESTRATION_READ)
    })
}

pub const STANDARD_SCOPES: &[&str] = &[
    SCOPE_ORCHESTRATION_READ,
    SCOPE_ORCHESTRATION_OPERATE,
    SCOPE_TERMINAL_OPERATE,
    SCOPE_REVIEW_WRITE,
    SCOPE_RELAY_READ,
];

pub const ADMINISTRATIVE_SCOPES: &[&str] = &[
    SCOPE_ORCHESTRATION_READ,
    SCOPE_ORCHESTRATION_OPERATE,
    SCOPE_TERMINAL_OPERATE,
    SCOPE_REVIEW_WRITE,
    SCOPE_RELAY_READ,
    SCOPE_ACCESS_READ,
    SCOPE_ACCESS_WRITE,
    SCOPE_RELAY_WRITE,
];

pub const TOKEN_GRANT_TYPE: &str = "urn:ietf:params:oauth:grant-type:token-exchange";
pub const ACCESS_TOKEN_TYPE: &str = "urn:ietf:params:oauth:token-type:access_token";
pub const BOOTSTRAP_TOKEN_TYPE: &str = "urn:bibcode:params:oauth:token-type:environment-bootstrap";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthDescriptor {
    pub policy: &'static str,
    pub bootstrap_methods: Vec<&'static str>,
    pub session_methods: [&'static str; 3],
    pub session_cookie_name: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct BrowserSessionRequest {
    pub credential: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSessionResult {
    pub authenticated: bool,
    pub scopes: Vec<String>,
    pub session_method: String,
    pub expires_at: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct TokenExchangeRequest {
    pub grant_type: String,
    pub subject_token: String,
    pub subject_token_type: String,
    pub requested_token_type: String,
    pub scope: Option<String>,
    pub client_label: Option<String>,
    pub client_device_type: Option<String>,
    pub client_os: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct AccessTokenResult {
    pub access_token: String,
    pub issued_token_type: &'static str,
    pub token_type: &'static str,
    pub expires_in: i64,
    pub scope: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebSocketTicketResult {
    pub ticket: String,
    pub expires_at: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct CreatePairingRequest {
    pub label: Option<String>,
    pub scopes: Option<Vec<String>>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingCredentialResult {
    pub id: String,
    pub credential: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub expires_at: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct CreatePairingOfferRequest {
    pub name: String,
    pub endpoint: String,
    pub reach: String,
    pub label: Option<String>,
    pub scopes: Option<Vec<String>>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelPairingOfferRequest {
    pub idempotency_key: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingOfferResult {
    pub id: String,
    pub code: String,
    pub reach: String,
    pub endpoint: String,
    pub name: String,
    pub expires_at: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareExposureState {
    pub desired_exposure: String,
    pub off_host_grant_count: usize,
    pub legacy_grant_count: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingLinkView {
    pub id: String,
    pub credential: String,
    pub scopes: Vec<String>,
    pub subject: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub created_at: String,
    pub expires_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reach: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct RevokePairingRequest {
    pub id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevokeClientRequest {
    pub session_id: String,
    /// **Stop** for an outside agent (#139, slice X1): also interrupt each running turn whose
    /// latest user message it sent. A plain revocation interrupts nothing.
    #[serde(default)]
    pub interrupt_turns: bool,
}

/// `POST /api/auth/clients/mcp-access`: **Take over** sets `read-only`; **Hand back** restores
/// the level Take over replaced, and nothing else.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpAccessRequest {
    pub session_id: String,
    pub access: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientMetadata {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ip_address: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_agent: Option<String>,
    pub device_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub os: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub browser: Option<String>,
}

impl Default for ClientMetadata {
    fn default() -> Self {
        Self {
            label: None,
            ip_address: None,
            user_agent: None,
            device_type: "unknown".to_owned(),
            os: None,
            browser: None,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientSessionView {
    pub session_id: String,
    pub subject: String,
    pub scopes: Vec<String>,
    pub method: String,
    pub client: ClientMetadata,
    pub issued_at: String,
    pub expires_at: String,
    pub last_connected_at: Option<String>,
    pub connected: bool,
    pub current: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reach: Option<String>,
    /// An outside agent's access ceiling (`mcp-client` sessions only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mcp_access: Option<String>,
    /// The access a person's Take over replaced; set while the agent is taken over.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mcp_access_hand_back: Option<String>,
}

#[derive(Clone, Debug)]
pub(crate) enum AuthAccessChange {
    PairingLinkUpserted(PairingLinkView),
    PairingLinkRemoved { id: String },
    ClientUpserted(ClientSessionView),
    ClientRemoved { session_id: String },
}

#[derive(Clone, Debug)]
pub(crate) struct AuthAccessEvent {
    pub revision: u64,
    pub change: AuthAccessChange,
}

#[derive(Clone, Debug)]
pub struct Principal {
    pub session_id: String,
    pub subject: String,
    pub method: String,
    pub scopes: Vec<String>,
    pub proof_key_thumbprint: Option<String>,
    pub expires_at_ms: i64,
}

impl Principal {
    #[must_use]
    pub fn has_scope(&self, scope: &str) -> bool {
        scope_satisfies(&self.scopes, scope)
    }
}
