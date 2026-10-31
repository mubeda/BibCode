//! Remote Streamable HTTP's authorization server (#139, slice R): BiBCode as an OAuth 2.1
//! authorization server for its own `/mcp`, and for nothing else.
//!
//! Public clients register dynamically (RFC 7591), ask for authorization with PKCE `S256`
//! and a `resource` (RFC 8707), and wait while a person approves the request in BiBCode or
//! with `bibcode mcp authorize`. An approved request yields a one-minute, single-use code;
//! its exchange mints an `mcp-client` session bound to `<origin>/mcp`, a one-hour access
//! token and a single-use refresh token. A refresh token used twice revokes the grant.
//!
//! Codes, refresh tokens and the consent page's status cookie are kept only as SHA-256
//! hashes, compared in constant time, and never logged.

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use url::Url;

use super::model::{SCOPE_ORCHESTRATION_OPERATE, SCOPE_ORCHESTRATION_READ, SCOPE_TERMINAL_OPERATE};
use crate::persistence::McpOAuthLimits;

/// An access token's lifetime. Both harnesses refresh before it ends.
pub(crate) const ACCESS_TOKEN_TTL_MS: i64 = 60 * 60 * 1_000;
/// A grant lives this long after its last refresh.
pub(crate) const GRANT_TTL_MS: i64 = 30 * 24 * 60 * 60 * 1_000;
/// An authorization code's lifetime; it is also single use.
pub(crate) const CODE_TTL_MS: i64 = 60 * 1_000;
/// How long a person has to approve a request.
pub(crate) const AUTHORIZATION_TTL_MS: i64 = 10 * 60 * 1_000;
/// The scopes an empty scope request means, and the ones the 401 challenge names.
pub(crate) const DEFAULT_SCOPES: [&str; 2] =
    [SCOPE_ORCHESTRATION_READ, SCOPE_ORCHESTRATION_OPERATE];
/// The cookie that binds the consent page's poll to the browser that opened it.
pub(crate) const STATUS_COOKIE: &str = "bibcode_mcp_authorization";
/// How a remote OAuth session's label starts, before the client's name.
pub(crate) const LABEL_PREFIX: &str = "MCP · ";
const CLIENT_NAME_MAX_CHARS: usize = 100;
const REDIRECT_URIS_MAX: usize = 5;
const REDIRECT_URI_MAX_BYTES: usize = 2_048;
const STATE_MAX_BYTES: usize = 1_024;
const USER_CODE_ALPHABET: &[u8] = b"23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const USER_CODE_LENGTH: usize = 8;
const USER_CODE_REJECTION_LIMIT: u8 =
    (u8::MAX as usize / USER_CODE_ALPHABET.len() * USER_CODE_ALPHABET.len()) as u8;

/// The admission limits of the unauthenticated routes (design, "Admission").
pub(crate) const LIMITS: McpOAuthLimits = McpOAuthLimits {
    registrations_per_source_per_hour: 8,
    unapproved_clients: 64,
    pending_per_client: 2,
    pending_per_source: 4,
    pending: 64,
    pending_reserved: 16,
    unapproved_client_ttl_ms: 24 * 60 * 60 * 1_000,
    approved_client_idle_ms: 90 * 24 * 60 * 60 * 1_000,
    finished_authorization_ttl_ms: 60 * 60 * 1_000,
};

/// What the OAuth routes need of the environment's MCP settings, read live.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct McpOAuthSettings {
    /// `enableMcpServer`.
    pub(crate) enabled: bool,
    /// `mcpServerAccess`, the ceiling a person may approve up to.
    pub(crate) access: String,
    /// `mcpCapabilities.terminals`.
    pub(crate) terminals: bool,
}

impl McpOAuthSettings {
    /// Before the MCP service attaches its settings: off.
    pub(crate) fn off() -> Self {
        Self {
            enabled: false,
            access: "read-only".to_owned(),
            terminals: false,
        }
    }
}

