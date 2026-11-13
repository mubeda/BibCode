use std::{
    collections::{HashMap, HashSet},
    net::IpAddr,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use subtle::ConstantTimeEq;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use tokio::sync::{Mutex, OwnedMutexGuard, broadcast};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::{
    HostIdentity,
    dpop::DpopVerifier,
    limits::{
        MAX_ACTIVE_PAIRING_OFFERS, MAX_ACTIVE_PAIRING_OFFERS_PER_PRINCIPAL, MAX_ACTIVE_PAIRINGS,
        MAX_ACTIVE_SESSIONS,
    },
    model::{
        ADMINISTRATIVE_SCOPES, ALL_SCOPES, AuthAccessChange, AuthAccessEvent, AuthDescriptor,
        ClientMetadata, ClientSessionView, McpNamedClientView, PairingCredentialResult,
        PairingLinkView, PairingOfferResult, PendingMcpAuthorizationView, Principal,
        STANDARD_SCOPES, ShareExposureState,
    },
    secret_store::SecretStore,
    token::{SessionClaims, TokenError, TokenSigner, WebSocketClaims},
};
use crate::config::{ServerConfig, ServerMode};
use crate::persistence::{
    AuthAuthoritySnapshot as PersistedAuthAuthoritySnapshot,
    AuthPairingLink as PersistedPairingLink, AuthPairingOffer as PersistedPairingOffer,
    AuthSession as PersistedAuthSession, AuthSessionClient as PersistedAuthSessionClient,
    AuthSessionDeliveryState, LiveMcpNamedClient, McpNamedClient, McpOAuthAuthorization,
    McpOAuthCodeExchange, McpOAuthExchangeOutcome, McpOAuthRefreshOutcome, McpOAuthRefreshRotation,
    NewAuthPairingOffer, NewAuthSession, PersistenceError, Repositories, RevokedAccess,
};

const SESSION_TTL_MS: i64 = 30 * 24 * 60 * 60 * 1_000;
/// Reads a session refresh makes before it keeps the cached record instead (#324).
const MAX_REFRESH_READS: usize = 8;
const DPOP_SESSION_TTL_MS: i64 = 60 * 60 * 1_000;
const WEBSOCKET_TICKET_TTL_MS: i64 = 5 * 60 * 1_000;
/// Pending pairing sessions and offer reservations older than this are crash
/// orphans. Younger rows may still belong to a live request or confirmation and
/// are left alone.
const PENDING_PAIRING_SWEEP_GRACE_MS: i64 = 2 * 60 * 1_000;
const PENDING_PAIRING_SWEEP_INTERVAL: Duration = Duration::from_secs(60);
const PAIRING_TTL_MS: i64 = 5 * 60 * 1_000;
const CLOUD_PAIRING_TTL_MS: i64 = 2 * 60 * 1_000;
const DESKTOP_BOOTSTRAP_TTL_MS: i64 = 24 * 60 * 60 * 1_000;
/// Subject of every session minted from the desktop bootstrap credential: the desktop app's
/// own WebView.
pub(crate) const DESKTOP_BOOTSTRAP_SUBJECT: &str = "desktop-bootstrap";
/// The subject of an outside agent's MCP credential (#139). Such a session authenticates
/// `/mcp` only, through [`AuthService::authenticate_mcp_client`]; every other bearer, cookie,
/// ticket and E2EE path refuses it, so the tools it is given are all it can reach.
pub(crate) const MCP_CLIENT_SUBJECT: &str = "mcp-client";
/// How long the relay's MCP pairing link lives: it exchanges it at once.
const MCP_PAIRING_TTL_MS: i64 = 60 * 1_000;
const PAIRING_ALPHABET: &[u8] = b"23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const PAIRING_LENGTH: usize = 12;
const PAIRING_REJECTION_LIMIT: u8 =
    (u8::MAX as usize / PAIRING_ALPHABET.len() * PAIRING_ALPHABET.len()) as u8;
const ACCESS_EVENT_CAPACITY: usize = 64;
const AUTHORITY_CONVERGENCE_INTERVAL: Duration = Duration::from_millis(250);
pub(crate) const PAIRING_REACH_ANOTHER_DEVICE: &str = "another-device";
pub(crate) const PAIRING_REACH_THIS_COMPUTER: &str = "this-computer";
pub(crate) const PAIRING_REACH_CUSTOM: &str = "custom";
pub(crate) const PAIRING_REACH_VALUES: [&str; 3] = [
    PAIRING_REACH_ANOTHER_DEVICE,
    PAIRING_REACH_THIS_COMPUTER,
    PAIRING_REACH_CUSTOM,
];

fn is_valid_pairing_reach(value: &str) -> bool {
    PAIRING_REACH_VALUES.contains(&value)
}

#[derive(Clone, Debug)]
pub enum AuthError {
    MissingCredential,
    InvalidCredential,
    InvalidScope,
    ScopeNotGranted,
    ScopeRequired(String),
    CurrentSessionRevokeNotAllowed,
    /// A cookie-authenticated mutation or WebSocket upgrade from an untrusted `Origin`.
    Forbidden,
    Internal(String),
}

#[derive(Clone)]
pub struct AuthService {
    descriptor: AuthDescriptor,
    host_identity: HostIdentity,
    desktop_bootstrap: Option<DesktopBootstrap>,
    signer: TokenSigner,
    state: Arc<Mutex<AuthState>>,
    issuance: Arc<Mutex<()>>,
    pairing_offer_issuance: Arc<Mutex<()>>,
    repositories: Option<Repositories>,
    access_events: Arc<broadcast::Sender<AuthAccessEvent>>,
    /// How Stop (#139, slice X1) has the MCP service interrupt a stopped agent's turns: a
    /// revocation with `interruptTurns`. A plain revocation is not a stop.
    mcp_stop_handler: Arc<std::sync::Mutex<Option<McpStopHandler>>>,
    /// The environment's MCP settings, as remote MCP's OAuth routes read them (slice R).
    mcp_oauth_settings: Arc<std::sync::Mutex<Option<McpOAuthSettingsSource>>>,
    access_revision: Arc<AtomicU64>,
    authority_watcher_running: Arc<AtomicBool>,
    /// Redeemed single-use websocket ticket ids, pruned by expiry.
    redeemed_websocket_tickets: Arc<std::sync::Mutex<HashMap<String, i64>>>,
    dpop: DpopVerifier,
    /// Non-request origins that may use the session cookie for mutations: the dev UI only.
    trusted_cookie_origins: Arc<[String]>,
    #[cfg(test)]
    test_hooks: Arc<AuthTestHooks>,
}

/// Reached, then resumed: where a test holds an exchange.
#[cfg(test)]
pub(crate) type TestHold = (
    tokio::sync::oneshot::Sender<()>,
    tokio::sync::oneshot::Receiver<()>,
);

#[cfg(test)]
#[derive(Default)]
pub(crate) struct AuthTestHooks {
    pub(crate) after_consume: std::sync::Mutex<Option<TestHold>>,
    /// After the session row commits, before the cache holds it.
    pub(crate) after_session_insert: std::sync::Mutex<Option<TestHold>>,
    /// After a session refresh read its row, before it takes the state lock (#324).
    pub(crate) after_refresh_read: std::sync::Mutex<Option<TestHold>>,
    /// Bumps the generation on every refresh read, as constant local churn would (#324).
    pub(crate) churn_refresh: std::sync::atomic::AtomicBool,
    /// Immediately before issuance sends its ClientUpserted, wherever that send sits (#294).
    pub(crate) before_session_upsert_event: std::sync::Mutex<Option<TestHold>>,
    /// Gives `mcp-client` sessions random ids, as a server before #281 did.
    pub(crate) random_mcp_session_ids: AtomicBool,
}

#[cfg(test)]
async fn reach_hold(slot: &std::sync::Mutex<Option<TestHold>>) {
    let hold = slot.lock().unwrap().take();
    if let Some((reached, resume)) = hold {
        let _ = reached.send(());
        let _ = resume.await;
    }
}

pub(crate) struct AuthenticatedConnectionGuard {
    auth: AuthService,
    session_id: String,
    connection_id: Option<u64>,
}

impl AuthenticatedConnectionGuard {
    pub(crate) async fn close(mut self) {
        self.disconnect().await;
    }

    async fn disconnect(&mut self) {
        let Some(connection_id) = self.connection_id.take() else {
            return;
        };
        self.auth
            .mark_disconnected(&self.session_id, connection_id)
            .await;
    }
}

impl Drop for AuthenticatedConnectionGuard {
    fn drop(&mut self) {
        let Some(connection_id) = self.connection_id.take() else {
            return;
        };
        let auth = self.auth.clone();
        let session_id = self.session_id.clone();
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            tracing::error!(
                %session_id,
                connection_id,
                "unable to schedule authenticated connection cleanup"
            );
            return;
        };
        runtime.spawn(async move {
            auth.mark_disconnected(&session_id, connection_id).await;
        });
    }
}

struct PendingSessionIssuanceGuard {
    auth: AuthService,
    session_id: String,
    armed: bool,
}

impl PendingSessionIssuanceGuard {
    fn new(auth: AuthService, session_id: String) -> Self {
        Self {
            auth,
            session_id,
            armed: true,
        }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for PendingSessionIssuanceGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let auth = self.auth.clone();
        let session_id = self.session_id.clone();
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            tracing::error!(
                session_id,
                "unable to schedule compensation for cancelled pending session issuance"
            );
            return;
        };
        runtime.spawn(async move {
            if let Err(error) = auth.revoke_failed_pairing_session(&session_id).await {
                tracing::error!(
                    session_id,
                    ?error,
                    "failed to compensate cancelled pending session issuance"
                );
            }
        });
    }
}

#[derive(Clone)]
struct DesktopBootstrap {
    credential: String,
    expires_at_ms: i64,
}

#[derive(Default)]
struct AuthState {
    sessions: HashMap<String, SessionRecord>,
    pairings: HashMap<String, PairingRecord>,
    pairing_offer_idempotency: HashMap<(String, String), StoredPairingOffer>,
    live_connections: HashMap<String, HashMap<u64, CancellationToken>>,
    next_connection_id: u64,
    authority_generation: u64,
    /// Remote MCP authorizations waiting for a person (slice R), oldest first.
    pending_mcp: Vec<PendingMcpAuthorizationView>,
    /// Named MCP clients not yet ended (#324), oldest first.
    named_clients: Vec<LiveMcpNamedClient>,
}

impl AuthState {
    fn bump_authority_generation(&mut self) {
        self.authority_generation = self.authority_generation.wrapping_add(1);
    }
}

#[derive(Clone)]
struct StoredPairingOffer {
    input_fingerprint: String,
    pairing_id: Option<String>,
    result: Option<PairingOfferResult>,
    expires_at_ms: i64,
}

pub(crate) struct PairingOfferReservation {
    principal_id: String,
    idempotency_key: String,
    input_fingerprint: String,
}

impl PairingOfferReservation {
    pub(crate) fn new(
        principal_id: String,
        idempotency_key: String,
        input_fingerprint: String,
    ) -> Self {
        Self {
            principal_id,
            idempotency_key,
            input_fingerprint,
        }
    }
}

fn ensure_pairing_offer_capacity(
    state: &AuthState,
    lookup_key: &(String, String),
) -> Result<(), AuthError> {
    if state.pairing_offer_idempotency.contains_key(lookup_key) {
        return Ok(());
    }
    let principal_entries = state
        .pairing_offer_idempotency
        .keys()
        .filter(|(principal_id, _)| principal_id == &lookup_key.0)
        .count();
    if principal_entries >= MAX_ACTIVE_PAIRING_OFFERS_PER_PRINCIPAL {
        return Err(AuthError::Internal(
            "pairing offer principal capacity exceeded".to_owned(),
        ));
    }
    if state.pairing_offer_idempotency.len() >= MAX_ACTIVE_PAIRING_OFFERS {
        return Err(AuthError::Internal(
            "pairing offer idempotency capacity exceeded".to_owned(),
        ));
    }
    Ok(())
}

#[derive(Default)]
struct AuthGrantMetadata {
    /// Whether the session comes from the reusable desktop bootstrap credential.
    desktop_bootstrap: bool,
    proof_key_thumbprint: Option<String>,
    reach: Option<String>,
    off_host: Option<bool>,
    /// The MCP access ceiling an `mcp-client` credential carries; `None` for every other kind.
    mcp_access: Option<String>,
    /// An `mcp-client` grant's pairing link: its session takes this id, so a relay that never
    /// heard back can revoke it, and a revoked link fences the insert (#281).
    mcp_link_id: Option<String>,
    /// The named client (#280) the grant's link carried.
    mcp_named_client: Option<McpNamedClient>,
}

struct AuthSessionIssuanceMetadata {
    grant: AuthGrantMetadata,
    delivery_state: AuthSessionDeliveryState,
}

pub(crate) enum PairingOfferReplay {
    Original(PairingOfferResult),
    Cancelled,
    Conflict,
    Fresh,
}

/// The MCP access levels, lowest first (the same names as `McpAccess`).
const MCP_ACCESS_LEVELS: [&str; 4] = [
    "read-only",
    "approval-required",
    "auto-accept-edits",
    "full-access",
];

/// How long Stop waits for its interrupts before it answers; they go on after it.
pub(crate) const MCP_STOP_WAIT: Duration = Duration::from_secs(10);

/// What interrupting a stopped agent's turns did.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) struct McpStopOutcome {
    pub(crate) interrupted: usize,
    pub(crate) failed: usize,
}

/// Interrupts the turns a stopped agent (its session id) started.
pub(crate) type McpStopHandler = Arc<
    dyn Fn(String) -> std::pin::Pin<Box<dyn std::future::Future<Output = McpStopOutcome> + Send>>
        + Send
        + Sync,
>;

/// What [`AuthService::stop_client`] did.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct McpStopResult {
    /// The agent is revoked, now or earlier, and its turns were interrupted.
    pub revoked: bool,
    pub interrupted: usize,
    pub failed: usize,
    /// The interrupts were still running when Stop answered.
    pub timed_out: bool,
}

/// What [`AuthService::set_mcp_access`] did.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum McpAccessChange {
    Changed,
    /// No live session has this id.
    NotFound,
    /// The session is not an outside agent's.
    NotAnAgent,
    /// The level is not an MCP access level.
    InvalidAccess,
    /// Only `read-only`, or the level Take over replaced, may be set.
    NotTheHandBack,
}

pub(crate) enum PairingOfferIssuance {
    Reserved(PairingCredentialResult),
    Replay(PairingOfferReplay),
}

enum PairingIssuance {
    Reserved(PairingCredentialResult),
    Existing(PersistedPairingOffer),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum SessionTransport {
    Plain,
    E2ee,
}

impl SessionTransport {
    const fn claim(self) -> &'static str {
        match self {
            Self::Plain => "plain",
            Self::E2ee => "e2ee",
        }
    }
}

#[derive(Clone)]
struct SessionRecord {
    session_id: String,
    subject: String,
    scopes: Vec<String>,
    method: String,
    client: ClientMetadata,
    issued_at_ms: i64,
    expires_at_ms: i64,
    revoked_at_ms: Option<i64>,
    last_connected_at_ms: Option<i64>,
    connected_count: usize,
    proof_key_thumbprint: Option<String>,
    transport: SessionTransport,
    reach: Option<String>,
    off_host: Option<bool>,
    /// The MCP access ceiling an `mcp-client` credential carries; `None` for every other kind.
    mcp_access: Option<String>,
    /// The access a person's Take over replaced, which Hand back restores (#139, slice X1).
    mcp_access_hand_back: Option<String>,
    /// The resource (`<origin>/mcp`) a remote OAuth grant is bound to (slice R); `None` for
    /// every other session.
    mcp_resource: Option<String>,
    delivery_state: AuthSessionDeliveryState,
    /// The named client (#280) this `mcp-client` session is a run of.
    mcp_named_client: Option<McpNamedClient>,
}

#[derive(Clone)]
struct PairingRecord {
    id: String,
    credential: String,
    scopes: Vec<String>,
    subject: String,
    label: Option<String>,
    proof_key_thumbprint: Option<String>,
    created_at_ms: i64,
    expires_at_ms: i64,
    consumed_at_ms: Option<i64>,
    revoked_at_ms: Option<i64>,
    reach: Option<String>,
    off_host: Option<bool>,
    /// The MCP access ceiling an `mcp-client` credential carries; `None` for every other kind.
    mcp_access: Option<String>,
    /// The named client (#280) an `mcp-client` link signs a run of in.
    mcp_named_client: Option<McpNamedClient>,
}

struct Grant {
    scopes: Vec<String>,
    subject: String,
    label: Option<String>,
    reach: Option<String>,
    off_host: Option<bool>,
    /// The MCP access ceiling an `mcp-client` credential carries; `None` for every other kind.
    mcp_access: Option<String>,
    /// The consumed pairing link's id; `None` for the desktop bootstrap.
    pairing_id: Option<String>,
    /// The reusable desktop bootstrap credential of this backend process. The
    /// host's own WebView exchanges it on every load and after every backend
    /// restart, so a new exchange supersedes the sessions it minted before.
    desktop_bootstrap: bool,
    /// The named client (#280) of an `mcp-client` link.
    mcp_named_client: Option<McpNamedClient>,
}

pub struct IssuedSession {
    pub token: String,
    pub principal: Principal,
}

/// Where the OAuth routes read the environment's MCP settings from.
pub(crate) type McpOAuthSettingsSource =
    Arc<dyn Fn() -> super::oauth::McpOAuthSettings + Send + Sync>;

/// An outside agent's authenticated MCP credential: its session, its access ceiling (`None`
/// is read-only), and, for a remote OAuth grant, the resource it is bound to.
#[derive(Clone, Debug)]
pub(crate) struct McpClientCredential {
    pub(crate) principal: Principal,
    pub(crate) access: Option<String>,
    pub(crate) resource: Option<String>,
    /// A person took this agent over: its read-only access is theirs until Hand back.
    pub(crate) taken_over: bool,
    /// The session's Authorized clients label.
    pub(crate) label: Option<String>,
    /// The named client (#280) this session is a run of.
    pub(crate) named_client_id: Option<String>,
}

/// The tokens of a remote MCP grant, as the token endpoint returns them.
#[derive(Clone, Debug)]
pub(crate) struct McpOAuthTokens {
    pub(crate) access_token: String,
    pub(crate) expires_in: i64,
    pub(crate) scope: String,
}

pub(crate) enum McpOAuthMint {
    Minted(McpOAuthTokens),
    /// The code was exchanged before; the session it minted is now revoked.
    Replayed,
    /// The code is unknown, expired, or not approved.
    Refused,
}

pub(crate) enum McpOAuthRefresh {
    Rotated(McpOAuthTokens),
    /// The refresh token was used before; the grant is now revoked.
    Reused,
    InvalidGrant,
    InvalidScope,
}

impl AuthService {
    #[must_use]
    #[cfg(test)]
    pub fn new(config: &ServerConfig, signing_secret: Vec<u8>) -> Self {
        Self::build(
            config,
            signing_secret,
            HostIdentity::generate_ephemeral(),
            None,
            None,
        )
    }

    pub(crate) async fn new_with_persistence(
        config: &ServerConfig,
        signing_secret: Vec<u8>,
        secret_store: SecretStore,
        repositories: Repositories,
    ) -> Result<Self, AuthError> {
        let host_identity = HostIdentity::load_or_generate(&secret_store)
            .await
            .map_err(|error| AuthError::Internal(error.to_string()))?;
        // Crash compensation for unconfirmed pairing credentials is age-gated:
        // no connection survives a restart, so a young pending session can
        // never be confirmed anyway, but sweeping only past the grace window
        // keeps one uniform rule with the periodic sweeper below. The startup
        // pass is best-effort — a transiently locked store must not fail
        // boot when the periodic sweeper converges within a minute anyway.
        let now = now_ms();
        if let Err(error) = repositories
            .revoke_pending_auth_sessions(
                format_iso(now),
                format_iso(now - PENDING_PAIRING_SWEEP_GRACE_MS),
            )
            .await
        {
            tracing::warn!(
                ?error,
                "startup pending-pairing sweep failed; the periodic sweeper retries"
            );
        }
        let service = Self::build(
            config,
            signing_secret,
            host_identity,
            Some(secret_store),
            Some(repositories),
        );
        service.hydrate_active_state().await?;
        service.ensure_authority_watcher();
        service.spawn_pending_pairing_sweeper();
        Ok(service)
    }

