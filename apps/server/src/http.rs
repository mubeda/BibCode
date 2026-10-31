use std::{
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    path::{Component, Path, PathBuf},
    sync::Arc,
    time::UNIX_EPOCH,
};

use axum::{
    Json, Router,
    body::Body,
    extract::{
        ConnectInfo, FromRef, Request, State, WebSocketUpgrade, connect_info::Connected,
        rejection::ExtensionRejection,
    },
    http::{
        HeaderMap, HeaderValue, Method, StatusCode, Uri,
        header::{
            CACHE_CONTROL, CONTENT_LENGTH, CONTENT_TYPE, ETAG, HOST, IF_NONE_MATCH, LOCATION, VARY,
        },
    },
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    serve::IncomingStream,
};
use percent_encoding::percent_decode_str;
use serde::{Deserialize, Serialize};
use serde_json::json;
use subtle::ConstantTimeEq;
use tokio::fs::File;
use tokio_util::{io::ReaderStream, sync::CancellationToken};
use tower_http::cors::{AllowCredentials, AllowOrigin, Any, CorsLayer};

use crate::{
    auth,
    config::{ServerConfig, ServerMode},
    device::media::MediaChannel,
    maintenance::{
        DESKTOP_MAINTENANCE_TOKEN_HEADER, MAINTENANCE_UPDATE_CANCEL_PATH,
        MAINTENANCE_UPDATE_COMMIT_PATH, MAINTENANCE_UPDATE_PREPARE_PATH,
        MAINTENANCE_UPDATE_STATUS_PATH, MaintenanceError, RpcAdmissionGate, UpdateMaintenance,
        http_mutability,
    },
    preview::gateway::registry::{ClientReach, PreviewGateway},
    production::http_routes::{self, DEVICE_MEDIA_E2EE_PATH, DEVICE_MEDIA_PATH, HttpRoutesState},
    remote_update::RemoteUpdateSupport,
    rpc::{
        E2eePreauthAdmission, MAX_E2EE_CIPHERTEXT_BYTES, RpcRegistry, RpcSessionContext,
        plain_subprotocols, remote_compression_enabled, run_session,
    },
};

pub const ENVIRONMENT_DESCRIPTOR_PATH: &str = "/.well-known/bibcode/environment";
pub(crate) const WS_E2EE_PATH: &str = "/ws-e2ee";
pub(crate) const REMOTE_PROTOCOL_VERSION: u32 = 1;
pub(crate) const MIN_COMPATIBLE_REMOTE_PROTOCOL: u32 = 1;
pub const DESKTOP_SHUTDOWN_PATH: &str = "/.well-known/bibcode/desktop/shutdown";
pub const DESKTOP_SHUTDOWN_TOKEN_HEADER: &str = "x-bibcode-desktop-bootstrap-token";

const CONTENT_SECURITY_POLICY_VALUE: &str = "default-src 'self'; connect-src 'self' http: https: ws: wss:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";
const IMMUTABLE_CACHE_CONTROL: &str = "public, max-age=31536000, immutable";
const HTML_CACHE_CONTROL: &str = "no-cache";
const MAX_PLAIN_WEBSOCKET_MESSAGE_BYTES: usize = 64 * 1024 * 1024;
const MAX_PLAIN_WEBSOCKET_FRAME_BYTES: usize = 16 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RouteMethod {
    Delete,
    Get,
    Post,
}

impl RouteMethod {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Delete => "DELETE",
            Self::Get => "GET",
            Self::Post => "POST",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RouteSpec {
    pub method: &'static str,
    pub path: &'static str,
}

const fn route(method: RouteMethod, path: &'static str) -> RouteSpec {
    RouteSpec {
        method: method.as_str(),
        path,
    }
}

pub const ROUTE_INVENTORY: &[RouteSpec] = &[
    route(RouteMethod::Get, ENVIRONMENT_DESCRIPTOR_PATH),
    route(RouteMethod::Get, "/api/auth/session"),
    route(RouteMethod::Post, "/api/auth/browser-session"),
    route(RouteMethod::Post, "/oauth/token"),
    // Remote MCP's OAuth (slice R): unauthenticated, admitted per source, and served only on
    // an eligible origin.
    route(
        RouteMethod::Get,
        crate::auth::PROTECTED_RESOURCE_METADATA_PATH,
    ),
    route(
        RouteMethod::Get,
        crate::auth::PROTECTED_RESOURCE_ROOT_METADATA_PATH,
    ),
    route(
        RouteMethod::Get,
        crate::auth::AUTHORIZATION_SERVER_METADATA_PATH,
    ),
    route(RouteMethod::Post, "/oauth/register"),
    route(RouteMethod::Get, "/oauth/authorize"),
    route(RouteMethod::Get, "/oauth/authorize/status"),
    route(RouteMethod::Post, "/api/auth/websocket-ticket"),
    route(RouteMethod::Post, "/api/auth/pairing-token"),
    route(RouteMethod::Post, "/api/auth/pairing-offer"),
    route(RouteMethod::Post, "/api/auth/pairing-offer/cancel"),
    route(RouteMethod::Get, "/api/auth/share-state"),
    route(RouteMethod::Get, "/api/auth/pairing-links"),
    route(RouteMethod::Post, "/api/auth/pairing-links/revoke"),
    route(RouteMethod::Get, "/api/auth/clients"),
    route(RouteMethod::Post, "/api/auth/clients/revoke"),
    route(RouteMethod::Post, "/api/auth/clients/mcp-access"),
    route(RouteMethod::Post, "/api/auth/clients/revoke-others"),
    // Approving or denying a remote MCP authorization needs `access:write` (slice R).
    route(RouteMethod::Post, "/api/auth/mcp-authorizations/approve"),
    route(RouteMethod::Post, "/api/auth/mcp-authorizations/deny"),
    route(RouteMethod::Get, "/api/orchestration/snapshot"),
    route(RouteMethod::Post, "/api/orchestration/dispatch"),
    route(RouteMethod::Post, "/api/connect/link-proof"),
    route(RouteMethod::Post, "/api/connect/relay-config"),
    route(RouteMethod::Get, "/api/connect/link-state"),
    route(RouteMethod::Post, "/api/connect/unlink"),
    route(RouteMethod::Post, "/api/bibcode-connect/health"),
    route(RouteMethod::Post, "/api/connect/mint-credential"),
    route(RouteMethod::Post, "/api/bibcode-connect/mint-credential"),
    route(RouteMethod::Get, "/ws"),
    route(RouteMethod::Get, WS_E2EE_PATH),
    route(RouteMethod::Post, "/api/diagnostics/logs.zip"),
    route(RouteMethod::Post, "/api/diagnostics/relay"),
    route(RouteMethod::Get, "/api/assets/*"),
    route(RouteMethod::Post, "/api/preview/open-url"),
    route(RouteMethod::Get, "/api/transfers/*"),
    route(RouteMethod::Get, DEVICE_MEDIA_PATH),
    route(RouteMethod::Get, DEVICE_MEDIA_E2EE_PATH),
    route(RouteMethod::Post, "/api/transfers/*"),
    route(RouteMethod::Post, DESKTOP_SHUTDOWN_PATH),
    route(RouteMethod::Post, MAINTENANCE_UPDATE_PREPARE_PATH),
    route(RouteMethod::Post, MAINTENANCE_UPDATE_COMMIT_PATH),
    route(RouteMethod::Post, MAINTENANCE_UPDATE_CANCEL_PATH),
    route(RouteMethod::Get, MAINTENANCE_UPDATE_STATUS_PATH),
    route(RouteMethod::Get, "/mcp"),
    route(RouteMethod::Post, "/mcp"),
    route(RouteMethod::Delete, "/mcp"),
    // Unauthenticated and loopback-only: reads no bearer (`mcp::endpoint`).
    route(RouteMethod::Post, crate::mcp::endpoint::PROOF_PATH),
    route(RouteMethod::Get, "*"),
];

/// Both ends of an accepted connection. `local` is the address the client reached, which on a
/// wildcard bind tells which interface, and so which network, it came in on.
#[derive(Clone, Copy, Debug)]
pub(crate) struct ConnectionAddrs {
    pub(crate) peer: SocketAddr,
    pub(crate) local: Option<SocketAddr>,
}

impl Connected<IncomingStream<'_, tokio::net::TcpListener>> for ConnectionAddrs {
    fn connect_info(stream: IncomingStream<'_, tokio::net::TcpListener>) -> Self {
        Self {
            peer: *stream.remote_addr(),
            local: stream.io().local_addr().ok(),
        }
    }
}

