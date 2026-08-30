use std::{
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    path::{Component, Path, PathBuf},
    sync::Arc,
};

use axum::{
    Json, Router,
    body::Body,
    extract::{ConnectInfo, FromRef, Request, State, WebSocketUpgrade},
    http::{
        HeaderMap, Method, StatusCode, Uri,
        header::{CACHE_CONTROL, CONTENT_LENGTH, CONTENT_TYPE, HOST, LOCATION},
    },
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use percent_encoding::percent_decode_str;
use serde::{Deserialize, Serialize};
use serde_json::json;
use subtle::ConstantTimeEq;
use tokio::fs::File;
use tokio_util::{io::ReaderStream, sync::CancellationToken};
use tower_http::cors::{AllowOrigin, Any, CorsLayer};

use crate::{
    auth,
    config::{ServerConfig, ServerMode},
    maintenance::{
        DESKTOP_MAINTENANCE_TOKEN_HEADER, MAINTENANCE_UPDATE_CANCEL_PATH,
        MAINTENANCE_UPDATE_COMMIT_PATH, MAINTENANCE_UPDATE_PREPARE_PATH,
        MAINTENANCE_UPDATE_STATUS_PATH, MaintenanceError, RpcAdmissionGate, UpdateMaintenance,
        http_mutability,
    },
    production::http_routes::{self, HttpRoutesState},
    remote_update::RemoteUpdateSupport,
    rpc::{
        E2eePreauthAdmission, MAX_E2EE_CIPHERTEXT_BYTES, RpcRegistry, RpcSessionContext,
        run_session,
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
    route(RouteMethod::Post, "/api/auth/websocket-ticket"),
    route(RouteMethod::Post, "/api/auth/pairing-token"),
    route(RouteMethod::Post, "/api/auth/pairing-offer"),
    route(RouteMethod::Post, "/api/auth/pairing-offer/cancel"),
    route(RouteMethod::Get, "/api/auth/share-state"),
    route(RouteMethod::Get, "/api/auth/pairing-links"),
    route(RouteMethod::Post, "/api/auth/pairing-links/revoke"),
    route(RouteMethod::Get, "/api/auth/clients"),
    route(RouteMethod::Post, "/api/auth/clients/revoke"),
    route(RouteMethod::Post, "/api/auth/clients/revoke-others"),
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
    route(RouteMethod::Get, "/api/assets/*"),
    route(RouteMethod::Post, DESKTOP_SHUTDOWN_PATH),
    route(RouteMethod::Post, MAINTENANCE_UPDATE_PREPARE_PATH),
    route(RouteMethod::Post, MAINTENANCE_UPDATE_COMMIT_PATH),
    route(RouteMethod::Post, MAINTENANCE_UPDATE_CANCEL_PATH),
    route(RouteMethod::Get, MAINTENANCE_UPDATE_STATUS_PATH),
    route(RouteMethod::Post, "/mcp"),
    route(RouteMethod::Delete, "/mcp"),
    route(RouteMethod::Get, "*"),
];

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
        .layer(cors)
        .with_state(state)
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
    let mut origins = Vec::new();
    if let Ok(origin) = dev_url.origin().ascii_serialization().parse() {
        origins.push(origin);
    }
    for origin in ["bibcode://app", "bibcode-dev://app"] {
        if let Ok(origin) = origin.parse() {
            origins.push(origin);
        }
    }
    layer
        .allow_origin(AllowOrigin::list(origins))
        .allow_credentials(true)
}

async fn websocket(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    upgrade: WebSocketUpgrade,
) -> Response {
    let session_shutdown = state.shutdown.child_token();
    if state.config.unsafe_no_auth {
        return upgrade
            .max_frame_size(MAX_PLAIN_WEBSOCKET_FRAME_BYTES)
            .max_message_size(MAX_PLAIN_WEBSOCKET_MESSAGE_BYTES)
            .on_upgrade(move |socket| {
                run_session(
                    socket,
                    state.rpc_registry,
                    RpcSessionContext::unauthenticated(),
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
            let rpc_context = RpcSessionContext::authenticated(principal, auth.clone());
            upgrade
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
    peer: Result<ConnectInfo<SocketAddr>, axum::extract::rejection::ExtensionRejection>,
    upgrade: WebSocketUpgrade,
) -> Response {
    let session_shutdown = state.shutdown.child_token();
    let peer_ip = peer
        .ok()
        .map(|ConnectInfo(address)| address.ip())
        .unwrap_or(IpAddr::V4(Ipv4Addr::UNSPECIFIED));
    let preauth_admission = state.e2ee_preauth_admission;
    upgrade
        .max_frame_size(MAX_E2EE_CIPHERTEXT_BYTES)
        .max_message_size(MAX_E2EE_CIPHERTEXT_BYTES)
        .on_upgrade(move |socket| {
            crate::rpc::run_e2ee_session(
                socket,
                peer_ip,
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
        remote_update_support: config.remote_update_support,
        remote_protocol_version: REMOTE_PROTOCOL_VERSION,
        min_compatible_remote_protocol: MIN_COMPATIBLE_REMOTE_PROTOCOL,
        capabilities: EnvironmentCapabilities {
            repository_identity: true,
            remote_update_control: true,
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
    if method != Method::GET {
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
    serve_static(static_dir, uri.path()).await
}

async fn serve_static(static_dir: &Path, request_path: &str) -> Response {
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
    stream_file(candidate).await
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

async fn stream_file(path: PathBuf) -> Response {
    let file = match File::open(&path).await {
        Ok(file) => file,
        Err(_) => return internal_server_error(),
    };
    let length = match file.metadata().await {
        Ok(metadata) => metadata.len(),
        Err(_) => return internal_server_error(),
    };
    let content_type = mime_guess::from_path(&path).first_or_octet_stream();
    let cache_control = if content_type.type_() == mime_guess::mime::TEXT
        && content_type.subtype() == mime_guess::mime::HTML
    {
        HTML_CACHE_CONTROL
    } else {
        IMMUTABLE_CACHE_CONTROL
    };
    let body = Body::from_stream(ReaderStream::new(file));

    Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, content_type.as_ref())
        .header(CONTENT_LENGTH, length)
        .header(CACHE_CONTROL, cache_control)
        .header("x-content-type-options", "nosniff")
        .header("content-security-policy", CONTENT_SECURITY_POLICY_VALUE)
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
    use super::*;

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