/// The scopes a client may ask for now: `terminal:operate` only while terminals are on.
pub(crate) fn scopes_supported(settings: &McpOAuthSettings) -> Vec<&'static str> {
    let mut scopes = DEFAULT_SCOPES.to_vec();
    if settings.terminals {
        scopes.push(SCOPE_TERMINAL_OPERATE);
    }
    scopes
}

/// The protected resource this origin serves.
pub(crate) fn resource_for(origin: &str) -> String {
    format!("{origin}/mcp")
}

/// RFC 9728 Protected Resource Metadata for `<origin>/mcp`.
pub(crate) fn protected_resource_metadata(
    origin: &str,
    settings: &McpOAuthSettings,
    label: &str,
) -> Value {
    json!({
        "resource": resource_for(origin),
        "authorization_servers": [origin],
        "scopes_supported": scopes_supported(settings),
        "bearer_methods_supported": ["header"],
        "resource_name": label,
    })
}

/// RFC 8414 Authorization Server Metadata, with `issuer` the origin itself.
pub(crate) fn authorization_server_metadata(origin: &str, settings: &McpOAuthSettings) -> Value {
    json!({
        "issuer": origin,
        "authorization_endpoint": format!("{origin}/oauth/authorize"),
        "token_endpoint": format!("{origin}/oauth/token"),
        "registration_endpoint": format!("{origin}/oauth/register"),
        "response_types_supported": ["code"],
        "grant_types_supported": ["authorization_code", "refresh_token"],
        "code_challenge_methods_supported": ["S256"],
        "token_endpoint_auth_methods_supported": ["none"],
        "scopes_supported": scopes_supported(settings),
        "authorization_response_iss_parameter_supported": true,
    })
}

/// The `WWW-Authenticate` value `/mcp` sends an unauthenticated request on an eligible
/// origin. It never names `terminal:operate`: an agent asks for that explicitly.
pub(crate) fn challenge(origin: &str) -> String {
    format!(
        "Bearer resource_metadata=\"{origin}/.well-known/oauth-protected-resource/mcp\", scope=\"{}\"",
        DEFAULT_SCOPES.join(" ")
    )
}

/// A validated RFC 7591 registration.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct Registration {
    pub(crate) client_name: String,
    pub(crate) redirect_uris: Vec<String>,
}

/// Why a registration was refused: the RFC 7591 error and a description.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct RegistrationError {
    pub(crate) error: &'static str,
    pub(crate) description: &'static str,
}

const fn registration_error(error: &'static str, description: &'static str) -> RegistrationError {
    RegistrationError { error, description }
}

/// Validates a client's metadata. Public clients only; `grant_types` and `response_types`
/// within what the metadata advertises; `application_type`, `scope` and unknown fields are
/// accepted and ignored (RFC 7591 §2), as Codex sends them.
pub(crate) fn validate_registration(body: &Value) -> Result<Registration, RegistrationError> {
    let Some(body) = body.as_object() else {
        return Err(registration_error(
            "invalid_client_metadata",
            "The registration must be a JSON object.",
        ));
    };
    match body.get("token_endpoint_auth_method") {
        None => {}
        Some(Value::String(method)) if method == "none" => {}
        Some(_) => {
            return Err(registration_error(
                "invalid_client_metadata",
                "Only public clients (token_endpoint_auth_method \"none\") can register.",
            ));
        }
    }
    let within = |field: &str, allowed: &[&str]| match body.get(field) {
        None => true,
        Some(Value::Array(values)) => values
            .iter()
            .all(|value| value.as_str().is_some_and(|value| allowed.contains(&value))),
        Some(_) => false,
    };
    if !within("grant_types", &["authorization_code", "refresh_token"]) {
        return Err(registration_error(
            "invalid_client_metadata",
            "Only the authorization_code and refresh_token grants are supported.",
        ));
    }
    if !within("response_types", &["code"]) {
        return Err(registration_error(
            "invalid_client_metadata",
            "Only the code response type is supported.",
        ));
    }
    let Some(Value::Array(uris)) = body.get("redirect_uris") else {
        return Err(registration_error(
            "invalid_redirect_uri",
            "redirect_uris is required.",
        ));
    };
    if uris.is_empty() || uris.len() > REDIRECT_URIS_MAX {
        return Err(registration_error(
            "invalid_redirect_uri",
            "Register one to five redirect URIs.",
        ));
    }
    let mut redirect_uris = Vec::with_capacity(uris.len());
    for uri in uris {
        let Some(uri) = uri.as_str().filter(|uri| registrable_redirect_uri(uri)) else {
            return Err(registration_error(
                "invalid_redirect_uri",
                "Each redirect URI must be http on localhost, 127.0.0.1 or [::1], or https, with no fragment.",
            ));
        };
        redirect_uris.push(uri.to_owned());
    }
    let client_name = match body.get("client_name") {
        None | Some(Value::Null) => "MCP client".to_owned(),
        Some(Value::String(name)) => {
            let name = name.trim();
            if name.is_empty() {
                "MCP client".to_owned()
            } else if name.chars().count() > CLIENT_NAME_MAX_CHARS
                || name.chars().any(char::is_control)
            {
                return Err(registration_error(
                    "invalid_client_metadata",
                    "client_name must be at most 100 characters of text.",
                ));
            } else {
                name.to_owned()
            }
        }
        Some(_) => {
            return Err(registration_error(
                "invalid_client_metadata",
                "client_name must be a string.",
            ));
        }
    };
    Ok(Registration {
        client_name,
        redirect_uris,
    })
}

