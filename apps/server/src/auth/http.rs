use std::{
    collections::HashMap,
    time::{Duration, UNIX_EPOCH},
};

use axum::{
    Extension, Form, Json, Router,
    body::Bytes,
    extract::{FromRequest, State},
    http::{HeaderMap, Method, StatusCode, Uri, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde_json::json;
use uuid::Uuid;

use super::{
    consent_page,
    model::{
        ACCESS_TOKEN_TYPE, ApproveMcpAuthorizationRequest, BOOTSTRAP_TOKEN_TYPE,
        BrowserSessionRequest, BrowserSessionResult, CancelPairingOfferRequest, ClientMetadata,
        CreatePairingOfferRequest, CreatePairingRequest, DenyMcpAuthorizationRequest,
        McpAccessRequest, PairingOfferResult, RevokeClientRequest, RevokePairingRequest,
        SCOPE_ACCESS_READ, SCOPE_ACCESS_WRITE, TOKEN_GRANT_TYPE, TokenExchangeRequest,
        WebSocketTicketResult,
    },
    oauth,
    pairing_code::{
        REMOTE_PAIRING_CODE_VERSION, RemotePairingCodePayload, RemotePairingReach,
        encode_pairing_code,
    },
    pairing_offer::validate_pairing_offer_input,
    service::{
        AuthError, AuthService, McpAccessChange, McpOAuthMint, McpOAuthRefresh, McpOAuthTokens,
        PairingOfferIssuance, PairingOfferReplay, PairingOfferReservation, default_standard_scopes,
        format_iso, now_ms, parse_scopes,
    },
};
use crate::{
    http::{AppState, RequestOrigin},
    persistence::{
        McpOAuthAdmission, McpOAuthClient, McpOAuthDecision, McpOAuthRefreshRotation,
        NewMcpOAuthAuthorization,
    },
};

const CREDENTIAL_HEADERS: [(&str, &str); 2] =
    [("cache-control", "no-store"), ("pragma", "no-cache")];
const MAX_PAIRING_OFFER_IDEMPOTENCY_KEY_BYTES: usize = 128;

pub(crate) fn add_routes(router: Router<AppState>) -> Router<AppState> {
    router
        .route("/api/auth/session", get(session))
        .route("/api/auth/browser-session", post(browser_session))
        .route("/oauth/token", post(token))
        .route("/api/auth/websocket-ticket", post(websocket_ticket))
        .route("/api/auth/pairing-token", post(pairing_token))
        .route("/api/auth/pairing-offer", post(create_pairing_offer))
        .route("/api/auth/pairing-offer/cancel", post(cancel_pairing_offer))
        .route("/api/auth/share-state", get(share_state))
        .route("/api/auth/pairing-links", get(pairing_links))
        .route("/api/auth/pairing-links/revoke", post(revoke_pairing_link))
        .route("/api/auth/clients", get(clients))
        .route("/api/auth/clients/revoke", post(revoke_client))
        .route("/api/auth/clients/mcp-access", post(set_mcp_access))
        .route(
            "/api/auth/clients/revoke-others",
            post(revoke_other_clients),
        )
        .route(
            "/api/auth/mcp-authorizations/approve",
            post(approve_mcp_authorization),
        )
        .route(
            "/api/auth/mcp-authorizations/deny",
            post(deny_mcp_authorization),
        )
        .route(
            PROTECTED_RESOURCE_METADATA_PATH,
            get(protected_resource_metadata),
        )
        .route(
            PROTECTED_RESOURCE_ROOT_METADATA_PATH,
            get(protected_resource_metadata),
        )
        .route(
            AUTHORIZATION_SERVER_METADATA_PATH,
            get(authorization_server_metadata),
        )
        .route("/oauth/register", post(register_client))
        .route("/oauth/authorize", get(authorize))
        .route("/oauth/authorize/status", get(authorize_status))
}

async fn session(State(state): State<AppState>, headers: HeaderMap, uri: Uri) -> Response {
    let auth = &state.auth;
    let descriptor = auth.descriptor();
    match authenticate_request(auth, &headers, &uri).await {
        Ok(principal) => Json(json!({
            "authenticated": true,
            "auth": descriptor,
            "scopes": principal.scopes,
            "sessionMethod": principal.method,
            "expiresAt": format_iso(principal.expires_at_ms),
        }))
        .into_response(),
        Err(AuthError::MissingCredential | AuthError::InvalidCredential) => Json(json!({
            "authenticated": false,
            "auth": descriptor,
        }))
        .into_response(),
        Err(error) => HttpAuthError::new(error, "internal_error").into_response(),
    }
}

async fn browser_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<BrowserSessionRequest>,
) -> Response {
    let response = match state
        .auth
        .create_browser_session(
            payload.credential.trim(),
            client_metadata(&headers, None),
            super::SessionTransport::Plain,
        )
        .await
    {
        Ok(issued) => {
            let expires = UNIX_EPOCH
                + Duration::from_millis(
                    u64::try_from(issued.principal.expires_at_ms).unwrap_or_default(),
                );
            let cookie = format!(
                "{}={}; Path=/; Expires={}; HttpOnly; SameSite=Lax",
                state.auth.cookie_name(),
                issued.token,
                httpdate::fmt_http_date(expires)
            );
            let result = BrowserSessionResult {
                authenticated: true,
                scopes: issued.principal.scopes,
                session_method: issued.principal.method,
                expires_at: format_iso(issued.principal.expires_at_ms),
            };
            let mut response = Json(result).into_response();
            if let Ok(value) = header::HeaderValue::from_str(&cookie) {
                response.headers_mut().insert(header::SET_COOKIE, value);
            }
            response
        }
        Err(error) => HttpAuthError::new(error, "browser_session_issuance_failed").into_response(),
    };
    credential_response(response)
}

/// The RFC 8693 exchange, as `POST /oauth/token` has always served it.
async fn exchange_token(
    state: &AppState,
    headers: &HeaderMap,
    uri: &Uri,
    payload: TokenExchangeRequest,
) -> Response {
    let uses_dpop = headers.contains_key("dpop");
    let response = token_inner(&state.auth, headers, uri, payload)
        .await
        .unwrap_or_else(|error| {
            HttpAuthError::new(error, "access_token_issuance_failed").into_response()
        });
    let response = credential_response(response);
    if uses_dpop {
        dpop_challenge_on_unauthorized(response)
    } else {
        response
    }
}

async fn token_inner(
    auth: &AuthService,
    headers: &HeaderMap,
    uri: &Uri,
    payload: TokenExchangeRequest,
) -> Result<Response, AuthError> {
    if payload.grant_type != TOKEN_GRANT_TYPE
        || payload.subject_token_type != BOOTSTRAP_TOKEN_TYPE
        || payload.requested_token_type != ACCESS_TOKEN_TYPE
        || payload.subject_token.trim().is_empty()
    {
        return Err(AuthError::InvalidCredential);
    }
    let requested_scopes = payload.scope.as_deref().map(parse_scopes).transpose()?;
    if payload
        .client_device_type
        .as_deref()
        .is_some_and(|value| !is_device_type(value))
        || payload
            .client_label
            .as_deref()
            .is_some_and(|value| value.trim().is_empty())
        || payload
            .client_os
            .as_deref()
            .is_some_and(|value| value.trim().is_empty())
    {
        return Err(AuthError::InvalidScope);
    }
    let presented = ClientMetadata {
        label: non_empty(payload.client_label),
        device_type: payload
            .client_device_type
            .filter(|value| is_device_type(value))
            .unwrap_or_else(|| infer_device_type(headers).to_owned()),
        os: non_empty(payload.client_os).or_else(|| infer_os(headers).map(str::to_owned)),
        ..client_metadata(headers, None)
    };
    let proof_key_thumbprint = match headers.get("dpop") {
        Some(proof) => {
            let proof = proof.to_str().map_err(|_| AuthError::InvalidCredential)?;
            Some(
                auth.verify_dpop(proof, "POST", &request_url(headers, uri)?, None, None)
                    .await?,
            )
        }
        None => None,
    };
    let issued = auth
        .exchange_bootstrap(
            payload.subject_token.trim(),
            requested_scopes,
            presented,
            proof_key_thumbprint,
            super::SessionTransport::Plain,
        )
        .await?;
    let expires_in = ((issued.principal.expires_at_ms - now_ms()) / 1_000).max(0);
    Ok(Json(super::model::AccessTokenResult {
        access_token: issued.token,
        issued_token_type: ACCESS_TOKEN_TYPE,
        token_type: if issued.principal.proof_key_thumbprint.is_some() {
            "DPoP"
        } else {
            "Bearer"
        },
        expires_in,
        scope: issued.principal.scopes.join(" "),
    })
    .into_response())
}

async fn websocket_ticket(State(state): State<AppState>, headers: HeaderMap, uri: Uri) -> Response {
    let response = match authenticate_request(&state.auth, &headers, &uri).await {
        Ok(principal) => match state.auth.issue_websocket_ticket(&principal) {
            Ok((ticket, expires_at)) => Json(WebSocketTicketResult {
                ticket,
                expires_at: format_iso(expires_at),
            })
            .into_response(),
            Err(error) => {
                HttpAuthError::new(error, "websocket_ticket_issuance_failed").into_response()
            }
        },
        Err(error) => {
            let response =
                HttpAuthError::new(error, "websocket_ticket_issuance_failed").into_response();
            if request_uses_dpop(&headers) {
                dpop_challenge_on_unauthorized(response)
            } else {
                response
            }
        }
    };
    credential_response(response)
}

async fn pairing_token(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    Json(payload): Json<CreatePairingRequest>,
) -> Response {
    let result = async {
        let principal = authenticate_request(&state.auth, &headers, &uri).await?;
        require_scope(&principal, SCOPE_ACCESS_WRITE)?;
        if payload
            .label
            .as_deref()
            .is_some_and(|value| value.trim().is_empty())
        {
            return Err(AuthError::InvalidScope);
        }
        let scopes = payload.scopes.unwrap_or_else(default_standard_scopes);
        if scopes.is_empty()
            || scopes
                .iter()
                .any(|scope| !super::model::ALL_SCOPES.contains(&scope.as_str()))
            || scopes
                .iter()
                .collect::<std::collections::HashSet<_>>()
                .len()
                != scopes.len()
        {
            return Err(AuthError::InvalidScope);
        }
        for scope in &scopes {
            if !principal.has_scope(scope) {
                return Err(AuthError::ScopeRequired(scope.clone()));
            }
        }
        state
            .auth
            .issue_pairing(scopes, non_empty(payload.label))
            .await
    }
    .await;
    match result {
        Ok(result) => Json(result).into_response(),
        Err(error) => auth_error_for_request(error, &headers, "pairing_credential_issuance_failed"),
    }
}

async fn create_pairing_offer(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    Json(payload): Json<CreatePairingOfferRequest>,
) -> Response {
    let principal =
        match authenticated_with_scope(&state.auth, &headers, &uri, SCOPE_ACCESS_WRITE).await {
            Ok(principal) => principal,
            Err(error) => {
                return auth_error_for_request(error, &headers, "pairing_offer_issuance_failed");
            }
        };
    let idempotency_key = match headers.get("idempotency-key") {
        Some(value) => {
            let Ok(value) = value.to_str() else {
                return invalid_pairing_offer_response("idempotency key must be valid text");
            };
            let key = value.trim();
            if !is_valid_pairing_offer_idempotency_key(key) {
                return invalid_pairing_offer_response("idempotency key is invalid");
            }
            Some(key.to_owned())
        }
        None => None,
    };
    let input_fingerprint = format!(
        "{}\n{}\n{}\n{:?}\n{:?}",
        payload.name.trim(),
        payload.endpoint.trim(),
        payload.reach,
        payload.label,
        payload.scopes,
    );
    let _offer_guard = if idempotency_key.is_some() {
        Some(state.auth.lock_pairing_offer_issuance().await)
    } else {
        None
    };
    if let Some(key) = &idempotency_key {
        match state
            .auth
            .replay_pairing_offer(&principal.session_id, key, &input_fingerprint)
            .await
        {
            Ok(PairingOfferReplay::Original(original)) => return Json(original).into_response(),
            Ok(PairingOfferReplay::Cancelled) => {
                return invalid_pairing_offer_response("idempotency key was cancelled");
            }
            Ok(PairingOfferReplay::Conflict) => {
                return invalid_pairing_offer_response(
                    "idempotency key was already used with a different input",
                );
            }
            Ok(PairingOfferReplay::Fresh) => {}
            Err(error) => {
                return auth_error_for_request(error, &headers, "pairing_offer_issuance_failed");
            }
        }
    }

    let validated = match validate_pairing_offer_input(
        &payload.name,
        &payload.endpoint,
        &payload.reach,
        payload.label.as_deref(),
    ) {
        Ok(validated) => validated,
        Err(error) => return invalid_pairing_offer_response(&error.to_string()),
    };
    let name = validated.name.clone();
    let label = validated.label.clone();
    let off_host = validated.off_host;
    let scopes = payload.scopes.unwrap_or_else(default_standard_scopes);
    if scopes.is_empty()
        || scopes
            .iter()
            .any(|scope| !super::model::ALL_SCOPES.contains(&scope.as_str()))
        || scopes
            .iter()
            .collect::<std::collections::HashSet<_>>()
            .len()
            != scopes.len()
        || !scopes.iter().all(|scope| principal.has_scope(scope))
    {
        return invalid_pairing_offer_response("requested scope exceeds the caller's grant");
    }
    let Some(storage_instance_id) = state.config.storage_instance_id else {
        return auth_error_for_request(
            AuthError::Internal("storage identity is unavailable".to_owned()),
            &headers,
            "pairing_offer_issuance_failed",
        );
    };
    let issued = if let Some(key) = &idempotency_key {
        match state
            .auth
            .issue_share_pairing_offer(
                scopes,
                Some(label),
                payload.reach.clone(),
                off_host,
                PairingOfferReservation::new(
                    principal.session_id.clone(),
                    key.clone(),
                    input_fingerprint.clone(),
                ),
            )
            .await
        {
            Ok(PairingOfferIssuance::Reserved(issued)) => issued,
            Ok(PairingOfferIssuance::Replay(PairingOfferReplay::Original(original))) => {
                return Json(original).into_response();
            }
            Ok(PairingOfferIssuance::Replay(PairingOfferReplay::Cancelled)) => {
                return invalid_pairing_offer_response("idempotency key was cancelled");
            }
            Ok(PairingOfferIssuance::Replay(PairingOfferReplay::Conflict)) => {
                return invalid_pairing_offer_response(
                    "idempotency key was already used with a different input",
                );
            }
            Ok(PairingOfferIssuance::Replay(PairingOfferReplay::Fresh)) => {
                return auth_error_for_request(
                    AuthError::Internal("pairing offer reservation disappeared".to_owned()),
                    &headers,
                    "pairing_offer_issuance_failed",
                );
            }
            Err(error) => {
                return auth_error_for_request(error, &headers, "pairing_offer_issuance_failed");
            }
        }
    } else {
        match state
            .auth
            .issue_share_pairing(scopes, Some(label), payload.reach.clone(), off_host)
            .await
        {
            Ok(issued) => issued,
            Err(error) => {
                return auth_error_for_request(error, &headers, "pairing_offer_issuance_failed");
            }
        }
    };
    let code_payload = RemotePairingCodePayload {
        v: REMOTE_PAIRING_CODE_VERSION,
        endpoint: validated.endpoint.clone(),
        name: name.clone(),
        token: issued.credential.clone(),
        host_key: state.auth.host_identity().public_key_base64url(),
        reach: match payload.reach.as_str() {
            "this-computer" => RemotePairingReach::ThisComputer,
            "another-device" => RemotePairingReach::AnotherDevice,
            _ => RemotePairingReach::Custom,
        },
        storage_instance_id: storage_instance_id.to_string(),
    };
    let code = match encode_pairing_code(&code_payload) {
        Ok(code) => code,
        Err(error) => {
            if let Some(key) = &idempotency_key {
                let _ = state
                    .auth
                    .cancel_pairing_offer(&principal.session_id, key.clone())
                    .await;
            } else {
                let _ = state.auth.revoke_pairing(&issued.id).await;
            }
            return auth_error_for_request(
                AuthError::Internal(format!("pairing code encoding failed: {error}")),
                &headers,
                "pairing_offer_issuance_failed",
            );
        }
    };
    let result = PairingOfferResult {
        id: issued.id,
        code,
        reach: payload.reach,
        endpoint: code_payload.endpoint,
        name,
        expires_at: issued.expires_at,
    };
    if let Some(key) = idempotency_key
        && let Err(error) = state
            .auth
            .record_pairing_offer(
                &principal.session_id,
                key.clone(),
                input_fingerprint,
                result.clone(),
            )
            .await
    {
        let _ = state
            .auth
            .cancel_pairing_offer(&principal.session_id, key.clone())
            .await;
        return auth_error_for_request(error, &headers, "pairing_offer_issuance_failed");
    }
    Json(result).into_response()
}

async fn cancel_pairing_offer(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    Json(payload): Json<CancelPairingOfferRequest>,
) -> Response {
    let principal = match authenticated_with_scope(&state.auth, &headers, &uri, SCOPE_ACCESS_WRITE)
        .await
    {
        Ok(principal) => principal,
        Err(error) => {
            return auth_error_for_request(error, &headers, "pairing_offer_cancellation_failed");
        }
    };
    let key = payload.idempotency_key.trim();
    if !is_valid_pairing_offer_idempotency_key(key) {
        return invalid_pairing_offer_response("idempotency key is invalid");
    }
    let _offer_guard = state.auth.lock_pairing_offer_issuance().await;
    match state
        .auth
        .cancel_pairing_offer(&principal.session_id, key.to_owned())
        .await
    {
        Ok(cancelled) => Json(json!({ "cancelled": cancelled })).into_response(),
        Err(error) => auth_error_for_request(error, &headers, "pairing_offer_cancellation_failed"),
    }
}

fn invalid_pairing_offer_response(detail: &str) -> Response {
    let trace_id = Uuid::new_v4().to_string();
    tracing::debug!(target: "bibcode_server::auth", %trace_id, "invalid pairing offer: {detail}");
    error_response(
        StatusCode::BAD_REQUEST,
        "EnvironmentRequestInvalidError",
        json!({
            "code": "invalid_request",
            "reason": "invalid_pairing_offer",
            "traceId": trace_id,
        }),
    )
}

fn is_valid_pairing_offer_idempotency_key(key: &str) -> bool {
    !key.is_empty() && key.len() <= MAX_PAIRING_OFFER_IDEMPOTENCY_KEY_BYTES
}

async fn pairing_links(State(state): State<AppState>, headers: HeaderMap, uri: Uri) -> Response {
    match authenticated_with_scope(&state.auth, &headers, &uri, SCOPE_ACCESS_READ).await {
        Ok(_) => Json(state.auth.list_pairings().await).into_response(),
        Err(error) => auth_error_for_request(error, &headers, "pairing_links_load_failed"),
    }
}

async fn share_state(State(state): State<AppState>, headers: HeaderMap, uri: Uri) -> Response {
    match authenticated_with_scope(&state.auth, &headers, &uri, SCOPE_ACCESS_READ).await {
        Ok(_) => Json(state.auth.share_exposure_state().await).into_response(),
        Err(error) => auth_error_for_request(error, &headers, "share_state_load_failed"),
    }
}

async fn revoke_pairing_link(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    Json(payload): Json<RevokePairingRequest>,
) -> Response {
    match authenticated_with_scope(&state.auth, &headers, &uri, SCOPE_ACCESS_WRITE).await {
        Ok(_) => match state.auth.revoke_pairing(&payload.id).await {
            Ok(revoked) => Json(json!({ "revoked": revoked })).into_response(),
            Err(error) => auth_error_for_request(error, &headers, "pairing_link_revoke_failed"),
        },
        Err(error) => auth_error_for_request(error, &headers, "pairing_link_revoke_failed"),
    }
}

async fn clients(State(state): State<AppState>, headers: HeaderMap, uri: Uri) -> Response {
    match authenticated_with_scope(&state.auth, &headers, &uri, SCOPE_ACCESS_READ).await {
        Ok(principal) => Json(state.auth.list_clients(&principal.session_id).await).into_response(),
        Err(error) => auth_error_for_request(error, &headers, "client_sessions_load_failed"),
    }
}

async fn revoke_client(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    Json(payload): Json<RevokeClientRequest>,
) -> Response {
    match authenticated_with_scope(&state.auth, &headers, &uri, SCOPE_ACCESS_WRITE).await {
        Ok(principal) => {
            // Stop answers with how its interrupts went (#139, slice X1).
            let answer = if payload.interrupt_turns {
                state
                    .auth
                    .stop_client(&principal.session_id, &payload.session_id)
                    .await
                    .map(|stopped| {
                        if stopped.failed > 0 || stopped.timed_out {
                            tracing::warn!(
                                failed = stopped.failed,
                                timed_out = stopped.timed_out,
                                "MCP Stop did not interrupt every turn"
                            );
                        }
                        json!({
                            "revoked": stopped.revoked,
                            "interrupted": stopped.interrupted,
                            "failed": stopped.failed,
                            "timedOut": stopped.timed_out,
                        })
                    })
            } else {
                state
                    .auth
                    .revoke_client(&principal.session_id, &payload.session_id)
                    .await
                    .map(|revoked| json!({ "revoked": revoked }))
            };
            match answer {
                Ok(answer) => Json(answer).into_response(),
                Err(error) => {
                    auth_error_for_request(error, &headers, "client_session_revoke_failed")
                }
            }
        }
        Err(error) => auth_error_for_request(error, &headers, "client_session_revoke_failed"),
    }
}

/// **Take over** and **Hand back** for an outside agent (#139, slice X1).
async fn set_mcp_access(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    Json(payload): Json<McpAccessRequest>,
) -> Response {
    let principal =
        match authenticated_with_scope(&state.auth, &headers, &uri, SCOPE_ACCESS_WRITE).await {
            Ok(principal) => principal,
            Err(error) => {
                return auth_error_for_request(error, &headers, "client_mcp_access_failed");
            }
        };
    // Every refusal is one typed 400; the log line says which.
    let refused = |why: &str| {
        tracing::warn!(why, "an MCP access change was refused");
        error_response(
            StatusCode::BAD_REQUEST,
            "EnvironmentRequestInvalidError",
            json!({
                "code": "invalid_request",
                "reason": "invalid_mcp_access",
                "traceId": Uuid::new_v4().to_string(),
            }),
        )
    };
    if principal.session_id == payload.session_id {
        return refused("not-an-agent");
    }
    match state
        .auth
        .set_mcp_access(&payload.session_id, &payload.access)
        .await
    {
        Ok(McpAccessChange::Changed) => {
            Json(json!({ "sessionId": payload.session_id, "access": payload.access }))
                .into_response()
        }
        Ok(McpAccessChange::NotFound) => refused("not-found"),
        Ok(McpAccessChange::NotAnAgent) => refused("not-an-agent"),
        Ok(McpAccessChange::InvalidAccess) => refused("invalid-level"),
        Ok(McpAccessChange::NotTheHandBack) => refused("not-the-hand-back-level"),
        Err(error) => {
            tracing::warn!(?error, "an MCP access change failed");
            auth_error_for_request(error, &headers, "client_mcp_access_failed")
        }
    }
}

async fn revoke_other_clients(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
) -> Response {
    match authenticated_with_scope(&state.auth, &headers, &uri, SCOPE_ACCESS_WRITE).await {
        Ok(principal) => match state.auth.revoke_other_clients(&principal.session_id).await {
            Ok(revoked_count) => Json(json!({ "revokedCount": revoked_count })).into_response(),
            Err(error) => auth_error_for_request(error, &headers, "client_session_revoke_failed"),
        },
        Err(error) => auth_error_for_request(error, &headers, "client_session_revoke_failed"),
    }
}

// ---------------------------------------------------------------------------------------------
// Remote Streamable HTTP's authorization server (#139, slice R). Every route answers 404 on
// an origin that is not eligible (see `RequestOrigin::eligible_origin`). Secrets (codes,
// refresh tokens, the status cookie) never reach a log line, a URL other than the client's
// own redirect, or the profiler.
// ---------------------------------------------------------------------------------------------

/// RFC 9728 metadata for `/mcp`, where the 401 challenge points.
pub(crate) const PROTECTED_RESOURCE_METADATA_PATH: &str =
    "/.well-known/oauth-protected-resource/mcp";
/// The same metadata at the root, which clients try next.
pub(crate) const PROTECTED_RESOURCE_ROOT_METADATA_PATH: &str =
    "/.well-known/oauth-protected-resource";
/// RFC 8414 metadata.
pub(crate) const AUTHORIZATION_SERVER_METADATA_PATH: &str =
    "/.well-known/oauth-authorization-server";
const MAX_REGISTRATION_BYTES: usize = 16 * 1024;
const MAX_TOKEN_FORM_BYTES: usize = 16 * 1024;
const AUTHORIZATION_CODE_GRANT: &str = "authorization_code";
const REFRESH_TOKEN_GRANT: &str = "refresh_token";

fn not_found() -> Response {
    StatusCode::NOT_FOUND.into_response()
}

fn no_store(mut response: Response) -> Response {
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("no-store"),
    );
    response
}