pub(crate) type ConnectionInfo = Result<ConnectInfo<ConnectionAddrs>, ExtensionRejection>;

/// How a WebSocket client reached this server, for `preview.gatewayOpen`.
fn client_reach(connection: ConnectionInfo, headers: &HeaderMap) -> Option<ClientReach> {
    let ConnectInfo(addrs) = connection.ok()?;
    Some(ClientReach {
        local_ip: addrs.local?.ip(),
        host: headers
            .get(HOST)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned),
    })
}

const X_FORWARDED_HOST: &str = "x-forwarded-host";
const X_FORWARDED_PROTO: &str = "x-forwarded-proto";
const X_FORWARDED_FOR: &str = "x-forwarded-for";

/// How a request reached this server (#139, slice R), computed once per request before any
/// route runs.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum RequestClass {
    /// A loopback `Host` from a loopback peer, or the address this connection was accepted
    /// on, with no forwarded header: a process on this host, or a client of the bound
    /// address.
    Direct,
    /// BiBCode Connect's managed tunnel: a loopback socket and the managed hostname in
    /// `Host`. Its origin is fixed by the server.
    ManagedTunnel,
    /// A reverse proxy on this host that overwrites the forwarded headers, as the nginx
    /// recipe does: a loopback peer, a loopback `Host`, and `X-Forwarded-Host`.
    LocalProxy,
    /// Anything else, a preview gateway hostname included. Fails closed.
    #[default]
    Other,
}

/// The class, effective origin and admission source of a request.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct RequestOrigin {
    pub class: RequestClass,
    /// `scheme://host[:port]` as the client reached this server; `None` for [`RequestClass::Other`].
    pub origin: Option<String>,
    /// Who sent it, for the unauthenticated routes' admission: the peer's network (for a
    /// loopback peer, the last `X-Forwarded-For` entry's), or the managed tunnel.
    pub source_key: String,
}

impl RequestOrigin {
    /// A direct request to `origin` (`http://127.0.0.1:3773`), as a test or an in-process
    /// caller reaches this server.
    #[must_use]
    pub fn direct(origin: impl Into<String>) -> Self {
        Self {
            class: RequestClass::Direct,
            origin: Some(origin.into()),
            source_key: "loopback".to_owned(),
        }
    }

    /// Whether the request came straight to this server, not through a tunnel or a proxy.
    #[must_use]
    pub fn is_direct(&self) -> bool {
        self.class == RequestClass::Direct
    }

    /// The origin remote MCP's OAuth routes may serve: the managed tunnel's, a local proxy's
    /// `https` one, or a direct loopback `http` one. `None` everywhere else.
    #[must_use]
    pub fn eligible_origin(&self) -> Option<&str> {
        let origin = self.origin.as_deref()?;
        let eligible = match self.class {
            RequestClass::ManagedTunnel => true,
            RequestClass::LocalProxy => origin.starts_with("https://"),
            RequestClass::Direct => url::Url::parse(origin).is_ok_and(|url| {
                url.scheme() == "http" && url.host_str().is_some_and(crate::auth::is_loopback_host)
            }),
            RequestClass::Other => false,
        };
        eligible.then_some(origin)
    }
}

/// The forwarded-header rule (slice R), for every route: `X-Forwarded-Host` and
/// `X-Forwarded-Proto` are honored only when the peer is loopback **and** the raw `Host` is
/// a loopback name or the address the connection was accepted on. Otherwise both are
/// removed and `Host` is kept, so a client of the managed tunnel cannot turn its `Host` into
/// a loopback name. The nginx recipe (`Host: $proxy_host` and both headers overwritten) keeps
/// working; a proxy that sends the public `Host` itself loses only the scheme.
async fn trust_forwarded_headers(
    State(gateway): State<Option<PreviewGateway>>,
    connection: ConnectionInfo,
    mut request: Request,
    next: Next,
) -> Response {
    let addrs = connection.ok().map(|ConnectInfo(addrs)| addrs);
    let origin = classify_request(
        request.headers_mut(),
        addrs.map(|addrs| addrs.peer.ip()),
        addrs.and_then(|addrs| addrs.local),
        |local_ip, host| {
            gateway
                .as_ref()
                .and_then(|gateway| gateway.managed_hostname(local_ip, host))
        },
    );
    request.extensions_mut().insert(origin);
    next.run(request).await
}

fn first_header_value<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(',').next())
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

/// Applies the forwarded-header rule to `headers` and classifies the request.
fn classify_request(
    headers: &mut HeaderMap,
    peer: Option<IpAddr>,
    local: Option<SocketAddr>,
    managed_hostname: impl Fn(IpAddr, Option<&str>) -> Option<String>,
) -> RequestOrigin {
    let raw_host = headers
        .get(HOST)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let peer_loopback = peer.is_some_and(|peer| peer.to_canonical().is_loopback());
    let host_is_loopback = raw_host.as_deref().is_some_and(authority_is_loopback);
    let host_is_bound = raw_host
        .as_deref()
        .zip(local)
        .is_some_and(|(host, local)| authority_is_address(host, local));
    let forwarded =
        headers.contains_key(X_FORWARDED_HOST) || headers.contains_key(X_FORWARDED_PROTO);
    let honored = peer_loopback && (host_is_loopback || host_is_bound);
    let source_key = source_key(peer, headers);
    if !honored {
        headers.remove(X_FORWARDED_HOST);
        headers.remove(X_FORWARDED_PROTO);
    }
    let forwarded_host = honored
        .then(|| first_header_value(headers, X_FORWARDED_HOST))
        .flatten()
        .map(str::to_owned);
    if let Some(host) = forwarded_host
        .as_deref()
        .and_then(|host| HeaderValue::from_str(host).ok())
    {
        // From such a peer the forwarded host becomes `Host`, so the Origin rule and the
        // preview gateway see the address the browser used.
        headers.insert(HOST, host);
    }
    if let Some(host) = forwarded_host {
        let scheme = match first_header_value(headers, X_FORWARDED_PROTO) {
            Some(proto) if proto.eq_ignore_ascii_case("https") => "https",
            _ => "http",
        };
        return RequestOrigin {
            class: RequestClass::LocalProxy,
            origin: normalized_origin(scheme, &host),
            source_key,
        };
    }
    if !forwarded && ((peer_loopback && host_is_loopback) || host_is_bound) {
        let origin = raw_host
            .as_deref()
            .and_then(|host| normalized_origin("http", host));
        return RequestOrigin {
            class: if origin.is_some() {
                RequestClass::Direct
            } else {
                RequestClass::Other
            },
            origin,
            source_key,
        };
    }
    if let Some(local) = local
        && let Some(hostname) = managed_hostname(local.ip(), raw_host.as_deref())
    {
        return RequestOrigin {
            class: RequestClass::ManagedTunnel,
            origin: normalized_origin("https", &hostname),
            source_key: "tunnel".to_owned(),
        };
    }
    RequestOrigin {
        class: RequestClass::Other,
        origin: None,
        source_key,
    }
}