/// A redirect URI a client may register: `http` on a loopback name with any port, or
/// `https`, never with a fragment or userinfo.
fn registrable_redirect_uri(uri: &str) -> bool {
    if uri.len() > REDIRECT_URI_MAX_BYTES {
        return false;
    }
    let Ok(url) = Url::parse(uri) else {
        return false;
    };
    if url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.host_str().is_none()
    {
        return false;
    }
    match url.scheme() {
        "https" => true,
        "http" => is_loopback_redirect_host(&url),
        _ => false,
    }
}

fn is_loopback_redirect_host(url: &Url) -> bool {
    matches!(
        url.host_str(),
        Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
    )
}

/// Whether `requested` is the registered redirect URI `registered`: a loopback `http` URI
/// matches on scheme, host, path and query with any port (RFC 8252 §7.3), because native
/// clients pick a port at run time; every other URI matches exactly.
pub(crate) fn redirect_uri_matches(registered: &str, requested: &str) -> bool {
    if registered == requested {
        return true;
    }
    let (Ok(registered), Ok(requested)) = (Url::parse(registered), Url::parse(requested)) else {
        return false;
    };
    registered.scheme() == "http"
        && requested.scheme() == "http"
        && is_loopback_redirect_host(&registered)
        && registered.host_str() == requested.host_str()
        && registered.path() == requested.path()
        && registered.query() == requested.query()
        && requested.fragment().is_none()
        && requested.username().is_empty()
        && requested.password().is_none()
}

/// The redirect URI's host and port, as the approval card and the consent page show it.
pub(crate) fn redirect_host(uri: &str) -> String {
    Url::parse(uri)
        .ok()
        .and_then(|url| {
            let host = url.host_str()?.to_owned();
            Some(match url.port() {
                Some(port) => format!("{host}:{port}"),
                None => host,
            })
        })
        .unwrap_or_default()
}

/// Whether the redirect URI returns to this computer only (the spec's localhost
/// impersonation note): the approval card warns then.
pub(crate) fn redirect_is_loopback(uri: &str) -> bool {
    Url::parse(uri).is_ok_and(|url| url.scheme() == "http" && is_loopback_redirect_host(&url))
}

/// Whether `resource` names `<origin>/mcp`, comparing scheme and host without case.
pub(crate) fn resource_matches(resource: &str, origin: &str) -> bool {
    match (Url::parse(resource), Url::parse(&resource_for(origin))) {
        (Ok(resource), Ok(expected)) => {
            resource.fragment().is_none() && resource.query().is_none() && resource == expected
        }
        _ => false,
    }
}