/// An OAuth error body (RFC 6749 §5.2), `no-store`.
fn oauth_error(status: StatusCode, error: &'static str, description: &str) -> Response {
    credential_response(
        (
            status,
            Json(json!({ "error": error, "error_description": description })),
        )
            .into_response(),
    )
}

async fn protected_resource_metadata(
    State(state): State<AppState>,
    Extension(origin): Extension<RequestOrigin>,
) -> Response {
    let Some(origin) = origin.eligible_origin() else {
        return not_found();
    };
    if state.auth.oauth_repositories().is_none() {
        return not_found();
    }
    let settings = state.auth.mcp_oauth_settings();
    no_store(
        Json(oauth::protected_resource_metadata(
            origin,
            &settings,
            &state.config.environment_label,
        ))
        .into_response(),
    )
}

async fn authorization_server_metadata(
    State(state): State<AppState>,
    Extension(origin): Extension<RequestOrigin>,
) -> Response {
    let Some(origin) = origin.eligible_origin() else {
        return not_found();
    };
    if state.auth.oauth_repositories().is_none() {
        return not_found();
    }
    let settings = state.auth.mcp_oauth_settings();
    no_store(Json(oauth::authorization_server_metadata(origin, &settings)).into_response())
}

/// `POST /oauth/register` (RFC 7591): public clients only, under the per-source and global
/// admission limits.
async fn register_client(
    State(state): State<AppState>,
    Extension(origin): Extension<RequestOrigin>,
    body: Bytes,
) -> Response {
    if origin.eligible_origin().is_none() {
        return not_found();
    }
    let Some(repositories) = state.auth.oauth_repositories() else {
        return not_found();
    };
    if body.len() > MAX_REGISTRATION_BYTES {
        return oauth_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "invalid_client_metadata",
            "The registration is too large.",
        );
    }
    let Ok(metadata) = serde_json::from_slice::<serde_json::Value>(&body) else {
        return oauth_error(
            StatusCode::BAD_REQUEST,
            "invalid_client_metadata",
            "The registration must be JSON.",
        );
    };
    let registration = match oauth::validate_registration(&metadata) {
        Ok(registration) => registration,
        Err(refusal) => {
            tracing::warn!(
                error = refusal.error,
                "an MCP client registration was refused"
            );
            return oauth_error(StatusCode::BAD_REQUEST, refusal.error, refusal.description);
        }
    };
    let Ok(secret) = oauth::random_secret() else {
        return oauth_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "server_error",
            "BiBCode could not register this client.",
        );
    };
    let client_id = format!("mcp-{}", &secret[..22]);
    let now = now_ms();
    let admission = repositories
        .register_mcp_oauth_client(
            McpOAuthClient {
                client_id: client_id.clone(),
                client_name: registration.client_name.clone(),
                redirect_uris: registration.redirect_uris.clone(),
                source_key: origin.source_key.clone(),
                created_at_ms: now,
                approved_at_ms: None,
                last_used_at_ms: None,
            },
            now,
            oauth::LIMITS,
        )
        .await;
    match admission {
        Ok(McpOAuthAdmission::Admitted) => {}
        Ok(McpOAuthAdmission::Refused) => {
            tracing::warn!(
                class = ?origin.class,
                "an MCP client registration was refused: too many from one source"
            );
            return oauth_error(
                StatusCode::TOO_MANY_REQUESTS,
                "temporarily_unavailable",
                "Too many clients registered from here in the last hour. Try again later.",
            );
        }
        Err(error) => {
            tracing::warn!(%error, "an MCP client registration failed");
            return oauth_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "server_error",
                "BiBCode could not register this client.",
            );
        }
    }
    credential_response(
        (
            StatusCode::CREATED,
            Json(json!({
                "client_id": client_id,
                "client_id_issued_at": now / 1_000,
                "client_name": registration.client_name,
                "redirect_uris": registration.redirect_uris,
                "token_endpoint_auth_method": "none",
                "grant_types": [AUTHORIZATION_CODE_GRANT, REFRESH_TOKEN_GRANT],
                "response_types": ["code"],
            })),
        )
            .into_response(),
    )
}

