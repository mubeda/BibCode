# Server Control, Pairing, Transport, And Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every BiBCode Server a protected host-local administration channel, a working five-minute DPoP pairing CLI, transport admission that forbids non-loopback HTTP, and explicit workstation/headless service lifecycle commands.

**Architecture:** The server process owns a small versioned local-control protocol beside the environment data root. CLI administration talks to that protocol rather than a network RPC. Public HTTP/WebSocket admission is derived from one validated listener policy; loopback may be plaintext, while every non-loopback listener terminates validated TLS. OS service adapters translate typed lifecycle intent into Task Scheduler, launchd, or systemd operations without granting network clients host authority.

**Tech Stack:** Rust 2024, Tokio, Axum 0.8, rustls 0.23, tokio-rustls 0.26, Clap 4, SQLite/rusqlite, Windows named pipes and security descriptors, Unix-domain sockets and peer credentials, Task Scheduler/Windows Service tools, launchd, systemd, Vite+ contract tests.

**Spec:** [Connection, security, and lifecycle specification](./03-connection-security-and-lifecycle.spec.md)

## Global Constraints

- The local-control endpoint is administrative capability, not an alternate application API; it never proxies arbitrary RPC.
- Unix sockets live in a mode-`0700` runtime directory and reject unexpected peer UIDs. Windows pipes carry an explicit service-user/Administrators ACL and reject remote pipe clients.
- Control frames are versioned, size-bounded, deadline-bound, one request per connection, and redact pairing credentials from logs and errors.
- Pairing credentials are random, stored only as a hash, expire after five minutes, are atomically single-use, and bind the resulting session to the submitted DPoP key.
- There are no user-selectable permission levels. Local pairing grants the full non-Connect environment administrator scope set.
- HTTP/WS is permitted only when the bound socket address is loopback. Non-loopback startup without a valid TLS key and certificate is a hard configuration error with no override.
- `unsafe_no_auth` remains test/development-only and cannot be combined with service mode, packaged static assets, or non-loopback admission.
- Workstation service mode is the default. Headless/system mode is a separate explicit elevated operation with a dedicated account.
- Service stop, update, uninstall, and purge use the existing admission drain, data-root lock, process cancellation, and reaping rules.
- Network administrator sessions may inspect application service metadata but cannot install services, create OS accounts, change firewall/bind policy, or delete host data.

---

## File Structure

- Modify: `Cargo.toml`, `Cargo.lock`, `apps/server/Cargo.toml` — direct TLS and platform dependencies.
- Modify: `apps/server/src/config.rs` — typed listener/TLS/control/service CLI configuration.
- Modify: `apps/server/src/lib.rs` — CLI actions and module exports.
- Modify: `apps/server/src/lifecycle.rs` — validated listener and control-server ownership.
- Create: `apps/server/src/transport.rs` — centralized listener admission and TLS loading.
- Create: `apps/server/src/local_control/mod.rs` — control client/server boundary.
- Create: `apps/server/src/local_control/protocol.rs` — bounded versioned messages.
- Create: `apps/server/src/local_control/unix.rs` — Unix socket permissions and peer checks.
- Create: `apps/server/src/local_control/windows.rs` — named-pipe ACL and local-client checks.
- Modify: `apps/server/src/auth/model.rs`, `service.rs`, `http.rs` — administrator pairing and DPoP exchange.
- Modify: `apps/server/src/persistence/migrations.rs`, `repositories.rs` — hashed credentials and exchange receipts.
- Create: `apps/server/src/service/mod.rs`, `model.rs`, `linux.rs`, `macos.rs`, `windows.rs` — service lifecycle adapters.
- Modify: `packages/contracts/src/auth.ts`, `environment.ts`, `server.ts` — public pairing/TLS/service views.
- Test: `apps/server/tests/network_admission.rs`, `local_control.rs`, `service_lifecycle.rs`, `auth_http.rs`, `cli_smoke.rs`.

### Task 1: Centralize listener admission and reject non-loopback HTTP

**Files:**

