use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use bibcode_server::{ROUTE_INVENTORY, RpcRegistry, ServerConfig, ServerHandle, ServerRuntime};
use futures_util::{SinkExt, StreamExt};
use p256::ecdsa::{Signature, SigningKey, signature::hazmat::PrehashSigner};
use reqwest::{Client, Response, StatusCode, header};
use rusqlite::Connection;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tempfile::TempDir;
use tokio::time::timeout;
use tokio_tungstenite::{connect_async, tungstenite};

const DESKTOP_BOOTSTRAP: &str = "desktop-bootstrap-fixture";
const TOKEN_GRANT_TYPE: &str = "urn:ietf:params:oauth:grant-type:token-exchange";
const ACCESS_TOKEN_TYPE: &str = "urn:ietf:params:oauth:token-type:access_token";
const BOOTSTRAP_TOKEN_TYPE: &str = "urn:bibcode:params:oauth:token-type:environment-bootstrap";

#[test]
fn language_neutral_auth_fixtures_match_the_rust_http_inventory() {
    let fixture_directory = auth_fixture_directory();
    let manifest: Value = serde_json::from_str(
        &std::fs::read_to_string(fixture_directory.join("manifest.json"))
            .expect("auth manifest fixture"),
    )
    .expect("valid auth manifest");
    let mut fixture_routes = manifest["routes"]
        .as_array()
        .expect("fixture routes")
        .iter()
        .map(|route| {
            (
                route["method"].as_str().expect("fixture method").to_owned(),
                route["path"].as_str().expect("fixture path").to_owned(),
            )
        })
        .collect::<Vec<_>>();
    fixture_routes.sort();
    let mut rust_routes = ROUTE_INVENTORY
        .iter()
        .filter(|route| route.path.starts_with("/api/auth/") || route.path == "/oauth/token")
        .map(|route| (route.method.to_owned(), route.path.to_owned()))
        .collect::<Vec<_>>();
    rust_routes.sort();

    assert_eq!(rust_routes, fixture_routes);
    assert_eq!(
        manifest["scopes"]["all"],
        json!([
            "orchestration:read",
            "orchestration:operate",
            "terminal:operate",
            "review:write",
            "access:read",
            "access:write",
            "relay:read",
            "relay:write"
        ])
    );
    for fixture in manifest["fixtures"].as_array().expect("auth fixture list") {
        let path = fixture_directory.join(fixture.as_str().expect("auth fixture path"));
        assert!(path.is_file(), "missing auth fixture: {}", path.display());
    }
}

#[tokio::test]
async fn desktop_bootstrap_creates_cookie_and_bearer_sessions() {
    let temp = TempDir::new().expect("temporary base directory");
    let handle = start_desktop_server(&temp).await;
    let client = Client::new();

    let unauthenticated = get_json(
        client
            .get(http_url(&handle, "/api/auth/session"))
            .send()
            .await
            .expect("session request"),
        StatusCode::OK,
    )
    .await;
    assert_eq!(unauthenticated["authenticated"], false);
    assert_eq!(unauthenticated["auth"]["policy"], "desktop-managed-local");
    assert_eq!(
        unauthenticated["auth"]["bootstrapMethods"],
        json!(["desktop-bootstrap"])
    );
    assert_eq!(
        unauthenticated["auth"]["sessionCookieName"],
        "bibcode_session_0"
    );

    let browser_response = client
        .post(http_url(&handle, "/api/auth/browser-session"))
        .json(&json!({ "credential": DESKTOP_BOOTSTRAP }))
        .send()
        .await
        .expect("browser bootstrap request");
    assert_credential_headers(&browser_response);
    let cookie = browser_response
        .headers()
        .get(header::SET_COOKIE)
        .expect("session cookie")
        .to_str()
        .expect("ASCII session cookie")
        .split(';')
        .next()
        .expect("cookie pair")
        .to_owned();
    assert!(cookie.starts_with("bibcode_session_0="));
    let browser_session = get_json(browser_response, StatusCode::OK).await;
    assert_eq!(browser_session["authenticated"], true);
    assert_eq!(browser_session["sessionMethod"], "browser-session-cookie");

    let authenticated = get_json(
        client
            .get(http_url(&handle, "/api/auth/session"))
            .header(header::COOKIE, &cookie)
            .send()
            .await
            .expect("cookie session request"),
        StatusCode::OK,
    )
    .await;
    assert_eq!(authenticated["authenticated"], true);

    let access = exchange_token(&client, &handle, DESKTOP_BOOTSTRAP, None).await;
    assert_eq!(access["token_type"], "Bearer");
    assert_eq!(access["issued_token_type"], ACCESS_TOKEN_TYPE);
    assert!(access["expires_in"].as_u64().is_some_and(|ttl| ttl > 0));
    assert!(
        access["scope"]
            .as_str()
            .is_some_and(|scope| scope.contains("access:write"))
    );

    shutdown(handle).await;
}

#[tokio::test]
async fn web_mode_exposes_a_one_time_administrative_startup_pairing_url() {
    let temp = TempDir::new().expect("temporary base directory");
    let config = ServerConfig::new(temp.path()).with_bind("127.0.0.1", 0);
    let handle = ServerRuntime::start_with_registry(config, RpcRegistry::empty())
        .await
        .expect("web server starts");
    let startup = handle
        .startup_access()
        .expect("web mode startup pairing access");
    assert_eq!(
        startup.connection_string,
        format!("http://{}", handle.local_addr())
    );
    assert!(
        startup
            .pairing_url
            .starts_with(&format!("http://{}/pair#token=", handle.local_addr()))
    );
    assert!(startup.pairing_url.ends_with(&startup.credential));

    let client = Client::new();
    let first = client
        .post(http_url(&handle, "/api/auth/browser-session"))
        .json(&json!({ "credential": &startup.credential }))
        .send()
        .await
        .expect("startup browser pairing request");
    let first_cookie = first
        .headers()
        .get(header::SET_COOKIE)
        .expect("startup session cookie")
        .clone();
    let session = get_json(first, StatusCode::OK).await;
    assert!(
        session["scopes"]
            .as_array()
            .is_some_and(|scopes| scopes.iter().any(|scope| scope == "access:write"))
    );
    let replay = client
        .post(http_url(&handle, "/api/auth/browser-session"))
        .json(&json!({ "credential": &startup.credential }))
        .send()
        .await
        .expect("lost-response browser pairing retry");
    assert_eq!(replay.status(), StatusCode::OK);
    assert_eq!(
        replay.headers().get(header::SET_COOKIE),
        Some(&first_cookie)
    );

    shutdown(handle).await;
}