fn query_pairs(uri: &Uri) -> HashMap<String, String> {
    let mut pairs = HashMap::new();
    for (name, value) in url::form_urlencoded::parse(uri.query().unwrap_or_default().as_bytes()) {
        // A repeated parameter is ambiguous; the first one counts, as most servers do.
        pairs
            .entry(name.into_owned())
            .or_insert_with(|| value.into_owned());
    }
    pairs
}

/// The cookie that binds one authorization's poll to the browser that opened it.
fn status_cookie_name(id: &str) -> String {
    format!("{}_{}", oauth::STATUS_COOKIE, id)
}

fn status_url(id: &str) -> String {
    format!("/oauth/authorize/status?id={id}")
}

fn admitted_mutation(state: &AppState, route: &str) -> Option<crate::maintenance::RpcPermit> {
    state
        .admission_gate
        .admit_named(
            crate::maintenance::RpcMutability::Mutation,
            format!("HTTP GET {route}"),
        )
        .ok()
}

/// `GET /oauth/authorize`: checks the client and its redirect URI before it would redirect
/// anywhere, then the request, then records a pending authorization and shows the consent
/// page.
async fn authorize(
    State(state): State<AppState>,
    Extension(origin): Extension<RequestOrigin>,
    uri: Uri,
) -> Response {
    let Some(origin_value) = origin.eligible_origin().map(str::to_owned) else {
        return not_found();
    };
    let Some(repositories) = state.auth.oauth_repositories() else {
        return not_found();
    };
    let start_again = "Start sign-in again from your AI tool.";
    let params = query_pairs(&uri);
    let client = match params.get("client_id") {
        Some(client_id) => repositories.get_mcp_oauth_client(client_id.clone()).await,
        None => Ok(None),
    };
    let client = match client {
        Ok(Some(client)) => client,
        Ok(None) => {
            tracing::warn!("an MCP authorization named an unknown client");
            return consent_page::message(
                StatusCode::BAD_REQUEST,
                "Unknown AI tool",
                &format!("This sign-in link names an AI tool BiBCode does not know. {start_again}"),
            );
        }
        Err(error) => {
            tracing::warn!(%error, "an MCP authorization could not read its client");
            return consent_page::message(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Sign-in failed",
                &format!("BiBCode could not read this request. {start_again}"),
            );
        }
    };
    let redirect_uri = params.get("redirect_uri").cloned().unwrap_or_default();
    if !client
        .redirect_uris
        .iter()
        .any(|registered| oauth::redirect_uri_matches(registered, &redirect_uri))
    {
        tracing::warn!("an MCP authorization named a redirect URI its client did not register");
        return consent_page::message(
            StatusCode::BAD_REQUEST,
            "Unknown return address",
            &format!(
                "This sign-in link returns to an address the AI tool did not register. {start_again}"
            ),
        );
    }
    // From here on a refusal goes back to the client, as RFC 6749 §4.1.2.1 asks.
    let state_param = params.get("state").cloned();
    let refuse = |error: &'static str, description: &str| -> Response {
        tracing::warn!(error, "an MCP authorization was refused");
        let mut response_params = vec![("error", error), ("error_description", description)];
        if let Some(state_param) = state_param
            .as_deref()
            .filter(|value| oauth::state_is_valid(value))
        {
            response_params.push(("state", state_param));
        }
        response_params.push(("iss", origin_value.as_str()));
        redirect(&redirect_uri, &response_params)
    };
    if params.get("response_type").map(String::as_str) != Some("code") {
        return refuse(
            "unsupported_response_type",
            "Only response_type=code is supported.",
        );
    }
    let challenge = params.get("code_challenge").cloned().unwrap_or_default();
    if params.get("code_challenge_method").map(String::as_str) != Some("S256")
        || !oauth::challenge_is_valid(&challenge)
    {
        return refuse(
            "invalid_request",
            "PKCE with code_challenge_method=S256 is required.",
        );
    }
    if state_param
        .as_deref()
        .is_some_and(|value| !oauth::state_is_valid(value))
    {
        return refuse("invalid_request", "The state parameter is too long.");
    }
    if !params
        .get("resource")
        .is_some_and(|resource| oauth::resource_matches(resource, &origin_value))
    {
        return refuse(
            "invalid_target",
            "The resource must be this server's /mcp endpoint.",
        );
    }
    let settings = state.auth.mcp_oauth_settings();
    let Some(scopes) = oauth::requested_scopes(params.get("scope").map(String::as_str), &settings)
    else {
        return refuse("invalid_scope", "A requested scope is not supported.");
    };
    if !settings.enabled {
        return consent_page::message(
            StatusCode::FORBIDDEN,
            "The MCP server is off",
            &format!(
                "The MCP server is off on {}. Turn on MCP server in BiBCode (Settings → Agents → Agent integrations), then start sign-in again from your AI tool.",
                state.config.environment_label
            ),
        );
    }
    let Some(_permit) = admitted_mutation(&state, "/oauth/authorize") else {
        return consent_page::message(
            StatusCode::SERVICE_UNAVAILABLE,
            "BiBCode is updating",
            &format!("BiBCode is protecting its data during an update. {start_again}"),
        );
    };
    let (Ok(cookie), Ok(user_code)) = (oauth::random_secret(), oauth::random_user_code()) else {
        return consent_page::message(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Sign-in failed",
            &format!("BiBCode could not start this request. {start_again}"),
        );
    };
    let id = Uuid::new_v4().to_string();
    let now = now_ms();
    let created = repositories
        .create_mcp_oauth_authorization(
            NewMcpOAuthAuthorization {
                id: id.clone(),
                user_code: user_code.clone(),
                client_id: client.client_id.clone(),
                redirect_uri: redirect_uri.clone(),
                code_challenge: challenge,
                state: state_param.clone(),
                resource: oauth::resource_for(&origin_value),
                scopes: scopes.join(" "),
                origin: origin_value.clone(),
                source_key: origin.source_key.clone(),
                status_cookie_hash: oauth::secret_hash(&cookie),
                created_at_ms: now,
                expires_at_ms: now + oauth::AUTHORIZATION_TTL_MS,
            },
            now,
            oauth::LIMITS,
        )
        .await;
    match created {
        Ok(McpOAuthAdmission::Admitted) => {}
        Ok(McpOAuthAdmission::Refused) => {
            tracing::warn!(
                class = ?origin.class,
                "an MCP authorization was refused: too many waiting from one client or source"
            );
            return consent_page::message(
                StatusCode::TOO_MANY_REQUESTS,
                "Too many requests waiting",
                "Too many sign-in requests from here are waiting. Approve or deny them in BiBCode (Settings → Agents → Agent integrations), or wait 10 minutes, then start sign-in again from your AI tool.",
            );
        }
        Err(error) => {
            tracing::warn!(%error, "an MCP authorization could not be recorded");
            return consent_page::message(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Sign-in failed",
                &format!("BiBCode could not record this request. {start_again}"),
            );
        }
    }
    if let Err(error) = state.auth.reload_pending_mcp_authorizations().await {
        tracing::warn!(
            ?error,
            "the pending MCP authorizations could not be announced"
        );
    }
    let secure = if origin_value.starts_with("https://") {
        "; Secure"
    } else {
        ""
    };
    let set_cookie = format!(
        "{}={cookie}; Path=/oauth/authorize; Max-Age={}; HttpOnly; SameSite=Strict{secure}",
        status_cookie_name(&id),
        oauth::AUTHORIZATION_TTL_MS / 1_000,
    );
    consent_page::consent(
        &consent_page::Consent {
            client_name: &client.client_name,
            environment: &state.config.environment_label,
            code: &oauth::display_user_code(&user_code),
            redirect_host: &oauth::redirect_host(&redirect_uri),
            status_url: &status_url(&id),
        },
        Some(set_cookie),
    )
}