/// The scopes asked for: within what is supported now, `offline_access` ignored, and an
/// empty request meaning the default pair. Duplicates collapse; order is the supported order.
pub(crate) fn requested_scopes(
    scope: Option<&str>,
    settings: &McpOAuthSettings,
) -> Option<Vec<String>> {
    let supported = scopes_supported(settings);
    let asked = scope
        .unwrap_or_default()
        .split_ascii_whitespace()
        .filter(|scope| *scope != "offline_access")
        .collect::<Vec<_>>();
    if asked.is_empty() {
        return Some(
            DEFAULT_SCOPES
                .iter()
                .map(|scope| (*scope).to_owned())
                .collect(),
        );
    }
    if asked.iter().any(|scope| !supported.contains(scope)) {
        return None;
    }
    Some(
        supported
            .into_iter()
            .filter(|scope| asked.contains(scope))
            .map(str::to_owned)
            .collect(),
    )
}

/// The levels an MCP grant may carry, lowest first.
const ACCESS_LEVELS: [&str; 4] = [
    "read-only",
    "approval-required",
    "auto-accept-edits",
    "full-access",
];

fn access_rank(access: &str) -> Option<usize> {
    ACCESS_LEVELS.iter().position(|level| *level == access)
}

/// Whether `access` is a level and no higher than `ceiling`.
pub(crate) fn access_within(access: &str, ceiling: &str) -> bool {
    matches!((access_rank(access), access_rank(ceiling)), (Some(access), Some(ceiling)) if access <= ceiling)
}

/// Whether a grant at `access` may carry `terminal:operate` now (slice T's conditions):
/// terminals on for MCP agents, and full access both granted and allowed.
pub(crate) fn terminals_allowed(settings: &McpOAuthSettings, access: &str) -> bool {
    settings.terminals && access == "full-access" && settings.access == "full-access"
}

/// The scopes an approval grants: those asked for, with `terminal:operate` only when the
/// person allowed terminals.
pub(crate) fn approved_scopes(requested: &[String], terminals: bool) -> Vec<String> {
    requested
        .iter()
        .filter(|scope| terminals || scope.as_str() != SCOPE_TERMINAL_OPERATE)
        .cloned()
        .collect()
}

