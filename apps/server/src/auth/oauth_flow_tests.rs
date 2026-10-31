//! Remote MCP's OAuth (#139, slice R) against a real BiBCode server on loopback: discovery,
//! registration, authorization with approval in BiBCode, the code exchange, `/mcp` calls,
//! refresh with strict reuse detection, the off switch and admission.

use std::path::Path;

use reqwest::{Client, StatusCode, header, redirect::Policy};
use serde_json::{Value, json};

use super::oauth::s256;
use crate::{ServerConfig, ServerHandle, ServerRuntime, persistence::Repositories};

const VERIFIER: &str = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const REDIRECT: &str = "http://127.0.0.1:53682/callback";

async fn start_server(root: &Path, overlay: Value) -> ServerHandle {
    let providers = crate::test_support::hermetic_providers::BUILTIN_PROVIDER_DRIVERS
        .iter()
        .map(|driver| ((*driver).to_owned(), json!({ "enabled": false })))
        .collect::<serde_json::Map<String, Value>>();
    let mut settings = json!({ "providers": providers });
    if let (Some(settings), Some(overlay)) = (settings.as_object_mut(), overlay.as_object()) {
        for (key, value) in overlay {
            settings.insert(key.clone(), value.clone());
        }
    }
    crate::test_support::hermetic_providers::write_hermetic_settings(
        &ServerConfig::new(root).state_dir(),
        settings,
    );
    ServerRuntime::start(ServerConfig::new(root).with_bind("127.0.0.1", 0))
        .await
        .expect("server starts")
}

async fn repositories(root: &Path) -> (Repositories, crate::persistence::Database) {
    let database =
        crate::persistence::Database::open_existing(ServerConfig::new(root).database_path())
            .await
            .expect("database");
    (Repositories::new(database.clone()), database)
}

fn client() -> Client {
    Client::builder().redirect(Policy::none()).build().unwrap()
}

/// A bearer with every administrative scope, as `bibcode pairing issue` grants one.
async fn administrator(root: &Path, base: &str) -> String {
    let (repositories, database) = repositories(root).await;
    let link = super::issue_administrative_pairing_link(&repositories, None)
        .await
        .unwrap();
    database.close().await;
    exchange(base, &link.credential, None).await
}

async fn exchange(base: &str, credential: &str, scope: Option<&str>) -> String {
    let mut form = vec![
        ("grant_type", super::TOKEN_GRANT_TYPE),
        ("subject_token", credential),
        ("subject_token_type", super::BOOTSTRAP_TOKEN_TYPE),
        ("requested_token_type", super::ACCESS_TOKEN_TYPE),
    ];
    if let Some(scope) = scope {
        form.push(("scope", scope));
    }
    let answer: Value = client()
        .post(format!("{base}/oauth/token"))
        .form(&form)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    answer["access_token"].as_str().unwrap().to_owned()
}

async fn register(base: &str, forwarded_for: Option<&str>) -> reqwest::Response {
    let mut request = client()
        .post(format!("{base}/oauth/register"))
        .json(&json!({
            "client_name": "Codex",
            "redirect_uris": [REDIRECT],
            "token_endpoint_auth_method": "none",
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
        }));
    if let Some(forwarded_for) = forwarded_for {
        request = request.header("x-forwarded-for", forwarded_for);
    }
    request.send().await.unwrap()
}

async fn client_id(base: &str, forwarded_for: Option<&str>) -> String {
    let registered = register(base, forwarded_for).await;
    assert_eq!(registered.status(), StatusCode::CREATED);
    let body: Value = registered.json().await.unwrap();
    assert_eq!(body["token_endpoint_auth_method"], "none");
    body["client_id"].as_str().unwrap().to_owned()
}