fn redirect(target: &str, params: &[(&str, &str)]) -> Response {
    let Some(location) = oauth::redirect_with(target, params) else {
        return consent_page::message(
            StatusCode::BAD_REQUEST,
            "Unknown return address",
            "This sign-in link returns to an address BiBCode cannot use.",
        );
    };
    let mut response = StatusCode::SEE_OTHER.into_response();
    if let Ok(location) = header::HeaderValue::from_str(&location) {
        response.headers_mut().insert(header::LOCATION, location);
    }
    response.headers_mut().insert(
        header::REFERRER_POLICY,
        header::HeaderValue::from_static("no-referrer"),
    );
    no_store(response)
}

/// `GET /oauth/authorize/status?id=…`: the consent page's own poll, read with the cookie
/// that page set. Pending refreshes; approved redirects once with a new single-use code;
/// denied redirects with `access_denied`; expired explains.
async fn authorize_status(
    State(state): State<AppState>,
    Extension(origin): Extension<RequestOrigin>,
    headers: HeaderMap,
    uri: Uri,
) -> Response {
    let Some(origin_value) = origin.eligible_origin().map(str::to_owned) else {
        return not_found();
    };
    let Some(repositories) = state.auth.oauth_repositories() else {
        return not_found();
    };
    let start_again = "Start sign-in again from your AI tool.";
    let gone = || {
        consent_page::message(
            StatusCode::NOT_FOUND,
            "Request not found",
            &format!("This sign-in request is gone. {start_again}"),
        )
    };
    let Some(id) = query_pairs(&uri).remove("id") else {
        return gone();
    };
    let authorization = match repositories.get_mcp_oauth_authorization(id.clone()).await {
        Ok(Some(authorization)) => authorization,
        Ok(None) => return gone(),
        Err(error) => {
            tracing::warn!(%error, "an MCP authorization's status could not be read");
            return consent_page::message(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Sign-in failed",
                &format!("BiBCode could not read this request. {start_again}"),
            );
        }
    };
    let presented = headers
        .get(header::COOKIE)
        .and_then(|value| value.to_str().ok())
        .and_then(|cookies| cookie_value(cookies, &status_cookie_name(&id)))
        .map(oauth::secret_hash);
    if !presented
        .is_some_and(|hash| oauth::constant_time_equal(&hash, &authorization.status_cookie_hash))
        || authorization.origin != origin_value
    {
        tracing::warn!("an MCP authorization's status was asked without its cookie");
        return consent_page::message(
            StatusCode::FORBIDDEN,
            "Open the sign-in page again",
            &format!("This page only works in the browser your AI tool opened. {start_again}"),
        );
    }
    let now = now_ms();
    let respond = |params: &[(&str, &str)]| -> Response {
        let mut params = params.to_vec();
        if let Some(state_param) = authorization.state.as_deref() {
            params.push(("state", state_param));
        }
        params.push(("iss", origin_value.as_str()));
        let mut response = redirect(&authorization.redirect_uri, &params);
        if let Ok(expired) = header::HeaderValue::from_str(&format!(
            "{}=; Path=/oauth/authorize; Max-Age=0; HttpOnly; SameSite=Strict",
            status_cookie_name(&id)
        )) {
            response.headers_mut().insert(header::SET_COOKIE, expired);
        }
        response
    };
    match authorization.status.as_str() {
        "pending" if authorization.expires_at_ms > now => consent_page::consent(
            &consent_page::Consent {
                client_name: &authorization.client_name,
                environment: &state.config.environment_label,
                code: &oauth::display_user_code(&authorization.user_code),
                redirect_host: &oauth::redirect_host(&authorization.redirect_uri),
                status_url: &status_url(&id),
            },
            None,
        ),
        "denied" => respond(&[
            ("error", "access_denied"),
            ("error_description", "The request was denied in BiBCode."),
        ]),
        "approved" if authorization.code_hash.is_none() && authorization.expires_at_ms > now => {
            let Some(_permit) = admitted_mutation(&state, "/oauth/authorize/status") else {
                return consent_page::message(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "BiBCode is updating",
                    "BiBCode is protecting its data during an update. Reload this page in a moment.",
                );
            };
            let Ok(code) = oauth::random_secret() else {
                return consent_page::message(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Sign-in failed",
                    &format!("BiBCode could not finish this request. {start_again}"),
                );
            };
            match repositories
                .attach_mcp_oauth_code(
                    id.clone(),
                    oauth::secret_hash(&code),
                    now + oauth::CODE_TTL_MS,
                    now,
                )
                .await
            {
                Ok(true) => respond(&[("code", code.as_str())]),
                Ok(false) => finished(),
                Err(error) => {
                    tracing::warn!(%error, "an MCP authorization's code could not be stored");
                    consent_page::message(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "Sign-in failed",
                        &format!("BiBCode could not finish this request. {start_again}"),
                    )
                }
            }
        }
        "approved" if authorization.code_hash.is_some() => finished(),
        "exchanged" => finished(),
        _ => consent_page::message(
            StatusCode::GONE,
            "This request expired",
            &format!("Nobody approved it in time. {start_again}"),
        ),
    }
}

