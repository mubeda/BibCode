use std::{
    collections::{HashMap, HashSet},
    sync::{
        Arc,
        atomic::{AtomicI64, Ordering},
    },
};

use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, Uri, header};
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use super::*;
use crate::mcp::tools::previews::{TOOL_OPERATIONS, operation_wire_name};

type PreviewCall = (PreviewScope, String, Value, Option<String>);

#[derive(Clone)]
struct Controls {
    now: Arc<AtomicI64>,
    sign_failures: Arc<Mutex<HashSet<String>>>,
    sign_calls: Arc<Mutex<Vec<(String, Value)>>>,
    verify_results: Arc<Mutex<HashMap<String, Result<DecodedCloudProof, String>>>>,
    key_pair_result: Arc<Mutex<Result<(String, String), String>>>,
    endpoint_result: Arc<Mutex<Option<Result<Value, String>>>>,
    endpoint_calls: Arc<Mutex<Vec<Value>>>,
    /// Holds each endpoint apply open this long, to widen races.
    endpoint_delay: Arc<std::sync::atomic::AtomicU64>,
    pairing_result: Arc<Mutex<Result<PairingCredential, String>>>,
    preview_results: Arc<Mutex<HashMap<String, Result<Value, String>>>>,
    preview_calls: Arc<Mutex<Vec<PreviewCall>>>,
}

impl Controls {
    fn new() -> Self {
        Self {
            now: Arc::new(AtomicI64::new(1_700_000_000)),
            sign_failures: Arc::default(),
            sign_calls: Arc::default(),
            verify_results: Arc::default(),
            key_pair_result: Arc::new(Mutex::new(Ok((
                "private-key".into(),
                "-----BEGIN PUBLIC KEY-----\npublic-key\n-----END PUBLIC KEY-----".into(),
            )))),
            endpoint_result: Arc::default(),
            endpoint_calls: Arc::default(),
            endpoint_delay: Arc::default(),
            pairing_result: Arc::new(Mutex::new(Ok(PairingCredential {
                credential: "pairing-secret".into(),
                expires_at: "2026-07-10T12:02:00Z".into(),
            }))),
            preview_results: Arc::default(),
            preview_calls: Arc::default(),
        }
    }

    fn proof(&self, token: &str, scope: &str) -> DecodedCloudProof {
        let now = self.now.load(Ordering::SeqCst);
        DecodedCloudProof {
            issuer: "https://relay.example".into(),
            subject: "cloud-user".into(),
            audience: "bibcode-env:env-1".into(),
            jwt_id: token.into(),
            issued_at: now,
            expires_at: now + 120,
            environment_id: "env-1".into(),
            nonce: format!("nonce-{token}"),
            scope: vec![scope.into()],
            client_proof_key_thumbprint: (scope == "environment:connect")
                .then(|| "thumbprint".into()),
            confirmation_thumbprint: (scope == "environment:connect").then(|| "thumbprint".into()),
        }
    }
}

struct Harness {
    _temp: TempDir,
    database_path: PathBuf,
    service: ConnectMcpService,
    controls: Controls,
}

async fn harness(max_credentials: usize, max_sessions: usize) -> Harness {
    let temp = TempDir::new().expect("temp directory");
    let database_path = temp.path().join("connect.sqlite3");
    let controls = Controls::new();

    let sign_controls = controls.clone();
    let verify_controls = controls.clone();
    let key_controls = controls.clone();
    let jwt = JwtCodec::new(
        move |typ, payload| {
            let controls = sign_controls.clone();
            async move {
                controls
                    .sign_calls
                    .lock()
                    .await
                    .push((typ.clone(), payload.clone()));
                if controls.sign_failures.lock().await.contains(&typ) {
                    Err("sign failed".into())
                } else {
                    Ok(format!("signed:{typ}:{}", payload["jti"]))
                }
            }
        },
        move |_key, typ, token, _issuer, _audience, _now| {
            let controls = verify_controls.clone();
            async move {
                if let Some(result) = controls.verify_results.lock().await.get(&token).cloned() {
                    return result;
                }
                let scope = if typ == RELAY_HEALTH_REQUEST_TYP {
                    "environment:status"
                } else {
                    "environment:connect"
                };
                Ok(controls.proof(&token, scope))
            }
        },
        move || {
            let controls = key_controls.clone();
            async move { controls.key_pair_result.lock().await.clone() }
        },
    );

    let endpoint_controls = controls.clone();
    let endpoint = EndpointRuntime::new(move |config| {
        let controls = endpoint_controls.clone();
        async move {
            let delay = controls.endpoint_delay.load(Ordering::SeqCst);
            if delay > 0 {
                tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
            }
            controls.endpoint_calls.lock().await.push(config.clone());
            if let Some(result) = controls.endpoint_result.lock().await.clone() {
                result
            } else if config.is_null() {
                Ok(json!({"status":"disabled"}))
            } else {
                Ok(json!({"status":"running"}))
            }
        }
    });

    let pairing_controls = controls.clone();
    let pairing = PairingIssuer::new(move |_thumbprint| {
        let controls = pairing_controls.clone();
        async move { controls.pairing_result.lock().await.clone() }
    });

    let preview_controls = controls.clone();
    let preview = PreviewInvoker::new(move |scope, operation, input, tab_id, cancellation| {
        let controls = preview_controls.clone();
        async move {
            if cancellation.is_cancelled() {
                return Err("cancelled".into());
            }
            controls
                .preview_calls
                .lock()
                .await
                .push((scope, operation.clone(), input, tab_id));
            controls
                .preview_results
                .lock()
                .await
                .get(&operation)
                .cloned()
                .unwrap_or_else(|| Ok(json!({"ok":true})))
        }
    });

    let now = Arc::clone(&controls.now);
    let service = ConnectMcpService::open(
        &database_path,
        ConnectMcpConfig {
            environment_id: "env-1".into(),
            descriptor: json!({"environmentId":"env-1","label":"Local"}),
            mcp_endpoint: "http://127.0.0.1:43123/mcp".into(),
            open_url_endpoint: "http://127.0.0.1:43123/api/preview/open-url".into(),
            now_epoch_seconds: Arc::new(move || now.load(Ordering::SeqCst)),
            max_mcp_credentials: max_credentials,
            max_mcp_sessions: max_sessions,
        },
        jwt,
        endpoint,
        pairing,
        preview,
        None,
    )
    .await
    .expect("connect service");

    Harness {
        _temp: temp,
        database_path,
        service,
        controls,
    }
}

fn context(headers: HeaderMap) -> RouteContext {
    RouteContext {
        headers,
        uri: Uri::from_static("http://127.0.0.1:43123/mcp"),
        origin: crate::RequestOrigin::direct("http://127.0.0.1:43123"),
        cancellation: CancellationToken::new(),
    }
}

fn cancelled_context(headers: HeaderMap) -> RouteContext {
    let cancellation = CancellationToken::new();
    cancellation.cancel();
    RouteContext {
        headers,
        uri: Uri::from_static("http://127.0.0.1:43123/mcp"),
        origin: crate::RequestOrigin::direct("http://127.0.0.1:43123"),
        cancellation,
    }
}

fn error<T>(result: Result<T, ConnectMcpError>) -> ConnectMcpError {
    match result {
        Ok(_) => panic!("operation unexpectedly succeeded"),
        Err(error) => error,
    }
}

fn assert_error(error: &ConnectMcpError, status: StatusCode, tag: &str, message: &str) {
    assert_eq!(error.status, status);
    assert_eq!(error.body["_tag"], tag);
    assert_eq!(error.body["message"], message);
}

fn relay_config(cloud_user_id: &str) -> Value {
    json!({
        "relayUrl":"https://relay.example/",
        "relayIssuer":"https://relay.example",
        "cloudUserId":cloud_user_id,
        "environmentCredential":"environment-secret",
        "cloudMintPublicKey":"-----BEGIN PUBLIC KEY-----\ncloud-key\n-----END PUBLIC KEY-----",
        "endpointRuntime":{"providerKind":"cloudflare_tunnel","connectorToken":"token"}
    })
}

async fn link(harness: &Harness) {
    let response = harness
        .service
        .json(
            JsonOperation::ConnectRelayConfig,
            Some(relay_config("cloud-user")),
            context(HeaderMap::new()),
        )
        .await
        .expect("relay config");
    assert_eq!(response.body["ok"], true);
}

fn authorization(credential: &McpIssuedCredential) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        header::AUTHORIZATION,
        HeaderValue::from_str(&credential.authorization_header).expect("authorization header"),
    );
    headers
}

async fn initialize(service: &ConnectMcpService, credential: &McpIssuedCredential) -> HeaderMap {
    let mut headers = authorization(credential);
    let response = service
        .mcp(
            Method::POST,
            serde_json::to_vec(&json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}))
                .expect("request body"),
            context(headers.clone()),
        )
        .await
        .expect("initialize");
    headers.insert(
        "mcp-session-id",
        HeaderValue::from_str(&response.headers["mcp-session-id"]).expect("session header"),
    );
    headers
}

async fn rpc(service: &ConnectMcpService, headers: HeaderMap, request: Value) -> Value {
    let response = service
        .mcp(
            Method::POST,
            serde_json::to_vec(&request).expect("request body"),
            context(headers),
        )
        .await
        .expect("MCP response");
    serde_json::from_slice(&response.body).expect("JSON-RPC response")
}