    /// Periodically revokes pending-pairing sessions older than the grace
    /// window. Startup-only sweeping would let a crash-orphaned unconfirmed
    /// credential keep the host's desired exposure wide until the next
    /// restart; the periodic sweep bounds that window to minutes, while the
    /// age gate keeps it from racing a live confirmation.
    fn spawn_pending_pairing_sweeper(&self) {
        let Some(repositories) = self.repositories.clone() else {
            return;
        };
        let liveness = Arc::downgrade(&self.state);
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(PENDING_PAIRING_SWEEP_INTERVAL);
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            // The first tick fires immediately and duplicates the startup
            // sweep, which is harmless.
            loop {
                interval.tick().await;
                if liveness.upgrade().is_none() {
                    break;
                }
                let now = now_ms();
                match repositories
                    .revoke_pending_auth_sessions(
                        format_iso(now),
                        format_iso(now - PENDING_PAIRING_SWEEP_GRACE_MS),
                    )
                    .await
                {
                    Ok(_) => {}
                    Err(PersistenceError::WorkerUnavailable) => break,
                    Err(error) => {
                        tracing::warn!(?error, "pending-pairing sweep failed");
                    }
                }
            }
        });
    }

    fn build(
        config: &ServerConfig,
        signing_secret: Vec<u8>,
        host_identity: HostIdentity,
        secret_store: Option<SecretStore>,
        repositories: Option<Repositories>,
    ) -> Self {
        let remote_reachable = !is_loopback_host(&config.host);
        let policy = match (config.unsafe_no_auth, config.mode, remote_reachable) {
            (true, _, _) => "unsafe-no-auth",
            (false, ServerMode::Desktop, false) => "desktop-managed-local",
            (false, ServerMode::Web, false) => "loopback-browser",
            (false, _, true) => "remote-reachable",
        };
        let bootstrap_methods = match (config.unsafe_no_auth, config.mode, policy) {
            (true, _, _) => Vec::new(),
            (false, ServerMode::Desktop, "desktop-managed-local") => vec!["desktop-bootstrap"],
            (false, ServerMode::Desktop, _) => vec!["desktop-bootstrap", "one-time-token"],
            (false, _, _) => vec!["one-time-token"],
        };
        let session_cookie_name = if config.mode == ServerMode::Desktop {
            format!("bibcode_session_{}", config.port)
        } else {
            "bibcode_session".to_owned()
        };
        let desktop_bootstrap =
            config
                .desktop_bootstrap_token
                .as_ref()
                .map(|credential| DesktopBootstrap {
                    credential: credential.clone(),
                    expires_at_ms: now_ms().saturating_add(DESKTOP_BOOTSTRAP_TTL_MS),
                });
        let (access_events, _) = broadcast::channel(ACCESS_EVENT_CAPACITY);
        // Only a dev UI served from another origin uses the cookie cross-origin. The desktop
        // app (`bibcode://app`) never sends it: its requests carry a bearer token with
        // `credentials: "omit"`, and its WebSockets authenticate with a ticket.
        let trusted_cookie_origins = config
            .dev_url
            .as_ref()
            .map(|dev_url| dev_url.origin())
            // An opaque origin serializes as `null`, which sandboxed frames send.
            .filter(url::Origin::is_tuple)
            .map(|origin| origin.ascii_serialization())
            .into_iter()
            .collect();
        Self {
            descriptor: AuthDescriptor {
                policy,
                bootstrap_methods,
                session_methods: [
                    "browser-session-cookie",
                    "bearer-access-token",
                    "dpop-access-token",
                ],
                session_cookie_name,
            },
            host_identity,
            desktop_bootstrap,
            signer: TokenSigner::new(signing_secret),
            state: Arc::new(Mutex::new(AuthState::default())),
            issuance: Arc::new(Mutex::new(())),
            pairing_offer_issuance: Arc::new(Mutex::new(())),
            repositories,
            access_events: Arc::new(access_events),
            mcp_stop_handler: Arc::new(std::sync::Mutex::new(None)),
            mcp_oauth_settings: Arc::new(std::sync::Mutex::new(None)),
            access_revision: Arc::new(AtomicU64::new(1)),
            authority_watcher_running: Arc::new(AtomicBool::new(false)),
            redeemed_websocket_tickets: Arc::new(std::sync::Mutex::new(HashMap::new())),
            dpop: DpopVerifier::new(secret_store),
            trusted_cookie_origins,
            #[cfg(test)]
            test_hooks: Arc::default(),
        }
    }

    #[cfg(test)]
    pub(crate) fn test_hooks(&self) -> &AuthTestHooks {
        &self.test_hooks
    }

    async fn hydrate_active_state(&self) -> Result<(), AuthError> {
        let Some(repositories) = &self.repositories else {
            return Ok(());
        };
        let snapshot = repositories
            .load_auth_authority_snapshot(format_iso(now_ms()))
            .await
            .map_err(|error| AuthError::Internal(error.to_string()))?;
        let pairings = snapshot
            .pairings
            .into_iter()
            .filter(|row| known_scopes_or_warn(&row.scopes, "pairing link", &row.id))
            .map(pairing_record_from_persisted)
            .collect::<Result<Vec<_>, _>>()?;
        let sessions = snapshot
            .sessions
            .into_iter()
            .filter(|row| known_scopes_or_warn(&row.scopes, "session", &row.session_id))
            .map(session_record_from_persisted)
            .collect::<Result<Vec<_>, _>>()?;
        let pairing_offers = snapshot
            .offers
            .into_iter()
            .map(stored_pairing_offer_from_persisted)
            .collect::<Result<HashMap<_, _>, AuthError>>()?;
        let mut state = self.state.lock().await;
        state.pairings = pairings
            .into_iter()
            .map(|pairing| (pairing.id.clone(), pairing))
            .collect();
        state.sessions = sessions
            .into_iter()
            .map(|session| (session.session_id.clone(), session))
            .collect();
        state.pairing_offer_idempotency = pairing_offers;
        state.pending_mcp = snapshot
            .pending_mcp_authorizations
            .iter()
            .map(pending_mcp_view)
            .collect();
        state.named_clients = snapshot.mcp_named_clients;
        Ok(())
    }

    #[must_use]
    pub fn descriptor(&self) -> AuthDescriptor {
        self.descriptor.clone()
    }

    #[must_use]
    pub fn host_identity(&self) -> &HostIdentity {
        &self.host_identity
    }

    #[must_use]
    pub fn cookie_name(&self) -> &str {
        &self.descriptor.session_cookie_name
    }

    #[must_use]
    pub(crate) fn trusted_cookie_origins(&self) -> &[String] {
        &self.trusted_cookie_origins
    }

    #[must_use]
    pub(crate) fn subscribe_access(&self) -> broadcast::Receiver<AuthAccessEvent> {
        let receiver = self.access_events.subscribe();
        self.ensure_authority_watcher();
        receiver
    }

    pub(crate) async fn access_snapshot(
        &self,
        current_session_id: &str,
    ) -> (
        u64,
        Vec<PairingLinkView>,
        Vec<ClientSessionView>,
        Vec<PendingMcpAuthorizationView>,
    ) {
        let now = now_ms();
        let state = self.state.lock().await;
        let mut pairings = state
            .pairings
            .values()
            .filter(|pairing| {
                pairing.consumed_at_ms.is_none()
                    && pairing.revoked_at_ms.is_none()
                    && pairing.expires_at_ms > now
            })
            .map(PairingRecord::view)
            .collect::<Vec<_>>();
        pairings.sort_by(|left, right| right.created_at.cmp(&left.created_at));
        let mut sessions = state
            .sessions
            .values()
            .filter(|session| session.revoked_at_ms.is_none() && session.expires_at_ms > now)
            .map(|session| session.view(session.session_id == current_session_id))
            .collect::<Vec<_>>();
        sessions.sort_by_key(|session| !session.current);
        let pending = state
            .pending_mcp
            .iter()
            .filter(|pending| pending.expires_at_ms > now)
            .cloned()
            .collect();
        let revision = self.access_revision.load(Ordering::Acquire);
        (revision, pairings, sessions, pending)
    }

    /// The named MCP clients not yet ended (#324), as the access stream's snapshot lists them.
    pub(crate) async fn named_client_views(&self) -> Vec<McpNamedClientView> {
        self.state
            .lock()
            .await
            .named_clients
            .iter()
            .map(|client| McpNamedClientView {
                id: client.id.clone(),
                name: client.name.clone(),
                created_at: client.created_at.clone(),
            })
            .collect()
    }

    /// Sends `change` while the caller still holds the state lock that made it, so the
    /// channel order is the state order (#294). `held` proves the lock is held.
    fn emit_access_change(&self, held: &AuthState, change: AuthAccessChange) {
        emit_access_change_on(held, &self.access_events, &self.access_revision, change);
    }

    fn ensure_authority_watcher(&self) {
        let Some(repositories) = self.repositories.clone() else {
            return;
        };
        if self
            .authority_watcher_running
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return;
        }
        let state = Arc::downgrade(&self.state);
        let access_events = Arc::downgrade(&self.access_events);
        let access_revision = Arc::downgrade(&self.access_revision);
        let watcher_running = Arc::downgrade(&self.authority_watcher_running);
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(AUTHORITY_CONVERGENCE_INTERVAL);
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            let mut observed_revision = None;
            // A local change (issuance publishing into the cache) may land after a reconcile
            // that already saw a durable revoke of it, so it reloads too (#281).
            let mut reconciled_generation = None;
            let mut next_expiry_ms = None;
            'watcher: loop {
                interval.tick().await;
                let (
                    Some(state),
                    Some(access_events),
                    Some(access_revision),
                    Some(watcher_running),
                ) = (
                    state.upgrade(),
                    access_events.upgrade(),
                    access_revision.upgrade(),
                    watcher_running.upgrade(),
                )
                else {
                    break;
                };
                let now = now_ms();
                let generation = state.lock().await.authority_generation;
                match repositories.auth_authority_revision().await {
                    Ok(revision)
                        if observed_revision != Some(revision)
                            || reconciled_generation != Some(generation)
                            || next_expiry_ms.is_some_and(|expires_at| expires_at <= now) =>
                    {
                        match repositories
                            .load_auth_authority_snapshot(format_iso(now))
                            .await
                        {
                            Ok(snapshot) => {
                                let snapshot_revision = snapshot.revision;
                                let snapshot_expiry = snapshot
                                    .next_expiry_at
                                    .as_deref()
                                    .map(parse_timestamp_ms)
                                    .transpose();
                                match (
                                    snapshot_expiry,
                                    reconcile_authority_snapshot(
                                        &state,
                                        &access_events,
                                        &access_revision,
                                        snapshot,
                                        generation,
                                    )
                                    .await,
                                ) {
                                    (Ok(snapshot_expiry), Ok(true)) => {
                                        observed_revision = Some(snapshot_revision);
                                        reconciled_generation = Some(generation);
                                        next_expiry_ms = snapshot_expiry;
                                    }
                                    (Err(error), _) | (_, Err(error)) => {
                                        tracing::error!(
                                            ?error,
                                            "failed to decode durable auth authority snapshot"
                                        );
                                    }
                                    (Ok(_), Ok(false)) => {}
                                }
                            }
                            Err(PersistenceError::WorkerUnavailable) => {
                                watcher_running.store(false, Ordering::Release);
                                break 'watcher;
                            }
                            Err(error) => {
                                tracing::error!(%error, "failed to reconcile durable auth authority");
                            }
                        }
                    }
                    Ok(_) => {}
                    Err(PersistenceError::WorkerUnavailable) => {
                        watcher_running.store(false, Ordering::Release);
                        break;
                    }
                    Err(error) => {
                        tracing::error!(%error, "failed to read durable auth authority revision");
                    }
                }

                if authority_has_consumers(&state, &access_events).await {
                    continue;
                }
                watcher_running.store(false, Ordering::Release);
                if authority_has_consumers(&state, &access_events).await
                    && watcher_running
                        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                        .is_ok()
                {
                    continue;
                }
                break;
            }
        });
    }

    pub(crate) async fn create_browser_session(
        &self,
        credential: &str,
        client: ClientMetadata,
        transport: SessionTransport,
    ) -> Result<IssuedSession, AuthError> {
        let grant = self.consume_grant(credential, None).await?;
        self.issue_session(
            grant.subject,
            grant.scopes,
            "browser-session-cookie",
            apply_grant_label(client, grant.label),
            transport,
            AuthSessionIssuanceMetadata {
                grant: AuthGrantMetadata {
                    desktop_bootstrap: grant.desktop_bootstrap,
                    reach: grant.reach,
                    off_host: grant.off_host,
                    ..AuthGrantMetadata::default()
                },
                delivery_state: AuthSessionDeliveryState::Active,
            },
        )
        .await
    }

    pub(crate) async fn exchange_bootstrap(
        &self,
        credential: &str,
        requested_scopes: Option<Vec<String>>,
        client: ClientMetadata,
        proof_key_thumbprint: Option<String>,
        transport: SessionTransport,
    ) -> Result<IssuedSession, AuthError> {
        self.exchange_bootstrap_with_delivery(
            credential,
            requested_scopes,
            client,
            proof_key_thumbprint,
            transport,
            AuthSessionDeliveryState::Active,
        )
        .await
    }

    /// Exchanges a pairing one-time token over the encrypted channel. The
    /// server — not the client — decides delivery from the grant it consumed:
    /// an off-host grant mints a pending session that must be confirmed before
    /// the credential authenticates anywhere, an on-host grant is delivered
    /// immediately. A client cannot opt out of the guard by omitting a wire
    /// flag. Returns the issued session and whether confirmation is required.
    pub(crate) async fn exchange_pairing_bootstrap(
        &self,
        credential: &str,
        client: ClientMetadata,
    ) -> Result<(IssuedSession, bool), AuthError> {
        let grant = self.consume_grant(credential, None).await?;
        let confirmation_required = matches!(grant.off_host, Some(true));
        let delivery_state = if confirmation_required {
            AuthSessionDeliveryState::PendingPairing
        } else {
            AuthSessionDeliveryState::Active
        };
        let issued = self
            .issue_session_from_grant(
                grant,
                None,
                client,
                None,
                SessionTransport::E2ee,
                delivery_state,
            )
            .await?;
        Ok((issued, confirmation_required))
    }

    async fn exchange_bootstrap_with_delivery(
        &self,
        credential: &str,
        requested_scopes: Option<Vec<String>>,
        client: ClientMetadata,
        proof_key_thumbprint: Option<String>,
        transport: SessionTransport,
        delivery_state: AuthSessionDeliveryState,
    ) -> Result<IssuedSession, AuthError> {
        let grant = self
            .consume_grant(credential, proof_key_thumbprint.as_deref())
            .await?;
        #[cfg(test)]
        reach_hold(&self.test_hooks.after_consume).await;
        self.issue_session_from_grant(
            grant,
            requested_scopes,
            client,
            proof_key_thumbprint,
            transport,
            delivery_state,
        )
        .await
    }

    async fn issue_session_from_grant(
        &self,
        grant: Grant,
        requested_scopes: Option<Vec<String>>,
        client: ClientMetadata,
        proof_key_thumbprint: Option<String>,
        transport: SessionTransport,
        delivery_state: AuthSessionDeliveryState,
    ) -> Result<IssuedSession, AuthError> {
        let scopes = requested_scopes.unwrap_or_else(|| grant.scopes.clone());
        if !scopes
            .iter()
            .all(|scope| super::model::scope_satisfies(&grant.scopes, scope))
        {
            return Err(AuthError::ScopeNotGranted);
        }
        let method = if proof_key_thumbprint.is_some() {
            "dpop-access-token"
        } else {
            "bearer-access-token"
        };
        let mcp_link_id = grant
            .pairing_id
            .filter(|_| grant.subject == MCP_CLIENT_SUBJECT);
        #[cfg(test)]
        let mcp_link_id = mcp_link_id.filter(|_| {
            !self
                .test_hooks
                .random_mcp_session_ids
                .load(Ordering::Acquire)
        });
        self.issue_session(
            grant.subject,
            scopes,
            method,
            apply_grant_label(client, grant.label),
            transport,
            AuthSessionIssuanceMetadata {
                grant: AuthGrantMetadata {
                    desktop_bootstrap: grant.desktop_bootstrap,
                    proof_key_thumbprint,
                    reach: grant.reach,
                    off_host: grant.off_host,
                    mcp_access: grant.mcp_access,
                    mcp_link_id,
                    mcp_named_client: grant.mcp_named_client,
                },
                delivery_state,
            },
        )
        .await
    }

    pub(crate) async fn authenticate_token(
        &self,
        token: &str,
        surface: SessionTransport,
    ) -> Result<Principal, AuthError> {
        let (principal, _) = self.authenticate_session_token(token, surface).await?;
        // Audience binding: an outside agent's credential reaches `/mcp` and nothing else.
        if principal.subject == MCP_CLIENT_SUBJECT {
            return Err(AuthError::InvalidCredential);
        }
        Ok(principal)
    }

    /// Authenticates an outside agent's MCP credential (subject `mcp-client`) and returns its
    /// access ceiling, `None` when the session has none (callers treat that as read-only).
    /// Every other session token is refused.
    pub(crate) async fn authenticate_mcp_client(
        &self,
        token: &str,
    ) -> Result<McpClientCredential, AuthError> {
        let credential = self
            .authenticate_session_record(token, SessionTransport::Plain)
            .await?;
        if credential.principal.subject != MCP_CLIENT_SUBJECT {
            return Err(AuthError::InvalidCredential);
        }
        Ok(credential)
    }

    async fn authenticate_session_token(
        &self,
        token: &str,
        surface: SessionTransport,
    ) -> Result<(Principal, Option<String>), AuthError> {
        let credential = self.authenticate_session_record(token, surface).await?;
        Ok((credential.principal, credential.access))
    }

    /// The principal of `token`, with what its session's cached record says about it.
    async fn authenticate_session_record(
        &self,
        token: &str,
        surface: SessionTransport,
    ) -> Result<McpClientCredential, AuthError> {
        let claims: SessionClaims = self
            .signer
            .verify(token)
            .map_err(map_token_error_to_credential)?;
        let observed_at = now_ms();
        if claims.v != 1
            || claims.kind != "session"
            || claims.exp <= observed_at
            || claims.scopes.iter().any(|scope| !is_scope(scope))
            || !matches!(claims.tr.as_str(), "plain" | "e2ee")
            || (claims.tr == "e2ee" && surface == SessionTransport::Plain)
        {
            return Err(AuthError::InvalidCredential);
        }
        self.refresh_session_from_repository(&claims.sid, observed_at)
            .await?;
        let state = self.state.lock().await;
        let record = state
            .sessions
            .get(&claims.sid)
            .ok_or(AuthError::InvalidCredential)?;
        // A remote OAuth grant (slice R) outlives its one-hour access tokens: the grant's
        // expiry and the token's are checked separately, and a token never outlives its
        // grant. Every other session's token carries the session's own expiry.
        let token_expiry_mismatch = if record.mcp_resource.is_some() {
            claims.exp > record.expires_at_ms
        } else {
            record.expires_at_ms != claims.exp
        };
        if record.revoked_at_ms.is_some()
            || record.expires_at_ms <= observed_at
            || token_expiry_mismatch
            || record.subject != claims.sub
            || record.method != claims.method
            || record.scopes != claims.scopes
            || (record.transport == SessionTransport::E2ee && claims.tr != "e2ee")
            || record.delivery_state != AuthSessionDeliveryState::Active
        {
            return Err(AuthError::InvalidCredential);
        }
        Ok(McpClientCredential {
            principal: Principal {
                session_id: claims.sid,
                subject: claims.sub,
                method: claims.method,
                scopes: claims.scopes,
                proof_key_thumbprint: claims.jkt,
                expires_at_ms: claims.exp,
            },
            access: record.mcp_access.clone(),
            resource: record.mcp_resource.clone(),
            taken_over: record.mcp_access_hand_back.is_some(),
            label: record.client.label.clone(),
            named_client_id: record
                .mcp_named_client
                .as_ref()
                .map(|named| named.id.clone()),
        })
    }

    pub async fn verify_dpop(
        &self,
        proof: &str,
        method: &str,
        url: &str,
        expected_thumbprint: Option<&str>,
        expected_access_token: Option<&str>,
    ) -> Result<String, AuthError> {
        self.dpop
            .verify(
                proof,
                method,
                url,
                now_ms() / 1_000,
                expected_thumbprint,
                expected_access_token,
            )
            .await
    }

    pub fn issue_websocket_ticket(
        &self,
        principal: &Principal,
    ) -> Result<(String, i64), AuthError> {
        let issued_at = now_ms();
        let expires_at = issued_at.saturating_add(WEBSOCKET_TICKET_TTL_MS);
        let claims = WebSocketClaims {
            v: 1,
            kind: "websocket".to_owned(),
            sid: principal.session_id.clone(),
            jti: Some(Uuid::new_v4().to_string()),
            iat: issued_at,
            exp: expires_at,
        };
        self.signer
            .issue(&claims)
            .map(|token| (token, expires_at))
            .map_err(|error| AuthError::Internal(error.to_string()))
    }

    // Tickets are only accepted by the plain `/ws` route. An E2EE session cannot
    // obtain one because the preceding plain HTTP authentication rejects its
    // transport-scoped bearer credential.
    pub async fn verify_websocket_ticket(&self, token: &str) -> Result<Principal, AuthError> {
        let claims: WebSocketClaims = self
            .signer
            .verify(token)
            .map_err(map_token_error_to_credential)?;
        let observed_at = now_ms();
        if claims.v != 1 || claims.kind != "websocket" || claims.exp <= observed_at {
            return Err(AuthError::InvalidCredential);
        }
        self.refresh_session_from_repository(&claims.sid, observed_at)
            .await?;
        let state = self.state.lock().await;
        let record = state
            .sessions
            .get(&claims.sid)
            .ok_or(AuthError::InvalidCredential)?;
        if record.revoked_at_ms.is_some() || record.expires_at_ms <= observed_at {
            return Err(AuthError::InvalidCredential);
        }
        // Defense in depth for the no-downgrade invariant: tickets are only
        // accepted by the plain `/ws` route, so only plain-transport sessions
        // may redeem them.
        if record.transport != SessionTransport::Plain || record.subject == MCP_CLIENT_SUBJECT {
            return Err(AuthError::InvalidCredential);
        }
        let principal = record.principal();
        drop(state);
        // Each ticket is redeemable exactly once; the client mints a fresh
        // ticket per connection attempt, so replays are always hostile.
        let Some(jti) = claims.jti else {
            return Err(AuthError::InvalidCredential);
        };
        let mut redeemed = self
            .redeemed_websocket_tickets
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        redeemed.retain(|_, expires_at| *expires_at > observed_at);
        if redeemed.insert(jti, claims.exp).is_some() {
            return Err(AuthError::InvalidCredential);
        }
        drop(redeemed);
        Ok(principal)
    }

    pub(crate) async fn authorize_session(
        &self,
        session_id: &str,
        required_scope: &str,
    ) -> Result<(), AuthError> {
        let observed_at = now_ms();
        self.refresh_session_from_repository(session_id, observed_at)
            .await?;
        let state = self.state.lock().await;
        let session = state
            .sessions
            .get(session_id)
            .ok_or(AuthError::InvalidCredential)?;
        if session.revoked_at_ms.is_some() || session.expires_at_ms <= observed_at {
            return Err(AuthError::InvalidCredential);
        }
        if super::model::scope_satisfies(&session.scopes, required_scope) {
            Ok(())
        } else {
            Err(AuthError::ScopeRequired(required_scope.to_owned()))
        }
    }

    /// Expiry of `session_id` while it exists, is not revoked, and has not expired.
    /// Repository failures count as inactive so callers fail closed.
    pub(crate) async fn active_session_expiry(&self, session_id: &str) -> Option<i64> {
        let observed_at = now_ms();
        self.refresh_session_from_repository(session_id, observed_at)
            .await
            .ok()?;
        let state = self.state.lock().await;
        let session = state.sessions.get(session_id)?;
        (session.revoked_at_ms.is_none() && session.expires_at_ms > observed_at)
            .then_some(session.expires_at_ms)
    }

    /// The live `mcpAccess` of an outside agent's session while it is active: after a Take
    /// over it is `read-only`. `None` for any other session, and on a repository failure, so
    /// callers fail closed.
    pub(crate) async fn mcp_client_access(&self, session_id: &str) -> Option<String> {
        let observed_at = now_ms();
        self.refresh_session_from_repository(session_id, observed_at)
            .await
            .ok()?;
        let state = self.state.lock().await;
        let session = state.sessions.get(session_id)?;
        if session.revoked_at_ms.is_some()
            || session.expires_at_ms <= observed_at
            || session.subject != MCP_CLIENT_SUBJECT
        {
            return None;
        }
        session.mcp_access.clone()
    }

    async fn refresh_session_from_repository(
        &self,
        session_id: &str,
        observed_at: i64,
    ) -> Result<(), AuthError> {
        let Some(repositories) = &self.repositories else {
            return Ok(());
        };
        // Publish only a read no local change overtook: a Take over that commits and updates
        // the cache after this read must not have its level replaced by the older row (#324).
        let mut reads = 0;
        let (mut refreshed, mut state) = loop {
            reads += 1;
            let generation = self.state.lock().await.authority_generation;
            let persisted = repositories
                .get_auth_session(session_id.to_owned())
                .await
                .map_err(|error| AuthError::Internal(error.to_string()))?;
            let Some(persisted) = persisted else {
                self.remove_cached_session(session_id).await;
                return Err(AuthError::InvalidCredential);
            };
            if persisted.revoked_at.is_some()
                || parse_timestamp_ms(&persisted.expires_at)? <= observed_at
            {
                self.remove_cached_session(session_id).await;
                return Err(AuthError::InvalidCredential);
            }
            let refreshed = session_record_from_persisted(persisted)?;
            #[cfg(test)]
            reach_hold(&self.test_hooks.after_refresh_read).await;
            #[cfg_attr(not(test), allow(unused_mut))]
            let mut state = self.state.lock().await;
            #[cfg(test)]
            if self
                .test_hooks
                .churn_refresh
                .load(std::sync::atomic::Ordering::Relaxed)
            {
                state.bump_authority_generation();
            }
            if state.authority_generation == generation {
                break (refreshed, state);
            }
            if reads == MAX_REFRESH_READS {
                // Keep the cache, which every local change keeps current, rather than spin.
                tracing::warn!("a session refresh was overtaken on every read; kept the cache");
                return Ok(());
            }
        };
        let change = if let Some(current) = state.sessions.get(session_id) {
            let previous_view = current.view(false);
            refreshed.connected_count = current.connected_count;
            refreshed.proof_key_thumbprint = current.proof_key_thumbprint.clone();
            refreshed.transport = current.transport;
            if current.last_connected_at_ms > refreshed.last_connected_at_ms {
                refreshed.last_connected_at_ms = current.last_connected_at_ms;
            }
            (refreshed.view(false) != previous_view)
                .then(|| AuthAccessChange::ClientUpserted(Box::new(refreshed.view(false))))
        } else {
            Some(AuthAccessChange::ClientUpserted(Box::new(
                refreshed.view(false),
            )))
        };
        state.sessions.insert(session_id.to_owned(), refreshed);
        if let Some(change) = change {
            state.bump_authority_generation();
            self.emit_access_change(&state, change);
        }
        drop(state);
        self.ensure_authority_watcher();
        Ok(())
    }

    async fn remove_cached_session(&self, session_id: &str) {
        let mut state = self.state.lock().await;
        let removed = state.sessions.remove(session_id).is_some();
        cancel_live_connections(&mut state, session_id);
        if removed {
            state.bump_authority_generation();
            self.emit_access_change(
                &state,
                AuthAccessChange::ClientRemoved {
                    session_id: session_id.to_owned(),
                },
            );
        }
    }

    pub async fn issue_pairing(
        &self,
        scopes: Vec<String>,
        label: Option<String>,
    ) -> Result<PairingCredentialResult, AuthError> {
        reserved_pairing(
            self.issue_pairing_for_subject(
                scopes,
                label,
                "one-time-token",
                PAIRING_TTL_MS,
                AuthGrantMetadata::default(),
                None,
            )
            .await?,
        )
    }

    pub async fn issue_pairing_with_proof(
        &self,
        scopes: Vec<String>,
        label: Option<String>,
        proof_key_thumbprint: String,
    ) -> Result<PairingCredentialResult, AuthError> {
        if proof_key_thumbprint.trim().is_empty() {
            return Err(AuthError::InvalidCredential);
        }
        reserved_pairing(
            self.issue_pairing_for_subject(
                scopes,
                label,
                "one-time-token",
                PAIRING_TTL_MS,
                AuthGrantMetadata {
                    desktop_bootstrap: false,
                    proof_key_thumbprint: Some(proof_key_thumbprint),
                    ..AuthGrantMetadata::default()
                },
                None,
            )
            .await?,
        )
    }

    pub async fn issue_cloud_pairing(
        &self,
        proof_key_thumbprint: String,
    ) -> Result<PairingCredentialResult, AuthError> {
        if proof_key_thumbprint.trim().is_empty() {
            return Err(AuthError::InvalidCredential);
        }
        reserved_pairing(
            self.issue_pairing_for_subject(
                owned_scopes(STANDARD_SCOPES),
                Some("BiBCode Connect connect".to_owned()),
                "cloud-connect",
                CLOUD_PAIRING_TTL_MS,
                AuthGrantMetadata {
                    desktop_bootstrap: false,
                    proof_key_thumbprint: Some(proof_key_thumbprint),
                    ..AuthGrantMetadata::default()
                },
                None,
            )
            .await?,
        )
    }

    pub(crate) async fn issue_startup_pairing(&self) -> Result<PairingCredentialResult, AuthError> {
        reserved_pairing(
            self.issue_pairing_for_subject(
                owned_scopes(ADMINISTRATIVE_SCOPES),
                None,
                "administrative-bootstrap",
                PAIRING_TTL_MS,
                AuthGrantMetadata::default(),
                None,
            )
            .await?,
        )
    }

    pub async fn issue_share_pairing(
        &self,
        scopes: Vec<String>,
        label: Option<String>,
        reach: String,
        off_host: bool,
    ) -> Result<PairingCredentialResult, AuthError> {
        if !is_valid_pairing_reach(&reach) {
            return Err(AuthError::InvalidCredential);
        }
        reserved_pairing(
            self.issue_pairing_for_subject(
                scopes,
                label,
                "one-time-token",
                PAIRING_TTL_MS,
                AuthGrantMetadata {
                    desktop_bootstrap: false,
                    reach: Some(reach),
                    off_host: Some(off_host),
                    ..AuthGrantMetadata::default()
                },
                None,
            )
            .await?,
        )
    }

    pub(crate) async fn issue_share_pairing_offer(
        &self,
        scopes: Vec<String>,
        label: Option<String>,
        reach: String,
        off_host: bool,
        reservation: PairingOfferReservation,
    ) -> Result<PairingOfferIssuance, AuthError> {
        if !is_valid_pairing_reach(&reach) {
            return Err(AuthError::InvalidCredential);
        }
        let replay_fingerprint = reservation.input_fingerprint.clone();
        match self
            .issue_pairing_for_subject(
                scopes,
                label,
                "one-time-token",
                PAIRING_TTL_MS,
                AuthGrantMetadata {
                    desktop_bootstrap: false,
                    reach: Some(reach),
                    off_host: Some(off_host),
                    ..AuthGrantMetadata::default()
                },
                Some(reservation),
            )
            .await?
        {
            PairingIssuance::Reserved(issued) => Ok(PairingOfferIssuance::Reserved(issued)),
            PairingIssuance::Existing(offer) => Ok(PairingOfferIssuance::Replay(
                pairing_offer_replay_from_persisted(&offer, &replay_fingerprint)?,
            )),
        }
    }

    async fn issue_pairing_for_subject(
        &self,
        scopes: Vec<String>,
        label: Option<String>,
        subject: &str,
        ttl_ms: i64,
        metadata: AuthGrantMetadata,
        offer_reservation: Option<PairingOfferReservation>,
    ) -> Result<PairingIssuance, AuthError> {
        let AuthGrantMetadata {
            desktop_bootstrap: _,
            proof_key_thumbprint,
            reach,
            off_host,
            mcp_access,
            mcp_link_id: _,
            mcp_named_client: _,
        } = metadata;
        let _issuance = self.issuance.lock().await;
        if scopes.is_empty()
            || scopes.iter().any(|scope| !is_scope(scope))
            || scopes.iter().collect::<HashSet<_>>().len() != scopes.len()
        {
            return Err(AuthError::InvalidScope);
        }
        let now = now_ms();
        let expires_at = now.saturating_add(ttl_ms);
        let durable_offer_reservation = self.repositories.is_some() && offer_reservation.is_some();
        let credential = {
            let mut state = self.state.lock().await;
            state.pairings.retain(|_, pairing| {
                pairing.consumed_at_ms.is_none()
                    && pairing.revoked_at_ms.is_none()
                    && pairing.expires_at_ms > now
            });
            state
                .pairing_offer_idempotency
                .retain(|_, stored| stored.expires_at_ms > now);
            if !durable_offer_reservation && state.pairings.len() >= MAX_ACTIVE_PAIRINGS {
                return Err(AuthError::Internal(
                    "active pairing capacity exceeded".to_owned(),
                ));
            }
            if !durable_offer_reservation && let Some(reservation) = &offer_reservation {
                let lookup_key = (
                    reservation.principal_id.clone(),
                    reservation.idempotency_key.clone(),
                );
                ensure_pairing_offer_capacity(&state, &lookup_key)?;
                if state.pairing_offer_idempotency.contains_key(&lookup_key) {
                    return Err(AuthError::Internal(
                        "pairing offer idempotency key is already reserved".to_owned(),
                    ));
                }
            }
            loop {
                let candidate = generate_pairing_credential()?;
                if !state
                    .pairings
                    .values()
                    .any(|pairing| pairing.credential == candidate)
                {
                    break candidate;
                }
            }
        };
        let id = Uuid::new_v4().to_string();
        let record = PairingRecord {
            id: id.clone(),
            credential: credential.clone(),
            scopes,
            subject: subject.to_owned(),
            label: label.clone(),
            proof_key_thumbprint,
            created_at_ms: now,
            expires_at_ms: expires_at,
            consumed_at_ms: None,
            revoked_at_ms: None,
            reach,
            off_host,
            mcp_access,
            mcp_named_client: None,
        };
        let view = record.view();
        if let Some(repositories) = &self.repositories {
            if let Some(reservation) = &offer_reservation {
                let reservation = repositories
                    .create_auth_pairing_link_with_offer(
                        persisted_pairing_link(&record),
                        NewAuthPairingOffer {
                            principal_id: reservation.principal_id.clone(),
                            idempotency_key: reservation.idempotency_key.clone(),
                            input_fingerprint: reservation.input_fingerprint.clone(),
                            expires_at: format_iso(expires_at),
                        },
                    )
                    .await
                    .map_err(|error| AuthError::Internal(error.to_string()))?;
                if !reservation.reserved {
                    let offer = reservation.offer;
                    let (lookup_key, stored) = stored_pairing_offer_from_persisted(offer.clone())?;
                    let mut state = self.state.lock().await;
                    state.pairing_offer_idempotency.insert(lookup_key, stored);
                    let access_change = if let Some(pairing) = reservation.pairing {
                        let pairing = pairing_record_from_persisted(pairing)?;
                        let change = (!state.pairings.contains_key(&pairing.id))
                            .then(|| AuthAccessChange::PairingLinkUpserted(pairing.view()));
                        state.pairings.insert(pairing.id.clone(), pairing);
                        change
                    } else if let Some(pairing_id) = &offer.pairing_id {
                        state.pairings.remove(pairing_id).map(|_| {
                            AuthAccessChange::PairingLinkRemoved {
                                id: pairing_id.clone(),
                            }
                        })
                    } else {
                        None
                    };
                    state.bump_authority_generation();
                    if let Some(change) = access_change {
                        self.emit_access_change(&state, change);
                    }
                    drop(state);
                    self.ensure_authority_watcher();
                    return Ok(PairingIssuance::Existing(offer));
                }
            } else {
                repositories
                    .create_auth_pairing_link(persisted_pairing_link(&record))
                    .await
                    .map_err(|error| AuthError::Internal(error.to_string()))?;
            }
        }
        let mut state = self.state.lock().await;
        state.pairings.insert(id.clone(), record);
        if let Some(reservation) = offer_reservation {
            state.pairing_offer_idempotency.insert(
                (reservation.principal_id, reservation.idempotency_key),
                StoredPairingOffer {
                    input_fingerprint: reservation.input_fingerprint,
                    pairing_id: Some(id.clone()),
                    result: None,
                    expires_at_ms: expires_at,
                },
            );
        }
        state.bump_authority_generation();
        self.emit_access_change(&state, AuthAccessChange::PairingLinkUpserted(view));
        drop(state);
        self.ensure_authority_watcher();
        Ok(PairingIssuance::Reserved(PairingCredentialResult {
            id,
            credential,
            label,
            expires_at: format_iso(expires_at),
        }))
    }

    pub async fn list_pairings(&self) -> Vec<PairingLinkView> {
        let now = now_ms();
        let mut state = self.state.lock().await;
        state.pairings.retain(|_, pairing| {
            pairing.consumed_at_ms.is_none()
                && pairing.revoked_at_ms.is_none()
                && pairing.expires_at_ms > now
        });
        let mut pairings = state
            .pairings
            .values()
            .filter(|pairing| {
                pairing.consumed_at_ms.is_none()
                    && pairing.revoked_at_ms.is_none()
                    && pairing.expires_at_ms > now
            })
            .map(PairingRecord::view)
            .collect::<Vec<_>>();
        pairings.sort_by(|left, right| right.created_at.cmp(&left.created_at));
        pairings
    }

    pub(crate) async fn lock_pairing_offer_issuance(&self) -> OwnedMutexGuard<()> {
        Arc::clone(&self.pairing_offer_issuance).lock_owned().await
    }

    pub(crate) async fn replay_pairing_offer(
        &self,
        principal_id: &str,
        key: &str,
        input_fingerprint: &str,
    ) -> Result<PairingOfferReplay, AuthError> {
        let observed_at = now_ms();
        let lookup_key = (principal_id.to_owned(), key.to_owned());
        if let Some(repositories) = &self.repositories {
            let recovered_pairing_id = repositories
                .recover_pending_auth_pairing_offer(
                    principal_id.to_owned(),
                    key.to_owned(),
                    input_fingerprint.to_owned(),
                    format_iso(observed_at),
                    format_iso(observed_at.saturating_sub(PENDING_PAIRING_SWEEP_GRACE_MS)),
                )
                .await
                .map_err(|error| AuthError::Internal(error.to_string()))?;
            if let Some(pairing_id) = recovered_pairing_id {
                let mut state = self.state.lock().await;
                state.pairing_offer_idempotency.remove(&lookup_key);
                let removed = state.pairings.remove(&pairing_id).is_some();
                state.bump_authority_generation();
                if removed {
                    self.emit_access_change(
                        &state,
                        AuthAccessChange::PairingLinkRemoved { id: pairing_id },
                    );
                }
                drop(state);
                self.ensure_authority_watcher();
                return Ok(PairingOfferReplay::Fresh);
            }
            let persisted = repositories
                .prune_and_get_active_auth_pairing_offer(
                    principal_id.to_owned(),
                    key.to_owned(),
                    format_iso(observed_at),
                )
                .await
                .map_err(|error| AuthError::Internal(error.to_string()))?;
            let mut state = self.state.lock().await;
            let mut access_change = None;
            match persisted {
                Some(authority) => {
                    let offer = authority.offer;
                    let (persisted_key, stored) =
                        stored_pairing_offer_from_persisted(offer.clone())?;
                    state
                        .pairing_offer_idempotency
                        .insert(persisted_key, stored);
                    if let Some(pairing) = authority.pairing {
                        let pairing = pairing_record_from_persisted(pairing)?;
                        if !state.pairings.contains_key(&pairing.id) {
                            access_change =
                                Some(AuthAccessChange::PairingLinkUpserted(pairing.view()));
                        }
                        state.pairings.insert(pairing.id.clone(), pairing);
                    } else if let Some(pairing_id) = offer.pairing_id
                        && state.pairings.remove(&pairing_id).is_some()
                    {
                        access_change =
                            Some(AuthAccessChange::PairingLinkRemoved { id: pairing_id });
                    }
                }
                None => {
                    state.pairing_offer_idempotency.remove(&lookup_key);
                }
            }
            state.bump_authority_generation();
            if let Some(change) = access_change {
                self.emit_access_change(&state, change);
            }
        }
        let mut state = self.state.lock().await;
        state
            .pairing_offer_idempotency
            .retain(|_, stored| stored.expires_at_ms > observed_at);
        let stale_completed = state
            .pairing_offer_idempotency
            .get(&lookup_key)
            .is_some_and(|stored| {
                stored.input_fingerprint == input_fingerprint
                    && stored.result.is_some()
                    && stored
                        .pairing_id
                        .as_ref()
                        .is_some_and(|id| !state.pairings.contains_key(id))
            });
        if stale_completed {
            // The recorded offer was consumed or revoked since it was minted;
            // replaying its result would advertise a dead code as fresh.
            state.pairing_offer_idempotency.remove(&lookup_key);
            state.bump_authority_generation();
            return Ok(PairingOfferReplay::Fresh);
        }
        Ok(match state.pairing_offer_idempotency.get(&lookup_key) {
            Some(stored) if stored.result.is_none() && stored.pairing_id.is_none() => {
                PairingOfferReplay::Cancelled
            }
            Some(stored) if stored.input_fingerprint == input_fingerprint => stored
                .result
                .clone()
                .map(PairingOfferReplay::Original)
                .unwrap_or(PairingOfferReplay::Cancelled),
            Some(_) => PairingOfferReplay::Conflict,
            None => PairingOfferReplay::Fresh,
        })
    }

    pub(crate) async fn record_pairing_offer(
        &self,
        principal_id: &str,
        key: String,
        input_fingerprint: String,
        result: PairingOfferResult,
    ) -> Result<(), AuthError> {
        let expires_at_ms = parse_timestamp_ms(&result.expires_at)?;
        let observed_at = now_ms();
        if let Some(repositories) = &self.repositories {
            let persisted = serde_json::to_value(&result)
                .map_err(|error| AuthError::Internal(error.to_string()))?;
            if !repositories
                .complete_auth_pairing_offer(principal_id.to_owned(), key.clone(), persisted)
                .await
                .map_err(|error| AuthError::Internal(error.to_string()))?
            {
                return Err(AuthError::Internal(
                    "pairing offer reservation is unavailable".to_owned(),
                ));
            }
        }
        let mut state = self.state.lock().await;
        state
            .pairing_offer_idempotency
            .retain(|_, stored| stored.expires_at_ms > observed_at);
        let lookup_key = (principal_id.to_owned(), key.clone());
        ensure_pairing_offer_capacity(&state, &lookup_key)?;
        if let Some(stored) = state.pairing_offer_idempotency.get_mut(&lookup_key) {
            stored.input_fingerprint = input_fingerprint;
            stored.pairing_id = Some(result.id.clone());
            stored.result = Some(result);
            stored.expires_at_ms = expires_at_ms;
        } else {
            state.pairing_offer_idempotency.insert(
                lookup_key,
                StoredPairingOffer {
                    input_fingerprint,
                    pairing_id: Some(result.id.clone()),
                    result: Some(result),
                    expires_at_ms,
                },
            );
        }
        state.bump_authority_generation();
        drop(state);
        self.ensure_authority_watcher();
        Ok(())
    }

    pub(crate) async fn cancel_pairing_offer(
        &self,
        principal_id: &str,
        key: String,
    ) -> Result<bool, AuthError> {
        let observed_at = now_ms();
        let lookup_key = (principal_id.to_owned(), key.clone());
        let offer_id = {
            let mut state = self.state.lock().await;
            state
                .pairing_offer_idempotency
                .retain(|_, stored| stored.expires_at_ms > observed_at);
            if self.repositories.is_none() {
                ensure_pairing_offer_capacity(&state, &lookup_key)?;
            }
            state
                .pairing_offer_idempotency
                .get(&lookup_key)
                .and_then(|stored| stored.pairing_id.clone())
        };

        let (cancelled, cancelled_pairing_id) = if let Some(repositories) = &self.repositories {
            let cancellation = repositories
                .cancel_auth_pairing_offer(
                    principal_id.to_owned(),
                    key.clone(),
                    format_iso(observed_at),
                    format_iso(observed_at.saturating_add(PAIRING_TTL_MS)),
                )
                .await
                .map_err(|error| AuthError::Internal(error.to_string()))?;
            (cancellation.revoked, cancellation.pairing_id)
        } else {
            let cancelled = match &offer_id {
                Some(id) => self.revoke_pairing(id).await?,
                None => false,
            };
            (cancelled, offer_id)
        };
        {
            let mut state = self.state.lock().await;
            let removed = cancelled_pairing_id
                .as_ref()
                .and_then(|id| state.pairings.remove(id));
            state.pairing_offer_idempotency.insert(
                lookup_key,
                StoredPairingOffer {
                    input_fingerprint: String::new(),
                    pairing_id: None,
                    result: None,
                    expires_at_ms: observed_at.saturating_add(PAIRING_TTL_MS),
                },
            );
            state.bump_authority_generation();
            if self.repositories.is_some()
                && cancelled
                && let Some(pairing) = removed
            {
                self.emit_access_change(
                    &state,
                    AuthAccessChange::PairingLinkRemoved { id: pairing.id },
                );
            }
        }
        Ok(cancelled)
    }

    pub async fn share_exposure_state(&self) -> ShareExposureState {
        let now = now_ms();
        let state = self.state.lock().await;
        let link_grants = state
            .pairings
            .values()
            .filter(|pairing| {
                pairing.subject == "one-time-token"
                    && pairing.consumed_at_ms.is_none()
                    && pairing.revoked_at_ms.is_none()
                    && pairing.expires_at_ms > now
            })
            .map(|pairing| (pairing.reach.as_deref(), pairing.off_host));
        let session_grants = state
            .sessions
            .values()
            .filter(|session| {
                session.subject == "one-time-token"
                    && session.revoked_at_ms.is_none()
                    && session.expires_at_ms > now
            })
            .map(|session| (session.reach.as_deref(), session.off_host));
        let mut off_host_grant_count = 0usize;
        let mut native_exposure_grant_count = 0usize;
        let mut legacy_grant_count = 0usize;
        for (reach, off_host) in link_grants.chain(session_grants) {
            match off_host {
                Some(true) => {
                    off_host_grant_count += 1;
                    if reach == Some(PAIRING_REACH_ANOTHER_DEVICE) {
                        native_exposure_grant_count += 1;
                    }
                }
                Some(false) => {}
                None => legacy_grant_count += 1,
            }
        }
        ShareExposureState {
            desired_exposure: if native_exposure_grant_count > 0 {
                "wide"
            } else {
                "loopback"
            }
            .to_owned(),
            off_host_grant_count,
            legacy_grant_count,
        }
    }

    pub async fn revoke_pairing(&self, id: &str) -> Result<bool, AuthError> {
        let revoked_at = now_ms();
        if let Some(repositories) = &self.repositories {
            let revoked = repositories
                .revoke_auth_pairing_link(id.to_owned(), format_iso(revoked_at))
                .await
                .map_err(|error| AuthError::Internal(error.to_string()))?;
            if !revoked {
                return Ok(false);
            }
            let mut state = self.state.lock().await;
            state.pairings.remove(id);
            state.bump_authority_generation();
            self.emit_access_change(
                &state,
                AuthAccessChange::PairingLinkRemoved { id: id.to_owned() },
            );
            drop(state);
            return Ok(true);
        }
        let mut state = self.state.lock().await;
        let Some(pairing) = state.pairings.get_mut(id) else {
            return Ok(false);
        };
        if pairing.revoked_at_ms.is_some() {
            return Ok(false);
        }
        pairing.revoked_at_ms = Some(revoked_at);
        let id = pairing.id.clone();
        state.pairings.remove(&id);
        state.bump_authority_generation();
        self.emit_access_change(&state, AuthAccessChange::PairingLinkRemoved { id });
        drop(state);
        Ok(true)
    }

    pub async fn list_clients(&self, current_session_id: &str) -> Vec<ClientSessionView> {
        let now = now_ms();
        let mut state = self.state.lock().await;
        state
            .sessions
            .retain(|_, session| session.revoked_at_ms.is_none() && session.expires_at_ms > now);
        let mut sessions = state
            .sessions
            .values()
            .filter(|session| session.revoked_at_ms.is_none() && session.expires_at_ms > now)
            .map(|session| session.view(session.session_id == current_session_id))
            .collect::<Vec<_>>();
        sessions.sort_by_key(|session| !session.current);
        sessions
    }

    pub async fn revoke_client(
        &self,
        current_session_id: &str,
        target_session_id: &str,
    ) -> Result<bool, AuthError> {
        if current_session_id == target_session_id {
            return Err(AuthError::CurrentSessionRevokeNotAllowed);
        }
        self.revoke_session(target_session_id).await
    }

    /// **Stop** (#139, slice X1): revokes an outside agent, which ends its calls and owned
    /// mutations, then has the MCP service interrupt the turns it started, also for an agent
    /// revoked earlier, and answers with how that went: the turns interrupted, those whose
    /// interrupt failed, and whether the interrupts were still running after
    /// [`MCP_STOP_WAIT`] (they go on). `revoked: false` for an unknown session, or one revoked
    /// earlier that was not an outside agent's. Only Stop interrupts, so a plain revocation
    /// (the `bibcode thread` CLI revokes its own credential on the way out) never does.
    pub async fn stop_client(
        &self,
        current_session_id: &str,
        target_session_id: &str,
    ) -> Result<McpStopResult, AuthError> {
        let revoked = self
            .revoke_client(current_session_id, target_session_id)
            .await?;
        // An agent revoked earlier (Revoke, then Stop) may still be running turns; Stop
        // interrupts them too. Only a session that was an outside agent's is stopped.
        let stopped = revoked || self.was_revoked_mcp_client(target_session_id).await?;
        let mut result = McpStopResult {
            revoked: stopped,
            ..McpStopResult::default()
        };
        let handler = self
            .mcp_stop_handler
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        if let (true, Some(handler)) = (stopped, handler) {
            let interrupting = tokio::spawn(handler(target_session_id.to_owned()));
            match tokio::time::timeout(MCP_STOP_WAIT, interrupting).await {
                Ok(Ok(outcome)) => {
                    result.interrupted = outcome.interrupted;
                    result.failed = outcome.failed;
                }
                Ok(Err(error)) => {
                    tracing::warn!(%error, "MCP Stop's interrupts ended abnormally");
                    result.failed = 1;
                }
                Err(_) => result.timed_out = true,
            }
        }
        Ok(result)
    }

    /// Lets the MCP service interrupt a stopped agent's turns; the last registration wins.
    /// Lets the OAuth routes read the environment's MCP settings live (slice R). The MCP
    /// service attaches its settings when it starts; until then remote MCP is off.
    pub(crate) fn set_mcp_oauth_settings(&self, source: McpOAuthSettingsSource) {
        *self
            .mcp_oauth_settings
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(source);
    }

    pub(crate) fn mcp_oauth_settings(&self) -> super::oauth::McpOAuthSettings {
        let source = self
            .mcp_oauth_settings
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        source.map_or_else(super::oauth::McpOAuthSettings::off, |source| source())
    }

    /// The store behind the OAuth routes; `None` for a server without persistence, which
    /// serves no remote MCP.
    pub(crate) fn oauth_repositories(&self) -> Option<&Repositories> {
        self.repositories.as_ref()
    }

    /// Mints the grant an approved authorization's code is exchanged for: an `mcp-client`
    /// session bound to the authorization's resource, its first refresh token, and a
    /// one-hour access token. The authorization's single use is decided in the same
    /// transaction that writes the session.
    pub(crate) async fn mint_mcp_oauth_grant(
        &self,
        authorization: &McpOAuthAuthorization,
        code_hash: String,
        refresh_token_hash: String,
        client: ClientMetadata,
    ) -> Result<McpOAuthMint, AuthError> {
        let repositories = self
            .repositories
            .as_ref()
            .ok_or_else(|| AuthError::Internal("remote MCP needs a data store".to_owned()))?;
        let scopes = authorization
            .approved_scopes
            .as_deref()
            .map(parse_scopes)
            .transpose()?
            .ok_or(AuthError::InvalidCredential)?;
        let access = authorization
            .approved_access
            .clone()
            .ok_or(AuthError::InvalidCredential)?;
        let _issuance = self.issuance.lock().await;
        let issued_at = now_ms();
        {
            let mut state = self.state.lock().await;
            state.sessions.retain(|_, session| {
                session.revoked_at_ms.is_none() && session.expires_at_ms > issued_at
            });
            if state.sessions.len() >= MAX_ACTIVE_SESSIONS {
                return Err(AuthError::Internal(
                    "active session capacity exceeded".to_owned(),
                ));
            }
        }
        let record = SessionRecord {
            session_id: Uuid::new_v4().to_string(),
            subject: MCP_CLIENT_SUBJECT.to_owned(),
            scopes,
            method: "bearer-access-token".to_owned(),
            client: ClientMetadata {
                label: Some(super::oauth::session_label(&authorization.client_name)),
                ..client
            },
            issued_at_ms: issued_at,
            expires_at_ms: issued_at.saturating_add(super::oauth::GRANT_TTL_MS),
            revoked_at_ms: None,
            last_connected_at_ms: None,
            connected_count: 0,
            proof_key_thumbprint: None,
            transport: SessionTransport::Plain,
            reach: None,
            off_host: None,
            mcp_access: Some(access),
            mcp_access_hand_back: None,
            mcp_resource: Some(authorization.resource.clone()),
            delivery_state: AuthSessionDeliveryState::Active,
            mcp_named_client: None,
        };
        let outcome = repositories
            .exchange_mcp_oauth_code(
                McpOAuthCodeExchange {
                    authorization_id: authorization.id.clone(),
                    code_hash,
                    client_id: authorization.client_id.clone(),
                    resource: authorization.resource.clone(),
                    session: persisted_auth_session(&record),
                    refresh_token_hash,
                    revoked_at: format_iso(issued_at),
                },
                issued_at,
            )
            .await
            .map_err(|error| AuthError::Internal(error.to_string()))?;
        match outcome {
            McpOAuthExchangeOutcome::Exchanged => {}
            McpOAuthExchangeOutcome::Replayed { session_id } => {
                self.forget_revoked_session(&session_id).await;
                return Ok(McpOAuthMint::Replayed);
            }
            McpOAuthExchangeOutcome::Refused => return Ok(McpOAuthMint::Refused),
        }
        let (access_token, expires_in) = self.sign_mcp_oauth_access_token(&record, issued_at)?;
        let scope = record.scopes.join(" ");
        let view = record.view(false);
        let mut state = self.state.lock().await;
        state.sessions.insert(record.session_id.clone(), record);
        state.bump_authority_generation();
        self.emit_access_change(&state, AuthAccessChange::ClientUpserted(Box::new(view)));
        drop(state);
        self.ensure_authority_watcher();
        Ok(McpOAuthMint::Minted(McpOAuthTokens {
            access_token,
            expires_in,
            scope,
        }))
    }

    /// Rotates a remote grant's refresh token and signs a new access token. A token used
    /// before revokes the grant; the session leaves this service at once.
    pub(crate) async fn rotate_mcp_oauth_refresh_token(
        &self,
        rotation: McpOAuthRefreshRotation,
    ) -> Result<McpOAuthRefresh, AuthError> {
        let repositories = self
            .repositories
            .as_ref()
            .ok_or_else(|| AuthError::Internal("remote MCP needs a data store".to_owned()))?;
        let now = now_ms();
        let outcome = repositories
            .rotate_mcp_oauth_refresh_token(rotation, now)
            .await
            .map_err(|error| AuthError::Internal(error.to_string()))?;
        let session = match outcome {
            McpOAuthRefreshOutcome::Rotated(session) => session,
            McpOAuthRefreshOutcome::Reused { session_id, .. } => {
                self.forget_revoked_session(&session_id).await;
                return Ok(McpOAuthRefresh::Reused);
            }
            McpOAuthRefreshOutcome::InvalidGrant => return Ok(McpOAuthRefresh::InvalidGrant),
            McpOAuthRefreshOutcome::InvalidScope => return Ok(McpOAuthRefresh::InvalidScope),
        };
        let session_id = session.session_id.clone();
        let record = session_record_from_persisted(*session)?;
        let (access_token, expires_in) = self.sign_mcp_oauth_access_token(&record, now)?;
        let scope = record.scopes.join(" ");
        // The moved expiry (and any narrowed scopes) reach the cache before the new token is
        // handed out, so its first use matches.
        self.refresh_session_from_repository(&session_id, now)
            .await?;
        Ok(McpOAuthRefresh::Rotated(McpOAuthTokens {
            access_token,
            expires_in,
            scope,
        }))
    }

    /// An access token for a remote grant: the session's claims with `exp` one hour out, or
    /// the grant's own expiry when that is sooner.
    fn sign_mcp_oauth_access_token(
        &self,
        record: &SessionRecord,
        issued_at: i64,
    ) -> Result<(String, i64), AuthError> {
        let expires_at = issued_at
            .saturating_add(super::oauth::ACCESS_TOKEN_TTL_MS)
            .min(record.expires_at_ms);
        let claims = SessionClaims {
            v: 1,
            kind: "session".to_owned(),
            sid: record.session_id.clone(),
            sub: record.subject.clone(),
            scopes: record.scopes.clone(),
            method: record.method.clone(),
            jkt: None,
            tr: SessionTransport::Plain.claim().to_owned(),
            iat: issued_at,
            exp: expires_at,
        };
        let token = self
            .signer
            .issue(&claims)
            .map_err(|error| AuthError::Internal(error.to_string()))?;
        Ok((token, ((expires_at - issued_at) / 1_000).max(0)))
    }

    /// Drops a session another path revoked in the store: its connections end and every
    /// client sees it go.
    async fn forget_revoked_session(&self, session_id: &str) {
        self.remove_cached_session(session_id).await;
    }

    /// Rereads the pending remote authorizations after this service changed them, so every
    /// BiBCode client's cards follow at once.
    pub(crate) async fn reload_pending_mcp_authorizations(&self) -> Result<(), AuthError> {
        let Some(repositories) = &self.repositories else {
            return Ok(());
        };
        let rows = repositories
            .list_pending_mcp_oauth_authorizations(now_ms())
            .await
            .map_err(|error| AuthError::Internal(error.to_string()))?;
        let pending = rows.iter().map(pending_mcp_view).collect::<Vec<_>>();
        let mut state = self.state.lock().await;
        if state.pending_mcp == pending {
            return Ok(());
        }
        state.pending_mcp = pending;
        state.bump_authority_generation();
        self.emit_access_change(&state, AuthAccessChange::PendingMcpAuthorizations);
        drop(state);
        self.ensure_authority_watcher();
        Ok(())
    }

    pub(crate) fn set_mcp_stop_handler(&self, handler: McpStopHandler) {
        *self
            .mcp_stop_handler
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(handler);
    }

    /// Whether `session_id` is an outside agent's session that has been revoked.
    async fn was_revoked_mcp_client(&self, session_id: &str) -> Result<bool, AuthError> {
        let Some(repositories) = &self.repositories else {
            return Ok(false);
        };
        // An identity ended earlier stays stoppable, so a later Stop still reaches its turns.
        if session_id.starts_with(crate::persistence::NAMED_CLIENT_ID_PREFIX) {
            return repositories
                .mcp_named_client_is_revoked(session_id.to_owned())
                .await
                .map_err(|error| AuthError::Internal(error.to_string()));
        }
        let session = repositories
            .get_auth_session(session_id.to_owned())
            .await
            .map_err(|error| AuthError::Internal(error.to_string()))?;
        Ok(session.is_some_and(|session| {
            session.subject == MCP_CLIENT_SUBJECT && session.revoked_at.is_some()
        }))
    }

    /// The Authorized clients label of a live session.
    pub(crate) async fn client_label(&self, session_id: &str) -> Option<String> {
        self.state
            .lock()
            .await
            .sessions
            .get(session_id)
            .and_then(|session| session.client.label.clone())
    }

    /// **Take over** and **Hand back** (#139, slice X1). `read-only` remembers the level it
    /// replaces; any other level must be that remembered level, so this never raises an agent
    /// above what it was paired with. A change cancels the session's live work, so its owned
    /// mutations stop (C4), and its next mutating call is refused.
    pub(crate) async fn set_mcp_access(
        &self,
        target_session_id: &str,
        access: &str,
    ) -> Result<McpAccessChange, AuthError> {
        if !MCP_ACCESS_LEVELS.contains(&access) {
            return Ok(McpAccessChange::InvalidAccess);
        }
        let (next, hand_back) =
            {
                let state = self.state.lock().await;
                let now = now_ms();
                let Some(session) = state.sessions.get(target_session_id).filter(|session| {
                    session.revoked_at_ms.is_none() && session.expires_at_ms > now
                }) else {
                    return Ok(McpAccessChange::NotFound);
                };
                if session.subject != MCP_CLIENT_SUBJECT {
                    return Ok(McpAccessChange::NotAnAgent);
                }
                let current = session
                    .mcp_access
                    .clone()
                    .unwrap_or_else(|| "read-only".to_owned());
                if access == "read-only" {
                    // Taking over twice keeps the first level.
                    let hand_back = session
                        .mcp_access_hand_back
                        .clone()
                        .or_else(|| (current != "read-only").then_some(current));
                    ("read-only".to_owned(), hand_back)
                } else if session.mcp_access_hand_back.as_deref() == Some(access) {
                    (access.to_owned(), None)
                } else {
                    return Ok(McpAccessChange::NotTheHandBack);
                }
            };
        // Issuance holds this lock from its session insert to its cache publication, so a new
        // run of a named client cannot publish a level this change has already replaced.
        let _issuance = self.issuance.lock().await;
        let changed = match &self.repositories {
            Some(repositories) => repositories
                .set_mcp_session_access(
                    target_session_id.to_owned(),
                    access.to_owned(),
                    format_iso(now_ms()),
                )
                .await
                .map_err(|error| AuthError::Internal(error.to_string()))?,
            None => vec![(target_session_id.to_owned(), Some(next), hand_back)],
        };
        if changed.is_empty() {
            return Ok(McpAccessChange::NotFound);
        }
        let mut state = self.state.lock().await;
        let mut views = Vec::with_capacity(changed.len());
        for (session_id, access, hand_back) in changed {
            let Some(session) = state.sessions.get_mut(&session_id) else {
                continue;
            };
            session.mcp_access = access;
            session.mcp_access_hand_back = hand_back;
            views.push(session.view(false));
            // The session stays, so its connection guards still count themselves out.
            for shutdown in state
                .live_connections
                .get(&session_id)
                .into_iter()
                .flat_map(HashMap::values)
            {
                shutdown.cancel();
            }
        }
        if let Some(named) = state
            .sessions
            .get(target_session_id)
            .and_then(|session| session.mcp_named_client.clone())
        {
            let taken_over = access == "read-only";
            if let Some(client) = state
                .named_clients
                .iter_mut()
                .find(|client| client.id == named.id)
            {
                client.taken_over = taken_over;
            }
            tracing::info!(
                named_client_id = %named.id,
                sessions = views.len(),
                taken_over,
                "changed a named MCP client's Take over"
            );
        }
        state.bump_authority_generation();
        for view in views {
            self.emit_access_change(&state, AuthAccessChange::ClientUpserted(Box::new(view)));
        }
        drop(state);
        Ok(McpAccessChange::Changed)
    }

    pub(crate) async fn revoke_failed_pairing_session(
        &self,
        session_id: &str,
    ) -> Result<bool, AuthError> {
        let revoked_at = now_ms();
        if let Some(repositories) = &self.repositories {
            let revoked = repositories
                .revoke_pending_auth_session(session_id.to_owned(), format_iso(revoked_at))
                .await
                .map_err(|error| AuthError::Internal(error.to_string()))?;
            if !revoked {
                return Ok(false);
            }
        }
        let mut state = self.state.lock().await;
        let pending = state.sessions.get(session_id).is_some_and(|session| {
            session.delivery_state == AuthSessionDeliveryState::PendingPairing
        });
        if !pending {
            return Ok(false);
        }
        state.sessions.remove(session_id);
        cancel_live_connections(&mut state, session_id);
        state.bump_authority_generation();
        self.emit_access_change(
            &state,
            AuthAccessChange::ClientRemoved {
                session_id: session_id.to_owned(),
            },
        );
        drop(state);
        Ok(true)
    }

    pub(crate) async fn confirm_pending_pairing_session(
        &self,
        session_id: &str,
    ) -> Result<bool, AuthError> {
        let now = now_ms();
        if let Some(repositories) = &self.repositories {
            let confirmed = repositories
                .confirm_pending_auth_session(session_id.to_owned(), format_iso(now))
                .await
                .map_err(|error| AuthError::Internal(error.to_string()))?;
            if !confirmed {
                return Ok(false);
            }
        }
        let mut state = self.state.lock().await;
        let Some(session) = state.sessions.get_mut(session_id) else {
            return Ok(false);
        };
        if session.revoked_at_ms.is_some() || session.expires_at_ms <= now {
            return Ok(false);
        }
        if session.delivery_state == AuthSessionDeliveryState::Active {
            return Ok(true);
        }
        session.delivery_state = AuthSessionDeliveryState::Active;
        state.bump_authority_generation();
        Ok(true)
    }

    /// Revokes every active session the desktop bootstrap credential minted
    /// before a new exchange. The host has one WebView, and each of its loads
    /// or backend restarts exchanges the same reusable credential; without this
    /// every launch would leave another "current host" row in the paired-client
    /// list. Runs under the issuance lock after the replacement session is
    /// durable, so concurrent exchanges serialize and a crash in between leaves
    /// sessions the next exchange supersedes. With persistence the database is
    /// the authority (the authority watcher converges memory to it), so the
    /// candidates come from the persisted active rows and revocation goes
    /// through the persisted path; the watcher cannot resurrect a superseded
    /// session. The WebView holds one session per session method (its bearer
    /// access token and its browser-session cookie), so only sessions issued
    /// with the same `method` are superseded. `replacement_session_id` is the
    /// session being issued and is never revoked.
    async fn supersede_desktop_bootstrap_sessions(
        &self,
        replacement_session_id: &str,
        method: &str,
    ) -> Result<usize, AuthError> {
        let now = now_ms();
        let mut superseded = if let Some(repositories) = &self.repositories {
            repositories
                .list_active_auth_sessions(format_iso(now))
                .await
                .map_err(|error| AuthError::Internal(error.to_string()))?
                .into_iter()
                .filter(|session| {
                    session.subject == DESKTOP_BOOTSTRAP_SUBJECT && session.method == method
                })
                .map(|session| session.session_id)
                .collect::<Vec<_>>()
        } else {
            let state = self.state.lock().await;
            state
                .sessions
                .values()
                .filter(|session| {
                    session.subject == DESKTOP_BOOTSTRAP_SUBJECT
                        && session.method == method
                        && session.revoked_at_ms.is_none()
                        && session.expires_at_ms > now
                })
                .map(|session| session.session_id.clone())
                .collect::<Vec<_>>()
        };
        superseded.retain(|session_id| session_id != replacement_session_id);
        superseded.sort_unstable();
        superseded.dedup();
        let mut revoked = 0;
        for session_id in superseded {
            if self.revoke_session(&session_id).await? {
                revoked += 1;
            }
        }
        Ok(revoked)
    }

    async fn revoke_session(&self, target_session_id: &str) -> Result<bool, AuthError> {
        let revoked_at = now_ms();
        if let Some(repositories) = &self.repositories {
            let revoked = repositories
                .revoke_auth_session_and_identity(
                    target_session_id.to_owned(),
                    format_iso(revoked_at),
                )
                .await
                .map_err(|error| AuthError::Internal(error.to_string()))?;
            let changed = revoked != RevokedAccess::default();
            self.forget_revoked(revoked).await;
            return Ok(changed);
        }
        let mut state = self.state.lock().await;
        let Some(session) = state.sessions.get_mut(target_session_id) else {
            return Ok(false);
        };
        if session.revoked_at_ms.is_some() {
            return Ok(false);
        }
        session.revoked_at_ms = Some(revoked_at);
        let session_id = session.session_id.clone();
        state.sessions.remove(&session_id);
        cancel_live_connections(&mut state, &session_id);
        state.bump_authority_generation();
        self.emit_access_change(&state, AuthAccessChange::ClientRemoved { session_id });
        drop(state);
        Ok(true)
    }

    /// Drops what a person's revoke ended from the cache, ends its live connections and sends
    /// each removal under the same lock (#294). A named client's runs and links go too (#280).
    async fn forget_revoked(&self, revoked: RevokedAccess) {
        if revoked == RevokedAccess::default() {
            return;
        }
        for client_id in &revoked.named_clients {
            tracing::info!(named_client_id = %client_id, "ended a named MCP client's identity");
        }
        let mut state = self.state.lock().await;
        for session_id in &revoked.sessions {
            state.sessions.remove(session_id);
            cancel_live_connections(&mut state, session_id);
        }
        let pairings = revoked
            .pairings
            .into_iter()
            .filter(|id| state.pairings.remove(id).is_some())
            .collect::<Vec<_>>();
        state
            .named_clients
            .retain(|client| !revoked.named_clients.contains(&client.id));
        // Sent even when the cache had not yet seen the identity: the store ended it, and the
        // webhook dispatcher must still wake.
        let named_changed = !revoked.named_clients.is_empty();
        state.bump_authority_generation();
        for session_id in revoked.sessions {
            self.emit_access_change(&state, AuthAccessChange::ClientRemoved { session_id });
        }
        for id in pairings {
            self.emit_access_change(&state, AuthAccessChange::PairingLinkRemoved { id });
        }
        // An idle identity has no ClientRemoved; this is what removes its row and wakes the
        // webhook dispatcher to turn its paired endpoints off (#324).
        if named_changed {
            self.emit_access_change(&state, AuthAccessChange::McpNamedClients);
        }
        drop(state);
    }

    pub async fn revoke_other_clients(&self, current_session_id: &str) -> Result<usize, AuthError> {
        let now = now_ms();
        if let Some(repositories) = &self.repositories {
            let revoked = repositories
                .revoke_other_auth_sessions(current_session_id.to_owned(), format_iso(now))
                .await
                .map_err(|error| AuthError::Internal(error.to_string()))?;
            let count = revoked.sessions.len();
            self.forget_revoked(revoked).await;
            return Ok(count);
        }
        let mut state = self.state.lock().await;
        let mut revoked = 0;
        let mut removed_session_ids = Vec::new();
        for session in state.sessions.values_mut() {
            if session.session_id != current_session_id && session.revoked_at_ms.is_none() {
                session.revoked_at_ms = Some(now);
                removed_session_ids.push(session.session_id.clone());
                revoked += 1;
            }
        }
        for session_id in &removed_session_ids {
            cancel_live_connections(&mut state, session_id);
        }
        state.bump_authority_generation();
        for session_id in removed_session_ids {
            self.emit_access_change(&state, AuthAccessChange::ClientRemoved { session_id });
        }
        drop(state);
        Ok(revoked)
    }

    /// Test-only convenience over [`Self::mark_connected_guard`]; production
    /// connection lifecycles must hold the guard so disconnection cannot be
    /// skipped.
    #[cfg(test)]
    async fn mark_connected(
        &self,
        session_id: &str,
        shutdown: CancellationToken,
    ) -> Result<u64, AuthError> {
        let mut guard = self.mark_connected_guard(session_id, shutdown).await?;
        Ok(guard
            .connection_id
            .take()
            .expect("new authenticated connection guard is armed"))
    }

    /// Moves `session_id`'s expiry to `expires_at_ms`, as if it had been issued so; only the
    /// device media socket's tests use it.
    #[cfg(all(test, unix))]
    pub(crate) async fn set_session_expiry_for_test(&self, session_id: &str, expires_at_ms: i64) {
        if let Some(session) = self.state.lock().await.sessions.get_mut(session_id) {
            session.expires_at_ms = expires_at_ms;
        }
    }

    #[cfg(test)]
    pub(crate) async fn live_connection_count_for_test(&self, session_id: &str) -> usize {
        self.state
            .lock()
            .await
            .live_connections
            .get(session_id)
            .map_or(0, HashMap::len)
    }

    pub(crate) async fn mark_connected_guard(
        &self,
        session_id: &str,
        shutdown: CancellationToken,
    ) -> Result<AuthenticatedConnectionGuard, AuthError> {
        let mut state = self.state.lock().await;
        let observed_at = now_ms();
        let Some(session) = state.sessions.get_mut(session_id) else {
            drop(state);
            shutdown.cancel();
            return Err(AuthError::InvalidCredential);
        };
        if session.revoked_at_ms.is_some() || session.expires_at_ms <= observed_at {
            drop(state);
            shutdown.cancel();
            return Err(AuthError::InvalidCredential);
        }
        if session.connected_count == 0 {
            session.last_connected_at_ms = Some(observed_at);
        }
        session.connected_count = session.connected_count.saturating_add(1);
        let view = session.view(false);
        state.next_connection_id = state.next_connection_id.wrapping_add(1);
        let connection_id = state.next_connection_id;
        state
            .live_connections
            .entry(session_id.to_owned())
            .or_default()
            .insert(connection_id, shutdown);
        // Sent under the lock; the persistence below is best-effort and does not gate the event.
        self.emit_access_change(
            &state,
            AuthAccessChange::ClientUpserted(Box::new(view.clone())),
        );
        drop(state);
        let guard = AuthenticatedConnectionGuard {
            auth: self.clone(),
            session_id: session_id.to_owned(),
            connection_id: Some(connection_id),
        };
        if let Some(repositories) = &self.repositories
            && let Err(error) = repositories
                .set_auth_session_last_connected_at(
                    session_id.to_owned(),
                    view.last_connected_at
                        .clone()
                        .unwrap_or_else(|| format_iso(observed_at)),
                )
                .await
        {
            tracing::error!(%error, %session_id, "failed to persist session connection time");
        }
        Ok(guard)
    }

    async fn mark_disconnected(&self, session_id: &str, connection_id: u64) {
        let mut state = self.state.lock().await;
        let disconnected = if let Some(connections) = state.live_connections.get_mut(session_id) {
            let disconnected = connections.remove(&connection_id).is_some();
            if connections.is_empty() {
                state.live_connections.remove(session_id);
            }
            disconnected
        } else {
            false
        };
        if !disconnected {
            return;
        }
        if let Some(session) = state.sessions.get_mut(session_id) {
            session.connected_count = session.connected_count.saturating_sub(1);
            let view = session.view(false);
            self.emit_access_change(&state, AuthAccessChange::ClientUpserted(Box::new(view)));
        }
    }

    async fn issue_session(
        &self,
        subject: String,
        scopes: Vec<String>,
        method: &str,
        client: ClientMetadata,
        transport: SessionTransport,
        metadata: AuthSessionIssuanceMetadata,
    ) -> Result<IssuedSession, AuthError> {
        let AuthSessionIssuanceMetadata {
            grant:
                AuthGrantMetadata {
                    desktop_bootstrap,
                    proof_key_thumbprint,
                    reach,
                    off_host,
                    mcp_access,
                    mcp_link_id,
                    mcp_named_client,
                },
            delivery_state,
        } = metadata;
        let _issuance = self.issuance.lock().await;
        let issued_at = now_ms();
        let ttl = if proof_key_thumbprint.is_some() {
            DPOP_SESSION_TTL_MS
        } else {
            SESSION_TTL_MS
        };
        let expires_at = issued_at.saturating_add(ttl);
        let session_id = mcp_link_id
            .clone()
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let claims = SessionClaims {
            v: 1,
            kind: "session".to_owned(),
            sid: session_id.clone(),
            sub: subject.clone(),
            scopes: scopes.clone(),
            method: method.to_owned(),
            jkt: proof_key_thumbprint.clone(),
            tr: transport.claim().to_owned(),
            iat: issued_at,
            exp: expires_at,
        };
        let token = self
            .signer
            .issue(&claims)
            .map_err(|error| AuthError::Internal(error.to_string()))?;
        let mut record = SessionRecord {
            session_id: session_id.clone(),
            subject: subject.clone(),
            scopes: scopes.clone(),
            method: method.to_owned(),
            client,
            issued_at_ms: issued_at,
            expires_at_ms: expires_at,
            revoked_at_ms: None,
            last_connected_at_ms: None,
            connected_count: 0,
            proof_key_thumbprint: proof_key_thumbprint.clone(),
            transport,
            reach,
            off_host,
            mcp_access,
            mcp_access_hand_back: None,
            mcp_resource: None,
            delivery_state,
            mcp_named_client,
        };
        {
            let mut state = self.state.lock().await;
            state.sessions.retain(|_, session| {
                session.revoked_at_ms.is_none() && session.expires_at_ms > issued_at
            });
            // Sessions the desktop bootstrap is about to supersede do not hold
            // capacity against the session that replaces them.
            let occupied = if desktop_bootstrap {
                state
                    .sessions
                    .values()
                    .filter(|session| {
                        session.subject != DESKTOP_BOOTSTRAP_SUBJECT || session.method != method
                    })
                    .count()
            } else {
                state.sessions.len()
            };
            if occupied >= MAX_ACTIVE_SESSIONS {
                return Err(AuthError::Internal(
                    "active session capacity exceeded".to_owned(),
                ));
            }
        }
        let mut view = record.view(false);
        let mut pending_issuance_guard = (delivery_state
            == AuthSessionDeliveryState::PendingPairing)
            .then(|| PendingSessionIssuanceGuard::new(self.clone(), session_id.clone()));
        if let Some(repositories) = &self.repositories {
            let row = persisted_auth_session(&record);
            let written = match &mcp_link_id {
                // A relay or sweep may have revoked the link since its consume.
                Some(link_id) => match repositories
                    .create_fenced_mcp_auth_session(row, link_id.clone())
                    .await
                    .map_err(|error| AuthError::Internal(error.to_string()))?
                {
                    // A run of a taken-over named client starts read-only (#324).
                    Some((_, access, hand_back)) => {
                        record.mcp_access = access;
                        record.mcp_access_hand_back = hand_back;
                        view = record.view(false);
                        true
                    }
                    None => false,
                },
                None => repositories
                    .create_auth_session(row)
                    .await
                    .map(|()| true)
                    .map_err(|error| AuthError::Internal(error.to_string()))?,
            };
            if !written {
                tracing::warn!(
                    link_id = mcp_link_id.as_deref(),
                    "refused an MCP session whose pairing link was revoked after its consume"
                );
                return Err(AuthError::InvalidCredential);
            }
        }
        #[cfg(test)]
        reach_hold(&self.test_hooks.after_session_insert).await;
        if desktop_bootstrap {
            self.supersede_desktop_bootstrap_sessions(&session_id, method)
                .await?;
        }
        let mut state = self.state.lock().await;
        state.sessions.insert(session_id.clone(), record);
        state.bump_authority_generation();
        #[cfg(test)]
        reach_hold(&self.test_hooks.before_session_upsert_event).await;
        self.emit_access_change(&state, AuthAccessChange::ClientUpserted(Box::new(view)));
        drop(state);
        self.ensure_authority_watcher();
        if let Some(guard) = &mut pending_issuance_guard {
            guard.disarm();
        }
        Ok(IssuedSession {
            token,
            principal: Principal {
                session_id,
                subject,
                method: method.to_owned(),
                scopes,
                proof_key_thumbprint,
                expires_at_ms: expires_at,
            },
        })
    }

    async fn consume_grant(
        &self,
        credential: &str,
        proof_key_thumbprint: Option<&str>,
    ) -> Result<Grant, AuthError> {
        let now = now_ms();
        if let Some(desktop) = &self.desktop_bootstrap
            && constant_time_text_equal(&desktop.credential, credential)
        {
            return if desktop.expires_at_ms > now {
                Ok(Grant {
                    scopes: owned_scopes(ADMINISTRATIVE_SCOPES),
                    subject: DESKTOP_BOOTSTRAP_SUBJECT.to_owned(),
                    label: None,
                    reach: None,
                    off_host: None,
                    mcp_access: None,
                    pairing_id: None,
                    desktop_bootstrap: true,
                    mcp_named_client: None,
                })
            } else {
                log_pairing_refusal("desktop_bootstrap_expired");
                Err(AuthError::InvalidCredential)
            };
        }

        if let Some(repositories) = &self.repositories {
            let now_iso = format_iso(now);
            let consumed = repositories
                .consume_auth_pairing_link(
                    credential.to_owned(),
                    proof_key_thumbprint.map(str::to_owned),
                    now_iso.clone(),
                    now_iso.clone(),
                )
                .await
                .map_err(|error| AuthError::Internal(error.to_string()))?;
            let Some(consumed) = consumed else {
                // The update refuses every cause alike; one read of the kept row names it. An
                // unauthenticated caller can trigger this, so it stays a single query.
                let class = if credential.trim().is_empty() {
                    "empty"
                } else {
                    match repositories
                        .get_auth_pairing_link_by_credential(credential.to_owned())
                        .await
                    {
                        Ok(link) => pairing_rejection_class(
                            credential,
                            link.as_ref().map(|link| RefusedPairing {
                                revoked: link.revoked_at.is_some(),
                                consumed: link.consumed_at.is_some(),
                                // The same text comparison as the update's `expires_at > ?`.
                                expired: link.expires_at <= now_iso,
                                proof_key_thumbprint: link.proof_key_thumbprint.as_deref(),
                            }),
                            proof_key_thumbprint,
                        )
                        .unwrap_or("unclassified"),
                        Err(_) => "unclassified",
                    }
                };
                log_pairing_refusal(class);
                return Err(AuthError::InvalidCredential);
            };
            let pairing = pairing_record_from_persisted(consumed)?;
            let mut state = self.state.lock().await;
            state.pairings.remove(&pairing.id);
            state.bump_authority_generation();
            self.emit_access_change(
                &state,
                AuthAccessChange::PairingLinkRemoved {
                    id: pairing.id.clone(),
                },
            );
            drop(state);
            return Ok(Grant {
                scopes: pairing.scopes,
                subject: pairing.subject,
                label: pairing.label,
                reach: pairing.reach,
                off_host: pairing.off_host,
                mcp_access: pairing.mcp_access,
                pairing_id: Some(pairing.id),
                desktop_bootstrap: false,
                mcp_named_client: pairing.mcp_named_client,
            });
        }

        let mut state = self.state.lock().await;
        let Some(pairing) = state
            .pairings
            .values_mut()
            .find(|pairing| pairing.credential == credential)
        else {
            // Revoked records are removed and the rest are pruned, so a gone record is `unknown`.
            log_pairing_refusal(
                pairing_rejection_class(credential, None, proof_key_thumbprint)
                    .unwrap_or("unclassified"),
            );
            return Err(AuthError::InvalidCredential);
        };
        if let Some(class) = pairing_rejection_class(
            credential,
            Some(RefusedPairing {
                revoked: pairing.revoked_at_ms.is_some(),
                consumed: pairing.consumed_at_ms.is_some(),
                expired: pairing.expires_at_ms <= now,
                proof_key_thumbprint: pairing.proof_key_thumbprint.as_deref(),
            }),
            proof_key_thumbprint,
        ) {
            log_pairing_refusal(class);
            return Err(AuthError::InvalidCredential);
        }
        pairing.consumed_at_ms = Some(now);
        let pairing_id = pairing.id.clone();
        let grant = Grant {
            scopes: pairing.scopes.clone(),
            subject: pairing.subject.clone(),
            label: pairing.label.clone(),
            reach: pairing.reach.clone(),
            off_host: pairing.off_host,
            mcp_access: pairing.mcp_access.clone(),
            pairing_id: Some(pairing_id.clone()),
            desktop_bootstrap: false,
            mcp_named_client: pairing.mcp_named_client.clone(),
        };
        self.emit_access_change(
            &state,
            AuthAccessChange::PairingLinkRemoved { id: pairing_id },
        );
        drop(state);
        Ok(grant)
    }
}