fn finished() -> Response {
    consent_page::message(
        StatusCode::OK,
        "Sign-in finished",
        "This request was already completed. Return to your AI tool.",
    )
}

/// `POST /oauth/token`: dispatches on `grant_type`. The RFC 8693 exchange is unchanged and
/// served wherever it was; the authorization-code and refresh grants need an eligible
/// origin.
async fn token(State(state): State<AppState>, request: axum::extract::Request) -> Response {
    let (parts, body) = request.into_parts();
    let Ok(body) = axum::body::to_bytes(body, MAX_TOKEN_FORM_BYTES).await else {
        return oauth_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "invalid_request",
            "The request is too large.",
        );
    };
    let form = url::form_urlencoded::parse(&body)
        .map(|(name, value)| (name.into_owned(), value.into_owned()))
        .collect::<Vec<_>>();
    let grant_type = form
        .iter()
        .find(|(name, _)| name == "grant_type")
        .map(|(_, value)| value.as_str());
    match grant_type {
        Some(AUTHORIZATION_CODE_GRANT | REFRESH_TOKEN_GRANT) => {
            let origin = parts
                .extensions
                .get::<RequestOrigin>()
                .cloned()
                .unwrap_or_default();
            let mut fields = HashMap::new();
            for (name, value) in form {
                fields.entry(name).or_insert(value);
            }
            oauth_token(&state, &origin, &parts.headers, &fields).await
        }
        _ => {
            let (headers, uri) = (parts.headers.clone(), parts.uri.clone());
            let request = axum::extract::Request::from_parts(parts, axum::body::Body::from(body));
            match Form::<TokenExchangeRequest>::from_request(request, &state).await {
                Ok(Form(payload)) => exchange_token(&state, &headers, &uri, payload).await,
                Err(rejection) => rejection.into_response(),
            }
        }
    }
}