/// `scheme://authority`, normalized (lower-case host, no default port); `None` for an
/// authority that is not a plain host and port.
fn normalized_origin(scheme: &str, authority: &str) -> Option<String> {
    if authority.contains(['/', '?', '#', '@', ' ']) {
        return None;
    }
    let url = url::Url::parse(&format!("{scheme}://{authority}")).ok()?;
    url.host_str()?;
    Some(url.origin().ascii_serialization())
}

fn authority_host(authority: &str) -> Option<String> {
    let url = url::Url::parse(&format!("http://{authority}")).ok()?;
    url.host_str().map(str::to_owned)
}

fn authority_is_loopback(authority: &str) -> bool {
    authority_host(authority).is_some_and(|host| crate::auth::is_loopback_host(&host))
}

fn authority_is_address(authority: &str, address: SocketAddr) -> bool {
    let Ok(url) = url::Url::parse(&format!("http://{authority}")) else {
        return false;
    };
    let host_ip = match url.host() {
        Some(url::Host::Ipv4(ip)) => IpAddr::V4(ip),
        Some(url::Host::Ipv6(ip)) => IpAddr::V6(ip),
        _ => return false,
    };
    host_ip.to_canonical() == address.ip().to_canonical()
        && url.port_or_known_default() == Some(address.port())
}

/// The admission source of a request: the peer's network (an IPv4 /24 or IPv6 /64), with a
/// loopback peer keyed by the last `X-Forwarded-For` entry, which a local proxy appends.
fn source_key(peer: Option<IpAddr>, headers: &HeaderMap) -> String {
    let Some(peer) = peer else {
        return "unknown".to_owned();
    };
    let forwarded_for = headers
        .get(X_FORWARDED_FOR)
        .and_then(|value| value.to_str().ok());
    match crate::rpc::effective_preauth_peer(peer, forwarded_for) {
        ip if ip.is_unspecified() => "unspecified".to_owned(),
        ip if ip.is_loopback() => "loopback".to_owned(),
        IpAddr::V4(ip) => {
            let octets = ip.octets();
            format!("v4:{}.{}.{}.0/24", octets[0], octets[1], octets[2])
        }
        IpAddr::V6(ip) => {
            let segments = ip.segments();
            format!(
                "v6:{:x}:{:x}:{:x}:{:x}::/64",
                segments[0], segments[1], segments[2], segments[3]
            )
        }
    }
}

#[derive(Clone)]
pub(crate) struct AppState {
    pub config: Arc<ServerConfig>,
    pub shutdown: CancellationToken,
    pub rpc_registry: RpcRegistry,
    pub e2ee_preauth_admission: E2eePreauthAdmission,
    pub auth: auth::AuthService,
    pub http_routes: HttpRoutesState,
    pub admission_gate: RpcAdmissionGate,
    pub update_maintenance: Option<Arc<UpdateMaintenance>>,
    /// Serves BiBCode Connect preview hostnames; `None` without a production runtime.
    pub preview_gateway: Option<PreviewGateway>,
}

impl FromRef<AppState> for HttpRoutesState {
    fn from_ref(state: &AppState) -> Self {
        state.http_routes.clone()
    }
}

pub(crate) fn build_router(state: AppState) -> Router {
    let cors = cors_layer(&state.config);
    let router = http_routes::add_routes(auth::add_routes(Router::<AppState>::new()));
    router
        .route(ENVIRONMENT_DESCRIPTOR_PATH, get(environment_descriptor))
        .route(DESKTOP_SHUTDOWN_PATH, post(desktop_shutdown))
        .route(MAINTENANCE_UPDATE_PREPARE_PATH, post(update_prepare))
        .route(MAINTENANCE_UPDATE_COMMIT_PATH, post(update_commit))
        .route(MAINTENANCE_UPDATE_CANCEL_PATH, post(update_cancel))
        .route(MAINTENANCE_UPDATE_STATUS_PATH, get(update_status))
        .route("/ws", get(websocket))
        .route(WS_E2EE_PATH, get(websocket_e2ee))
        .fallback(static_or_dev)
        .layer(middleware::from_fn_with_state(
            state.admission_gate.clone(),
            request_admission,
        ))
        .layer(middleware::from_fn_with_state(
            state.preview_gateway.clone(),
            trust_forwarded_headers,
        ))
        .layer(cors)
        .layer(middleware::from_fn_with_state(
            state.preview_gateway.clone(),
            route_relay_previews,
        ))
        .with_state(state)
}

/// BiBCode Connect preview hostnames reach this port through the tunnel. The preview
/// gateway serves them, never BiBCode's own routes, CORS, or admission gate; the raw
/// `Host` is matched before forwarded headers are applied.
async fn route_relay_previews(
    State(gateway): State<Option<PreviewGateway>>,
    connection: ConnectionInfo,
    request: Request,
    next: Next,
) -> Response {
    let Some(gateway) = gateway else {
        return next.run(request).await;
    };
    let local = connection
        .ok()
        .and_then(|ConnectInfo(addrs)| addrs.local)
        .map(|addr| addr.ip());
    let host = request
        .headers()
        .get(HOST)
        .and_then(|value| value.to_str().ok());
    let forwarded_proto = request
        .headers()
        .get(X_FORWARDED_PROTO)
        .and_then(|value| value.to_str().ok());
    let path = request
        .uri()
        .path_and_query()
        .map_or("/", |path| path.as_str());
    if let Some(location) = gateway.relay_https_redirect(local, host, forwarded_proto, path) {
        return (StatusCode::PERMANENT_REDIRECT, [(LOCATION, location)]).into_response();
    }
    match gateway.relay_slot(local, host) {
        Some(slot) => gateway
            .serve_relay(slot, request)
            .await
            .map(axum::body::Body::new),
        None => next.run(request).await,
    }
}

async fn request_admission(
    State(gate): State<RpcAdmissionGate>,
    request: Request,
    next: Next,
) -> Response {
    let mutability = http_mutability(request.method().as_str(), request.uri().path());
    let operation = format!("HTTP {} {}", request.method(), request.uri().path());
    let Ok(_permit) = gate.admit_named(mutability, operation) else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            [(CACHE_CONTROL, "no-store")],
            Json(json!({
                "_tag": "UpdateMaintenanceActiveError",
                "message": "Persistent mutations are temporarily closed while project data is protected.",
            })),
        )
            .into_response();
    };
    next.run(request).await
}

fn cors_layer(config: &ServerConfig) -> CorsLayer {
    let layer = CorsLayer::new()
        .allow_methods([Method::GET, Method::POST, Method::DELETE, Method::OPTIONS])
        // Never allow `x-forwarded-host` (or `-proto`) here. A loopback peer's forwarded host
        // becomes `Host` (`apply_forwarded_headers`), and the cookie Origin rule compares
        // against that `Host`. A page could otherwise make the browser on this machine send a
        // forwarded host equal to its own origin and pass the rule with the user's cookie.
        .allow_headers([
            axum::http::header::AUTHORIZATION,
            axum::http::header::CONTENT_TYPE,
            axum::http::HeaderName::from_static("b3"),
            axum::http::HeaderName::from_static("traceparent"),
            axum::http::HeaderName::from_static("dpop"),
            axum::http::HeaderName::from_static("idempotency-key"),
            axum::http::HeaderName::from_static(DESKTOP_MAINTENANCE_TOKEN_HEADER),
        ])
        .max_age(std::time::Duration::from_secs(600));
    let Some(dev_url) = &config.dev_url else {
        return layer.allow_origin(Any);
    };
    // The desktop app's origins get no credentials: it sends a bearer token, and cookie
    // requests from them are refused.
    let mut origins = Vec::new();
    if let Ok(origin) = dev_url.origin().ascii_serialization().parse() {
        origins.push(origin);
    }
    // Normal mode already allows every origin for header-authenticated clients.
    // Preserve that access in dev mode; only this allowlist gets credentialed CORS.
    layer
        .allow_origin(AllowOrigin::mirror_request())
        .allow_credentials(AllowCredentials::predicate(move |origin, _| {
            origins.contains(origin)
        }))
}