impl SessionRecord {
    fn principal(&self) -> Principal {
        Principal {
            session_id: self.session_id.clone(),
            subject: self.subject.clone(),
            method: self.method.clone(),
            scopes: self.scopes.clone(),
            proof_key_thumbprint: self.proof_key_thumbprint.clone(),
            expires_at_ms: self.expires_at_ms,
        }
    }

    fn view(&self, current: bool) -> ClientSessionView {
        ClientSessionView {
            session_id: self.session_id.clone(),
            subject: self.subject.clone(),
            scopes: self.scopes.clone(),
            method: self.method.clone(),
            client: self.client.clone(),
            issued_at: format_iso(self.issued_at_ms),
            expires_at: format_iso(self.expires_at_ms),
            last_connected_at: self.last_connected_at_ms.map(format_iso),
            connected: self.connected_count > 0,
            current,
            reach: self.reach.clone(),
            // An outside agent's access, and what Take over replaced (#139, slice X1).
            mcp_access: self.mcp_access.clone(),
            mcp_access_hand_back: self.mcp_access_hand_back.clone(),
            mcp_resource: self.mcp_resource.clone(),
            mcp_named_client: self.mcp_named_client.clone(),
        }
    }
}

impl PairingRecord {
    fn view(&self) -> PairingLinkView {
        PairingLinkView {
            id: self.id.clone(),
            credential: self.credential.clone(),
            scopes: self.scopes.clone(),
            subject: self.subject.clone(),
            label: self.label.clone(),
            created_at: format_iso(self.created_at_ms),
            expires_at: format_iso(self.expires_at_ms),
            reach: self.reach.clone(),
        }
    }
}