#[tokio::test]
async fn one_time_pairing_credentials_are_atomic_dpop_bound_full_administrator() {
    let temp = TempDir::new().expect("temporary base directory");
    let handle = start_desktop_server(&temp).await;
    let client = Client::new();
    let administrator = exchange_token(&client, &handle, DESKTOP_BOOTSTRAP, None).await;
    let administrator_token = access_token(&administrator);

    let issued_before = unix_seconds();
    let pairing = get_json(
        client
            .post(http_url(&handle, "/api/auth/pairing-token"))
            .bearer_auth(administrator_token)
            .json(&json!({ "label": "Administrator client" }))
            .send()
            .await
            .expect("pairing token request"),
        StatusCode::OK,
    )
    .await;
    let expires_at = time::OffsetDateTime::parse(
        pairing["expiresAt"].as_str().expect("pairing expiry"),
        &time::format_description::well_known::Rfc3339,
    )
    .expect("RFC 3339 pairing expiry")
    .unix_timestamp();
    assert!(
        expires_at >= issued_before + 299 && expires_at <= unix_seconds() + 301,
        "pairing credential must expire after five minutes"
    );
    let credential = pairing["credential"].as_str().expect("pairing credential");
    assert_eq!(credential.len(), 12);
    assert!(
        credential
            .bytes()
            .all(|byte| b"23456789ABCDEFGHJKLMNPQRSTUVWXYZ".contains(&byte))
    );

    let signing_key = SigningKey::from_bytes((&[31_u8; 32]).into()).expect("DPoP key");
    let paired = exchange_dpop_token(
        &client,
        &handle,
        credential,
        &signing_key,
        "admin-pairing-1",
    )
    .await;
    let scopes = paired["scope"].as_str().expect("administrator scopes");
    for required in [
        "orchestration:read",
        "orchestration:operate",
        "terminal:operate",
        "review:write",
        "access:read",
        "access:write",
    ] {
        assert!(scopes.contains(required));
    }
    assert!(!scopes.contains("relay:"));

    let replay = exchange_dpop_token(
        &client,
        &handle,
        credential,
        &signing_key,
        "admin-pairing-2",
    )
    .await;
    assert_eq!(access_token(&paired), access_token(&replay));

    shutdown(handle).await;
}

#[tokio::test]
async fn pairing_links_and_client_sessions_can_be_listed_and_revoked() {
    let temp = TempDir::new().expect("temporary base directory");
    let handle = start_desktop_server(&temp).await;
    let client = Client::new();
    let administrator = exchange_token(&client, &handle, DESKTOP_BOOTSTRAP, None).await;
    let administrator_token = access_token(&administrator);

    let pairing = get_json(
        client
            .post(http_url(&handle, "/api/auth/pairing-token"))
            .bearer_auth(administrator_token)
            .json(&json!({ "label": "Revocable client" }))
            .send()
            .await
            .expect("pairing token request"),
        StatusCode::OK,
    )
    .await;
    let pairing_id = pairing["id"].as_str().expect("pairing id");
    let pairing_credential = pairing["credential"].as_str().expect("pairing credential");

    let links = get_json(
        client
            .get(http_url(&handle, "/api/auth/pairing-links"))
            .bearer_auth(administrator_token)
            .send()
            .await
            .expect("list pairing links"),
        StatusCode::OK,
    )
    .await;
    assert!(
        links
            .as_array()
            .is_some_and(|items| items.iter().any(|item| item["id"] == pairing_id))
    );

    let revoked = get_json(
        client
            .post(http_url(&handle, "/api/auth/pairing-links/revoke"))
            .bearer_auth(administrator_token)
            .json(&json!({ "id": pairing_id }))
            .send()
            .await
            .expect("revoke pairing link"),
        StatusCode::OK,
    )
    .await;
    assert_eq!(revoked["revoked"], true);

    let unavailable = client
        .post(http_url(&handle, "/oauth/token"))
        .form(&token_form(pairing_credential, None))
        .send()
        .await
        .expect("revoked pairing exchange");
    assert_eq!(unavailable.status(), StatusCode::UNAUTHORIZED);

    let second_pairing = get_json(
        client
            .post(http_url(&handle, "/api/auth/pairing-token"))
            .bearer_auth(administrator_token)
            .json(&json!({ "label": "Paired client" }))
            .send()
            .await
            .expect("second pairing token request"),
        StatusCode::OK,
    )
    .await;
    let paired_key = SigningKey::from_bytes((&[37_u8; 32]).into()).expect("paired DPoP key");
    let paired = exchange_dpop_token(
        &client,
        &handle,
        second_pairing["credential"]
            .as_str()
            .expect("second credential"),
        &paired_key,
        "revocable-client-pairing",
    )
    .await;
    let paired_token = access_token(&paired);
    let clients = get_json(
        client
            .get(http_url(&handle, "/api/auth/clients"))
            .bearer_auth(administrator_token)
            .send()
            .await
            .expect("list clients"),
        StatusCode::OK,
    )
    .await;
    let paired_session_id = clients
        .as_array()
        .and_then(|items| {
            items
                .iter()
                .find(|item| item["client"]["label"] == "Paired client")
        })
        .and_then(|item| item["sessionId"].as_str())
        .expect("paired session id");

    let current_session_id = clients
        .as_array()
        .and_then(|items| items.iter().find(|item| item["current"] == true))
        .and_then(|item| item["sessionId"].as_str())
        .expect("current administrator session");
    let self_revoke = get_json(
        client
            .post(http_url(&handle, "/api/auth/clients/revoke"))
            .bearer_auth(administrator_token)
            .json(&json!({ "sessionId": current_session_id }))
            .send()
            .await
            .expect("self revoke request"),
        StatusCode::FORBIDDEN,
    )
    .await;
    assert_eq!(self_revoke["reason"], "current_session_revoke_not_allowed");

    let revoke = get_json(
        client
            .post(http_url(&handle, "/api/auth/clients/revoke"))
            .bearer_auth(administrator_token)
            .json(&json!({ "sessionId": paired_session_id }))
            .send()
            .await
            .expect("revoke client request"),
        StatusCode::OK,
    )
    .await;
    assert_eq!(revoke["revoked"], true);

    let revoked_state = get_json(
        client
            .get(http_url(&handle, "/api/auth/session"))
            .bearer_auth(paired_token)
            .send()
            .await
            .expect("revoked session state"),
        StatusCode::OK,
    )
    .await;
    assert_eq!(revoked_state["authenticated"], false);

    let third_pairing = get_json(
        client
            .post(http_url(&handle, "/api/auth/pairing-token"))
            .bearer_auth(administrator_token)
            .json(&json!({ "label": "Revoke other client" }))
            .send()
            .await
            .expect("third pairing token request"),
        StatusCode::OK,
    )
    .await;
    let third_key = SigningKey::from_bytes((&[41_u8; 32]).into()).expect("third DPoP key");
    let _third = exchange_dpop_token(
        &client,
        &handle,
        third_pairing["credential"]
            .as_str()
            .expect("third credential"),
        &third_key,
        "revoke-other-client-pairing",
    )
    .await;
    let revoked_others = get_json(
        client
            .post(http_url(&handle, "/api/auth/clients/revoke-others"))
            .bearer_auth(administrator_token)
            .json(&json!({}))
            .send()
            .await
            .expect("revoke other clients request"),
        StatusCode::OK,
    )
    .await;
    assert_eq!(revoked_others["revokedCount"], 1);

    shutdown(handle).await;
}