fn authorize_url(base: &str, client_id: &str, extra: &[(&str, &str)]) -> String {
    let mut url = url::Url::parse(&format!("{base}/oauth/authorize")).unwrap();
    {
        let mut query = url.query_pairs_mut();
        query
            .append_pair("response_type", "code")
            .append_pair("client_id", client_id)
            .append_pair("redirect_uri", "http://127.0.0.1:61000/callback")
            .append_pair("code_challenge", &s256(VERIFIER))
            .append_pair("code_challenge_method", "S256")
            .append_pair("state", "xyz")
            .append_pair("resource", &format!("{base}/mcp"));
        for (name, value) in extra {
            query.append_pair(name, value);
        }
    }
    url.into()
}

/// A pending authorization: its id and the status cookie the consent page set.
struct Pending {
    id: String,
    cookie: String,
}

async fn authorize(url: &str, forwarded_for: Option<&str>) -> reqwest::Response {
    let mut request = client().get(url);
    if let Some(forwarded_for) = forwarded_for {
        request = request.header("x-forwarded-for", forwarded_for);
    }
    request.send().await.unwrap()
}

async fn pending(base: &str, client_id: &str) -> Pending {
    let response = authorize(&authorize_url(base, client_id, &[]), None).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::X_FRAME_OPTIONS], "DENY");
    let cookie = response.headers()[header::SET_COOKIE]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let page = response.text().await.unwrap();
    let id = page
        .split("status?id=")
        .nth(1)
        .unwrap()
        .split('"')
        .next()
        .unwrap()
        .to_owned();
    Pending { id, cookie }
}

async fn status(base: &str, pending: &Pending) -> reqwest::Response {
    client()
        .get(format!("{base}/oauth/authorize/status?id={}", pending.id))
        .header(header::COOKIE, &pending.cookie)
        .send()
        .await
        .unwrap()
}

async fn approve(base: &str, bearer: &str, body: Value) -> reqwest::Response {
    client()
        .post(format!("{base}/api/auth/mcp-authorizations/approve"))
        .bearer_auth(bearer)
        .json(&body)
        .send()
        .await
        .unwrap()
}

/// The code the status poll redirects with, after the person approved.
async fn approved_code(base: &str, admin: &str, client_id: &str) -> String {
    let pending = pending(base, client_id).await;
    assert_eq!(
        approve(
            base,
            admin,
            json!({ "id": pending.id, "access": "approval-required" })
        )
        .await
        .status(),
        StatusCode::OK
    );
    let redirected = status(base, &pending).await;
    assert_eq!(redirected.status(), StatusCode::SEE_OTHER);
    let location =
        url::Url::parse(redirected.headers()[header::LOCATION].to_str().unwrap()).unwrap();
    let query = location
        .query_pairs()
        .into_owned()
        .collect::<std::collections::HashMap<_, _>>();
    assert_eq!(query["state"], "xyz");
    assert_eq!(query["iss"], base);
    assert_eq!(
        location.port(),
        Some(61000),
        "the port the client asked for"
    );
    query["code"].clone()
}

async fn token(base: &str, form: &[(&str, &str)]) -> (StatusCode, Value) {
    let response = client()
        .post(format!("{base}/oauth/token"))
        .form(form)
        .send()
        .await
        .unwrap();
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    let status = response.status();
    (status, response.json().await.unwrap())
}

async fn exchange_code(
    base: &str,
    client_id: &str,
    code: &str,
    verifier: &str,
) -> (StatusCode, Value) {
    let resource = format!("{base}/mcp");
    token(
        base,
        &[
            ("grant_type", "authorization_code"),
            ("code", code),
            ("code_verifier", verifier),
            ("redirect_uri", "http://127.0.0.1:61000/callback"),
            ("client_id", client_id),
            ("resource", &resource),
        ],
    )
    .await
}

async fn refresh(
    base: &str,
    client_id: &str,
    refresh_token: &str,
    scope: Option<&str>,
) -> (StatusCode, Value) {
    let resource = format!("{base}/mcp");
    let mut form = vec![
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token),
        ("client_id", client_id),
        ("resource", resource.as_str()),
    ];
    if let Some(scope) = scope {
        form.push(("scope", scope));
    }
    token(base, &form).await
}