/// The authorization-code and refresh-token grants of a remote MCP client.
async fn oauth_token(
    state: &AppState,
    origin: &RequestOrigin,
    headers: &HeaderMap,
    fields: &HashMap<String, String>,
) -> Response {
    let Some(origin_value) = origin.eligible_origin() else {
        return oauth_error(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "Remote MCP sign-in needs an HTTPS address, or this computer's loopback address.",
        );
    };
    let Some(repositories) = state.auth.oauth_repositories() else {
        return not_found();
    };
    let field = |name: &str| {
        fields
            .get(name)
            .map(String::as_str)
            .filter(|value| !value.is_empty())
    };
    let invalid_grant = |why: &'static str| {
        tracing::warn!(why, "an MCP token request was refused");
        oauth_error(
            StatusCode::BAD_REQUEST,
            "invalid_grant",
            "The grant is invalid, expired or revoked. Sign in again.",
        )
    };
    let Some(client_id) = field("client_id") else {
        return oauth_error(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "client_id is required.",
        );
    };
    let resource = field("resource")
        .map(str::to_owned)
        .unwrap_or_else(|| oauth::resource_for(origin_value));
    if !oauth::resource_matches(&resource, origin_value) {
        return oauth_error(
            StatusCode::BAD_REQUEST,
            "invalid_target",
            "The resource must be this server's /mcp endpoint.",
        );
    }
    if field("grant_type") == Some(REFRESH_TOKEN_GRANT) {
        let Some(refresh_token) = field("refresh_token") else {
            return oauth_error(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "refresh_token is required.",
            );
        };
        let scopes = field("scope").map(|scope| {
            scope
                .split_ascii_whitespace()
                .filter(|scope| *scope != "offline_access")
                .map(str::to_owned)
                .collect::<Vec<_>>()
        });
        let scopes = scopes.filter(|scopes| !scopes.is_empty());
        let Ok(successor) = oauth::random_secret() else {
            return oauth_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "server_error",
                "BiBCode could not refresh this grant.",
            );
        };
        let now = now_ms();
        let outcome = state
            .auth
            .rotate_mcp_oauth_refresh_token(McpOAuthRefreshRotation {
                token_hash: oauth::secret_hash(refresh_token),
                new_token_hash: oauth::secret_hash(&successor),
                client_id: client_id.to_owned(),
                resource: oauth::resource_for(origin_value),
                scopes,
                new_expires_at: format_iso(now + oauth::GRANT_TTL_MS),
                now: format_iso(now),
            })
            .await;
        return match outcome {
            Ok(McpOAuthRefresh::Rotated(tokens)) => token_response(&tokens, &successor),
            Ok(McpOAuthRefresh::Reused) => {
                tracing::warn!("a reused MCP refresh token revoked its grant");
                invalid_grant("reused")
            }
            Ok(McpOAuthRefresh::InvalidGrant) => invalid_grant("unknown-or-dead"),
            Ok(McpOAuthRefresh::InvalidScope) => oauth_error(
                StatusCode::BAD_REQUEST,
                "invalid_scope",
                "A refresh can only narrow the scopes that were granted.",
            ),
            Err(error) => {
                tracing::warn!(?error, "an MCP refresh failed");
                oauth_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "server_error",
                    "BiBCode could not refresh this grant.",
                )
            }
        };
    }
    if !state.auth.mcp_oauth_settings().enabled {
        tracing::warn!("an MCP code exchange was refused: the MCP server is off");
        return oauth_error(
            StatusCode::BAD_REQUEST,
            "invalid_grant",
            "The MCP server is off in BiBCode. Turn it on, then sign in again.",
        );
    }
    let (Some(code), Some(verifier), Some(redirect_uri)) =
        (field("code"), field("code_verifier"), field("redirect_uri"))
    else {
        return oauth_error(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "code, code_verifier and redirect_uri are required.",
        );
    };
    let code_hash = oauth::secret_hash(code);
    let authorization = match repositories
        .get_mcp_oauth_authorization_by_code(code_hash.clone())
        .await
    {
        Ok(Some(authorization)) => authorization,
        Ok(None) => return invalid_grant("unknown-code"),
        Err(error) => {
            tracing::warn!(%error, "an MCP code exchange could not read its authorization");
            return oauth_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "server_error",
                "BiBCode could not complete sign-in.",
            );
        }
    };
    let now = now_ms();
    if authorization.status == "approved"
        && (authorization.client_id != client_id
            || authorization.redirect_uri != redirect_uri
            || authorization.origin != origin_value
            || !oauth::resource_matches(&authorization.resource, origin_value)
            || authorization
                .code_expires_at_ms
                .is_none_or(|expiry| expiry <= now)
            || !oauth::pkce_verifies(verifier, &authorization.code_challenge))
    {
        return invalid_grant("mismatch-or-expired");
    }
    let Ok(refresh_token) = oauth::random_secret() else {
        return oauth_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "server_error",
            "BiBCode could not complete sign-in.",
        );
    };
    match state
        .auth
        .mint_mcp_oauth_grant(
            &authorization,
            code_hash,
            oauth::secret_hash(&refresh_token),
            client_metadata(headers, None),
        )
        .await
    {
        Ok(McpOAuthMint::Minted(tokens)) => {
            tracing::info!("a remote MCP client signed in");
            token_response(&tokens, &refresh_token)
        }
        Ok(McpOAuthMint::Replayed) => {
            tracing::warn!("a replayed MCP authorization code revoked its grant");
            invalid_grant("replayed-code")
        }
        Ok(McpOAuthMint::Refused) => invalid_grant("not-approved"),
        Err(error) => {
            tracing::warn!(?error, "an MCP code exchange failed");
            oauth_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "server_error",
                "BiBCode could not complete sign-in.",
            )
        }
    }
}

fn token_response(tokens: &McpOAuthTokens, refresh_token: &str) -> Response {
    credential_response(
        Json(json!({
            "access_token": tokens.access_token,
            "token_type": "Bearer",
            "expires_in": tokens.expires_in,
            "refresh_token": refresh_token,
            "scope": tokens.scope,
        }))
        .into_response(),
    )
}

fn invalid_mcp_authorization(why: &str) -> Response {
    tracing::warn!(why, "an MCP authorization decision was refused");
    error_response(
        StatusCode::BAD_REQUEST,
        "EnvironmentRequestInvalidError",
        json!({
            "code": "invalid_request",
            "reason": "invalid_mcp_authorization",
            "traceId": Uuid::new_v4().to_string(),
        }),
    )
}

/// `POST /api/auth/mcp-authorizations/approve`: a person with `access:write` approves a
/// pending remote authorization, at most at the environment's access, with terminals only
/// when the client asked for them and slice T's conditions hold.
async fn approve_mcp_authorization(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    Json(payload): Json<ApproveMcpAuthorizationRequest>,
) -> Response {
    if let Err(error) =
        authenticated_with_scope(&state.auth, &headers, &uri, SCOPE_ACCESS_WRITE).await
    {
        return auth_error_for_request(error, &headers, "mcp_authorization_decision_failed");
    }
    let Some(repositories) = state.auth.oauth_repositories() else {
        return invalid_mcp_authorization("no-store");
    };
    let authorization = match repositories
        .get_mcp_oauth_authorization(payload.id.clone())
        .await
    {
        Ok(Some(authorization))
            if authorization.status == "pending" && authorization.expires_at_ms > now_ms() =>
        {
            authorization
        }
        Ok(_) => return invalid_mcp_authorization("not-pending"),
        Err(error) => {
            return auth_error_for_request(
                AuthError::Internal(error.to_string()),
                &headers,
                "mcp_authorization_decision_failed",
            );
        }
    };
    let settings = state.auth.mcp_oauth_settings();
    if !oauth::access_within(&payload.access, &settings.access) {
        return invalid_mcp_authorization("above-the-environment-access");
    }
    let requested = authorization
        .scopes
        .split_ascii_whitespace()
        .map(str::to_owned)
        .collect::<Vec<_>>();
    if payload.terminals
        && (!requested
            .iter()
            .any(|scope| scope == super::SCOPE_TERMINAL_OPERATE)
            || !oauth::terminals_allowed(&settings, &payload.access))
    {
        return invalid_mcp_authorization("terminals-not-allowed");
    }
    let scopes = oauth::approved_scopes(&requested, payload.terminals);
    if scopes.is_empty() {
        return invalid_mcp_authorization("no-scope-left");
    }
    decide_mcp_authorization(
        &state,
        &headers,
        payload.id,
        McpOAuthDecision::Approve {
            access: payload.access,
            scopes: scopes.join(" "),
        },
        "approved",
    )
    .await
}

/// `POST /api/auth/mcp-authorizations/deny`.
async fn deny_mcp_authorization(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    Json(payload): Json<DenyMcpAuthorizationRequest>,
) -> Response {
    if let Err(error) =
        authenticated_with_scope(&state.auth, &headers, &uri, SCOPE_ACCESS_WRITE).await
    {
        return auth_error_for_request(error, &headers, "mcp_authorization_decision_failed");
    }
    decide_mcp_authorization(
        &state,
        &headers,
        payload.id,
        McpOAuthDecision::Deny,
        "denied",
    )
    .await
}