#[test]
fn parsing_auth_and_wire_helpers_reject_invalid_inputs() {
    let empty = HeaderMap::new();
    assert_eq!(
        bearer_token(&context(empty)).unwrap_err().status,
        StatusCode::UNAUTHORIZED
    );

    for value in ["Basic token", "Bearer", "Bearer   "] {
        let mut headers = HeaderMap::new();
        headers.insert(header::AUTHORIZATION, HeaderValue::from_str(value).unwrap());
        assert_eq!(
            bearer_token(&context(headers)).unwrap_err().status,
            StatusCode::UNAUTHORIZED
        );
    }
    let mut headers = HeaderMap::new();
    headers.insert(
        header::AUTHORIZATION,
        HeaderValue::from_static("Bearer token"),
    );
    assert_eq!(bearer_token(&context(headers)).unwrap(), "token");

    for invalid in [
        "not a URL",
        "http://relay.example",
        "https://u:p@relay.example",
    ] {
        assert_eq!(
            validate_secure_url(invalid, "Relay URL")
                .unwrap_err()
                .status,
            StatusCode::BAD_REQUEST
        );
    }
    validate_secure_url("https://relay.example/path", "Relay URL").unwrap();
    assert_eq!(
        normalize_issuer(" https://relay.example/// "),
        "https://relay.example"
    );

    assert_eq!(
        parse_iso_timestamp("bad").unwrap_err().status,
        StatusCode::INTERNAL_SERVER_ERROR
    );
    assert_eq!(parse_iso_timestamp("1970-01-01T00:00:01Z").unwrap(), 1);
    assert_eq!(iso_timestamp(0).unwrap(), "1970-01-01T00:00:00Z");
    assert_eq!(
        iso_timestamp(i64::MAX).unwrap_err().status,
        StatusCode::INTERNAL_SERVER_ERROR
    );

    assert_eq!(
        required_payload(None).unwrap_err().status,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        object(&json!([])).unwrap_err().status,
        StatusCode::BAD_REQUEST
    );
    let fields = json!({"required":1,"optional":false,"blank":"  "});
    let object = object(&fields).unwrap();
    assert_eq!(
        string_field(object, "required").unwrap_err().status,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(optional_string_field(object, "missing").unwrap(), None);
    assert_eq!(
        optional_string_field(object, "optional")
            .unwrap_err()
            .status,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        nonempty_field(object, "blank", "blank").unwrap_err().status,
        StatusCode::BAD_REQUEST
    );

    let response = credential_response(json!({"ok":true})).unwrap();
    assert_eq!(response.headers["cache-control"], "no-store");
    assert_eq!(response.headers["pragma"], "no-cache");
    assert_eq!(hash_token("token").len(), 64);

    let temp = TempDir::new().unwrap();
    let database_path = temp.path().join("settings.sqlite3");
    initialize_database(&database_path).unwrap();
    let connection = open_database(&database_path).unwrap();
    let busy_timeout: i64 = connection
        .query_row("PRAGMA busy_timeout", [], |row| row.get(0))
        .unwrap();
    let foreign_keys: i64 = connection
        .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
        .unwrap();
    assert_eq!(busy_timeout, 5_000);
    assert_eq!(foreign_keys, 1);
}

#[test]
fn origin_snapshot_and_tool_metadata_cover_wire_variants() {
    let valid = json!({"localHttpHost":"[::1]","localHttpPort":43123});
    let ipv6 = RouteContext {
        headers: HeaderMap::new(),
        uri: "http://[::1]:43123/mcp".parse().unwrap(),
        origin: crate::RequestOrigin::direct("http://127.0.0.1:43123"),
        cancellation: CancellationToken::new(),
    };
    assert!(allowed_origin(Some(&valid), &ipv6));
    assert!(!allowed_origin(None, &ipv6));
    assert!(!allowed_origin(Some(&json!([])), &ipv6));
    assert!(!allowed_origin(
        Some(&json!({"localHttpHost":"remote","localHttpPort":43123})),
        &ipv6
    ));
    assert!(!allowed_origin(
        Some(&json!({"localHttpHost":"localhost","localHttpPort":99})),
        &context(HeaderMap::new())
    ));
    // HTTP/1.1 requests carry an origin-form target; the authority is in Host.
    let mut loopback_host = HeaderMap::new();
    loopback_host.insert(header::HOST, HeaderValue::from_static("127.0.0.1:43123"));
    let origin_form = |headers| RouteContext {
        headers,
        uri: Uri::from_static("/api/connect/link-proof"),
        origin: crate::RequestOrigin::direct("http://127.0.0.1:43123"),
        cancellation: CancellationToken::new(),
    };
    let loopback = json!({"localHttpHost":"127.0.0.1","localHttpPort":43123});
    assert!(allowed_origin(Some(&loopback), &origin_form(loopback_host)));
    let mut tunnel_host = HeaderMap::new();
    tunnel_host.insert(header::HOST, HeaderValue::from_static("env.zone.test"));
    assert!(!allowed_origin(Some(&loopback), &origin_form(tunnel_host)));
    assert!(!allowed_origin(
        Some(&loopback),
        &origin_form(HeaderMap::new())
    ));
    let mut forwarded = HeaderMap::new();
    forwarded.insert(
        "x-forwarded-host",
        HeaderValue::from_static("relay.example"),
    );
    assert!(!allowed_origin(
        Some(&json!({"localHttpHost":"localhost","localHttpPort":43123})),
        &context(forwarded)
    ));

    let malformed = snapshot_tool_result(json!({"url":"https://example.test"}));
    assert_eq!(malformed["isError"], true);
    assert_eq!(
        malformed["structuredContent"]["error"]["_tag"],
        "PreviewAutomationMalformedResponseError"
    );
    let defaulted = snapshot_tool_result(json!({"screenshot":{},"url":"https://example.test"}));
    assert_eq!(defaulted["content"][1]["mimeType"], "image/png");
    assert_eq!(defaulted["content"][1]["data"], "");
    assert_eq!(
        defaulted["structuredContent"]["screenshot"]["width"],
        Value::Null
    );
    let complete = snapshot_tool_result(json!({
        "screenshot":{"data":"abc","mimeType":"image/webp","width":10,"height":20}
    }));
    assert_eq!(
        complete["content"][1],
        json!({"type":"image","data":"abc","mimeType":"image/webp"})
    );
    assert_eq!(complete["structuredContent"]["screenshot"]["height"], 20);

    assert_eq!(operation_wire_name("wait_for"), "waitFor");
    assert_eq!(operation_wire_name("recording_start"), "recordingStart");
    assert_eq!(operation_wire_name("recording_stop"), "recordingStop");
    assert_eq!(operation_wire_name("click"), "click");
    let tools = tool_descriptors(false);
    assert_eq!(tools.len(), TOOL_OPERATIONS.len());
    let status = tools
        .iter()
        .find(|tool| tool["name"] == "preview_status")
        .unwrap();
    assert_eq!(status["annotations"]["readOnlyHint"], true);
    let click = tools
        .iter()
        .find(|tool| tool["name"] == "preview_click")
        .unwrap();
    assert_eq!(click["annotations"]["destructiveHint"], true);
}

#[test]
fn proof_validation_rejects_every_security_boundary() {
    let controls = Controls::new();
    let now = controls.now.load(Ordering::SeqCst);
    let valid_health = controls.proof("health", "environment:status");
    validate_cloud_proof(
        &valid_health,
        "env-1",
        "cloud-user",
        "environment:status",
        now,
        false,
    )
    .unwrap();

    let mut invalid = Vec::new();
    let mut proof = valid_health.clone();
    proof.environment_id = "other".into();
    invalid.push(proof);
    let mut proof = valid_health.clone();
    proof.subject = "other".into();
    invalid.push(proof);
    let mut proof = valid_health.clone();
    proof.scope = vec!["environment:connect".into()];
    invalid.push(proof);
    let mut proof = valid_health.clone();
    proof.expires_at = proof.issued_at;
    invalid.push(proof);
    let mut proof = valid_health.clone();
    proof.expires_at = proof.issued_at + PROOF_MAX_LIFETIME_SECONDS + 1;
    invalid.push(proof);
    let mut proof = valid_health.clone();
    proof.issued_at = now + PROOF_CLOCK_SKEW_SECONDS + 1;
    proof.expires_at = proof.issued_at + 1;
    invalid.push(proof);
    let mut proof = valid_health;
    proof.issued_at = now - 120;
    proof.expires_at = now - PROOF_CLOCK_SKEW_SECONDS - 1;
    invalid.push(proof);
    for proof in invalid {
        let error = validate_cloud_proof(
            &proof,
            "env-1",
            "cloud-user",
            "environment:status",
            now,
            false,
        )
        .unwrap_err();
        assert_error(
            &error,
            StatusCode::UNAUTHORIZED,
            "EnvironmentHttpUnauthorizedError",
            "Invalid cloud health request.",
        );
    }

    let mut mint = controls.proof("mint", "environment:connect");
    mint.confirmation_thumbprint = Some("different".into());
    let error = validate_cloud_proof(
        &mint,
        "env-1",
        "cloud-user",
        "environment:connect",
        now,
        true,
    )
    .unwrap_err();
    assert_eq!(error.body["message"], "Invalid cloud mint request.");
    mint.client_proof_key_thumbprint = None;
    mint.confirmation_thumbprint = None;
    assert!(
        validate_cloud_proof(
            &mint,
            "env-1",
            "cloud-user",
            "environment:connect",
            now,
            true
        )
        .is_err()
    );
}

#[tokio::test]
async fn connect_routes_validate_payload_origin_and_runtime_failures() {
    let harness = harness(4, 4).await;
    let cancelled = error(
        harness
            .service
            .json(
                JsonOperation::ConnectLinkState,
                None,
                cancelled_context(HeaderMap::new()),
            )
            .await,
    );
    assert_eq!(cancelled.body["message"], "Request was cancelled.");

    for operation in [
        JsonOperation::ConnectLinkProof,
        JsonOperation::ConnectRelayConfig,
        JsonOperation::ConnectHealth,
        JsonOperation::ConnectMintCredential,
    ] {
        assert_eq!(
            error(
                harness
                    .service
                    .json(operation, None, context(HeaderMap::new()))
                    .await
            )
            .status,
            StatusCode::BAD_REQUEST
        );
    }

    for payload in [
        json!([]),
        json!({"relayUrl":"not a URL"}),
        json!({
            "relayUrl":"https://relay.example",
            "relayIssuer":1,
            "cloudUserId":"cloud-user",
            "environmentCredential":"secret",
            "cloudMintPublicKey":"-----BEGIN PUBLIC KEY-----"
        }),
        json!({
            "relayUrl":"https://relay.example",
            "cloudUserId":" ",
            "environmentCredential":"secret",
            "cloudMintPublicKey":"-----BEGIN PUBLIC KEY-----"
        }),
        json!({
            "relayUrl":"https://relay.example",
            "cloudUserId":"cloud-user",
            "environmentCredential":" ",
            "cloudMintPublicKey":"-----BEGIN PUBLIC KEY-----"
        }),
        json!({
            "relayUrl":"https://relay.example",
            "cloudUserId":"cloud-user",
            "environmentCredential":"secret"
        }),
        json!({
            "relayUrl":"https://relay.example",
            "cloudUserId":"cloud-user",
            "environmentCredential":"secret",
            "cloudMintPublicKey":"not-a-key"
        }),
    ] {
        assert_eq!(
            error(
                harness
                    .service
                    .json(
                        JsonOperation::ConnectRelayConfig,
                        Some(payload),
                        context(HeaderMap::new()),
                    )
                    .await
            )
            .status,
            StatusCode::BAD_REQUEST
        );
    }

    *harness.controls.endpoint_result.lock().await = Some(Err("offline".into()));
    let endpoint_error = error(
        harness
            .service
            .json(
                JsonOperation::ConnectRelayConfig,
                Some(relay_config("cloud-user")),
                context(HeaderMap::new()),
            )
            .await,
    );
    assert_eq!(endpoint_error.status, StatusCode::INTERNAL_SERVER_ERROR);
    *harness.controls.endpoint_result.lock().await = Some(Ok(json!({"status":"failed"})));
    assert_eq!(
        error(
            harness
                .service
                .json(
                    JsonOperation::ConnectRelayConfig,
                    Some(relay_config("cloud-user")),
                    context(HeaderMap::new()),
                )
                .await
        )
        .status,
        StatusCode::SERVICE_UNAVAILABLE
    );
    *harness.controls.endpoint_result.lock().await = None;
    link(&harness).await;
    assert_eq!(
        error(
            harness
                .service
                .json(
                    JsonOperation::ConnectRelayConfig,
                    Some(relay_config("different-user")),
                    context(HeaderMap::new()),
                )
                .await
        )
        .status,
        StatusCode::CONFLICT
    );

    let missing_endpoint = error(
        harness
            .service
            .json(
                JsonOperation::ConnectLinkProof,
                Some(json!({"challenge":"c","relayIssuer":"https://relay.example"})),
                context(HeaderMap::new()),
            )
            .await,
    );
    assert_eq!(
        missing_endpoint.body["message"],
        "Managed endpoint configuration is required."
    );
    for (endpoint, origin, route_context) in [
        (
            json!({"providerKind":"other"}),
            json!({"localHttpHost":"localhost","localHttpPort":43123}),
            context(HeaderMap::new()),
        ),
        (
            json!({"providerKind":"cloudflare_tunnel"}),
            Value::Null,
            context(HeaderMap::new()),
        ),
        (
            json!({"providerKind":"cloudflare_tunnel"}),
            json!({"localHttpHost":"localhost","localHttpPort":43123}),
            RouteContext {
                headers: HeaderMap::new(),
                uri: Uri::from_static("https://remote.example/mcp"),
                origin: crate::RequestOrigin::direct("http://127.0.0.1:43123"),
                cancellation: CancellationToken::new(),
            },
        ),
    ] {
        let failure = error(
            harness
                .service
                .json(
                    JsonOperation::ConnectLinkProof,
                    Some(json!({
                        "challenge":"c",
                        "relayIssuer":"https://relay.example",
                        "endpoint":endpoint,
                        "origin":origin
                    })),
                    route_context,
                )
                .await,
        );
        assert_eq!(failure.body["message"], "Invalid managed endpoint origin.");
    }

    *harness.controls.key_pair_result.lock().await = Err("keys".into());
    let proof_payload = json!({
        "challenge":"c",
        "relayIssuer":"https://relay.example/",
        "endpoint":{"providerKind":"cloudflare_tunnel"},
        "origin":{"localHttpHost":"localhost","localHttpPort":43123}
    });
    assert_eq!(
        error(
            harness
                .service
                .json(
                    JsonOperation::ConnectLinkProof,
                    Some(proof_payload.clone()),
                    context(HeaderMap::new()),
                )
                .await
        )
        .status,
        StatusCode::INTERNAL_SERVER_ERROR
    );
    *harness.controls.key_pair_result.lock().await = Ok(("private".into(), " public ".into()));
    harness
        .controls
        .sign_failures
        .lock()
        .await
        .insert(RELAY_LINK_PROOF_TYP.into());
    assert_eq!(
        error(
            harness
                .service
                .json(
                    JsonOperation::ConnectLinkProof,
                    Some(proof_payload),
                    context(HeaderMap::new()),
                )
                .await
        )
        .status,
        StatusCode::INTERNAL_SERVER_ERROR
    );

    *harness.controls.endpoint_result.lock().await = Some(Err("disable".into()));
    assert_eq!(
        error(
            harness
                .service
                .json(
                    JsonOperation::ConnectUnlink,
                    None,
                    context(HeaderMap::new()),
                )
                .await
        )
        .status,
        StatusCode::INTERNAL_SERVER_ERROR
    );
}

#[tokio::test]
async fn cloud_health_and_mint_fail_closed_at_each_dependency() {
    let harness = harness(4, 4).await;
    for operation in [
        JsonOperation::ConnectHealth,
        JsonOperation::ConnectMintCredential,
    ] {
        assert_eq!(
            error(
                harness
                    .service
                    .json(
                        operation,
                        Some(json!({"proof":"before-link"})),
                        context(HeaderMap::new()),
                    )
                    .await
            )
            .status,
            StatusCode::INTERNAL_SERVER_ERROR
        );
    }
    link(&harness).await;

    harness
        .controls
        .verify_results
        .lock()
        .await
        .insert("verify-error".into(), Err("bad signature".into()));
    assert_eq!(
        error(
            harness
                .service
                .json(
                    JsonOperation::ConnectHealth,
                    Some(json!({"proof":"verify-error"})),
                    context(HeaderMap::new()),
                )
                .await
        )
        .status,
        StatusCode::UNAUTHORIZED
    );

    let mut invalid_health = harness
        .controls
        .proof("invalid-health", "environment:status");
    invalid_health.environment_id = "other".into();
    harness
        .controls
        .verify_results
        .lock()
        .await
        .insert("invalid-health".into(), Ok(invalid_health));
    assert_eq!(
        error(
            harness
                .service
                .json(
                    JsonOperation::ConnectHealth,
                    Some(json!({"proof":"invalid-health"})),
                    context(HeaderMap::new()),
                )
                .await
        )
        .status,
        StatusCode::UNAUTHORIZED
    );

    harness
        .controls
        .sign_failures
        .lock()
        .await
        .insert(RELAY_HEALTH_RESPONSE_TYP.into());
    assert_eq!(
        error(
            harness
                .service
                .json(
                    JsonOperation::ConnectHealth,
                    Some(json!({"proof":"health-sign"})),
                    context(HeaderMap::new()),
                )
                .await
        )
        .status,
        StatusCode::INTERNAL_SERVER_ERROR
    );
    harness
        .controls
        .sign_failures
        .lock()
        .await
        .remove(RELAY_HEALTH_RESPONSE_TYP);

    let mut invalid_mint = harness
        .controls
        .proof("invalid-mint", "environment:connect");
    invalid_mint.subject = "different-user".into();
    harness
        .controls
        .verify_results
        .lock()
        .await
        .insert("invalid-mint".into(), Ok(invalid_mint));
    assert_eq!(
        error(
            harness
                .service
                .json(
                    JsonOperation::ConnectMintCredential,
                    Some(json!({"proof":"invalid-mint"})),
                    context(HeaderMap::new()),
                )
                .await
        )
        .status,
        StatusCode::UNAUTHORIZED
    );

    *harness.controls.pairing_result.lock().await = Err("pairing".into());
    assert_eq!(
        error(
            harness
                .service
                .json(
                    JsonOperation::ConnectMintCredential,
                    Some(json!({"proof":"pairing-error"})),
                    context(HeaderMap::new()),
                )
                .await
        )
        .status,
        StatusCode::INTERNAL_SERVER_ERROR
    );
    *harness.controls.pairing_result.lock().await = Ok(PairingCredential {
        credential: "secret".into(),
        expires_at: "not-a-time".into(),
    });
    assert_eq!(
        error(
            harness
                .service
                .json(
                    JsonOperation::ConnectMintCredential,
                    Some(json!({"proof":"bad-expiry"})),
                    context(HeaderMap::new()),
                )
                .await
        )
        .status,
        StatusCode::INTERNAL_SERVER_ERROR
    );
    *harness.controls.pairing_result.lock().await = Ok(PairingCredential {
        credential: "secret".into(),
        expires_at: "2026-07-10T12:02:00Z".into(),
    });
    harness
        .controls
        .sign_failures
        .lock()
        .await
        .insert(RELAY_MINT_RESPONSE_TYP.into());
    assert_eq!(
        error(
            harness
                .service
                .json(
                    JsonOperation::ConnectMintCredential,
                    Some(json!({"proof":"mint-sign"})),
                    context(HeaderMap::new()),
                )
                .await
        )
        .status,
        StatusCode::INTERNAL_SERVER_ERROR
    );
    harness
        .controls
        .sign_failures
        .lock()
        .await
        .remove(RELAY_MINT_RESPONSE_TYP);
    let first = harness
        .service
        .json(
            JsonOperation::ConnectMintCredential,
            Some(json!({"proof":"mint-replay"})),
            context(HeaderMap::new()),
        )
        .await
        .unwrap();
    assert_eq!(first.body["credential"], "secret");
    let replay = error(
        harness
            .service
            .json(
                JsonOperation::ConnectMintCredential,
                Some(json!({"proof":"mint-replay"})),
                context(HeaderMap::new()),
            )
            .await,
    );
    assert_eq!(replay.status, StatusCode::CONFLICT);
    assert_eq!(
        replay.body["message"],
        "Cloud mint request was already consumed."
    );

    let response = harness
        .service
        .json(
            JsonOperation::ConnectHealth,
            Some(json!({"proof":"health-ok"})),
            context(HeaderMap::new()),
        )
        .await
        .unwrap();
    assert_eq!(response.body["status"], "online");
    let calls = harness.controls.sign_calls.lock().await;
    let (_, payload) = calls
        .iter()
        .rev()
        .find(|(typ, _)| typ == RELAY_HEALTH_RESPONSE_TYP)
        .unwrap();
    assert_eq!(payload["requestNonce"], "nonce-health-ok");
}

#[tokio::test]
async fn mcp_transport_enforces_auth_capacity_expiry_and_session_ownership() {
    let harness = harness(2, 1).await;
    // An unauthenticated GET is a discovery probe (slice R): 401, naming the metadata.
    let probe = error(
        harness
            .service
            .mcp(Method::GET, Vec::new(), context(HeaderMap::new()))
            .await,
    );
    assert_eq!(probe.status, StatusCode::UNAUTHORIZED);
    assert!(probe.headers["www-authenticate"].contains("resource_metadata="));

    let first = harness
        .service
        .issue_mcp_credential("one", "one", "provider")
        .await
        .unwrap();
    let second = harness
        .service
        .issue_mcp_credential("two", "two", "provider")
        .await
        .unwrap();
    assert_eq!(
        error(
            harness
                .service
                .issue_mcp_credential("three", "three", "provider")
                .await
        )
        .status,
        StatusCode::INTERNAL_SERVER_ERROR
    );
    let replacement = harness
        .service
        .issue_mcp_credential("one", "one", "replacement")
        .await
        .unwrap();
    assert_eq!(
        error(
            harness
                .service
                .mcp(
                    Method::POST,
                    serde_json::to_vec(&json!({"id":1,"method":"initialize"})).unwrap(),
                    context(authorization(&first)),
                )
                .await
        )
        .status,
        StatusCode::UNAUTHORIZED
    );

    let session = initialize(&harness.service, &replacement).await;
    assert_eq!(
        error(
            harness
                .service
                .mcp(
                    Method::POST,
                    serde_json::to_vec(&json!({"id":2,"method":"initialize"})).unwrap(),
                    context(authorization(&replacement)),
                )
                .await
        )
        .status,
        StatusCode::SERVICE_UNAVAILABLE
    );

    let mut wrong_owner = authorization(&second);
    wrong_owner.insert("mcp-session-id", session["mcp-session-id"].clone());
    assert_eq!(
        error(
            harness
                .service
                .mcp(
                    Method::POST,
                    serde_json::to_vec(&json!({"id":3,"method":"ping"})).unwrap(),
                    context(wrong_owner.clone()),
                )
                .await
        )
        .status,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        error(
            harness
                .service
                .mcp(Method::DELETE, Vec::new(), context(wrong_owner))
                .await
        )
        .status,
        StatusCode::UNAUTHORIZED
    );

    assert_eq!(
        error(
            harness
                .service
                .mcp(
                    Method::DELETE,
                    Vec::new(),
                    context(authorization(&replacement))
                )
                .await
        )
        .status,
        StatusCode::BAD_REQUEST
    );
    let mut missing = authorization(&replacement);
    missing.insert("mcp-session-id", HeaderValue::from_static("missing"));
    assert_eq!(
        error(
            harness
                .service
                .mcp(Method::DELETE, Vec::new(), context(missing))
                .await
        )
        .status,
        StatusCode::NOT_FOUND
    );

    let cancelled = error(
        harness
            .service
            .mcp(
                Method::POST,
                serde_json::to_vec(&json!({"id":4,"method":"ping"})).unwrap(),
                cancelled_context(session.clone()),
            )
            .await,
    );
    assert_eq!(cancelled.status, StatusCode::REQUEST_TIMEOUT);

    harness.controls.now.store(1_700_001_801, Ordering::SeqCst);
    assert_eq!(
        error(
            harness
                .service
                .mcp(
                    Method::POST,
                    serde_json::to_vec(&json!({"id":5,"method":"ping"})).unwrap(),
                    context(session),
                )
                .await
        )
        .status,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn mcp_json_rpc_and_preview_tools_preserve_wire_results() {
    let harness = harness(4, 4).await;
    let issued = harness
        .service
        .issue_mcp_credential("thread", "thread", "provider")
        .await
        .unwrap();
    let auth = authorization(&issued);

    // A malformed message gets 400 with its JSON-RPC error in the body.
    for (body, code) in [
        (b"not-json".to_vec(), -32700),
        (serde_json::to_vec(&json!({"id":1})).unwrap(), -32600),
    ] {
        let response = harness
            .service
            .mcp(Method::POST, body, context(auth.clone()))
            .await
            .unwrap();
        assert_eq!(response.status, 400);
        let body: Value = serde_json::from_slice(&response.body).unwrap();
        assert_eq!(body["error"]["code"], code);
    }
    assert_eq!(
        error(
            harness
                .service
                .mcp(
                    Method::POST,
                    serde_json::to_vec(&json!({"id":1,"method":"ping"})).unwrap(),
                    context(auth.clone()),
                )
                .await
        )
        .status,
        StatusCode::BAD_REQUEST
    );
    let mut missing_session = auth.clone();
    missing_session.insert("mcp-session-id", HeaderValue::from_static("missing"));
    assert_eq!(
        error(
            harness
                .service
                .mcp(
                    Method::POST,
                    serde_json::to_vec(&json!({"id":1,"method":"ping"})).unwrap(),
                    context(missing_session),
                )
                .await
        )
        .status,
        StatusCode::NOT_FOUND
    );
    // A message without an id is a notification: accepted, never answered.
    assert_eq!(
        harness
            .service
            .mcp(
                Method::POST,
                serde_json::to_vec(&json!({"method":"initialize"})).unwrap(),
                context(auth.clone()),
            )
            .await
            .unwrap()
            .status,
        202
    );

    let headers = initialize(&harness.service, &issued).await;
    let notification = harness
        .service
        .mcp(
            Method::POST,
            serde_json::to_vec(&json!({"method":"notifications/initialized"})).unwrap(),
            context(headers.clone()),
        )
        .await
        .unwrap();
    assert_eq!(notification.status, 202);
    assert!(notification.body.is_empty());

    let unknown = rpc(
        &harness.service,
        headers.clone(),
        json!({"id":9,"method":"unknown"}),
    )
    .await;
    assert_eq!(unknown["id"], 9);
    assert_eq!(unknown["error"]["code"], -32601);

    let listed = rpc(
        &harness.service,
        headers.clone(),
        json!({"id":2,"method":"tools/list"}),
    )
    .await;
    assert_eq!(
        listed["result"]["tools"].as_array().unwrap().len(),
        TOOL_OPERATIONS.len()
    );

    for name in ["unknown", "preview_unknown"] {
        let response = rpc(
            &harness.service,
            headers.clone(),
            json!({"id":3,"method":"tools/call","params":{"name":name}}),
        )
        .await;
        assert_eq!(response["result"]["isError"], true);
        assert_eq!(
            response["result"]["structuredContent"]["error"]["_tag"],
            "McpUnknownToolError"
        );
    }

    harness
        .controls
        .preview_results
        .lock()
        .await
        .insert("status".into(), Err("preview failed".into()));
    let failed = rpc(
        &harness.service,
        headers.clone(),
        json!({"id":4,"method":"tools/call","params":{"name":"preview_status"}}),
    )
    .await;
    assert_eq!(
        failed["result"]["structuredContent"]["error"]["_tag"],
        "PreviewAutomationExecutionError"
    );

    harness
        .controls
        .preview_results
        .lock()
        .await
        .insert("snapshot".into(), Ok(json!({"url":"https://example.test"})));
    let malformed = rpc(
        &harness.service,
        headers.clone(),
        json!({"id":5,"method":"tools/call","params":{"name":"preview_snapshot"}}),
    )
    .await;
    assert_eq!(malformed["result"]["isError"], true);

    harness.controls.preview_results.lock().await.insert(
        "snapshot".into(),
        Ok(json!({"screenshot":{"data":"image","mimeType":"image/png","width":1,"height":2}})),
    );
    let snapshot = rpc(
        &harness.service,
        headers.clone(),
        json!({"id":6,"method":"tools/call","params":{"name":"preview_snapshot"}}),
    )
    .await;
    assert_eq!(snapshot["result"]["content"][1]["data"], "image");

    for (name, wire) in [
        ("preview_wait_for", "waitFor"),
        ("preview_recording_start", "recordingStart"),
        ("preview_recording_stop", "recordingStop"),
    ] {
        let response = rpc(
            &harness.service,
            headers.clone(),
            json!({
                "id":7,
                "method":"tools/call",
                "params":{"name":name,"arguments":{"tabId":"tab-1","value":1}}
            }),
        )
        .await;
        assert_eq!(response["result"]["isError"], false);
        let calls = harness.controls.preview_calls.lock().await;
        let call = calls.last().unwrap();
        assert_eq!(call.1, wire);
        assert_eq!(call.2, json!({"value":1}));
        assert_eq!(call.3.as_deref(), Some("tab-1"));
    }

    let scalar = rpc(
        &harness.service,
        headers,
        json!({"id":8,"method":"tools/call","params":{"name":"preview_click","arguments":5}}),
    )
    .await;
    assert_eq!(scalar["result"]["structuredContent"], json!({"ok":true}));
    let calls = harness.controls.preview_calls.lock().await;
    let call = calls.last().unwrap();
    assert_eq!(call.2, json!(5));
    assert_eq!(call.3, None);
}

/// A chat panel's provider gets a credential for its own thread whose tools act for its host.
#[tokio::test]
async fn a_credential_carries_the_thread_and_its_owner() {
    let harness = harness(4, 4).await;
    let issued = harness
        .service
        .issue_mcp_credential("panel", "host", "provider")
        .await
        .unwrap();
    assert_eq!(issued.thread_id, "panel");
    let headers = initialize(&harness.service, &issued).await;
    let response = rpc(
        &harness.service,
        headers,
        json!({"id":1,"method":"tools/call","params":{"name":"preview_status"}}),
    )
    .await;
    assert_eq!(response["result"]["isError"], false, "{response}");
    let calls = harness.controls.preview_calls.lock().await;
    let scope = &calls.last().expect("the preview tool ran").0;
    assert_eq!(
        (scope.thread_id.as_str(), scope.owner_thread_id.as_str()),
        ("panel", "host")
    );
}

#[tokio::test]
async fn revocation_and_pruning_remove_credentials_and_sessions_together() {
    let harness = harness(4, 4).await;
    let issued = harness
        .service
        .issue_mcp_credential("thread", "thread", "provider")
        .await
        .unwrap();
    let headers = initialize(&harness.service, &issued).await;
    harness
        .service
        .revoke_mcp_provider_session(&issued.provider_session_id)
        .await;
    assert_eq!(
        error(
            harness
                .service
                .mcp(
                    Method::POST,
                    serde_json::to_vec(&json!({"id":1,"method":"ping"})).unwrap(),
                    context(headers),
                )
                .await
        )
        .status,
        StatusCode::UNAUTHORIZED
    );

    let issued = harness
        .service
        .issue_mcp_credential("other", "other", "provider")
        .await
        .unwrap();
    harness.service.revoke_all_mcp_credentials().await;
    assert_eq!(
        error(
            harness
                .service
                .mcp(
                    Method::POST,
                    serde_json::to_vec(&json!({"id":2,"method":"initialize"})).unwrap(),
                    context(authorization(&issued)),
                )
                .await
        )
        .status,
        StatusCode::UNAUTHORIZED
    );

    let mut state = McpState::default();
    state.credentials.insert(
        "expired".into(),
        McpCredentialRecord {
            scope: PreviewScope {
                environment_id: "env".into(),
                thread_id: "thread".into(),
                owner_thread_id: "thread".into(),
                provider_session_id: "provider".into(),
                provider_instance_id: "instance".into(),
            },
            expires_at: 99,
            last_used_at: 100,
        },
    );
    state.sessions.insert(
        "orphan".into(),
        McpSessionRecord {
            credential_hash: "expired".into(),
            last_used_at: 100,
        },
    );
    prune_mcp(&mut state, 100);
    assert!(state.credentials.is_empty());
    assert!(state.sessions.is_empty());
}

#[tokio::test]
async fn persistence_failures_are_reported_without_partial_success() {
    let parent = TempDir::new().unwrap();
    let blocker = parent.path().join("blocker");
    std::fs::write(&blocker, b"file").unwrap();
    let open = ConnectMcpService::open(
        blocker.join("child").join("connect.sqlite3"),
        ConnectMcpConfig {
            environment_id: "env-1".into(),
            descriptor: json!({}),
            mcp_endpoint: "http://localhost/mcp".into(),
            open_url_endpoint: "http://localhost/api/preview/open-url".into(),
            now_epoch_seconds: Arc::new(|| 0),
            max_mcp_credentials: 1,
            max_mcp_sessions: 1,
        },
        JwtCodec::new(
            |_, _| async { Ok("signed".into()) },
            |_, _, _, _, _, _| async { Err("unused".into()) },
            || async { Ok(("private".into(), "public".into())) },
        ),
        EndpointRuntime::new(|_| async { Ok(json!({"status":"disabled"})) }),
        PairingIssuer::new(|_| async { Err("unused".into()) }),
        PreviewInvoker::new(|_, _, _, _, _| async { Err("unused".into()) }),
        None,
    )
    .await;
    assert_eq!(error(open).status, StatusCode::INTERNAL_SERVER_ERROR);

    for operation in [
        JsonOperation::ConnectLinkState,
        JsonOperation::ConnectRelayConfig,
        JsonOperation::ConnectUnlink,
    ] {
        let harness = harness(4, 4).await;
        std::fs::remove_file(&harness.database_path).unwrap();
        std::fs::create_dir(&harness.database_path).unwrap();
        let payload =
            (operation == JsonOperation::ConnectRelayConfig).then(|| relay_config("cloud-user"));
        let failure = error(
            harness
                .service
                .json(operation, payload, context(HeaderMap::new()))
                .await,
        );
        assert_eq!(failure.status, StatusCode::INTERNAL_SERVER_ERROR);
    }
}

#[tokio::test]
async fn sqlite_failures_map_to_route_specific_errors_without_partial_responses() {
    let harness = harness(4, 4).await;
    let connection = Connection::open(&harness.database_path).unwrap();
    connection
        .execute_batch(
            "CREATE TRIGGER fail_secret_insert
             BEFORE INSERT ON connect_native_secrets
             BEGIN SELECT RAISE(FAIL, 'secret insert failed'); END;",
        )
        .unwrap();
    let persist = error(
        harness
            .service
            .json(
                JsonOperation::ConnectRelayConfig,
                Some(relay_config("cloud-user")),
                context(HeaderMap::new()),
            )
            .await,
    );
    assert_error(
        &persist,
        StatusCode::INTERNAL_SERVER_ERROR,
        "EnvironmentHttpInternalServerError",
        "Could not persist environment relay configuration.",
    );
    connection
        .execute_batch("DROP TRIGGER fail_secret_insert;")
        .unwrap();
    link(&harness).await;

    connection
        .execute_batch(
            "CREATE TRIGGER fail_replay_insert
             BEFORE INSERT ON connect_native_replay
             BEGIN SELECT RAISE(FAIL, 'replay insert failed'); END;",
        )
        .unwrap();
    for (operation, token) in [
        (JsonOperation::ConnectHealth, "health-persist"),
        (JsonOperation::ConnectMintCredential, "mint-persist"),
    ] {
        let failure = error(
            harness
                .service
                .json(
                    operation,
                    Some(json!({"proof":token})),
                    context(HeaderMap::new()),
                )
                .await,
        );
        assert_error(
            &failure,
            StatusCode::INTERNAL_SERVER_ERROR,
            "EnvironmentHttpInternalServerError",
            "Could not persist cloud request replay state.",
        );
    }
    connection
        .execute_batch("DROP TRIGGER fail_replay_insert;")
        .unwrap();

    connection
        .execute_batch(
            "CREATE TRIGGER fail_secret_delete
             BEFORE DELETE ON connect_native_secrets
             BEGIN SELECT RAISE(FAIL, 'secret delete failed'); END;",
        )
        .unwrap();
    let unlink = error(
        harness
            .service
            .json(
                JsonOperation::ConnectUnlink,
                None,
                context(HeaderMap::new()),
            )
            .await,
    );
    assert_error(
        &unlink,
        StatusCode::INTERNAL_SERVER_ERROR,
        "EnvironmentHttpInternalServerError",
        "Could not remove environment relay configuration.",
    );

    let missing_secrets = self::harness(4, 4).await;
    Connection::open(&missing_secrets.database_path)
        .unwrap()
        .execute_batch("DROP TABLE connect_native_secrets;")
        .unwrap();
    assert!(
        missing_secrets
            .service
            .read_secret("relay-url")
            .await
            .is_err()
    );
    assert!(missing_secrets.service.read_link_state().await.is_err());
    assert!(
        missing_secrets
            .service
            .required_link_material()
            .await
            .is_err()
    );

    let malformed_rows = self::harness(4, 4).await;
    Connection::open(&malformed_rows.database_path)
        .unwrap()
        .execute_batch(
            "DROP TABLE connect_native_secrets;
             CREATE TABLE connect_native_secrets(name BLOB, value BLOB);
             INSERT INTO connect_native_secrets(name, value) VALUES ('relay-url', x'FF');",
        )
        .unwrap();
    assert!(malformed_rows.service.read_link_state().await.is_err());

    let deferred_secret_commit = self::harness(4, 4).await;
    Connection::open(&deferred_secret_commit.database_path)
        .unwrap()
        .execute_batch(
            "PRAGMA foreign_keys=OFF;
             DROP TABLE connect_native_secrets;
             CREATE TABLE secret_values(value TEXT PRIMARY KEY);
             CREATE TABLE connect_native_secrets(
               name TEXT PRIMARY KEY NOT NULL,
               value TEXT NOT NULL REFERENCES secret_values(value) DEFERRABLE INITIALLY DEFERRED
             ) STRICT;
             PRAGMA foreign_keys=ON;",
        )
        .unwrap();
    assert!(
        deferred_secret_commit
            .service
            .replace_link_config(LinkConfig {
                relay_url: "https://relay.test".into(),
                relay_issuer: "https://issuer.test".into(),
                cloud_user_id: "user".into(),
                environment_credential: "credential".into(),
                cloud_mint_public_key: "key".into(),
                endpoint_runtime: json!({}),
                origin_port: None,
            })
            .await
            .is_err()
    );

    let deferred_delete_commit = self::harness(4, 4).await;
    let deferred_delete_connection =
        Connection::open(&deferred_delete_commit.database_path).unwrap();
    deferred_delete_connection
        .execute_batch(
            "CREATE TABLE secret_references(
               name TEXT REFERENCES connect_native_secrets(name) DEFERRABLE INITIALLY DEFERRED
             );
             INSERT INTO connect_native_secrets(name, value) VALUES ('relay-url', 'https://relay.test');
             INSERT INTO secret_references(name) VALUES ('relay-url');",
        )
        .unwrap();
    assert!(
        deferred_delete_commit
            .service
            .clear_link_config()
            .await
            .is_err()
    );

    let replay_without_rowid = self::harness(4, 4).await;
    Connection::open(&replay_without_rowid.database_path)
        .unwrap()
        .execute_batch(
            "DROP TABLE connect_native_replay;
             CREATE TABLE connect_native_replay(
               kind TEXT NOT NULL,
               value TEXT NOT NULL,
               consumed_at INTEGER NOT NULL,
               PRIMARY KEY(kind, value)
             ) WITHOUT ROWID;",
        )
        .unwrap();
    assert!(
        replay_without_rowid
            .service
            .consume_replay("health", "jti", "nonce", 1_700_000_000)
            .await
            .is_err()
    );

    let fail_second_replay_insert = self::harness(4, 4).await;
    Connection::open(&fail_second_replay_insert.database_path)
        .unwrap()
        .execute_batch(
            "CREATE TRIGGER fail_nonce_insert
             BEFORE INSERT ON connect_native_replay
             WHEN NEW.kind LIKE '%:nonce'
             BEGIN SELECT RAISE(FAIL, 'nonce insert failed'); END;",
        )
        .unwrap();
    assert!(
        fail_second_replay_insert
            .service
            .consume_replay("health", "jti", "nonce", 1_700_000_000)
            .await
            .is_err()
    );

    let deferred_replay_commit = self::harness(4, 4).await;
    Connection::open(&deferred_replay_commit.database_path)
        .unwrap()
        .execute_batch(
            "PRAGMA foreign_keys=OFF;
             DROP TABLE connect_native_replay;
             CREATE TABLE replay_values(value TEXT PRIMARY KEY);
             CREATE TABLE connect_native_replay(
               kind TEXT NOT NULL,
               value TEXT NOT NULL REFERENCES replay_values(value) DEFERRABLE INITIALLY DEFERRED,
               consumed_at INTEGER NOT NULL,
               PRIMARY KEY(kind, value)
             ) STRICT;
             PRAGMA foreign_keys=ON;",
        )
        .unwrap();
    assert!(
        deferred_replay_commit
            .service
            .consume_replay("health", "jti", "nonce", 1_700_000_000)
            .await
            .is_err()
    );

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        let initialization_failure = TempDir::new().unwrap();
        let read_only_path = initialization_failure.path().join("connect.sqlite3");
        initialize_database(&read_only_path).unwrap();
        let mut file_permissions = std::fs::metadata(&read_only_path).unwrap().permissions();
        file_permissions.set_mode(0o400);
        std::fs::set_permissions(&read_only_path, file_permissions).unwrap();
        let mut directory_permissions = std::fs::metadata(initialization_failure.path())
            .unwrap()
            .permissions();
        directory_permissions.set_mode(0o500);
        std::fs::set_permissions(initialization_failure.path(), directory_permissions).unwrap();
        assert!(initialize_database(&read_only_path).is_err());
        let mut directory_permissions = std::fs::metadata(initialization_failure.path())
            .unwrap()
            .permissions();
        directory_permissions.set_mode(0o700);
        std::fs::set_permissions(initialization_failure.path(), directory_permissions).unwrap();
    }
}

#[test]
fn json_rpc_helpers_preserve_ids_headers_and_errors() {
    let message = json!({"jsonrpc":"2.0","id":7,"result":{"ok":true}});
    let response = mcp_json(StatusCode::OK, &message, None).unwrap();
    assert_eq!(response.headers.len(), 1);
    assert_eq!(
        serde_json::from_slice::<Value>(&response.body).unwrap()["id"],
        7
    );
    let response = mcp_json(StatusCode::NOT_FOUND, &message, Some("session".into())).unwrap();
    assert_eq!(response.status, 404);
    assert_eq!(response.headers["mcp-session-id"], "session");

    let error = ConnectMcpError::invalid_mcp_credential();
    assert_eq!(error.headers[header::WWW_AUTHENTICATE.as_str()], "Bearer");
    let _http = error.into_http();
}

#[tokio::test]
async fn owned_credential_scope_inputs_issue_and_replace_thread_credentials() {
    let harness = harness(2, 2).await;
    let first = harness
        .service
        .issue_mcp_credential(
            "thread-owned".to_string(),
            "thread-owned".to_string(),
            "provider-owned".to_string(),
        )
        .await
        .expect("owned credential inputs should issue");
    let replacement = harness
        .service
        .issue_mcp_credential(
            "thread-owned".to_string(),
            "thread-owned".to_string(),
            "provider-next".to_string(),
        )
        .await
        .expect("same thread credential should replace");

    assert_ne!(first.authorization_header, replacement.authorization_header);
    assert_eq!(replacement.thread_id, "thread-owned");
    assert_eq!(replacement.provider_instance_id, "provider-next");
}

#[test]
fn database_initialization_reports_parent_directory_creation_failures() {
    let temp = TempDir::new().expect("temporary directory");
    let blocker = temp.path().join("blocker");
    std::fs::write(&blocker, b"file").expect("blocker should write");

    assert!(initialize_database(&blocker.join("connect.sqlite3")).is_err());
}

#[tokio::test]
async fn link_state_reports_the_managed_endpoint_and_its_preview_hostnames() {
    let harness = harness(4, 4).await;
    let state = || async {
        harness
            .service
            .json(
                JsonOperation::ConnectLinkState,
                None,
                context(HeaderMap::new()),
            )
            .await
            .expect("link state")
            .body
    };
    let unlinked = state().await;
    assert_eq!(unlinked["managedEndpoint"], false);
    assert_eq!(unlinked["previewHostnames"], false);

    link(&harness).await;
    let linked = state().await;
    assert_eq!(linked["managedEndpoint"], true);
    assert_eq!(linked["previewHostnames"], false);

    let mut config = relay_config("cloud-user");
    config["endpointRuntime"]["hostname"] = json!("env.zone.test");
    config["endpointRuntime"]["previewHostnames"] = json!(["env-p1.zone.test"]);
    harness
        .service
        .json(
            JsonOperation::ConnectRelayConfig,
            Some(config),
            context(HeaderMap::new()),
        )
        .await
        .expect("relink");
    assert_eq!(state().await["previewHostnames"], true);
}

#[tokio::test]
async fn restore_reapplies_the_stored_endpoint_only_when_linked() {
    let harness = harness(4, 4).await;
    assert_eq!(
        harness.service.restore_managed_endpoint().await.unwrap(),
        None
    );
    assert!(harness.controls.endpoint_calls.lock().await.is_empty());

    link(&harness).await;
    harness.controls.endpoint_calls.lock().await.clear();
    let restored = harness.service.restore_managed_endpoint().await.unwrap();
    assert_eq!(restored, Some(json!({"status":"running"})));
    assert_eq!(
        *harness.controls.endpoint_calls.lock().await,
        vec![json!({"providerKind":"cloudflare_tunnel","connectorToken":"token"})]
    );

    *harness.controls.endpoint_result.lock().await = Some(Err("offline".into()));
    assert!(harness.service.restore_managed_endpoint().await.is_err());
}

#[tokio::test]
async fn a_restore_racing_an_unlink_never_restarts_the_tunnel() {
    let harness = harness(4, 4).await;
    link(&harness).await;
    harness.controls.endpoint_calls.lock().await.clear();
    harness.controls.endpoint_delay.store(50, Ordering::SeqCst);

    let restore = harness.service.restore_managed_endpoint();
    let unlink = harness.service.json(
        JsonOperation::ConnectUnlink,
        None,
        context(HeaderMap::new()),
    );
    let (restored, unlinked) = tokio::join!(restore, unlink);
    restored.expect("restore");
    unlinked.expect("unlink");

    assert_eq!(
        harness.controls.endpoint_calls.lock().await.last(),
        Some(&Value::Null),
        "the unlink's disable is the last word on the tunnel"
    );
}

#[tokio::test]
async fn a_tunnel_provisioned_for_another_port_is_not_restored_and_reports_stale() {
    let harness = harness(4, 4).await;
    link(&harness).await;
    let state = || async {
        harness
            .service
            .json(
                JsonOperation::ConnectLinkState,
                None,
                context(HeaderMap::new()),
            )
            .await
            .expect("link state")
            .body
    };
    assert_eq!(state().await["managedEndpointStale"], false);

    // The server now listens on another port than the one the tunnel was linked for.
    open_database(&harness.database_path)
        .unwrap()
        .execute(
            "UPDATE connect_native_secrets SET value = '50000' WHERE name = 'cloud-endpoint-origin-port'",
            [],
        )
        .unwrap();
    harness.controls.endpoint_calls.lock().await.clear();
    assert_eq!(
        harness.service.restore_managed_endpoint().await.unwrap(),
        Some(json!({"status":"stale-origin"}))
    );
    assert!(
        harness.controls.endpoint_calls.lock().await.is_empty(),
        "no connector starts for a tunnel that reaches nothing"
    );
    assert_eq!(state().await["managedEndpointStale"], true);
}

#[tokio::test]
async fn a_background_relink_never_undoes_a_changed_link() {
    let harness = harness(4, 4).await;
    let mut config = relay_config("cloud-user");
    config["requireLinkGeneration"] = json!("not-a-link");
    let refused = error(
        harness
            .service
            .json(
                JsonOperation::ConnectRelayConfig,
                Some(config.clone()),
                context(HeaderMap::new()),
            )
            .await,
    );
    assert_eq!(
        refused.status,
        StatusCode::CONFLICT,
        "the link it named is gone"
    );
    assert!(
        harness.controls.endpoint_calls.lock().await.is_empty(),
        "a refused re-link starts nothing"
    );

    link(&harness).await;
    let state = || async {
        harness
            .service
            .json(
                JsonOperation::ConnectLinkState,
                None,
                context(HeaderMap::new()),
            )
            .await
            .expect("link state")
            .body
    };
    let generation = state().await["linkGeneration"].clone();
    assert!(generation.is_string());
    // Another client unlinks and links again to the same account: a new link.
    harness
        .service
        .json(
            JsonOperation::ConnectUnlink,
            None,
            context(HeaderMap::new()),
        )
        .await
        .expect("unlink");
    let mut relinked = relay_config("cloud-user");
    relinked["environmentCredential"] = json!("rotated-secret");
    harness
        .service
        .json(
            JsonOperation::ConnectRelayConfig,
            Some(relinked),
            context(HeaderMap::new()),
        )
        .await
        .expect("relink");
    assert_ne!(state().await["linkGeneration"], generation);

    config["requireLinkGeneration"] = generation;
    assert_eq!(
        error(
            harness
                .service
                .json(
                    JsonOperation::ConnectRelayConfig,
                    Some(config.clone()),
                    context(HeaderMap::new()),
                )
                .await
        )
        .status,
        StatusCode::CONFLICT,
        "a refresh of the replaced link never overwrites the new one"
    );
    config["requireLinkGeneration"] = state().await["linkGeneration"].clone();
    harness
        .service
        .json(
            JsonOperation::ConnectRelayConfig,
            Some(config),
            context(HeaderMap::new()),
        )
        .await
        .expect("a refresh of the current link applies");
}

#[test]
fn device_tools_are_listed_only_when_enabled() {
    let names = |enabled| {
        tool_descriptors(enabled)
            .iter()
            .map(|tool| tool["name"].as_str().unwrap().to_owned())
            .collect::<Vec<_>>()
    };
    assert!(!names(false).iter().any(|name| name.starts_with("device_")));
    for tool in [
        "device_list",
        "device_open",
        "device_screenshot",
        "device_close",
    ] {
        assert!(names(true).contains(&tool.to_owned()), "{tool}");
    }
    assert!(names(false).contains(&"preview_snapshot".to_owned()));
}

#[test]
fn device_screenshot_describes_both_image_formats() {
    let tools = tool_descriptors(true);
    let screenshot = tools
        .iter()
        .find(|tool| tool["name"] == "device_screenshot")
        .expect("device_screenshot is listed");
    let description = screenshot["description"].as_str().unwrap();
    assert!(
        description.contains("a PNG at most 1080 px wide"),
        "{description}"
    );
    assert!(
        description.contains("a full-size JPEG for a view-only iOS simulator"),
        "{description}"
    );
}

#[test]
fn every_listed_provider_tool_is_registered_with_a_client_twin_of_its_own() {
    use crate::mcp::control::{PrincipalKind, tool_spec, tool_specs};
    let listed: Vec<String> = tool_descriptors(true)
        .iter()
        .map(|tool| tool["name"].as_str().unwrap().to_owned())
        .collect();
    let registered: Vec<&str> = tool_specs(PrincipalKind::Provider)
        .map(|spec| spec.name)
        .collect();
    assert_eq!(listed, registered);
    for name in &listed {
        let spec = tool_spec(PrincipalKind::Provider, name).unwrap();
        // They wait on a page or an emulator, so `mcp.<name>` is long-running.
        assert!(spec.long_running, "{name}");
        assert_eq!(spec.kind, PrincipalKind::Provider, "{name}");
        assert!(spec.capability.is_none(), "{name}");
        // Outside agents' twin (slice D) is a spec of its own, in the Workspace set.
        let twin = tool_spec(PrincipalKind::Client, name).unwrap();
        assert_eq!(twin.kind, PrincipalKind::Client, "{name}");
        assert!(twin.long_running && !twin.holds_wait_slot, "{name}");
    }
}

#[test]
fn device_open_takes_a_platform_and_an_image() {
    let tools = tool_descriptors(true);
    let open = tools
        .iter()
        .find(|tool| tool["name"] == "device_open")
        .expect("device_open is listed");
    let properties = &open["inputSchema"]["properties"];
    assert_eq!(
        properties["platform"]["enum"],
        serde_json::json!(["android", "ios"])
    );
    assert_eq!(properties["platform"]["default"], "android");
    assert_eq!(properties["imageId"]["type"], "string");
    assert!(properties.get("avdName").is_none());
    for tool in tools
        .iter()
        .filter(|tool| tool["name"].as_str().unwrap().starts_with("device_"))
    {
        assert!(
            tool["description"]
                .as_str()
                .unwrap()
                .contains("Android emulators and iOS simulators (macOS servers)"),
            "{tool}"
        );
    }
}

#[cfg(unix)]
mod device_tools {
    use std::time::Duration;

    use base64::{Engine as _, engine::general_purpose::STANDARD};
    use serde_json::json;

    use tokio_util::sync::CancellationToken;

    use super::{DeviceTools, PreviewScope};
    use crate::device::android::testing::{LaunchStub, ManagerFixture, process_alive, wait_until};

    fn scope() -> PreviewScope {
        PreviewScope {
            environment_id: "environment".into(),
            thread_id: "thread".into(),
            owner_thread_id: "thread".into(),
            provider_session_id: "provider-session".into(),
            provider_instance_id: "provider-instance".into(),
        }
    }

    struct DeviceToolsFixture {
        tools: DeviceTools,
        fixture: ManagerFixture,
    }

    impl DeviceToolsFixture {
        fn new(fixture: ManagerFixture) -> Self {
            Self {
                tools: DeviceTools::new(fixture.manager.clone()),
                fixture,
            }
        }

        async fn ready_device() -> Self {
            let fixture = Self::ready_sdk(&["Pixel"]).await;
            let result = fixture
                .tools
                .call(&scope(), "open", json!({}), CancellationToken::new())
                .await;
            assert_eq!(result["isError"], false, "{result}");
            fixture
        }

        async fn ready_sdk(avds: &[&str]) -> Self {
            Self::new(ManagerFixture::ready(avds).await)
        }

        async fn slow_boot() -> Self {
            Self::new(ManagerFixture::with_sdk(|sdk| sdk.avds(&["Pixel"]).never_boots()).await)
        }

        async fn disabled() -> Self {
            let fixture = Self::ready_sdk(&["Pixel"]).await;
            fixture.fixture.enabled.send(false).unwrap();
            fixture
        }
    }

    #[tokio::test]
    async fn device_screenshot_returns_an_image_block() {
        let fixture = DeviceToolsFixture::ready_device().await;
        let result = fixture
            .tools
            .call(&scope(), "screenshot", json!({}), CancellationToken::new())
            .await;
        assert_eq!(result["isError"], false, "{result}");
        let image = result["content"]
            .as_array()
            .unwrap()
            .iter()
            .find(|block| block["type"] == "image")
            .unwrap();
        assert_eq!(image["mimeType"], "image/png");
        let bytes = STANDARD.decode(image["data"].as_str().unwrap()).unwrap();
        assert!(bytes.starts_with(b"\x89PNG"));
        assert_eq!(result["structuredContent"]["screenshot"]["width"], 1080);
        assert_eq!(result["structuredContent"]["platform"], "android");
    }

    #[tokio::test]
    async fn device_list_reports_the_catalog() {
        let fixture = DeviceToolsFixture::ready_device().await;
        let result = fixture
            .tools
            .call(&scope(), "list", json!({}), CancellationToken::new())
            .await;
        assert_eq!(result["isError"], false);
        assert_eq!(
            result["structuredContent"]["platforms"][0]["images"][0]["id"],
            "Pixel"
        );
        assert_eq!(result["structuredContent"]["devices"][0]["state"], "ready");
        assert_eq!(
            result["structuredContent"]["platforms"][0]["platform"],
            "android"
        );
        assert_eq!(
            result["structuredContent"]["devices"][0]["platform"],
            "android"
        );
    }

    #[tokio::test]
    async fn device_close_stops_the_device() {
        let fixture = DeviceToolsFixture::ready_device().await;
        let id = fixture.fixture.manager.catalog().borrow().devices[0]
            .device_id
            .clone();
        let missing = fixture
            .tools
            .call(&scope(), "close", json!({}), CancellationToken::new())
            .await;
        assert_eq!(
            missing["structuredContent"]["error"]["_tag"],
            "DeviceInputError"
        );
        let closed = fixture
            .tools
            .call(
                &scope(),
                "close",
                json!({"deviceId": id}),
                CancellationToken::new(),
            )
            .await;
        assert_eq!(closed["isError"], false, "{closed}");
        assert_eq!(closed["structuredContent"]["platform"], "android");
        let after = fixture
            .tools
            .call(&scope(), "screenshot", json!({}), CancellationToken::new())
            .await;
        assert_eq!(
            after["structuredContent"]["error"]["_tag"],
            "DeviceNotFoundError"
        );
    }

    /// An agent of `owner`'s own thread.
    fn scope_for(owner: &str) -> PreviewScope {
        PreviewScope {
            thread_id: owner.into(),
            owner_thread_id: owner.into(),
            ..scope()
        }
    }

    /// `owner` opens `image` through the tools and gets its device id.
    async fn open_as(fixture: &DeviceToolsFixture, owner: &str, image: &str) -> String {
        let result = fixture
            .tools
            .call(
                &scope_for(owner),
                "open",
                json!({"imageId": image}),
                CancellationToken::new(),
            )
            .await;
        assert_eq!(result["isError"], false, "{result}");
        result["structuredContent"]["deviceId"]
            .as_str()
            .unwrap()
            .to_owned()
    }

    #[tokio::test]
    async fn device_list_marks_the_devices_the_callers_thread_started() {
        let fixture = DeviceToolsFixture::ready_sdk(&["Pixel", "Tablet"]).await;
        let pixel = open_as(&fixture, "t1", "Pixel").await;
        let tablet = open_as(&fixture, "t2", "Tablet").await;
        let result = fixture
            .tools
            .call(
                &scope_for("t1"),
                "list",
                json!({}),
                CancellationToken::new(),
            )
            .await;
        let devices = result["structuredContent"]["devices"].as_array().unwrap();
        let mark = |id: &str| {
            devices
                .iter()
                .find(|device| device["deviceId"] == id)
                .unwrap()["thisThread"]
                .clone()
        };
        assert_eq!((mark(&pixel), mark(&tablet)), (json!(true), json!(false)));
        fixture.fixture.manager.shutdown().await;
    }

    #[tokio::test]
    async fn device_screenshot_without_an_id_takes_the_callers_device() {
        let fixture = DeviceToolsFixture::ready_sdk(&["Pixel", "Tablet"]).await;
        let pixel = open_as(&fixture, "t1", "Pixel").await;
        let tablet = open_as(&fixture, "t2", "Tablet").await;
        for (owner, expected) in [("t1", &pixel), ("t2", &tablet)] {
            let result = fixture
                .tools
                .call(
                    &scope_for(owner),
                    "screenshot",
                    json!({}),
                    CancellationToken::new(),
                )
                .await;
            assert_eq!(result["isError"], false, "{result}");
            assert_eq!(result["structuredContent"]["deviceId"], expected.as_str());
        }
        // A thread with no device of its own, with two running, is told which there are.
        let neither = fixture
            .tools
            .call(
                &scope_for("idle-thread"),
                "screenshot",
                json!({}),
                CancellationToken::new(),
            )
            .await;
        assert_eq!(
            neither["structuredContent"]["error"]["_tag"],
            "DeviceInputError"
        );
        assert!(
            text(&neither).contains(&pixel) && text(&neither).contains(&tablet),
            "{neither}"
        );
        fixture.fixture.manager.shutdown().await;
    }

    #[tokio::test]
    async fn another_threads_device_is_neither_attached_nor_stopped() {
        let fixture = DeviceToolsFixture::ready_sdk(&["Pixel"]).await;
        let pixel = open_as(&fixture, "t1", "Pixel").await;
        let open = fixture
            .tools
            .call(
                &scope_for("t2"),
                "open",
                json!({"imageId": "Pixel"}),
                CancellationToken::new(),
            )
            .await;
        assert_eq!(
            open["structuredContent"]["error"]["_tag"],
            "DeviceBusyError"
        );
        assert_eq!(
            text(&open),
            "Pixel is in use by another thread. Start a different image, or look at it with device_screenshot."
        );
        let close = fixture
            .tools
            .call(
                &scope_for("t2"),
                "close",
                json!({"deviceId": pixel}),
                CancellationToken::new(),
            )
            .await;
        assert_eq!(
            close["structuredContent"]["error"]["_tag"],
            "DeviceBusyError"
        );
        assert_eq!(
            text(&close),
            "Pixel was started by another thread. Ask the user to stop it."
        );
        // It may look at it.
        let screenshot = fixture
            .tools
            .call(
                &scope_for("t2"),
                "screenshot",
                json!({"deviceId": pixel}),
                CancellationToken::new(),
            )
            .await;
        assert_eq!(screenshot["isError"], false, "{screenshot}");
        // The owner's own open of the image returns its device.
        assert_eq!(open_as(&fixture, "t1", "Pixel").await, pixel);
        assert_eq!(fixture.fixture.sdk.launched_pids().len(), 1);
        let closed = fixture
            .tools
            .call(
                &scope_for("t1"),
                "close",
                json!({"deviceId": pixel}),
                CancellationToken::new(),
            )
            .await;
        assert_eq!(closed["isError"], false, "{closed}");
        fixture.fixture.manager.shutdown().await;
    }

    /// A chat panel's agent works for its host: it shares the device the host's Device pane
    /// started.
    #[tokio::test]
    async fn a_chat_panels_agent_uses_its_hosts_device() {
        use crate::device::catalog::{DeviceState, Platform};
        let fixture = DeviceToolsFixture::ready_sdk(&["Pixel"]).await;
        let host = fixture
            .fixture
            .manager
            .open(Platform::Android, "Pixel", Some("host"))
            .await
            .unwrap();
        fixture.fixture.wait_state(&host, DeviceState::Ready).await;
        let panel = PreviewScope {
            thread_id: "panel".into(),
            owner_thread_id: "host".into(),
            ..scope()
        };
        let open = fixture
            .tools
            .call(
                &panel,
                "open",
                json!({"imageId": "Pixel"}),
                CancellationToken::new(),
            )
            .await;
        assert_eq!(
            open["structuredContent"]["deviceId"],
            host.as_str(),
            "{open}"
        );
        let screenshot = fixture
            .tools
            .call(&panel, "screenshot", json!({}), CancellationToken::new())
            .await;
        assert_eq!(screenshot["structuredContent"]["deviceId"], host.as_str());
        let closed = fixture
            .tools
            .call(
                &panel,
                "close",
                json!({"deviceId": host}),
                CancellationToken::new(),
            )
            .await;
        assert_eq!(closed["structuredContent"]["closed"], true, "{closed}");
        fixture.fixture.manager.shutdown().await;
    }

    #[tokio::test]
    async fn device_open_fails_when_disabled_mid_boot() {
        let fixture = DeviceToolsFixture::slow_boot().await;
        let call = tokio::spawn({
            let tools = fixture.tools.clone();
            async move {
                tools
                    .call(
                        &scope(),
                        "open",
                        json!({"platform": "android", "imageId": "Pixel"}),
                        CancellationToken::new(),
                    )
                    .await
            }
        });
        tokio::time::sleep(Duration::from_millis(200)).await;
        fixture.fixture.enabled.send(false).unwrap();
        let result = call.await.unwrap();
        assert_eq!(result["isError"], true);
        assert_eq!(
            result["structuredContent"]["error"]["_tag"],
            "DevicePreviewsDisabledError"
        );
        assert!(
            result["content"][0]["text"]
                .as_str()
                .unwrap()
                .contains("off")
        );
        wait_until(|| {
            fixture
                .fixture
                .sdk
                .launched_pids()
                .iter()
                .all(|pid| !process_alive(*pid))
        })
        .await;
    }

    #[tokio::test]
    async fn device_call_when_disabled_is_a_tool_error() {
        let fixture = DeviceToolsFixture::disabled().await;
        let result = fixture
            .tools
            .call(&scope(), "list", json!({}), CancellationToken::new())
            .await;
        assert_eq!(
            result["structuredContent"]["error"]["_tag"],
            "DevicePreviewsDisabledError"
        );
    }

    #[tokio::test]
    async fn device_open_without_name_uses_the_only_avd_and_lists_choices_otherwise() {
        let one = DeviceToolsFixture::ready_sdk(&["Pixel"]).await;
        assert_eq!(
            one.tools
                .call(&scope(), "open", json!({}), CancellationToken::new())
                .await["isError"],
            false
        );
        let two = DeviceToolsFixture::ready_sdk(&["Pixel", "Tablet"]).await;
        let result = two
            .tools
            .call(&scope(), "open", json!({}), CancellationToken::new())
            .await;
        assert_eq!(result["isError"], true);
        assert!(
            result["content"][0]["text"]
                .as_str()
                .unwrap()
                .contains("Pass imageId as one of: Pixel, Tablet")
        );
    }

    #[tokio::test]
    async fn device_open_defaults_to_android() {
        let fixture = DeviceToolsFixture::ready_sdk(&["Pixel", "Tablet"]).await;
        let result = fixture
            .tools
            .call(
                &scope(),
                "open",
                json!({"imageId": "Tablet"}),
                CancellationToken::new(),
            )
            .await;
        assert_eq!(result["isError"], false, "{result}");
        assert_eq!(result["structuredContent"]["device"]["platform"], "android");
        assert_eq!(result["structuredContent"]["device"]["imageId"], "Tablet");
    }

    #[tokio::test]
    async fn device_open_rejects_an_unknown_platform_and_the_old_argument() {
        let fixture = DeviceToolsFixture::ready_sdk(&["Pixel"]).await;
        let unknown = fixture
            .tools
            .call(
                &scope(),
                "open",
                json!({"platform": "windows", "imageId": "Pixel"}),
                CancellationToken::new(),
            )
            .await;
        assert_eq!(
            unknown["structuredContent"]["error"]["_tag"], "DeviceInputError",
            "{unknown}"
        );
        assert!(text(&unknown).contains("android or ios"), "{unknown}");
        // No iOS backend runs here, so naming iOS says so instead of starting anything.
        let ios = fixture
            .tools
            .call(
                &scope(),
                "open",
                json!({"platform": "ios"}),
                CancellationToken::new(),
            )
            .await;
        assert_eq!(ios["isError"], true, "{ios}");
        assert!(text(&ios).contains("iOS simulators"), "{ios}");
        let old = fixture
            .tools
            .call(
                &scope(),
                "open",
                json!({"avdName": "Pixel"}),
                CancellationToken::new(),
            )
            .await;
        assert_eq!(
            old["structuredContent"]["error"]["_tag"], "DeviceInputError",
            "{old}"
        );
        assert!(
            fixture
                .fixture
                .manager
                .catalog()
                .borrow()
                .devices
                .is_empty()
        );
    }

    fn text(result: &serde_json::Value) -> &str {
        result["content"][0]["text"].as_str().unwrap()
    }

    #[tokio::test]
    async fn device_open_reports_why_the_emulator_failed() {
        let fixture = DeviceToolsFixture::new(
            ManagerFixture::with_sdk(|sdk| {
                sdk.avds(&["Pixel"])
                    .launch_stub(LaunchStub::ExitsWith(1, "no acceleration"))
            })
            .await,
        );
        let result = fixture
            .tools
            .call(&scope(), "open", json!({}), CancellationToken::new())
            .await;
        assert_eq!(result["isError"], true);
        assert!(
            text(&result).starts_with("The device failed to start: "),
            "{result}"
        );
        assert!(text(&result).contains("exited"), "{result}");
    }

    #[tokio::test]
    async fn device_open_says_when_the_device_is_still_booting() {
        let fixture = DeviceToolsFixture::slow_boot().await;
        let tools = fixture
            .tools
            .clone()
            .with_boot_timeout(Duration::from_millis(300));
        let result = tools
            .call(&scope(), "open", json!({}), CancellationToken::new())
            .await;
        assert_eq!(result["isError"], true);
        assert!(text(&result).contains("still booting"), "{result}");
        assert!(text(&result).contains("device_list"), "{result}");
    }

    #[tokio::test]
    async fn device_open_returns_promptly_when_cancelled() {
        let fixture = DeviceToolsFixture::slow_boot().await;
        let cancellation = CancellationToken::new();
        let call = tokio::spawn({
            let (tools, cancellation) = (fixture.tools.clone(), cancellation.clone());
            async move { tools.call(&scope(), "open", json!({}), cancellation).await }
        });
        tokio::time::sleep(Duration::from_millis(200)).await;
        cancellation.cancel();
        let result = tokio::time::timeout(Duration::from_secs(2), call)
            .await
            .expect("returns promptly")
            .unwrap();
        assert_eq!(result["isError"], true);
        assert!(text(&result).contains("cancelled"), "{result}");
    }

    #[tokio::test]
    async fn non_string_arguments_are_invalid_input() {
        let fixture = DeviceToolsFixture::ready_sdk(&["Pixel"]).await;
        for (operation, arguments) in [
            ("open", json!({"imageId": 7})),
            ("open", json!({"platform": 7})),
            ("screenshot", json!({"deviceId": ["x"]})),
            ("close", json!({"deviceId": 1})),
        ] {
            let result = fixture
                .tools
                .call(&scope(), operation, arguments, CancellationToken::new())
                .await;
            assert_eq!(
                result["structuredContent"]["error"]["_tag"], "DeviceInputError",
                "{operation}: {result}"
            );
        }
        assert!(
            fixture
                .fixture
                .manager
                .catalog()
                .borrow()
                .devices
                .is_empty()
        );
    }
}

fn bearer(token: &str) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        header::AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {token}")).unwrap(),
    );
    headers
}