async fn list_tools(base: &str, access_token: &str) -> StatusCode {
    client()
        .post(format!("{base}/mcp"))
        .bearer_auth(access_token)
        .json(&json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }))
        .send()
        .await
        .unwrap()
        .status()
}

/// Discovery, registration, approval, the exchange and the refresh, end to end. Revision 4:
/// the access token works at once after the exchange, and again after a refresh. Revision 3:
/// the old refresh token used again revokes the grant.
#[tokio::test]
async fn the_authorization_code_flow_mints_a_grant_that_works_at_once_and_after_refresh() {
    let root = tempfile::tempdir().unwrap();
    let server = start_server(root.path(), json!({})).await;
    let base = format!("http://{}", server.local_addr());

    for path in [
        "/.well-known/oauth-protected-resource/mcp",
        "/.well-known/oauth-protected-resource",
    ] {
        let metadata: Value = client()
            .get(format!("{base}{path}"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(metadata["resource"], format!("{base}/mcp"), "{path}");
        assert_eq!(metadata["authorization_servers"], json!([base]));
    }
    let server_metadata: Value = client()
        .get(format!("{base}/.well-known/oauth-authorization-server"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(server_metadata["issuer"], base);
    assert_eq!(
        server_metadata["code_challenge_methods_supported"],
        json!(["S256"])
    );
    let challenged = client()
        .post(format!("{base}/mcp"))
        .json(&json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }))
        .send()
        .await
        .unwrap();
    assert_eq!(challenged.status(), StatusCode::UNAUTHORIZED);
    assert!(
        challenged.headers()[header::WWW_AUTHENTICATE]
            .to_str()
            .unwrap()
            .contains(&format!(
                "resource_metadata=\"{base}/.well-known/oauth-protected-resource/mcp\""
            ))
    );

    let admin = administrator(root.path(), &base).await;
    let client_id = client_id(&base, None).await;
    let pending = pending(&base, &client_id).await;
    assert_eq!(status(&base, &pending).await.status(), StatusCode::OK);
    // Another browser's poll, without the cookie, learns nothing.
    let stranger = client()
        .get(format!("{base}/oauth/authorize/status?id={}", pending.id))
        .send()
        .await
        .unwrap();
    assert_eq!(stranger.status(), StatusCode::FORBIDDEN);
    // Approval: access:write, at most the environment's access.
    let reader = {
        let (repositories, database) = repositories(root.path()).await;
        let link = super::issue_administrative_pairing_link(&repositories, None)
            .await
            .unwrap();
        database.close().await;
        exchange(&base, &link.credential, Some("orchestration:read")).await
    };
    assert_eq!(
        approve(
            &base,
            &reader,
            json!({ "id": pending.id, "access": "read-only" })
        )
        .await
        .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        approve(
            &base,
            &admin,
            json!({ "id": pending.id, "access": "full-access" })
        )
        .await
        .status(),
        StatusCode::BAD_REQUEST,
        "above Supervised, the environment's default"
    );
    assert_eq!(
        approve(
            &base,
            &admin,
            json!({ "id": pending.id, "access": "approval-required", "terminals": true })
        )
        .await
        .status(),
        StatusCode::BAD_REQUEST,
        "terminals were not asked for"
    );
    assert_eq!(
        approve(
            &base,
            &admin,
            json!({ "id": pending.id, "access": "approval-required" })
        )
        .await
        .status(),
        StatusCode::OK
    );
    let redirected = status(&base, &pending).await;
    assert_eq!(redirected.status(), StatusCode::SEE_OTHER);
    let location =
        url::Url::parse(redirected.headers()[header::LOCATION].to_str().unwrap()).unwrap();
    let code = location
        .query_pairs()
        .find(|(name, _)| name == "code")
        .unwrap()
        .1
        .into_owned();
    // The code is delivered once.
    assert_eq!(status(&base, &pending).await.status(), StatusCode::OK);

    let (refused, error) = exchange_code(&base, &client_id, &code, &"w".repeat(43)).await;
    assert_eq!(
        (refused, error["error"].as_str()),
        (StatusCode::BAD_REQUEST, Some("invalid_grant"))
    );
    let (ok, tokens) = exchange_code(&base, &client_id, &code, VERIFIER).await;
    assert_eq!(ok, StatusCode::OK, "{tokens}");
    assert_eq!(tokens["token_type"], "Bearer");
    assert_eq!(tokens["expires_in"], 3_600);
    assert_eq!(tokens["scope"], "orchestration:read orchestration:operate");
    let access = tokens["access_token"].as_str().unwrap().to_owned();
    let first_refresh = tokens["refresh_token"].as_str().unwrap().to_owned();
    assert_eq!(
        list_tools(&base, &access).await,
        StatusCode::OK,
        "at once after the exchange"
    );
    // Its audience is this origin's /mcp only: through another Host it is refused.
    let other_host = client()
        .post(format!("{base}/mcp"))
        .header(
            header::HOST,
            format!("localhost:{}", server.local_addr().port()),
        )
        .bearer_auth(&access)
        .json(&json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }))
        .send()
        .await
        .unwrap();
    assert_eq!(other_host.status(), StatusCode::UNAUTHORIZED);
    // An mcp-client token is still no credential elsewhere.
    let clients = client()
        .get(format!("{base}/api/auth/clients"))
        .bearer_auth(&access)
        .send()
        .await
        .unwrap();
    assert_eq!(clients.status(), StatusCode::UNAUTHORIZED);

    // A refresh asking for a scope that was not granted is refused, and changes nothing.
    let (widened, error) =
        refresh(&base, &client_id, &first_refresh, Some("terminal:operate")).await;
    assert_eq!(
        (widened, error["error"].as_str()),
        (StatusCode::BAD_REQUEST, Some("invalid_scope"))
    );
    let (ok, refreshed) = refresh(&base, &client_id, &first_refresh, None).await;
    assert_eq!(ok, StatusCode::OK, "{refreshed}");
    let second_access = refreshed["access_token"].as_str().unwrap().to_owned();
    assert_ne!(refreshed["refresh_token"], first_refresh.as_str());
    assert_eq!(
        list_tools(&base, &second_access).await,
        StatusCode::OK,
        "after a refresh"
    );

    // The old refresh token again: refused, and the whole grant is revoked.
    let (reused, error) = refresh(&base, &client_id, &first_refresh, None).await;
    assert_eq!(
        (reused, error["error"].as_str()),
        (StatusCode::BAD_REQUEST, Some("invalid_grant"))
    );
    assert_eq!(
        list_tools(&base, &second_access).await,
        StatusCode::UNAUTHORIZED
    );
    let (dead, _) = refresh(
        &base,
        &client_id,
        refreshed["refresh_token"].as_str().unwrap(),
        None,
    )
    .await;
    assert_eq!(dead, StatusCode::BAD_REQUEST);

    server.shutdown();
    server.join().await.expect("server joins");
}