fn cancel_live_connections(state: &mut AuthState, session_id: &str) {
    if let Some(connections) = state.live_connections.remove(session_id) {
        for shutdown in connections.into_values() {
            shutdown.cancel();
        }
    }
}

// The send is synchronous and never waits on a receiver (a lagging one is overwritten), so
// sending under the state lock cannot deadlock.
fn emit_access_change_on(
    _held: &AuthState,
    events: &broadcast::Sender<AuthAccessEvent>,
    revision: &AtomicU64,
    change: AuthAccessChange,
) {
    let revision = revision.fetch_add(1, Ordering::AcqRel) + 1;
    let _ = events.send(AuthAccessEvent { revision, change });
}

async fn authority_has_consumers(
    state: &Mutex<AuthState>,
    access_events: &broadcast::Sender<AuthAccessEvent>,
) -> bool {
    let state = state.lock().await;
    !state.pairings.is_empty()
        || !state.sessions.is_empty()
        || !state.live_connections.is_empty()
        || !state.pending_mcp.is_empty()
        || access_events.receiver_count() > 0
}

/// Converges the cache to `snapshot` and sends its changes under the same lock. `false` means a
/// local change since `expected_generation` fenced it.
async fn reconcile_authority_snapshot(
    state: &Mutex<AuthState>,
    access_events: &broadcast::Sender<AuthAccessEvent>,
    access_revision: &AtomicU64,
    snapshot: PersistedAuthAuthoritySnapshot,
    expected_generation: u64,
) -> Result<bool, AuthError> {
    let pairings = snapshot
        .pairings
        .into_iter()
        .filter(|row| !holds_unknown_scope(&row.scopes))
        .map(pairing_record_from_persisted)
        .collect::<Result<Vec<_>, _>>()?;
    let sessions = snapshot
        .sessions
        .into_iter()
        .filter(|row| !holds_unknown_scope(&row.scopes))
        .map(session_record_from_persisted)
        .collect::<Result<Vec<_>, _>>()?;
    let offers = snapshot
        .offers
        .into_iter()
        .map(stored_pairing_offer_from_persisted)
        .collect::<Result<HashMap<_, _>, _>>()?;
    let pending_mcp = snapshot
        .pending_mcp_authorizations
        .iter()
        .map(pending_mcp_view)
        .collect::<Vec<_>>();
    let named_clients = snapshot.mcp_named_clients;
    let mut state = state.lock().await;
    if state.authority_generation != expected_generation {
        return Ok(false);
    }

    let mut changes = Vec::new();
    let mut next_pairings = HashMap::with_capacity(pairings.len());
    for pairing in pairings {
        if !state.pairings.contains_key(&pairing.id) {
            changes.push(AuthAccessChange::PairingLinkUpserted(pairing.view()));
        }
        next_pairings.insert(pairing.id.clone(), pairing);
    }
    for pairing_id in state.pairings.keys() {
        if !next_pairings.contains_key(pairing_id) {
            changes.push(AuthAccessChange::PairingLinkRemoved {
                id: pairing_id.clone(),
            });
        }
    }

    let mut next_sessions = HashMap::with_capacity(sessions.len());
    for mut session in sessions {
        if let Some(current) = state.sessions.get(&session.session_id) {
            let previous_view = current.view(false);
            session.connected_count = current.connected_count;
            session.proof_key_thumbprint = current.proof_key_thumbprint.clone();
            session.transport = current.transport;
            if current.last_connected_at_ms > session.last_connected_at_ms {
                session.last_connected_at_ms = current.last_connected_at_ms;
            }
            if session.view(false) != previous_view {
                changes.push(AuthAccessChange::ClientUpserted(Box::new(
                    session.view(false),
                )));
            }
        } else {
            changes.push(AuthAccessChange::ClientUpserted(Box::new(
                session.view(false),
            )));
        }
        next_sessions.insert(session.session_id.clone(), session);
    }
    let removed_sessions = state
        .sessions
        .keys()
        .filter(|session_id| !next_sessions.contains_key(*session_id))
        .cloned()
        .collect::<Vec<_>>();
    for session_id in removed_sessions {
        cancel_live_connections(&mut state, &session_id);
        changes.push(AuthAccessChange::ClientRemoved { session_id });
    }

    if state.pending_mcp != pending_mcp {
        changes.push(AuthAccessChange::PendingMcpAuthorizations);
    }
    if !same_named_clients(&state.named_clients, &named_clients) {
        changes.push(AuthAccessChange::McpNamedClients);
    }
    state.named_clients = named_clients;
    state.pairings = next_pairings;
    state.sessions = next_sessions;
    state.pairing_offer_idempotency = offers;
    state.pending_mcp = pending_mcp;
    for change in changes {
        emit_access_change_on(&state, access_events, access_revision, change);
    }
    Ok(true)
}

/// Whether two lists name the same clients; the Take over flag is not shown, so it is no change.
fn same_named_clients(left: &[LiveMcpNamedClient], right: &[LiveMcpNamedClient]) -> bool {
    left.len() == right.len()
        && left.iter().zip(right).all(|(left, right)| {
            left.id == right.id && left.name == right.name && left.created_at == right.created_at
        })
}

/// A pending remote authorization as BiBCode clients show it: who asks, where it returns,
/// the origin it used, the scopes and the code to compare. No secret is in it.
fn pending_mcp_view(row: &McpOAuthAuthorization) -> PendingMcpAuthorizationView {
    PendingMcpAuthorizationView {
        id: row.id.clone(),
        code: super::oauth::display_user_code(&row.user_code),
        client_name: row.client_name.clone(),
        redirect_host: super::oauth::redirect_host(&row.redirect_uri),
        redirect_is_loopback: super::oauth::redirect_is_loopback(&row.redirect_uri),
        origin: row.origin.clone(),
        scopes: row
            .scopes
            .split_ascii_whitespace()
            .map(str::to_owned)
            .collect(),
        created_at: format_iso(row.created_at_ms),
        expires_at: format_iso(row.expires_at_ms),
        expires_at_ms: row.expires_at_ms,
    }
}

fn persisted_pairing_link(record: &PairingRecord) -> PersistedPairingLink {
    PersistedPairingLink {
        id: record.id.clone(),
        credential: record.credential.clone(),
        method: "one-time-token".to_owned(),
        scopes: serde_json::json!(record.scopes),
        subject: record.subject.clone(),
        label: record.label.clone(),
        proof_key_thumbprint: record.proof_key_thumbprint.clone(),
        created_at: format_iso(record.created_at_ms),
        expires_at: format_iso(record.expires_at_ms),
        consumed_at: record.consumed_at_ms.map(format_iso),
        revoked_at: record.revoked_at_ms.map(format_iso),
        reach: record.reach.clone(),
        off_host: record.off_host,
        mcp_access: record.mcp_access.clone(),
        mcp_named_client: record.mcp_named_client.clone(),
    }
}

fn persisted_auth_session(record: &SessionRecord) -> NewAuthSession {
    NewAuthSession {
        session_id: record.session_id.clone(),
        subject: record.subject.clone(),
        scopes: serde_json::json!(record.scopes),
        method: record.method.clone(),
        client: PersistedAuthSessionClient {
            label: record.client.label.clone(),
            ip_address: record.client.ip_address.clone(),
            user_agent: record.client.user_agent.clone(),
            device_type: record.client.device_type.clone(),
            os: record.client.os.clone(),
            browser: record.client.browser.clone(),
        },
        issued_at: format_iso(record.issued_at_ms),
        expires_at: format_iso(record.expires_at_ms),
        reach: record.reach.clone(),
        off_host: record.off_host,
        mcp_access: record.mcp_access.clone(),
        delivery_state: record.delivery_state,
    }
}

fn pairing_record_from_persisted(row: PersistedPairingLink) -> Result<PairingRecord, AuthError> {
    let scopes = decode_persisted_scopes(row.scopes)?;
    Ok(PairingRecord {
        id: row.id,
        credential: row.credential,
        scopes,
        subject: row.subject,
        label: row.label,
        proof_key_thumbprint: row.proof_key_thumbprint,
        created_at_ms: parse_timestamp_ms(&row.created_at)?,
        expires_at_ms: parse_timestamp_ms(&row.expires_at)?,
        consumed_at_ms: row
            .consumed_at
            .as_deref()
            .map(parse_timestamp_ms)
            .transpose()?,
        revoked_at_ms: row
            .revoked_at
            .as_deref()
            .map(parse_timestamp_ms)
            .transpose()?,
        reach: row.reach,
        off_host: row.off_host,
        mcp_access: row.mcp_access,
        mcp_named_client: row.mcp_named_client,
    })
}

fn stored_pairing_offer_from_persisted(
    offer: PersistedPairingOffer,
) -> Result<((String, String), StoredPairingOffer), AuthError> {
    let expires_at_ms = parse_timestamp_ms(&offer.expires_at)?;
    let result = offer
        .result
        .map(serde_json::from_value::<PairingOfferResult>)
        .transpose()
        .map_err(|error| AuthError::Internal(error.to_string()))?;
    Ok((
        (offer.principal_id, offer.idempotency_key),
        StoredPairingOffer {
            input_fingerprint: offer.input_fingerprint,
            pairing_id: offer.pairing_id,
            result,
            expires_at_ms,
        },
    ))
}

fn pairing_offer_replay_from_persisted(
    offer: &PersistedPairingOffer,
    input_fingerprint: &str,
) -> Result<PairingOfferReplay, AuthError> {
    if offer.cancelled_at.is_some() || offer.result.is_none() {
        return Ok(PairingOfferReplay::Cancelled);
    }
    if offer.input_fingerprint != input_fingerprint {
        return Ok(PairingOfferReplay::Conflict);
    }
    serde_json::from_value::<PairingOfferResult>(
        offer
            .result
            .clone()
            .expect("completed pairing offer checked above"),
    )
    .map(PairingOfferReplay::Original)
    .map_err(|error| AuthError::Internal(error.to_string()))
}

fn reserved_pairing(issuance: PairingIssuance) -> Result<PairingCredentialResult, AuthError> {
    match issuance {
        PairingIssuance::Reserved(issued) => Ok(issued),
        PairingIssuance::Existing(_) => Err(AuthError::Internal(
            "unexpected keyed pairing offer reservation".to_owned(),
        )),
    }
}

fn session_record_from_persisted(row: PersistedAuthSession) -> Result<SessionRecord, AuthError> {
    let scopes = decode_persisted_scopes(row.scopes)?;
    Ok(SessionRecord {
        session_id: row.session_id,
        subject: row.subject,
        scopes,
        method: row.method,
        client: ClientMetadata {
            label: row.client.label,
            ip_address: row.client.ip_address,
            user_agent: row.client.user_agent,
            device_type: row.client.device_type,
            os: row.client.os,
            browser: row.client.browser,
        },
        issued_at_ms: parse_timestamp_ms(&row.issued_at)?,
        expires_at_ms: parse_timestamp_ms(&row.expires_at)?,
        revoked_at_ms: row
            .revoked_at
            .as_deref()
            .map(parse_timestamp_ms)
            .transpose()?,
        last_connected_at_ms: row
            .last_connected_at
            .as_deref()
            .map(parse_timestamp_ms)
            .transpose()?,
        connected_count: 0,
        proof_key_thumbprint: None,
        transport: SessionTransport::Plain,
        reach: row.reach,
        off_host: row.off_host,
        mcp_access: row.mcp_access,
        mcp_access_hand_back: row.mcp_access_hand_back,
        mcp_resource: row.mcp_resource,
        delivery_state: row.delivery_state,
        mcp_named_client: row.mcp_named_client,
    })
}

/// Whether a persisted row names a scope this server does not know: a row a newer server
/// wrote (for example a `diagnostics:read` session after a rollback past #202). Such a row is
/// unusable here, so it is skipped rather than failing startup, and its credential is refused.
fn holds_unknown_scope(value: &serde_json::Value) -> bool {
    value.as_array().is_some_and(|scopes| {
        scopes
            .iter()
            .any(|scope| scope.as_str().is_some_and(|scope| !is_scope(scope)))
    })
}

fn known_scopes_or_warn(value: &serde_json::Value, kind: &'static str, id: &str) -> bool {
    if !holds_unknown_scope(value) {
        return true;
    }
    tracing::warn!(
        kind,
        id,
        "skipping a persisted authorization row with a scope this server does not know \
         (written by a newer BiBCode); it cannot authenticate until that version runs again"
    );
    false
}

fn decode_persisted_scopes(value: serde_json::Value) -> Result<Vec<String>, AuthError> {
    if holds_unknown_scope(&value) {
        return Err(AuthError::InvalidCredential);
    }
    let scopes = serde_json::from_value::<Vec<String>>(value)
        .map_err(|error| AuthError::Internal(error.to_string()))?;
    if scopes.is_empty()
        || scopes.iter().any(|scope| !is_scope(scope))
        || scopes.iter().collect::<HashSet<_>>().len() != scopes.len()
    {
        return Err(AuthError::Internal(
            "persisted authentication scopes are invalid".to_owned(),
        ));
    }
    Ok(scopes)
}

fn parse_timestamp_ms(value: &str) -> Result<i64, AuthError> {
    let timestamp = OffsetDateTime::parse(value, &Rfc3339)
        .map_err(|error| AuthError::Internal(error.to_string()))?;
    i64::try_from(timestamp.unix_timestamp_nanos() / 1_000_000)
        .map_err(|error| AuthError::Internal(error.to_string()))
}

pub fn parse_scopes(value: &str) -> Result<Vec<String>, AuthError> {
    let scopes = value
        .split_ascii_whitespace()
        .map(str::to_owned)
        .collect::<Vec<_>>();
    if scopes.is_empty()
        || scopes.iter().any(|scope| !is_scope(scope))
        || scopes.iter().collect::<HashSet<_>>().len() != scopes.len()
    {
        return Err(AuthError::InvalidScope);
    }
    Ok(scopes)
}

#[must_use]
pub fn owned_scopes(scopes: &[&str]) -> Vec<String> {
    scopes.iter().map(|scope| (*scope).to_owned()).collect()
}

#[must_use]
/// Epoch milliseconds in the store's fixed-width timestamp form; see
/// [`crate::persistence::format_timestamp`].
pub fn format_iso(epoch_ms: i64) -> String {
    crate::persistence::format_timestamp_ms(epoch_ms)
}

#[must_use]
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| i64::try_from(duration.as_millis()).ok())
        .unwrap_or(0)
}

fn is_scope(scope: &str) -> bool {
    ALL_SCOPES.contains(&scope)
}

pub(crate) fn is_loopback_host(host: &str) -> bool {
    let normalized = host.trim().trim_matches(['[', ']']).to_ascii_lowercase();
    normalized == "localhost"
        || normalized
            .parse::<IpAddr>()
            .is_ok_and(|address| match address {
                IpAddr::V4(address) => address.is_loopback(),
                IpAddr::V6(address) => {
                    address
                        .to_ipv4_mapped()
                        .is_some_and(|mapped| mapped.is_loopback())
                        || address.is_loopback()
                }
            })
}

pub(crate) fn is_unspecified_host(host: &str) -> bool {
    host.trim()
        .trim_matches(['[', ']'])
        .parse::<IpAddr>()
        .is_ok_and(|address| match address {
            IpAddr::V4(address) => address.is_unspecified(),
            IpAddr::V6(address) => {
                address
                    .to_ipv4_mapped()
                    .is_some_and(|mapped| mapped.is_unspecified())
                    || address.is_unspecified()
            }
        })
}

fn apply_grant_label(mut client: ClientMetadata, label: Option<String>) -> ClientMetadata {
    if label.is_some() {
        client.label = label;
    }
    client
}

fn map_token_error_to_credential(_error: TokenError) -> AuthError {
    AuthError::InvalidCredential
}

fn constant_time_text_equal(left: &str, right: &str) -> bool {
    left.len() == right.len() && bool::from(left.as_bytes().ct_eq(right.as_bytes()))
}

/// What a refused pairing record says about itself, for the refusal's log class.
struct RefusedPairing<'a> {
    revoked: bool,
    consumed: bool,
    expired: bool,
    proof_key_thumbprint: Option<&'a str>,
}

/// The fixed class of a pairing credential refusal, or `None` when `link` admits it. Only the
/// empty string is told apart as malformed; any other unmatched text is `unknown`.
fn pairing_rejection_class(
    credential: &str,
    link: Option<RefusedPairing<'_>>,
    presented_thumbprint: Option<&str>,
) -> Option<&'static str> {
    if credential.trim().is_empty() {
        return Some("empty");
    }
    let Some(link) = link else {
        return Some("unknown");
    };
    if link.revoked {
        Some("revoked")
    } else if link.consumed {
        Some("already_used")
    } else if link.expired {
        Some("expired")
    } else if link
        .proof_key_thumbprint
        .is_some_and(|expected| Some(expected) != presented_thumbprint)
    {
        Some("proof_key_mismatch")
    } else {
        None
    }
}

/// One `warn` per refused pairing credential: the class only, never the credential, a hash of
/// it, the link, the device or an address.
fn log_pairing_refusal(class: &'static str) {
    tracing::warn!(target: "bibcode_server::auth", class = %class, "a pairing credential was refused");
}

fn generate_pairing_credential() -> Result<String, AuthError> {
    let mut credential = String::with_capacity(PAIRING_LENGTH);
    while credential.len() < PAIRING_LENGTH {
        let mut bytes = [0_u8; PAIRING_LENGTH];
        getrandom::fill(&mut bytes).map_err(|error| AuthError::Internal(error.to_string()))?;
        for byte in bytes {
            if byte >= PAIRING_REJECTION_LIMIT {
                continue;
            }
            credential.push(char::from(
                PAIRING_ALPHABET[usize::from(byte) % PAIRING_ALPHABET.len()],
            ));
            if credential.len() == PAIRING_LENGTH {
                break;
            }
        }
    }
    Ok(credential)
}

/// Issues a one-time administrative pairing link directly against a data
/// root's repositories, without a full [`AuthService`]. Used by the native CLI
/// (`bibcode pairing issue`) beside a running server: credential consumption
/// reads `auth_pairing_links` from the database, so the running server honors
/// links inserted here. Mirrors `issue_startup_pairing` (administrative
/// scopes, `administrative-bootstrap` subject, five-minute TTL).
pub(crate) async fn issue_administrative_pairing_link(
    repositories: &Repositories,
    label: Option<String>,
) -> Result<PairingCredentialResult, AuthError> {
    let now = now_ms();
    let active = repositories
        .list_active_auth_pairing_links(format_iso(now))
        .await
        .map_err(|error| AuthError::Internal(error.to_string()))?;
    if active.len() >= MAX_ACTIVE_PAIRINGS {
        return Err(AuthError::Internal(
            "active pairing capacity exceeded".to_owned(),
        ));
    }
    let record = PairingRecord {
        id: Uuid::new_v4().to_string(),
        credential: generate_pairing_credential()?,
        scopes: owned_scopes(ADMINISTRATIVE_SCOPES),
        subject: "administrative-bootstrap".to_owned(),
        label: label.clone(),
        proof_key_thumbprint: None,
        created_at_ms: now,
        expires_at_ms: now.saturating_add(PAIRING_TTL_MS),
        consumed_at_ms: None,
        revoked_at_ms: None,
        reach: None,
        off_host: None,
        mcp_access: None,
        mcp_named_client: None,
    };
    repositories
        .create_auth_pairing_link(persisted_pairing_link(&record))
        .await
        .map_err(|error| AuthError::Internal(error.to_string()))?;
    Ok(PairingCredentialResult {
        id: record.id,
        credential: record.credential,
        label,
        expires_at: format_iso(record.expires_at_ms),
    })
}

/// Issues a one-time share pairing grant directly against a data root's
/// repositories, without a full [`AuthService`]. Used by `bibcode pairing offer`
/// beside a running server: consumption reads `auth_pairing_links` from the
/// database, so the running server honors grants inserted here. Mirrors
/// `issue_share_pairing` (standard scopes, `one-time-token` subject, reach and
/// off-host recorded, five-minute TTL) rather than the administrative shape,
/// so the off-host confirmation guard and exposure accounting see it.
pub(crate) async fn issue_offline_share_pairing(
    repositories: &Repositories,
    scopes: Vec<String>,
    label: Option<String>,
    reach: String,
    off_host: bool,
) -> Result<PairingCredentialResult, AuthError> {
    if !is_valid_pairing_reach(&reach) {
        return Err(AuthError::InvalidCredential);
    }
    if scopes.is_empty() || scopes.iter().any(|scope| !is_scope(scope)) {
        return Err(AuthError::InvalidScope);
    }
    let now = now_ms();
    let active = repositories
        .list_active_auth_pairing_links(format_iso(now))
        .await
        .map_err(|error| AuthError::Internal(error.to_string()))?;
    if active.len() >= MAX_ACTIVE_PAIRINGS {
        return Err(AuthError::Internal(
            "active pairing capacity exceeded".to_owned(),
        ));
    }
    let record = PairingRecord {
        id: Uuid::new_v4().to_string(),
        credential: generate_pairing_credential()?,
        scopes,
        subject: "one-time-token".to_owned(),
        label: label.clone(),
        proof_key_thumbprint: None,
        created_at_ms: now,
        expires_at_ms: now.saturating_add(PAIRING_TTL_MS),
        consumed_at_ms: None,
        revoked_at_ms: None,
        reach: Some(reach),
        off_host: Some(off_host),
        mcp_access: None,
        mcp_named_client: None,
    };
    repositories
        .create_auth_pairing_link(persisted_pairing_link(&record))
        .await
        .map_err(|error| AuthError::Internal(error.to_string()))?;
    Ok(PairingCredentialResult {
        id: record.id,
        credential: record.credential,
        label,
        expires_at: format_iso(record.expires_at_ms),
    })
}

/// Issues the one-time pairing link an MCP relay (`bibcode mcp`) exchanges for its credential,
/// directly against a data root's repositories, like `issue_administrative_pairing_link`. It
/// never holds more than `orchestration:read orchestration:operate`, so a stolen link cannot be
/// widened at exchange; its subject is `mcp-client`, which binds the session to `/mcp`; and it
/// carries the access ceiling `access` into the session. It lives 60 s. `extra_scopes` may
/// add `terminal:operate` and nothing else: the relay asks for it when terminals are on for MCP
/// agents and the ceiling is full access.
pub(crate) async fn issue_mcp_pairing_link(
    repositories: &Repositories,
    label: String,
    access: &str,
    extra_scopes: &[&str],
) -> Result<PairingCredentialResult, AuthError> {
    issue_mcp_link(repositories, label, access, extra_scopes, None).await
}

/// [`issue_mcp_pairing_link`] for a run of the named client `name` (#280), labelled
/// `MCP · <name>`: the link carries the live identity of that name, made when there is none,
/// so the session it signs in is a run of it. The store must know named clients.
pub(crate) async fn issue_named_mcp_pairing_link(
    repositories: &Repositories,
    name: &str,
    access: &str,
    extra_scopes: &[&str],
) -> Result<PairingCredentialResult, AuthError> {
    issue_mcp_link(
        repositories,
        format!("MCP · {name}"),
        access,
        extra_scopes,
        Some(name),
    )
    .await
}

async fn issue_mcp_link(
    repositories: &Repositories,
    label: String,
    access: &str,
    extra_scopes: &[&str],
    name: Option<&str>,
) -> Result<PairingCredentialResult, AuthError> {
    if let Some(scope) = extra_scopes
        .iter()
        .find(|scope| **scope != super::model::SCOPE_TERMINAL_OPERATE)
    {
        return Err(AuthError::Internal(format!(
            "an MCP credential cannot carry {scope}"
        )));
    }
    let mut scopes = owned_scopes(super::model::MCP_CLIENT_SCOPES);
    scopes.extend(
        extra_scopes
            .iter()
            .map(|scope| (*scope).to_owned())
            .filter(|scope| !scopes.contains(scope))
            .collect::<Vec<_>>(),
    );
    let now = now_ms();
    // A count names no column, so this also works on a store from before migration 70 (#280).
    let active = repositories
        .count_active_auth_pairing_links(format_iso(now))
        .await
        .map_err(|error| AuthError::Internal(error.to_string()))?;
    if active >= MAX_ACTIVE_PAIRINGS {
        return Err(AuthError::Internal(
            "active pairing capacity exceeded".to_owned(),
        ));
    }
    let record = PairingRecord {
        id: Uuid::new_v4().to_string(),
        credential: generate_pairing_credential()?,
        scopes,
        subject: MCP_CLIENT_SUBJECT.to_owned(),
        label: Some(label.clone()),
        proof_key_thumbprint: None,
        created_at_ms: now,
        expires_at_ms: now.saturating_add(MCP_PAIRING_TTL_MS),
        consumed_at_ms: None,
        revoked_at_ms: None,
        reach: None,
        off_host: None,
        mcp_access: Some(access.to_owned()),
        mcp_named_client: None,
    };
    match name {
        Some(name) => repositories
            .create_named_mcp_pairing_link(persisted_pairing_link(&record), name.to_owned())
            .await
            .map(drop),
        None => {
            repositories
                .create_auth_pairing_link(persisted_pairing_link(&record))
                .await
        }
    }
    .map_err(|error| AuthError::Internal(error.to_string()))?;
    Ok(PairingCredentialResult {
        id: record.id,
        credential: record.credential,
        label: Some(label),
        expires_at: format_iso(record.expires_at_ms),
    })
}

#[must_use]
pub fn default_standard_scopes() -> Vec<String> {
    owned_scopes(STANDARD_SCOPES)
}

/// The scopes of a diagnostics-only pairing offer: `diagnostics:read` alone.
#[must_use]
pub fn diagnostics_scopes() -> Vec<String> {
    owned_scopes(super::model::DIAGNOSTICS_SCOPES)
}

#[cfg(test)]
mod tests {
    use crate::rpc::{PairingConfirmationLatch, RpcSessionContext};

    use super::*;

    struct IndependentAuthRepositories {
        _database_directory: tempfile::TempDir,
        first: Repositories,
        second: Repositories,
    }

    impl IndependentAuthRepositories {
        async fn new() -> Self {
            let database_directory = tempfile::tempdir().expect("temporary SQLite directory");
            let database_path = database_directory.path().join("auth.sqlite3");
            let first_database = crate::persistence::Database::create_new(&database_path)
                .await
                .expect("first SQLite connection opens");
            first_database
                .call(|connection| {
                    crate::persistence::run_migrations(connection, None)?;
                    Ok(())
                })
                .await
                .expect("all migrations apply");
            let second_database = crate::persistence::Database::open_existing(&database_path)
                .await
                .expect("second independent SQLite connection opens");
            let first = Repositories::new(first_database);
            let second = Repositories::new(second_database);
            let first_observer = first
                .database()
                .enable_queue_backpressure_observation_for_integration_test()
                .expect("first repository owns a SQLite worker");
            let second_observer = second
                .database()
                .enable_queue_backpressure_observation_for_integration_test()
                .expect("second repository must own an independent SQLite worker");
            drop((first_observer, second_observer));
            Self {
                _database_directory: database_directory,
                first,
                second,
            }
        }

        async fn close(self) {
            self.first.database().clone().close().await;
            self.second.database().clone().close().await;
        }
    }

    #[tokio::test]
    async fn issues_a_persisted_administrative_pairing_a_running_service_exchanges_once() {
        let database = crate::persistence::Database::open_in_memory()
            .await
            .expect("in-memory database opens");
        database
            .call(|connection| {
                crate::persistence::run_migrations(connection, None)?;
                Ok(())
            })
            .await
            .expect("all migrations apply");
        let repositories = Repositories::new(database);

        let issued =
            issue_administrative_pairing_link(&repositories, Some("SSH bootstrap".to_owned()))
                .await
                .expect("pairing link issues");
        assert_eq!(issued.credential.len(), PAIRING_LENGTH);
        assert!(
            issued
                .credential
                .bytes()
                .all(|byte| PAIRING_ALPHABET.contains(&byte))
        );
        assert_eq!(issued.label.as_deref(), Some("SSH bootstrap"));

        let secrets = tempfile::tempdir().expect("secret store directory");
        let secret_store = SecretStore::new(secrets.path())
            .await
            .expect("secret store opens");
        let config = ServerConfig::new(".").with_bind("127.0.0.1", 3773);
        let service = AuthService::new_with_persistence(
            &config,
            vec![7_u8; 32],
            secret_store,
            repositories.clone(),
        )
        .await
        .expect("service hydrates over the same repositories");

        let session = service
            .exchange_bootstrap(
                &issued.credential,
                None,
                ClientMetadata::default(),
                None,
                SessionTransport::Plain,
            )
            .await
            .expect("credential exchanges once");
        assert_eq!(
            session.principal.scopes,
            owned_scopes(ADMINISTRATIVE_SCOPES)
        );
        assert_eq!(session.principal.subject, "administrative-bootstrap");
        assert!(matches!(
            service
                .exchange_bootstrap(
                    &issued.credential,
                    None,
                    ClientMetadata::default(),
                    None,
                    SessionTransport::Plain,
                )
                .await,
            Err(AuthError::InvalidCredential)
        ));
    }

    async fn mcp_test_service() -> (AuthService, Repositories, tempfile::TempDir) {
        let database = crate::persistence::Database::open_in_memory()
            .await
            .expect("in-memory database opens");
        database
            .call(|connection| {
                crate::persistence::run_migrations(connection, None)?;
                Ok(())
            })
            .await
            .expect("all migrations apply");
        let repositories = Repositories::new(database);
        let secrets = tempfile::tempdir().expect("secret store directory");
        let secret_store = SecretStore::new(secrets.path())
            .await
            .expect("secret store opens");
        let config = ServerConfig::new(".").with_bind("127.0.0.1", 3773);
        let service = AuthService::new_with_persistence(
            &config,
            vec![7_u8; 32],
            secret_store,
            repositories.clone(),
        )
        .await
        .expect("service hydrates");
        (service, repositories, secrets)
    }

    #[derive(Clone, Default)]
    struct TraceCapture(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);

    struct TraceCaptureWriter(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);