async fn post(service: &ConnectMcpService, headers: HeaderMap, request: Value) -> McpHttpResponse {
    service
        .mcp(
            Method::POST,
            serde_json::to_vec(&request).unwrap(),
            context(headers),
        )
        .await
        .expect("MCP response")
}

fn body(response: &McpHttpResponse) -> Value {
    serde_json::from_slice(&response.body).expect("JSON body")
}

fn names(listed: &Value) -> Vec<String> {
    listed["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["name"].as_str().unwrap().to_owned())
        .collect()
}

#[tokio::test]
async fn providers_and_outside_agents_share_mcp_with_separate_tools_and_checks() {
    let tools = crate::production::mcp_tools_tests::Harness::new().await;
    let (_agent, token) = tools
        .agent(crate::mcp::control::McpAccess::FullAccess)
        .await;
    let connect = harness(4, 4).await;
    let service = connect.service.clone().with_control(tools.control.clone());
    let issued = service
        .issue_mcp_credential("thread", "thread", "provider")
        .await
        .unwrap();

    // A web page's Origin is refused; this server's own origin is not.
    let mut from_page = bearer(&token);
    from_page.insert(
        header::ORIGIN,
        HeaderValue::from_static("https://evil.example"),
    );
    let refused = service
        .mcp(
            Method::POST,
            serde_json::to_vec(&json!({"jsonrpc":"2.0","id":1,"method":"ping"})).unwrap(),
            context(from_page),
        )
        .await;
    assert_eq!(error(refused).status, StatusCode::FORBIDDEN);
    let mut own = bearer(&token);
    own.insert(
        header::ORIGIN,
        HeaderValue::from_static("http://127.0.0.1:3773"),
    );
    own.insert(header::HOST, HeaderValue::from_static("127.0.0.1:3773"));
    assert_eq!(
        post(
            &service,
            own,
            json!({"jsonrpc":"2.0","id":1,"method":"ping"})
        )
        .await
        .status,
        200
    );

    // A legacy outside agent: no HTTP session, and an unknown version answers 2025-11-25.
    let initialized = post(
        &service,
        bearer(&token),
        json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2099-01-01"}}),
    )
    .await;
    assert!(!initialized.headers.contains_key("mcp-session-id"));
    assert_eq!(
        body(&initialized)["result"]["protocolVersion"],
        "2025-11-25"
    );
    let mut later = bearer(&token);
    later.insert(
        "mcp-protocol-version",
        HeaderValue::from_static("2025-11-25"),
    );
    let listed = body(
        &post(
            &service,
            later,
            json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}),
        )
        .await,
    );
    let client_tools = names(&listed);
    assert!(client_tools.contains(&"start_thread".to_owned()));
    // Outside agents list their own twin of each preview tool, which names its thread.
    let twin = listed["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|tool| tool["name"] == "preview_status")
        .expect("the client twin is listed");
    assert_eq!(twin["inputSchema"]["required"], json!(["threadId"]));
    assert_eq!(listed["result"]["cacheScope"], "private");

    // A provider lists no thread tools, and a provider's legacy initialize also negotiates.
    let provider = initialize(&service, &issued).await;
    let provider_tools = names(
        &rpc(
            &service,
            provider.clone(),
            json!({"jsonrpc":"2.0","id":3,"method":"tools/list"}),
        )
        .await,
    );
    assert!(
        provider_tools
            .iter()
            .all(|name| name.starts_with("preview_") || name.starts_with("device_"))
    );

    // Each kind's call to the other's tool is a scope refusal.
    let crossed = rpc(
        &service,
        provider,
        json!({"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"start_thread","arguments":{}}}),
    )
    .await;
    assert_eq!(
        crossed["result"]["structuredContent"]["error"]["_tag"],
        "McpScopeError"
    );

    // A provider still reaches its own preview tool, for the thread its credential names.
    let own = rpc(
        &service,
        initialize(&service, &issued).await,
        json!({"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"preview_status","arguments":{}}}),
    )
    .await;
    assert_eq!(own["result"]["isError"], false, "{own}");
    {
        let calls = connect.controls.preview_calls.lock().await;
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0.provider_session_id, issued.provider_session_id);
        assert_eq!(calls[0].0.thread_id, "thread");
    }
    // An outside agent's call of that name is its twin's, never the provider's: it needs a
    // thread of this environment, not a provider's credential.
    let twin_call = |id: u64, arguments: Value| {
        post(
            &service,
            bearer(&token),
            json!({"jsonrpc":"2.0","id":id,"method":"tools/call","params":{"name":"preview_status","arguments":arguments}}),
        )
    };
    let missing = body(&twin_call(6, json!({})).await);
    assert_eq!(
        missing["result"]["structuredContent"]["error"]["_tag"],
        "McpInvalidArgumentError"
    );
    let unknown = body(&twin_call(7, json!({ "threadId": "thread" })).await);
    assert_eq!(
        unknown["result"]["structuredContent"]["error"]["_tag"],
        "McpThreadNotFoundError"
    );
    assert_eq!(connect.controls.preview_calls.lock().await.len(), 1);

    // A modern request whose headers disagree with its body is refused.
    let meta = json!({"io.modelcontextprotocol/protocolVersion": "2026-07-28"});
    let mut mismatched = bearer(&token);
    mismatched.insert(
        "mcp-protocol-version",
        HeaderValue::from_static("2026-07-28"),
    );
    mismatched.insert("mcp-method", HeaderValue::from_static("tools/call"));
    mismatched.insert("mcp-name", HeaderValue::from_static("read_thread"));
    let response = post(
        &service,
        mismatched.clone(),
        json!({"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"list_projects_and_threads","arguments":{},"_meta":meta}}),
    )
    .await;
    assert_eq!(response.status, 400);
    assert_eq!(body(&response)["error"]["code"], -32020);
    mismatched.insert(
        "mcp-name",
        HeaderValue::from_static("list_projects_and_threads"),
    );
    let response = post(
        &service,
        mismatched,
        json!({"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"list_projects_and_threads","arguments":{},"_meta":meta}}),
    )
    .await;
    assert_eq!(response.status, 200);
    assert_eq!(body(&response)["result"]["resultType"], "complete");

    // Any other session token is not an MCP credential.
    let link = crate::auth::issue_administrative_pairing_link(&tools.repositories, None)
        .await
        .unwrap();
    let standard = tools
        .auth
        .exchange_bootstrap(
            &link.credential,
            Some(vec![
                "orchestration:read".into(),
                "orchestration:operate".into(),
            ]),
            crate::auth::ClientMetadata::default(),
            None,
            crate::auth::SessionTransport::Plain,
        )
        .await
        .unwrap();
    let refused = service
        .mcp(
            Method::POST,
            serde_json::to_vec(&json!({"jsonrpc":"2.0","id":8,"method":"tools/list"})).unwrap(),
            context(bearer(&standard.token)),
        )
        .await;
    assert_eq!(error(refused).status, StatusCode::UNAUTHORIZED);

    // Off: a typed refusal for outside agents, while provider tools keep working.
    tools
        .settings
        .send_replace(crate::mcp::control::McpServerSettings {
            enabled: false,
            access: crate::mcp::control::McpAccess::FullAccess,
            ..Default::default()
        });
    let off = body(
        &post(
            &service,
            bearer(&token),
            json!({"jsonrpc":"2.0","id":9,"method":"tools/list"}),
        )
        .await,
    );
    assert_eq!(off["error"]["data"]["_tag"], "McpServerDisabledError");
    let provider = initialize(&service, &issued).await;
    let status = rpc(
        &service,
        provider,
        json!({"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"preview_status","arguments":{}}}),
    )
    .await;
    assert_ne!(
        status["result"]["structuredContent"]["error"]["_tag"],
        "McpServerDisabledError"
    );
    assert_ne!(
        status["result"]["structuredContent"]["error"]["_tag"],
        "McpScopeError"
    );
    // On again: the same token works with no new initialize.
    tools
        .settings
        .send_replace(crate::mcp::control::McpServerSettings {
            enabled: true,
            access: crate::mcp::control::McpAccess::FullAccess,
            ..Default::default()
        });
    let mut again = bearer(&token);
    again.insert(
        "mcp-protocol-version",
        HeaderValue::from_static("2025-11-25"),
    );
    let listed = body(
        &post(
            &service,
            again,
            json!({"jsonrpc":"2.0","id":11,"method":"tools/list"}),
        )
        .await,
    );
    assert!(names(&listed).contains(&"read_thread".to_owned()));
    tools.shutdown().await;
}

#[tokio::test]
async fn a_wait_with_a_progress_token_streams_progress_then_its_result() {
    let tools = crate::production::mcp_tools_tests::Harness::new().await;
    let (agent, token) = tools
        .agent(crate::mcp::control::McpAccess::FullAccess)
        .await;
    let started = tools
        .control
        .call(
            &agent,
            "start_thread",
            &serde_json::from_value(json!({"projectId":"p1","prompt":"hi","providerInstanceId":"codex","model":"gpt-5"})).unwrap(),
            None,
            CancellationToken::new(),
        )
        .await;
    let thread_id = started["structuredContent"]["threadId"]
        .as_str()
        .unwrap()
        .to_owned();
    let connect = harness(4, 4).await;
    let service = connect.service.clone().with_control(tools.control.clone());
    let mut response = post(
        &service,
        bearer(&token),
        json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"wait_for_thread","arguments":{"threadId":thread_id,"timeoutMs":300},"_meta":{"progressToken":"p-1"}}}),
    )
    .await;
    assert_eq!(response.headers["content-type"], "text/event-stream");
    let mut stream = response.stream.take().expect("a streamed body");
    let mut frames = Vec::new();
    while let Some(frame) = stream.recv().await {
        frames.push(String::from_utf8(frame).unwrap());
    }
    let messages: Vec<Value> = frames
        .iter()
        .map(|frame| {
            serde_json::from_str(frame.trim().strip_prefix("event: message\ndata: ").unwrap())
                .unwrap()
        })
        .collect();
    assert!(messages.len() >= 2, "{frames:?}");
    assert_eq!(messages[0]["method"], "notifications/progress");
    assert_eq!(messages[0]["params"]["progressToken"], "p-1");
    let last = messages.last().unwrap();
    assert_eq!(last["id"], 1);
    assert_eq!(last["result"]["structuredContent"]["timedOut"], true);
    tools.shutdown().await;
}

/// A request as it arrives through the managed tunnel at `origin`, or through a local proxy.
fn arriving(headers: HeaderMap, class: crate::RequestClass, origin: &str) -> RouteContext {
    RouteContext {
        headers,
        uri: Uri::from_static("/mcp"),
        origin: crate::RequestOrigin {
            class,
            origin: Some(origin.to_owned()),
            source_key: "tunnel".to_owned(),
        },
        cancellation: CancellationToken::new(),
    }
}

fn ping() -> Vec<u8> {
    serde_json::to_vec(&json!({"jsonrpc":"2.0","id":1,"method":"ping"})).unwrap()
}

/// Slice R: each bearer kind is accepted only where it belongs. A provider's token and a
/// relay session work on a direct request and get 401 through the tunnel or a proxy; a
/// remote OAuth session works only at the origin its grant is bound to.
#[tokio::test]
async fn each_bearer_is_accepted_only_where_it_belongs() {
    let tools = crate::production::mcp_tools_tests::Harness::new().await;
    let (_agent, relay_token) = tools
        .agent(crate::mcp::control::McpAccess::FullAccess)
        .await;
    let connect = harness(4, 4).await;
    let service = connect.service.clone().with_control(tools.control.clone());
    let provider = service
        .issue_mcp_credential("thread", "thread", "provider")
        .await
        .unwrap();
    let provider_token = provider
        .authorization_header
        .strip_prefix("Bearer ")
        .unwrap()
        .to_owned();
    let tunnel = "https://env-1.connect.example";
    let (oauth_token, _) = crate::auth::oauth::test_remote_grant(
        &tools.auth,
        tunnel,
        "approval-required",
        "orchestration:read orchestration:operate",
    )
    .await;

    for token in [&relay_token, &provider_token] {
        let modern = |token: &str| {
            let mut headers = bearer(token);
            headers.insert(
                "mcp-protocol-version",
                HeaderValue::from_static("2025-11-25"),
            );
            headers
        };
        let direct = service
            .mcp(Method::POST, ping(), context(modern(token)))
            .await;
        // A provider's legacy ping needs its session (400); neither is refused as a credential.
        assert!(
            direct
                .as_ref()
                .map_or_else(|error| error.status != StatusCode::UNAUTHORIZED, |_| true),
            "a direct request is authenticated"
        );
        for (class, origin) in [
            (crate::RequestClass::ManagedTunnel, tunnel),
            (crate::RequestClass::LocalProxy, "https://proxy.example"),
        ] {
            let refused = error(
                service
                    .mcp(Method::POST, ping(), arriving(modern(token), class, origin))
                    .await,
            );
            assert_eq!(refused.status, StatusCode::UNAUTHORIZED, "{class:?}");
        }
    }

    // The OAuth grant works at its own origin only.
    let through_tunnel = service
        .mcp(
            Method::POST,
            ping(),
            arriving(
                bearer(&oauth_token),
                crate::RequestClass::ManagedTunnel,
                tunnel,
            ),
        )
        .await;
    assert!(through_tunnel.is_ok());
    for refused in [
        context(bearer(&oauth_token)),
        arriving(
            bearer(&oauth_token),
            crate::RequestClass::LocalProxy,
            "https://other.example",
        ),
    ] {
        assert_eq!(
            error(service.mcp(Method::POST, ping(), refused).await).status,
            StatusCode::UNAUTHORIZED
        );
    }
    tools.shutdown().await;
}

/// The 401 names the protected resource metadata on an eligible origin, for POST and GET
/// alike; an authenticated GET is 405, and an outside agent has no session to DELETE.
#[tokio::test]
async fn the_challenge_names_the_metadata_on_an_eligible_origin_only() {
    let tools = crate::production::mcp_tools_tests::Harness::new().await;
    let (_agent, token) = tools
        .agent(crate::mcp::control::McpAccess::FullAccess)
        .await;
    let connect = harness(4, 4).await;
    let service = connect.service.clone().with_control(tools.control.clone());
    for method in [Method::POST, Method::GET] {
        let challenged = error(
            service
                .mcp(method.clone(), ping(), context(HeaderMap::new()))
                .await,
        );
        assert_eq!(challenged.status, StatusCode::UNAUTHORIZED);
        assert_eq!(
            challenged.headers["www-authenticate"],
            "Bearer resource_metadata=\"http://127.0.0.1:43123/.well-known/oauth-protected-resource/mcp\", scope=\"orchestration:read orchestration:operate\""
        );
        let tunnel = error(
            service
                .mcp(
                    method.clone(),
                    ping(),
                    arriving(
                        HeaderMap::new(),
                        crate::RequestClass::ManagedTunnel,
                        "https://env-1.connect.example",
                    ),
                )
                .await,
        );
        assert!(
            tunnel.headers["www-authenticate"]
                .contains("https://env-1.connect.example/.well-known/oauth-protected-resource/mcp")
        );
        // A plain-HTTP LAN origin, or any other, serves no OAuth: a plain challenge.
        let lan = error(
            service
                .mcp(
                    method.clone(),
                    ping(),
                    arriving(
                        HeaderMap::new(),
                        crate::RequestClass::Direct,
                        "http://192.168.1.5:3773",
                    ),
                )
                .await,
        );
        assert_eq!(lan.headers["www-authenticate"], "Bearer");
    }
    assert_eq!(
        error(
            service
                .mcp(Method::GET, Vec::new(), context(bearer(&token)))
                .await
        )
        .status,
        StatusCode::METHOD_NOT_ALLOWED
    );
    let mut delete = bearer(&token);
    delete.insert("mcp-session-id", HeaderValue::from_static("anything"));
    assert_eq!(
        error(
            service
                .mcp(Method::DELETE, Vec::new(), context(delete))
                .await
        )
        .status,
        StatusCode::METHOD_NOT_ALLOWED
    );
    tools.shutdown().await;
}