/// A second use of a code revokes the grant it minted; a denied request redirects with
/// `access_denied`; revoking the client in Authorized clients ends its refresh.
#[tokio::test]
async fn replayed_codes_denials_and_revocation_end_the_grant() {
    let root = tempfile::tempdir().unwrap();
    let server = start_server(root.path(), json!({})).await;
    let base = format!("http://{}", server.local_addr());
    let admin = administrator(root.path(), &base).await;
    let client_id = client_id(&base, None).await;

    let code = approved_code(&base, &admin, &client_id).await;
    let (_, tokens) = exchange_code(&base, &client_id, &code, VERIFIER).await;
    let access = tokens["access_token"].as_str().unwrap().to_owned();
    assert_eq!(list_tools(&base, &access).await, StatusCode::OK);
    let (replayed, error) = exchange_code(&base, &client_id, &code, VERIFIER).await;
    assert_eq!(
        (replayed, error["error"].as_str()),
        (StatusCode::BAD_REQUEST, Some("invalid_grant"))
    );
    assert_eq!(list_tools(&base, &access).await, StatusCode::UNAUTHORIZED);

    let denied = pending(&base, &client_id).await;
    let answer = client()
        .post(format!("{base}/api/auth/mcp-authorizations/deny"))
        .bearer_auth(&admin)
        .json(&json!({ "id": denied.id }))
        .send()
        .await
        .unwrap();
    assert_eq!(answer.status(), StatusCode::OK);
    let redirected = status(&base, &denied).await;
    let location = redirected.headers()[header::LOCATION]
        .to_str()
        .unwrap()
        .to_owned();
    assert!(location.contains("error=access_denied"), "{location}");
    assert!(location.contains("state=xyz"), "{location}");

    let code = approved_code(&base, &admin, &client_id).await;
    let (_, tokens) = exchange_code(&base, &client_id, &code, VERIFIER).await;
    let session_id = {
        let clients: Value = client()
            .get(format!("{base}/api/auth/clients"))
            .bearer_auth(&admin)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        clients
            .as_array()
            .unwrap()
            .iter()
            .find(|client| client["client"]["label"] == "MCP · Codex (remote)")
            .map(|client| client["sessionId"].as_str().unwrap().to_owned())
            .expect("the grant is an authorized client")
    };
    let revoked = client()
        .post(format!("{base}/api/auth/clients/revoke"))
        .bearer_auth(&admin)
        .json(&json!({ "sessionId": session_id }))
        .send()
        .await
        .unwrap();
    assert_eq!(revoked.status(), StatusCode::OK);
    let (after, _) = refresh(
        &base,
        &client_id,
        tokens["refresh_token"].as_str().unwrap(),
        None,
    )
    .await;
    assert_eq!(after, StatusCode::BAD_REQUEST);

    server.shutdown();
    server.join().await.expect("server joins");
}