    impl std::io::Write for TraceCaptureWriter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0
                .lock()
                .expect("trace capture")
                .extend_from_slice(bytes);
            Ok(bytes.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl<'writer> tracing_subscriber::fmt::MakeWriter<'writer> for TraceCapture {
        type Writer = TraceCaptureWriter;

        fn make_writer(&'writer self) -> Self::Writer {
            TraceCaptureWriter(self.0.clone())
        }
    }

    impl TraceCapture {
        fn text(&self) -> String {
            String::from_utf8(self.0.lock().expect("trace capture").clone())
                .expect("trace capture UTF-8")
        }
    }

    /// Consumes `presented` under a fresh capture and checks the one `warn` line it must leave:
    /// the class, and none of the issued credentials nor the presented text.
    async fn assert_refusal_logged(
        service: &AuthService,
        presented: &str,
        thumbprint: Option<&str>,
        class: &str,
        issued: &[String],
    ) {
        let capture = TraceCapture::default();
        let subscriber = tracing_subscriber::fmt()
            .with_writer(capture.clone())
            .with_ansi(false)
            .with_max_level(tracing::Level::DEBUG)
            .finish();
        let _guard = tracing::subscriber::set_default(subscriber);
        let result = service.consume_grant(presented, thumbprint).await;
        assert!(
            matches!(result, Err(AuthError::InvalidCredential)),
            "{class}: the credential is refused, got {:?}",
            result
                .as_ref()
                .map(|grant| format!("Ok(grant for subject {})", grant.subject))
        );
        let text = capture.text();
        let warnings: Vec<&str> = text.lines().filter(|line| line.contains("WARN")).collect();
        assert_eq!(warnings.len(), 1, "{class}: {text}");
        assert!(warnings[0].contains(&format!("class={class}")), "{text}");
        assert!(
            warnings[0].contains("a pairing credential was refused"),
            "{text}"
        );
        for secret in issued
            .iter()
            .map(String::as_str)
            .chain([presented])
            .filter(|secret| !secret.is_empty())
        {
            assert!(!text.contains(secret), "{class}: a credential was logged");
        }
    }

    /// The store compares these timestamps as text (`expires_at > ?`), so text order must be time
    /// order. RFC 3339 with a trimmed fraction is not: `…:00Z` sorts after `…:00.001Z`.
    #[test]
    fn stored_timestamps_sort_as_text_in_time_order() {
        let second = 1_767_225_600_000_i64; // 2026-01-01T00:00:00Z
        let instants =
            [0, 1, 9, 10, 100, 120, 121, 999, 1_000, 1_001].map(|offset| second + offset);
        for earlier in instants {
            for later in instants.into_iter().filter(|later| *later > earlier) {
                assert!(
                    format_iso(earlier) < format_iso(later),
                    "{} must sort before {}",
                    format_iso(earlier),
                    format_iso(later)
                );
            }
        }
    }

    /// A link is refused from the first millisecond after it expires, whatever the fraction of
    /// its expiry. Explicit timestamps, so load cannot change the outcome.
    #[tokio::test]
    async fn a_pairing_link_is_refused_from_the_millisecond_after_it_expires() {
        let (_service, repositories, _secrets) = mcp_test_service().await;
        let second = 1_767_225_600_000_i64;
        for (index, expires_at) in [second, second + 100, second + 120].into_iter().enumerate() {
            let credential = format!("expiry-probe-{index}");
            repositories
                .create_auth_pairing_link(PersistedPairingLink {
                    id: format!("expiry-probe-id-{index}"),
                    credential: credential.clone(),
                    method: "one-time-token".to_owned(),
                    scopes: serde_json::json!(owned_scopes(STANDARD_SCOPES)),
                    subject: "one-time-token".to_owned(),
                    label: None,
                    proof_key_thumbprint: None,
                    created_at: format_iso(expires_at - 60_000),
                    expires_at: format_iso(expires_at),
                    consumed_at: None,
                    revoked_at: None,
                    reach: None,
                    off_host: None,
                    mcp_access: None,
                    mcp_named_client: None,
                })
                .await
                .expect("the link is stored");
            let now = format_iso(expires_at + 1);
            let consumed = repositories
                .consume_auth_pairing_link(credential, None, now.clone(), now.clone())
                .await
                .expect("the store answers");
            assert!(
                consumed.is_none(),
                "expires {} was accepted at {now}",
                format_iso(expires_at)
            );
        }
    }

    fn expired_pairing(issuance: Result<PairingIssuance, AuthError>) -> PairingCredentialResult {
        reserved_pairing(issuance.expect("an expired pairing issues")).expect("reserved")
    }

    /// #358: every refusal of a persisted pairing credential names its class at `warn`.
    #[tokio::test]
    async fn a_refused_pairing_credential_is_logged_at_warn_with_its_class_and_never_the_credential_persisted()
     {
        let (service, _repositories, _secrets) = mcp_test_service().await;
        let scopes = || owned_scopes(STANDARD_SCOPES);
        let mut issued = Vec::new();

        assert_refusal_logged(
            &service,
            "pairing-secret-marker-unknown",
            None,
            "unknown",
            &issued,
        )
        .await;
        assert_refusal_logged(&service, "", None, "empty", &issued).await;

        let revoked = service.issue_pairing(scopes(), None).await.expect("issues");
        issued.push(revoked.credential.clone());
        assert!(service.revoke_pairing(&revoked.id).await.expect("revokes"));
        assert_refusal_logged(&service, &revoked.credential, None, "revoked", &issued).await;

        let used = service.issue_pairing(scopes(), None).await.expect("issues");
        issued.push(used.credential.clone());
        assert!(service.consume_grant(&used.credential, None).await.is_ok());
        assert_refusal_logged(&service, &used.credential, None, "already_used", &issued).await;

        let expired = expired_pairing(
            service
                .issue_pairing_for_subject(
                    scopes(),
                    None,
                    "one-time-token",
                    -1,
                    AuthGrantMetadata::default(),
                    None,
                )
                .await,
        );
        issued.push(expired.credential.clone());
        assert_refusal_logged(&service, &expired.credential, None, "expired", &issued).await;

        let proven = service
            .issue_pairing_with_proof(scopes(), None, "thumbprint-a".to_owned())
            .await
            .expect("issues");
        issued.push(proven.credential.clone());
        assert_refusal_logged(
            &service,
            &proven.credential,
            Some("thumbprint-b"),
            "proof_key_mismatch",
            &issued,
        )
        .await;
    }

    /// #358: the in-memory store can name fewer classes, because it forgets refused records.
    #[tokio::test]
    async fn a_refused_pairing_credential_is_logged_at_warn_with_its_class_and_never_the_credential_in_memory()
     {
        let config = ServerConfig::new(".").with_bind("127.0.0.1", 3773);
        let mut service = AuthService::new(&config, vec![7_u8; 32]);
        service.desktop_bootstrap = Some(DesktopBootstrap {
            credential: "pairing-secret-marker-desktop".into(),
            expires_at_ms: 0,
        });
        let scopes = || owned_scopes(STANDARD_SCOPES);
        let mut issued = vec!["pairing-secret-marker-desktop".to_owned()];

        assert_refusal_logged(
            &service,
            "pairing-secret-marker-unknown",
            None,
            "unknown",
            &issued,
        )
        .await;
        assert_refusal_logged(&service, "", None, "empty", &issued).await;

        // `revoke_pairing` removes the in-memory record, so nothing is left to name the cause.
        let revoked = service.issue_pairing(scopes(), None).await.expect("issues");
        issued.push(revoked.credential.clone());
        assert!(service.revoke_pairing(&revoked.id).await.expect("revokes"));
        assert_refusal_logged(&service, &revoked.credential, None, "unknown", &issued).await;

        // Consumed and expired records survive until the next issue or list prunes them.
        let used = service.issue_pairing(scopes(), None).await.expect("issues");
        issued.push(used.credential.clone());
        assert!(service.consume_grant(&used.credential, None).await.is_ok());
        assert_refusal_logged(&service, &used.credential, None, "already_used", &issued).await;

        let expired = expired_pairing(
            service
                .issue_pairing_for_subject(
                    scopes(),
                    None,
                    "one-time-token",
                    -1,
                    AuthGrantMetadata::default(),
                    None,
                )
                .await,
        );
        issued.push(expired.credential.clone());
        assert_refusal_logged(&service, &expired.credential, None, "expired", &issued).await;

        let proven = service
            .issue_pairing_with_proof(scopes(), None, "thumbprint-a".to_owned())
            .await
            .expect("issues");
        issued.push(proven.credential.clone());
        assert_refusal_logged(
            &service,
            &proven.credential,
            Some("thumbprint-b"),
            "proof_key_mismatch",
            &issued,
        )
        .await;

        assert_refusal_logged(
            &service,
            "pairing-secret-marker-desktop",
            None,
            "desktop_bootstrap_expired",
            &issued,
        )
        .await;
    }

    #[tokio::test]
    async fn the_mcp_issuer_adds_only_the_terminal_scope() {
        let (service, repositories, _secrets) = mcp_test_service().await;
        let issued = issue_mcp_pairing_link(
            &repositories,
            "MCP · terminals".into(),
            "full-access",
            &["terminal:operate"],
        )
        .await
        .expect("link issues");
        let session = service
            .exchange_bootstrap(
                &issued.credential,
                None,
                ClientMetadata::default(),
                None,
                SessionTransport::Plain,
            )
            .await
            .expect("exchange");
        assert_eq!(
            session.principal.scopes,
            owned_scopes(&[
                "orchestration:read",
                "orchestration:operate",
                "terminal:operate"
            ])
        );
        for scope in ["access:write", "relay:write", "orchestration:operate"] {
            assert!(
                issue_mcp_pairing_link(&repositories, "MCP".into(), "full-access", &[scope])
                    .await
                    .is_err(),
                "{scope}"
            );
        }
    }

    #[tokio::test]
    async fn the_mcp_issuer_mints_two_scopes_bound_to_mcp_with_its_ceiling() {
        let (service, repositories, _secrets) = mcp_test_service().await;
        let issued = issue_mcp_pairing_link(
            &repositories,
            "MCP · Claude Code".into(),
            "approval-required",
            &[],
        )
        .await
        .expect("link issues");
        let link = repositories
            .get_auth_pairing_link_by_credential(issued.credential.clone())
            .await
            .expect("read")
            .expect("link exists");
        assert_eq!(link.subject, MCP_CLIENT_SUBJECT);
        assert_eq!(link.mcp_access.as_deref(), Some("approval-required"));
        let lifetime = parse_timestamp_ms(&link.expires_at).unwrap()
            - parse_timestamp_ms(&link.created_at).unwrap();
        assert_eq!(lifetime, 60_000);

        // Exchange cannot widen the grant.
        let widened = service
            .exchange_bootstrap(
                &issued.credential,
                Some(owned_scopes(&["orchestration:read", "terminal:operate"])),
                ClientMetadata::default(),
                None,
                SessionTransport::Plain,
            )
            .await;
        assert!(matches!(widened, Err(AuthError::ScopeNotGranted)));

        let issued =
            issue_mcp_pairing_link(&repositories, "MCP · Claude Code".into(), "read-only", &[])
                .await
                .expect("link issues");
        let session = service
            .exchange_bootstrap(
                &issued.credential,
                None,
                ClientMetadata::default(),
                None,
                SessionTransport::Plain,
            )
            .await
            .expect("exchange");
        assert_eq!(
            session.principal.scopes,
            owned_scopes(&["orchestration:read", "orchestration:operate"])
        );
        let stored = repositories
            .get_auth_session(session.principal.session_id.clone())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(stored.mcp_access.as_deref(), Some("read-only"));
        assert_eq!(stored.client.label.as_deref(), Some("MCP · Claude Code"));

        // Audience: only the MCP surface accepts it.
        assert!(matches!(
            service
                .authenticate_token(&session.token, SessionTransport::Plain)
                .await,
            Err(AuthError::InvalidCredential)
        ));
        let super::McpClientCredential {
            principal, access, ..
        } = service
            .authenticate_mcp_client(&session.token)
            .await
            .expect("the MCP surface accepts it");
        assert_eq!(principal.session_id, session.principal.session_id);
        assert_eq!(access.as_deref(), Some("read-only"));
        let ticket = service
            .issue_websocket_ticket(&principal)
            .expect("ticket signs")
            .0;
        assert!(service.verify_websocket_ticket(&ticket).await.is_err());

        // Revoking the row through the data root ends it on the next request.
        repositories
            .revoke_auth_session(principal.session_id.clone(), format_iso(now_ms()))
            .await
            .unwrap();
        assert!(
            service
                .authenticate_mcp_client(&session.token)
                .await
                .is_err()
        );
    }

    /// An approved remote authorization with an attached code, as the consent page's poll
    /// leaves it (slice R).
    async fn approved_remote_authorization(
        repositories: &Repositories,
        code: &str,
    ) -> McpOAuthAuthorization {
        let now = now_ms();
        let client_id = Uuid::new_v4().to_string();
        repositories
            .register_mcp_oauth_client(
                crate::persistence::McpOAuthClient {
                    client_id: client_id.clone(),
                    client_name: "Codex".to_owned(),
                    redirect_uris: vec!["http://127.0.0.1:53682/callback".to_owned()],
                    source_key: "loopback".to_owned(),
                    created_at_ms: now,
                    approved_at_ms: None,
                    last_used_at_ms: None,
                },
                now,
                super::super::oauth::LIMITS,
            )
            .await
            .unwrap();
        let id = Uuid::new_v4().to_string();
        repositories
            .create_mcp_oauth_authorization(
                crate::persistence::NewMcpOAuthAuthorization {
                    id: id.clone(),
                    user_code: super::super::oauth::random_user_code().unwrap(),
                    client_id,
                    redirect_uri: "http://127.0.0.1:61000/callback".to_owned(),
                    code_challenge: super::super::oauth::s256(&"v".repeat(43)),
                    state: Some("s".to_owned()),
                    resource: "http://127.0.0.1:3773/mcp".to_owned(),
                    scopes: "orchestration:read orchestration:operate".to_owned(),
                    origin: "http://127.0.0.1:3773".to_owned(),
                    source_key: "loopback".to_owned(),
                    status_cookie_hash: super::super::oauth::secret_hash("cookie"),
                    created_at_ms: now,
                    expires_at_ms: now + super::super::oauth::AUTHORIZATION_TTL_MS,
                },
                now,
                super::super::oauth::LIMITS,
            )
            .await
            .unwrap();
        assert!(
            repositories
                .decide_mcp_oauth_authorization(
                    id.clone(),
                    crate::persistence::McpOAuthDecision::Approve {
                        access: "approval-required".to_owned(),
                        scopes: "orchestration:read orchestration:operate".to_owned(),
                    },
                    now,
                )
                .await
                .unwrap()
        );
        assert!(
            repositories
                .attach_mcp_oauth_code(
                    id.clone(),
                    super::super::oauth::secret_hash(code),
                    now + super::super::oauth::CODE_TTL_MS,
                    now,
                )
                .await
                .unwrap()
        );
        repositories
            .get_mcp_oauth_authorization(id)
            .await
            .unwrap()
            .unwrap()
    }

    async fn minted_remote_grant(
        service: &AuthService,
        repositories: &Repositories,
        refresh_token: &str,
    ) -> McpOAuthTokens {
        let authorization = approved_remote_authorization(repositories, "code").await;
        match service
            .mint_mcp_oauth_grant(
                &authorization,
                super::super::oauth::secret_hash("code"),
                super::super::oauth::secret_hash(refresh_token),
                ClientMetadata::default(),
            )
            .await
            .unwrap()
        {
            McpOAuthMint::Minted(tokens) => tokens,
            _ => panic!("the approved code mints a grant"),
        }
    }

    fn rotation(token: &str, successor: &str) -> McpOAuthRefreshRotation {
        let now = now_ms();
        McpOAuthRefreshRotation {
            token_hash: super::super::oauth::secret_hash(token),
            new_token_hash: super::super::oauth::secret_hash(successor),
            client_id: String::new(),
            resource: "http://127.0.0.1:3773/mcp".to_owned(),
            scopes: None,
            new_expires_at: format_iso(now + super::super::oauth::GRANT_TTL_MS),
            now: format_iso(now),
        }
    }

    /// Revision 4 (P1): a one-hour access token on a 30-day grant authenticates at once, and
    /// again after a refresh. The token's expiry and the grant's are checked separately.
    #[tokio::test]
    async fn a_remote_grant_s_hour_long_access_token_works_on_its_thirty_day_grant() {
        let (service, repositories, _secrets) = mcp_test_service().await;
        let tokens = minted_remote_grant(&service, &repositories, "refresh-1").await;
        assert_eq!(tokens.expires_in, 3_600);
        let credential = service
            .authenticate_mcp_client(&tokens.access_token)
            .await
            .expect("an access token works right after the code exchange");
        assert_eq!(
            credential.resource.as_deref(),
            Some("http://127.0.0.1:3773/mcp")
        );
        assert_eq!(credential.access.as_deref(), Some("approval-required"));
        assert!(credential.principal.expires_at_ms < now_ms() + 3_601_000);
        // The person's view of the grant names the address it was granted on, which Remote
        // agents shows when the app's own address is not HTTPS.
        let view = service
            .list_clients("person")
            .await
            .into_iter()
            .find(|client| client.session_id == credential.principal.session_id)
            .unwrap();
        assert_eq!(
            view.mcp_resource.as_deref(),
            Some("http://127.0.0.1:3773/mcp")
        );
        let grant_expiry = service
            .active_session_expiry(&credential.principal.session_id)
            .await
            .unwrap();
        assert!(grant_expiry > now_ms() + 29 * 24 * 60 * 60 * 1_000);

        let client_id = repositories
            .get_mcp_oauth_authorization_by_code(super::super::oauth::secret_hash("code"))
            .await
            .unwrap()
            .unwrap()
            .client_id;
        let refreshed = match service
            .rotate_mcp_oauth_refresh_token(McpOAuthRefreshRotation {
                client_id: client_id.clone(),
                ..rotation("refresh-1", "refresh-2")
            })
            .await
            .unwrap()
        {
            McpOAuthRefresh::Rotated(tokens) => tokens,
            _ => panic!("an unused refresh token rotates"),
        };
        service
            .authenticate_mcp_client(&refreshed.access_token)
            .await
            .expect("an access token works right after a refresh");
        service
            .authenticate_mcp_client(&tokens.access_token)
            .await
            .expect("the earlier access token lives until its own expiry");

        // Reuse (Revision 3): the old refresh token again revokes the whole grant.
        assert!(matches!(
            service
                .rotate_mcp_oauth_refresh_token(McpOAuthRefreshRotation {
                    client_id: client_id.clone(),
                    ..rotation("refresh-1", "refresh-3")
                })
                .await
                .unwrap(),
            McpOAuthRefresh::Reused
        ));
        assert!(
            service
                .authenticate_mcp_client(&refreshed.access_token)
                .await
                .is_err()
        );
        assert!(matches!(
            service
                .rotate_mcp_oauth_refresh_token(McpOAuthRefreshRotation {
                    client_id,
                    ..rotation("refresh-2", "refresh-4")
                })
                .await
                .unwrap(),
            McpOAuthRefresh::InvalidGrant
        ));
    }

    /// The grant's expiry and the token's are separate: a token past its own `exp` fails on
    /// a live grant, and a token never outlives its grant.
    #[tokio::test]
    async fn a_remote_access_token_fails_past_its_own_expiry_or_its_grant_s() {
        let (service, repositories, _secrets) = mcp_test_service().await;
        let tokens = minted_remote_grant(&service, &repositories, "refresh-1").await;
        let credential = service
            .authenticate_mcp_client(&tokens.access_token)
            .await
            .unwrap();
        let session_id = credential.principal.session_id.clone();
        let mut claims: SessionClaims = service.signer.verify(&tokens.access_token).unwrap();
        claims.exp = now_ms() - 1;
        let expired = service.signer.issue(&claims).unwrap();
        assert!(service.authenticate_mcp_client(&expired).await.is_err());
        let grant_expiry = service.active_session_expiry(&session_id).await.unwrap();
        claims.exp = grant_expiry + 1;
        let beyond_grant = service.signer.issue(&claims).unwrap();
        assert!(
            service
                .authenticate_mcp_client(&beyond_grant)
                .await
                .is_err()
        );
        // A grant past its own expiry refuses even an access token that has not expired.
        let past = format_iso(now_ms() - 1);
        repositories
            .database()
            .call(move |connection| {
                connection.execute(
                    "UPDATE auth_sessions SET expires_at = ? WHERE session_id = ?",
                    rusqlite::params![past, session_id],
                )?;
                Ok(())
            })
            .await
            .unwrap();
        assert!(
            service
                .authenticate_mcp_client(&tokens.access_token)
                .await
                .is_err()
        );
    }

    /// Review round 2: refresh-token history stays bounded per grant, and the reuse of a
    /// recent old token is still detected.
    #[tokio::test]
    async fn a_thousand_refreshes_keep_the_token_history_bounded() {
        let (service, repositories, _secrets) = mcp_test_service().await;
        let _tokens = minted_remote_grant(&service, &repositories, "refresh-0").await;
        let client_id = repositories
            .get_mcp_oauth_authorization_by_code(super::super::oauth::secret_hash("code"))
            .await
            .unwrap()
            .unwrap()
            .client_id;
        for index in 0..1_000 {
            let outcome = repositories
                .rotate_mcp_oauth_refresh_token(
                    McpOAuthRefreshRotation {
                        client_id: client_id.clone(),
                        ..rotation(
                            &format!("refresh-{index}"),
                            &format!("refresh-{}", index + 1),
                        )
                    },
                    now_ms(),
                )
                .await
                .unwrap();
            assert!(
                matches!(outcome, McpOAuthRefreshOutcome::Rotated(_)),
                "rotation {index}"
            );
        }
        let rows: i64 = repositories
            .database()
            .call(|connection| {
                Ok(connection.query_row(
                    "SELECT COUNT(*) FROM mcp_oauth_refresh_tokens",
                    [],
                    |row| row.get(0),
                )?)
            })
            .await
            .unwrap();
        assert!(rows <= 33, "{rows} refresh-token rows kept");
        // A token used a few rotations ago is still recognized, and revokes the grant.
        assert!(matches!(
            repositories
                .rotate_mcp_oauth_refresh_token(
                    McpOAuthRefreshRotation {
                        client_id,
                        ..rotation("refresh-995", "refresh-x")
                    },
                    now_ms(),
                )
                .await
                .unwrap(),
            McpOAuthRefreshOutcome::Reused { .. }
        ));
    }

    /// A code works once; its second use revokes the session it minted.
    #[tokio::test]
    async fn a_replayed_code_revokes_the_grant_it_minted() {
        let (service, repositories, _secrets) = mcp_test_service().await;
        let tokens = minted_remote_grant(&service, &repositories, "refresh-1").await;
        let authorization = repositories
            .get_mcp_oauth_authorization_by_code(super::super::oauth::secret_hash("code"))
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(
            service
                .mint_mcp_oauth_grant(
                    &authorization,
                    super::super::oauth::secret_hash("code"),
                    super::super::oauth::secret_hash("refresh-other"),
                    ClientMetadata::default(),
                )
                .await
                .unwrap(),
            McpOAuthMint::Replayed
        ));
        assert!(
            service
                .authenticate_mcp_client(&tokens.access_token)
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn the_mcp_surface_refuses_every_other_session() {
        let (service, repositories, _secrets) = mcp_test_service().await;
        let issued = issue_administrative_pairing_link(&repositories, None)
            .await
            .expect("link");
        let session = service
            .exchange_bootstrap(
                &issued.credential,
                Some(owned_scopes(&[
                    "orchestration:read",
                    "orchestration:operate",
                ])),
                ClientMetadata::default(),
                None,
                SessionTransport::Plain,
            )
            .await
            .expect("exchange");
        assert!(matches!(
            service.authenticate_mcp_client(&session.token).await,
            Err(AuthError::InvalidCredential)
        ));
    }

    #[tokio::test]
    async fn authorization_context_rechecks_a_revoked_session() {
        let service = service();
        let issued = service
            .exchange_bootstrap(
                "desktop-test-seed",
                None,
                ClientMetadata::default(),
                None,
                SessionTransport::Plain,
            )
            .await
            .expect("session");
        let context = RpcSessionContext::authenticated(issued.principal.clone(), service.clone());

        assert!(context.is_currently_authorized("orchestration:read").await);
        assert!(
            service
                .revoke_client("administrator", &issued.principal.session_id)
                .await
                .expect("revoke session")
        );
        assert!(!context.is_currently_authorized("orchestration:read").await);
    }

    fn desktop_client() -> ClientMetadata {
        ClientMetadata {
            label: Some("BiBCode Tauri Desktop".to_owned()),
            device_type: "desktop".to_owned(),
            os: Some("macOS".to_owned()),
            ..ClientMetadata::default()
        }
    }

    async fn exchange_desktop_bootstrap(service: &AuthService) -> IssuedSession {
        service
            .exchange_bootstrap(
                "desktop-test-seed",
                None,
                desktop_client(),
                None,
                SessionTransport::Plain,
            )
            .await
            .expect("desktop bootstrap exchanges")
    }

    /// Issues and exchanges a one-time pairing so a test owns an independent
    /// client session; the desktop bootstrap credential supersedes its own
    /// earlier sessions, so it cannot mint several coexisting ones.
    async fn paired_session(service: &AuthService, label: &str) -> IssuedSession {
        let pairing = service
            .issue_pairing(owned_scopes(STANDARD_SCOPES), Some(label.to_owned()))
            .await
            .expect("pairing issues");
        service
            .exchange_bootstrap(
                &pairing.credential,
                None,
                ClientMetadata {
                    label: Some(label.to_owned()),
                    device_type: "mobile".to_owned(),
                    ..ClientMetadata::default()
                },
                None,
                SessionTransport::Plain,
            )
            .await
            .expect("pairing exchanges")
    }

    #[tokio::test]
    async fn desktop_bootstrap_exchange_supersedes_the_previous_desktop_session() {
        let service = service();
        let first = exchange_desktop_bootstrap(&service).await;
        let second_load = exchange_desktop_bootstrap(&service).await;
        let mut events = service.subscribe_access();
        let third_load = exchange_desktop_bootstrap(&service).await;

        let (_, _, clients, _) = service
            .access_snapshot(&third_load.principal.session_id)
            .await;
        assert_eq!(
            clients
                .iter()
                .map(|client| client.session_id.as_str())
                .collect::<Vec<_>>(),
            [third_load.principal.session_id.as_str()],
            "the host's WebView holds exactly one session"
        );
        assert!(clients[0].current);
        assert_eq!(
            clients[0].client.label.as_deref(),
            Some("BiBCode Tauri Desktop")
        );

        let removed = events.recv().await.expect("superseded session removal");
        assert!(matches!(
            removed.change,
            AuthAccessChange::ClientRemoved { ref session_id }
                if *session_id == second_load.principal.session_id
        ));
        let upserted = events.recv().await.expect("new session announcement");
        assert!(matches!(
            upserted.change,
            AuthAccessChange::ClientUpserted(ref view)
                if view.session_id == third_load.principal.session_id
        ));

        for stale in [&first, &second_load] {
            let context =
                RpcSessionContext::authenticated(stale.principal.clone(), service.clone());
            assert!(
                !context.is_currently_authorized("orchestration:read").await,
                "a superseded desktop session no longer authorizes"
            );
        }
        let current =
            RpcSessionContext::authenticated(third_load.principal.clone(), service.clone());
        assert!(current.is_currently_authorized("orchestration:read").await);
    }

    #[tokio::test]
    async fn superseding_a_desktop_session_closes_its_live_connections() {
        let service = service();
        let first = exchange_desktop_bootstrap(&service).await;
        let shutdown = CancellationToken::new();
        service
            .mark_connected(&first.principal.session_id, shutdown.clone())
            .await
            .expect("first session connects");
        assert!(!shutdown.is_cancelled());

        let second = exchange_desktop_bootstrap(&service).await;

        assert!(
            shutdown.is_cancelled(),
            "the superseded session's connection is closed"
        );
        let (_, _, clients, _) = service.access_snapshot(&second.principal.session_id).await;
        assert_eq!(clients.len(), 1);
        assert_eq!(clients[0].session_id, second.principal.session_id);
        assert!(!clients[0].connected);
    }

    #[tokio::test]
    async fn desktop_bootstrap_keeps_one_bearer_and_one_browser_cookie_session_side_by_side() {
        let service = service();
        let bearer = exchange_desktop_bootstrap(&service).await;
        let cookie = service
            .create_browser_session(
                "desktop-test-seed",
                desktop_client(),
                SessionTransport::Plain,
            )
            .await
            .expect("browser session issues");
        let bearer_again = exchange_desktop_bootstrap(&service).await;
        let cookie_again = service
            .create_browser_session(
                "desktop-test-seed",
                desktop_client(),
                SessionTransport::Plain,
            )
            .await
            .expect("browser session re-issues");

        let (_, _, clients, _) = service
            .access_snapshot(&bearer_again.principal.session_id)
            .await;
        let mut remaining = clients
            .iter()
            .map(|client| (client.method.as_str(), client.session_id.as_str()))
            .collect::<Vec<_>>();
        remaining.sort_unstable();
        let mut expected = vec![
            (
                "bearer-access-token",
                bearer_again.principal.session_id.as_str(),
            ),
            (
                "browser-session-cookie",
                cookie_again.principal.session_id.as_str(),
            ),
        ];
        expected.sort_unstable();
        assert_eq!(
            remaining, expected,
            "each method keeps exactly its latest desktop session"
        );
        for stale in [&bearer, &cookie] {
            let context =
                RpcSessionContext::authenticated(stale.principal.clone(), service.clone());
            assert!(!context.is_currently_authorized("orchestration:read").await);
        }
    }

    #[tokio::test]
    async fn pairing_exchanges_never_supersede_each_other_or_the_desktop_session() {
        let service = service();
        let desktop = exchange_desktop_bootstrap(&service).await;
        let mut paired = Vec::new();
        for label in ["Phone", "Tablet"] {
            paired.push(paired_session(&service, label).await.principal.session_id);
        }

        let (_, _, clients, _) = service.access_snapshot(&desktop.principal.session_id).await;
        let mut session_ids = clients
            .iter()
            .map(|client| client.session_id.clone())
            .collect::<Vec<_>>();
        session_ids.sort();
        let mut expected = paired.clone();
        expected.push(desktop.principal.session_id.clone());
        expected.sort();
        assert_eq!(session_ids, expected);
    }

    #[tokio::test(start_paused = true)]
    async fn desktop_supersession_persists_and_survives_authority_convergence() {
        let database = crate::persistence::Database::open_in_memory()
            .await
            .expect("in-memory database opens");
        database
            .call(|connection| {
                crate::persistence::run_migrations(connection, None)?;
                Ok(())
            })
            .await
            .expect("all migrations apply");
        let repositories = Repositories::new(database);
        let secrets = tempfile::tempdir().expect("secret store directory");
        let secret_store = SecretStore::new(secrets.path())
            .await
            .expect("secret store opens");
        let config = ServerConfig::new(".")
            .with_bind("127.0.0.1", 3773)
            .with_desktop("desktop-test-seed")
            .expect("desktop config");
        let service = AuthService::new_with_persistence(
            &config,
            vec![7_u8; 32],
            secret_store,
            repositories.clone(),
        )
        .await
        .expect("persisted service starts");

        let first = exchange_desktop_bootstrap(&service).await;
        let _events = service.subscribe_access();
        let second = exchange_desktop_bootstrap(&service).await;

        let persisted_first = repositories
            .get_auth_session(first.principal.session_id.clone())
            .await
            .expect("persisted session reads")
            .expect("superseded session row remains for audit");
        assert!(
            persisted_first.revoked_at.is_some(),
            "supersession is durable, not memory-only"
        );
        let active = repositories
            .list_active_auth_sessions(format_iso(now_ms()))
            .await
            .expect("active sessions read");
        assert_eq!(
            active
                .iter()
                .map(|session| session.session_id.as_str())
                .collect::<Vec<_>>(),
            [second.principal.session_id.as_str()]
        );

        // The authority watcher reconciles memory with the database every 250 ms;
        // the superseded session must not come back.
        for _ in 0..4 {
            tokio::time::advance(AUTHORITY_CONVERGENCE_INTERVAL).await;
            tokio::task::yield_now().await;
        }
        let (_, _, clients, _) = service.access_snapshot(&second.principal.session_id).await;
        assert_eq!(clients.len(), 1);
        assert_eq!(clients[0].session_id, second.principal.session_id);
    }

    #[tokio::test]
    async fn revoking_other_clients_cancels_every_registered_connection() {
        let auth = service();
        let current = auth
            .exchange_bootstrap(
                "desktop-test-seed",
                None,
                ClientMetadata::default(),
                None,
                SessionTransport::Plain,
            )
            .await
            .expect("current session");
        let first = paired_session(&auth, "first other").await;
        let second = paired_session(&auth, "second other").await;

        let current_shutdown = CancellationToken::new();
        let first_shutdown_a = CancellationToken::new();
        let first_shutdown_b = CancellationToken::new();
        let second_shutdown = CancellationToken::new();
        let current_connection = auth
            .mark_connected(&current.principal.session_id, current_shutdown.clone())
            .await
            .expect("current connection registers");
        auth.mark_connected(&first.principal.session_id, first_shutdown_a.clone())
            .await
            .expect("first connection registers");
        auth.mark_connected(&first.principal.session_id, first_shutdown_b.clone())
            .await
            .expect("second connection registers");
        auth.mark_connected(&second.principal.session_id, second_shutdown.clone())
            .await
            .expect("third connection registers");

        assert_eq!(
            auth.revoke_other_clients(&current.principal.session_id)
                .await
                .expect("revoke other clients"),
            2
        );
        assert!(!current_shutdown.is_cancelled());
        assert!(first_shutdown_a.is_cancelled());
        assert!(first_shutdown_b.is_cancelled());
        assert!(second_shutdown.is_cancelled());

        auth.mark_disconnected(&current.principal.session_id, current_connection)
            .await;
    }

    #[tokio::test]
    async fn connection_registration_rejects_a_session_revoked_after_authentication() {
        let auth = service();
        let issued = auth
            .exchange_bootstrap(
                "desktop-test-seed",
                None,
                ClientMetadata::default(),
                None,
                SessionTransport::Plain,
            )
            .await
            .expect("session");
        auth.authenticate_token(&issued.token, SessionTransport::Plain)
            .await
            .expect("authentication completes before the race pause");
        let session_id = issued.principal.session_id;
        let connection_shutdown = CancellationToken::new();
        let (paused_tx, paused_rx) = tokio::sync::oneshot::channel();
        let (resume_tx, resume_rx) = tokio::sync::oneshot::channel();
        let registering_auth = auth.clone();
        let registering_session_id = session_id.clone();
        let registering_shutdown = connection_shutdown.clone();
        let registration = tokio::spawn(async move {
            paused_tx.send(()).expect("signal deterministic race pause");
            resume_rx.await.expect("resume registration");
            registering_auth
                .mark_connected(&registering_session_id, registering_shutdown)
                .await
        });

        paused_rx.await.expect("registration reached race pause");
        let next_connection_id = auth.state.lock().await.next_connection_id;
        assert!(
            auth.revoke_client("other-session", &session_id)
                .await
                .expect("revoke authenticated session")
        );
        resume_tx.send(()).expect("release registration");
        assert!(matches!(
            registration.await.expect("registration task completes"),
            Err(AuthError::InvalidCredential)
        ));

        assert!(connection_shutdown.is_cancelled());
        let state = auth.state.lock().await;
        assert_eq!(state.next_connection_id, next_connection_id);
        assert!(!state.live_connections.contains_key(&session_id));
    }

    #[tokio::test]
    async fn connection_registration_rejects_an_expired_extant_session() {
        let auth = service();
        let issued = auth
            .exchange_bootstrap(
                "desktop-test-seed",
                None,
                ClientMetadata::default(),
                None,
                SessionTransport::Plain,
            )
            .await
            .expect("session");
        let session_id = issued.principal.session_id;
        {
            let mut state = auth.state.lock().await;
            state
                .sessions
                .get_mut(&session_id)
                .expect("cached session")
                .expires_at_ms = now_ms() - 1;
        }
        let connection_shutdown = CancellationToken::new();
        let next_connection_id = auth.state.lock().await.next_connection_id;

        assert!(matches!(
            auth.mark_connected(&session_id, connection_shutdown.clone())
                .await,
            Err(AuthError::InvalidCredential)
        ));

        assert!(connection_shutdown.is_cancelled());
        let state = auth.state.lock().await;
        assert_eq!(state.next_connection_id, next_connection_id);
        assert!(!state.live_connections.contains_key(&session_id));
        assert_eq!(
            state
                .sessions
                .get(&session_id)
                .expect("expired record remains available for the assertion")
                .connected_count,
            0
        );
    }

    #[tokio::test]
    async fn disconnect_bookkeeping_ignores_unadmitted_connection_ids() {
        let auth = service();
        let issued = auth
            .exchange_bootstrap(
                "desktop-test-seed",
                None,
                ClientMetadata::default(),
                None,
                SessionTransport::Plain,
            )
            .await
            .expect("session");
        let session_id = issued.principal.session_id;
        let connection_id = auth
            .mark_connected(&session_id, CancellationToken::new())
            .await
            .expect("connection registers");

        auth.mark_disconnected(&session_id, connection_id.wrapping_add(1))
            .await;

        assert_eq!(
            auth.state
                .lock()
                .await
                .sessions
                .get(&session_id)
                .expect("live session")
                .connected_count,
            1
        );
        auth.mark_disconnected(&session_id, connection_id).await;
    }

    #[tokio::test]
    async fn dropped_connection_guard_releases_connected_accounting_exactly_once() {
        let auth = service();
        let issued = auth
            .exchange_bootstrap(
                "desktop-test-seed",
                None,
                ClientMetadata::default(),
                None,
                SessionTransport::Plain,
            )
            .await
            .expect("session");
        let session_id = issued.principal.session_id;
        let guard = auth
            .mark_connected_guard(&session_id, CancellationToken::new())
            .await
            .expect("connection guard registers");
        assert_eq!(
            auth.state
                .lock()
                .await
                .sessions
                .get(&session_id)
                .expect("live session")
                .connected_count,
            1
        );

        drop(guard);
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if auth
                    .state
                    .lock()
                    .await
                    .sessions
                    .get(&session_id)
                    .expect("live session")
                    .connected_count
                    == 0
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("guard drop schedules disconnect bookkeeping");
        auth.mark_disconnected(&session_id, u64::MAX).await;
        assert_eq!(
            auth.state
                .lock()
                .await
                .sessions
                .get(&session_id)
                .expect("live session")
                .connected_count,
            0
        );
    }

    #[tokio::test]
    async fn cancelled_guard_registration_releases_bookkeeping_while_persistence_is_queued() {
        let database = crate::persistence::Database::open_in_memory()
            .await
            .expect("in-memory database opens");
        database
            .call(|connection| {
                crate::persistence::run_migrations(connection, None)?;
                Ok(())
            })
            .await
            .expect("all migrations apply");
        let repositories = Repositories::new(database.clone());
        let secrets = tempfile::tempdir().expect("secret store directory");
        let secret_store = SecretStore::new(secrets.path())
            .await
            .expect("secret store opens");
        let config = ServerConfig::new(".")
            .with_bind("127.0.0.1", 3773)
            .with_desktop("desktop-test-seed")
            .expect("desktop config");
        let auth =
            AuthService::new_with_persistence(&config, vec![7_u8; 32], secret_store, repositories)
                .await
                .expect("persistent auth service starts");
        let issued = auth
            .exchange_bootstrap(
                "desktop-test-seed",
                None,
                ClientMetadata::default(),
                None,
                SessionTransport::Plain,
            )
            .await
            .expect("session");
        let session_id = issued.principal.session_id;

        let (worker_entered_tx, worker_entered_rx) = tokio::sync::oneshot::channel();
        let (release_worker_tx, release_worker_rx) = std::sync::mpsc::channel();
        let blocking_database = database.clone();
        let blocker = tokio::spawn(async move {
            blocking_database
                .call(move |_connection| {
                    worker_entered_tx.send(()).expect("signal blocked worker");
                    release_worker_rx.recv().expect("worker release signal");
                    Ok(())
                })
                .await
        });
        worker_entered_rx.await.expect("database worker is blocked");

        let registering_auth = auth.clone();
        let registering_session_id = session_id.clone();
        let registration = tokio::spawn(async move {
            registering_auth
                .mark_connected_guard(&registering_session_id, CancellationToken::new())
                .await
        });
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if auth
                    .state
                    .lock()
                    .await
                    .sessions
                    .get(&session_id)
                    .expect("live session")
                    .connected_count
                    == 1
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("registration mutates in-memory bookkeeping before persistence");

        registration.abort();
        let registration_result = registration.await;
        assert!(matches!(registration_result, Err(error) if error.is_cancelled()));
        release_worker_tx.send(()).expect("release database worker");
        blocker
            .await
            .expect("database blocker joins")
            .expect("database blocker succeeds");

        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let state = auth.state.lock().await;
                let connected_count = state
                    .sessions
                    .get(&session_id)
                    .expect("live session")
                    .connected_count;
                let has_live_token = state.live_connections.contains_key(&session_id);
                drop(state);
                if connected_count == 0 && !has_live_token {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("cancelled registration releases bookkeeping");
        database.close().await;
    }

    #[tokio::test]
    async fn cancelled_pending_session_issuance_revokes_durable_commit_before_state_publication() {
        let database = crate::persistence::Database::open_in_memory()
            .await
            .expect("in-memory database opens");
        database
            .call(|connection| {
                crate::persistence::run_migrations(connection, None)?;
                Ok(())
            })
            .await
            .expect("all migrations apply");
        let repositories = Repositories::new(database.clone());
        let secrets = tempfile::tempdir().expect("secret store directory");
        let secret_store = SecretStore::new(secrets.path())
            .await
            .expect("secret store opens");
        let config = ServerConfig::new(".")
            .with_bind("127.0.0.1", 3773)
            .with_desktop("desktop-test-seed")
            .expect("desktop config");
        let auth = AuthService::new_with_persistence(
            &config,
            vec![7_u8; 32],
            secret_store,
            repositories.clone(),
        )
        .await
        .expect("persistent auth service starts");

        let initial_state_guard = auth.state.lock().await;
        let exchanging_auth = auth.clone();
        // The desktop seed consumes no shared state before issuance, which is
        // what lets this test hold the state lock across the exchange; force
        // the pending delivery the guard protects through the private seam.
        let exchange = tokio::spawn(async move {
            exchanging_auth
                .exchange_bootstrap_with_delivery(
                    "desktop-test-seed",
                    None,
                    ClientMetadata::default(),
                    None,
                    SessionTransport::E2ee,
                    AuthSessionDeliveryState::PendingPairing,
                )
                .await
        });
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if auth.issuance.try_lock().is_err() {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("session issuance waits for the initial state lock");

        drop(initial_state_guard);
        let publication_state_guard = auth.state.lock().await;
        let pending_session = repositories
            .list_active_auth_sessions(format_iso(now_ms()))
            .await
            .expect("durable sessions list")
            .into_iter()
            .find(|session| session.delivery_state == AuthSessionDeliveryState::PendingPairing)
            .expect("pending session commits before state publication");
        assert!(
            !publication_state_guard
                .sessions
                .contains_key(&pending_session.session_id)
        );

        exchange.abort();
        let exchange_result = exchange.await;
        assert!(matches!(exchange_result, Err(error) if error.is_cancelled()));
        drop(publication_state_guard);

        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let persisted = repositories
                    .get_auth_session(pending_session.session_id.clone())
                    .await
                    .expect("persisted session reads")
                    .expect("persisted pending session remains auditable");
                if persisted.revoked_at.is_some() {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("cancelled pending issuance revokes its durable session");
        assert!(
            !auth
                .state
                .lock()
                .await
                .sessions
                .contains_key(&pending_session.session_id)
        );
        database.close().await;
    }

    #[tokio::test]
    async fn cancelled_confirmation_owns_activation_through_latch_publication() {
        let database = crate::persistence::Database::open_in_memory()
            .await
            .expect("in-memory database opens");
        database
            .call(|connection| {
                crate::persistence::run_migrations(connection, None)?;
                Ok(())
            })
            .await
            .expect("all migrations apply");
        let repositories = Repositories::new(database.clone());
        let secrets = tempfile::tempdir().expect("secret store directory");
        let secret_store = SecretStore::new(secrets.path())
            .await
            .expect("secret store opens");
        let config = ServerConfig::new(".")
            .with_bind("127.0.0.1", 3773)
            .with_desktop("desktop-test-seed")
            .expect("desktop config");
        let auth = AuthService::new_with_persistence(
            &config,
            vec![7_u8; 32],
            secret_store,
            repositories.clone(),
        )
        .await
        .expect("persistent auth service starts");
        let offer = auth
            .issue_share_pairing(
                owned_scopes(STANDARD_SCOPES),
                None,
                "another-device".to_owned(),
                true,
            )
            .await
            .expect("off-host share pairing");
        let (issued, confirmation_required) = auth
            .exchange_pairing_bootstrap(&offer.credential, ClientMetadata::default())
            .await
            .expect("pending session issues");
        assert!(confirmation_required);
        let session_id = issued.principal.session_id.clone();
        let latch = PairingConfirmationLatch::default();
        let context = RpcSessionContext::authenticated_pending_pairing(
            issued.principal,
            auth.clone(),
            latch.clone(),
        );

        let publication_state_guard = auth.state.lock().await;
        let confirmation = tokio::spawn(async move { context.confirm_current_pairing().await });
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let persisted = repositories
                    .get_auth_session(session_id.clone())
                    .await
                    .expect("persisted session reads")
                    .expect("persisted session exists");
                if persisted.delivery_state == AuthSessionDeliveryState::Active {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("durable activation commits while state publication is blocked");
        assert_eq!(
            publication_state_guard
                .sessions
                .get(&session_id)
                .expect("cached pending session exists")
                .delivery_state,
            AuthSessionDeliveryState::PendingPairing
        );

        confirmation.abort();
        assert!(matches!(confirmation.await, Err(error) if error.is_cancelled()));
        drop(publication_state_guard);

        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let active = auth
                    .state
                    .lock()
                    .await
                    .sessions
                    .get(&session_id)
                    .is_some_and(|session| {
                        session.delivery_state == AuthSessionDeliveryState::Active
                    });
                if active && latch.is_confirmed() {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("owned activation publishes cached state and confirmation latch");
        assert!(
            !auth
                .revoke_failed_pairing_session(&session_id)
                .await
                .expect("delivery-guard compensation checks the session")
        );
        auth.authenticate_token(&issued.token, SessionTransport::E2ee)
            .await
            .expect("confirmed credential remains authoritative");
        database.close().await;
    }

    fn service() -> AuthService {
        let config = ServerConfig::new(".")
            .with_bind("127.0.0.1", 3773)
            .with_desktop("desktop-test-seed")
            .expect("desktop config");
        AuthService::new(&config, vec![7_u8; 32])
    }

    #[tokio::test]
    async fn active_session_expiry_requires_a_live_unrevoked_session() {
        let auth = service();
        let issue = || {
            auth.exchange_bootstrap(
                "desktop-test-seed",
                None,
                ClientMetadata::default(),
                None,
                SessionTransport::Plain,
            )
        };
        let live = issue().await.expect("session should issue");
        let live_id = live.principal.session_id;
        let expected = auth.state.lock().await.sessions[&live_id].expires_at_ms;
        assert_eq!(auth.active_session_expiry(&live_id).await, Some(expected));
        assert_eq!(auth.active_session_expiry("missing").await, None);

        auth.state
            .lock()
            .await
            .sessions
            .get_mut(&live_id)
            .expect("session record")
            .expires_at_ms = now_ms() - 1;
        assert_eq!(auth.active_session_expiry(&live_id).await, None);

        let revoked = issue().await.expect("session should issue");
        auth.revoke_client("administrator", &revoked.principal.session_id)
            .await
            .expect("revoke session");
        assert_eq!(
            auth.active_session_expiry(&revoked.principal.session_id)
                .await,
            None
        );
    }

    #[tokio::test]
    async fn share_pairing_reach_is_recorded_and_inherited_by_sessions() {
        let auth = service();
        let issued = auth
            .issue_share_pairing(
                owned_scopes(STANDARD_SCOPES),
                Some("Tablet".to_owned()),
                "another-device".to_owned(),
                true,
            )
            .await
            .expect("share pairing");
        let listed = auth.list_pairings().await;
        assert_eq!(listed[0].reach.as_deref(), Some("another-device"));

        let session = auth
            .exchange_bootstrap(
                &issued.credential,
                None,
                ClientMetadata::default(),
                None,
                SessionTransport::Plain,
            )
            .await
            .expect("session");
        let clients = auth.list_clients(&session.principal.session_id).await;
        let paired = clients
            .iter()
            .find(|client| client.session_id == session.principal.session_id)
            .expect("paired client");
        assert_eq!(paired.reach.as_deref(), Some("another-device"));
    }

    #[tokio::test]
    async fn off_host_pairing_mints_pending_and_refuses_the_bearer_until_confirmed() {
        let auth = service();
        let offer = auth
            .issue_share_pairing(
                owned_scopes(STANDARD_SCOPES),
                None,
                "another-device".to_owned(),
                true,
            )
            .await
            .expect("off-host share pairing");
        let (issued, confirmation_required) = auth
            .exchange_pairing_bootstrap(&offer.credential, ClientMetadata::default())
            .await
            .expect("pending session issues");
        assert!(
            confirmation_required,
            "an off-host grant always requires confirmation; the client sends no flag"
        );
        assert!(matches!(
            auth.authenticate_token(&issued.token, SessionTransport::E2ee)
                .await,
            Err(AuthError::InvalidCredential)
        ));

        assert!(
            auth.confirm_pending_pairing_session(&issued.principal.session_id)
                .await
                .expect("confirmation commits")
        );
        auth.authenticate_token(&issued.token, SessionTransport::E2ee)
            .await
            .expect("confirmed credential authenticates");
    }

    #[tokio::test]
    async fn on_host_pairing_mints_an_active_credential_without_confirmation() {
        let auth = service();
        let offer = auth
            .issue_share_pairing(
                owned_scopes(STANDARD_SCOPES),
                None,
                "this-computer".to_owned(),
                false,
            )
            .await
            .expect("on-host share pairing");
        let (issued, confirmation_required) = auth
            .exchange_pairing_bootstrap(&offer.credential, ClientMetadata::default())
            .await
            .expect("active session issues");
        assert!(!confirmation_required);
        auth.authenticate_token(&issued.token, SessionTransport::E2ee)
            .await
            .expect("on-host credential is delivered immediately");
    }

    #[tokio::test]
    async fn pending_pairing_sweep_only_revokes_sessions_past_the_grace_window() {
        let database = crate::persistence::Database::open_in_memory()
            .await
            .expect("in-memory database opens");
        database
            .call(|connection| {
                crate::persistence::run_migrations(connection, None)?;
                Ok(())
            })
            .await
            .expect("all migrations apply");
        let repositories = Repositories::new(database.clone());
        let now = now_ms();
        let session_id = Uuid::new_v4().to_string();
        repositories
            .create_auth_session(NewAuthSession {
                session_id: session_id.clone(),
                subject: "pairing-sweep-test".to_owned(),
                scopes: serde_json::json!(owned_scopes(STANDARD_SCOPES)),
                method: "bearer-access-token".to_owned(),
                client: PersistedAuthSessionClient {
                    label: Some("Pairing sweep test".to_owned()),
                    ip_address: None,
                    user_agent: None,
                    device_type: "desktop".to_owned(),
                    os: None,
                    browser: None,
                },
                issued_at: format_iso(now),
                expires_at: format_iso(now + SESSION_TTL_MS),
                reach: Some(PAIRING_REACH_ANOTHER_DEVICE.to_owned()),
                off_host: Some(true),
                mcp_access: None,
                delivery_state: AuthSessionDeliveryState::PendingPairing,
            })
            .await
            .expect("pending session persists");

        // A sweep whose cutoff predates the mint leaves the fresh pending
        // session alone — a restart cannot revoke an in-flight pairing.
        let swept = repositories
            .revoke_pending_auth_sessions(
                format_iso(now),
                format_iso(now - PENDING_PAIRING_SWEEP_GRACE_MS),
            )
            .await
            .expect("age-gated sweep runs");
        assert!(swept.is_empty(), "fresh pending sessions survive the sweep");

        // Once the session is older than the grace window it is a crash
        // orphan and the sweep revokes it.
        let swept = repositories
            .revoke_pending_auth_sessions(format_iso(now), format_iso(now))
            .await
            .expect("expired sweep runs");
        assert_eq!(swept, vec![session_id]);
        database.close().await;
    }

    #[tokio::test]
    async fn confirm_pairing_policy_is_pending_capability_or_access_write() {
        use crate::auth::model::SCOPE_ACCESS_WRITE;
        // The declared scope governs third-party callers…
        assert_eq!(
            crate::auth::required_scope("auth.confirmPairing"),
            Some(SCOPE_ACCESS_WRITE)
        );
        // …which standard device grants do not carry, so a delivered
        // (non-pending) device session cannot invoke confirmation…
        let auth = service();
        let offer = auth
            .issue_share_pairing(
                owned_scopes(STANDARD_SCOPES),
                None,
                "this-computer".to_owned(),
                false,
            )
            .await
            .expect("on-host share pairing");
        let (issued, _) = auth
            .exchange_pairing_bootstrap(&offer.credential, ClientMetadata::default())
            .await
            .expect("active session issues");
        assert!(matches!(
            auth.authorize_session(&issued.principal.session_id, SCOPE_ACCESS_WRITE)
                .await,
            Err(AuthError::ScopeRequired(_))
        ));
        // …while a pending session confirms its own delivery through the
        // session capability gate regardless of scopes (see
        // pending_pairing_capability_is_limited_to_confirmation and the e2ee
        // scope-bypass suite).
    }

    #[tokio::test]
    async fn websocket_tickets_are_single_use_and_plain_transport_only() {
        let auth = service();
        let offer = auth
            .issue_share_pairing(
                owned_scopes(STANDARD_SCOPES),
                None,
                "this-computer".to_owned(),
                false,
            )
            .await
            .expect("plain share pairing");
        let plain = auth
            .exchange_bootstrap(
                &offer.credential,
                None,
                ClientMetadata::default(),
                None,
                SessionTransport::Plain,
            )
            .await
            .expect("plain session");
        let (ticket, _expires_at) = auth
            .issue_websocket_ticket(&plain.principal)
            .expect("ticket issues");
        auth.verify_websocket_ticket(&ticket)
            .await
            .expect("first redemption authenticates");
        assert!(
            matches!(
                auth.verify_websocket_ticket(&ticket).await,
                Err(AuthError::InvalidCredential)
            ),
            "a websocket ticket is redeemable exactly once"
        );

        let e2ee_offer = auth
            .issue_share_pairing(
                owned_scopes(STANDARD_SCOPES),
                None,
                "this-computer".to_owned(),
                false,
            )
            .await
            .expect("e2ee share pairing");
        let (e2ee_session, _) = auth
            .exchange_pairing_bootstrap(&e2ee_offer.credential, ClientMetadata::default())
            .await
            .expect("e2ee session");
        let (e2ee_ticket, _expires_at) = auth
            .issue_websocket_ticket(&e2ee_session.principal)
            .expect("ticket issues for the wrong transport");
        assert!(
            matches!(
                auth.verify_websocket_ticket(&e2ee_ticket).await,
                Err(AuthError::InvalidCredential)
            ),
            "tickets never authenticate a non-plain-transport session"
        );
    }

    #[tokio::test]
    async fn share_pairing_rejects_unknown_reach() {
        let auth = service();
        let error = auth
            .issue_share_pairing(
                owned_scopes(STANDARD_SCOPES),
                None,
                "everywhere".to_owned(),
                true,
            )
            .await
            .expect_err("invalid reach");
        assert!(matches!(error, AuthError::InvalidCredential));
    }

    #[tokio::test]
    async fn share_exposure_derives_wide_only_from_native_managed_off_host_grants() {
        let auth = service();
        let state = auth.share_exposure_state().await;
        assert_eq!(state.desired_exposure, "loopback");

        auth.issue_share_pairing(
            owned_scopes(STANDARD_SCOPES),
            None,
            "this-computer".to_owned(),
            false,
        )
        .await
        .expect("this-computer pairing");
        assert_eq!(
            auth.share_exposure_state().await.desired_exposure,
            "loopback"
        );

        auth.issue_share_pairing(
            owned_scopes(STANDARD_SCOPES),
            None,
            "custom".to_owned(),
            false,
        )
        .await
        .expect("loopback custom pairing");
        assert_eq!(
            auth.share_exposure_state().await.desired_exposure,
            "loopback"
        );

        let off_host = auth
            .issue_share_pairing(
                owned_scopes(STANDARD_SCOPES),
                None,
                "another-device".to_owned(),
                true,
            )
            .await
            .expect("off-host pairing");
        let state = auth.share_exposure_state().await;
        assert_eq!(state.desired_exposure, "wide");
        assert_eq!(state.off_host_grant_count, 1);

        let session = auth
            .exchange_bootstrap(
                &off_host.credential,
                None,
                ClientMetadata::default(),
                None,
                SessionTransport::Plain,
            )
            .await
            .expect("off-host session");
        assert_eq!(auth.share_exposure_state().await.desired_exposure, "wide");

        auth.revoke_client("administrator", &session.principal.session_id)
            .await
            .expect("revoke off-host session");
        assert_eq!(
            auth.share_exposure_state().await.desired_exposure,
            "loopback"
        );
    }

    #[tokio::test]
    async fn custom_off_host_grants_remain_externally_managed_after_exchange() {
        let auth = service();
        let custom = auth
            .issue_share_pairing(
                owned_scopes(STANDARD_SCOPES),
                None,
                "custom".to_owned(),
                true,
            )
            .await
            .expect("custom off-host pairing");

        let state = auth.share_exposure_state().await;
        assert_eq!(state.desired_exposure, "loopback");
        assert_eq!(state.off_host_grant_count, 1);

        auth.exchange_bootstrap(
            &custom.credential,
            None,
            ClientMetadata::default(),
            None,
            SessionTransport::Plain,
        )
        .await
        .expect("custom off-host session");

        let state = auth.share_exposure_state().await;
        assert_eq!(state.desired_exposure, "loopback");
        assert_eq!(state.off_host_grant_count, 1);
    }

    #[tokio::test]
    async fn legacy_null_reach_grants_count_separately_and_never_widen() {
        let auth = service();
        let legacy = auth
            .issue_pairing(owned_scopes(STANDARD_SCOPES), None)
            .await
            .expect("legacy pairing");
        auth.exchange_bootstrap(
            &legacy.credential,
            None,
            ClientMetadata::default(),
            None,
            SessionTransport::Plain,
        )
        .await
        .expect("legacy session");

        let state = auth.share_exposure_state().await;
        assert_eq!(state.desired_exposure, "loopback");
        assert_eq!(state.legacy_grant_count, 1);
    }

    #[tokio::test]
    async fn e2ee_minted_tokens_are_rejected_on_plain_surfaces() {
        let auth = service();
        let pairing = auth
            .issue_pairing(owned_scopes(STANDARD_SCOPES), Some("device".to_owned()))
            .await
            .expect("pairing issues");
        let issued = auth
            .exchange_bootstrap(
                &pairing.credential,
                None,
                ClientMetadata::default(),
                None,
                SessionTransport::E2ee,
            )
            .await
            .expect("e2ee session issues");

        assert!(
            auth.authenticate_token(&issued.token, SessionTransport::E2ee)
                .await
                .is_ok()
        );
        assert!(matches!(
            auth.authenticate_token(&issued.token, SessionTransport::Plain)
                .await,
            Err(AuthError::InvalidCredential)
        ));
    }

    #[tokio::test]
    async fn plain_minted_tokens_still_work_on_both_surfaces() {
        let auth = service();
        let pairing = auth
            .issue_pairing(owned_scopes(STANDARD_SCOPES), Some("device".to_owned()))
            .await
            .expect("pairing issues");
        let issued = auth
            .exchange_bootstrap(
                &pairing.credential,
                None,
                ClientMetadata::default(),
                None,
                SessionTransport::Plain,
            )
            .await
            .expect("plain session issues");

        assert!(
            auth.authenticate_token(&issued.token, SessionTransport::Plain)
                .await
                .is_ok()
        );
        assert!(
            auth.authenticate_token(&issued.token, SessionTransport::E2ee)
                .await
                .is_ok()
        );
    }

    #[tokio::test]
    async fn legacy_tokens_without_a_transport_claim_decode_as_plain() {
        let auth = service();
        let issued = auth
            .exchange_bootstrap(
                "desktop-test-seed",
                None,
                ClientMetadata::default(),
                None,
                SessionTransport::Plain,
            )
            .await
            .expect("plain session issues");
        let mut claims = auth
            .signer
            .verify::<serde_json::Value>(&issued.token)
            .expect("issued claims decode");
        claims
            .as_object_mut()
            .expect("claims are an object")
            .remove("tr");
        let legacy_token = auth.signer.issue(&claims).expect("legacy token signs");

        assert!(
            auth.authenticate_token(&legacy_token, SessionTransport::Plain)
                .await
                .is_ok()
        );
    }

    #[tokio::test]
    async fn rejects_expired_session_claims_and_parent_sessions_for_websocket_tickets() {
        let service = service();
        let expired = SessionClaims {
            v: 1,
            kind: "session".to_owned(),
            sid: Uuid::new_v4().to_string(),
            sub: "expired".to_owned(),
            scopes: owned_scopes(STANDARD_SCOPES),
            method: "bearer-access-token".to_owned(),
            jkt: None,
            tr: SessionTransport::Plain.claim().to_owned(),
            iat: now_ms() - 2_000,
            exp: now_ms() - 1_000,
        };
        let token = service.signer.issue(&expired).expect("expired token");
        assert!(matches!(
            service
                .authenticate_token(&token, SessionTransport::Plain)
                .await,
            Err(AuthError::InvalidCredential)
        ));

        let issued = service
            .exchange_bootstrap(
                "desktop-test-seed",
                None,
                ClientMetadata::default(),
                None,
                SessionTransport::Plain,
            )
            .await
            .expect("session");
        let (ticket, _) = service
            .issue_websocket_ticket(&issued.principal)
            .expect("ticket");
        service
            .state
            .lock()
            .await
            .sessions
            .get_mut(&issued.principal.session_id)
            .expect("session row")
            .expires_at_ms = now_ms() - 1;
        assert!(matches!(
            service.verify_websocket_ticket(&ticket).await,
            Err(AuthError::InvalidCredential)
        ));
    }

    #[tokio::test]
    async fn consumes_pairing_credentials_atomically_under_race() {
        let service = service();
        let pairing = service
            .issue_pairing(owned_scopes(STANDARD_SCOPES), None)
            .await
            .expect("pairing");
        let first = service.exchange_bootstrap(
            &pairing.credential,
            None,
            ClientMetadata::default(),
            None,
            SessionTransport::Plain,
        );
        let second = service.exchange_bootstrap(
            &pairing.credential,
            None,
            ClientMetadata::default(),
            None,
            SessionTransport::Plain,
        );
        let (first, second) = tokio::join!(first, second);
        assert_eq!(usize::from(first.is_ok()) + usize::from(second.is_ok()), 1);
    }

    #[tokio::test]
    async fn rejects_expired_pairing_credentials_without_consuming_them() {
        let service = service();
        let pairing = service
            .issue_pairing(owned_scopes(STANDARD_SCOPES), None)
            .await
            .expect("pairing");
        service
            .state
            .lock()
            .await
            .pairings
            .get_mut(&pairing.id)
            .expect("pairing row")
            .expires_at_ms = now_ms() - 1;

        assert!(matches!(
            service
                .exchange_bootstrap(
                    &pairing.credential,
                    None,
                    ClientMetadata::default(),
                    None,
                    SessionTransport::Plain,
                )
                .await,
            Err(AuthError::InvalidCredential)
        ));
    }

    #[tokio::test]
    async fn proof_pairings_and_client_access_lifecycle_cover_public_auth_operations() {
        let service = service();
        assert!(matches!(
            service
                .issue_pairing_with_proof(
                    owned_scopes(STANDARD_SCOPES),
                    Some("Proof client".to_owned()),
                    "   ".to_owned(),
                )
                .await,
            Err(AuthError::InvalidCredential)
        ));
        assert!(matches!(
            service.issue_cloud_pairing(String::new()).await,
            Err(AuthError::InvalidCredential)
        ));

        let proof_pairing = service
            .issue_pairing_with_proof(
                owned_scopes(STANDARD_SCOPES),
                Some("Proof client".to_owned()),
                "proof-thumbprint".to_owned(),
            )
            .await
            .expect("proof pairing should issue");
        assert!(matches!(
            service
                .exchange_bootstrap(
                    &proof_pairing.credential,
                    None,
                    ClientMetadata::default(),
                    Some("wrong-thumbprint".to_owned()),
                    SessionTransport::Plain,
                )
                .await,
            Err(AuthError::InvalidCredential)
        ));
        let proof_session = service
            .exchange_bootstrap(
                &proof_pairing.credential,
                None,
                ClientMetadata::default(),
                Some("proof-thumbprint".to_owned()),
                SessionTransport::Plain,
            )
            .await
            .expect("proof pairing should exchange");
        assert_eq!(
            proof_session.principal.proof_key_thumbprint.as_deref(),
            Some("proof-thumbprint")
        );

        let cloud_pairing = service
            .issue_cloud_pairing("cloud-thumbprint".to_owned())
            .await
            .expect("cloud pairing should issue");
        assert!(
            service
                .list_pairings()
                .await
                .iter()
                .any(|pairing| pairing.id == cloud_pairing.id)
        );
        assert!(!service.revoke_pairing("missing-pairing").await.unwrap());
        assert!(service.revoke_pairing(&cloud_pairing.id).await.unwrap());
        assert!(!service.revoke_pairing(&cloud_pairing.id).await.unwrap());

        let current = service
            .exchange_bootstrap(
                "desktop-test-seed",
                None,
                ClientMetadata::default(),
                None,
                SessionTransport::Plain,
            )
            .await
            .expect("current session should issue");
        let other = paired_session(&service, "other").await;
        let connection_id = service
            .mark_connected(&current.principal.session_id, CancellationToken::new())
            .await
            .expect("connection registers");
        let clients = service.list_clients(&current.principal.session_id).await;
        assert_eq!(clients.len(), 3);
        assert!(clients[0].current);
        assert!(clients[0].connected);
        let (revision, pairings, snapshot_clients, _) =
            service.access_snapshot(&current.principal.session_id).await;
        assert!(revision > 1);
        assert!(pairings.is_empty());
        assert_eq!(snapshot_clients.len(), 3);
        service
            .mark_disconnected(&current.principal.session_id, connection_id)
            .await;

        assert!(matches!(
            service
                .revoke_client(&current.principal.session_id, &current.principal.session_id,)
                .await,
            Err(AuthError::CurrentSessionRevokeNotAllowed)
        ));
        assert!(
            !service
                .revoke_client(&current.principal.session_id, "missing-session")
                .await
                .unwrap()
        );
        assert_eq!(
            service
                .revoke_other_clients(&current.principal.session_id)
                .await
                .expect("other sessions should revoke"),
            2,
        );
        assert_eq!(
            service
                .list_clients(&current.principal.session_id)
                .await
                .len(),
            1
        );
        assert!(matches!(
            service
                .authenticate_token(&other.token, SessionTransport::Plain)
                .await,
            Err(AuthError::InvalidCredential)
        ));
    }

    #[tokio::test]
    async fn auth_error_boundaries_cover_policy_scope_expiry_and_revocation_paths() {
        let unsafe_config = ServerConfig::new(".").with_unsafe_no_auth();
        assert_eq!(
            AuthService::new(&unsafe_config, vec![1_u8; 32])
                .descriptor()
                .policy,
            "unsafe-no-auth"
        );
        let remote_desktop = ServerConfig::new(".")
            .with_bind("0.0.0.0", 3773)
            .with_desktop("remote-desktop")
            .expect("remote desktop config");
        assert_eq!(
            AuthService::new(&remote_desktop, vec![2_u8; 32])
                .descriptor()
                .bootstrap_methods,
            vec!["desktop-bootstrap", "one-time-token"]
        );

        let auth = service();
        assert!(matches!(
            auth.issue_pairing(Vec::new(), None).await,
            Err(AuthError::InvalidScope)
        ));
        let pairing = auth
            .issue_pairing(owned_scopes(STANDARD_SCOPES), Some("Snapshot".to_owned()))
            .await
            .expect("pairing should issue");
        assert_eq!(auth.access_snapshot("missing").await.1.len(), 1);
        assert!(matches!(
            auth.exchange_bootstrap(
                &pairing.credential,
                Some(vec!["access:write".to_owned()]),
                ClientMetadata::default(),
                None,
                SessionTransport::Plain,
            )
            .await,
            Err(AuthError::ScopeNotGranted)
        ));

        let issued = auth
            .exchange_bootstrap(
                "desktop-test-seed",
                None,
                ClientMetadata::default(),
                None,
                SessionTransport::Plain,
            )
            .await
            .expect("session should issue");
        assert!(matches!(
            auth
                .authorize_session(&issued.principal.session_id, "missing:scope")
                .await,
            Err(AuthError::ScopeRequired(scope)) if scope == "missing:scope"
        ));
        auth.state
            .lock()
            .await
            .sessions
            .get_mut(&issued.principal.session_id)
            .expect("session record")
            .expires_at_ms = now_ms() - 1;
        assert!(matches!(
            auth.authorize_session(&issued.principal.session_id, "orchestration:read")
                .await,
            Err(AuthError::InvalidCredential)
        ));

        let mismatched = auth
            .exchange_bootstrap(
                "desktop-test-seed",
                None,
                ClientMetadata::default(),
                None,
                SessionTransport::Plain,
            )
            .await
            .expect("mismatched session should issue");
        auth.state
            .lock()
            .await
            .sessions
            .get_mut(&mismatched.principal.session_id)
            .expect("mismatched session record")
            .subject = "changed-subject".to_owned();
        assert!(matches!(
            auth.authenticate_token(&mismatched.token, SessionTransport::Plain)
                .await,
            Err(AuthError::InvalidCredential)
        ));

        let revoked_pairing = auth
            .issue_pairing(owned_scopes(STANDARD_SCOPES), None)
            .await
            .expect("revoked pairing should issue");
        auth.state
            .lock()
            .await
            .pairings
            .get_mut(&revoked_pairing.id)
            .expect("revoked pairing record")
            .revoked_at_ms = Some(now_ms());
        assert!(!auth.revoke_pairing(&revoked_pairing.id).await.unwrap());

        let revoked_client = auth
            .exchange_bootstrap(
                "desktop-test-seed",
                None,
                ClientMetadata::default(),
                None,
                SessionTransport::Plain,
            )
            .await
            .expect("revoked client should issue");
        auth.state
            .lock()
            .await
            .sessions
            .get_mut(&revoked_client.principal.session_id)
            .expect("revoked client record")
            .revoked_at_ms = Some(now_ms());
        assert!(
            !auth
                .revoke_client("current", &revoked_client.principal.session_id)
                .await
                .unwrap()
        );
        let removable = auth
            .exchange_bootstrap(
                "desktop-test-seed",
                None,
                ClientMetadata::default(),
                None,
                SessionTransport::Plain,
            )
            .await
            .expect("removable client should issue");
        assert!(
            auth.revoke_client("current", &removable.principal.session_id)
                .await
                .unwrap()
        );
        assert!(matches!(
            auth.mark_connected("missing-session", CancellationToken::new())
                .await,
            Err(AuthError::InvalidCredential)
        ));

        let mut expired_service = service();
        expired_service
            .desktop_bootstrap
            .as_mut()
            .expect("desktop bootstrap")
            .expires_at_ms = now_ms() - 1;
        assert!(matches!(
            expired_service
                .exchange_bootstrap(
                    "desktop-test-seed",
                    None,
                    ClientMetadata::default(),
                    None,
                    SessionTransport::Plain,
                )
                .await,
            Err(AuthError::InvalidCredential)
        ));
        assert!(decode_persisted_scopes(serde_json::json!([])).is_err());
        assert!(decode_persisted_scopes(serde_json::json!(["unknown:scope"])).is_err());
    }

    /// A server rolled back past a scope it does not know still starts: the newer rows are
    /// skipped, and their credential is refused instead of failing startup.
    #[tokio::test]
    async fn rows_with_a_scope_this_server_does_not_know_are_skipped_at_startup() {
        let database = crate::persistence::Database::open_in_memory()
            .await
            .expect("in-memory database opens");
        database
            .call(|connection| {
                crate::persistence::run_migrations(connection, None)?;
                Ok(())
            })
            .await
            .expect("all migrations apply");
        let repositories = Repositories::new(database.clone());
        let secrets = tempfile::tempdir().expect("secret store directory");
        let config = ServerConfig::new(".").with_bind("127.0.0.1", 3773);
        let first = AuthService::new_with_persistence(
            &config,
            vec![7_u8; 32],
            SecretStore::new(secrets.path())
                .await
                .expect("secret store"),
            repositories.clone(),
        )
        .await
        .expect("first start");
        let mut sessions = Vec::new();
        for label in ["kept", "from-a-newer-server"] {
            let issued = first
                .issue_pairing(owned_scopes(STANDARD_SCOPES), Some(label.to_owned()))
                .await
                .expect("pairing");
            let session = first
                .exchange_bootstrap(
                    &issued.credential,
                    None,
                    ClientMetadata::default(),
                    None,
                    SessionTransport::Plain,
                )
                .await
                .expect("session");
            sessions.push(session.principal.session_id);
        }
        first
            .issue_pairing(owned_scopes(STANDARD_SCOPES), Some("later-link".to_owned()))
            .await
            .expect("unused pairing");
        drop(first);
        let newer = sessions[1].clone();
        database
            .call(move |connection| {
                connection.execute(
                    "UPDATE auth_sessions SET scopes = '[\"a-later:scope\"]' WHERE session_id = ?1",
                    [&newer],
                )?;
                connection.execute(
                    "UPDATE auth_pairing_links SET scopes = '[\"a-later:scope\"]' \
                     WHERE label = 'later-link'",
                    [],
                )?;
                Ok(())
            })
            .await
            .expect("rows from a newer server");

        let restarted = AuthService::new_with_persistence(
            &config,
            vec![7_u8; 32],
            SecretStore::new(secrets.path())
                .await
                .expect("secret store"),
            repositories,
        )
        .await
        .expect("a newer server's rows do not stop startup");

        let clients = restarted.list_clients(&sessions[0]).await;
        assert!(
            clients
                .iter()
                .any(|client| client.session_id == sessions[0])
        );
        assert!(
            !clients
                .iter()
                .any(|client| client.session_id == sessions[1])
        );
        assert!(restarted.list_pairings().await.is_empty());
        assert!(
            restarted
                .authorize_session(&sessions[0], super::super::model::SCOPE_ORCHESTRATION_READ)
                .await
                .is_ok()
        );
        assert!(matches!(
            restarted
                .authorize_session(&sessions[1], super::super::model::SCOPE_ORCHESTRATION_READ)
                .await,
            Err(AuthError::InvalidCredential)
        ));
    }

    #[test]
    fn parses_only_unique_known_non_empty_scopes() {
        assert_eq!(
            parse_scopes("orchestration:read terminal:operate").expect("scopes"),
            ["orchestration:read", "terminal:operate"]
        );
        for invalid in ["", "unknown:scope", "orchestration:read orchestration:read"] {
            assert!(matches!(
                parse_scopes(invalid),
                Err(AuthError::InvalidScope)
            ));
        }
        assert!(decode_persisted_scopes(serde_json::json!(42)).is_err());
        assert!(parse_timestamp_ms("not-a-timestamp").is_err());
        assert_eq!(format_iso(i64::MAX), "1970-01-01T00:00:00.000000000Z");
        assert_eq!(
            format_iso(1_767_225_600_120),
            "2026-01-01T00:00:00.120000000Z"
        );
        assert_eq!(
            parse_timestamp_ms(&format_iso(1_767_225_600_120)).ok(),
            Some(1_767_225_600_120)
        );
    }

    #[tokio::test]
    async fn credential_issuance_prunes_expired_state_and_caps_active_memory() {
        let service = service();
        let now = now_ms();
        {
            let mut state = service.state.lock().await;
            for index in 0..MAX_ACTIVE_PAIRINGS {
                let id = format!("pairing-{index}");
                state.pairings.insert(
                    id.clone(),
                    PairingRecord {
                        id,
                        credential: format!("CREDENTIAL{index}"),
                        scopes: owned_scopes(STANDARD_SCOPES),
                        subject: "test".to_owned(),
                        label: None,
                        proof_key_thumbprint: None,
                        created_at_ms: now,
                        expires_at_ms: now + PAIRING_TTL_MS,
                        consumed_at_ms: None,
                        revoked_at_ms: None,
                        reach: None,
                        off_host: None,
                        mcp_access: None,
                        mcp_named_client: None,
                    },
                );
            }
        }
        assert!(matches!(
            service
                .issue_pairing(owned_scopes(STANDARD_SCOPES), None)
                .await,
            Err(AuthError::Internal(message)) if message == "active pairing capacity exceeded"
        ));
        service
            .state
            .lock()
            .await
            .pairings
            .get_mut("pairing-0")
            .expect("pairing fixture")
            .expires_at_ms = now - 1;
        service
            .issue_pairing(owned_scopes(STANDARD_SCOPES), None)
            .await
            .expect("expired pairing frees capacity");
        assert_eq!(
            service.state.lock().await.pairings.len(),
            MAX_ACTIVE_PAIRINGS
        );

        {
            let mut state = service.state.lock().await;
            for index in 0..MAX_ACTIVE_SESSIONS {
                let session_id = format!("session-{index}");
                state.sessions.insert(
                    session_id.clone(),
                    SessionRecord {
                        session_id,
                        subject: "test".to_owned(),
                        scopes: owned_scopes(STANDARD_SCOPES),
                        method: "bearer-access-token".to_owned(),
                        client: ClientMetadata::default(),
                        issued_at_ms: now,
                        expires_at_ms: now + SESSION_TTL_MS,
                        revoked_at_ms: None,
                        last_connected_at_ms: None,
                        connected_count: 0,
                        proof_key_thumbprint: None,
                        transport: SessionTransport::Plain,
                        reach: None,
                        off_host: None,
                        mcp_access: None,
                        mcp_access_hand_back: None,
                        mcp_resource: None,
                        delivery_state: AuthSessionDeliveryState::Active,
                        mcp_named_client: None,
                    },
                );
            }
        }
        assert!(matches!(
            service
                .exchange_bootstrap(
                    "desktop-test-seed",
                    None,
                    ClientMetadata::default(),
                    None,
                    SessionTransport::Plain,
                )
                .await,
            Err(AuthError::Internal(message)) if message == "active session capacity exceeded"
        ));
    }

    async fn insert_live_pairing(service: &AuthService, id: &str) {
        let now = now_ms();
        service.state.lock().await.pairings.insert(
            id.to_owned(),
            PairingRecord {
                id: id.to_owned(),
                credential: format!("credential-{id}"),
                scopes: owned_scopes(STANDARD_SCOPES),
                subject: "one-time-token".to_owned(),
                label: None,
                proof_key_thumbprint: None,
                created_at_ms: now,
                expires_at_ms: now + PAIRING_TTL_MS,
                consumed_at_ms: None,
                revoked_at_ms: None,
                reach: Some("another-device".to_owned()),
                off_host: Some(true),
                mcp_access: None,
                mcp_named_client: None,
            },
        );
    }

    #[tokio::test]
    async fn replaying_a_consumed_offer_returns_fresh_instead_of_a_dead_code() {
        let service = service();
        let offer = PairingOfferResult {
            id: "offer-consumed".to_owned(),
            code: "code-consumed".to_owned(),
            reach: "another-device".to_owned(),
            endpoint: "http://192.168.1.20:3773".to_owned(),
            name: "Tablet".to_owned(),
            expires_at: format_iso(now_ms() + PAIRING_TTL_MS),
        };
        insert_live_pairing(&service, &offer.id).await;
        service
            .record_pairing_offer(
                "principal",
                "request-key".to_owned(),
                "fingerprint".to_owned(),
                offer.clone(),
            )
            .await
            .expect("offer records");
        assert!(matches!(
            service
                .replay_pairing_offer("principal", "request-key", "fingerprint")
                .await,
            Ok(PairingOfferReplay::Original(result)) if result.id == offer.id
        ));

        // A device consumes the link; the recorded result now advertises a
        // dead code and must not be replayed as fresh success.
        service.state.lock().await.pairings.remove(&offer.id);
        assert!(matches!(
            service
                .replay_pairing_offer("principal", "request-key", "fingerprint")
                .await,
            Ok(PairingOfferReplay::Fresh)
        ));
    }

    #[tokio::test]
    async fn pairing_offer_idempotency_is_scoped_to_the_authenticated_principal() {
        let service = service();
        let first = PairingOfferResult {
            id: "offer-a".to_owned(),
            code: "code-a".to_owned(),
            reach: "another-device".to_owned(),
            endpoint: "http://192.168.1.20:3773".to_owned(),
            name: "Tablet A".to_owned(),
            expires_at: format_iso(now_ms() + PAIRING_TTL_MS),
        };
        insert_live_pairing(&service, &first.id).await;
        service
            .record_pairing_offer(
                "principal-a",
                "shared-key".to_owned(),
                "fingerprint-a".to_owned(),
                first.clone(),
            )
            .await
            .expect("first principal records offer");

        assert!(matches!(
            service
                .replay_pairing_offer("principal-a", "shared-key", "fingerprint-a")
                .await,
            Ok(PairingOfferReplay::Original(result)) if result.id == first.id
        ));
        assert!(matches!(
            service
                .replay_pairing_offer("principal-a", "shared-key", "different-input")
                .await,
            Ok(PairingOfferReplay::Conflict)
        ));
        assert!(matches!(
            service
                .replay_pairing_offer("principal-b", "shared-key", "fingerprint-a")
                .await,
            Ok(PairingOfferReplay::Fresh)
        ));

        let second = PairingOfferResult {
            id: "offer-b".to_owned(),
            code: "code-b".to_owned(),
            reach: "another-device".to_owned(),
            endpoint: "http://192.168.1.21:3773".to_owned(),
            name: "Tablet B".to_owned(),
            expires_at: format_iso(now_ms() + PAIRING_TTL_MS),
        };
        insert_live_pairing(&service, &second.id).await;
        service
            .record_pairing_offer(
                "principal-b",
                "shared-key".to_owned(),
                "fingerprint-b".to_owned(),
                second.clone(),
            )
            .await
            .expect("second principal records its own offer");
        assert!(matches!(
            service
                .replay_pairing_offer("principal-b", "shared-key", "fingerprint-b")
                .await,
            Ok(PairingOfferReplay::Original(result)) if result.id == second.id
        ));
    }

    #[tokio::test]
    async fn completed_pairing_offer_replays_and_cancels_after_restart() {
        let database = crate::persistence::Database::open_in_memory()
            .await
            .expect("in-memory database opens");
        database
            .call(|connection| {
                crate::persistence::run_migrations(connection, None)?;
                Ok(())
            })
            .await
            .expect("all migrations apply");
        let repositories = Repositories::new(database);
        let secrets = tempfile::tempdir().expect("secret store directory");
        let config = ServerConfig::new(".").with_bind("127.0.0.1", 3773);
        let service = AuthService::new_with_persistence(
            &config,
            vec![7_u8; 32],
            SecretStore::new(secrets.path())
                .await
                .expect("secret store"),
            repositories.clone(),
        )
        .await
        .expect("initial service");
        let issued = service
            .issue_share_pairing_offer(
                owned_scopes(STANDARD_SCOPES),
                Some("Tablet".to_owned()),
                "another-device".to_owned(),
                true,
                PairingOfferReservation::new(
                    "principal".to_owned(),
                    "request-key".to_owned(),
                    "fingerprint".to_owned(),
                ),
            )
            .await
            .expect("durable offer reservation");
        let PairingOfferIssuance::Reserved(issued) = issued else {
            panic!("fresh offer must reserve its grant");
        };
        let result = PairingOfferResult {
            id: issued.id.clone(),
            code: "encoded-offer".to_owned(),
            reach: "another-device".to_owned(),
            endpoint: "http://192.168.1.20:3773".to_owned(),
            name: "Tablet".to_owned(),
            expires_at: issued.expires_at,
        };
        service
            .record_pairing_offer(
                "principal",
                "request-key".to_owned(),
                "fingerprint".to_owned(),
                result.clone(),
            )
            .await
            .expect("offer completion");
        drop(service);

        let restarted = AuthService::new_with_persistence(
            &config,
            vec![7_u8; 32],
            SecretStore::new(secrets.path())
                .await
                .expect("reopened secret store"),
            repositories.clone(),
        )
        .await
        .expect("restarted service hydrates offer ledger");
        assert!(matches!(
            restarted
                .replay_pairing_offer("principal", "request-key", "fingerprint")
                .await,
            Ok(PairingOfferReplay::Original(replayed)) if replayed.id == result.id
        ));
        assert_eq!(
            restarted.share_exposure_state().await.desired_exposure,
            "wide"
        );
        assert!(
            restarted
                .cancel_pairing_offer("principal", "request-key".to_owned())
                .await
                .expect("restart-safe cancellation")
        );
        assert_eq!(
            restarted.share_exposure_state().await.desired_exposure,
            "loopback"
        );
        drop(restarted);

        let after_cancel = AuthService::new_with_persistence(
            &config,
            vec![7_u8; 32],
            SecretStore::new(secrets.path())
                .await
                .expect("reopened secret store after cancellation"),
            repositories,
        )
        .await
        .expect("tombstone hydrates");
        assert!(matches!(
            after_cancel
                .replay_pairing_offer("principal", "request-key", "fingerprint")
                .await,
            Ok(PairingOfferReplay::Cancelled)
        ));
        assert_eq!(
            after_cancel.share_exposure_state().await.desired_exposure,
            "loopback"
        );
    }

    #[tokio::test]
    async fn live_service_does_not_recover_another_services_young_pending_offer() {
        let repositories = IndependentAuthRepositories::new().await;
        let secrets = tempfile::tempdir().expect("secret store directory");
        let config = ServerConfig::new(".").with_bind("127.0.0.1", 3773);
        let first = AuthService::new_with_persistence(
            &config,
            vec![7_u8; 32],
            SecretStore::new(secrets.path())
                .await
                .expect("first secret store"),
            repositories.first.clone(),
        )
        .await
        .expect("first live service");
        let second = AuthService::new_with_persistence(
            &config,
            vec![7_u8; 32],
            SecretStore::new(secrets.path())
                .await
                .expect("second secret store"),
            repositories.second.clone(),
        )
        .await
        .expect("second live service");

        let issued = first
            .issue_share_pairing_offer(
                owned_scopes(STANDARD_SCOPES),
                Some("Tablet".to_owned()),
                "another-device".to_owned(),
                true,
                PairingOfferReservation::new(
                    "principal".to_owned(),
                    "concurrent-key".to_owned(),
                    "fingerprint".to_owned(),
                ),
            )
            .await
            .expect("first service reserves the offer");
        let PairingOfferIssuance::Reserved(issued) = issued else {
            panic!("fresh offer must reserve its grant");
        };

        assert!(matches!(
            second
                .replay_pairing_offer("principal", "concurrent-key", "fingerprint")
                .await,
            Ok(PairingOfferReplay::Cancelled)
        ));

        let result = PairingOfferResult {
            id: issued.id,
            code: "encoded-offer".to_owned(),
            reach: "another-device".to_owned(),
            endpoint: "http://192.168.1.20:3773".to_owned(),
            name: "Tablet".to_owned(),
            expires_at: issued.expires_at,
        };
        first
            .record_pairing_offer(
                "principal",
                "concurrent-key".to_owned(),
                "fingerprint".to_owned(),
                result.clone(),
            )
            .await
            .expect("first service completes the offer");
        assert!(matches!(
            second
                .replay_pairing_offer("principal", "concurrent-key", "fingerprint")
                .await,
            Ok(PairingOfferReplay::Original(replayed)) if replayed.id == result.id
        ));

        drop((first, second));
        repositories.close().await;
    }

    #[tokio::test]
    async fn remote_offer_cancellation_converges_dormant_share_state_and_access_events() {
        let repositories = IndependentAuthRepositories::new().await;
        let secrets = tempfile::tempdir().expect("secret store directory");
        let config = ServerConfig::new(".").with_bind("127.0.0.1", 3773);
        let first = AuthService::new_with_persistence(
            &config,
            vec![7_u8; 32],
            SecretStore::new(secrets.path())
                .await
                .expect("first secret store"),
            repositories.first.clone(),
        )
        .await
        .expect("first live service");
        let second = AuthService::new_with_persistence(
            &config,
            vec![7_u8; 32],
            SecretStore::new(secrets.path())
                .await
                .expect("second secret store"),
            repositories.second.clone(),
        )
        .await
        .expect("second live service");

        let issued = first
            .issue_share_pairing_offer(
                owned_scopes(STANDARD_SCOPES),
                Some("Tablet".to_owned()),
                "another-device".to_owned(),
                true,
                PairingOfferReservation::new(
                    "principal".to_owned(),
                    "dormant-key".to_owned(),
                    "fingerprint".to_owned(),
                ),
            )
            .await
            .expect("off-host reservation");
        let PairingOfferIssuance::Reserved(issued) = issued else {
            panic!("fresh offer must reserve its grant");
        };
        first
            .record_pairing_offer(
                "principal",
                "dormant-key".to_owned(),
                "fingerprint".to_owned(),
                PairingOfferResult {
                    id: issued.id.clone(),
                    code: "encoded-offer".to_owned(),
                    reach: "another-device".to_owned(),
                    endpoint: "http://192.168.1.20:3773".to_owned(),
                    name: "Tablet".to_owned(),
                    expires_at: issued.expires_at,
                },
            )
            .await
            .expect("offer completion");
        assert_eq!(first.state.lock().await.live_connections.len(), 0);
        assert_eq!(first.share_exposure_state().await.desired_exposure, "wide");
        let mut access_events = first.subscribe_access();

        assert!(
            second
                .cancel_pairing_offer("principal", "dormant-key".to_owned())
                .await
                .expect("remote cancellation")
        );
        let event = tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                let event = access_events
                    .recv()
                    .await
                    .expect("access channel remains open");
                if matches!(
                    &event.change,
                    AuthAccessChange::PairingLinkRemoved { id } if id == &issued.id
                ) {
                    break event;
                }
            }
        })
        .await
        .expect("dormant grant removal must converge");
        assert!(event.revision > 1);
        assert_eq!(first.state.lock().await.live_connections.len(), 0);
        assert_eq!(
            first.share_exposure_state().await.desired_exposure,
            "loopback"
        );
        drop((first, second));
        repositories.close().await;
    }

    #[tokio::test]
    async fn access_subscriber_keeps_one_service_watcher_without_cached_authority() {
        let repositories = IndependentAuthRepositories::new().await;
        let secrets = tempfile::tempdir().expect("secret store directory");
        let config = ServerConfig::new(".").with_bind("127.0.0.1", 3773);
        let first = AuthService::new_with_persistence(
            &config,
            vec![7_u8; 32],
            SecretStore::new(secrets.path())
                .await
                .expect("first secret store"),
            repositories.first.clone(),
        )
        .await
        .expect("first live service");
        let second = AuthService::new_with_persistence(
            &config,
            vec![7_u8; 32],
            SecretStore::new(secrets.path())
                .await
                .expect("second secret store"),
            repositories.second.clone(),
        )
        .await
        .expect("second live service");
        assert!(first.state.lock().await.pairings.is_empty());
        assert!(first.state.lock().await.sessions.is_empty());
        let mut access_events = first.subscribe_access();
        tokio::time::sleep(AUTHORITY_CONVERGENCE_INTERVAL * 2).await;

        let issued = second
            .issue_pairing(owned_scopes(STANDARD_SCOPES), Some("Tablet".to_owned()))
            .await
            .expect("remote pairing");
        let event = tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                let event = access_events
                    .recv()
                    .await
                    .expect("access channel remains open");
                if matches!(
                    &event.change,
                    AuthAccessChange::PairingLinkUpserted(pairing) if pairing.id == issued.id
                ) {
                    break event;
                }
            }
        })
        .await
        .expect("subscriber-only authority watcher must converge");
        assert!(event.revision > 1);
        drop((access_events, first, second));
        repositories.close().await;
    }

    #[tokio::test]
    async fn cached_grant_keeps_one_service_watcher_without_socket_or_subscriber() {
        let repositories = IndependentAuthRepositories::new().await;
        let secrets = tempfile::tempdir().expect("secret store directory");
        let config = ServerConfig::new(".").with_bind("127.0.0.1", 3773);
        let first = AuthService::new_with_persistence(
            &config,
            vec![7_u8; 32],
            SecretStore::new(secrets.path())
                .await
                .expect("first secret store"),
            repositories.first.clone(),
        )
        .await
        .expect("first live service");
        let second = AuthService::new_with_persistence(
            &config,
            vec![7_u8; 32],
            SecretStore::new(secrets.path())
                .await
                .expect("second secret store"),
            repositories.second.clone(),
        )
        .await
        .expect("second live service");
        let issued = first
            .issue_share_pairing_offer(
                owned_scopes(STANDARD_SCOPES),
                Some("Tablet".to_owned()),
                "another-device".to_owned(),
                true,
                PairingOfferReservation::new(
                    "principal".to_owned(),
                    "grant-only-key".to_owned(),
                    "fingerprint".to_owned(),
                ),
            )
            .await
            .expect("off-host reservation");
        assert!(matches!(issued, PairingOfferIssuance::Reserved(_)));
        assert_eq!(first.access_events.receiver_count(), 0);
        assert!(first.state.lock().await.live_connections.is_empty());
        tokio::time::sleep(AUTHORITY_CONVERGENCE_INTERVAL * 2).await;

        assert!(
            second
                .cancel_pairing_offer("principal", "grant-only-key".to_owned())
                .await
                .expect("remote cancellation")
        );
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                if first.share_exposure_state().await.desired_exposure == "loopback" {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("cached grant watcher must converge without a socket or subscriber");
        drop((first, second));
        repositories.close().await;
    }

    #[tokio::test]
    async fn cached_session_keeps_one_service_watcher_without_live_connection() {
        let repositories = IndependentAuthRepositories::new().await;
        let secrets = tempfile::tempdir().expect("secret store directory");
        let config = ServerConfig::new(".").with_bind("127.0.0.1", 3773);
        let first = AuthService::new_with_persistence(
            &config,
            vec![7_u8; 32],
            SecretStore::new(secrets.path())
                .await
                .expect("first secret store"),
            repositories.first.clone(),
        )
        .await
        .expect("first live service");
        let second = AuthService::new_with_persistence(
            &config,
            vec![7_u8; 32],
            SecretStore::new(secrets.path())
                .await
                .expect("second secret store"),
            repositories.second.clone(),
        )
        .await
        .expect("second live service");
        let pairing = first
            .issue_pairing(owned_scopes(STANDARD_SCOPES), Some("Tablet".to_owned()))
            .await
            .expect("pairing grant");
        let issued = first
            .exchange_bootstrap(
                &pairing.credential,
                None,
                ClientMetadata::default(),
                None,
                SessionTransport::Plain,
            )
            .await
            .expect("cached session");
        assert!(first.state.lock().await.pairings.is_empty());
        assert!(first.state.lock().await.live_connections.is_empty());
        tokio::time::sleep(AUTHORITY_CONVERGENCE_INTERVAL * 2).await;

        assert!(
            second
                .revoke_client("other-session", &issued.principal.session_id)
                .await
                .expect("remote session revocation")
        );
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                if first.list_clients("other-session").await.is_empty() {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("cached session watcher must converge without a live connection");
        drop((first, second));
        repositories.close().await;
    }

    #[tokio::test]
    async fn cross_service_authentication_starts_watcher_for_the_cached_session() {
        let repositories = IndependentAuthRepositories::new().await;
        let secrets = tempfile::tempdir().expect("secret store directory");
        let config = ServerConfig::new(".").with_bind("127.0.0.1", 3773);
        let first = AuthService::new_with_persistence(
            &config,
            vec![7_u8; 32],
            SecretStore::new(secrets.path())
                .await
                .expect("first secret store"),
            repositories.first.clone(),
        )
        .await
        .expect("first live service");
        let second = AuthService::new_with_persistence(
            &config,
            vec![7_u8; 32],
            SecretStore::new(secrets.path())
                .await
                .expect("second secret store"),
            repositories.second.clone(),
        )
        .await
        .expect("second live service");
        tokio::time::sleep(AUTHORITY_CONVERGENCE_INTERVAL * 2).await;
        let pairing = first
            .issue_pairing(owned_scopes(STANDARD_SCOPES), Some("Tablet".to_owned()))
            .await
            .expect("pairing grant");
        let issued = first
            .exchange_bootstrap(
                &pairing.credential,
                None,
                ClientMetadata::default(),
                None,
                SessionTransport::Plain,
            )
            .await
            .expect("session minted on first service");
        second
            .authenticate_token(&issued.token, SessionTransport::Plain)
            .await
            .expect("second service authenticates durable session");
        let connection_shutdown = CancellationToken::new();
        second
            .mark_connected(&issued.principal.session_id, connection_shutdown.clone())
            .await
            .expect("connection registers");
        tokio::time::sleep(AUTHORITY_CONVERGENCE_INTERVAL * 2).await;

        assert!(
            first
                .revoke_client("other-session", &issued.principal.session_id)
                .await
                .expect("remote session revocation")
        );
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            connection_shutdown.cancelled().await;
        })
        .await
        .expect("authenticated peer session must retain revocation convergence");
        drop((first, second));
        repositories.close().await;
    }

    #[tokio::test]
    async fn unchanged_revision_reconciles_at_the_nearest_authority_expiry() {
        let database = crate::persistence::Database::open_in_memory()
            .await
            .expect("in-memory database opens");
        database
            .call(|connection| {
                crate::persistence::run_migrations(connection, None)?;
                Ok(())
            })
            .await
            .expect("all migrations apply");
        let repositories = Repositories::new(database);
        let secrets = tempfile::tempdir().expect("secret store directory");
        let secret_store = SecretStore::new(secrets.path())
            .await
            .expect("secret store");
        let config = ServerConfig::new(".").with_bind("127.0.0.1", 3773);
        let expiry_lead_ms = i64::try_from((AUTHORITY_CONVERGENCE_INTERVAL * 8).as_millis())
            .expect("authority expiry lead fits i64");
        let expires_at = now_ms().saturating_add(expiry_lead_ms);
        repositories
            .create_auth_pairing_link(PersistedPairingLink {
                id: "expiring-grant".to_owned(),
                credential: "expiring-credential".to_owned(),
                method: "one-time-token".to_owned(),
                scopes: serde_json::json!(owned_scopes(STANDARD_SCOPES)),
                subject: "one-time-token".to_owned(),
                label: Some("Expiring".to_owned()),
                proof_key_thumbprint: None,
                created_at: format_iso(now_ms()),
                expires_at: format_iso(expires_at),
                consumed_at: None,
                revoked_at: None,
                reach: Some("another-device".to_owned()),
                off_host: Some(true),
                mcp_access: None,
                mcp_named_client: None,
            })
            .await
            .expect("expiring authority row");
        let service = AuthService::new_with_persistence(
            &config,
            vec![7_u8; 32],
            secret_store,
            repositories.clone(),
        )
        .await
        .expect("service hydrates expiring authority");
        assert_eq!(service.list_pairings().await.len(), 1);
        let mut access_events = service.subscribe_access();
        let revision = repositories
            .auth_authority_revision()
            .await
            .expect("authority revision");

        let event = tokio::time::timeout(AUTHORITY_CONVERGENCE_INTERVAL * 16, async {
            loop {
                let event = access_events
                    .recv()
                    .await
                    .expect("access channel remains open");
                if matches!(
                    &event.change,
                    AuthAccessChange::PairingLinkRemoved { id } if id == "expiring-grant"
                ) {
                    break event;
                }
            }
        })
        .await
        .expect("nearest expiry must reconcile without another mutation");
        assert!(event.revision > 1);
        assert_eq!(
            repositories
                .auth_authority_revision()
                .await
                .expect("unchanged authority revision"),
            revision
        );
    }

    #[tokio::test]
    async fn pending_pairing_offer_recovers_for_retry_after_restart() {
        let database = crate::persistence::Database::open_in_memory()
            .await
            .expect("in-memory database opens");
        database
            .call(|connection| {
                crate::persistence::run_migrations(connection, None)?;
                Ok(())
            })
            .await
            .expect("all migrations apply");
        let repositories = Repositories::new(database);
        let secrets = tempfile::tempdir().expect("secret store directory");
        let config = ServerConfig::new(".").with_bind("127.0.0.1", 3773);
        let service = AuthService::new_with_persistence(
            &config,
            vec![7_u8; 32],
            SecretStore::new(secrets.path())
                .await
                .expect("secret store"),
            repositories.clone(),
        )
        .await
        .expect("initial service");
        let issued = service
            .issue_share_pairing_offer(
                owned_scopes(STANDARD_SCOPES),
                Some("Tablet".to_owned()),
                "another-device".to_owned(),
                true,
                PairingOfferReservation::new(
                    "principal".to_owned(),
                    "pending-key".to_owned(),
                    "fingerprint".to_owned(),
                ),
            )
            .await
            .expect("pairing and reservation commit");
        let PairingOfferIssuance::Reserved(issued) = issued else {
            panic!("fresh offer must reserve its grant");
        };
        let stale_created_at = "1970-01-01T00:00:00Z".to_owned();
        let pairing_id = issued.id;
        repositories
            .database()
            .call(move |connection| {
                let updated = connection.execute(
                    "UPDATE auth_pairing_links SET created_at = ? WHERE id = ?",
                    [stale_created_at, pairing_id],
                )?;
                assert_eq!(updated, 1);
                Ok(())
            })
            .await
            .expect("pending reservation is aged past the recovery grace");
        drop(service);

        let restarted = AuthService::new_with_persistence(
            &config,
            vec![7_u8; 32],
            SecretStore::new(secrets.path())
                .await
                .expect("reopened secret store"),
            repositories,
        )
        .await
        .expect("pending reservation hydrates");
        assert!(matches!(
            restarted
                .replay_pairing_offer("principal", "pending-key", "fingerprint")
                .await,
            Ok(PairingOfferReplay::Fresh)
        ));
        assert_eq!(
            restarted.share_exposure_state().await.desired_exposure,
            "loopback"
        );
        assert!(matches!(
            restarted
                .issue_share_pairing_offer(
                    owned_scopes(STANDARD_SCOPES),
                    Some("Tablet".to_owned()),
                    "another-device".to_owned(),
                    true,
                    PairingOfferReservation::new(
                        "principal".to_owned(),
                        "pending-key".to_owned(),
                        "fingerprint".to_owned(),
                    ),
                )
                .await,
            Ok(PairingOfferIssuance::Reserved(_))
        ));
    }

    #[tokio::test]
    async fn pairing_offer_idempotency_prunes_expired_entries_and_caps_memory() {
        let service = service();
        let now = now_ms();
        {
            let mut state = service.state.lock().await;
            for index in 0..MAX_ACTIVE_PAIRINGS {
                let id = format!("offer-{index}");
                state.pairing_offer_idempotency.insert(
                    (format!("principal-{index}"), format!("key-{index}")),
                    StoredPairingOffer {
                        input_fingerprint: format!("fingerprint-{index}"),
                        pairing_id: Some(id.clone()),
                        result: Some(PairingOfferResult {
                            id,
                            code: format!("code-{index}"),
                            reach: "another-device".to_owned(),
                            endpoint: "http://192.168.1.20:3773".to_owned(),
                            name: format!("Client {index}"),
                            expires_at: format_iso(now + PAIRING_TTL_MS),
                        }),
                        expires_at_ms: now + PAIRING_TTL_MS,
                    },
                );
            }
        }

        let overflow = PairingOfferResult {
            id: "overflow".to_owned(),
            code: "overflow-code".to_owned(),
            reach: "another-device".to_owned(),
            endpoint: "http://192.168.1.21:3773".to_owned(),
            name: "Overflow client".to_owned(),
            expires_at: format_iso(now + PAIRING_TTL_MS),
        };
        assert!(matches!(
            service
                .record_pairing_offer(
                    "overflow-principal",
                    "overflow-key".to_owned(),
                    "overflow-fingerprint".to_owned(),
                    overflow.clone(),
                )
                .await,
            Err(AuthError::Internal(message))
                if message == "pairing offer idempotency capacity exceeded"
        ));

        service
            .state
            .lock()
            .await
            .pairing_offer_idempotency
            .get_mut(&("principal-0".to_owned(), "key-0".to_owned()))
            .expect("idempotency fixture")
            .expires_at_ms = now - 1;
        service
            .record_pairing_offer(
                "overflow-principal",
                "overflow-key".to_owned(),
                "overflow-fingerprint".to_owned(),
                overflow,
            )
            .await
            .expect("expired idempotency entry frees capacity");
        assert_eq!(
            service.state.lock().await.pairing_offer_idempotency.len(),
            MAX_ACTIVE_PAIRINGS
        );
    }

    #[tokio::test]
    async fn pairing_offer_tombstones_are_bounded_per_principal() {
        let service = service();
        for index in 0..MAX_ACTIVE_PAIRING_OFFERS_PER_PRINCIPAL {
            service
                .cancel_pairing_offer("principal-a", format!("cancelled-{index}"))
                .await
                .expect("principal tombstone within quota");
        }

        assert!(matches!(
            service
                .cancel_pairing_offer("principal-a", "cancelled-overflow".to_owned())
                .await,
            Err(AuthError::Internal(message))
                if message == "pairing offer principal capacity exceeded"
        ));
        service
            .cancel_pairing_offer("principal-b", "cancelled-elsewhere".to_owned())
            .await
            .expect("one principal cannot consume another principal's quota");
    }

    async fn exchange_in_background(
        service: &AuthService,
        credential: &str,
    ) -> tokio::task::JoinHandle<Result<IssuedSession, AuthError>> {
        let service = service.clone();
        let credential = credential.to_owned();
        tokio::spawn(async move {
            service
                .exchange_bootstrap(
                    &credential,
                    None,
                    ClientMetadata::default(),
                    None,
                    SessionTransport::Plain,
                )
                .await
        })
    }

    fn test_hold() -> (
        TestHold,
        tokio::sync::oneshot::Receiver<()>,
        tokio::sync::oneshot::Sender<()>,
    ) {
        let (reached_tx, reached) = tokio::sync::oneshot::channel();
        let (resume, resume_rx) = tokio::sync::oneshot::channel();
        ((reached_tx, resume_rx), reached, resume)
    }

    /// The relay knows its link's id before the exchange, so a lost answer is still revocable
    /// (#281).
    #[tokio::test]
    async fn an_mcp_session_takes_the_id_of_its_pairing_link() {
        let (service, repositories, _secrets) = mcp_test_service().await;
        let link = issue_mcp_pairing_link(&repositories, "MCP · id".into(), "read-only", &[])
            .await
            .expect("link issues");
        let session = exchange_in_background(&service, &link.credential)
            .await
            .await
            .unwrap()
            .expect("exchange");
        assert_eq!(session.principal.session_id, link.id);
        assert!(
            repositories
                .get_auth_session(link.id.clone())
                .await
                .unwrap()
                .is_some()
        );
    }

    #[tokio::test]
    async fn a_non_mcp_pairing_exchange_still_gets_a_random_session_id() {
        let (service, repositories, _secrets) = mcp_test_service().await;
        let link = issue_administrative_pairing_link(&repositories, None)
            .await
            .expect("link issues");
        let session = exchange_in_background(&service, &link.credential)
            .await
            .await
            .unwrap()
            .expect("exchange");
        assert_ne!(session.principal.session_id, link.id);
    }

    #[tokio::test]
    async fn a_fenced_link_cannot_be_exchanged() {
        let (service, repositories, _secrets) = mcp_test_service().await;
        let link = issue_mcp_pairing_link(&repositories, "MCP · fenced".into(), "read-only", &[])
            .await
            .expect("link issues");
        assert!(
            repositories
                .revoke_mcp_credential(link.id.clone(), format_iso(now_ms()))
                .await
                .unwrap()
        );
        let exchanged = exchange_in_background(&service, &link.credential)
            .await
            .await
            .unwrap();
        assert!(matches!(exchanged, Err(AuthError::InvalidCredential)));
    }

    /// A sweep fences the link after the exchange consumed it but before the session row
    /// exists: the fenced insert writes nothing and the exchange fails.
    #[tokio::test]
    async fn a_revoke_between_consume_and_insert_leaves_no_session() {
        let (service, repositories, _secrets) = mcp_test_service().await;
        let link = issue_mcp_pairing_link(&repositories, "MCP · raced".into(), "read-only", &[])
            .await
            .expect("link issues");
        let (held, reached, resume) = test_hold();
        *service.test_hooks().after_consume.lock().unwrap() = Some(held);
        let exchange = exchange_in_background(&service, &link.credential).await;
        reached.await.expect("consumed");
        assert!(
            repositories
                .revoke_mcp_credential(link.id.clone(), format_iso(now_ms()))
                .await
                .unwrap(),
            "the consumed link is fenced"
        );
        resume.send(()).unwrap();
        let exchanged = exchange.await.unwrap();
        assert!(matches!(exchanged, Err(AuthError::InvalidCredential)));
        assert!(
            repositories
                .get_auth_session(link.id.clone())
                .await
                .unwrap()
                .is_none()
        );
        assert!(service.list_clients("").await.is_empty());
    }

    /// A revoke the watcher reconciles while issuance has committed the row but not yet
    /// published it to the cache still reaches Settings, one tick after the publication (R1.4).
    #[tokio::test]
    async fn a_revoke_reconciled_before_issuance_publishes_is_removed_from_settings() {
        let (service, repositories, _secrets) = mcp_test_service().await;
        let mut events = service.subscribe_access();
        let link = issue_mcp_pairing_link(&repositories, "MCP · late".into(), "read-only", &[])
            .await
            .expect("link issues");
        let (held, reached, resume) = test_hold();
        *service.test_hooks().after_session_insert.lock().unwrap() = Some(held);
        let exchange = exchange_in_background(&service, &link.credential).await;
        reached.await.expect("the row committed");
        repositories
            .revoke_mcp_credential(link.id.clone(), format_iso(now_ms()))
            .await
            .unwrap();
        // A later link the watcher must list proves it reconciled past the revoke.
        let marker = issue_mcp_pairing_link(&repositories, "MCP · marker".into(), "read-only", &[])
            .await
            .expect("link issues");
        let mut wait_for = async |wanted: &dyn Fn(&AuthAccessChange) -> bool| {
            tokio::time::timeout(AUTHORITY_CONVERGENCE_INTERVAL * 16, async {
                while !wanted(&events.recv().await.expect("access events").change) {}
            })
            .await
        };
        wait_for(&|change| {
            matches!(change, AuthAccessChange::PairingLinkUpserted(view) if view.id == marker.id)
        })
        .await
        .expect("the watcher reconciled the revoke");
        resume.send(()).unwrap();
        exchange.await.unwrap().expect("issued");
        // A tick that cached the row before the revoke queued a ClientRemoved the publication
        // then undid; only one after the publication's ClientUpserted proves the removal.
        wait_for(&|change| {
            matches!(change, AuthAccessChange::ClientUpserted(view) if view.session_id == link.id)
        })
        .await
        .expect("the publication upserts the client");
        wait_for(&|change| {
            matches!(change, AuthAccessChange::ClientRemoved { session_id } if *session_id == link.id)
        })
        .await
        .expect("a ClientRemoved follows the publication");
        assert!(
            service
                .list_clients("")
                .await
                .iter()
                .all(|client| client.session_id != link.id)
        );
    }

    /// The same revoke when a watcher tick cached the committed row before it: that tick's
    /// ClientRemoved comes before the publication, which must still be removed after (R1.4).
    #[tokio::test]
    async fn a_revoke_after_a_tick_cached_the_committed_row_is_removed_from_settings() {
        let (service, repositories, _secrets) = mcp_test_service().await;
        let mut events = service.subscribe_access();
        let link = issue_mcp_pairing_link(&repositories, "MCP · late".into(), "read-only", &[])
            .await
            .expect("link issues");
        let (held, reached, resume) = test_hold();
        *service.test_hooks().after_session_insert.lock().unwrap() = Some(held);
        let exchange = exchange_in_background(&service, &link.credential).await;
        reached.await.expect("the row committed");
        tokio::time::timeout(AUTHORITY_CONVERGENCE_INTERVAL * 16, async {
            while !matches!(&events.recv().await.expect("events").change, AuthAccessChange::ClientUpserted(view) if view.session_id == link.id) {}
        }).await.expect("a tick cached the committed row");
        repositories
            .revoke_mcp_credential(link.id.clone(), format_iso(now_ms()))
            .await
            .unwrap();
        // A later link the watcher must list proves it reconciled past the revoke.
        let marker = issue_mcp_pairing_link(&repositories, "MCP · marker".into(), "read-only", &[])
            .await
            .expect("link issues");
        let mut wait_for = async |wanted: &dyn Fn(&AuthAccessChange) -> bool| {
            tokio::time::timeout(AUTHORITY_CONVERGENCE_INTERVAL * 16, async {
                while !wanted(&events.recv().await.expect("access events").change) {}
            })
            .await
        };
        wait_for(&|change| {
            matches!(change, AuthAccessChange::PairingLinkUpserted(view) if view.id == marker.id)
        })
        .await
        .expect("the watcher reconciled the revoke");
        resume.send(()).unwrap();
        exchange.await.unwrap().expect("issued");
        // A tick that cached the row before the revoke queued a ClientRemoved the publication
        // then undid; only one after the publication's ClientUpserted proves the removal.
        wait_for(&|change| {
            matches!(change, AuthAccessChange::ClientUpserted(view) if view.session_id == link.id)
        })
        .await
        .expect("the publication upserts the client");
        wait_for(&|change| {
            matches!(change, AuthAccessChange::ClientRemoved { session_id } if *session_id == link.id)
        })
        .await
        .expect("a ClientRemoved follows the publication");
        assert!(
            service
                .list_clients("")
                .await
                .iter()
                .all(|client| client.session_id != link.id)
        );
    }

    /// A revoke that lands while issuance is about to send its ClientUpserted must not leave
    /// the client in Settings: events go out in state order (#294). The hold sits right before
    /// that send, so if the send ever moves after the unlock, the watcher reconciles inside
    /// the hold and the late upsert resurrects the client.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_revoke_reconciled_between_publication_and_its_event_is_removed_from_settings() {
        let (service, repositories, _secrets) = mcp_test_service().await;
        let mut events = service.subscribe_access();
        let link = issue_mcp_pairing_link(&repositories, "MCP · gap".into(), "read-only", &[])
            .await
            .expect("link issues");
        let (held, reached, resume) = test_hold();
        *service
            .test_hooks()
            .before_session_upsert_event
            .lock()
            .unwrap() = Some(held);
        let exchange = exchange_in_background(&service, &link.credential).await;
        reached
            .await
            .expect("the session is published to the cache");
        repositories
            .revoke_mcp_credential(link.id.clone(), format_iso(now_ms()))
            .await
            .unwrap();
        let mut settings = std::collections::HashSet::new();
        let mut fold = |change: &AuthAccessChange| match change {
            AuthAccessChange::ClientUpserted(view) => {
                settings.insert(view.session_id.clone());
            }
            AuthAccessChange::ClientRemoved { session_id } => {
                settings.remove(session_id);
            }
            _ => {}
        };
        // Sending under the lock keeps the watcher out until the hold ends; a send after the
        // unlock lets it reconcile the revoke here. Either way, give it several ticks.
        let _ = tokio::time::timeout(AUTHORITY_CONVERGENCE_INTERVAL * 8, async {
            loop {
                let change = events.recv().await.expect("access events").change;
                fold(&change);
                if matches!(&change, AuthAccessChange::ClientRemoved { session_id } if *session_id == link.id)
                {
                    break;
                }
            }
        })
        .await;
        resume.send(()).unwrap();
        exchange.await.unwrap().expect("issued");
        // Issuance sends before it returns, so everything it sent precedes this marker.
        let marker = issue_mcp_pairing_link(&repositories, "MCP · marker".into(), "read-only", &[])
            .await
            .expect("link issues");
        tokio::time::timeout(AUTHORITY_CONVERGENCE_INTERVAL * 16, async {
            loop {
                let change = events.recv().await.expect("access events").change;
                fold(&change);
                if matches!(&change, AuthAccessChange::PairingLinkUpserted(view) if view.id == marker.id)
                {
                    break;
                }
            }
        })
        .await
        .expect("the watcher reconciled the marker");
        // One reconcile sends its pairing changes before its session changes, all under one
        // lock, so the rest of the marker's batch is already queued.
        while let Ok(event) = events.try_recv() {
            fold(&event.change);
        }
        assert!(
            !settings.contains(&link.id),
            "the access stream resurrected the revoked client"
        );
        assert!(
            service
                .list_clients("")
                .await
                .iter()
                .all(|client| client.session_id != link.id)
        );
    }