async fn decide_mcp_authorization(
    state: &AppState,
    headers: &HeaderMap,
    id: String,
    decision: McpOAuthDecision,
    status: &'static str,
) -> Response {
    let Some(repositories) = state.auth.oauth_repositories() else {
        return invalid_mcp_authorization("no-store");
    };
    match repositories
        .decide_mcp_oauth_authorization(id.clone(), decision, now_ms())
        .await
    {
        Ok(true) => {
            tracing::info!(status, "a remote MCP authorization was decided");
            if let Err(error) = state.auth.reload_pending_mcp_authorizations().await {
                tracing::warn!(
                    ?error,
                    "the pending MCP authorizations could not be announced"
                );
            }
            Json(json!({ "id": id, "status": status })).into_response()
        }
        Ok(false) => invalid_mcp_authorization("not-pending"),
        Err(error) => auth_error_for_request(
            AuthError::Internal(error.to_string()),
            headers,
            "mcp_authorization_decision_failed",
        ),
    }
}

pub(crate) async fn authenticate_websocket(
    auth: &AuthService,
    headers: &HeaderMap,
    uri: &Uri,
) -> Result<super::model::Principal, AuthError> {
    if let Some(ticket) = query_value(uri, "wsTicket").filter(|value| !value.trim().is_empty()) {
        return auth.verify_websocket_ticket(&ticket).await;
    }
    authenticate_request(auth, headers, uri).await
}

pub(crate) fn auth_error_response(error: AuthError) -> Response {
    HttpAuthError::new(error, "internal_error").into_response()
}

async fn authenticated_with_scope(
    auth: &AuthService,
    headers: &HeaderMap,
    uri: &Uri,
    scope: &str,
) -> Result<super::model::Principal, AuthError> {
    let principal = authenticate_request(auth, headers, uri).await?;
    require_scope(&principal, scope)?;
    Ok(principal)
}

async fn authenticate_request(
    auth: &AuthService,
    headers: &HeaderMap,
    uri: &Uri,
) -> Result<super::model::Principal, AuthError> {
    authenticate_request_for_method(auth, headers, request_method(uri), uri).await
}

pub(crate) async fn authorize_http_request(
    auth: &AuthService,
    headers: &HeaderMap,
    method: &Method,
    uri: &Uri,
    scope: Option<&str>,
) -> Result<super::model::Principal, AuthError> {
    let principal = authenticate_request_for_method(auth, headers, method.as_str(), uri).await?;
    if let Some(scope) = scope {
        require_scope(&principal, scope)?;
    }
    Ok(principal)
}

async fn authenticate_request_for_method(
    auth: &AuthService,
    headers: &HeaderMap,
    method: &str,
    uri: &Uri,
) -> Result<super::model::Principal, AuthError> {
    let cookie = headers
        .get(header::COOKIE)
        .and_then(|value| value.to_str().ok())
        .and_then(|cookies| cookie_value(cookies, auth.cookie_name()));
    let authorization = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok());
    let bearer = authorization
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::trim);
    let dpop = authorization
        .and_then(|value| value.strip_prefix("DPoP "))
        .map(str::trim);
    let token = cookie.or(bearer).or(dpop).filter(|value| !value.is_empty());
    let token = token.ok_or(AuthError::MissingCredential)?;
    // The cookie wins the chain above, so a present cookie is the credential.
    // Browsers attach it cross-site; only same-origin pages may mutate with it.
    let mutates = !matches!(method, "GET" | "HEAD" | "OPTIONS")
        || headers
            .get(header::UPGRADE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.eq_ignore_ascii_case("websocket"));
    if cookie.is_some()
        && mutates
        && !cookie_request_origin_allowed(headers, auth.trusted_cookie_origins())
    {
        return Err(AuthError::Forbidden);
    }
    let principal = auth
        .authenticate_token(token, super::SessionTransport::Plain)
        .await?;
    if let Some(expected_thumbprint) = principal.proof_key_thumbprint.as_deref() {
        let dpop_token = dpop.filter(|candidate| *candidate == token);
        let dpop_token = dpop_token.ok_or(AuthError::InvalidCredential)?;
        let proof = headers
            .get("dpop")
            .and_then(|value| value.to_str().ok())
            .ok_or(AuthError::InvalidCredential)?;
        auth.verify_dpop(
            proof,
            method,
            &request_url(headers, uri)?,
            Some(expected_thumbprint),
            Some(dpop_token),
        )
        .await?;
    } else if dpop.is_some() {
        return Err(AuthError::InvalidCredential);
    }
    Ok(principal)
}

/// True when `Origin` is a trusted app origin or the request's own
/// `http(s)://<Host>` origin.
pub(crate) fn cookie_request_origin_allowed(headers: &HeaderMap, trusted: &[String]) -> bool {
    let Some(origin) = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
    else {
        return false;
    };
    if trusted
        .iter()
        .any(|candidate| candidate.eq_ignore_ascii_case(origin))
    {
        return true;
    }
    let Some(host) = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
    else {
        return false;
    };
    let Ok(url) = url::Url::parse(origin) else {
        return false;
    };
    matches!(url.scheme(), "http" | "https")
        && url.path() == "/"
        && url
            .host_str()
            .map(|origin_host| {
                let port = url
                    .port()
                    .map(|port| format!(":{port}"))
                    .unwrap_or_default();
                format!("{origin_host}{port}")
            })
            .is_some_and(|authority| authority.eq_ignore_ascii_case(host))
}

fn require_scope(principal: &super::model::Principal, scope: &str) -> Result<(), AuthError> {
    if principal.has_scope(scope) {
        Ok(())
    } else {
        Err(AuthError::ScopeRequired(scope.to_owned()))
    }
}

fn credential_response(mut response: Response) -> Response {
    for (name, value) in CREDENTIAL_HEADERS {
        response.headers_mut().insert(
            header::HeaderName::from_static(name),
            header::HeaderValue::from_static(value),
        );
    }
    response
}

fn dpop_challenge_on_unauthorized(mut response: Response) -> Response {
    if response.status() == StatusCode::UNAUTHORIZED {
        response.headers_mut().insert(
            header::WWW_AUTHENTICATE,
            header::HeaderValue::from_static("DPoP"),
        );
    }
    response
}

fn auth_error_for_request(
    error: AuthError,
    headers: &HeaderMap,
    internal_reason: &'static str,
) -> Response {
    let response = HttpAuthError::new(error, internal_reason).into_response();
    if request_uses_dpop(headers) {
        dpop_challenge_on_unauthorized(response)
    } else {
        response
    }
}

fn request_uses_dpop(headers: &HeaderMap) -> bool {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.starts_with("DPoP "))
}

struct HttpAuthError {
    error: AuthError,
    internal_reason: &'static str,
}

impl HttpAuthError {
    fn new(error: AuthError, internal_reason: &'static str) -> Self {
        Self {
            error,
            internal_reason,
        }
    }
}

impl IntoResponse for HttpAuthError {
    fn into_response(self) -> Response {
        let trace_id = Uuid::new_v4().to_string();
        match self.error {
            AuthError::MissingCredential => error_response(
                StatusCode::UNAUTHORIZED,
                "EnvironmentAuthInvalidError",
                json!({ "code": "auth_invalid", "reason": "missing_credential", "traceId": trace_id }),
            ),
            AuthError::InvalidCredential => error_response(
                StatusCode::UNAUTHORIZED,
                "EnvironmentAuthInvalidError",
                json!({ "code": "auth_invalid", "reason": "invalid_credential", "traceId": trace_id }),
            ),
            AuthError::InvalidScope => error_response(
                StatusCode::BAD_REQUEST,
                "EnvironmentRequestInvalidError",
                json!({ "code": "invalid_request", "reason": "invalid_scope", "traceId": trace_id }),
            ),
            AuthError::ScopeNotGranted => error_response(
                StatusCode::BAD_REQUEST,
                "EnvironmentRequestInvalidError",
                json!({ "code": "invalid_request", "reason": "scope_not_granted", "traceId": trace_id }),
            ),
            AuthError::ScopeRequired(required_scope) => error_response(
                StatusCode::FORBIDDEN,
                "EnvironmentScopeRequiredError",
                json!({ "code": "insufficient_scope", "requiredScope": required_scope, "traceId": trace_id }),
            ),
            AuthError::CurrentSessionRevokeNotAllowed => error_response(
                StatusCode::FORBIDDEN,
                "EnvironmentOperationForbiddenError",
                json!({ "code": "operation_forbidden", "reason": "current_session_revoke_not_allowed", "traceId": trace_id }),
            ),
            AuthError::Forbidden => error_response(
                StatusCode::FORBIDDEN,
                "EnvironmentOperationForbiddenError",
                json!({ "code": "operation_forbidden", "reason": "origin_not_allowed", "traceId": trace_id }),
            ),
            AuthError::Internal(diagnostic) => {
                tracing::error!(%trace_id, %diagnostic, "environment authentication failed");
                error_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "EnvironmentInternalError",
                    json!({ "code": "internal_error", "reason": self.internal_reason, "traceId": trace_id }),
                )
            }
        }
    }
}