/// Authorization refusals: an unknown client or redirect shows a page and never redirects;
/// a loopback redirect on another port is accepted; PKCE, resource and scope refusals
/// redirect back with an error.
#[tokio::test]
async fn authorization_requests_are_checked_before_anything_is_recorded() {
    let root = tempfile::tempdir().unwrap();
    let server = start_server(root.path(), json!({})).await;
    let base = format!("http://{}", server.local_addr());
    let client_id = client_id(&base, None).await;

    let unknown = authorize(&authorize_url(&base, "mcp-nobody", &[]), None).await;
    assert_eq!(unknown.status(), StatusCode::BAD_REQUEST);
    assert!(unknown.headers().get(header::LOCATION).is_none());
    let mut wrong_path = url::Url::parse(&authorize_url(&base, &client_id, &[])).unwrap();
    let pairs = wrong_path
        .query_pairs()
        .into_owned()
        .map(|(name, value)| {
            if name == "redirect_uri" {
                (name, "http://127.0.0.1:61000/elsewhere".to_owned())
            } else {
                (name, value)
            }
        })
        .collect::<Vec<_>>();
    wrong_path.query_pairs_mut().clear().extend_pairs(pairs);
    let refused = authorize(wrong_path.as_str(), None).await;
    assert_eq!(refused.status(), StatusCode::BAD_REQUEST);
    assert!(refused.headers().get(header::LOCATION).is_none());

    for (extra, error) in [
        (vec![("scope", "access:write")], "invalid_scope"),
        (
            vec![("response_type", "token")],
            "unsupported_response_type",
        ),
    ] {
        let mut url = url::Url::parse(&authorize_url(&base, &client_id, &[])).unwrap();
        let mut pairs = url.query_pairs().into_owned().collect::<Vec<_>>();
        for (name, value) in &extra {
            pairs.retain(|(existing, _)| existing != name);
            pairs.push(((*name).to_owned(), (*value).to_owned()));
        }
        url.query_pairs_mut().clear().extend_pairs(pairs);
        let refused = authorize(url.as_str(), None).await;
        assert_eq!(refused.status(), StatusCode::SEE_OTHER, "{error}");
        let location = refused.headers()[header::LOCATION]
            .to_str()
            .unwrap()
            .to_owned();
        assert!(location.contains(&format!("error={error}")), "{location}");
        assert!(location.contains("iss="), "{location}");
    }
    for (name, value, error) in [
        ("code_challenge_method", "plain", "invalid_request"),
        (
            "resource",
            "https://elsewhere.example/mcp",
            "invalid_target",
        ),
    ] {
        let mut url = url::Url::parse(&authorize_url(&base, &client_id, &[])).unwrap();
        let pairs = url
            .query_pairs()
            .into_owned()
            .map(|(existing, current)| {
                if existing == name {
                    (existing, value.to_owned())
                } else {
                    (existing, current)
                }
            })
            .collect::<Vec<_>>();
        url.query_pairs_mut().clear().extend_pairs(pairs);
        let refused = authorize(url.as_str(), None).await;
        assert_eq!(refused.status(), StatusCode::SEE_OTHER, "{name}");
        assert!(
            refused.headers()[header::LOCATION]
                .to_str()
                .unwrap()
                .contains(&format!("error={error}")),
            "{name}"
        );
    }
    // Nothing above recorded a pending request; an empty scope means the default pair.
    let (repositories, database) = repositories(root.path()).await;
    assert!(
        repositories
            .list_pending_mcp_oauth_authorizations(super::now_ms())
            .await
            .unwrap()
            .is_empty()
    );
    let accepted = authorize(
        &authorize_url(&base, &client_id, &[("scope", "offline_access")]),
        None,
    )
    .await;
    assert_eq!(accepted.status(), StatusCode::OK);
    let pending = repositories
        .list_pending_mcp_oauth_authorizations(super::now_ms())
        .await
        .unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(
        pending[0].scopes,
        "orchestration:read orchestration:operate"
    );
    assert_eq!(pending[0].redirect_uri, "http://127.0.0.1:61000/callback");
    database.close().await;

    server.shutdown();
    server.join().await.expect("server joins");
}