- Modify: `apps/server/src/config.rs`
- Create: `apps/server/src/transport.rs`
- Modify: `apps/server/src/lifecycle.rs`
- Test: `apps/server/tests/network_admission.rs`

**Interfaces:**

- Produces: `ValidatedListenerConfig { bind, scheme, tls }`.
- Rejects: non-loopback plaintext, unusable TLS material, wildcard plaintext, and unsafe-auth release/service combinations before binding.

- [x] **Step 1: Write the admission matrix as failing table tests**

```rust
#[test]
fn listener_admission_matches_the_security_matrix() {
    assert!(validate(listener("127.0.0.1", None)).is_ok());
    assert!(validate(listener("::1", None)).is_ok());
    assert_matches!(validate(listener("0.0.0.0", None)), Err(NonLoopbackPlaintext { .. }));
    assert_matches!(validate(listener("192.0.2.10", None)), Err(NonLoopbackPlaintext { .. }));
    assert!(validate(listener("0.0.0.0", Some(valid_tls()))).is_ok());
}
```

Add cases for a hostname resolving to mixed loopback/non-loopback addresses, missing key, unreadable certificate, mismatched key, expired/not-yet-valid certificate, unsupported key, and `unsafe_no_auth` in service/package mode.

- [x] **Step 2: Run the focused test and confirm RED**

```sh
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --test network_admission -- --nocapture
```

Expected: FAIL because `ServerConfig` exposes a free-form host and `lifecycle.rs` binds it directly.

- [x] **Step 3: Add typed listener configuration**

```rust
pub struct TlsFiles {
    pub certificate_chain: PathBuf,
    pub private_key: PathBuf,
}

pub enum ListenerSecurity {
    LoopbackPlaintext,
    Tls(Arc<rustls::ServerConfig>),
}

pub struct ValidatedListenerConfig {
    pub bind: SocketAddr,
    pub advertised_scheme: &'static str,
    pub security: ListenerSecurity,
}
```

Resolve the requested bind under a bounded startup deadline. Require every resolved address to satisfy the same policy; do not choose a convenient loopback result from a mixed set.

- [x] **Step 4: Make validation the only bind entry point**

Replace `TcpListener::bind((config.host.as_str(), config.port))` with `transport::bind(validated)`. Desktop in-process, WSL, standalone CLI, service restart, and integration fixtures all call this path.

- [ ] **Step 5: Remove the packaged non-loopback plaintext path**

Delete or replace `DESKTOP_LAN_BIND_HOST`, `network-accessible` plaintext planning, and the WSL wildcard HTTP exception. WSL must use the desktop-owned loopback transport designed in Plan 40.

Progress: the desktop LAN bind, mutation command, UI switch, and plaintext LAN/Tailnet endpoint candidates are removed. The WSL wildcard launch is intentionally left fail-closed until Plan 40 installs the desktop-owned loopback forwarder.

- [x] **Step 6: Run focused tests and commit**

```sh
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --test network_admission -- --nocapture
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server config lifecycle -- --nocapture
git add apps/server/src/config.rs apps/server/src/lifecycle.rs apps/server/src/transport.rs apps/server/tests/network_admission.rs
git commit -m "feat(server): enforce secure listener admission"
```

### Task 2: Terminate TLS and publish verifiable transport metadata

**Files:**

- Modify: `Cargo.toml`, `Cargo.lock`, `apps/server/Cargo.toml`
- Modify: `apps/server/src/transport.rs`
- Modify: `apps/server/src/http.rs`, `apps/server/src/lifecycle.rs`
- Modify: `packages/contracts/src/environment.ts`
- Test: `packages/contracts/src/environment.test.ts`
- Test: `apps/server/tests/network_admission.rs`, `server_runtime.rs`

- [x] **Step 1: Add failing HTTPS descriptor tests**

Start a TLS fixture and assert that HTTPS and WSS work, the descriptor reports a stable SHA-256 SPKI fingerprint and TLS capability, and plaintext against the same non-loopback configuration is never served.

- [x] **Step 2: Add direct dependencies already compatible with the lockfile**

