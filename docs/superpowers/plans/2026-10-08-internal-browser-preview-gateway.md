# Internal Browser Preview Gateway (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A dev server or tool on the BiBCode server's loopback opens correctly in the internal browser from every client topology (local, LAN, tailnet, WSL, desktop-managed SSH, and a new tab in browser mode), and `$BROWSER` / `BRAINSTORM_OPEN_CMD` launches from agents and terminals land in BiBCode.

**Architecture:** The server gains an authenticated reverse proxy with one ephemeral listener per admitted `(thread, port)` target. It is reached by a single-use capability that is exchanged for a port-named cookie. Clients keep preview state canonical (`http://localhost:<port>/…`) and resolve it locally just before navigating: directly for LAN/WSL, or through a desktop-owned `ssh -N -L` forward for SSH. An open-URL shim plus a thread-scoped token lets CLI tools request opens. Clients claim the request, so only one of them handles it.

**Tech Stack:** Rust (axum 0.8, tokio, hyper 1 / hyper-util — already in `Cargo.lock`), Tauri 2.11.5, React 19 + Effect atoms, Effect Schema contracts, Vite+ (`vp`) tests, cargo.

**Spec:** `docs/superpowers/specs/2026-10-07-internal-browser-preview-gateway-design.md`
**Builds on:** Phase 0 (`docs/superpowers/plans/2026-10-07-internal-browser-link-routing.md`, PR #53). This branch, `feat/preview-gateway`, stacks on `feat/internal-browser-link-routing`.

## Global Constraints

- Capability: purpose `"preview-gateway"`, signed with `crate::signed_token::{sign, verify}`, 60 s TTL, single use, bound to `(gatewayPort, upstreamPort, threadId, sessionId)`.
- Gateway cookie: `bibcode-gw-<gatewayPort>=<gateway session id>; HttpOnly; SameSite=Strict; Path=/`.
- Bootstrap path: `/__bibcode/bootstrap?cap=<token>&to=<path+query+fragment>`. It returns a `200` HTML page that calls `location.replace(to)`. `to` must be a path, with no scheme and no host.
- 401 page copy: "This preview link expired. Go back to BiBCode and open it again."
- 502 page copy: "Nothing is listening on port <port> on <environment>."
- HTTPS rejection copy: "HTTPS dev servers can't be previewed through the gateway yet; serve over HTTP or open it on <environment> directly."
- Relay copy (unchanged from Phase 0's shortened copy): "This address is on <label>, not this computer. Opening its ports from here isn't supported yet."
- Limits: 64 concurrent upstream connections per target, 256 global, 64 KiB copy buffers, no body buffering. Over the limit returns `503` with `retry-after: 1`.
- Idle teardown: 10 minutes with no connections. Principal check cache: at most 30 s.
- Origin rule:
  - **Main server:** cookie-authenticated non-`GET`/`HEAD`/`OPTIONS` requests and cookie-authenticated WebSocket upgrades must carry `Origin` equal to the request's own origin (scheme + `Host`) or one of `bibcode://app`, `bibcode-dev://app`, the dev URL origin. Missing or different returns `403`. Header/bearer/DPoP/`wsTicket` auth is unchanged.
  - **Gateway:** the same rule applies, against the gateway's client-facing origin, **before** any rewrite.
- Upstream rewrite:
  - **Request headers:** `Host` → `localhost:<port>`. On WS upgrade, `Origin` → `http://localhost:<port>`.
  - **Request strip:** BiBCode session cookie, all `bibcode-gw-*` cookies, `authorization`, `dpop`, hop-by-hop headers.
  - **Response `Set-Cookie`:** drop `Domain=`, and drop any cookie named like the BiBCode session cookie or `bibcode-gw-*`.
  - **Response `Location`:** rewrite `localhost|127.0.0.1|[::1]:<port>` to the client-facing gateway origin.
- RPCs:
  - `preview.gatewayOpen` takes `{ threadId, url }` and returns `{ gatewayPort, capability, expiresAtMs }`, under scope `orchestration:operate`.
  - `preview.claimOpenRequest` takes `{ requestId }` and returns `{ claimed: boolean }`, under scope `orchestration:operate`.
- Event: `openRequested { threadId, requestId, url, createdAt }`. Open requests expire unclaimed after 60 s.
- Env vars injected into provider and terminal sessions: `BIBCODE_OPEN_URL_TOKEN`, `BIBCODE_OPEN_URL_ENDPOINT`, `BROWSER=bibcode-open-url`, `BRAINSTORM_OPEN_CMD=bibcode-open-url`, and a `PATH` prefix pointing at `<state_dir>/runtime/open-url`.
- Route: `POST /api/preview/open-url`, bearer only. The open-url token never authenticates `/mcp` or any other route.
- Public-IP environments keep the Phase 0 `public-host` notice. Gateway traffic is plain HTTP outside Noise, and it is not exposed to public-IP binds in this phase.
- SSH forwards use a dedicated `ssh -N -L <free local>:127.0.0.1:<remotePort>` child. The codebase has no ControlMaster, so `-O forward` is not used.
- No new crate is downloaded: `hyper`, `hyper-util` and `http-body-util` are already in `Cargo.lock`. Declare them with the lockfile's exact versions (`hyper 1.11.1`, `hyper-util 0.1.20`, `http-body-util 0.1.5`) using the features you need. No new npm packages.
- Tooling:
  - `vp` is not on PATH. Run `PATH=$PWD/node_modules/.bin:$PATH node scripts/run-local-vp.mjs <args>` from the repo root, or `node ../../scripts/run-local-vp.mjs <args>` from a package dir.
  - Use a per-worktree `CARGO_TARGET_DIR=$PWD/target CARGO_BUILD_JOBS=4`.
  - Before **every** commit, run `codex review --uncommitted` and evaluate its findings. Commits end with the session attribution lines.
- Adding an RPC changes the pinned counts in:
  - `packages/contracts/scripts/export-rust-rpc-fixtures.ts:966-983`
  - `packages/contracts/scripts/export-rust-rpc-fixtures.test.ts:101-124`
  - `apps/server/tests/rpc_wire.rs:92-102`

  Regenerate the fixtures with `PATH=$PWD/node_modules/.bin:$PATH node scripts/run-local-vp.mjs run check:contracts`, and read the new counts rather than hand-computing them.

## Review Focus

1. **Two clients, one target.** Example: desktop over SSH plus browser over LAN on the same thread. Each must get its own capability and its own client origin, and shared tab state must stay `http://localhost:<port>/…`. Pinned in Task 8 (`keeps shared state canonical across clients`).
2. **Brainstorm companion.** Its keyed URL (`/?key=<hex>`) redirects to `/` and sets `Path=/` cookies, and its WebSocket requires `Origin === "http://" + Host`. Pinned in Task 3 (`proxies a websocket whose upstream enforces origin equals host`) and Task 2 (`bootstrap keeps query and fragment`).
3. **Cross-port attack from another previewed app.** It has the gateway cookie, because cookies ignore port. Expected: its POST and its WS upgrade are refused with `403` before reaching upstream. Pinned in Task 3 (`refuses cross-origin websocket and post before forwarding`).
4. **Revoked session with a live upstream WebSocket.** Expected: the connection closes within the 30 s check window. Pinned in Task 3 (`closes live connections when the principal is revoked`).
5. **Browser-mode click resolved through the async gateway.** Expected: a tab opens immediately (`about:blank`) and navigates after resolution. If resolution fails, the blank tab closes and the notice shows. Pinned in Task 9 (`opens a blank tab synchronously then navigates`).

---

### Task 1: Origin enforcement for cookie-authenticated requests

**Files:**
- Modify: `apps/server/src/auth/http.rs:604-695` (`authenticate_websocket`, `authorize_http_request`, `authenticate_request_for_method`)
- Modify: `apps/server/src/auth/service.rs` (store the trusted extra origins on `AuthService`; set them where it is constructed from `ServerConfig`)
- Test: `apps/server/tests/auth_http.rs` (new tests); update any existing test that posts with a cookie and no `Origin`

**Interfaces:**
- Produces: `pub(crate) fn cookie_request_origin_allowed(headers: &HeaderMap, trusted: &[String]) -> bool` in `auth/http.rs`. It is reused by the gateway (Task 3) through `pub(crate)`.
- Behavior: when the credential came from the cookie (cookie chosen in `authenticate_request_for_method`), the method is not `GET`/`HEAD`/`OPTIONS` **or** the request is a WebSocket upgrade, and `Origin` is not allowed, the call returns `AuthError::Forbidden`, which maps to `403`. If the error enum has no such variant, add one and map it in the existing auth error response mapper.

- [ ] **Step 1: Write failing tests** in `apps/server/tests/auth_http.rs`, using the file's existing app/session helpers (search it for how a browser session cookie is obtained):

```rust
#[tokio::test]
async fn cookie_authenticated_post_requires_same_origin() {
    // obtain a session cookie as existing tests do, then:
    // 1. POST /api/orchestration/dispatch with Cookie, no Origin      -> 403
    // 2. same with Origin: http://evil.localhost:9999                 -> 403
    // 3. same with Origin equal to "http://" + Host header           -> not 403 (whatever the route returns today)
    // 4. same with Authorization: Bearer <token> and no Origin       -> not 403
}

#[tokio::test]
async fn cookie_authenticated_websocket_upgrade_requires_same_origin() {
    // GET /ws with upgrade headers + Cookie:
    //   Origin http://other:1                          -> 403
    //   Origin "http://" + Host                        -> upgrade proceeds (101 or the existing success path)
    //   ?wsTicket=<ticket> and no Origin               -> proceeds (ticket auth is unchanged)
}

#[tokio::test]
async fn trusted_desktop_origins_pass_cookie_checks() {
    // Origin bibcode://app and bibcode-dev://app pass a cookie POST.
}
```

Write each case as a real request against the router, following the patterns already in this file. Cookie GETs must keep working with no `Origin`.

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p bibcode-server --test auth_http cookie_authenticated`
Expected: FAIL. The posts return non-403.

- [ ] **Step 3: Implement.** In `authenticate_request_for_method`, track whether the chosen token is the cookie (`cookie.is_some()` and it won the `or` chain). If so, and the request is a mutation or a WS upgrade (`headers.get(UPGRADE)` equals `websocket`, case-insensitive), require `cookie_request_origin_allowed`:

```rust
pub(crate) fn cookie_request_origin_allowed(headers: &HeaderMap, trusted: &[String]) -> bool {
    let Some(origin) = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) else { return false };
    if trusted.iter().any(|t| t.eq_ignore_ascii_case(origin)) { return true; }
    let Some(host) = headers.get(header::HOST).and_then(|v| v.to_str().ok()) else { return false };
    let Ok(url) = url::Url::parse(origin) else { return false };
    matches!(url.scheme(), "http" | "https")
        && url.path() == "/"
        && url.host_str().map(|h| { let port = url.port().map(|p| format!(":{p}")).unwrap_or_default(); format!("{h}{port}") })
            .is_some_and(|authority| authority.eq_ignore_ascii_case(host))
}
```

`trusted` comes from `AuthService`: `["bibcode://app", "bibcode-dev://app"]` plus the `dev_url` origin when it is set. Thread it through the `AuthService` constructor from `ServerConfig`; find the construction site with `rg -n "AuthService::new" apps/server/src`. Bracketed IPv6 hosts compare as `[::1]:port` on both sides, so add a test case for them.

- [ ] **Step 4: Run tests.** Run `cargo test -p bibcode-server --test auth_http` and `cargo test -p bibcode-server --test server_runtime`. Fix existing tests that relied on cookie POSTs without `Origin` by adding the correct `Origin` header. Do not weaken the rule. Then run `cargo clippy -p bibcode-server --all-targets -- -D warnings` and `cargo fmt --all --check`.

- [ ] **Step 5: Docs.** In the auth section of `docs/architecture/remote.md`, state the Origin rule for cookie-authenticated mutations and WS upgrades.

- [ ] **Step 6: Codex review, then commit**

```bash
git add apps/server/src/auth apps/server/tests docs/architecture/remote.md
git commit -m "fix(server): require same-origin for cookie-authenticated mutations and websocket upgrades"
```

---

### Task 2: Gateway core (capabilities, sessions, header rewriting)

**Files:**
- Create: `apps/server/src/preview/gateway/mod.rs`, `apps/server/src/preview/gateway/capability.rs`, `apps/server/src/preview/gateway/rewrite.rs`
- Modify: `apps/server/src/preview/mod.rs` (`pub mod gateway;`)

**Interfaces:**
- Produces (`capability.rs`):

```rust
pub const GATEWAY_TOKEN_PURPOSE: &str = "preview-gateway";
pub const CAPABILITY_TTL_MS: u64 = 60_000;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayCapabilityClaims {
    pub gateway_port: u16,
    pub upstream_port: u16,
    pub thread_id: String,
    pub session_id: String,
    pub expires_at: u64,
    pub jti: String,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum CapabilityError { #[error("invalid")] Invalid, #[error("expired")] Expired, #[error("replayed")] Replayed, #[error("wrong target")] WrongTarget }

pub struct CapabilityIssuer { /* secret: Vec<u8>, redeemed: Mutex<HashMap<String, u64>> (jti -> expires_at) */ }
impl CapabilityIssuer {
    pub fn new(secret: Vec<u8>) -> Self;
    pub fn issue(&self, gateway_port: u16, upstream_port: u16, thread_id: &str, session_id: &str, now_ms: u64) -> (String, u64);
    /// Verifies signature, expiry, gateway port, and single use; prunes expired jtis.
    pub fn redeem(&self, token: &str, gateway_port: u16, now_ms: u64) -> Result<GatewayCapabilityClaims, CapabilityError>;
}
```

- Produces (`mod.rs`): `pub struct GatewaySessions` mapping gateway session id → `GatewaySession { gateway_port, upstream_port, thread_id, principal_session_id, principal_expires_at_ms }`. Its methods are `create(&self, claims, principal_expires_at_ms) -> String` (random 32-byte base64url id), `get(&self, id) -> Option<GatewaySession>`, `remove_for_principal(&self, session_id)` and `remove_for_port(&self, gateway_port)`.
- Produces (`rewrite.rs`), all pure functions:

```rust
pub const HOP_BY_HOP: &[&str] = &["connection","keep-alive","proxy-authenticate","proxy-authorization","te","trailer","transfer-encoding","upgrade"];
pub fn gateway_cookie_name(gateway_port: u16) -> String;                       // "bibcode-gw-<port>"
pub fn gateway_session_from_cookie(cookie_header: &str, gateway_port: u16) -> Option<String>;
pub fn strip_request_cookies(cookie_header: &str, session_cookie_name: &str) -> Option<String>;   // None if nothing left
pub fn filter_set_cookie(value: &str, session_cookie_name: &str) -> Option<String>;              // drops Domain=, reserved names
pub fn rewrite_location(location: &str, upstream_port: u16, client_origin: &str) -> String;
pub fn client_origin(scheme: &str, host_header: &str) -> String;                                 // "http://h:p"
pub fn gateway_origin_allowed(origin: Option<&str>, client_origin: &str) -> bool;
pub fn bootstrap_target(to: &str) -> Option<String>;   // Some only for "/..." paths; rejects "//", schemes, backslashes
pub fn bootstrap_page(to: &str) -> String;             // minimal HTML; `to` embedded via JSON string escaping
pub fn status_page(title: &str, body: &str) -> String; // minimal HTML for 401/403/502/503 (escaped text)
```

- [ ] **Step 1: Write failing unit tests** in each module's `#[cfg(test)] mod tests`:

```rust
// capability.rs
#[test] fn issued_capability_redeems_once() {
    let issuer = CapabilityIssuer::new(vec![7; 32]);
    let (token, exp) = issuer.issue(40001, 5173, "t1", "s1", 1_000);
    assert_eq!(exp, 61_000);
    let claims = issuer.redeem(&token, 40001, 2_000).unwrap();
    assert_eq!((claims.upstream_port, claims.thread_id.as_str(), claims.session_id.as_str()), (5173, "t1", "s1"));
    assert_eq!(issuer.redeem(&token, 40001, 2_001), Err(CapabilityError::Replayed));
}
#[test] fn capability_rejects_expired_wrong_port_and_tampered() {
    let issuer = CapabilityIssuer::new(vec![7; 32]);
    let (token, _) = issuer.issue(40001, 5173, "t1", "s1", 1_000);
    assert_eq!(issuer.redeem(&token, 40001, 61_001), Err(CapabilityError::Expired));
    let (token, _) = issuer.issue(40001, 5173, "t1", "s1", 1_000);
    assert_eq!(issuer.redeem(&token, 40002, 2_000), Err(CapabilityError::WrongTarget));
    assert_eq!(issuer.redeem("abc.def", 40001, 2_000), Err(CapabilityError::Invalid));
    let other = CapabilityIssuer::new(vec![8; 32]);
    let (foreign, _) = other.issue(40001, 5173, "t1", "s1", 1_000);
    assert_eq!(issuer.redeem(&foreign, 40001, 2_000), Err(CapabilityError::Invalid));
}

// rewrite.rs
#[test] fn bootstrap_keeps_query_and_fragment() {
    assert_eq!(bootstrap_target("/?key=ab12#x").as_deref(), Some("/?key=ab12#x"));
    for bad in ["https://evil.test/", "//evil.test/", "/\\evil.test", "javascript:alert(1)", ""] {
        assert_eq!(bootstrap_target(bad), None, "{bad}");
    }
    let page = bootstrap_page("/a?b=\"</script>");
    assert!(page.contains("location.replace("));
    assert!(!page.contains("</script>\""));
}
#[test] fn cookies_are_stripped_and_filtered() {
    assert_eq!(strip_request_cookies("bibcode_session=x; app=1; bibcode-gw-40001=y", "bibcode_session").as_deref(), Some("app=1"));
    assert_eq!(strip_request_cookies("bibcode-gw-1=a", "bibcode_session"), None);
    assert_eq!(filter_set_cookie("sid=1; Domain=evil.test; Path=/", "bibcode_session").as_deref(), Some("sid=1; Path=/"));
    assert_eq!(filter_set_cookie("bibcode_session=evil; Path=/", "bibcode_session"), None);
    assert_eq!(filter_set_cookie("bibcode-gw-40001=evil", "bibcode_session"), None);
    assert_eq!(gateway_session_from_cookie("a=1; bibcode-gw-40001=sess; bibcode-gw-40002=o", 40001).as_deref(), Some("sess"));
}
#[test] fn location_rewrites_only_the_upstream_loopback() {
    let origin = "http://127.0.0.1:41000";
    assert_eq!(rewrite_location("http://localhost:5173/a?b", 5173, origin), "http://127.0.0.1:41000/a?b");
    assert_eq!(rewrite_location("http://127.0.0.1:5173/", 5173, origin), "http://127.0.0.1:41000/");
    assert_eq!(rewrite_location("http://[::1]:5173/x", 5173, origin), "http://127.0.0.1:41000/x");
    assert_eq!(rewrite_location("/relative", 5173, origin), "/relative");
    assert_eq!(rewrite_location("http://localhost:9999/", 5173, origin), "http://localhost:9999/");
}
#[test] fn gateway_origin_check_requires_exact_client_origin() {
    assert!(gateway_origin_allowed(Some("http://127.0.0.1:41000"), "http://127.0.0.1:41000"));
    assert!(!gateway_origin_allowed(Some("http://127.0.0.1:41001"), "http://127.0.0.1:41000"));
    assert!(!gateway_origin_allowed(None, "http://127.0.0.1:41000"));
}
```

Add a `GatewaySessions` test: create, get, `remove_for_principal`, `remove_for_port`.

- [ ] **Step 2: Run to verify failure:** `cargo test -p bibcode-server --lib preview::gateway` (FAIL, the modules don't exist yet).
- [ ] **Step 3: Implement** with `crate::signed_token::{sign, verify, now_millis}`. Random ids come from `getrandom` plus `base64` URL-safe-no-pad, as `connect_mcp.rs:358-361` does. The `jti` is 16 random bytes. `bootstrap_page` embeds `serde_json::to_string(to)` with `<` escaped to `<`. Pages set no external resources.
- [ ] **Step 4: Run tests** (PASS), then clippy and fmt.
- [ ] **Step 5: Codex review, then commit:** `feat(server): preview gateway capabilities, sessions, and header rewriting`

---

### Task 3: Gateway listener and proxy

**Files:**
- Create: `apps/server/src/preview/gateway/proxy.rs`
- Modify: `apps/server/Cargo.toml` (declare `hyper = { version = "1.11.1", features = ["client", "http1", "server"] }`, `hyper-util = { version = "0.1.20", features = ["tokio"] }`, `http-body-util = "0.1.5"`. Mirror the workspace-dependency style if other deps use `workspace = true`, which means adding them to the root `Cargo.toml` `[workspace.dependencies]` instead.)
- Modify: `apps/server/src/auth/service.rs` (add `pub(crate) async fn active_session_expiry(&self, session_id: &str) -> Option<i64>`, which returns the expiry when the session exists, is not revoked and is not expired)
- Test: `apps/server/tests/preview_gateway.rs` (new)

**Interfaces:**
- Consumes: Task 2 (`CapabilityIssuer`, `GatewaySessions`, `rewrite::*`), Task 1 (`cookie_request_origin_allowed` is not reused; the gateway uses `gateway_origin_allowed`).
- Produces:

```rust
#[async_trait::async_trait] // or a boxed-future fn if async_trait is not already a dependency
pub trait PrincipalCheck: Send + Sync {
    async fn session_expiry(&self, session_id: &str) -> Option<i64>;
}

pub struct GatewayLimits { pub per_target: usize, pub global: Arc<tokio::sync::Semaphore> }  // 64 / 256

pub struct GatewayTarget { pub thread_id: String, pub upstream: std::net::SocketAddr, pub upstream_port: u16, pub environment_label: String }

pub struct RunningTarget { pub gateway_port: u16, pub shutdown: CancellationToken, pub last_activity_ms: Arc<AtomicU64>, pub active: Arc<AtomicUsize> }

/// Binds `bind_host:0`, serves until `shutdown` is cancelled, and returns once listening.
pub async fn start_target(
    bind_host: &str,
    target: GatewayTarget,
    ctx: GatewayContext,              // Arc<CapabilityIssuer>, Arc<GatewaySessions>, Arc<dyn PrincipalCheck>, GatewayLimits, session_cookie_name: String
    shutdown: CancellationToken,      // child of the server shutdown token
) -> std::io::Result<RunningTarget>;
```

Request handling, per connection served with `hyper-util` auto or http1 and upgrades enabled:
1. `GET /__bibcode/bootstrap?cap&to`:
   - Run `redeem` (failure returns the 401 page). Check that `PrincipalCheck::session_expiry` is `Some`.
   - Call `GatewaySessions::create`, set the cookie, and return `bootstrap_page(to)`.
   - If `bootstrap_target` fails, return a 400 page.
2. Every other request:
   - Look up the gateway session from the cookie. A missing session, a mismatched port, or a principal no longer active (checked at most every 30 s per session) returns 401.
   - Run the Origin check (mutation or WS upgrade without the client origin returns 403).
   - Acquire the per-target and global permits (none free returns 503 with `retry-after: 1`).
   - Forward to `upstream`. Connect failure returns the 502 page with the Global Constraints copy.
3. Responses: apply `filter_set_cookie` to each `set-cookie` and `rewrite_location` to `location`, strip hop-by-hop headers, and stream the body through without buffering.
4. WS (any request with `upgrade: websocket`):
   - Forward the upgrade request with the `Origin` rewrite.
   - On upstream `101`, return `101` to the client.
   - `hyper::upgrade::on` both sides, then `tokio::io::copy_bidirectional` until either side closes, `shutdown` is cancelled, or the principal check fails. The connection holds its permits for its lifetime.
5. Update `last_activity_ms` and `active` on every request and connection.

- [ ] **Step 1: Write failing integration tests** in `apps/server/tests/preview_gateway.rs`.
  - Use in-process fixtures: an upstream axum server on `127.0.0.1:0`; a `PrincipalCheck` fake backed by `Arc<Mutex<Option<i64>>>`; and a `reqwest` or raw hyper client.
  - Required tests, each with real assertions:
    - `bootstrap_sets_port_named_cookie_and_redirects_via_page`: the 200 page contains `location.replace("/?key=ab")` and `set-cookie` starts with `bibcode-gw-<port>=` and contains `HttpOnly`, `SameSite=Strict` and `Path=/`.
    - `request_without_cookie_is_401_with_copy`
    - `replayed_capability_is_401`
    - `forwards_get_with_host_rewrite_and_stripped_credentials`: upstream echoes headers. Assert `host: localhost:<upstreamPort>`, and that the cookie lacks the BiBCode session and `bibcode-gw-*` while keeping app cookies. No `authorization` and no `dpop`.
    - `refuses_cross_origin_websocket_and_post_before_forwarding`: upstream counts hits. POST with `Origin: http://127.0.0.1:1` returns 403, the WS upgrade with a foreign Origin returns 403, and the upstream hit count stays 0.
    - `proxies_a_websocket_whose_upstream_enforces_origin_equals_host`: the upstream WS rejects unless `origin == "http://" + host`. Send a text frame through and assert the echo.
    - `rewrites_set_cookie_domain_and_location`
    - `unreachable_upstream_is_502_with_copy`
    - `limits_return_503`: per-target permits set to 1, and a held slow request makes a second request get 503.
    - `closes_live_connections_when_the_principal_is_revoked`: open a proxied WS, set the fake to `None`, advance the check (expose the check interval as a parameter defaulting to 30 s; tests use 100 ms), and assert the client sees close within 2 s.
    - `shutdown_cancels_listener`
- [ ] **Step 2: Run to verify failure:** `cargo test -p bibcode-server --test preview_gateway` (FAIL).
- [ ] **Step 3: Implement** `proxy.rs` per the interface. Keep it under about 600 lines; if it grows, split WS handling into `proxy_ws.rs`. Implement `PrincipalCheck` for `AuthService` via `active_session_expiry`.
- [ ] **Step 4: Run tests** (PASS), then clippy and fmt.
- [ ] **Step 5: Codex review, then commit:** `feat(server): preview gateway listener and authenticated reverse proxy`

---

### Task 4: Open-URL server surface (credential, route, open requests, claim RPC)

**Files:**
- Modify: `apps/server/src/production/connect_mcp.rs` (add a separate `open_url: HashMap<hash, OpenUrlRecord { thread_id, environment_id, expires_at }>` in `McpState`, with `issue_open_url_credential(thread_id) -> (token, expires_at)` and `verify_open_url_credential(token) -> Option<String /*thread_id*/>`; lifetime 8 h like MCP. **Do not** touch the MCP credential map or its `retain`.)
- Modify: `apps/server/src/preview/mod.rs` (add the `OpenRequested { thread_id, request_id, url, created_at }` event variant; add `PreviewManager::request_open(thread_id, url) -> Result<String /*request_id*/, PreviewError>` and `claim_open_request(request_id) -> bool`. Requests expire after 60 s and are pruned on access. Make `tab_id()` return `Option<&str>` and update callers.)
- Modify: `apps/server/src/production/http_routes.rs` and `apps/server/src/http.rs` (`ROUTE_INVENTORY`) to add `POST /api/preview/open-url` as a sibling handler in the `websocket_ticket` style. It checks `Authorization: Bearer` against `verify_open_url_credential` **only** (cookies are rejected), validates the body `{ url }` as http(s) via `PreviewManager` URL normalization, and calls `request_open`. Responses: `202 {requestId}`; `401` for a bad token; `400` for a bad URL.
- Modify: `packages/contracts/src/preview.ts` (`PreviewOpenRequestedEvent` in the `PreviewEvent` union, plus `PreviewClaimOpenRequestInput` and `PreviewClaimOpenRequestResult`), `packages/contracts/src/rpc.ts` (`WS_METHODS.previewClaimOpenRequest = "preview.claimOpenRequest"` and its `Rpc.make`, added to the group), `apps/server/src/rpc/methods.rs` (`mutation_unary("preview.claimOpenRequest")`), `apps/server/src/auth/scope.rs` (operate group), and `apps/server/src/production/workspace_preview.rs` (`PREVIEW_METHODS` plus a dispatch arm)
- Modify: the RPC count pins and regenerated fixtures (see Global Constraints)
- Modify: `apps/web/src/previewStateStore.ts` (`case "openRequested": return current;`, so the exhaustive switch compiles)
- Test: `apps/server/tests/preview_open_url.rs` (new), `apps/server/tests/preview_domain.rs`, `packages/contracts/src/preview.test.ts` (or the closest existing preview contract test)

**Interfaces:**
- Produces:
  - **Event:** `{ type: "openRequested", threadId, requestId, url, createdAt }`. Its key casing must match the existing variants on the wire. Check `packages/contracts/fixtures/rpc-wire/stream-shapes/subscribePreviewEvents-00.json`, which uses camelCase, and mirror whatever mechanism the existing variants use.
  - **RPC:** `preview.claimOpenRequest`, `{ requestId: string }` → `{ claimed: boolean }`.
  - **Rust:** `ConnectMcpService::issue_open_url_credential(&self, thread_id: &str) -> Result<OpenUrlCredential { token, expires_at }, ConnectMcpError>`.

- [ ] **Step 1: Failing tests.**
  - `preview_domain.rs`: `request_open_emits_event_and_first_claim_wins` (two claims, the second returns false), `open_requests_expire_after_sixty_seconds` (inject a clock or expose `claim_open_request_at(now)`).
  - `preview_open_url.rs`: the route's 202, 401 and 400 cases, and `open_url_token_does_not_authorize_mcp` (POST `/mcp` with the open-url token returns the existing invalid-credential response).
  - `mcp_credential_survives_open_url_issue`: issuing an open-url token for a thread keeps that thread's MCP token valid.
  - The contracts decode test for the new event.
- [ ] **Step 2: Run to verify failure:** `cargo test -p bibcode-server --test preview_domain --test preview_open_url` and the contracts test file (FAIL).
- [ ] **Step 3: Implement** the items listed under Files.
- [ ] **Step 4: Regenerate fixtures and update the pinned counts.** Run the contracts check and `cargo test -p bibcode-server --test rpc_wire` (PASS).
- [ ] **Step 5: Codex review, then commit:** `feat(server): open-url credential, route, and claimable open requests`

---

### Task 5: Gateway admission, registry, and `preview.gatewayOpen`

**Files:**
- Create: `apps/server/src/preview/gateway/registry.rs`
- Modify: `apps/server/src/production/runtime.rs` (construct `PreviewGateway` with the auth service, the server bind host from `ServerConfig.host`, the asset-style secret, and the shutdown token; pass it to `WorkspacePreviewRpcServices`)
- Modify: `apps/server/src/production/orchestration_effects.rs` (`cleanup_deleted_thread` also calls a new `close_previews(thread_id)` callback with a no-op default; the runtime impl calls `PreviewManager::close(thread, None)` and `PreviewGateway::close_thread`)
- Modify: contracts plus server RPC wiring for `preview.gatewayOpen`, as in Task 4, registered with `register_unary_with_context` so the handler gets the caller's session id and expiry (add a principal accessor on `RpcSessionContext` if needed). Bump the pinned counts again and regenerate the fixtures.
- Test: `apps/server/tests/preview_gateway_admission.rs` (new)

**Interfaces:**
- Consumes: Task 3 `start_target`, `RunningTarget`.
- Produces:

```rust
pub struct GatewayOpenResult { pub gateway_port: u16, pub capability: String, pub expires_at_ms: u64 }
#[derive(Debug, thiserror::Error)]
pub enum GatewayError {
    #[error("not admitted")] NotAdmitted,
    #[error("https unsupported")] HttpsUnsupported,
    #[error("no upstream")] NoUpstream,
    #[error("unavailable: {0}")] Unavailable(String),
}
impl PreviewGateway {
    pub async fn open(&self, thread_id: &str, url: &str, session_id: &str, session_expires_at_ms: i64) -> Result<GatewayOpenResult, GatewayError>;
    pub async fn close_thread(&self, thread_id: &str);
    pub async fn close_target(&self, thread_id: &str, upstream_port: u16);
    pub async fn shutdown(&self);
}
```

- **Contracts:**
  - `PreviewGatewayOpenInput { threadId, url: Url }` and `PreviewGatewayOpenResult { gatewayPort, capability, expiresAtMs }`.
  - Errors: tagged `PreviewGatewayError { reason: "not-admitted" | "https-unsupported" | "no-upstream" | "unavailable", message }`, added to the RPC's error union.
- **Admission rules:** every `gatewayOpen` call is itself an explicit user or agent action by an `orchestration:operate` caller, such as a click, a URL-bar submit, an agent `preview_open`, or a claimed `open-url` request. So admission is:
  - The URL must be on a loopback host (`localhost`, `127.0.0.0/8`, `::1`).
  - `https` returns `HttpsUnsupported`, which the client turns into the HTTPS copy. Other schemes return `NotAdmitted`.
  - Upstream address: try `127.0.0.1:port`, then `[::1]:port`, with a 500 ms connect probe each. The first that accepts wins. If neither does, return `NoUpstream`.
- **Registry:**
  - Keyed `(thread_id, upstream_port)` under one `tokio::sync::Mutex`, and idempotent: a second call reuses the running target and mints a fresh capability.
  - An idle sweeper runs every 60 s. It closes targets with `active == 0` and `now - last_activity_ms >= 10 min`.
  - Subscribe to `PreviewManager` events. On `Closed`, once no tab of that thread still has a URL on that port (`PreviewManager::list(thread)`), call `close_target`. On `Lagged`, re-check every running target.
  - Server shutdown cancels all targets.

- [ ] **Step 1: Failing tests:**
  - `rejects_non_loopback_and_non_http_targets`
  - `rejects_https_targets`
  - `no_upstream_when_nothing_listens`
  - `reaches_an_ipv6_only_upstream`, with an upstream bound to `[::1]:0` (skip with a printed note if IPv6 loopback is unavailable)
  - `second_open_reuses_listener_with_fresh_capability`
  - `closing_last_tab_closes_target`
  - `thread_delete_closes_previews_and_targets`
  - `gateway_open_requires_operate_scope`, using the RPC scope table assertion
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cargo test -p bibcode-server` (the full crate, since this touches runtime wiring), plus clippy and fmt, the contracts check and `rpc_wire`.
- [ ] **Step 5: Docs.** In `docs/architecture/remote.md` add a "Preview gateway" section covering per-target listeners, admission, the auth bootstrap, the Origin rule, limits, idle teardown, the E2EE plaintext caveat and the relay limitation. In `docs/architecture/overview.md`, add the gateway to the runtime topology.
- [ ] **Step 6: Codex review, then commit:** `feat(server): admit preview gateway targets per thread and expose preview.gatewayOpen`

---

### Task 6: Desktop `sshForward` bridge command

**Files:**
- Modify: `apps/desktop/src-tauri/src/ssh.rs`:
  - Add `forwards: HashMap<u16 /*remote*/, SshPortForward { child: ManagedSshChild, local_port: u16 }>` to `ManagedSshTunnel`.
  - Add `pub async fn ensure_port_forward<R: Runtime>(&self, app, prompts, target: SshEnvironmentTarget, remote_port: u16) -> Result<u16, String>`.
  - Add `pub async fn release_port_forward(&self, target, remote_port)`.
- Modify: `apps/desktop/src-tauri/src/bridge.rs` (`desktop_bridge_ssh_forward(app, ssh, prompts, target, remote_port) -> Result<u16, String>` and `desktop_bridge_release_ssh_forward(ssh, target, remote_port)`)
- Modify: all four registration lists (`lib.rs` test macro, `lib.rs` `generate_handler!`, `permissions/desktop-bridge.toml`, the `bridge.rs` mock app list) and the "missing command arguments" loop
- Modify: `packages/contracts/src/ipc.ts` (`DesktopBridge.sshForward(target: DesktopSshEnvironmentTarget, remotePort: number) => Promise<number>` and `releaseSshForward(target, remotePort) => Promise<void>`) and `apps/web/src/tauriDesktopBridge.ts`, plus its test's invoke switch

**Interfaces:**
- **Behavior:**
  - The command requires a live tunnel for the target: `take_existing_bootstrap_if_running`, or return the error "SSH connection is not active.".
  - It takes `target_lock`. It is idempotent per `(target key, remote_port)`: a live child returns the same local port, and a dead child is reaped and replaced.
  - It reuses `base_ssh_args_with_auth` and spawns `ssh <base> -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -n -N -L <local>:127.0.0.1:<remote> <host>` through `spawn_managed_ssh_child` (so admission and reaper rules apply). Pick the local port with `portpicker::pick_unused_port()`.
  - **Readiness:** poll until a TCP connect to `127.0.0.1:<local>` succeeds and the child has not exited, every 50 ms for up to 10 s. On timeout, `terminate_and_reap` and return an error.
  - **Lifecycle:** forwards die with the tunnel (`drop_cached_tunnel`, `disconnect_environment`, `shutdown` reap them via the `ManagedSshTunnel` drop). `release_port_forward` terminates and reaps one forward.
  - **Cap:** at most 8 forwards per tunnel, as a backstop against leaks. A ninth request evicts the least recently requested forward (terminate and reap) before spawning. This keeps the shared `SSH_CHILD_REAPER_CAPACITY` (32) available to other SSH work.

- [ ] **Step 1: Failing tests:**
  - Rust unit tests in `ssh.rs`, using the file's existing fake-ssh-program test harness (find it with `rg -n "fake_ssh|ssh_program" apps/desktop/src-tauri/src/ssh.rs`): `port_forward_requires_live_tunnel`, `port_forward_is_idempotent_per_remote_port`, `port_forward_args_forward_to_loopback_remote_port`, `forwards_are_reaped_with_the_tunnel`, `release_reaps_one_forward`, `ninth_forward_evicts_least_recent`.
  - The `lib.rs` list tests must include the new commands.
  - A web bridge test for invoke names and args.
- [ ] **Step 2: Run to verify failure:** `cargo test -p bibcode-desktop --lib ssh::` (FAIL).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cargo test -p bibcode-desktop`, clippy and fmt, plus the web `tauriDesktopBridge.test.ts`.
- [ ] **Step 5: Codex review, then commit:** `feat(desktop): forward preview gateway ports over the managed SSH connection`

---

### Task 7: Open-URL shim, env injection, and `open-url` CLI

**Files:**
- Modify: `apps/server/src/persistence/state_files.rs` (`StatePaths.open_url_shim_dir = state_dir.join("runtime/open-url")`, created in `ensure_directories_without_database_side_effects`)
- Create: `apps/server/src/open_url.rs`, containing:
  - `write_shims(dir: &Path, exe: &Path) -> io::Result<()>`, which writes `bibcode-open-url` (POSIX sh, mode 0755) and `bibcode-open-url.cmd` atomically and skips the write if the content is unchanged;
  - `session_env(endpoint: &str, token: &str, shim_dir: &Path, base_path: Option<&OsStr>) -> BTreeMap<String,String>`;
  - `pub async fn run_open_url(url: &str) -> i32`, the CLI body.
- Modify: `apps/server/src/lifecycle.rs` (call `write_shims` during `start_internal` with `std::env::current_exe()`; log on failure, never abort startup)
- Modify: `apps/server/src/production/provider_runtime.rs:966-996` (in `launch`, after the MCP block: issue the open-url credential and merge `session_env` into `request.environment`; prefix `PATH` from `request.environment["PATH"]` or else `std::env::var_os("PATH")`)
- Modify: `apps/server/src/terminal/manager.rs`. Add `TerminalManagerOptions.session_env: Option<Arc<dyn Fn(&str /*thread_id*/) -> BTreeMap<String, String> + Send + Sync>>`. Apply it inside `start_inner` (`manager.rs:1894`, the shared start path for `terminal.open`, attach-restart, setup scripts and internal terminals), merged after the caller's env so server values win. The runtime (`production/runtime.rs`, where `TerminalManagerOptions` is built) supplies a closure that issues or reuses the thread's open-url credential and returns `session_env`.
- Modify: `apps/server/src/config.rs` and `apps/server/src/lib.rs` (`CliCommand::OpenUrl { url: String }` → `CliAction::OpenUrl` → `run_open_url`; short-circuits before any data-root resolution)
- Modify: `apps/desktop/src-tauri/src/main.rs` (before `bibcode_desktop_lib::run()`, if `args[1] == "open-url"`, run `bibcode_server::open_url::run_open_url(&args[2])` on a current-thread tokio runtime and `std::process::exit(code)`; no Tauri, no window)
- Test: `apps/server/src/open_url.rs` unit tests, `apps/server/tests/preview_open_url.rs` (extend), and a CLI parse test in `config.rs`

**Interfaces:**
- POSIX shim content (exact):

```sh
#!/bin/sh
# BiBCode open-url shim: hands one URL to the BiBCode client showing this thread.
exec "<EXE>" open-url "$1"
```

  `<EXE>` is replaced with the absolute exe path, single-quote escaped for sh.

- Windows `.cmd`:

```bat
@echo off
"<EXE>" open-url %1
```

- `run_open_url(url)`:
  - It reads `BIBCODE_OPEN_URL_ENDPOINT` and `BIBCODE_OPEN_URL_TOKEN`.
  - A URL that isn't http(s) prints `bibcode open-url: expected an http(s) URL` to stderr and exits 2.
  - A missing env var prints the URL to stdout and exits 0.
  - Otherwise it POSTs `{url}` with the bearer token (5 s timeout). A `202` exits 0 silently. Any other failure prints the URL to stdout, writes the error to stderr, and exits 0.
- `session_env` returns `BIBCODE_OPEN_URL_TOKEN`, `BIBCODE_OPEN_URL_ENDPOINT` (the server's own HTTP base URL + `/api/preview/open-url`, built from the configured bind), `BROWSER=bibcode-open-url`, `BRAINSTORM_OPEN_CMD=bibcode-open-url`, and `PATH=<shim_dir><sep><base PATH>`.

- [ ] **Step 1: Failing tests:**
  - `shim_passes_metacharacters_as_one_argument`: write the shim pointing at a test script that prints `$#` and `$1`, run it with `'http://h/?a=$(x)&b=`y`;c'`, and assert one argument, echoed byte for byte. POSIX only, behind `#[cfg(unix)]`.
  - `session_env_prefixes_path_and_sets_browser`
  - `cli_parses_open_url_without_data_root`
  - `run_open_url_rejects_non_http`
  - Route-level end to end: start the test server, issue a credential, run `run_open_url` against it with the env set, and assert an `openRequested` event.
  - `provider_launch_env_contains_open_url_vars`, using the existing provider launch test harness in `provider_runtime.rs` tests (`rg -n "fn .*launch.*environment" apps/server/src/production/provider_runtime.rs`).
  - `terminal_env_contains_open_url_vars`: cover both a `terminal.open`-started terminal and a restarted one, through the manager's fake PTY harness
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cargo test -p bibcode-server`, `cargo test -p bibcode-desktop --lib`, and clippy and fmt for both.
- [ ] **Step 5: Codex review, then commit:** `feat: open-url shim and BROWSER hook for agents and terminals`

---

### Task 8: Client gateway resolution and canonical preview state

**Files:**
- Create: `apps/web/src/browser/previewGateway.ts` and `previewGateway.test.ts`
- Modify: `apps/web/src/browser/browserTargetResolver.ts`:
  - Add the `{ kind: "gateway"; url: string /*canonical*/; via: "host"; host: string } | { kind: "gateway"; url: string; via: "ssh" }` resolution for loopback URLs. Covered topologies: `BearerConnectionTarget`, or `PrimaryConnectionTarget` with a non-loopback private/tailnet/name host (`via:"host"`), and `SshConnectionTarget` (`via:"ssh"`).
  - Relay, disconnected and public-host stay `unreachable`.
  - Same-host stays `reachable`.
- Modify: `packages/client-runtime/src/state/preview.ts` (add a `gatewayOpen` command, mirroring `open` with `tag: WS_METHODS.previewGatewayOpen`)
- Modify: `apps/web/src/browser/DesktopPreviewTabHosts.tsx` (initial navigation: `await resolveForNavigation(...)`, then navigate the native view)
- Modify: `apps/web/src/components/preview/PreviewView.tsx`:
  - `handleSubmitUrl`: the server `navigate` gets the canonical URL and the native view gets the resolved URL.
  - `handleRefresh`: gateway-backed tabs re-resolve and navigate; local tabs keep `previewBridge.refresh`.
- Modify: `apps/web/src/components/preview/usePreviewBridge.ts` (map the reported URL back with `canonicalizePreviewUrl` before `reportStatus` and `applyPreviewDesktopState`)
- Modify: `apps/web/src/components/preview/PreviewAutomationHosts.tsx` (the `open`/`navigate` handlers store canonical URLs; native navigation uses `resolveForNavigation`)
- Modify: `apps/web/src/components/preview/PreviewNewWindowRouter.tsx` and `apps/web/src/browser/openLink.ts` (the app branch passes the **canonical** URL to `openUrlInPreview` for the `gateway` kind; the native host resolves it)

**Interfaces:**
- Produces (`previewGateway.ts`):

```ts
export type GatewayOpenMutation = (input: {
  environmentId: EnvironmentId;
  input: { threadId: ThreadId; url: string };
}) => Promise<AtomCommandResult<{ gatewayPort: number; capability: string; expiresAtMs: number }, unknown>>;

/** Resolve a canonical preview URL to the URL this client's webview should load. */
export function resolveForNavigation(input: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  canonicalUrl: string;
  gatewayOpen: GatewayOpenMutation;
}): Promise<{ kind: "ok"; url: string } | { kind: "unreachable"; message: string }>;

/** Map a client-side gateway URL back to its canonical http://localhost:<port> form; other URLs pass through. */
export function canonicalizePreviewUrl(url: string): string;

/** Test seam. */
export function resetPreviewGatewayForTests(): void;
```

- Behavior of `resolveForNavigation`:
  - `resolvePreviewTarget` returns `reachable` → `{ok, url}`; `unreachable` → `{unreachable, message: UNREACHABLE_MESSAGES[...]}`.
  - `gateway` → call `gatewayOpen`. A typed `PreviewGatewayError` maps to a message: https uses the HTTPS copy, not-admitted uses "Open this address from the thread's terminal or chat first, then try again.", and the rest use the relay-style copy. For `via:"ssh"`, also call `window.desktopBridge.sshForward(target, gatewayPort)`, where `target` is the profile's `DesktopSshEnvironmentTarget`. Find how `connection/platform.ts` passes the target to `ensureSshEnvironment` and reuse that lookup.
  - The client origin is `http://<host>:<gatewayPort>` for `via:"host"`, or `http://127.0.0.1:<localPort>` for `via:"ssh"`.
  - Record `clientOrigin → canonical origin (http://localhost:<port>)` in a module map.
  - Return `<clientOrigin>/__bibcode/bootstrap?cap=<encoded>&to=<encoded path+search+hash>`.
- `canonicalizePreviewUrl` replaces a known client origin with the canonical origin. When the path is `/__bibcode/bootstrap`, it returns the canonical origin plus the decoded `to`.
- SSH forward bookkeeping: the module keeps `canonical origin → { gatewayPort, localPort, tabs: Set<tabId> }` per environment.
  - `resolveForNavigation` takes an optional `tabId` and adds it.
  - `releasePreviewTab(environmentId, tabId)` removes the tab. When a set becomes empty, or a re-resolution returns a different `gatewayPort` for the same canonical origin, it calls `window.desktopBridge.releaseSshForward(target, oldGatewayPort)`.
  - Call `releasePreviewTab` from the tab-close path (`apps/web/src/browser/desktopTabLifetime.ts` release, and where preview tabs are closed in `previewStateStore` / `PreviewView`).

- [ ] **Step 1: Failing tests** in `previewGateway.test.ts`. Mock `readPreparedConnection` and `window.desktopBridge`:
  - `resolves LAN loopback through the gateway with a bootstrap url`: asserts `http://192.168.1.5:41000/__bibcode/bootstrap?cap=CAP&to=%2Fapp%3Fkey%3D1%23h`.
  - `resolves SSH loopback through gateway plus local forward`
  - `maps https rejection to the HTTPS copy`
  - `keeps same-host loopback direct without calling gatewayOpen`
  - `canonicalizes gateway and bootstrap urls back to localhost`
  - `keeps shared state canonical across clients`: two different client origins for the same canonical origin both map back to `http://localhost:5173/...`.
  - `releases the ssh forward when the last tab closes and on gateway port change`: repeat close/reopen cycles and assert `releaseSshForward` balances `sshForward`.

  Update `browserTargetResolver.test.ts` for the new `gateway` kind. LAN/WSL cases that previously expected a direct host rewrite now expect `gateway`. Add a component test asserting that `PreviewView` sends the canonical URL to `navigate` and that Reload on a gateway tab calls `resolveForNavigation` instead of `previewBridge.refresh`.
- [ ] **Step 2: Run to verify failure:** `cd apps/web && node ../../scripts/run-local-vp.mjs test run --project unit src/browser src/components/preview` (FAIL).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same tests (PASS), plus `tsc --noEmit` in `apps/web` and `packages/client-runtime`.
- [ ] **Step 5: Codex review, then commit:** `feat(web): resolve server-loopback previews through the gateway and keep shared state canonical`

---

### Task 9: Browser mode, open-request claiming, and the "wants to open" prompt

**Files:**
- Create: `apps/web/src/components/preview/OpenRequestRouter.tsx` and its test. It is always mounted in `AppRoot` next to `PreviewNewWindowRouter`.
- Create: `apps/web/src/browser/browserTab.ts` and its test: `openPendingTab(): PendingTab | null` and `PendingTab.navigate(url)` / `.close()`.
- Create: `apps/web/src/components/preview/OpenPromptBanner.tsx` and its test: a non-modal banner with **Open** and **Dismiss**, styled like `ServerReloadPrompt`.
- Modify: `apps/web/src/browser/openLink.ts`, for a `gateway` resolution with the system destination:
  - **Browser mode** (no `window.desktopBridge`): call `openPendingTab()` synchronously, then `resolveForNavigation`, then `navigate`, or `close` plus the notice. If `openPendingTab()` returned `null`, show the prompt.
  - **Desktop:** `await resolveForNavigation`, then `readLocalApi().shell.openExternal(url)`. This goes through `DesktopBridge.openExternal`, the privileged boundary. The desktop main window denies `window.open`, so the pending-tab trick is browser-mode only.
- Modify: `apps/web/src/components/preview/PreviewAutomationHosts.tsx`. Register a browser-mode host when `previewBridge` is null. It supports only `status` and `open`: `open` enqueues the prompt and returns `{ status: "pending-user" }`, and `status` returns the no-automation status.
- Modify: `apps/web/src/AppRoot.tsx` (mount the router and the banner; the browser-mode automation host mount)
- Modify: `packages/contracts/src/previewAutomation.ts` (add the `pending-user` result shape to the open result union, if the contract types it)

**Interfaces:**
- `openPendingTab()`:
  - Calls `window.open("about:blank", "_blank")`, so the handle is kept. If it isn't null, it sets `w.opener = null` and returns `{ navigate(url) { w.location.replace(url) }, close() { w.close() } }`. Otherwise it returns `null`.
- `OpenRequestRouter`:
  - It subscribes to preview events per environment through the existing preview event subscription used by `usePreviewSession`.
  - On `openRequested` for a thread currently shown in the UI (`useRightPanelStore` / the active thread), it calls `preview.claimOpenRequest`.
  - On `{claimed:true}`, it routes through `openLink({ url, threadRef, invert: false, openPreview })`. Browser mode always shows the prompt, because there is no user gesture.
- Prompt copy: "<Agent | A command> wants to open <url>". It uses "A command" for `openRequested` and "Agent" for automation `open`.

- [ ] **Step 1: Failing tests:**
  - `opens a blank tab synchronously then navigates`: spy on `window.open`. Assert it is called before `await`, and that after resolution `location.replace` is called with the bootstrap URL.
  - `closes the blank tab and notifies on unreachable`
  - `falls back to the prompt when the popup is blocked`
  - `desktop system destination resolves then calls openExternal without window.open`
  - `claims open requests and only the winner opens`: two routers; the mock claim returns true then false; exactly one open.
  - `ignores open requests for threads not on screen`
  - `browser-mode automation open returns pending-user and shows the prompt`
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.** Review the prompt and notices against `UI.md`: the target URL is visible, Dismiss is explicit, and a dismissed banner doesn't reappear.
- [ ] **Step 4: Run** the focused tests and `tsc --noEmit`.
- [ ] **Step 5: Codex review, then commit:** `feat(web): browser-mode gateway tabs, open-request claiming, and the open prompt`

---

### Task 10: Docs, runbooks, Linux geometry check, and completion gates

**Files:**
- Modify: `docs/user/workspace-ui.md` (remote previews over SSH, LAN and WSL; browser-mode new tab and prompt; the `$BROWSER`/`BRAINSTORM_OPEN_CMD` behavior; the HTTPS and relay limitations; previewed apps get a new origin, so hard-coded `localhost` OAuth/CORS breaks)
- Modify: `docs/testing/ssh-environments.md` and `docs/testing/cross-platform-validation.md`. Add these procedures:
  - SSH preview of a dev server.
  - The brainstorm companion end to end: `start-server.sh --open` in a thread terminal over SSH. The companion loads in the internal browser and live reload works.
  - Browser-mode cross-site bootstrap. The BiBCode UI is on one site and the gateway on another; after `location.replace`, the cookie is kept.
  - Revocation closing a live preview.
  - The 403 cross-port check.
- Modify: `docs/testing/linux-desktop.md` (under "GTK backend and fractional scaling", add a "Preview child webview geometry" check: open the browser panel, resize and move the split, and confirm the preview follows on both Wayland and X11)

- [ ] **Step 1: Linux geometry runtime check (controller).** Run the desktop dev build on this Linux host (`PATH=$PWD/node_modules/.bin:$PATH node scripts/run-local-vp.mjs run dev:desktop`) only if the user approves opening a window on their session. Otherwise record it as pending manual validation. If the check shows the preview does not follow bounds, open a follow-up task that implements the `gtk::Fixed` mount per the spec, §5.
- [ ] **Step 2: Docs** as listed.
- [ ] **Step 3: Gates (repo root):**

```bash
PATH=$PWD/node_modules/.bin:$PATH node scripts/run-local-vp.mjs check
PATH=$PWD/node_modules/.bin:$PATH node scripts/run-local-vp.mjs run typecheck
cargo fmt --all --check
cargo clippy -p bibcode-server -p bibcode-desktop --all-targets -- -D warnings
(cd apps/web && node ../../scripts/run-local-vp.mjs test run --project unit)
(cd packages/contracts && node ../../scripts/run-local-vp.mjs test run)
cargo test -p bibcode-server
cargo test -p bibcode-desktop
```

- [ ] **Step 4: Reviews.** Run a `UI.md` review of the 401/403/502/503 pages, the prompt and the notices. Run `vercel-react-best-practices` on the changed components. Run a security review of the gateway diff (`/security-review` or a dedicated reviewer).
- [ ] **Step 5: Codex review, then commit:** `docs: preview gateway behavior and validation`