fn error_response(status: StatusCode, tag: &str, fields: serde_json::Value) -> Response {
    let mut object = fields.as_object().cloned().unwrap_or_default();
    object.insert("_tag".to_owned(), json!(tag));
    (status, Json(object)).into_response()
}

fn cookie_value<'a>(cookies: &'a str, name: &str) -> Option<&'a str> {
    cookies.split(';').find_map(|cookie| {
        let (candidate, value) = cookie.trim().split_once('=')?;
        (candidate == name).then_some(value)
    })
}

fn query_value(uri: &Uri, key: &str) -> Option<String> {
    url::form_urlencoded::parse(uri.query()?.as_bytes())
        .find_map(|(candidate, value)| (candidate == key).then(|| value.into_owned()))
}

fn request_url(headers: &HeaderMap, uri: &Uri) -> Result<String, AuthError> {
    let host = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("localhost");
    let protocol = if headers
        .get("x-forwarded-proto")
        .and_then(|value| value.to_str().ok())
        == Some("https")
    {
        "https"
    } else {
        "http"
    };
    Ok(format!("{protocol}://{host}{uri}"))
}

fn request_method(uri: &Uri) -> &'static str {
    match uri.path() {
        "/api/auth/session"
        | "/api/auth/share-state"
        | "/api/auth/pairing-links"
        | "/api/auth/clients"
        | "/ws" => "GET",
        _ => "POST",
    }
}

fn client_metadata(headers: &HeaderMap, label: Option<String>) -> ClientMetadata {
    let user_agent = headers
        .get(header::USER_AGENT)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    ClientMetadata {
        label,
        user_agent: user_agent.clone(),
        device_type: infer_device_type(headers).to_owned(),
        os: infer_os(headers).map(str::to_owned),
        browser: infer_browser(user_agent.as_deref()).map(str::to_owned),
        ip_address: None,
    }
}

fn infer_device_type(headers: &HeaderMap) -> &'static str {
    let user_agent = headers
        .get(header::USER_AGENT)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if ["bot", "crawler", "spider", "slurp", "curl", "wget"]
        .iter()
        .any(|needle| user_agent.contains(needle))
    {
        "bot"
    } else if user_agent.contains("ipad") || user_agent.contains("tablet") {
        "tablet"
    } else if user_agent.contains("iphone") || user_agent.contains("mobile") {
        "mobile"
    } else {
        "desktop"
    }
}

fn infer_os(headers: &HeaderMap) -> Option<&'static str> {
    let user_agent = headers
        .get(header::USER_AGENT)
        .and_then(|value| value.to_str().ok())?
        .to_ascii_lowercase();
    if user_agent.contains("iphone") || user_agent.contains("ipad") {
        Some("iOS")
    } else if user_agent.contains("android") {
        Some("Android")
    } else if user_agent.contains("mac os x") || user_agent.contains("macintosh") {
        Some("macOS")
    } else if user_agent.contains("windows nt") {
        Some("Windows")
    } else if user_agent.contains("linux") {
        Some("Linux")
    } else {
        None
    }
}

fn infer_browser(user_agent: Option<&str>) -> Option<&'static str> {
    let user_agent = user_agent?.to_ascii_lowercase();
    if user_agent.contains("edg/") {
        Some("Edge")
    } else if user_agent.contains("opr/") {
        Some("Opera")
    } else if user_agent.contains("firefox/") {
        Some("Firefox")
    } else if user_agent.contains("chrome/") || user_agent.contains("crios/") {
        Some("Chrome")
    } else if user_agent.contains("safari/") {
        Some("Safari")
    } else {
        None
    }
}

fn is_device_type(value: &str) -> bool {
    ["desktop", "mobile", "tablet", "bot", "unknown"].contains(&value)
}

fn non_empty(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_owned())
    })
}

#[cfg(test)]
mod tests {
    use serde::Deserialize;

    use super::{MAX_PAIRING_OFFER_IDEMPOTENCY_KEY_BYTES, is_valid_pairing_offer_idempotency_key};
    use crate::auth::service::{is_loopback_host, is_unspecified_host};

    #[derive(Deserialize)]
    struct PairingEndpointFixture {
        endpoint: String,
        classification: String,
    }

    #[test]
    fn pairing_endpoint_loopback_semantics_match_shared_fixtures() {
        let fixtures: Vec<PairingEndpointFixture> = serde_json::from_str(include_str!(
            "../../../../packages/shared/fixtures/pairing-endpoint-classification.json"
        ))
        .expect("pairing endpoint fixtures");

        for fixture in fixtures {
            let Ok(endpoint) = url::Url::parse(&fixture.endpoint) else {
                assert_eq!(fixture.classification, "unconnectable");
                continue;
            };
            let host = endpoint.host_str().unwrap_or_default();
            let wildcard = host.is_empty() || is_unspecified_host(host);
            let unconnectable = wildcard || endpoint.port() == Some(0);
            assert_eq!(
                unconnectable,
                fixture.classification == "unconnectable",
                "{}",
                fixture.endpoint
            );
            if !unconnectable {
                assert_eq!(
                    is_loopback_host(host),
                    fixture.classification == "loopback",
                    "{}",
                    fixture.endpoint
                );
            }
        }
    }

    #[test]
    fn cookie_origin_matches_host_or_the_dev_origin() {
        use axum::http::{HeaderMap, HeaderValue, header};

        let config = crate::config::ServerConfig::new(std::env::temp_dir())
            .with_dev_url("http://localhost:5733/app".parse().expect("dev URL"));
        let auth = crate::auth::AuthService::new(&config, vec![7_u8; 32]);
        let trusted = auth.trusted_cookie_origins();
        let allowed = |host: Option<&str>, origin: Option<&str>| {
            let mut headers = HeaderMap::new();
            if let Some(host) = host {
                headers.insert(header::HOST, HeaderValue::from_str(host).expect("host"));
            }
            if let Some(origin) = origin {
                headers.insert(
                    header::ORIGIN,
                    HeaderValue::from_str(origin).expect("origin"),
                );
            }
            super::cookie_request_origin_allowed(&headers, trusted)
        };

        assert_eq!(trusted, ["http://localhost:5733"]);
        assert!(allowed(None, Some("http://localhost:5733")));
        // The desktop app never authenticates with the cookie, so its origins get no pass.
        for origin in ["bibcode://app", "bibcode-dev://app"] {
            assert!(!allowed(Some("127.0.0.1:3773"), Some(origin)), "{origin}");
        }
        assert!(allowed(
            Some("127.0.0.1:3773"),
            Some("http://127.0.0.1:3773")
        ));
        assert!(allowed(Some("[::1]:3773"), Some("http://[::1]:3773")));
        assert!(allowed(Some("Example.test"), Some("https://example.test")));
        assert!(!allowed(Some("127.0.0.1:3773"), None));
        assert!(!allowed(Some("127.0.0.1:3773"), Some("null")));
        let opaque_dev = crate::config::ServerConfig::new(std::env::temp_dir())
            .with_dev_url("file:///tmp/app".parse().expect("opaque dev URL"));
        let opaque_auth = crate::auth::AuthService::new(&opaque_dev, vec![7_u8; 32]);
        assert!(opaque_auth.trusted_cookie_origins().is_empty());
        assert!(!allowed(
            Some("127.0.0.1:3773"),
            Some("http://127.0.0.1:3774")
        ));
        assert!(!allowed(Some("[::1]:3773"), Some("http://[::2]:3773")));
        assert!(!allowed(
            Some("127.0.0.1:3773"),
            Some("ws://127.0.0.1:3773")
        ));
        assert!(!allowed(
            Some("127.0.0.1:3773"),
            Some("http://127.0.0.1:3773/x")
        ));
        assert!(!allowed(None, Some("http://127.0.0.1:3773")));
        assert!(!allowed(
            Some("localhost:5734"),
            Some("http://localhost:5734.evil")
        ));
    }

    #[test]
    fn pairing_offer_idempotency_keys_are_byte_bounded() {
        assert!(!is_valid_pairing_offer_idempotency_key(""));
        assert!(is_valid_pairing_offer_idempotency_key(
            &"x".repeat(MAX_PAIRING_OFFER_IDEMPOTENCY_KEY_BYTES)
        ));
        assert!(!is_valid_pairing_offer_idempotency_key(
            &"x".repeat(MAX_PAIRING_OFFER_IDEMPOTENCY_KEY_BYTES + 1)
        ));
        assert!(!is_valid_pairing_offer_idempotency_key(
            &"🦀".repeat(MAX_PAIRING_OFFER_IDEMPOTENCY_KEY_BYTES / 2)
        ));
    }
}