    /// Named MCP clients (#280): one identity across runs, ended only by a person.
    mod named_clients {
        use super::*;

        async fn named_link(repositories: &Repositories, name: &str) -> PairingCredentialResult {
            issue_named_mcp_pairing_link(repositories, name, "read-only", &[])
                .await
                .expect("named link issues")
        }

        async fn run(service: &AuthService, repositories: &Repositories, name: &str) -> String {
            let link = named_link(repositories, name).await;
            exchange_in_background(service, &link.credential)
                .await
                .await
                .unwrap()
                .expect("exchange")
                .principal
                .session_id
        }

        async fn named_id(repositories: &Repositories, session_id: &str) -> Option<String> {
            repositories
                .get_auth_session(session_id.to_owned())
                .await
                .unwrap()
                .expect("session row")
                .mcp_named_client
                .map(|named| named.id)
        }

        async fn revoked(repositories: &Repositories, session_id: &str) -> bool {
            repositories
                .get_auth_session(session_id.to_owned())
                .await
                .unwrap()
                .is_some_and(|session| session.revoked_at.is_some())
        }

        #[tokio::test]
        async fn a_named_client_revoked_before_its_link_is_consumed_gets_no_session() {
            let (service, repositories, _secrets) = mcp_test_service().await;
            let first = run(&service, &repositories, "builder").await;
            let identity = named_id(&repositories, &first).await.expect("a named run");
            assert!(identity.starts_with("nc_"));
            let next = named_link(&repositories, "builder").await;
            assert!(service.revoke_client("person", &first).await.unwrap());
            let exchanged = exchange_in_background(&service, &next.credential)
                .await
                .await
                .unwrap();
            assert!(matches!(exchanged, Err(AuthError::InvalidCredential)));
            let fresh = run(&service, &repositories, "builder").await;
            assert_ne!(
                named_id(&repositories, &fresh).await.as_deref(),
                Some(identity.as_str()),
                "the next run starts a new identity"
            );
        }