```toml
rustls = "0.23.42"
tokio-rustls = "0.26.4"
rustls-pemfile = "2"
```

Keep default crypto provider selection explicit and fail startup if initialization or certificate parsing fails.

- [x] **Step 3: Implement bounded TLS accept**

```rust
pub enum BoundListener {
    Plain(TcpListener),
    Tls {
        listener: TcpListener,
        acceptor: tokio_rustls::TlsAcceptor,
        identity: TlsIdentity,
    },
}
```

Feed accepted streams into the same Axum service, cap handshake time, cap concurrent handshakes, cancel handshakes at shutdown, and retain peer address for auth/audit without logging certificates or headers.

- [x] **Step 4: Extend the minimal descriptor**

```ts
export const EnvironmentTransportIdentitySchema = Schema.Struct({
  mode: Schema.Literals(["loopback-http", "https"]),
  spkiSha256: Schema.optionalKey(Schema.String),
});
```

Return the fingerprint only for the currently served certificate. Do not accept a descriptor fingerprint as self-authenticating; Plan 20 verifies it against system trust or an enrollment pin.

- [x] **Step 5: Run HTTPS, WS, shutdown, and descriptor tests**

```sh
vp test packages/contracts/src/environment.test.ts
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --test network_admission -- --nocapture
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --test server_runtime -- --nocapture
git add Cargo.toml Cargo.lock apps/server/Cargo.toml apps/server/src/transport.rs apps/server/src/http.rs apps/server/src/lifecycle.rs apps/server/tests/network_admission.rs apps/server/tests/server_runtime.rs packages/contracts/src/environment.ts packages/contracts/src/environment.test.ts
git commit -m "feat(server): serve validated HTTPS environments"
```

### Task 3: Add the protected local-control protocol

**Files:**

- Create: `apps/server/src/local_control/mod.rs`, `protocol.rs`, `unix.rs`, `windows.rs`
- Modify: `apps/server/src/lib.rs`, `apps/server/src/lifecycle.rs`
- Modify: `apps/server/src/persistence/state_files.rs`
- Test: `apps/server/tests/local_control.rs`

**Interfaces:**

- Commands: `Status`, `CreatePairing`, `ServicePrepareUpdate`, `ServiceStop`.
- Not commands: arbitrary RPC, SQL, shell, filesystem, firewall, account creation, or purge.

- [x] **Step 1: Write failing protocol and authorization tests**

Cover an allowed same-user peer, wrong UID/SID, remote Windows pipe client, world-readable Unix parent, oversize frame, partial frame, unsupported protocol, unknown command, timeout, disconnect, concurrent shutdown, stale endpoint, and secret redaction.

- [x] **Step 2: Define the bounded wire protocol**

```rust
pub const CONTROL_PROTOCOL_VERSION: u16 = 1;
pub const MAX_CONTROL_FRAME_BYTES: usize = 64 * 1024;

#[derive(Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ControlRequestBody {
    Status,
    CreatePairing { client_label: Option<String> },
    ServicePrepareUpdate,
    ServiceStop,
}

pub struct ControlRequest {
    pub version: u16,
    pub request_id: Uuid,
    pub body: ControlRequestBody,
}
```

Use a four-byte big-endian length prefix and exactly one request/response per connection. Public errors contain a stable code and safe message only.

- [x] **Step 3: Implement Unix ownership checks**

Create `<state>/run` with `0700`, atomically remove only a verified stale socket owned by the expected UID, bind `control.sock` with `0600`, and verify peer credentials before reading a frame. Accept the service UID; accept root only for explicit headless administration.

- [x] **Step 4: Implement Windows pipe security**

Use `\\.\pipe\bibcode-<environment-uuid>` with a security descriptor granting the service SID and Builtin Administrators, denying network logons, and rejecting a client whose impersonated token is outside that set. Do not rely on the process default DACL.

- [x] **Step 5: Own control shutdown in `ServerHandle`**

Start the control server after persistence/auth are ready, cancel it before releasing the store guard, drain in-flight control requests, and unlink the Unix socket only when this process still owns it.