async fn websocket(
    State(state): State<AppState>,
    connection: ConnectionInfo,
    headers: HeaderMap,
    uri: Uri,
    upgrade: WebSocketUpgrade,
) -> Response {
    let session_shutdown = state.shutdown.child_token();
    let reach = client_reach(connection, &headers);
    if state.config.unsafe_no_auth {
        return upgrade
            .protocols(
                plain_subprotocols(remote_compression_enabled())
                    .iter()
                    .copied(),
            )
            .max_frame_size(MAX_PLAIN_WEBSOCKET_FRAME_BYTES)
            .max_message_size(MAX_PLAIN_WEBSOCKET_MESSAGE_BYTES)
            .on_upgrade(move |socket| {
                run_session(
                    socket,
                    state.rpc_registry,
                    RpcSessionContext::unauthenticated()
                        .with_reach(reach)
                        .with_channel(MediaChannel::Plain),
                    session_shutdown,
                )
            })
            .into_response();
    }
    match auth::authenticate_websocket(&state.auth, &headers, &uri).await {
        Ok(principal) => {
            let auth = state.auth.clone();
            let session_id = principal.session_id.clone();
            let expires_at_ms = principal.expires_at_ms;
            let rpc_context = RpcSessionContext::authenticated(principal, auth.clone())
                .with_reach(reach)
                .with_channel(MediaChannel::Plain);
            upgrade
                .protocols(
                    plain_subprotocols(remote_compression_enabled())
                        .iter()
                        .copied(),
                )
                .max_frame_size(MAX_PLAIN_WEBSOCKET_FRAME_BYTES)
                .max_message_size(MAX_PLAIN_WEBSOCKET_MESSAGE_BYTES)
                .on_upgrade(move |socket| async move {
                    let Ok(connection_guard) = auth
                        .mark_connected_guard(&session_id, session_shutdown.clone())
                        .await
                    else {
                        session_shutdown.cancel();
                        drop(socket);
                        return;
                    };
                    let expiration_guard =
                        spawn_session_expiration_guard(expires_at_ms, session_shutdown.clone());
                    run_session(
                        socket,
                        state.rpc_registry,
                        rpc_context,
                        session_shutdown.clone(),
                    )
                    .await;
                    session_shutdown.cancel();
                    let _ = expiration_guard.await;
                    connection_guard.close().await;
                })
                .into_response()
        }
        Err(error) => auth::auth_error_response(error),
    }
}