/// A PKCE challenge: 43 to 128 characters of base64url (an S256 digest is 43).
pub(crate) fn challenge_is_valid(challenge: &str) -> bool {
    (43..=128).contains(&challenge.len())
        && challenge
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

/// A PKCE verifier (RFC 7636 §4.1): 43 to 128 unreserved characters.
pub(crate) fn verifier_is_valid(verifier: &str) -> bool {
    (43..=128).contains(&verifier.len())
        && verifier
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~'))
}

/// The S256 challenge of a verifier.
pub(crate) fn s256(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

/// Whether `verifier` proves `challenge`, compared in constant time.
pub(crate) fn pkce_verifies(verifier: &str, challenge: &str) -> bool {
    verifier_is_valid(verifier) && constant_time_equal(&s256(verifier), challenge)
}

pub(crate) fn constant_time_equal(left: &str, right: &str) -> bool {
    left.len() == right.len() && bool::from(left.as_bytes().ct_eq(right.as_bytes()))
}

/// The hash a secret is stored and looked up by.
pub(crate) fn secret_hash(secret: &str) -> String {
    let digest = Sha256::digest(secret.as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// A new 256-bit secret, base64url.
pub(crate) fn random_secret() -> Result<String, getrandom::Error> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes)?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

/// A new user code: 8 characters from an alphabet without look-alikes.
pub(crate) fn random_user_code() -> Result<String, getrandom::Error> {
    let mut code = String::with_capacity(USER_CODE_LENGTH);
    while code.len() < USER_CODE_LENGTH {
        let mut bytes = [0_u8; 16];
        getrandom::fill(&mut bytes)?;
        for byte in bytes {
            if byte >= USER_CODE_REJECTION_LIMIT || code.len() == USER_CODE_LENGTH {
                continue;
            }
            code.push(char::from(
                USER_CODE_ALPHABET[usize::from(byte) % USER_CODE_ALPHABET.len()],
            ));
        }
    }
    Ok(code)
}

/// `ABCD2345` as the person reads it: `ABCD-2345`.
pub(crate) fn display_user_code(code: &str) -> String {
    if code.len() == USER_CODE_LENGTH {
        format!("{}-{}", &code[..4], &code[4..])
    } else {
        code.to_owned()
    }
}

/// A typed code back to its stored form: no dash or spaces, upper case.
pub(crate) fn normalize_user_code(input: &str) -> String {
    input
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .map(|character| character.to_ascii_uppercase())
        .collect()
}

/// A `state` value the authorization response can carry back.
pub(crate) fn state_is_valid(state: &str) -> bool {
    state.len() <= STATE_MAX_BYTES && !state.chars().any(char::is_control)
}

/// `redirect_uri` with `params` appended to its query.
pub(crate) fn redirect_with(redirect_uri: &str, params: &[(&str, &str)]) -> Option<String> {
    let mut url = Url::parse(redirect_uri).ok()?;
    {
        let mut query = url.query_pairs_mut();
        for (name, value) in params {
            query.append_pair(name, value);
        }
    }
    Some(url.into())
}

/// The session label of a remote grant: `MCP · <client_name> (remote)`.
pub(crate) fn session_label(client_name: &str) -> String {
    format!("{LABEL_PREFIX}{client_name} (remote)")
}

/// A remote OAuth grant at `origin`, minted as an approved authorization's exchange mints it:
/// its access token and its refresh token.
#[cfg(test)]
pub(crate) async fn test_remote_grant(
    auth: &super::AuthService,
    origin: &str,
    access: &str,
    scopes: &str,
) -> (String, String) {
    use crate::persistence::{McpOAuthClient, McpOAuthDecision, NewMcpOAuthAuthorization};
    let repositories = auth.oauth_repositories().expect("a store");
    let now = super::now_ms();
    let client_id = format!("mcp-{}", random_secret().unwrap());
    repositories
        .register_mcp_oauth_client(
            McpOAuthClient {
                client_id: client_id.clone(),
                client_name: "Claude Code".to_owned(),
                redirect_uris: vec!["http://localhost:1/callback".to_owned()],
                source_key: "loopback".to_owned(),
                created_at_ms: now,
                approved_at_ms: None,
                last_used_at_ms: None,
            },
            now,
            LIMITS,
        )
        .await
        .unwrap();
    let id = random_secret().unwrap();
    let code = random_secret().unwrap();
    let source_key = random_secret().unwrap();
    repositories
        .create_mcp_oauth_authorization(
            NewMcpOAuthAuthorization {
                id: id.clone(),
                user_code: random_user_code().unwrap(),
                client_id,
                redirect_uri: "http://localhost:2/callback".to_owned(),
                code_challenge: s256(&"v".repeat(43)),
                state: None,
                resource: resource_for(origin),
                scopes: scopes.to_owned(),
                origin: origin.to_owned(),
                source_key,
                status_cookie_hash: secret_hash("cookie"),
                created_at_ms: now,
                expires_at_ms: now + AUTHORIZATION_TTL_MS,
            },
            now,
            LIMITS,
        )
        .await
        .unwrap();
    repositories
        .decide_mcp_oauth_authorization(
            id.clone(),
            McpOAuthDecision::Approve {
                access: access.to_owned(),
                scopes: scopes.to_owned(),
            },
            now,
        )
        .await
        .unwrap();
    repositories
        .attach_mcp_oauth_code(id, secret_hash(&code), now + CODE_TTL_MS, now)
        .await
        .unwrap();
    let authorization = repositories
        .get_mcp_oauth_authorization_by_code(secret_hash(&code))
        .await
        .unwrap()
        .unwrap();
    let refresh = random_secret().unwrap();
    match auth
        .mint_mcp_oauth_grant(
            &authorization,
            secret_hash(&code),
            secret_hash(&refresh),
            super::ClientMetadata::default(),
        )
        .await
        .unwrap()
    {
        super::service::McpOAuthMint::Minted(tokens) => (tokens.access_token, refresh),
        _ => panic!("an approved code mints a grant"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings(terminals: bool) -> McpOAuthSettings {
        McpOAuthSettings {
            enabled: true,
            access: "full-access".to_owned(),
            terminals,
        }
    }

    #[test]
    fn metadata_names_the_origin_s256_both_grants_and_iss_support() {
        let origin = "https://env.example.com";
        let resource = protected_resource_metadata(origin, &settings(false), "Office");
        assert_eq!(resource["resource"], "https://env.example.com/mcp");
        assert_eq!(resource["authorization_servers"], json!([origin]));
        assert_eq!(
            resource["scopes_supported"],
            json!(["orchestration:read", "orchestration:operate"])
        );
        assert_eq!(resource["bearer_methods_supported"], json!(["header"]));
        let server = authorization_server_metadata(origin, &settings(true));
        assert_eq!(server["issuer"], origin);
        assert_eq!(server["code_challenge_methods_supported"], json!(["S256"]));
        assert_eq!(
            server["grant_types_supported"],
            json!(["authorization_code", "refresh_token"])
        );
        assert_eq!(
            server["authorization_response_iss_parameter_supported"],
            true
        );
        assert_eq!(
            server["token_endpoint"],
            "https://env.example.com/oauth/token"
        );
        assert!(
            server["scopes_supported"]
                .as_array()
                .unwrap()
                .contains(&json!("terminal:operate"))
        );
    }

    #[test]
    fn registration_takes_codex_s_shape_and_refuses_other_redirects() {
        let codex = json!({
            "client_name": "Codex",
            "redirect_uris": ["http://127.0.0.1:53682/callback"],
            "token_endpoint_auth_method": "none",
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "application_type": "native",
            "scope": "orchestration:read",
            "something_new": true,
        });
        assert_eq!(
            validate_registration(&codex).unwrap(),
            Registration {
                client_name: "Codex".to_owned(),
                redirect_uris: vec!["http://127.0.0.1:53682/callback".to_owned()],
            }
        );
        for uri in [
            "http://192.168.1.10:3000/callback",
            "http://example.com/callback",
            "https://example.com/callback#frag",
            "ftp://localhost/callback",
            "https://user@example.com/callback",
        ] {
            let refused = validate_registration(&json!({ "redirect_uris": [uri] })).unwrap_err();
            assert_eq!(refused.error, "invalid_redirect_uri", "{uri}");
        }
        assert!(
            validate_registration(&json!({
                "redirect_uris": ["https://example.com/cb"],
                "token_endpoint_auth_method": "client_secret_basic",
            }))
            .is_err()
        );
        assert!(
            validate_registration(&json!({
                "redirect_uris": ["https://example.com/cb"],
                "grant_types": ["client_credentials"],
            }))
            .is_err()
        );
        assert!(validate_registration(&json!({ "redirect_uris": [] })).is_err());
        assert!(
            validate_registration(&json!({
                "redirect_uris": ["https://example.com/cb"],
                "client_name": "x".repeat(101),
            }))
            .is_err()
        );
    }

    #[test]
    fn loopback_redirects_match_any_port_and_https_redirects_match_exactly() {
        let loopback = "http://127.0.0.1:53682/callback";
        assert!(redirect_uri_matches(
            loopback,
            "http://127.0.0.1:61000/callback"
        ));
        assert!(redirect_uri_matches(loopback, "http://127.0.0.1/callback"));
        assert!(!redirect_uri_matches(
            loopback,
            "http://localhost:61000/callback"
        ));
        assert!(!redirect_uri_matches(
            loopback,
            "http://127.0.0.1:61000/other"
        ));
        assert!(redirect_uri_matches(
            "http://[::1]:1/cb",
            "http://[::1]:2/cb"
        ));
        let https = "https://app.example.com/cb";
        assert!(redirect_uri_matches(https, https));
        assert!(!redirect_uri_matches(
            https,
            "https://app.example.com:8443/cb"
        ));
        assert!(!redirect_uri_matches(
            https,
            "https://app.example.com/cb?x=1"
        ));
    }

    #[test]
    fn scope_requests_default_ignore_offline_access_and_stay_within_support() {
        let off = settings(false);
        assert_eq!(
            requested_scopes(None, &off).unwrap(),
            ["orchestration:read", "orchestration:operate"]
        );
        assert_eq!(
            requested_scopes(Some("offline_access"), &off).unwrap(),
            ["orchestration:read", "orchestration:operate"]
        );
        assert_eq!(
            requested_scopes(Some("orchestration:read offline_access"), &off).unwrap(),
            ["orchestration:read"]
        );
        assert!(requested_scopes(Some("terminal:operate"), &off).is_none());
        assert!(requested_scopes(Some("access:write"), &off).is_none());
        assert_eq!(
            requested_scopes(
                Some("terminal:operate orchestration:operate orchestration:read"),
                &settings(true)
            )
            .unwrap(),
            [
                "orchestration:read",
                "orchestration:operate",
                "terminal:operate"
            ]
        );
    }

    #[test]
    fn resources_match_their_origin_without_case_and_nothing_else() {
        let origin = "https://env.example.com";
        assert!(resource_matches("https://ENV.example.com/mcp", origin));
        assert!(resource_matches("https://env.example.com:443/mcp", origin));
        assert!(!resource_matches("https://env.example.com/mcp/", origin));
        assert!(!resource_matches("https://other.example.com/mcp", origin));
        assert!(!resource_matches("http://env.example.com/mcp", origin));
        assert!(!resource_matches("https://env.example.com/mcp?x", origin));
    }

    #[test]
    fn pkce_s256_verifies_and_plain_does_not() {
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        let challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
        assert_eq!(s256(verifier), challenge);
        assert!(pkce_verifies(verifier, challenge));
        assert!(!pkce_verifies(verifier, verifier));
        assert!(!pkce_verifies("short", challenge));
        assert!(challenge_is_valid(challenge));
        assert!(!challenge_is_valid("abc"));
    }

    #[test]
    fn user_codes_are_eight_unambiguous_characters() {
        let code = random_user_code().unwrap();
        assert_eq!(code.len(), 8);
        assert!(code.bytes().all(|byte| USER_CODE_ALPHABET.contains(&byte)));
        assert_eq!(display_user_code("ABCD2345"), "ABCD-2345");
        assert_eq!(normalize_user_code(" abcd-2345 "), "ABCD2345");
    }

    #[test]
    fn terminals_need_the_setting_and_full_access_on_both_sides() {
        assert!(terminals_allowed(&settings(true), "full-access"));
        assert!(!terminals_allowed(&settings(true), "auto-accept-edits"));
        assert!(!terminals_allowed(&settings(false), "full-access"));
        let mut lower = settings(true);
        lower.access = "approval-required".to_owned();
        assert!(!terminals_allowed(&lower, "full-access"));
        assert!(access_within("approval-required", "full-access"));
        assert!(!access_within("full-access", "approval-required"));
        assert!(!access_within("root", "full-access"));
        let requested = vec![
            "orchestration:read".to_owned(),
            "terminal:operate".to_owned(),
        ];
        assert_eq!(approved_scopes(&requested, false), ["orchestration:read"]);
    }

    #[test]
    fn the_challenge_names_the_metadata_and_the_default_scopes_only() {
        assert_eq!(
            challenge("https://env.example.com"),
            "Bearer resource_metadata=\"https://env.example.com/.well-known/oauth-protected-resource/mcp\", scope=\"orchestration:read orchestration:operate\""
        );
    }

    #[test]
    fn redirects_keep_their_query_and_append_the_response() {
        assert_eq!(
            redirect_with(
                "http://127.0.0.1:1/cb?a=1",
                &[("code", "x y"), ("state", "s")]
            )
            .unwrap(),
            "http://127.0.0.1:1/cb?a=1&code=x+y&state=s"
        );
    }
}