- [ ] **Step 6: Verify on native Unix and Windows paths and commit**

Progress: native macOS protocol, lifecycle, runtime, maintenance, formatting,
lint, and Clippy checks pass. The Windows module also cross-compiles in an
isolated target harness, but a complete repository cross-check is blocked on
this host by `aws-lc-sys` requiring Windows SDK headers. Keep this step open
until the named-pipe tests run on a native Windows runner. Workspace TypeScript
typecheck remains blocked only by Relay descriptor fixtures scheduled for
removal in Plan 60; the affected Rust target checks pass.

```sh
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --test local_control -- --nocapture
cargo fmt --all --check
git add apps/server/src/lib.rs apps/server/src/lifecycle.rs apps/server/src/local_control apps/server/src/persistence/state_files.rs apps/server/tests/local_control.rs
git commit -m "feat(server): add protected local control channel"
```

### Task 4: Implement `bibcode auth pairing create`

**Files:**

- Modify: `apps/server/src/config.rs`, `apps/server/src/lib.rs`
- Modify: `apps/server/src/local_control/mod.rs`, `protocol.rs`
- Modify: `apps/server/src/auth/model.rs`, `service.rs`
- Test: `apps/server/tests/cli_smoke.rs`, `local_control.rs`

- [x] **Step 1: Add failing CLI parsing/output tests**

```rust
let action = Cli::try_parse_from([
    "bibcode", "auth", "pairing", "create", "--format", "json", "--base-dir", root,
])?.into_action()?;
assert_matches!(action, CliAction::Auth(AuthCommand::CreatePairing { .. }));
```

Test human output, JSON output, server-not-running, wrong data root, inaccessible control endpoint, expired reply, and that stdout/stderr never duplicate the credential.

- [x] **Step 2: Add the exact CLI model**

```text
bibcode auth pairing create [--client-label <label>] [--format human|json] [--base-dir <path>]
```

JSON output contains `environmentId`, `credential`, `expiresAt`, `pairingUrl`, and `controlProtocolVersion`. The URL puts the short-lived credential in the fragment, never the query or server logs.

- [x] **Step 3: Route CLI requests only through local control**

Resolve the same data-root rules as `serve`, read the durable identity marker, find the endpoint, and send `CreatePairing`. Do not fall back to the HTTP pairing endpoint when control is absent.

- [x] **Step 4: Grant the fixed administrator scope set**

```rust
pub const ENVIRONMENT_ADMINISTRATOR_SCOPES: &[&str] = &[
    SCOPE_ORCHESTRATION_READ,
    SCOPE_ORCHESTRATION_OPERATE,
    SCOPE_TERMINAL_OPERATE,
    SCOPE_REVIEW_WRITE,
    SCOPE_ACCESS_READ,
    SCOPE_ACCESS_WRITE,
];
```

Ignore no caller-supplied scope list because none exists. Keep named scopes internally for future protocol evolution without presenting permission levels.

- [x] **Step 5: Run CLI/control tests and commit**

Progress: native macOS runs pass for CLI parsing/process output, protected
control issuance, fixed non-Relay administrator scopes, lifecycle, formatting,
lint, and Clippy. The Windows named-pipe client is implemented, but its native
execution remains part of Task 3's open Windows validation gate.

```sh
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --test cli_smoke -- --nocapture
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --test local_control create_pairing -- --nocapture
git add apps/server/src/config.rs apps/server/src/lib.rs apps/server/src/local_control apps/server/src/auth/model.rs apps/server/src/auth/service.rs apps/server/tests/cli_smoke.rs apps/server/tests/local_control.rs
git commit -m "feat(server): create pairing credentials through local control"
```

### Task 5: Hash pairing credentials and bind idempotent exchange to DPoP

**Files:**

- Modify: `apps/server/src/persistence/migrations.rs`, `repositories.rs`
- Modify: `apps/server/src/auth/model.rs`, `service.rs`, `http.rs`, `dpop.rs`
- Modify: `packages/contracts/src/auth.ts`
- Test: `apps/server/tests/repositories.rs`, `auth_http.rs`