async fn websocket_e2ee(
    State(state): State<AppState>,
    connection: ConnectionInfo,
    headers: axum::http::HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Response {
    let session_shutdown = state.shutdown.child_token();
    let socket_peer_ip = connection
        .as_ref()
        .ok()
        .map(|ConnectInfo(addrs)| addrs.peer.ip())
        .unwrap_or(IpAddr::V4(Ipv4Addr::UNSPECIFIED));
    let reach = client_reach(connection, &headers);
    let peer_ip = crate::rpc::effective_preauth_peer(
        socket_peer_ip,
        headers
            .get("x-forwarded-for")
            .and_then(|value| value.to_str().ok()),
    );
    let preauth_admission = state.e2ee_preauth_admission;
    upgrade
        .max_frame_size(MAX_E2EE_CIPHERTEXT_BYTES)
        .max_message_size(MAX_E2EE_CIPHERTEXT_BYTES)
        .on_upgrade(move |socket| {
            crate::rpc::run_e2ee_session(
                socket,
                peer_ip,
                reach,
                preauth_admission,
                state.auth,
                state.rpc_registry,
                state.config,
                session_shutdown,
            )
        })
        .into_response()
}

pub(crate) fn spawn_session_expiration_guard(
    expires_at_ms: i64,
    session_shutdown: CancellationToken,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let remaining_ms = expires_at_ms.saturating_sub(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .ok()
                .and_then(|duration| i64::try_from(duration.as_millis()).ok())
                .unwrap_or(i64::MAX),
        );
        tokio::select! {
            () = session_shutdown.cancelled() => {}
            () = tokio::time::sleep(std::time::Duration::from_millis(
                u64::try_from(remaining_ms.max(0)).unwrap_or_default(),
            )) => session_shutdown.cancel(),
        }
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EnvironmentDescriptor {
    environment_id: String,
    label: String,
    platform: PlatformDescriptor,
    server_version: String,
    storage_instance_id: String,
    boot_id: Option<String>,
    remote_update_support: RemoteUpdateSupport,
    remote_protocol_version: u32,
    min_compatible_remote_protocol: u32,
    capabilities: EnvironmentCapabilities,
}

#[derive(Serialize)]
struct PlatformDescriptor {
    os: &'static str,
    arch: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EnvironmentCapabilities {
    repository_identity: bool,
    remote_update_control: bool,
    remote_update_progress: bool,
    terminal_ordered_input: bool,
    terminal_size_ownership: bool,
    /// `preview.tunnelOpen`, `preview.tunnelWrite` and `preview.tunnelClose` (#69): what a
    /// desktop reads before routing an environment's previews through SOCKS.
    preview_tunnels: bool,
}

async fn environment_descriptor(State(state): State<AppState>) -> Json<EnvironmentDescriptor> {
    let config = state.config;
    Json(EnvironmentDescriptor {
        environment_id: config.environment_id.clone(),
        label: config.environment_label.clone(),
        platform: PlatformDescriptor {
            os: platform_os(),
            arch: platform_arch(),
        },
        server_version: config.server_version.clone(),
        storage_instance_id: config
            .storage_instance_id
            .expect("a running server has a prepared persistent store")
            .to_string(),
        boot_id: config.boot_id.map(|id| id.to_string()),
        remote_update_support: config.remote_update_support,
        remote_protocol_version: REMOTE_PROTOCOL_VERSION,
        min_compatible_remote_protocol: MIN_COMPATIBLE_REMOTE_PROTOCOL,
        capabilities: EnvironmentCapabilities {
            repository_identity: true,
            remote_update_control: true,
            remote_update_progress: true,
            terminal_ordered_input: true,
            terminal_size_ownership: true,
            preview_tunnels: true,
        },
    })
}

async fn desktop_shutdown(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if state.config.mode != ServerMode::Desktop || state.config.desktop_bootstrap_token.is_none() {
        return (StatusCode::NOT_FOUND, "Not Found").into_response();
    }
    let supplied_token = headers
        .get(DESKTOP_SHUTDOWN_TOKEN_HEADER)
        .and_then(|value| value.to_str().ok());
    if !token_matches(
        state.config.desktop_bootstrap_token.as_deref(),
        supplied_token,
    ) {
        return (StatusCode::FORBIDDEN, "Forbidden").into_response();
    }

    state.shutdown.cancel();
    (
        StatusCode::ACCEPTED,
        [(CACHE_CONTROL, "no-store")],
        Json(json!({ "shuttingDown": true })),
    )
        .into_response()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateOperationInput {
    operation_id: String,
}

fn authorized_update_maintenance(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<Arc<UpdateMaintenance>, StatusCode> {
    let Some(maintenance) = state.update_maintenance.clone() else {
        return Err(StatusCode::NOT_FOUND);
    };
    let supplied_token = headers
        .get(DESKTOP_MAINTENANCE_TOKEN_HEADER)
        .and_then(|value| value.to_str().ok());
    if !token_matches(
        state.config.desktop_bootstrap_token.as_deref(),
        supplied_token,
    ) {
        return Err(StatusCode::FORBIDDEN);
    }
    Ok(maintenance)
}

async fn update_prepare(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let maintenance = match authorized_update_maintenance(&state, &headers) {
        Ok(maintenance) => maintenance,
        Err(status) => {
            return (status, status.canonical_reason().unwrap_or("Error")).into_response();
        }
    };
    match maintenance.prepare().await {
        Ok(result) => (StatusCode::OK, [(CACHE_CONTROL, "no-store")], Json(result)).into_response(),
        Err(error) => maintenance_error_response(error),
    }
}

async fn update_commit(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<UpdateOperationInput>,
) -> Response {
    let maintenance = match authorized_update_maintenance(&state, &headers) {
        Ok(maintenance) => maintenance,
        Err(status) => {
            return (status, status.canonical_reason().unwrap_or("Error")).into_response();
        }
    };
    let operation_id = match uuid::Uuid::parse_str(&input.operation_id) {
        Ok(operation_id) => operation_id,
        Err(_) => return maintenance_error_response(MaintenanceError::OperationMismatch),
    };
    match maintenance.commit(operation_id).await {
        Ok(()) => {
            maintenance.shutdown_after_response();
            (
                StatusCode::OK,
                [(CACHE_CONTROL, "no-store")],
                Json(json!({"committed":true})),
            )
                .into_response()
        }
        Err(error) => maintenance_error_response(error),
    }
}

async fn update_cancel(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<UpdateOperationInput>,
) -> Response {
    let maintenance = match authorized_update_maintenance(&state, &headers) {
        Ok(maintenance) => maintenance,
        Err(status) => {
            return (status, status.canonical_reason().unwrap_or("Error")).into_response();
        }
    };
    let operation_id = match uuid::Uuid::parse_str(&input.operation_id) {
        Ok(operation_id) => operation_id,
        Err(_) => return maintenance_error_response(MaintenanceError::OperationMismatch),
    };
    match maintenance.cancel(operation_id).await {
        Ok(()) => {
            maintenance.shutdown_after_response();
            (
                StatusCode::OK,
                [(CACHE_CONTROL, "no-store")],
                Json(json!({"cancelled":true})),
            )
                .into_response()
        }
        Err(error) => maintenance_error_response(error),
    }
}

async fn update_status(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let maintenance = match authorized_update_maintenance(&state, &headers) {
        Ok(maintenance) => maintenance,
        Err(status) => {
            return (status, status.canonical_reason().unwrap_or("Error")).into_response();
        }
    };
    (
        StatusCode::OK,
        [(CACHE_CONTROL, "no-store")],
        Json(maintenance.status().await),
    )
        .into_response()
}

fn maintenance_error_response(error: MaintenanceError) -> Response {
    let status = match error {
        MaintenanceError::OperationMismatch | MaintenanceError::NoPreparedOperation => {
            StatusCode::CONFLICT
        }
        MaintenanceError::AdmissionClosed
        | MaintenanceError::DrainTimeout { .. }
        | MaintenanceError::Preparation(_) => StatusCode::SERVICE_UNAVAILABLE,
    };
    (
        status,
        [(CACHE_CONTROL, "no-store")],
        Json(json!({
            "_tag":"UpdateMaintenanceError",
            "message":error.to_string(),
        })),
    )
        .into_response()
}

fn token_matches(expected: Option<&str>, supplied: Option<&str>) -> bool {
    let (Some(expected), Some(supplied)) = (expected, supplied) else {
        return false;
    };
    expected.len() == supplied.len() && bool::from(expected.as_bytes().ct_eq(supplied.as_bytes()))
}

async fn static_or_dev(
    State(state): State<AppState>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
) -> Response {
    if method != Method::GET && method != Method::HEAD {
        return (StatusCode::NOT_FOUND, "Not Found").into_response();
    }

    if let Some(dev_url) = &state.config.dev_url
        && request_is_loopback(&headers)
    {
        let mut redirect = dev_url.clone();
        redirect.set_path(uri.path());
        redirect.set_query(uri.query());
        return Response::builder()
            .status(StatusCode::FOUND)
            .header(LOCATION, redirect.as_str())
            .body(Body::empty())
            .unwrap_or_else(|_| internal_server_error());
    }

    let Some(static_dir) = &state.config.static_dir else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            "No static directory configured and no dev URL set.",
        )
            .into_response();
    };
    serve_static(static_dir, uri.path(), &method, &headers).await
}

async fn serve_static(
    static_dir: &Path,
    request_path: &str,
    method: &Method,
    headers: &HeaderMap,
) -> Response {
    let relative = match safe_relative_path(request_path) {
        Ok(path) => path,
        Err(()) => return (StatusCode::BAD_REQUEST, "Invalid static file path").into_response(),
    };
    let root = match tokio::fs::canonicalize(static_dir).await {
        Ok(path) => path,
        Err(_) => return (StatusCode::NOT_FOUND, "Not Found").into_response(),
    };

    let mut candidate = root.join(relative);
    if candidate.extension().is_none() {
        candidate.push("index.html");
    }
    let candidate = match canonical_file_within(&root, &candidate).await {
        Some(path) => path,
        None => match canonical_file_within(&root, &root.join("index.html")).await {
            Some(path) => path,
            None => return (StatusCode::NOT_FOUND, "Not Found").into_response(),
        },
    };
    if candidate == root.join("index.html") {
        return serve_entry_document(&candidate, method, headers).await;
    }
    let content_hashed = candidate
        .strip_prefix(&root)
        .is_ok_and(is_content_hashed_asset);
    stream_file(candidate, content_hashed, method, headers).await
}

/// The web app's entry document, marked as served by this server: a
/// `<meta name="bibcode-served-host">` names the host the request was served for. The app pairs
/// with its own origin only when the marker matches the host it runs on; a copy of this document
/// deployed elsewhere, or a page without it, stays a remote client. Only a plain authority is
/// written, so the Host header cannot inject markup, and the response varies by Host so no cache
/// serves one host's marker to another.
async fn serve_entry_document(path: &Path, method: &Method, headers: &HeaderMap) -> Response {
    let document = match tokio::fs::read_to_string(path).await {
        Ok(document) => document,
        Err(_) => return internal_server_error(),
    };
    let document = match served_host(headers) {
        Some(host) => match document.find("</head>") {
            Some(head_end) => format!(
                "{}<meta name=\"bibcode-served-host\" content=\"{host}\">{}",
                &document[..head_end],
                &document[head_end..]
            ),
            None => document,
        },
        None => document,
    };
    let length = document.len();
    let body = if method == Method::HEAD {
        Body::empty()
    } else {
        Body::from(document)
    };
    Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, "text/html")
        .header(CONTENT_LENGTH, length)
        .header(CACHE_CONTROL, HTML_CACHE_CONTROL)
        .header(VARY, "Host")
        .header("x-content-type-options", "nosniff")
        .header("content-security-policy", content_security_policy(headers))
        .body(body)
        .unwrap_or_else(|_| internal_server_error())
}

/// The request's Host as a lowercase authority, when it is nothing else: name, IPv4 or bracketed
/// IPv6 characters and a port.
fn served_host(headers: &HeaderMap) -> Option<String> {
    let host = headers.get(HOST)?.to_str().ok()?;
    let authority = host.parse::<hyper::http::uri::Authority>().ok()?;
    (authority.as_str() == host
        && host.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b':' | b'[' | b']')
        }))
    .then(|| host.to_ascii_lowercase())
}

fn safe_relative_path(request_path: &str) -> Result<PathBuf, ()> {
    let decoded = percent_decode_str(request_path)
        .decode_utf8()
        .map_err(|_| ())?;
    let normalized = decoded.replace('\\', "/");
    let relative = normalized.trim_start_matches('/');
    if relative.contains('\0') || relative.starts_with("..") {
        return Err(());
    }

    let path = if relative.is_empty() {
        Path::new("index.html")
    } else {
        Path::new(relative)
    };
    if path.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return Err(());
    }
    Ok(path.to_path_buf())
}