/// With the MCP server off, the authorize page says so, the code grant is refused, and a
/// refresh still works, so turning MCP back on does not force every agent to sign in again.
#[tokio::test]
async fn with_mcp_off_codes_are_refused_and_refresh_still_works() {
    let root = tempfile::tempdir().unwrap();
    let server = start_server(root.path(), json!({ "enableMcpServer": false })).await;
    let base = format!("http://{}", server.local_addr());
    let client_id = client_id(&base, None).await;

    let page = authorize(&authorize_url(&base, &client_id, &[]), None).await;
    assert_eq!(page.status(), StatusCode::FORBIDDEN);
    assert!(page.text().await.unwrap().contains("The MCP server is off"));
    let (refused, error) = exchange_code(&base, &client_id, "any-code", VERIFIER).await;
    assert_eq!(refused, StatusCode::BAD_REQUEST);
    assert!(
        error["error_description"].as_str().unwrap().contains("off"),
        "{error}"
    );

    // A grant minted while MCP was on, written as the exchange writes it.
    let (repositories, database) = repositories(root.path()).await;
    let now = super::now_ms();
    let session_id = uuid::Uuid::new_v4().to_string();
    repositories
        .exchange_mcp_oauth_code(
            seeded_exchange(&repositories, &client_id, &base, &session_id, now).await,
            now,
        )
        .await
        .unwrap();
    database.close().await;
    let (ok, refreshed) = refresh(&base, &client_id, "seeded-refresh", None).await;
    assert_eq!(ok, StatusCode::OK, "{refreshed}");
    let disabled: Value = client()
        .post(format!("{base}/mcp"))
        .bearer_auth(refreshed["access_token"].as_str().unwrap())
        .json(&json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(disabled["error"]["data"]["_tag"], "McpServerDisabledError");

    server.shutdown();
    server.join().await.expect("server joins");
}

async fn seeded_exchange(
    repositories: &Repositories,
    client_id: &str,
    base: &str,
    session_id: &str,
    now: i64,
) -> crate::persistence::McpOAuthCodeExchange {
    use crate::persistence::{McpOAuthDecision, NewMcpOAuthAuthorization};
    let id = uuid::Uuid::new_v4().to_string();
    repositories
        .create_mcp_oauth_authorization(
            NewMcpOAuthAuthorization {
                id: id.clone(),
                user_code: "SEED2345".to_owned(),
                client_id: client_id.to_owned(),
                redirect_uri: REDIRECT.to_owned(),
                code_challenge: s256(VERIFIER),
                state: None,
                resource: format!("{base}/mcp"),
                scopes: "orchestration:read orchestration:operate".to_owned(),
                origin: base.to_owned(),
                source_key: "loopback".to_owned(),
                status_cookie_hash: super::oauth::secret_hash("c"),
                created_at_ms: now,
                expires_at_ms: now + super::oauth::AUTHORIZATION_TTL_MS,
            },
            now,
            super::oauth::LIMITS,
        )
        .await
        .unwrap();
    repositories
        .decide_mcp_oauth_authorization(
            id.clone(),
            McpOAuthDecision::Approve {
                access: "approval-required".to_owned(),
                scopes: "orchestration:read orchestration:operate".to_owned(),
            },
            now,
        )
        .await
        .unwrap();
    repositories
        .attach_mcp_oauth_code(
            id.clone(),
            super::oauth::secret_hash("seeded-code"),
            now + 60_000,
            now,
        )
        .await
        .unwrap();
    crate::persistence::McpOAuthCodeExchange {
        authorization_id: id,
        code_hash: super::oauth::secret_hash("seeded-code"),
        client_id: client_id.to_owned(),
        resource: format!("{base}/mcp"),
        session: crate::persistence::NewAuthSession {
            session_id: session_id.to_owned(),
            subject: super::MCP_CLIENT_SUBJECT.to_owned(),
            scopes: json!(["orchestration:read", "orchestration:operate"]),
            method: "bearer-access-token".to_owned(),
            client: crate::persistence::AuthSessionClient {
                label: Some("MCP · Codex (remote)".to_owned()),
                ip_address: None,
                user_agent: None,
                device_type: "unknown".to_owned(),
                os: None,
                browser: None,
            },
            issued_at: super::format_iso(now),
            expires_at: super::format_iso(now + super::oauth::GRANT_TTL_MS),
            reach: None,
            off_host: None,
            mcp_access: Some("approval-required".to_owned()),
            delivery_state: crate::persistence::AuthSessionDeliveryState::Active,
        },
        refresh_token_hash: super::oauth::secret_hash("seeded-refresh"),
        revoked_at: super::format_iso(now),
    }
}

/// Admission: one source's flood of authorizations is refused at its own cap and leaves
/// room for another source; one client's leaves room for another client; registrations from
/// one source are capped per hour.
#[tokio::test]
async fn one_source_or_client_cannot_lock_out_another() {
    let root = tempfile::tempdir().unwrap();
    let server = start_server(root.path(), json!({})).await;
    let base = format!("http://{}", server.local_addr());
    let flood = Some("203.0.113.5");
    let first = client_id(&base, flood).await;
    let second = client_id(&base, flood).await;
    let third = client_id(&base, flood).await;
    for client in [&first, &first, &second, &second] {
        let page = authorize(&authorize_url(&base, client, &[]), flood).await;
        assert_eq!(page.status(), StatusCode::OK);
    }
    // The client is at its own cap, and so is the source.
    assert_eq!(
        authorize(&authorize_url(&base, &first, &[]), Some("198.51.100.7"))
            .await
            .status(),
        StatusCode::TOO_MANY_REQUESTS
    );
    assert_eq!(
        authorize(&authorize_url(&base, &third, &[]), flood)
            .await
            .status(),
        StatusCode::TOO_MANY_REQUESTS
    );
    // Another source, and another client, still get through.
    let other = Some("198.51.100.7");
    let elsewhere = client_id(&base, other).await;
    assert_eq!(
        authorize(&authorize_url(&base, &elsewhere, &[]), other)
            .await
            .status(),
        StatusCode::OK
    );
    // Eight registrations an hour from one source; the ninth is refused.
    for _ in 0..5 {
        assert_eq!(register(&base, flood).await.status(), StatusCode::CREATED);
    }
    assert_eq!(
        register(&base, flood).await.status(),
        StatusCode::TOO_MANY_REQUESTS
    );
    assert_eq!(register(&base, other).await.status(), StatusCode::CREATED);

    server.shutdown();
    server.join().await.expect("server joins");
}

/// Only an eligible origin serves remote MCP's OAuth: on a plain-HTTP LAN address (here a
/// `Host` that is neither loopback nor the bound address) the metadata is 404 and the code
/// grant is refused, while the RFC 8693 exchange works there as it always has. An expired
/// code is refused.
#[tokio::test]
async fn an_ineligible_origin_serves_no_oauth_but_keeps_the_token_exchange() {
    let root = tempfile::tempdir().unwrap();
    let server = start_server(root.path(), json!({})).await;
    let base = format!("http://{}", server.local_addr());
    let lan_host = format!("192.168.1.5:{}", server.local_addr().port());
    for path in [
        "/.well-known/oauth-protected-resource/mcp",
        "/.well-known/oauth-authorization-server",
        "/oauth/authorize?client_id=x",
    ] {
        let answer = client()
            .get(format!("{base}{path}"))
            .header(header::HOST, &lan_host)
            .send()
            .await
            .unwrap();
        assert_eq!(answer.status(), StatusCode::NOT_FOUND, "{path}");
    }
    let refused = client()
        .post(format!("{base}/oauth/token"))
        .header(header::HOST, &lan_host)
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", "x"),
            ("code_verifier", VERIFIER),
            ("redirect_uri", REDIRECT),
            ("client_id", "x"),
        ])
        .send()
        .await
        .unwrap();
    assert_eq!(refused.status(), StatusCode::BAD_REQUEST);
    let (repositories, database) = repositories(root.path()).await;
    let link = super::issue_administrative_pairing_link(&repositories, None)
        .await
        .unwrap();
    let exchanged = client()
        .post(format!("{base}/oauth/token"))
        .header(header::HOST, &lan_host)
        .form(&[
            ("grant_type", super::TOKEN_GRANT_TYPE),
            ("subject_token", link.credential.as_str()),
            ("subject_token_type", super::BOOTSTRAP_TOKEN_TYPE),
            ("requested_token_type", super::ACCESS_TOKEN_TYPE),
        ])
        .send()
        .await
        .unwrap();
    assert_eq!(exchanged.status(), StatusCode::OK);
    let admin = exchanged.json::<Value>().await.unwrap()["access_token"]
        .as_str()
        .unwrap()
        .to_owned();

    // An expired code is refused.
    let client_id = client_id(&base, None).await;
    let code = approved_code(&base, &admin, &client_id).await;
    let code_hash = super::oauth::secret_hash(&code);
    repositories
        .database()
        .call(move |connection| {
            connection.execute(
                "UPDATE mcp_oauth_authorizations SET code_expires_at = 0 WHERE code_hash = ?",
                [code_hash],
            )?;
            Ok(())
        })
        .await
        .unwrap();
    database.close().await;
    let (expired, error) = exchange_code(&base, &client_id, &code, VERIFIER).await;
    assert_eq!(
        (expired, error["error"].as_str()),
        (StatusCode::BAD_REQUEST, Some("invalid_grant"))
    );

    server.shutdown();
    server.join().await.expect("server joins");
}