- [x] **Step 1: Write failing persistence and exchange tests**

Assert that raw credentials never occur in SQLite, snapshots, logs, pairing-list responses, or diagnostic errors. Cover five-minute expiry, two-client race, same-key lost-response retry, different-key retry, DPoP method/URL mismatch, replay, revocation, WebSocket ticket invalidation, and access capacity.

- [x] **Step 2: Replace plaintext storage with a hash**

Add `credential_hash BLOB NOT NULL UNIQUE`, `credential_fingerprint TEXT NOT NULL`, and a bounded `auth_pairing_exchange_receipts` table. Migration hashes active legacy credentials in one transaction and drops the plaintext column by table rebuild.

```rust
fn pairing_hash(credential: &SecretString) -> [u8; 32] {
    Sha256::digest(credential.expose_secret().as_bytes()).into()
}
```

Keep the raw value only in the issuance response and zeroize owned buffers where practical.

- [x] **Step 3: Make consumption atomic and sender-constrained**

Inside one immediate transaction: look up the unconsumed hash, verify expiry and intended proof thumbprint, mark consumed, create the client/session, persist an exchange receipt keyed by `(pairing_id, proof_thumbprint)`, and return the session. A retry with the same credential hash and DPoP key during the short receipt window returns the same logical exchange result; any different key fails without creating access.

- [x] **Step 4: Remove credentials from administrative views**

```ts
export const PairingLinkViewSchema = Schema.Struct({
  id: Schema.String,
  credentialFingerprint: Schema.String,
  clientLabel: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  expiresAt: Schema.String,
});
```

The UI lists pairing/client metadata and revocation controls, never a reusable credential.

- [x] **Step 5: Prove DPoP/session lifecycle**

Use fresh `jti` values, exact `htu`/`htm`, timestamp/nonce bounds, bounded replay state, DPoP token type, one-use WebSocket tickets, revocation-driven socket close, and safe audit IDs.

- [x] **Step 6: Run persistence/auth tests and commit**

```sh
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --test repositories auth_pairing -- --nocapture
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --test auth_http -- --nocapture
vp test packages/contracts/src/auth.test.ts
git add apps/server/src/persistence/migrations.rs apps/server/src/persistence/repositories.rs apps/server/src/auth packages/contracts/src/auth.ts packages/contracts/src/auth.test.ts apps/server/tests/repositories.rs apps/server/tests/auth_http.rs
git commit -m "fix(auth): hash pairing credentials and bind exchange to DPoP"
```

Implementation note: migration 48 rebuilds pairing storage without plaintext,
uses secure deletion, skips a plaintext-preserving pre-migration backup, and
repeats WAL truncation on later existing-store starts. Pairing exchange is one
immediate transaction with a bounded same-key receipt, a 64-attempt/minute
admission window, persisted proof binding, and non-consuming capacity failures.
Administrative contracts/events are metadata-only; the UI warns about fixed
full-administrator access and reveals a new code only until its creation dialog
closes. One-use WebSocket tickets and auth revocation now close active sockets.

Direct macOS validation passed the repository exchange test, 16-test auth HTTP
suite, 11-test auth service suite, physical plaintext scrub test, six contract
tests, 40 focused web tests, affected package typechecks, `vp check`, Rust
formatting, and server all-target Clippy with warnings denied. The only
`vp check` warning is the pre-existing unused `otherEnvironmentId` fixture in
the already committed Plan 20 storage test. Plan-wide `vp run typecheck` remains
deferred to Plan 60 because its known failures are confined to Connect fixtures
scheduled for deletion.

### Task 6: Add typed workstation and headless service lifecycle

**Files:**

- Create: `apps/server/src/service/mod.rs`, `model.rs`, `linux.rs`, `macos.rs`, `windows.rs`
- Modify: `apps/server/src/config.rs`, `apps/server/src/lib.rs`
- Modify: `apps/server/src/local_control/protocol.rs`, `mod.rs`
- Test: `apps/server/tests/service_lifecycle.rs`, `cli_smoke.rs`

**Interfaces:**