        #[tokio::test]
        async fn a_named_client_revoked_after_consumption_but_before_the_session_insert_gets_no_session()
         {
            let (service, repositories, _secrets) = mcp_test_service().await;
            let first = run(&service, &repositories, "builder").await;
            let next = named_link(&repositories, "builder").await;
            let (held, reached, resume) = test_hold();
            *service.test_hooks().after_consume.lock().unwrap() = Some(held);
            let exchange = exchange_in_background(&service, &next.credential).await;
            reached.await.expect("consumed");
            assert!(service.revoke_client("person", &first).await.unwrap());
            resume.send(()).unwrap();
            assert!(matches!(
                exchange.await.unwrap(),
                Err(AuthError::InvalidCredential)
            ));
            assert!(
                repositories
                    .get_auth_session(next.id.clone())
                    .await
                    .unwrap()
                    .is_none()
            );
            assert!(service.list_clients("").await.is_empty());
        }

        #[tokio::test]
        async fn revoking_a_named_client_revokes_its_live_sessions_and_unconsumed_links() {
            let (service, repositories, _secrets) = mcp_test_service().await;
            let mut events = service.subscribe_access();
            let first = run(&service, &repositories, "builder").await;
            let second = run(&service, &repositories, "builder").await;
            assert_eq!(
                named_id(&repositories, &first).await,
                named_id(&repositories, &second).await,
                "two live runs of one name share the identity"
            );
            let other = run(&service, &repositories, "reviewer").await;
            let pending = named_link(&repositories, "builder").await;
            while events.try_recv().is_ok() {}

            assert!(service.revoke_client("person", &second).await.unwrap());

            assert!(revoked(&repositories, &first).await);
            assert!(revoked(&repositories, &second).await);
            assert!(
                !revoked(&repositories, &other).await,
                "another name is untouched"
            );
            assert!(
                repositories
                    .list_active_auth_pairing_links(format_iso(now_ms()))
                    .await
                    .unwrap()
                    .iter()
                    .all(|link| link.id != pending.id),
                "the unconsumed link is revoked"
            );
            let clients = service.list_clients("").await;
            assert_eq!(
                clients
                    .iter()
                    .map(|client| client.session_id.as_str())
                    .collect::<Vec<_>>(),
                [other.as_str()]
            );
            let mut removed = Vec::new();
            while let Ok(event) = events.try_recv() {
                if let AuthAccessChange::ClientRemoved { session_id } = event.change {
                    removed.push(session_id);
                }
            }
            removed.sort();
            let mut expected = vec![first, second];
            expected.sort();
            assert_eq!(
                removed, expected,
                "one removal per run, sent with the revoke"
            );
        }