async fn canonical_file_within(root: &Path, candidate: &Path) -> Option<PathBuf> {
    let canonical = tokio::fs::canonicalize(candidate).await.ok()?;
    if !canonical.starts_with(root) {
        return None;
    }
    let metadata = tokio::fs::metadata(&canonical).await.ok()?;
    metadata.is_file().then_some(canonical)
}

/// Vite emits build outputs into `assetsDir` (`assets/`) as `[name]-[hash].[ext]`
/// with an 8-character base64url hash; `apps/web/public/` files are copied to the
/// static root unhashed. The input is the resolved file's path relative to that root.
fn is_content_hashed_asset(relative: &Path) -> bool {
    let mut components = relative.components();
    let (Some(Component::Normal(directory)), Some(Component::Normal(filename)), None) =
        (components.next(), components.next(), components.next())
    else {
        return false;
    };
    if directory != "assets" {
        return false;
    }
    let filename = Path::new(filename);
    if filename
        .extension()
        .is_none_or(|extension| extension.is_empty())
    {
        return false;
    }
    let Some(stem) = filename.file_stem().and_then(|stem| stem.to_str()) else {
        return false;
    };
    let stem = stem.as_bytes();
    let Some(hash_start) = stem.len().checked_sub(8) else {
        return false;
    };
    hash_start > 0
        && stem[hash_start - 1] == b'-'
        && stem[hash_start..]
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn if_none_match_matches(header: &str, etag: &str) -> bool {
    let header = header.trim();
    let etag = etag.strip_prefix("W/").unwrap_or(etag);
    header == "*"
        || header.split(',').any(|entry| {
            let entry = entry.trim();
            entry.strip_prefix("W/").unwrap_or(entry) == etag
        })
}

/// The UI's policy. Browser mode frames preview gateways on the host the page was
/// loaded from, one port per target, so `frame-src` allows that host on any port.
/// An IPv6 host gets none: the gateway lets no IPv6 page frame it.
fn content_security_policy(headers: &HeaderMap) -> String {
    let gateways = headers
        .get(HOST)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<hyper::http::uri::Authority>().ok())
        .map(|authority| authority.host().to_owned())
        // Only name and IPv4 characters reach the policy (never `;`, `,`, or `[`).
        .filter(|host| {
            host.bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'.' || byte == b'-')
        })
        .map(|host| format!(" http://{host}:*"))
        .unwrap_or_default();
    format!("{CONTENT_SECURITY_POLICY_VALUE}; frame-src 'self'{gateways}")
}

async fn stream_file(
    path: PathBuf,
    content_hashed: bool,
    method: &Method,
    headers: &HeaderMap,
) -> Response {
    let file = match File::open(&path).await {
        Ok(file) => file,
        Err(_) => return internal_server_error(),
    };
    let metadata = match file.metadata().await {
        Ok(metadata) => metadata,
        Err(_) => return internal_server_error(),
    };
    let content_type = mime_guess::from_path(&path).first_or_octet_stream();
    let (cache_control, etag) = if content_type.type_() == mime_guess::mime::TEXT
        && content_type.subtype() == mime_guess::mime::HTML
    {
        (HTML_CACHE_CONTROL, None)
    } else if content_hashed {
        (IMMUTABLE_CACHE_CONTROL, None)
    } else {
        let etag = metadata
            .modified()
            .ok()
            .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
            .map(|modified| {
                format!(
                    "W/\"{:x}-{:x}-{:x}\"",
                    metadata.len(),
                    modified.as_secs(),
                    modified.subsec_nanos()
                )
            });
        ("no-cache", etag)
    };
    let not_modified = etag.as_deref().is_some_and(|etag| {
        headers.get_all(IF_NONE_MATCH).iter().any(|value| {
            value
                .to_str()
                .is_ok_and(|value| if_none_match_matches(value, etag))
        })
    });

    let mut response = Response::builder()
        .status(if not_modified {
            StatusCode::NOT_MODIFIED
        } else {
            StatusCode::OK
        })
        .header(CONTENT_TYPE, content_type.as_ref())
        .header(CONTENT_LENGTH, metadata.len())
        .header(CACHE_CONTROL, cache_control)
        .header("x-content-type-options", "nosniff")
        .header("content-security-policy", content_security_policy(headers));
    if let Some(etag) = etag {
        response = response.header(ETAG, etag);
    }
    let body = if not_modified || method == Method::HEAD {
        Body::empty()
    } else {
        Body::from_stream(ReaderStream::new(file))
    };
    response
        .body(body)
        .unwrap_or_else(|_| internal_server_error())
}

fn request_is_loopback(headers: &HeaderMap) -> bool {
    let Some(host) = headers.get(HOST).and_then(|value| value.to_str().ok()) else {
        return false;
    };
    let host = host.trim().to_ascii_lowercase();
    if host == "localhost" || host.starts_with("localhost:") {
        return true;
    }
    let without_port = host
        .strip_prefix('[')
        .and_then(|value| value.split_once(']').map(|(address, _)| address))
        .or_else(|| host.split_once(':').map(|(address, _)| address))
        .unwrap_or(&host);
    without_port.parse::<IpAddr>().is_ok_and(|address| {
        address == IpAddr::V4(Ipv4Addr::LOCALHOST) || address == IpAddr::V6(Ipv6Addr::LOCALHOST)
    })
}

fn platform_os() -> &'static str {
    match std::env::consts::OS {
        "windows" => "windows",
        "macos" => "darwin",
        "linux" => "linux",
        _ => "unknown",
    }
}

fn platform_arch() -> &'static str {
    match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        _ => "other",
    }
}