- CLI: `bibcode service status|install|start|stop|restart|uninstall`.
- Modes: `workstation` (default) and `headless` (explicit).
- Uninstall preserves the verified data root; data purge is not a `service uninstall` flag.

- [x] **Step 1: Write adapter contract tests with a fake command runner**

Assert exact argv/stdin and parsed state for Windows logon task/Windows Service, LaunchAgent/LaunchDaemon, systemd user/system unit, disabled/stopped/missing, insufficient authority, timeout, partial install rollback, running process, and uninstall preservation.

- [x] **Step 2: Define one platform-neutral service model**

```rust
pub enum ServiceMode { Workstation, Headless }
pub enum ServiceState { NotInstalled, Stopped, Starting, Running, Stopping, Failed }

pub struct ServiceStatus {
    pub mode: ServiceMode,
    pub state: ServiceState,
    pub startup_owner: String,
    pub account: String,
    pub binary_path: PathBuf,
    pub data_root: PathBuf,
    pub bind: SocketAddr,
    pub control_endpoint: String,
}
```

Return structured JSON for SSH/desktop use and concise human output for administrators.

- [x] **Step 3: Implement workstation adapters**

- Windows: per-user Task Scheduler logon trigger, interactive token/no stored password, loopback arguments.
- macOS: user LaunchAgent plist in the correct user domain with explicit log/data paths.
- Linux: systemd user unit with hardening compatible with provider/Git/process use; report linger separately and never enable it silently.

- [x] **Step 4: Implement explicit headless adapters**

Require elevation, create/use the dedicated `bibcode` account, install Windows Service/LaunchDaemon/system unit, create only verified data/log/run directories with least privilege, and reject interactive-user credential assumptions. Account creation and removal are separately reported so rollback cannot delete a pre-existing account.

- [x] **Step 5: Make service commands idempotent and drain-aware**

`install` of the matching definition returns current status; mismatch requires explicit update. `stop` asks the local control channel to close admission and drain first, then uses the service manager after a bounded deadline. `uninstall` removes binary registration/service metadata and preserves data.

- [x] **Step 6: Run service tests and commit**

```sh
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --test service_lifecycle -- --nocapture
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --test cli_smoke service -- --nocapture
git add apps/server/src/config.rs apps/server/src/lib.rs apps/server/src/local_control apps/server/src/service apps/server/tests/service_lifecycle.rs apps/server/tests/cli_smoke.rs
git commit -m "feat(server): manage workstation and headless services"
```

Implementation note: service management now uses one validated typed target and
one bounded no-shell command runner across systemd user/system units,
LaunchAgents/LaunchDaemons, Task Scheduler logon tasks, and the Windows SCM.
Definitions are loopback-only, exact-match installs are idempotent, mismatches
require `--update`, failed fresh installs roll back only artifacts and accounts
created by that attempt, and uninstall preserves the resolved data root. Linux
linger is reported but never changed. Windows workstation tasks use an
interactive token with XML passed over stdin; the headless SCM service uses its
virtual service identity without a password. A hidden Windows service-host entry
point implements SCM status and stop handling instead of pretending a console
process is a native service.

Stop, restart, update, and uninstall first ask the protected local-control
channel to close RPC mutation admission and drain admitted work within a bounded
deadline. Failure is explicit in JSON and human output before the requested
service-manager stop is forced. The CLI exposes no data-purge option and reports
the retained root and account handling separately.

Direct macOS validation passed 20 service adapter/lifecycle tests, 14
local-control tests, 17 serial CLI smoke tests, Rust formatting, server
all-target Clippy with warnings denied, and `vp check` (with only the previously
recorded Plan 20 unused-fixture warning). A native Windows check reached the
platform C dependency build but cannot complete on this macOS host because the
Windows SDK/MSVC headers are unavailable; the Windows-native gate remains in
the cross-platform validation plan.

### Task 7: Expose safe service/update state to environment clients

**Files:**