        #[tokio::test]
        async fn a_relay_revoke_never_ends_its_named_client() {
            let (service, repositories, _secrets) = mcp_test_service().await;
            let first = run(&service, &repositories, "builder").await;
            let identity = named_id(&repositories, &first).await;
            assert!(
                repositories
                    .revoke_mcp_credential(first.clone(), format_iso(now_ms()))
                    .await
                    .unwrap()
            );
            let second = run(&service, &repositories, "builder").await;
            assert_eq!(named_id(&repositories, &second).await, identity);
            let view = service
                .list_clients("")
                .await
                .into_iter()
                .find(|client| client.session_id == second)
                .expect("the new run is listed");
            assert_eq!(view.client.label.as_deref(), Some("MCP · builder"));
            assert_eq!(
                view.mcp_named_client.map(|named| named.name).as_deref(),
                Some("builder")
            );
        }

        /// Stop on the row of a run that already exited ends the identity, live runs included.
        #[tokio::test]
        async fn stopping_an_earlier_runs_row_ends_its_identity() {
            let (service, repositories, _secrets) = mcp_test_service().await;
            let first = run(&service, &repositories, "builder").await;
            repositories
                .revoke_mcp_credential(first.clone(), format_iso(now_ms()))
                .await
                .unwrap();
            let second = run(&service, &repositories, "builder").await;
            let stopped = service.stop_client("person", &first).await.unwrap();
            assert!(stopped.revoked);
            assert!(
                revoked(&repositories, &second).await,
                "the live run ends too"
            );
        }

        async fn run_at(
            service: &AuthService,
            repositories: &Repositories,
            name: &str,
            access: &str,
        ) -> String {
            let link = issue_named_mcp_pairing_link(repositories, name, access, &[])
                .await
                .expect("named link issues");
            exchange_in_background(service, &link.credential)
                .await
                .await
                .unwrap()
                .expect("exchange")
                .principal
                .session_id
        }

        /// The cached access and hand-back of `session_id`, as Settings shows them.
        async fn cached_access(
            service: &AuthService,
            session_id: &str,
        ) -> (Option<String>, Option<String>) {
            let view = service
                .list_clients("")
                .await
                .into_iter()
                .find(|client| client.session_id == session_id)
                .expect("the session is listed");
            (view.mcp_access, view.mcp_access_hand_back)
        }

        fn levels(access: &str, hand_back: Option<&str>) -> (Option<String>, Option<String>) {
            (Some(access.to_owned()), hand_back.map(str::to_owned))
        }

        async fn wait_for_named_clients(
            events: &mut broadcast::Receiver<AuthAccessEvent>,
        ) -> Result<(), tokio::time::error::Elapsed> {
            tokio::time::timeout(AUTHORITY_CONVERGENCE_INTERVAL * 16, async {
                while !matches!(
                    events.recv().await.expect("access events").change,
                    AuthAccessChange::McpNamedClients
                ) {}
            })
            .await
        }

        fn view_ids(views: &[McpNamedClientView]) -> Vec<&str> {
            views.iter().map(|view| view.id.as_str()).collect()
        }

        /// A run exiting leaves its identity listed, so Settings can show an idle row (#324).
        #[tokio::test]
        async fn a_named_client_whose_run_exited_stays_in_the_access_snapshot() {
            let (service, repositories, _secrets) = mcp_test_service().await;
            let mut events = service.subscribe_access();
            // The relay mints the identity in the store; the watcher brings it to the cache.
            let link = named_link(&repositories, "builder").await;
            wait_for_named_clients(&mut events)
                .await
                .expect("the watcher lists the new identity");
            let views = service.named_client_views().await;
            assert_eq!(views.len(), 1);
            assert_eq!(views[0].name, "builder");
            let first = exchange_in_background(&service, &link.credential)
                .await
                .await
                .unwrap()
                .expect("exchange")
                .principal
                .session_id;
            repositories
                .revoke_mcp_credential(first.clone(), format_iso(now_ms()))
                .await
                .unwrap();
            assert!(service.authorize_session(&first, "").await.is_err());
            assert!(service.list_clients("").await.is_empty());
            assert_eq!(
                view_ids(&service.named_client_views().await),
                view_ids(&views),
                "the identity outlives its run"
            );
        }

        /// Revoke on an idle row passes the named client's id and ends the identity (#324).
        #[tokio::test]
        async fn revoking_an_idle_named_client_by_its_id_ends_the_identity_and_sends_a_snapshot() {
            let (service, repositories, _secrets) = mcp_test_service().await;
            let first = run(&service, &repositories, "builder").await;
            let identity = named_id(&repositories, &first).await.expect("a named run");
            repositories
                .revoke_mcp_credential(first.clone(), format_iso(now_ms()))
                .await
                .unwrap();
            let mut events = service.subscribe_access();
            while events.try_recv().is_ok() {}

            assert!(service.revoke_client("person", &identity).await.unwrap());

            assert!(service.named_client_views().await.is_empty());
            assert!(
                std::iter::from_fn(|| events.try_recv().ok())
                    .any(|event| matches!(event.change, AuthAccessChange::McpNamedClients)),
                "the revoke sends the new list"
            );
            assert!(
                !service.revoke_client("person", &identity).await.unwrap(),
                "an ended identity is unknown"
            );
            let next = run(&service, &repositories, "builder").await;
            assert_ne!(
                named_id(&repositories, &next).await,
                Some(identity),
                "the next run starts a new identity"
            );
        }

        /// Revoke others removes every other row, idle identities included (#324).
        #[tokio::test]
        async fn revoke_others_ends_idle_named_clients() {
            let (service, repositories, _secrets) = mcp_test_service().await;
            let first = run(&service, &repositories, "builder").await;
            let identity = named_id(&repositories, &first).await;
            repositories
                .revoke_mcp_credential(first.clone(), format_iso(now_ms()))
                .await
                .unwrap();
            service.revoke_other_clients("person").await.unwrap();
            assert!(service.named_client_views().await.is_empty());
            let next = run(&service, &repositories, "builder").await;
            assert_ne!(named_id(&repositories, &next).await, identity);
        }

        /// Take over sticks to the identity: the next run starts read-only, and Hand back
        /// restores the level that run was paired with (#324).
        #[tokio::test]
        async fn a_taken_over_named_clients_next_run_starts_read_only_with_its_own_hand_back() {
            let (service, repositories, _secrets) = mcp_test_service().await;
            let first = run_at(&service, &repositories, "builder", "full-access").await;
            assert_eq!(
                service.set_mcp_access(&first, "read-only").await.unwrap(),
                McpAccessChange::Changed
            );
            repositories
                .revoke_mcp_credential(first.clone(), format_iso(now_ms()))
                .await
                .unwrap();
            let second = run_at(&service, &repositories, "builder", "approval-required").await;
            let expected = levels("read-only", Some("approval-required"));
            assert_eq!(cached_access(&service, &second).await, expected);
            let row = repositories
                .get_auth_session(second.clone())
                .await
                .unwrap()
                .expect("row");
            assert_eq!((row.mcp_access, row.mcp_access_hand_back), expected);
            assert_eq!(
                service.mcp_client_access(&second).await.as_deref(),
                Some("read-only")
            );
        }

        #[tokio::test]
        async fn taking_over_one_run_takes_over_every_live_run_of_the_identity() {
            let (service, repositories, _secrets) = mcp_test_service().await;
            let first = run_at(&service, &repositories, "builder", "full-access").await;
            let second = run_at(&service, &repositories, "builder", "auto-accept-edits").await;
            let other = run_at(&service, &repositories, "reviewer", "full-access").await;
            service.set_mcp_access(&first, "read-only").await.unwrap();
            assert_eq!(
                cached_access(&service, &first).await,
                levels("read-only", Some("full-access"))
            );
            assert_eq!(
                cached_access(&service, &second).await,
                levels("read-only", Some("auto-accept-edits"))
            );
            assert_eq!(
                cached_access(&service, &other).await,
                levels("full-access", None),
                "another name is untouched"
            );
        }

        #[tokio::test]
        async fn hand_back_on_one_run_releases_the_identity_and_every_live_run() {
            let (service, repositories, _secrets) = mcp_test_service().await;
            let first = run_at(&service, &repositories, "builder", "full-access").await;
            let second = run_at(&service, &repositories, "builder", "auto-accept-edits").await;
            service.set_mcp_access(&first, "read-only").await.unwrap();
            assert_eq!(
                service
                    .set_mcp_access(&second, "full-access")
                    .await
                    .unwrap(),
                McpAccessChange::NotTheHandBack,
                "Hand back restores only the run's own level"
            );
            assert_eq!(
                service
                    .set_mcp_access(&second, "auto-accept-edits")
                    .await
                    .unwrap(),
                McpAccessChange::Changed
            );
            assert_eq!(
                cached_access(&service, &first).await,
                levels("full-access", None)
            );
            assert_eq!(
                cached_access(&service, &second).await,
                levels("auto-accept-edits", None)
            );
            let third = run_at(&service, &repositories, "builder", "full-access").await;
            assert_eq!(
                cached_access(&service, &third).await,
                levels("full-access", None),
                "a released identity's next run starts at its own level"
            );
        }

        #[tokio::test]
        async fn a_read_only_run_of_a_taken_over_identity_has_no_hand_back() {
            let (service, repositories, _secrets) = mcp_test_service().await;
            let first = run_at(&service, &repositories, "builder", "full-access").await;
            service.set_mcp_access(&first, "read-only").await.unwrap();
            let reader = run_at(&service, &repositories, "builder", "read-only").await;
            assert_eq!(
                cached_access(&service, &reader).await,
                levels("read-only", None)
            );
        }

        /// A Take over that lands while a new run's row is committed but not yet published
        /// waits for the publication, so the cache never holds the run's paired level (#324).
        #[tokio::test]
        async fn take_over_while_a_named_run_publishes_leaves_the_cache_read_only() {
            let (service, repositories, _secrets) = mcp_test_service().await;
            let first = run_at(&service, &repositories, "builder", "full-access").await;
            let next = issue_named_mcp_pairing_link(&repositories, "builder", "full-access", &[])
                .await
                .expect("named link issues");
            let (held, reached, resume) = test_hold();
            *service.test_hooks().after_session_insert.lock().unwrap() = Some(held);
            let exchange = exchange_in_background(&service, &next.credential).await;
            reached.await.expect("the row committed");
            let take_over = {
                let service = service.clone();
                let first = first.clone();
                tokio::spawn(async move { service.set_mcp_access(&first, "read-only").await })
            };
            tokio::time::sleep(Duration::from_millis(50)).await;
            resume.send(()).unwrap();
            let second = exchange
                .await
                .unwrap()
                .expect("issued")
                .principal
                .session_id;
            assert_eq!(take_over.await.unwrap().unwrap(), McpAccessChange::Changed);
            assert_eq!(
                cached_access(&service, &second).await,
                levels("read-only", Some("full-access"))
            );
        }

        /// A refresh that read the writable row before a Take over committed must not put
        /// that level back into the cache (#324, Codex review).
        #[tokio::test]
        async fn a_refresh_that_read_before_take_over_does_not_restore_the_writable_level() {
            let (service, repositories, _secrets) = mcp_test_service().await;
            let first = run_at(&service, &repositories, "builder", "full-access").await;
            let (held, reached, resume) = test_hold();
            *service.test_hooks().after_refresh_read.lock().unwrap() = Some(held);
            let refresh = {
                let service = service.clone();
                let first = first.clone();
                tokio::spawn(async move { service.mcp_client_access(&first).await })
            };
            reached.await.expect("the refresh read the row");
            assert_eq!(
                service.set_mcp_access(&first, "read-only").await.unwrap(),
                McpAccessChange::Changed
            );
            resume.send(()).unwrap();
            assert_eq!(refresh.await.unwrap().as_deref(), Some("read-only"));
            assert_eq!(
                cached_access(&service, &first).await,
                levels("read-only", Some("full-access"))
            );
        }

        /// Constant local churn cannot spin a refresh: after its reads it keeps the cache.
        #[tokio::test]
        async fn a_refresh_overtaken_on_every_read_keeps_the_cache() {
            let (service, repositories, _secrets) = mcp_test_service().await;
            let first = run_at(&service, &repositories, "builder", "full-access").await;
            service
                .test_hooks()
                .churn_refresh
                .store(true, std::sync::atomic::Ordering::Relaxed);
            let access =
                tokio::time::timeout(Duration::from_secs(5), service.mcp_client_access(&first))
                    .await
                    .expect("the refresh gives up instead of spinning");
            assert_eq!(access.as_deref(), Some("full-access"));
        }

        /// The flag and each run's level are in the store, so a restarted server keeps them.
        #[tokio::test]
        async fn a_taken_over_identity_survives_a_restart() {
            let (service, repositories, secrets) = mcp_test_service().await;
            let first = run_at(&service, &repositories, "builder", "full-access").await;
            service.set_mcp_access(&first, "read-only").await.unwrap();
            drop(service);
            let restarted = AuthService::new_with_persistence(
                &ServerConfig::new(".").with_bind("127.0.0.1", 3773),
                vec![7_u8; 32],
                SecretStore::new(secrets.path())
                    .await
                    .expect("secret store opens"),
                repositories.clone(),
            )
            .await
            .expect("service hydrates");
            assert_eq!(
                cached_access(&restarted, &first).await,
                levels("read-only", Some("full-access"))
            );
            let second = run_at(&restarted, &repositories, "builder", "full-access").await;
            assert_eq!(
                cached_access(&restarted, &second).await,
                levels("read-only", Some("full-access"))
            );
        }

        /// Revoke others ends each named client one of the revoked sessions was a run of.
        #[tokio::test]
        async fn revoke_others_ends_the_named_clients_of_the_sessions_it_revokes() {
            let (service, repositories, _secrets) = mcp_test_service().await;
            let first = run(&service, &repositories, "builder").await;
            let pending = named_link(&repositories, "builder").await;
            assert_eq!(service.revoke_other_clients("person").await.unwrap(), 1);
            assert!(revoked(&repositories, &first).await);
            let exchanged = exchange_in_background(&service, &pending.credential)
                .await
                .await
                .unwrap();
            assert!(matches!(exchanged, Err(AuthError::InvalidCredential)));
        }

        /// An older relay's SQL names no migration-70 column; on a migrated store its link and
        /// session are unnamed and its revoke works.
        #[tokio::test]
        async fn an_older_relays_link_and_session_on_a_migrated_store_are_unnamed() {
            let (service, repositories, _secrets) = mcp_test_service().await;
            let created_at = format_iso(now_ms());
            let expires_at = format_iso(now_ms() + 60_000);
            repositories
                .database()
                .call(move |connection| {
                    connection.execute(
                        "INSERT INTO auth_pairing_links (
                            id, credential, method, scopes, subject, label, proof_key_thumbprint,
                            created_at, expires_at, consumed_at, revoked_at, reach, off_host, mcp_access
                         ) VALUES ('old-link', 'old-credential', 'one-time-token',
                           '[\"orchestration:read\",\"orchestration:operate\"]', 'mcp-client',
                           'MCP · old', NULL, ?, ?, NULL, NULL, NULL, NULL, 'read-only')",
                        rusqlite::params![created_at, expires_at],
                    )?;
                    Ok(())
                })
                .await
                .unwrap();
            let session = exchange_in_background(&service, "old-credential")
                .await
                .await
                .unwrap()
                .expect("exchange");
            assert_eq!(session.principal.session_id, "old-link");
            assert_eq!(named_id(&repositories, "old-link").await, None);
            assert!(
                repositories
                    .revoke_mcp_credential("old-link".to_owned(), format_iso(now_ms()))
                    .await
                    .unwrap()
            );
        }
    }
}