fn internal_server_error() -> Response {
    (StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error").into_response()
}

#[cfg(test)]
mod tests {
    use tower::ServiceExt;

    #[test]
    fn the_ui_may_frame_only_its_own_hosts_preview_gateways() {
        let csp = |host: &str| {
            let mut headers = HeaderMap::new();
            headers.insert(HOST, HeaderValue::from_str(host).unwrap());
            super::content_security_policy(&headers)
        };
        assert!(csp("box.lan:3773").ends_with("; frame-src 'self' http://box.lan:*"));
        // The gateway frames no IPv6 host, and a Host that isn't an authority adds nothing.
        for host in [
            "[::1]:3773",
            "box.lan:3773; script-src *",
            "a b",
            "box.lan;x:3773",
        ] {
            assert!(csp(host).ends_with("; frame-src 'self'"), "{host}");
        }
        assert!(super::content_security_policy(&HeaderMap::new()).ends_with("; frame-src 'self'"));
    }

    use super::*;

    /// The web app served by this server says so: its entry document names the host it was
    /// served for, which the app compares with its own before pairing with this server. Nothing
    /// else carries the marker, and a Host that is not a plain authority adds none.
    #[tokio::test]
    async fn the_served_entry_document_names_its_host() {
        let root = tempfile::tempdir().expect("static root");
        std::fs::write(
            root.path().join("index.html"),
            "<!doctype html><html><head><title>BiBCode</title></head><body></body></html>",
        )
        .expect("entry document");
        std::fs::create_dir(root.path().join("assets")).expect("assets");
        std::fs::write(root.path().join("assets/app-AbCd1234.js"), "</head>").expect("asset");
        let serve = |path: &'static str, host: &'static str| {
            let root = root.path().to_path_buf();
            async move {
                let mut headers = HeaderMap::new();
                headers.insert(HOST, HeaderValue::from_static(host));
                let response = serve_static(&root, path, &Method::GET, &headers).await;
                let vary = response.headers().get("vary").cloned();
                let body = axum::body::to_bytes(response.into_body(), usize::MAX)
                    .await
                    .expect("body");
                (String::from_utf8(body.to_vec()).expect("utf-8"), vary)
            }
        };
        for path in ["/", "/pair", "/index.html"] {
            let (body, vary) = serve(path, "Box.LAN:3773").await;
            assert!(
                body.contains(r#"<meta name="bibcode-served-host" content="box.lan:3773"></head>"#),
                "{path}: {body}"
            );
            assert_eq!(
                vary.as_ref().map(|value| value.to_str().unwrap()),
                Some("Host")
            );
        }
        let (body, _) = serve("/", "[::1]:3773").await;
        assert!(body.contains(r#"content="[::1]:3773""#), "{body}");
        for host in [r#"box.lan" onload="x"#, "box.lan:3773/x", "a b"] {
            let (body, _) = serve("/", host).await;
            assert!(!body.contains("bibcode-served-host"), "{host}: {body}");
        }
        let (asset, _) = serve("/assets/app-AbCd1234.js", "box.lan:3773").await;
        assert_eq!(asset, "</head>");
    }

    #[test]
    fn forwarded_host_is_trusted_only_from_a_loopback_peer() {
        let forwarded = || {
            let mut headers = HeaderMap::new();
            headers.insert(HOST, HeaderValue::from_static("127.0.0.1:3773"));
            headers.insert(
                X_FORWARDED_HOST,
                HeaderValue::from_static("bibcode.example.test, inner.proxy"),
            );
            headers.insert(X_FORWARDED_PROTO, HeaderValue::from_static("https"));
            headers
        };
        let local = Some("127.0.0.1:3773".parse().unwrap());
        for loopback in ["127.0.0.1", "::1", "::ffff:127.0.0.1"] {
            let mut headers = forwarded();
            let origin = classify_request(
                &mut headers,
                Some(loopback.parse().unwrap()),
                local,
                |_, _| None,
            );
            assert_eq!(headers[HOST], "bibcode.example.test", "{loopback}");
            assert_eq!(headers[X_FORWARDED_PROTO], "https", "{loopback}");
            assert_eq!(origin.class, RequestClass::LocalProxy, "{loopback}");
            assert_eq!(
                origin.eligible_origin(),
                Some("https://bibcode.example.test")
            );
        }
        for untrusted in [Some("192.168.1.9".parse().unwrap()), None] {
            let mut headers = forwarded();
            let origin = classify_request(&mut headers, untrusted, local, |_, _| None);
            assert_eq!(headers[HOST], "127.0.0.1:3773", "{untrusted:?}");
            assert!(!headers.contains_key(X_FORWARDED_HOST), "{untrusted:?}");
            assert!(!headers.contains_key(X_FORWARDED_PROTO), "{untrusted:?}");
            assert_eq!(origin.eligible_origin(), None, "{untrusted:?}");
        }
    }

    /// Slice R: through the managed tunnel the raw `Host` is the public hostname, so a
    /// client's `X-Forwarded-Host: 127.0.0.1` is dropped and its `Host` kept.
    #[test]
    fn a_tunnel_shaped_request_keeps_its_host_and_drops_injected_forwarded_headers() {
        let mut headers = HeaderMap::new();
        headers.insert(HOST, HeaderValue::from_static("env-1.connect.example"));
        headers.insert(X_FORWARDED_HOST, HeaderValue::from_static("127.0.0.1"));
        headers.insert(X_FORWARDED_PROTO, HeaderValue::from_static("http"));
        let origin = classify_request(
            &mut headers,
            Some("127.0.0.1".parse().unwrap()),
            Some("127.0.0.1:3773".parse().unwrap()),
            |local, host| {
                (local.is_loopback() && host == Some("env-1.connect.example"))
                    .then(|| "env-1.connect.example".to_owned())
            },
        );
        assert_eq!(headers[HOST], "env-1.connect.example");
        assert!(!headers.contains_key(X_FORWARDED_HOST));
        assert!(!headers.contains_key(X_FORWARDED_PROTO));
        assert_eq!(origin.class, RequestClass::ManagedTunnel);
        assert_eq!(origin.source_key, "tunnel");
        assert_eq!(
            origin.eligible_origin(),
            Some("https://env-1.connect.example")
        );
    }

    #[test]
    fn requests_are_classed_direct_only_on_a_loopback_or_bound_host_without_forwarding() {
        let classify = |host: &'static str, peer: &str, local: &str| {
            let mut headers = HeaderMap::new();
            headers.insert(HOST, HeaderValue::from_static(host));
            classify_request(
                &mut headers,
                Some(peer.parse().unwrap()),
                Some(local.parse().unwrap()),
                |_, _| None,
            )
        };
        let local = classify("127.0.0.1:3773", "127.0.0.1", "127.0.0.1:3773");
        assert_eq!(local.class, RequestClass::Direct);
        assert_eq!(local.eligible_origin(), Some("http://127.0.0.1:3773"));
        assert_eq!(
            classify("localhost:3773", "::1", "[::1]:3773").eligible_origin(),
            Some("http://localhost:3773")
        );
        // The bound LAN address is direct, but plain HTTP there serves no OAuth.
        let lan = classify("192.168.1.5:3773", "192.168.1.9", "192.168.1.5:3773");
        assert_eq!(lan.class, RequestClass::Direct);
        assert_eq!(lan.eligible_origin(), None);
        assert_eq!(lan.source_key, "v4:192.168.1.0/24");
        // A LAN peer naming a loopback host is not direct.
        let spoofed = classify("127.0.0.1:3773", "192.168.1.9", "192.168.1.5:3773");
        assert_eq!(spoofed.class, RequestClass::Other);
        // Neither is a preview or any other hostname.
        assert_eq!(
            classify("preview-1.connect.example", "127.0.0.1", "127.0.0.1:3773").class,
            RequestClass::Other
        );
    }

    #[test]
    fn content_hashed_assets_follow_the_vite_output_convention() {
        for (path, expected) in [
            ("assets/index-C0420DUf.js", true),
            ("assets/actionscript-3--17pq3dv.js", true),
            ("assets/react-DV3x_TFi.js", true),
            ("assets/style-AbCd12_-.css", true),
            ("theme-bootstrap.js", false),
            ("favicon.ico", false),
            ("assets/logo.png", false),
            ("nested/assets/index-C0420DUf.js", false),
            ("assets/nested/index-C0420DUf.js", false),
            ("assets/index-C0420DU.js", false),
            ("assets/index-C0420DUff.js", false),
            ("assets/index-C0420DUf", false),
            ("assets/index-C0420DUf.", false),
            ("assets/index-C0420D+f.js", false),
            ("assets/index-C0420Déf.js", false),
            ("/assets/index-C0420DUf.js", false),
            ("index-C0420DUf.js", false),
        ] {
            assert_eq!(is_content_hashed_asset(Path::new(path)), expected, "{path}");
        }
    }

    #[test]
    fn if_none_match_uses_weak_comparison() {
        for (header, etag, expected) in [
            ("\"abc\"", "\"abc\"", true),
            ("W/\"abc\"", "\"abc\"", true),
            ("\"abc\"", "W/\"abc\"", true),
            ("W/\"abc\"", "W/\"abc\"", true),
            (" \"other\", W/\"abc\", \"last\" ", "W/\"abc\"", true),
            ("*", "W/\"abc\"", true),
            (" \t* \t", "W/\"abc\"", true),
            ("\"other\"", "W/\"abc\"", false),
            ("\"ABC\"", "W/\"abc\"", false),
            ("", "W/\"abc\"", false),
            (" \t", "W/\"abc\"", false),
            ("abc", "W/\"abc\"", false),
            ("\"other,*,value\"", "W/\"abc\"", false),
        ] {
            assert_eq!(if_none_match_matches(header, etag), expected, "{header:?}");
        }
    }

    #[tokio::test]
    async fn relay_preview_hosts_are_served_by_the_gateway_not_bibcode_routes() {
        use crate::preview::{
            PreviewManager,
            gateway::{
                proxy::PrincipalCheck,
                registry::gateway_context,
                relay::{RelayHosts, RelayPreviewHosts},
            },
        };

        struct Live;
        impl PrincipalCheck for Live {
            fn session_expiry<'a>(
                &'a self,
                _: &'a str,
            ) -> futures_util::future::BoxFuture<'a, Option<i64>> {
                Box::pin(async { Some(i64::MAX) })
            }
        }

        let relay = RelayHosts::default();
        relay.publish(Some(RelayPreviewHosts {
            hostname: "env.zone.test".into(),
            previews: vec!["env-p1.zone.test".into()],
        }));
        let gateway = PreviewGateway::new(
            "127.0.0.1",
            "devbox",
            gateway_context(Arc::new(Live), vec![1; 32], "session".into()),
            PreviewManager::new(),
            relay,
        );
        let app = Router::new().route("/api", get(|| async { "api" })).layer(
            middleware::from_fn_with_state(Some(gateway.clone()), route_relay_previews),
        );
        let request = |host: &str| {
            let mut request = Request::builder()
                .uri("/api")
                .header(HOST, host)
                .body(Body::empty())
                .unwrap();
            request
                .extensions_mut()
                .insert(ConnectInfo(ConnectionAddrs {
                    peer: "127.0.0.1:50000".parse().unwrap(),
                    local: Some("127.0.0.1:3773".parse().unwrap()),
                }));
            request
        };

        let preview = app
            .clone()
            .oneshot(request("env-p1.zone.test"))
            .await
            .unwrap();
        assert_eq!(
            preview.status(),
            StatusCode::UNAUTHORIZED,
            "a preview hostname with no target gets the gateway's page, not /api"
        );
        let api = app.clone().oneshot(request("env.zone.test")).await.unwrap();
        assert_eq!(
            api.status(),
            StatusCode::OK,
            "the endpoint itself keeps its routes"
        );

        // Through the tunnel over plain HTTP, every relay hostname redirects to HTTPS.
        for host in ["env.zone.test", "env-p1.zone.test"] {
            let mut plain = request(host);
            *plain.uri_mut() = "/api?x=1".parse().unwrap();
            plain
                .headers_mut()
                .insert(X_FORWARDED_PROTO, HeaderValue::from_static("http"));
            let redirected = app.clone().oneshot(plain).await.unwrap();
            assert_eq!(
                redirected.status(),
                StatusCode::PERMANENT_REDIRECT,
                "{host}"
            );
            assert_eq!(
                redirected.headers()[LOCATION],
                format!("https://{host}/api?x=1").as_str()
            );
        }
        let mut lan = request("devbox.lan:3773");
        lan.headers_mut()
            .insert(X_FORWARDED_PROTO, HeaderValue::from_static("http"));
        assert_eq!(
            app.oneshot(lan).await.unwrap().status(),
            StatusCode::OK,
            "other hosts are never redirected"
        );
        gateway.shutdown().await;
    }

    async fn cors_response(
        config: &ServerConfig,
        method: Method,
        origin: Option<&str>,
    ) -> Response {
        let app = Router::new()
            .route("/", get(|| async { StatusCode::OK }))
            .layer(cors_layer(config));
        let mut request = Request::builder().uri("/").method(method.clone());
        if let Some(origin) = origin {
            request = request.header("origin", origin);
        }
        if method == Method::OPTIONS {
            request = request
                .header("access-control-request-method", "POST")
                .header("access-control-request-headers", "authorization");
        }
        app.oneshot(request.body(Body::empty()).expect("CORS request"))
            .await
            .expect("CORS response")
    }

    #[tokio::test]
    async fn cors_normal_mode_preserves_response_headers() {
        let config = ServerConfig::new("unused-cors-test-root");
        for (method, expected) in [
            (Method::GET, vec![("access-control-allow-origin", "*")]),
            (
                Method::OPTIONS,
                vec![
                    (
                        "access-control-allow-headers",
                        "authorization,content-type,b3,traceparent,dpop,idempotency-key,x-bibcode-desktop-bootstrap-token",
                    ),
                    ("access-control-allow-methods", "GET,POST,DELETE,OPTIONS"),
                    ("access-control-allow-origin", "*"),
                    ("access-control-max-age", "600"),
                ],
            ),
        ] {
            let response =
                cors_response(&config, method.clone(), Some("https://client.example.test")).await;
            assert_eq!(response.status(), StatusCode::OK);
            let mut actual = response
                .headers()
                .iter()
                .filter(|(name, _)| {
                    name.as_str().starts_with("access-control-") || name.as_str() == "vary"
                })
                .map(|(name, value)| (name.as_str(), value.to_str().expect("CORS header value")))
                .collect::<Vec<_>>();
            actual.sort_unstable();
            assert_eq!(actual, expected, "{method}");
        }
    }

    async fn assert_dev_cors_origin(method: Method, origin: &str, credentials: bool) {
        let config = ServerConfig::new("unused-cors-test-root")
            .with_dev_url("http://localhost:5733".parse().expect("dev URL"));
        let response = cors_response(&config, method.clone(), Some(origin)).await;
        let headers = response.headers();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            headers.get("access-control-allow-origin"),
            Some(&origin.parse::<axum::http::HeaderValue>().expect("origin")),
            "{method} from {origin}"
        );
        assert_eq!(
            headers
                .get("access-control-allow-credentials")
                .map(|value| value.to_str().expect("credentials header")),
            credentials.then_some("true"),
            "{method} from {origin}"
        );
        assert!(
            headers.get_all("vary").iter().any(|value| {
                value
                    .to_str()
                    .expect("Vary header")
                    .split(',')
                    .any(|name| name.trim().eq_ignore_ascii_case("origin"))
            }),
            "{method} from {origin} must vary by origin"
        );
    }

    #[tokio::test]
    async fn cors_dev_mode_reflects_other_origins_without_credentials_on_get() {
        for origin in [
            "https://random.example.test",
            "http://127.0.0.1:65000",
            "http://localhost:5734",
            "bibcode://other",
            // The desktop app sends a bearer token, and cookies from its origins are refused.
            "bibcode://app",
            "bibcode-dev://app",
            "null",
        ] {
            assert_dev_cors_origin(Method::GET, origin, false).await;
        }
    }

    #[tokio::test]
    async fn cors_dev_mode_reflects_other_origins_without_credentials_on_preflight() {
        for origin in [
            "https://random.example.test",
            "http://127.0.0.1:65000",
            "http://localhost:5734",
            "bibcode://other",
            // The desktop app sends a bearer token, and cookies from its origins are refused.
            "bibcode://app",
            "bibcode-dev://app",
            "null",
        ] {
            assert_dev_cors_origin(Method::OPTIONS, origin, false).await;
        }
    }

    #[tokio::test]
    async fn cors_dev_mode_preserves_credentials_for_the_dev_origin() {
        for method in [Method::GET, Method::OPTIONS] {
            assert_dev_cors_origin(method, "http://localhost:5733", true).await;
        }
    }

    #[tokio::test]
    async fn cors_dev_mode_omits_allow_origin_without_an_origin_header() {
        let config = ServerConfig::new("unused-cors-test-root")
            .with_dev_url("http://localhost:5733".parse().expect("dev URL"));
        for method in [Method::GET, Method::OPTIONS] {
            let response = cors_response(&config, method, None).await;
            assert_eq!(response.status(), StatusCode::OK);
            assert!(
                !response
                    .headers()
                    .contains_key("access-control-allow-origin")
            );
        }
    }

    #[test]
    fn route_helpers_preserve_runtime_methods_and_internal_error_status() {
        assert_eq!(RouteMethod::Delete.as_str(), "DELETE");
        assert_eq!(RouteMethod::Get.as_str(), "GET");
        assert_eq!(RouteMethod::Post.as_str(), "POST");
        assert_eq!(
            route(RouteMethod::Delete, "/runtime"),
            RouteSpec {
                method: "DELETE",
                path: "/runtime",
            }
        );
        assert_eq!(
            internal_server_error().status(),
            StatusCode::INTERNAL_SERVER_ERROR
        );
    }
}