- Modify: `packages/contracts/src/server.ts`, `environment.ts`, `rpc.ts`
- Modify: `apps/server/src/production/control.rs`, `http_routes.rs`, `runtime.rs`
- Modify: `apps/server/src/maintenance.rs`, `lifecycle.rs`
- Test: `packages/contracts/src/server.test.ts`, `rpc.test.ts`
- Test: `apps/server/tests/production_control.rs`, `production_maintenance.rs`

- [ ] **Step 1: Add failing view/authority tests**

Network clients may read service mode/state/version/update state but host mutations return `hostAuthorityRequired` with the allowed channel (`desktop`, `localControl`, or `sshAdmin`). Verify update drain/restart preserves environment/storage IDs and reaps server-owned children.

- [ ] **Step 2: Add a redacted service view**

Expose startup mechanism, state, version, bind posture, account kind, update state, and whether the current route has host-control authority. Avoid raw control socket paths, service credentials, environment variables, and full sensitive filesystem paths unless already authorized by the existing server settings policy.

- [ ] **Step 3: Integrate update admission with service restart**

Prepare rejects new mutations, drains admitted work, persists update status, closes transports, performs the platform restart through the authorized host path, verifies the same environment/storage identity and compatible version, then commits. On failure restore the previous binary and report a bounded recovery state.

- [ ] **Step 4: Run control/maintenance tests and commit**

```sh
vp test packages/contracts/src/server.test.ts packages/contracts/src/rpc.test.ts
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --test production_control -- --nocapture
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --test production_maintenance -- --nocapture
git add packages/contracts/src/server.ts packages/contracts/src/server.test.ts packages/contracts/src/environment.ts packages/contracts/src/rpc.ts packages/contracts/src/rpc.test.ts apps/server/src/production/control.rs apps/server/src/production/http_routes.rs apps/server/src/production/runtime.rs apps/server/src/maintenance.rs apps/server/src/lifecycle.rs apps/server/tests/production_control.rs apps/server/tests/production_maintenance.rs
git commit -m "feat(server): expose safe service and update state"
```

### Task 8: Update server security, service, and testing documentation

**Files:**

- Modify: `apps/server/README.md`
- Modify: `docs/architecture/authentication.md`
- Modify: `docs/architecture/remote.md`
- Modify: `docs/architecture/runtime-process-model.md`
- Modify: `docs/user/remote-access.md`
- Create: `docs/user/server-administration.md`
- Modify: `docs/reference/scripts.md`, `docs/reference/encyclopedia.md`
- Modify: `docs/testing/cross-platform-validation.md`
- Modify: `docs/testing/windows-desktop.md`, `macos-desktop.md`, `linux-desktop.md`
- Modify: `docs/testing/execution-report-template.md`

- [ ] **Step 1: Document the trust and listener matrix**

Include loopback HTTP, SSH forward, direct HTTPS, system trust/pinning, the lack of an insecure override, control-channel authorization, five-minute pairing, DPoP, revocation, and safe troubleshooting.

- [ ] **Step 2: Document workstation/headless lifecycle**

Show exact status/install/start/stop/restart/uninstall commands per OS, authority requirements, service accounts, data preservation, linger/background-session behavior, and recovery from partial update/install.

- [ ] **Step 3: Add native evidence procedures**

Require socket/pipe ACL evidence, wrong-peer rejection, bind inspection, certificate verification, pairing expiry/race/redaction, service single-instance behavior, restart identity, uninstall preservation, and zero leftover processes.

- [ ] **Step 4: Verify and commit**

```sh
git diff --check
rg -n "allow-insecure|0\.0\.0\.0.*http|pairing create|local control|workstation|headless|DPoP" apps/server/README.md docs/architecture docs/user docs/reference docs/testing
cargo fmt --all --check
node scripts/run-msvc-x64.mjs cargo clippy -p bibcode-server --all-targets -- -D warnings
git add apps/server/README.md docs/architecture/authentication.md docs/architecture/remote.md docs/architecture/runtime-process-model.md docs/user/remote-access.md docs/user/server-administration.md docs/reference/scripts.md docs/reference/encyclopedia.md docs/testing
git commit -m "docs: define secure server administration and services"
```