#[tokio::test]
async fn websocket_requires_a_short_lived_ticket_or_request_credential() {
    let temp = TempDir::new().expect("temporary base directory");
    let handle = start_desktop_server(&temp).await;
    let client = Client::new();
    let administrator = exchange_token(&client, &handle, DESKTOP_BOOTSTRAP, None).await;
    let administrator_token = access_token(&administrator);

    let ticket_response = client
        .post(http_url(&handle, "/api/auth/websocket-ticket"))
        .bearer_auth(administrator_token)
        .send()
        .await
        .expect("WebSocket ticket request");
    assert_credential_headers(&ticket_response);
    let ticket = get_json(ticket_response, StatusCode::OK).await;
    let ticket = ticket["ticket"].as_str().expect("WebSocket ticket");

    let (mut socket, _) =
        connect_async(format!("ws://{}/ws?wsTicket={ticket}", handle.local_addr()))
            .await
            .expect("ticket-authenticated WebSocket");
    socket
        .send(tungstenite::Message::Text(
            json!({ "_tag": "Ping" }).to_string().into(),
        ))
        .await
        .expect("send protocol ping");
    let pong = timeout(Duration::from_secs(2), socket.next())
        .await
        .expect("Pong timeout")
        .expect("WebSocket open")
        .expect("valid WebSocket frame");
    assert_eq!(pong.into_text().expect("text Pong"), r#"{"_tag":"Pong"}"#);
    socket.close(None).await.expect("close WebSocket");

    for query in [
        format!("wsTicket={administrator_token}"),
        format!("token={administrator_token}"),
    ] {
        let error = connect_async(format!("ws://{}/ws?{query}", handle.local_addr()))
            .await
            .expect_err("raw session query token must be rejected");
        assert!(matches!(
            error,
            tungstenite::Error::Http(response)
                if response.status() == StatusCode::UNAUTHORIZED
        ));
    }

    shutdown(handle).await;
}

#[tokio::test]
async fn websocket_authorizes_full_administrators_and_streams_auth_access_changes() {
    let temp = TempDir::new().expect("temporary base directory");
    let handle = start_desktop_server(&temp).await;
    let client = Client::new();
    let administrator = exchange_token(&client, &handle, DESKTOP_BOOTSTRAP, None).await;
    let administrator_token = access_token(&administrator);
    let administrator_ticket = websocket_ticket(&client, &handle, administrator_token).await;
    let (mut administrator_socket, _) = connect_async(format!(
        "ws://{}/ws?wsTicket={administrator_ticket}",
        handle.local_addr()
    ))
    .await
    .expect("administrator WebSocket");

    send_ws_json(
        &mut administrator_socket,
        json!({
            "_tag": "Request",
            "id": "101",
            "tag": "subscribeAuthAccess",
            "payload": {},
            "headers": []
        }),
    )
    .await;
    let snapshot = next_ws_json(&mut administrator_socket).await;
    assert_eq!(snapshot["_tag"], "Chunk");
    assert_eq!(snapshot["requestId"], "101");
    assert_eq!(snapshot["values"][0]["type"], "snapshot");
    assert!(
        snapshot["values"][0]["payload"]["clientSessions"]
            .as_array()
            .is_some_and(|sessions| sessions
                .iter()
                .any(|session| session["current"] == true && session["connected"] == true))
    );
    send_ws_json(
        &mut administrator_socket,
        json!({ "_tag": "Ack", "requestId": "101" }),
    )
    .await;

    let pairing = get_json(
        client
            .post(http_url(&handle, "/api/auth/pairing-token"))
            .bearer_auth(administrator_token)
            .json(&json!({ "label": "Full administrator client" }))
            .send()
            .await
            .expect("administrator pairing request"),
        StatusCode::OK,
    )
    .await;
    let upsert = next_ws_json(&mut administrator_socket).await;
    assert_eq!(upsert["_tag"], "Chunk");
    assert_eq!(upsert["values"][0]["type"], "pairingLinkUpserted");
    assert_eq!(upsert["values"][0]["payload"]["id"], pairing["id"]);
    assert!(upsert["values"][0]["payload"].get("credential").is_none());
    assert!(
        upsert["values"][0]["payload"]["credentialFingerprint"]
            .as_str()
            .is_some_and(|value| value.starts_with("sha256:"))
    );
    send_ws_json(
        &mut administrator_socket,
        json!({ "_tag": "Ack", "requestId": "101" }),
    )
    .await;

    let paired_key = SigningKey::from_bytes((&[47_u8; 32]).into()).expect("paired DPoP key");
    let paired = exchange_dpop_token(
        &client,
        &handle,
        pairing["credential"].as_str().expect("pairing credential"),
        &paired_key,
        "websocket-admin-pairing",
    )
    .await;
    for expected_type in ["pairingLinkRemoved", "clientUpserted"] {
        let event = next_ws_json(&mut administrator_socket).await;
        assert_eq!(event["_tag"], "Chunk");
        assert_eq!(event["values"][0]["type"], expected_type);
        send_ws_json(
            &mut administrator_socket,
            json!({ "_tag": "Ack", "requestId": "101" }),
        )
        .await;
    }

    let paired_ticket = dpop_websocket_ticket(
        &client,
        &handle,
        access_token(&paired),
        &paired_key,
        "websocket-admin-ticket",
    )
    .await;
    let (mut paired_socket, _) = connect_async(format!(
        "ws://{}/ws?wsTicket={paired_ticket}",
        handle.local_addr()
    ))
    .await
    .expect("paired administrator WebSocket");
    send_ws_json(
        &mut paired_socket,
        json!({
            "_tag": "Request",
            "id": "102",
            "tag": "server.getConfig",
            "payload": {},
            "headers": []
        }),
    )
    .await;
    let authorized = next_ws_json(&mut paired_socket).await;
    assert_eq!(authorized["_tag"], "Exit");
    assert_eq!(authorized["exit"]["_tag"], "Success");

    let clients = get_json(
        client
            .get(http_url(&handle, "/api/auth/clients"))
            .bearer_auth(administrator_token)
            .send()
            .await
            .expect("client list request"),
        StatusCode::OK,
    )
    .await;
    let paired_session_id = clients
        .as_array()
        .expect("client list")
        .iter()
        .find(|session| session["client"]["label"] == "Full administrator client")
        .and_then(|session| session["sessionId"].as_str())
        .expect("paired session id");
    let revoked = get_json(
        client
            .post(http_url(&handle, "/api/auth/clients/revoke"))
            .bearer_auth(administrator_token)
            .json(&json!({ "sessionId": paired_session_id }))
            .send()
            .await
            .expect("revoke paired administrator"),
        StatusCode::OK,
    )
    .await;
    assert_eq!(revoked["revoked"], true);

    let revoked_frame = timeout(Duration::from_secs(2), paired_socket.next())
        .await
        .expect("revoked WebSocket close timeout");
    assert!(
        matches!(
            revoked_frame,
            None | Some(Ok(tungstenite::Message::Close(_)))
                | Some(Err(tungstenite::Error::ConnectionClosed))
                | Some(Err(tungstenite::Error::AlreadyClosed))
        ),
        "revoked session must close without waiting for another request: {revoked_frame:?}"
    );

    administrator_socket
        .close(None)
        .await
        .expect("close administrator WebSocket");
    shutdown(handle).await;
}
#[tokio::test]
async fn invalid_scope_and_missing_credentials_use_stable_error_shapes() {
    let temp = TempDir::new().expect("temporary base directory");
    let handle = start_desktop_server(&temp).await;
    let client = Client::new();

    let missing = get_json(
        client
            .post(http_url(&handle, "/api/auth/pairing-token"))
            .json(&json!({}))
            .send()
            .await
            .expect("unauthenticated pairing request"),
        StatusCode::UNAUTHORIZED,
    )
    .await;
    assert_eq!(missing["_tag"], "EnvironmentAuthInvalidError");
    assert_eq!(missing["reason"], "missing_credential");

    let administrator = exchange_token(&client, &handle, DESKTOP_BOOTSTRAP, None).await;
    let invalid_scope = get_json(
        client
            .post(http_url(&handle, "/oauth/token"))
            .form(&token_form(
                DESKTOP_BOOTSTRAP,
                Some("orchestration:read unknown:scope"),
            ))
            .send()
            .await
            .expect("invalid scope request"),
        StatusCode::BAD_REQUEST,
    )
    .await;
    assert_eq!(invalid_scope["_tag"], "EnvironmentRequestInvalidError");
    assert_eq!(invalid_scope["reason"], "invalid_scope");

    let invalid_device = get_json(
        client
            .post(http_url(&handle, "/oauth/token"))
            .form(
                &token_form(DESKTOP_BOOTSTRAP, None)
                    .into_iter()
                    .chain([("client_device_type", "game-console")])
                    .collect::<Vec<_>>(),
            )
            .send()
            .await
            .expect("invalid client device request"),
        StatusCode::BAD_REQUEST,
    )
    .await;
    assert_eq!(invalid_device["_tag"], "EnvironmentRequestInvalidError");

    let empty_label = get_json(
        client
            .post(http_url(&handle, "/api/auth/pairing-token"))
            .bearer_auth(access_token(&administrator))
            .json(&json!({ "label": "   " }))
            .send()
            .await
            .expect("empty pairing label request"),
        StatusCode::BAD_REQUEST,
    )
    .await;
    assert_eq!(empty_label["_tag"], "EnvironmentRequestInvalidError");

    let legacy_permission_levels = client
        .post(http_url(&handle, "/api/auth/pairing-token"))
        .bearer_auth(access_token(&administrator))
        .json(&json!({
            "label": "Misleading limited client",
            "scopes": ["orchestration:read"]
        }))
        .send()
        .await
        .expect("legacy permission-level pairing request");
    assert_eq!(
        legacy_permission_levels.status(),
        StatusCode::UNPROCESSABLE_ENTITY
    );

    let malformed_token = get_json(
        client
            .post(http_url(&handle, "/api/auth/websocket-ticket"))
            .bearer_auth("malformed.session.token")
            .send()
            .await
            .expect("malformed token request"),
        StatusCode::UNAUTHORIZED,
    )
    .await;
    assert_eq!(malformed_token["_tag"], "EnvironmentAuthInvalidError");
    assert_eq!(malformed_token["reason"], "invalid_credential");

    shutdown(handle).await;
}

#[tokio::test]
async fn dpop_tokens_validate_proof_binding_time_and_replay() {
    let temp = TempDir::new().expect("temporary base directory");
    let handle = start_desktop_server(&temp).await;
    let client = Client::new();
    let signing_key = SigningKey::from_bytes((&[7_u8; 32]).into()).expect("fixture signing key");
    let token_url = http_url(&handle, "/oauth/token");
    let issued_at = unix_seconds();
    let proof = dpop_proof(
        &signing_key,
        "POST",
        &token_url,
        "token-proof-1",
        issued_at,
        None,
    );
    let response = client
        .post(&token_url)
        .header("dpop", &proof)
        .form(&token_form(DESKTOP_BOOTSTRAP, None))
        .send()
        .await
        .expect("DPoP token exchange");
    assert_credential_headers(&response);
    let issued = get_json(response, StatusCode::OK).await;
    assert_eq!(issued["token_type"], "DPoP");
    let access_token = access_token(&issued);

    let proxied_proof = dpop_proof(
        &signing_key,
        "POST",
        &token_url.replacen("http://", "https://", 1),
        "proxied-token-proof",
        unix_seconds(),
        None,
    );
    let proxied = client
        .post(&token_url)
        .header("x-forwarded-proto", "https")
        .header("dpop", proxied_proof)
        .form(&token_form(DESKTOP_BOOTSTRAP, None))
        .send()
        .await
        .expect("reverse-proxied DPoP token exchange");
    assert_eq!(proxied.status(), StatusCode::OK);

    let ticket_url = http_url(&handle, "/api/auth/websocket-ticket");
    let request_proof = dpop_proof(
        &signing_key,
        "POST",
        &ticket_url,
        "request-proof-1",
        unix_seconds(),
        Some(access_token),
    );
    let ticket_response = client
        .post(&ticket_url)
        .header(header::AUTHORIZATION, format!("DPoP {access_token}"))
        .header("dpop", &request_proof)
        .send()
        .await
        .expect("proof-bound ticket request");
    assert_eq!(ticket_response.status(), StatusCode::OK);

    let replay = client
        .post(&ticket_url)
        .header(header::AUTHORIZATION, format!("DPoP {access_token}"))
        .header("dpop", &request_proof)
        .send()
        .await
        .expect("replayed DPoP request");
    assert_eq!(replay.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(
        replay.headers().get(header::WWW_AUTHENTICATE),
        Some(&header::HeaderValue::from_static("DPoP"))
    );

    let bearer_misuse = client
        .post(&ticket_url)
        .bearer_auth(access_token)
        .send()
        .await
        .expect("Bearer misuse request");
    assert_eq!(bearer_misuse.status(), StatusCode::UNAUTHORIZED);

    let wrong_method = dpop_proof(
        &signing_key,
        "GET",
        &ticket_url,
        "wrong-method-proof",
        unix_seconds(),
        Some(access_token),
    );
    let wrong_method_response = client
        .post(&ticket_url)
        .header(header::AUTHORIZATION, format!("DPoP {access_token}"))
        .header("dpop", wrong_method)
        .send()
        .await
        .expect("wrong-method DPoP request");
    assert_eq!(wrong_method_response.status(), StatusCode::UNAUTHORIZED);

    let wrong_hash = dpop_proof(
        &signing_key,
        "POST",
        &ticket_url,
        "wrong-hash-proof",
        unix_seconds(),
        Some("a-different-access-token"),
    );
    let wrong_hash_response = client
        .post(&ticket_url)
        .header(header::AUTHORIZATION, format!("DPoP {access_token}"))
        .header("dpop", wrong_hash)
        .send()
        .await
        .expect("wrong-hash DPoP request");
    assert_eq!(wrong_hash_response.status(), StatusCode::UNAUTHORIZED);

    let future = dpop_proof(
        &signing_key,
        "POST",
        &token_url,
        "future-proof",
        unix_seconds() + 60,
        None,
    );
    let future_response = client
        .post(&token_url)
        .header("dpop", future)
        .form(&token_form(DESKTOP_BOOTSTRAP, None))
        .send()
        .await
        .expect("future DPoP request");
    assert_eq!(future_response.status(), StatusCode::UNAUTHORIZED);

    let stale = dpop_proof(
        &signing_key,
        "POST",
        &token_url,
        "stale-proof",
        unix_seconds() - 301,
        None,
    );
    let stale_response = client
        .post(&token_url)
        .header("dpop", stale)
        .form(&token_form(DESKTOP_BOOTSTRAP, None))
        .send()
        .await
        .expect("stale DPoP request");
    assert_eq!(stale_response.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(
        stale_response.headers().get(header::WWW_AUTHENTICATE),
        Some(&header::HeaderValue::from_static("DPoP"))
    );

    shutdown(handle).await;
}

#[tokio::test]
async fn pairing_exchange_is_hashed_dpop_bound_idempotent_and_metadata_only() {
    let temp = TempDir::new().expect("temporary base directory");
    let handle = start_desktop_server(&temp).await;
    let client = Client::new();
    let administrator = exchange_token(&client, &handle, DESKTOP_BOOTSTRAP, None).await;
    let pairing = get_json(
        client
            .post(http_url(&handle, "/api/auth/pairing-token"))
            .bearer_auth(access_token(&administrator))
            .json(&json!({ "label": "DPoP laptop" }))
            .send()
            .await
            .expect("pairing request"),
        StatusCode::OK,
    )
    .await;
    let pairing_id = pairing["id"].as_str().expect("pairing id");
    let credential = pairing["credential"]
        .as_str()
        .expect("one-time pairing credential")
        .to_owned();

    let links_response = client
        .get(http_url(&handle, "/api/auth/pairing-links"))
        .bearer_auth(access_token(&administrator))
        .send()
        .await
        .expect("pairing list request");
    let links_body = links_response.text().await.expect("pairing list body");
    assert!(!links_body.contains(&credential));
    let links: Value = serde_json::from_str(&links_body).expect("pairing list JSON");
    let listed = links
        .as_array()
        .and_then(|items| items.iter().find(|item| item["id"] == pairing_id))
        .expect("issued pairing is listed");
    assert!(
        listed["credentialFingerprint"]
            .as_str()
            .is_some_and(|fingerprint| fingerprint.starts_with("sha256:"))
    );
    assert_eq!(listed["clientLabel"], "DPoP laptop");
    for forbidden in ["credential", "scopes", "subject", "label"] {
        assert!(
            listed.get(forbidden).is_none(),
            "forbidden field {forbidden}"
        );
    }

    let first_key = SigningKey::from_bytes((&[19_u8; 32]).into()).expect("first DPoP key");
    let second_key = SigningKey::from_bytes((&[23_u8; 32]).into()).expect("second DPoP key");
    let first = exchange_dpop_token(
        &client,
        &handle,
        &credential,
        &first_key,
        "pairing-exchange-1",
    )
    .await;
    assert_eq!(first["token_type"], "DPoP");
    let retry = exchange_dpop_token(
        &client,
        &handle,
        &credential,
        &first_key,
        "pairing-exchange-2",
    )
    .await;
    assert_eq!(access_token(&first), access_token(&retry));

    let different_key = send_dpop_token_exchange(
        &client,
        &handle,
        &credential,
        &second_key,
        "pairing-exchange-different-key",
    )
    .await;
    assert_eq!(different_key.status(), StatusCode::UNAUTHORIZED);
    let different_key_error = different_key
        .text()
        .await
        .expect("different-key error body");
    assert!(!different_key_error.contains(&credential));
    let no_proof = client
        .post(http_url(&handle, "/oauth/token"))
        .form(&token_form(&credential, None))
        .send()
        .await
        .expect("unconstrained pairing exchange");
    assert_eq!(no_proof.status(), StatusCode::UNAUTHORIZED);

    let ticket = dpop_websocket_ticket(
        &client,
        &handle,
        access_token(&first),
        &first_key,
        "pairing-ticket-proof",
    )
    .await;
    let (mut socket, _) =
        connect_async(format!("ws://{}/ws?wsTicket={ticket}", handle.local_addr()))
            .await
            .expect("first ticket use");
    socket.close(None).await.expect("close first socket");
    let replayed_ticket =
        connect_async(format!("ws://{}/ws?wsTicket={ticket}", handle.local_addr()))
            .await
            .expect_err("WebSocket ticket is one-use");
    assert!(matches!(
        replayed_ticket,
        tungstenite::Error::Http(response)
            if response.status() == StatusCode::UNAUTHORIZED
    ));

    shutdown(handle).await;
    for entry in std::fs::read_dir(temp.path().join("userdata")).expect("userdata directory") {
        let path = entry.expect("userdata entry").path();
        if path.is_file() {
            let bytes = std::fs::read(&path).expect("state artifact bytes");
            assert!(
                !bytes
                    .windows(credential.len())
                    .any(|window| window == credential.as_bytes()),
                "raw pairing credential leaked into {}",
                path.display()
            );
        }
    }
}

#[tokio::test]
async fn dpop_replay_state_survives_a_server_restart() {
    let temp = TempDir::new().expect("temporary base directory");
    let first_config = ServerConfig::new(temp.path())
        .with_bind("127.0.0.1", 0)
        .with_desktop(DESKTOP_BOOTSTRAP)
        .expect("desktop config");
    let first = ServerRuntime::start_with_registry(first_config, RpcRegistry::empty())
        .await
        .expect("first server starts");
    let port = first.local_addr().port();
    let token_url = http_url(&first, "/oauth/token");
    let signing_key = SigningKey::from_bytes((&[11_u8; 32]).into()).expect("fixture signing key");
    let proof = dpop_proof(
        &signing_key,
        "POST",
        &token_url,
        "restart-replay-proof",
        unix_seconds(),
        None,
    );
    let client = Client::new();
    let accepted = client
        .post(&token_url)
        .header("dpop", &proof)
        .form(&token_form(DESKTOP_BOOTSTRAP, None))
        .send()
        .await
        .expect("first DPoP request");
    assert_eq!(accepted.status(), StatusCode::OK);
    shutdown(first).await;

    let second_config = ServerConfig::new(temp.path())
        .with_bind("127.0.0.1", port)
        .with_desktop(DESKTOP_BOOTSTRAP)
        .expect("desktop config");
    let second = ServerRuntime::start_with_registry(second_config, RpcRegistry::empty())
        .await
        .expect("second server starts");
    let replayed = client
        .post(http_url(&second, "/oauth/token"))
        .header("dpop", proof)
        .form(&token_form(DESKTOP_BOOTSTRAP, None))
        .send()
        .await
        .expect("replayed DPoP request after restart");
    assert_eq!(replayed.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(
        replayed.headers().get(header::WWW_AUTHENTICATE),
        Some(&header::HeaderValue::from_static("DPoP"))
    );
    shutdown(second).await;
}

#[tokio::test]
async fn sessions_pairings_consumption_and_revocation_survive_restarts() {
    let temp = TempDir::new().expect("temporary base directory");
    let client = Client::new();
    let first = start_desktop_server(&temp).await;
    let administrator = exchange_token(&client, &first, DESKTOP_BOOTSTRAP, None).await;
    let administrator_token = access_token(&administrator).to_owned();
    let pairing = get_json(
        client
            .post(http_url(&first, "/api/auth/pairing-token"))
            .bearer_auth(&administrator_token)
            .json(&json!({ "label": "Restarted client" }))
            .send()
            .await
            .expect("persistent pairing request"),
        StatusCode::OK,
    )
    .await;
    let pairing_id = pairing["id"].as_str().expect("pairing id").to_owned();
    let pairing_credential = pairing["credential"]
        .as_str()
        .expect("pairing credential")
        .to_owned();
    shutdown(first).await;

    let second = start_desktop_server(&temp).await;
    let restored_administrator = get_json(
        client
            .get(http_url(&second, "/api/auth/session"))
            .bearer_auth(&administrator_token)
            .send()
            .await
            .expect("restored administrator request"),
        StatusCode::OK,
    )
    .await;
    assert_eq!(restored_administrator["authenticated"], true);
    let restored_pairings = get_json(
        client
            .get(http_url(&second, "/api/auth/pairing-links"))
            .bearer_auth(&administrator_token)
            .send()
            .await
            .expect("restored pairing list"),
        StatusCode::OK,
    )
    .await;
    assert!(
        restored_pairings
            .as_array()
            .is_some_and(|items| items.iter().any(|item| item["id"] == pairing_id))
    );

    let paired_key = SigningKey::from_bytes((&[43_u8; 32]).into()).expect("restart DPoP key");
    let paired = exchange_dpop_token(
        &client,
        &second,
        &pairing_credential,
        &paired_key,
        "restart-pairing-exchange",
    )
    .await;
    let paired_token = access_token(&paired).to_owned();
    let clients = get_json(
        client
            .get(http_url(&second, "/api/auth/clients"))
            .bearer_auth(&administrator_token)
            .send()
            .await
            .expect("client list after restored pairing exchange"),
        StatusCode::OK,
    )
    .await;
    let paired_session_id = clients
        .as_array()
        .expect("client list")
        .iter()
        .find(|session| session["client"]["label"] == "Restarted client")
        .and_then(|session| session["sessionId"].as_str())
        .expect("paired session id");
    let revoked = get_json(
        client
            .post(http_url(&second, "/api/auth/clients/revoke"))
            .bearer_auth(&administrator_token)
            .json(&json!({ "sessionId": paired_session_id }))
            .send()
            .await
            .expect("persistent client revocation"),
        StatusCode::OK,
    )
    .await;
    assert_eq!(revoked["revoked"], true);
    shutdown(second).await;

    let third = start_desktop_server(&temp).await;
    let revoked_session = get_json(
        client
            .get(http_url(&third, "/api/auth/session"))
            .bearer_auth(&paired_token)
            .send()
            .await
            .expect("revoked session after second restart"),
        StatusCode::OK,
    )
    .await;
    assert_eq!(revoked_session["authenticated"], false);
    let consumed_pairing = send_dpop_token_exchange(
        &client,
        &third,
        &pairing_credential,
        &paired_key,
        "revoked-receipt-retry",
    )
    .await;
    assert_eq!(consumed_pairing.status(), StatusCode::UNAUTHORIZED);
    shutdown(third).await;
}

#[tokio::test]
async fn a_second_live_server_cannot_share_one_environment_control_endpoint() {
    let temp = TempDir::new().expect("temporary base directory");
    let first = start_desktop_server(&temp).await;
    let second_config = ServerConfig::new(temp.path())
        .with_bind("127.0.0.1", 0)
        .with_desktop(DESKTOP_BOOTSTRAP)
        .expect("desktop config");
    let second = ServerRuntime::start_with_registry(second_config, RpcRegistry::empty()).await;
    let error = match second {
        Ok(second) => {
            shutdown(second).await;
            panic!("one environment has one protected local-control owner");
        }
        Err(error) => error,
    };
    assert!(
        error
            .to_string()
            .contains("another BiBCode control endpoint is already active")
    );

    let client = Client::new();
    let session = exchange_token(&client, &first, DESKTOP_BOOTSTRAP, None).await;
    assert_eq!(session["token_type"], "Bearer");
    shutdown(first).await;
}

#[tokio::test]
async fn simultaneous_live_server_starts_admit_exactly_one_control_owner() {
    let temp = TempDir::new().expect("temporary base directory");
    let initialized = start_desktop_server(&temp).await;
    shutdown(initialized).await;

    let first_config = ServerConfig::new(temp.path())
        .with_bind("127.0.0.1", 0)
        .with_desktop(DESKTOP_BOOTSTRAP)
        .expect("first desktop config");
    let second_config = ServerConfig::new(temp.path())
        .with_bind("127.0.0.1", 0)
        .with_desktop(DESKTOP_BOOTSTRAP)
        .expect("second desktop config");
    let (first, second) = tokio::join!(
        ServerRuntime::start_with_registry(first_config, RpcRegistry::empty()),
        ServerRuntime::start_with_registry(second_config, RpcRegistry::empty())
    );
    match (first, second) {
        (Ok(winner), Err(_)) | (Err(_), Ok(winner)) => shutdown(winner).await,
        (Ok(first), Ok(second)) => {
            shutdown(second).await;
            shutdown(first).await;
            panic!("only one protected control owner may start");
        }
        (Err(first), Err(second)) => {
            panic!("one simultaneous starter must win: {first}; {second}")
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn server_starts_while_live_store_is_continuously_committed_and_checkpointed() {
    let temp = TempDir::new().expect("temporary base directory");
    let first = start_desktop_server(&temp).await;
    let client = Client::new();
    let administrator = exchange_token(&client, &first, DESKTOP_BOOTSTRAP, None).await;
    let administrator_token = access_token(&administrator).to_owned();
    let database_path = temp.path().join("userdata/state.sqlite");
    let setup = Connection::open(&database_path).expect("live-store churn setup");
    setup
        .execute_batch(
            "CREATE TABLE validation_startup_churn (
               singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
               revision INTEGER NOT NULL,
               padding BLOB NOT NULL
             );
             INSERT INTO validation_startup_churn (singleton, revision, padding)
               VALUES (1, 0, zeroblob(1048576));",
        )
        .expect("multi-batch live-store churn table");
    drop(setup);
    let stop = Arc::new(AtomicBool::new(false));
    let writer_stop = Arc::clone(&stop);
    let startup_started = Arc::new(AtomicBool::new(false));
    let writer_startup_started = Arc::clone(&startup_started);
    let startup_finished = Arc::new(AtomicBool::new(false));
    let writer_startup_finished = Arc::clone(&startup_finished);
    let checkpoints_during_startup = Arc::new(AtomicUsize::new(0));
    let writer_checkpoints_during_startup = Arc::clone(&checkpoints_during_startup);
    let (checkpoint_ready, checkpoint_observed) = std::sync::mpsc::sync_channel(1);

    let writer = std::thread::spawn(move || {
        let checkpoint = Connection::open(database_path).expect("checkpoint connection");
        checkpoint
            .busy_timeout(Duration::from_secs(1))
            .expect("checkpoint busy timeout");
        let mut checkpoint_ready = Some(checkpoint_ready);
        let mut successful_checkpoints = 0_usize;
        let mut ordinal = 0_i64;
        while !writer_stop.load(Ordering::Acquire) || ordinal < 2 {
            let cycle_started_before_startup_finished =
                !writer_startup_finished.load(Ordering::Acquire);
            checkpoint
                .execute(
                    "UPDATE validation_startup_churn SET revision = ?1 WHERE singleton = 1",
                    [ordinal],
                )
                .expect("live-store commit");
            let checkpoint_result = checkpoint
                .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
                    row.get::<_, i64>(0)
                })
                .expect("live-store checkpoint");
            if checkpoint_result == 0 {
                successful_checkpoints += 1;
                // Compare interval boundaries instead of sampling one in-progress flag here.
                // A checkpoint may begin before startup and finish after a fast startup has
                // completed; that cycle still overlaps startup and must not be missed.
                if cycle_started_before_startup_finished
                    && writer_startup_started.load(Ordering::Acquire)
                {
                    writer_checkpoints_during_startup.fetch_add(1, Ordering::AcqRel);
                }
                if let Some(ready) = checkpoint_ready.take() {
                    ready.send(()).expect("signal first checkpoint");
                }
            }
            ordinal += 1;
            std::thread::yield_now();
        }
        successful_checkpoints
    });
    checkpoint_observed
        .recv_timeout(Duration::from_secs(5))
        .expect("initial checkpoint signal");

    startup_started.store(true, Ordering::Release);
    let second_config = ServerConfig::new(temp.path())
        .with_bind("127.0.0.1", 0)
        .with_desktop(DESKTOP_BOOTSTRAP)
        .expect("second desktop config");
    let second = ServerRuntime::start_with_registry(second_config, RpcRegistry::empty()).await;
    startup_finished.store(true, Ordering::Release);
    stop.store(true, Ordering::Release);
    let successful_checkpoints = writer.join().expect("live-store writer thread");
    assert!(
        successful_checkpoints >= 2,
        "writer must checkpoint before and during concurrent startup"
    );
    assert!(
        checkpoints_during_startup.load(Ordering::Acquire) > 0,
        "at least one commit/checkpoint cycle overlaps the rejected startup"
    );
    assert!(
        second.is_err(),
        "live environment control ownership rejects a second server"
    );
    let accepted_by_first = get_json(
        client
            .get(http_url(&first, "/api/auth/session"))
            .bearer_auth(&administrator_token)
            .send()
            .await
            .expect("first server remains available"),
        StatusCode::OK,
    )
    .await;
    assert_eq!(accepted_by_first["authenticated"], true);

    shutdown(first).await;
}

#[tokio::test]
async fn auth_routes_include_browser_cors_and_preflight_headers() {
    let temp = TempDir::new().expect("temporary base directory");
    let handle = start_desktop_server(&temp).await;
    let client = Client::new();
    let origin = "https://client.example.test";

    let session = client
        .get(http_url(&handle, "/api/auth/session"))
        .header(header::ORIGIN, origin)
        .send()
        .await
        .expect("CORS session request");
    assert_eq!(
        session.headers().get(header::ACCESS_CONTROL_ALLOW_ORIGIN),
        Some(&header::HeaderValue::from_static("*"))
    );

    let preflight = client
        .request(
            reqwest::Method::OPTIONS,
            http_url(&handle, "/api/auth/websocket-ticket"),
        )
        .header(header::ORIGIN, origin)
        .header(header::ACCESS_CONTROL_REQUEST_METHOD, "POST")
        .header(
            header::ACCESS_CONTROL_REQUEST_HEADERS,
            "authorization, content-type, dpop",
        )
        .send()
        .await
        .expect("CORS preflight request");
    assert_eq!(preflight.status(), StatusCode::OK);
    assert_eq!(
        preflight.headers().get(header::ACCESS_CONTROL_ALLOW_ORIGIN),
        Some(&header::HeaderValue::from_static("*"))
    );
    let allowed_headers = preflight
        .headers()
        .get(header::ACCESS_CONTROL_ALLOW_HEADERS)
        .and_then(|value| value.to_str().ok())
        .expect("allowed headers");
    for expected in ["authorization", "content-type", "dpop"] {
        assert!(allowed_headers.contains(expected));
    }

    shutdown(handle).await;
}

async fn start_desktop_server(temp: &TempDir) -> ServerHandle {
    let config = ServerConfig::new(temp.path())
        .with_bind("127.0.0.1", 0)
        .with_desktop(DESKTOP_BOOTSTRAP)
        .expect("valid desktop configuration");
    let mut registry = RpcRegistry::empty();
    registry.register_unary("server.getConfig", |_request, _cancellation| async {
        Ok(json!({}))
    });
    registry.register_unary(
        "server.consumeCodexRateLimitReset",
        |_request, _cancellation| async {
            Err(json!({
                "_tag": "ServerProviderUsageResetError",
                "message": "Codex reset request ID is required.",
            }))
        },
    );
    for tag in [
        "activity.getSnapshot",
        "activity.listRoster",
        "activity.listDetail",
        "activity.cancelSubtree",
        "activity.retrySubtreeCancellation",
    ] {
        let response_tag = tag.to_owned();
        registry.register_unary(tag, move |_request, _cancellation| {
            let response_tag = response_tag.clone();
            async move { Ok(json!({ "tag": response_tag })) }
        });
    }
    registry.register_stream("subscribeActivity", |_request, _cancellation| {
        let (sender, receiver) = tokio::sync::mpsc::channel(1);
        sender
            .try_send(Ok(vec![json!({ "tag": "subscribeActivity" })]))
            .expect("activity fixture chunk");
        receiver
    });
    ServerRuntime::start_with_registry(config, registry)
        .await
        .expect("server starts")
}

fn http_url(handle: &ServerHandle, path: &str) -> String {
    format!("http://{}{}", handle.local_addr(), path)
}

fn token_form<'a>(credential: &'a str, scope: Option<&'a str>) -> Vec<(&'a str, &'a str)> {
    let mut form = vec![
        ("grant_type", TOKEN_GRANT_TYPE),
        ("subject_token", credential),
        ("subject_token_type", BOOTSTRAP_TOKEN_TYPE),
        ("requested_token_type", ACCESS_TOKEN_TYPE),
    ];
    if let Some(scope) = scope {
        form.push(("scope", scope));
    }
    form
}

async fn exchange_token(
    client: &Client,
    handle: &ServerHandle,
    credential: &str,
    scope: Option<&str>,
) -> Value {
    let response = client
        .post(http_url(handle, "/oauth/token"))
        .form(&token_form(credential, scope))
        .send()
        .await
        .expect("token exchange request");
    assert_credential_headers(&response);
    get_json(response, StatusCode::OK).await
}

async fn send_dpop_token_exchange(
    client: &Client,
    handle: &ServerHandle,
    credential: &str,
    signing_key: &SigningKey,
    jti: &str,
) -> Response {
    let token_url = http_url(handle, "/oauth/token");
    let proof = dpop_proof(signing_key, "POST", &token_url, jti, unix_seconds(), None);
    client
        .post(token_url)
        .header("dpop", proof)
        .form(&token_form(credential, None))
        .send()
        .await
        .expect("DPoP token exchange request")
}

async fn exchange_dpop_token(
    client: &Client,
    handle: &ServerHandle,
    credential: &str,
    signing_key: &SigningKey,
    jti: &str,
) -> Value {
    let response = send_dpop_token_exchange(client, handle, credential, signing_key, jti).await;
    assert_credential_headers(&response);
    get_json(response, StatusCode::OK).await
}

async fn dpop_websocket_ticket(
    client: &Client,
    handle: &ServerHandle,
    access_token: &str,
    signing_key: &SigningKey,
    jti: &str,
) -> String {
    let url = http_url(handle, "/api/auth/websocket-ticket");
    let proof = dpop_proof(
        signing_key,
        "POST",
        &url,
        jti,
        unix_seconds(),
        Some(access_token),
    );
    let response = client
        .post(url)
        .header(header::AUTHORIZATION, format!("DPoP {access_token}"))
        .header("dpop", proof)
        .send()
        .await
        .expect("DPoP WebSocket ticket request");
    get_json(response, StatusCode::OK).await["ticket"]
        .as_str()
        .expect("WebSocket ticket")
        .to_owned()
}

async fn websocket_ticket(client: &Client, handle: &ServerHandle, token: &str) -> String {
    let response = client
        .post(http_url(handle, "/api/auth/websocket-ticket"))
        .bearer_auth(token)
        .send()
        .await
        .expect("WebSocket ticket request");
    get_json(response, StatusCode::OK).await["ticket"]
        .as_str()
        .expect("WebSocket ticket")
        .to_owned()
}

async fn send_ws_json<S>(socket: &mut tokio_tungstenite::WebSocketStream<S>, value: Value)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    socket
        .send(tungstenite::Message::Text(value.to_string().into()))
        .await
        .expect("send WebSocket JSON");
}

async fn next_ws_json<S>(socket: &mut tokio_tungstenite::WebSocketStream<S>) -> Value
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let frame = timeout(Duration::from_secs(2), socket.next())
        .await
        .expect("WebSocket response timeout")
        .expect("WebSocket remains open")
        .expect("valid WebSocket frame");
    serde_json::from_str(frame.to_text().expect("text WebSocket frame"))
        .expect("valid WebSocket JSON")
}

fn access_token(response: &Value) -> &str {
    response["access_token"].as_str().expect("access token")
}

fn assert_credential_headers(response: &Response) {
    assert_eq!(
        response.headers().get(header::CACHE_CONTROL),
        Some(&header::HeaderValue::from_static("no-store"))
    );
    assert_eq!(
        response.headers().get(header::PRAGMA),
        Some(&header::HeaderValue::from_static("no-cache"))
    );
}

async fn get_json(response: Response, expected_status: StatusCode) -> Value {
    let actual_status = response.status();
    let body = response.text().await.expect("HTTP response body");
    assert_eq!(
        actual_status, expected_status,
        "unexpected HTTP response body: {body}"
    );
    serde_json::from_str(&body).expect("JSON response")
}

async fn shutdown(handle: ServerHandle) {
    handle.shutdown();
    timeout(Duration::from_secs(2), handle.join())
        .await
        .expect("server shutdown timeout")
        .expect("server joins");
}

fn unix_seconds() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock after epoch")
        .as_secs()
        .try_into()
        .expect("fixture timestamp fits i64")
}

fn dpop_proof(
    signing_key: &SigningKey,
    method: &str,
    url: &str,
    jti: &str,
    issued_at: i64,
    access_token: Option<&str>,
) -> String {
    let point = signing_key.verifying_key().to_sec1_point(false);
    let header = json!({
        "typ": "dpop+jwt",
        "alg": "ES256",
        "jwk": {
            "kty": "EC",
            "crv": "P-256",
            "x": URL_SAFE_NO_PAD.encode(point.x().expect("P-256 x coordinate")),
            "y": URL_SAFE_NO_PAD.encode(point.y().expect("P-256 y coordinate")),
        }
    });
    let mut payload = json!({
        "htm": method,
        "htu": normalize_dpop_url(url),
        "jti": jti,
        "iat": issued_at,
    });
    if let Some(access_token) = access_token {
        payload["ath"] = json!(URL_SAFE_NO_PAD.encode(Sha256::digest(access_token.as_bytes())));
    }
    let header = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&header).expect("DPoP header JSON"));
    let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).expect("DPoP payload JSON"));
    let signing_input = format!("{header}.{payload}");
    let digest = Sha256::digest(signing_input.as_bytes());
    let signature: Signature = signing_key
        .sign_prehash(&digest)
        .expect("sign DPoP fixture");
    format!(
        "{signing_input}.{}",
        URL_SAFE_NO_PAD.encode(signature.to_bytes())
    )
}

fn normalize_dpop_url(url: &str) -> String {
    let mut url = url::Url::parse(url).expect("fixture URL");
    url.set_query(None);
    url.set_fragment(None);
    url.to_string()
}

fn auth_fixture_directory() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages/contracts/fixtures/auth-http")
}
