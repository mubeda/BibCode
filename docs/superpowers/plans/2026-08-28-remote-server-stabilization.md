# Remote Server Stabilization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the reviewed remote-server exposure, pairing, transport, lifecycle, ownership, and repository-gate defects, then validate the complete boundary with separate Docker server and client containers.

**Architecture:** The Rust auth service remains the source of truth for live remote grants; the desktop host serializes fail-closed native exposure transactions; the renderer directly compensates a failed share ceremony and performs one post-narrow convergence read. E2EE keeps Noise NK and the existing wire format while bounding WebSocket input and processing plaintext record-by-record.

**Tech Stack:** Rust 1.97.1, Axum/Tokio/Tauri 2, Snow Noise NK, TypeScript 7, React 19, Effect 4, Vite+, pnpm 11, Docker.

**Spec:** `docs/superpowers/specs/2026-08-28-remote-server-stabilization-design.md`

## Global Constraints

- Keep `packages/contracts` schema-only; runtime URL and identity policy belongs in `packages/shared` or `packages/client-runtime`.
- Privileged settings, backend, and firewall mutations cross `DesktopBridge`; the renderer never performs native side effects directly.
- Do not add a production Node runtime, Electron host, helper sidecar, or relay redesign.
- Keep Noise `Noise_NK_25519_ChaChaPoly_SHA256`, 65,535-byte ciphertext records, 64 KiB pre-auth logical messages, 64 MiB authenticated logical messages, 32 pre-auth permits, and the combined 10-second handshake deadline.
- Widening persists `network-accessible` only after backend verification and firewall success; narrowing never restores a durable wide value as rollback.
- Pairing token consumption remains fail-closed before encrypted reply delivery; documentation and UX must describe the burned-code case honestly.
- Every production behavior change starts with a focused failing test, is observed red, receives the smallest passing implementation, and is committed before the next task.
- Preserve the existing bounded two-at-a-time update pool, per-row Check action, rail null-selection behavior, and per-entry update wiring.

## Execution Evidence Disclosures

- Commit `81eff018` also dropped the writable relay executable handle before
  `exec` to prevent Linux `ETXTBSY`. The production fix was discovered while
  running the E2EE interop path and is beneficial, but it was outside that
  commit's documentation-only description. It did not redesign the relay.

---

### Task 1: Restore the five range-introduced repository gates

**Files:**

- Modify: `docs/dependency-upgrades/2026-07-17-ledger.json`
- Modify: `scripts/toolchain-contract.test.ts:40-45`
- Modify: `scripts/tauri-hardening.test.ts:379-383`
- Modify: `packages/contracts/scripts/export-rust-auth-fixtures.test.ts:118-143`
- Modify: `apps/server/tests/server_runtime.rs:1090-1115`

**Interfaces:**

- Consumes: current dependency inventory, Tauri capability JSON, generated auth fixture manifest, and `ROUTE_INVENTORY`.
- Produces: a green repository baseline that explicitly accounts for the dependencies, permission, fixture route, and HTTP route introduced by the remote-server range.

- [x] **Step 1: Re-run the existing red gate tests and preserve their evidence**

Run:

```bash
vp test scripts/toolchain-contract.test.ts scripts/tauri-hardening.test.ts scripts/check-dependency-upgrade-ledger.test.ts packages/contracts/scripts/export-rust-auth-fixtures.test.ts
cargo test -p bibcode-server --test server_runtime route_inventory_covers_every_current_http_method_and_path -- --exact --nocapture
```

Expected: the TypeScript command reports four failures (missing Noble acknowledgement, missing deep-link permission, four missing ledger entries, and missing `shareState` fixture route); the Rust command reports missing `GET /api/auth/share-state`.

- [x] **Step 2: Synchronize the dependency ledger with the discovered inventory**

Set the summary to:

```json
{
  "javascriptDirect": 81,
  "javascriptLedger": 80,
  "rustRegistry": 81,
  "rustPath": 1,
  "actions": 9,
  "toolchains": 9
}
```

Insert these sorted dependency records next to their cohorts:

```json
{
  "key": "js:catalog:@noble/ciphers",
  "name": "@noble/ciphers",
  "current": "2.4.0",
  "target": "2.4.0",
  "channel": "stable",
  "source": "https://www.npmjs.com/package/@noble/ciphers",
  "cohort": "noble-cryptography",
  "platforms": ["linux", "macos", "windows"],
  "status": "green"
}
```

```json
{
  "key": "rust:workspace:snow",
  "name": "snow",
  "current": "0.10",
  "target": "0.10",
  "channel": "stable",
  "source": "https://crates.io/crates/snow",
  "cohort": "rust-current",
  "platforms": ["linux", "macos", "windows"],
  "status": "current"
}
```

```json
{
  "key": "rust:workspace:tauri-plugin-deep-link",
  "name": "tauri-plugin-deep-link",
  "current": "2",
  "target": "2",
  "channel": "stable",
  "source": "https://crates.io/crates/tauri-plugin-deep-link",
  "cohort": "rust-current",
  "platforms": ["linux", "macos", "windows"],
  "status": "current"
}
```

```json
{
  "key": "rust:workspace:tauri-plugin-single-instance",
  "name": "tauri-plugin-single-instance",
  "current": "2",
  "target": "2",
  "channel": "stable",
  "source": "https://crates.io/crates/tauri-plugin-single-instance",
  "cohort": "rust-current",
  "platforms": ["linux", "macos", "windows"],
  "status": "current"
}
```

- [x] **Step 3: Make each contract test acknowledge the current checked-in behavior**

Append `"@noble/ciphers@2.4.0"` to the exact `minimumReleaseAgeExclude` expectation, append `"deep-link:default"` to the exact Tauri permission expectation, insert `"shareState"` after `"pairingOffer"` in the auth route-name expectation, change fixture count `23` to `24`, change schema fingerprint count `26` to `27`, and insert:

```rust
("GET", "/api/auth/share-state"),
```

after `pairing-offer` in `expected_routes()`.

- [x] **Step 4: Re-run all five gates and verify green**

Run the two commands from Step 1.

Expected: 30 TypeScript tests pass and the exact Rust route-inventory test passes.

- [x] **Step 5: Commit the synchronized gates**

```bash
git add docs/dependency-upgrades/2026-07-17-ledger.json scripts/toolchain-contract.test.ts scripts/tauri-hardening.test.ts packages/contracts/scripts/export-rust-auth-fixtures.test.ts apps/server/tests/server_runtime.rs
git commit -m "test(remote): synchronize implementation gates"
```

### Task 2: Make server share state and offer idempotency authoritative

**Files:**

- Modify: `apps/server/src/auth/service.rs:40-100, 770-857, 1710-1845, 2330-2410`
- Modify: `apps/server/src/auth/http.rs:280-435`
- Modify: `apps/server/tests/auth_http.rs:420-610`

**Interfaces:**

- Consumes: `SessionRecord { subject, revoked_at_ms, expires_at_ms, off_host }`, authenticated principal `session_id`, and `MAX_ACTIVE_PAIRINGS`.
- Produces: `share_exposure_state()` that counts every active off-host one-time-token session; principal-scoped bounded `replay_pairing_offer(principal_id, key, fingerprint)` and `record_pairing_offer(principal_id, key, fingerprint, result)`.

- [x] **Step 1: Add the browser-pair-path regression test**

Add an HTTP test named `browser_pairing_session_preserves_off_host_exposure_until_revoked` that:

```rust
let offer = create_pairing_offer(&client, &handle, administrator_token, "another-device").await;
let link = find_pairing_link(&client, &handle, administrator_token, &offer["id"]).await;
let browser = client
    .post(http_url(&handle, "/api/auth/browser-session"))
    .json(&json!({ "credential": link["credential"] }))
    .send()
    .await
    .expect("browser session request");
assert_eq!(browser.status(), StatusCode::OK);
assert_eq!(share_state(&client, &handle, administrator_token).await["desiredExposure"], "wide");
let browser_session_id = find_client_session_by_method(
    &client,
    &handle,
    administrator_token,
    "browser-session-cookie",
)
.await;
revoke_client_session(&client, &handle, administrator_token, &browser_session_id).await;
assert_eq!(share_state(&client, &handle, administrator_token).await["desiredExposure"], "loopback");
```

Use small test helpers in `auth_http.rs` only when they remove repeated real HTTP requests; do not call `AuthService` directly from this test.

- [x] **Step 2: Run the browser regression and observe the incorrect loopback result**

```bash
cargo test -p bibcode-server --test auth_http browser_pairing_session_preserves_off_host_exposure_until_revoked -- --exact --nocapture
```

Expected: FAIL because consuming the link removes it and `browser-session-cookie` is excluded.

- [x] **Step 3: Remove the access-method filter from live session grants**

Reduce the session predicate to the actual grant lifecycle:

```rust
let session_grants = state.sessions.values().filter(|session| {
    session.subject == "one-time-token"
        && session.revoked_at_ms.is_none()
        && session.expires_at_ms > now
}).map(|session| session.off_host);
```

Run the Step 2 command and the existing unit test:

```bash
cargo test -p bibcode-server auth::service::tests::share_exposure_derives_wide_only_from_off_host_flags --lib -- --exact --nocapture
```

Expected: both pass.

- [x] **Step 4: Add failing principal-isolation and capacity tests for offer idempotency**

Add tests proving:

```rust
assert!(matches!(
    auth.replay_pairing_offer("principal-b", "same-key", &fingerprint).await,
    PairingOfferReplay::Fresh
));
```

after principal A records the key, and proving the `(MAX_ACTIVE_PAIRINGS + 1)`th live idempotency record returns `AuthError::Internal("pairing offer idempotency capacity exceeded")` after expired entries are pruned.

Run:

```bash
cargo test -p bibcode-server auth::service::tests::pairing_offer_idempotency --lib -- --nocapture
```

Expected: FAIL because keys are global and the map has no cap.

- [x] **Step 5: Key idempotency by principal and enforce the cap**

Change storage and signatures to:

```rust
pairing_offer_idempotency: HashMap<(String, String), StoredPairingOffer>,

pub(crate) async fn replay_pairing_offer(
    &self,
    principal_id: &str,
    key: &str,
    input_fingerprint: &str,
) -> PairingOfferReplay

pub(crate) async fn record_pairing_offer(
    &self,
    principal_id: String,
    key: String,
    input_fingerprint: String,
    result: PairingOfferResult,
) -> Result<(), AuthError>
```

Prune expired records before every replay/record, reject a fresh insert at `MAX_ACTIVE_PAIRINGS`, and pass `principal.session_id` from `create_pairing_offer`. Preserve replay and conflict behavior within one principal.

- [x] **Step 6: Run focused auth coverage and commit**

```bash
cargo test -p bibcode-server auth::service::tests --lib
cargo test -p bibcode-server --test auth_http
```

Expected: both targets pass.

```bash
git add apps/server/src/auth/service.rs apps/server/src/auth/http.rs apps/server/tests/auth_http.rs
git commit -m "fix(remote): preserve live browser grants"
```

### Task 3: Move shared URL, endpoint, and local-connection policy to its owners

**Files:**

- Modify: `packages/shared/src/pairingCode.ts`
- Modify: `packages/shared/src/pairingCode.test.ts`
- Modify: `packages/shared/src/advertisedEndpoint.ts`
- Modify: `packages/shared/src/advertisedEndpoint.test.ts`
- Modify: `packages/client-runtime/src/connection/presentation.ts`
- Modify: `packages/client-runtime/src/connection/presentation.test.ts`
- Modify: `packages/client-runtime/src/connection/pairingAdd.ts`
- Modify: `packages/client-runtime/src/connection/pairingAdd.test.ts`
- Modify: `apps/web/src/connection/desktopLocal.ts`
- Modify: `apps/web/src/components/settings/remote-servers/connectPresentation.ts`
- Modify: `apps/web/src/components/settings/remote-servers/connectPresentation.test.ts`
- Modify: `apps/web/src/components/settings/remote-servers/shareOffer.ts`
- Modify: `apps/web/src/components/settings/remote-servers/shareOffer.test.ts`
- Modify: `apps/web/src/desktopDeepLink.ts`
- Modify: `apps/web/src/desktopDeepLink.test.ts`
- Modify: `packages/contracts/src/remoteUpdate.ts`
- Modify: `packages/contracts/src/remoteUpdate.test.ts`

**Interfaces:**

- Consumes: existing `buildPairingDeepLink`, `buildBrowserPairUrl`, `parsePairingCode`, and connection target shapes.
- Produces: `resolvePairingDeepLinkCode(rawUrl): string | null`, `DESKTOP_LOCAL_CONNECTION_ID_PREFIX`, `isDesktopLocalConnectionId(connectionId)`, exact parsed-IP endpoint classification, and `RemoteUpdateSnapshot.error: string | null`.

- [x] **Step 1: Add failing endpoint and contract edge tests**

Add these table entries to the shared endpoint test:

```typescript
["http://example.test/path/:0", "public"],
["http://127.example.test:3773", "public"],
["http://fdcorp.example.test:3773", "public"],
["http://[fe80::1]:3773", "private-network"],
```

Add a contracts test:

```typescript
it("preserves an empty desktop updater error string", () => {
  expect(decodeSnapshot({
    serverVersion: "0.4.2",
    latestVersion: null,
    state: "error",
    error: "",
    support: { installMode: "interactive", reason: "available" },
  }).error).toBe("");
});
```

Extend the existing post-bootstrap identity-mismatch pairing test to assert:

```typescript
expect(error.detail).toContain(
  "This pairing attempt may still appear in the server's client list; revoke it there before retrying.",
);
```

Run:

```bash
vp test packages/shared/src/advertisedEndpoint.test.ts packages/contracts/src/remoteUpdate.test.ts
```

Expected: path `:0`, DNS prefix, and empty error cases fail.

- [x] **Step 2: Parse port and IP families exactly and loosen only the update error field**

Replace the raw endpoint regex with `url.port === "0"`; parse IPv4 only when all four decimal octets are integers in `0..=255`; treat `127.0.0.0/8` as loopback; and treat IPv6 as private only when the first hexadecimal segment is `fc00::/7` or `fe80::/10`. DNS names containing those prefixes remain public.

Change only:

```typescript
error: Schema.NullOr(Schema.String),
```

Run the Step 1 tests and expect them to pass.

- [x] **Step 3: Add failing shared-owner tests for pairing links and desktop-local IDs**

Export and test:

```typescript
export const DESKTOP_LOCAL_CONNECTION_ID_PREFIX = "local:";

export function isDesktopLocalConnectionId(connectionId: string | undefined): boolean {
  return connectionId?.startsWith(DESKTOP_LOCAL_CONNECTION_ID_PREFIX) ?? false;
}
```

Add `resolvePairingDeepLinkCode` cases for `bibcode://pair`, `bibcode:/pair`, wrong schemes, wrong targets, and missing codes. Update the web tests to import these wished-for APIs before implementing them.

Run:

```bash
vp test packages/shared/src/pairingCode.test.ts packages/client-runtime/src/connection/presentation.test.ts apps/web/src/desktopDeepLink.test.ts apps/web/src/components/settings/remote-servers/connectPresentation.test.ts
```

Expected: FAIL because the exports do not exist and web still owns literals/parsing.

- [x] **Step 4: Replace duplicated consumers with the owning exports**

Implement `resolvePairingDeepLinkCode` in `pairingCode.ts` and reuse it from the parser and `desktopDeepLink.ts`. Import pairing URL builders in `shareOffer.ts` from `@bibcode/shared/pairingCode` and delete its local copies. Export the local ID constant/predicate from client-runtime presentation; use them from `desktopLocal.ts`, `connectPresentation.ts`, and connection security presentation. When `verifyAndAddPairingCode` has already received a minted credential and then rejects an environment/storage identity mismatch, append the exact client-list revocation guidance from Step 1; pre-auth failures keep their existing copy.

- [x] **Step 5: Run all affected TypeScript tests and commit**

```bash
vp test packages/shared/src/pairingCode.test.ts packages/shared/src/advertisedEndpoint.test.ts packages/client-runtime/src/connection/presentation.test.ts packages/client-runtime/src/connection/pairingAdd.test.ts packages/contracts/src/remoteUpdate.test.ts apps/web/src/desktopDeepLink.test.ts apps/web/src/components/settings/remote-servers/connectPresentation.test.ts apps/web/src/components/settings/remote-servers/shareOffer.test.ts
```

Expected: all pass.

```bash
git add packages/shared/src/pairingCode.ts packages/shared/src/pairingCode.test.ts packages/shared/src/advertisedEndpoint.ts packages/shared/src/advertisedEndpoint.test.ts packages/client-runtime/src/connection/presentation.ts packages/client-runtime/src/connection/presentation.test.ts packages/client-runtime/src/connection/pairingAdd.ts packages/client-runtime/src/connection/pairingAdd.test.ts packages/contracts/src/remoteUpdate.ts packages/contracts/src/remoteUpdate.test.ts apps/web/src/connection/desktopLocal.ts apps/web/src/components/settings/remote-servers/connectPresentation.ts apps/web/src/components/settings/remote-servers/connectPresentation.test.ts apps/web/src/components/settings/remote-servers/shareOffer.ts apps/web/src/components/settings/remote-servers/shareOffer.test.ts apps/web/src/desktopDeepLink.ts apps/web/src/desktopDeepLink.test.ts
git commit -m "refactor(remote): centralize connection policy"
```

### Task 4: Compensate failed share ceremonies and close the narrowing race

**Files:**

- Modify: `apps/web/src/state/shareExposureReconciler.ts`
- Modify: `apps/web/src/state/shareExposureReconciler.test.tsx`
- Modify: `apps/web/src/components/settings/remote-servers/shareOffer.ts`
- Modify: `apps/web/src/components/settings/remote-servers/shareOffer.test.ts`
- Modify: `apps/web/src/components/settings/remote-servers/ShareThisHostTab.tsx`
- Modify: `apps/web/src/components/settings/remote-servers/ShareThisHostTab.test.tsx`

**Interfaces:**

- Consumes: `getServerShareState`, `DesktopBridge.getServerExposureState`, and `DesktopBridge.applyServerExposure`.
- Produces: `reconcileShareExposureOnce(operations): Promise<"unchanged" | "narrowed" | "rewidened">`; mint-failure cleanup status `"not-needed" | "restored" | "failed"`.

- [x] **Step 1: Add failing mint-failure compensation tests**

Extend `generateShareOffer` tests with:

```typescript
const cleanupExposureAfterFailedMint = vi.fn(async () => "restored" as const);
// arrange a loopback start, successful widen, and five failed mint attempts
expect(cleanupExposureAfterFailedMint).toHaveBeenCalledOnce();
expect(result).toMatchObject({
  ok: false,
  failure: { kind: "mint-failed", widened: true, cleanup: "restored" },
});
```

Add a second case where cleanup rejects and assert `cleanup: "failed"` plus the cleanup error in the returned message. Add a no-widen case asserting cleanup is not called.

Run:

```bash
vp test apps/web/src/components/settings/remote-servers/shareOffer.test.ts
```

Expected: FAIL because mint failure returns without cleanup.

- [x] **Step 2: Add failing convergence and post-narrow race tests**

Extract a testable operation and cover these ordered observations:

```typescript
getShareState
  .mockResolvedValueOnce({ desiredExposure: "loopback", offHostGrantCount: 0, legacyGrantCount: 0 })
  .mockResolvedValueOnce({ desiredExposure: "wide", offHostGrantCount: 1, legacyGrantCount: 0 });
getExposureState.mockResolvedValue({ mode: "network-accessible" });

await expect(reconcileShareExposureOnce(operations)).resolves.toBe("rewidened");
expect(applyExposure.mock.calls).toEqual([["local-only"], ["network-accessible"]]);
```

Retain cases for startup narrowing, legacy-grant blocking, and absent bridge.

Run:

```bash
vp test apps/web/src/state/shareExposureReconciler.test.tsx
```

Expected: FAIL because no reusable operation or post-apply read exists.

- [x] **Step 3: Implement one bounded convergence pass**

Implement the exact operation shape:

```typescript
export interface ShareExposureOperations {
  readonly getShareState: () => Promise<AuthShareStateResult>;
  readonly getExposureState: () => Promise<DesktopServerExposureState>;
  readonly applyExposure: (
    desired: DesktopServerExposureMode,
  ) => Promise<DesktopServerExposureState>;
}

export async function reconcileShareExposureOnce(
  operations: ShareExposureOperations,
): Promise<"unchanged" | "narrowed" | "rewidened">;
```

Fetch share/exposure together, narrow only when `shouldRevertExposure` is true, fetch share state once more, and re-widen only when that post-narrow result is `wide`. Refresh desktop network state after each native apply. Do not loop inside this function.

- [x] **Step 4: Invoke convergence directly after a widened mint failure**

Add this dependency to `GenerateShareOfferDependencies`:

```typescript
readonly cleanupExposureAfterFailedMint: null | (() => Promise<
  "unchanged" | "narrowed" | "rewidened"
>);
```

After the fifth mint failure, await it when `widened === true`; map `narrowed` to `cleanup: "restored"`, the other successful results to `cleanup: "not-needed"`, and rejection to `cleanup: "failed"`. `ShareThisHostTab` supplies the real `reconcileShareExposureOnce` operation.

- [x] **Step 5: Make the UI copy report completed reality**

Render these outcomes:

```typescript
cleanup === "restored"
  ? "The offer was not created. Remote access was restored to local-only."
  : cleanup === "failed"
    ? "The offer was not created, and remote-access cleanup also failed. Review Exposure and retry cleanup."
    : failure.message
```

Delete “will switch off again automatically.” Add component assertions for restored and cleanup-failed text.

- [x] **Step 6: Run focused renderer coverage and commit**

```bash
vp test apps/web/src/state/shareExposureReconciler.test.tsx apps/web/src/components/settings/remote-servers/shareOffer.test.ts apps/web/src/components/settings/remote-servers/ShareThisHostTab.test.tsx
```

Expected: all pass.

```bash
git add apps/web/src/state/shareExposureReconciler.ts apps/web/src/state/shareExposureReconciler.test.tsx apps/web/src/components/settings/remote-servers/shareOffer.ts apps/web/src/components/settings/remote-servers/shareOffer.test.ts apps/web/src/components/settings/remote-servers/ShareThisHostTab.tsx apps/web/src/components/settings/remote-servers/ShareThisHostTab.test.tsx
git commit -m "fix(remote): compensate failed share ceremonies"
```

### Task 5: Make desktop exposure applies serialized and fail-closed

**Files:**

- Create: `apps/desktop/src-tauri/src/server_exposure.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Modify: `apps/desktop/src-tauri/src/backend.rs:1085-1200, 2610-2665`
- Modify: `apps/desktop/src-tauri/src/bridge.rs:400-480, 1210-1300, 2940-3180`

**Interfaces:**

- Consumes: `BackendSupervisor`, desktop settings helpers, and `firewall::sync_remote_access_rule`.
- Produces: managed `ServerExposureCoordinator`, `apply_exposure`, and `BackendSupervisor::restart_default_if_active_with_exposure(app, desired)`.

- [x] **Step 1: Add failing backend override tests**

Add a backend test that stores wide settings but asks launch planning for local-only, and the converse. Assert:

```rust
assert_eq!(local_override.config.server_exposure_mode, "local-only");
assert_eq!(local_override.config.bind_host, DESKTOP_LOOPBACK_HOST);
assert_eq!(wide_override.config.server_exposure_mode, "network-accessible");
assert_eq!(wide_override.config.bind_host, DESKTOP_LAN_BIND_HOST);
```

Run:

```bash
cargo test -p bibcode-desktop backend::tests::exposure_override --lib -- --nocapture
```

Expected: FAIL because launch planning can only reread the persisted mode.

- [x] **Step 2: Add an ephemeral exposure override to backend restart planning**

Add:

```rust
pub async fn restart_default_if_active_with_exposure<R: Runtime>(
    &self,
    app: AppHandle<R>,
    desired: &str,
) -> Result<Option<BackendRunConfig>, String>
```

Thread `Option<&str>` through `start_default_with_reason` and `default_launch_plans`; clone the decoded `BackendDesktopSettings`, replace only `server_exposure_mode` for that launch, and leave the file untouched. Existing `start_default` and `restart_default_if_active` pass no override.

Run the Step 1 test and existing backend restart tests; expect green.

- [x] **Step 3: Create failing transaction-order and recovery tests with fake side effects**

Define a private test fake for this interface in `server_exposure.rs`:

```rust
pub(crate) trait ExposureOperations {
    fn persisted_mode(&self) -> Result<String, String>;
    fn persist_mode<'a>(&'a self, mode: &'a str) -> BoxFuture<'a, Result<(), String>>;
    fn current_config(&self) -> Option<BackendRunConfig>;
    fn restart_with_mode<'a>(&'a self, mode: &'a str)
        -> BoxFuture<'a, Result<Option<BackendRunConfig>, String>>;
    fn sync_firewall(&self, enabled: bool) -> BoxFuture<'_, Result<(), String>>;
    fn stop_backend(&self) -> BoxFuture<'_, Result<(), String>>;
}
```

Use a shared call log and queued results to assert:

```rust
assert_eq!(calls, ["restart:network-accessible", "firewall:true", "persist:network-accessible"]);
```

for success; assert a widening persist failure continues through `persist:local-only`, `restart:local-only`, and `firewall:false`; assert a failed local persistence does not skip restart/firewall; assert a narrowing restart failure closes the firewall and calls `stop`; and run two applies concurrently to prove their side-effect sequences do not interleave.

Run:

```bash
cargo test -p bibcode-desktop server_exposure::tests --lib -- --nocapture
```

Expected: FAIL because the coordinator and transaction do not exist.

- [x] **Step 4: Implement the serialized asymmetric transaction**

Implement:

```rust
#[derive(Default)]
pub(crate) struct ServerExposureCoordinator {
    apply_lock: tokio::sync::Mutex<()>,
}

pub(crate) async fn apply_exposure(
    coordinator: &ServerExposureCoordinator,
    operations: &impl ExposureOperations,
    desired: &str,
) -> Result<ExposureTransition, String>
```

Widen in restart → verify achieved wide → firewall open → persist-wide order. On any failure, collect rather than short-circuit local persistence, local override restart, firewall close, and stop when local restart cannot be verified. Narrow in persist-local → local override restart → firewall close order; never persist wide from recovery. Join initiating and recovery failures into one message.

- [x] **Step 5: Wire the production adapter and managed state**

Add `mod server_exposure;`, manage one `ServerExposureCoordinator::default()` in both the real and mock Tauri builders, accept `State<'_, ServerExposureCoordinator>` in `desktop_bridge_apply_server_exposure`, and replace the existing rollback block with `apply_exposure`. The production adapter calls the new backend override and existing firewall/settings functions.

- [x] **Step 6: Run desktop transaction, backend, and IPC tests and commit**

```bash
cargo test -p bibcode-desktop server_exposure::tests --lib
cargo test -p bibcode-desktop backend::tests --lib
cargo test -p bibcode-desktop bridge::tests --lib
vp test apps/web/src/tauriDesktopBridge.test.ts
```

Expected: all pass.

```bash
git add apps/desktop/src-tauri/src/server_exposure.rs apps/desktop/src-tauri/src/lib.rs apps/desktop/src-tauri/src/backend.rs apps/desktop/src-tauri/src/bridge.rs apps/web/src/tauriDesktopBridge.test.ts
git commit -m "fix(desktop): fail closed on exposure transitions"
```

### Task 6: Bound and stream E2EE transport work

**Files:**

- Modify: `apps/server/src/http.rs:210-275`
- Modify: `apps/server/src/rpc/mod.rs`
- Modify: `apps/server/src/rpc/e2ee.rs`
- Modify: `apps/server/tests/e2ee_ws.rs`
- Modify: `packages/client-runtime/src/e2ee/frame.ts`
- Modify: `packages/client-runtime/src/e2ee/frame.test.ts`
- Modify: `packages/client-runtime/src/e2ee/socket.ts`
- Modify: `packages/client-runtime/src/e2ee/socket.test.ts`
- Create: `packages/client-runtime/src/e2ee/testSupport.ts`
- Modify: `packages/client-runtime/src/e2ee/serverInterop.test.ts`
- Modify: `apps/server/src/auth/mod.rs`
- Modify: `apps/server/src/auth/host_identity.rs`
- Create: `scripts/remote-transport-hardening.test.ts`

**Interfaces:**

- Consumes: `MAX_E2EE_CIPHERTEXT_BYTES`, Noise send/receive states, socket write timeout, and record flags.
- Produces: lazy plaintext record iterators, per-record encryption/send, reusable server decrypt scratch, explicit WebSocket frame/message caps, and a 64 KiB client pre-auth assembler limit.

- [x] **Step 1: Add failing WebSocket and client pre-auth cap tests**

Add a raw `/ws-e2ee` test that sends a `MAX_E2EE_CIPHERTEXT_BYTES + 1` binary message before a valid Noise handshake and expects the transport to close. Add a source-level transport configuration contract that reads `apps/server/src/http.rs` and asserts the `/ws-e2ee` route applies both:

```typescript
expect(e2eeRoute).toContain(".max_frame_size(MAX_E2EE_CIPHERTEXT_BYTES)");
expect(e2eeRoute).toContain(".max_message_size(MAX_E2EE_CIPHERTEXT_BYTES)");
```

The static assertion is necessary because both the current application-level rejection and the desired WebSocket-level rejection close without a public memory-buffering signal. Keep the raw socket test beside it to verify peer-visible failure remains fail-closed. Add client frame tests:

```typescript
const assembler = new RecordAssembler(MAX_E2EE_PREAUTH_MESSAGE_BYTES);
expect(() => assembler.push(continuationRecord(40 * 1024))).not.toThrow();
expect(() => assembler.push(finalRecord(40 * 1024))).toThrow("E2EE reassembly overflow");
```

and an authenticated/default assembler case above 64 KiB that remains accepted.

Run:

```bash
cargo test -p bibcode-server --test e2ee_ws oversized_pre_auth_websocket_message_is_rejected -- --exact --nocapture
vp test scripts/remote-transport-hardening.test.ts packages/client-runtime/src/e2ee/frame.test.ts packages/client-runtime/src/e2ee/socket.test.ts
```

Expected: the static transport contract and client cap tests fail; the raw socket test documents the already fail-closed peer behavior.

- [x] **Step 2: Apply transport-level caps and phase-specific client assembly**

Re-export `MAX_E2EE_CIPHERTEXT_BYTES` from `rpc` and configure:

```rust
upgrade
    .max_frame_size(MAX_E2EE_CIPHERTEXT_BYTES)
    .max_message_size(MAX_E2EE_CIPHERTEXT_BYTES)
```

on `/ws-e2ee`. Add `MAX_E2EE_PREAUTH_MESSAGE_BYTES = 64 * 1024` to client frame code, accept a constructor cap in `RecordAssembler`, and use the pre-auth cap until the socket enters `open`; retain 64 MiB afterward.

- [x] **Step 3: Add failing lazy-record/order tests**

Define the wished-for APIs in tests:

```rust
let mut records = plaintext_records(&big).expect("valid message");
assert_eq!(records.next().expect("first").0, E2EE_RECORD_FLAG_CONTINUATION);
assert_eq!(records.count(), 2);
```

```typescript
expect([...plaintextRecords(payload)]).toHaveLength(3);
```

In the socket test, make the first mocked write block and assert the Noise send encryptor has been called once, not once per record. This proves later ciphertext is not precomputed before backpressure releases the first write.

Run the E2EE unit tests and expect failure because both implementations eagerly allocate arrays.

- [x] **Step 4: Encrypt and send one record at a time**

Add lazy `plaintext_records`/`plaintextRecords` iterators that yield `(flag, chunk)` without copying the entire message. Keep `splitIntoRecords` as a compatibility wrapper over the iterator for existing test helpers, but change production socket code to:

```typescript
for (const record of plaintextRecords(plaintext)) {
  const frame = transport.send.encryptWithAd(EMPTY, record);
  yield* write(frame);
}
```

On Rust, expose one-record encryption to the pumps; acquire the shared channel mutex only for `encrypt_record`, release it before the timed WebSocket write, and preserve the single outbound pump as send-order owner.

- [x] **Step 5: Reuse decrypt scratch and omit absent storage identity**

Add `decrypt_scratch: Vec<u8>` to `E2eeChannel`, resize it once to `MAX_E2EE_CIPHERTEXT_BYTES`, and reuse it in `decrypt_frame`. Build the pairing reply as a JSON object and insert `storageInstanceId` only when `config.storage_instance_id` is `Some`, so `None` never serializes as `""`.

Delete the stale Phase 3 `#[expect]` annotations and remove auth re-exports that have no consumers; keep `NOISE_NK_PARAMS` exported because E2EE uses it.

- [x] **Step 6: Extract reusable real-socket test support**

Move the non-process-specific helpers from `serverInterop.test.ts` into
`testSupport.ts` with these test-only exports:

```typescript
export interface EncryptedTestSocket {
  readonly nextMessage: () => Promise<string>;
  readonly sendMessage: (text: string) => void;
  readonly close: () => void;
}

export async function openEncryptedTestSocket(
  httpBaseUrl: string,
  hostKey: Uint8Array,
): Promise<EncryptedTestSocket>;

export async function requestTestRpc(
  channel: EncryptedTestSocket,
  requestId: string,
  tag: string,
  payload?: object,
): Promise<unknown>;
```

Keep process spawn/stop, filesystem host-key verification, and test assertions
inside `serverInterop.test.ts`. The helper uses the same ten-second frame
watchdog, lazy record iterator, and `RecordAssembler` as production protocol
tests; it is not exported from the package entry point.

- [x] **Step 7: Run crypto, interoperability, and client coverage and commit**

```bash
cargo test -p bibcode-server rpc::e2ee::tests --lib
cargo test -p bibcode-server --test e2ee_ws
vp test scripts/remote-transport-hardening.test.ts packages/client-runtime/src/e2ee/frame.test.ts packages/client-runtime/src/e2ee/noise.test.ts packages/client-runtime/src/e2ee/socket.test.ts packages/client-runtime/src/e2ee/serverInterop.test.ts
```

Expected: fragmentation, nonce exhaustion, wrong-key 4403, Cacophony vector, Rust/TypeScript interop, pre-auth cap, and oversize tests all pass.

```bash
git add apps/server/src/http.rs apps/server/src/rpc/mod.rs apps/server/src/rpc/e2ee.rs apps/server/tests/e2ee_ws.rs apps/server/src/auth/mod.rs apps/server/src/auth/host_identity.rs packages/client-runtime/src/e2ee/frame.ts packages/client-runtime/src/e2ee/frame.test.ts packages/client-runtime/src/e2ee/socket.ts packages/client-runtime/src/e2ee/socket.test.ts packages/client-runtime/src/e2ee/testSupport.ts packages/client-runtime/src/e2ee/serverInterop.test.ts scripts/remote-transport-hardening.test.ts
git commit -m "perf(remote): stream bounded E2EE records"
```

### Task 7: Bound updater delegation and fix plain WebSocket accounting

**Files:**

- Modify: `apps/server/src/remote_update.rs`
- Modify: `apps/server/tests/remote_update_rpc.rs`
- Modify: `apps/server/src/http.rs:210-255`
- Modify: `scripts/remote-transport-hardening.test.ts`

**Interfaces:**

- Consumes: `RemoteUpdateDelegate`, `HostUpdaterStatus`, `AuthService.mark_connected`, and Axum `on_upgrade`.
- Produces: a 30-second delegate timeout mapped to typed `RemoteUpdateState::Error`, and connection accounting that begins only inside a completed upgrade.

- [x] **Step 1: Add a failing hung-delegate test**

Create a `PendingHostUpdater` whose methods return `std::future::pending()`. Add a test-only timeout constructor:

```rust
let service = RemoteUpdateService::new(
    "0.4.2".to_owned(),
    interactive_support(),
    Some(Arc::new(PendingHostUpdater)),
).with_delegate_timeout(Duration::from_millis(10));
let snapshot = service.check().await;
assert_eq!(snapshot.state, RemoteUpdateState::Error);
assert_eq!(snapshot.error.as_deref(), Some("Desktop updater did not respond within 30 seconds."));
```

Run:

```bash
cargo test -p bibcode-server remote_update::tests::hung_delegate --lib -- --nocapture
```

Expected: FAIL because calls await forever and no timeout seam exists.

- [x] **Step 2: Wrap every delegate future with one bounded helper**

Add a default `Duration::from_secs(30)` field and a helper that uses `tokio::time::timeout`. `status`, `check`, and `request_install` all call the helper; timeout returns an error snapshot without panicking or holding a single-flight caller indefinitely.

- [x] **Step 3: Add a failing rejected-upgrade accounting contract**

Extend `remote-transport-hardening.test.ts` to isolate the authenticated plain `/ws` handler and assert `mark_connected` appears inside the `on_upgrade(move |socket| async move { ... })` body, with no call between successful authentication and `on_upgrade`. This source contract captures the otherwise timing-dependent TCP response-write failure seam; existing real-socket auth tests continue to cover successful connected/disconnected accounting and revocation teardown.

Run:

```bash
vp test scripts/remote-transport-hardening.test.ts
```

Expected: FAIL because `mark_connected` currently runs before `on_upgrade`.

- [x] **Step 4: Move accounting into the upgrade future and verify both fixes**

Move `mark_connected` to the first lines inside `on_upgrade`; retain the expiration guard, cancellation, and matching `mark_disconnected` in that future.

Run:

```bash
cargo test -p bibcode-server remote_update::tests --lib
cargo test -p bibcode-server --test remote_update_rpc
cargo test -p bibcode-server --test auth_http
vp test scripts/remote-transport-hardening.test.ts
```

Expected: all pass.

- [x] **Step 5: Commit lifecycle bounds**

```bash
git add apps/server/src/remote_update.rs apps/server/tests/remote_update_rpc.rs apps/server/src/http.rs scripts/remote-transport-hardening.test.ts
git commit -m "fix(remote): bound delegated lifecycle work"
```

### Task 8: Align living documentation and native validation runbooks

**Files:**

- Modify: `docs/architecture/remote.md`
- Modify: `docs/testing/cross-platform-validation.md`
- Review/modify if behavior changed: `docs/testing/linux-desktop.md`
- Review/modify if behavior changed: `docs/testing/macos-desktop.md`
- Review/modify if behavior changed: `docs/testing/windows-desktop.md`
- Review: `docs/testing/connection-runtime.md`
- Modify: `docs/plans/remote-servers/phases/phase-7-remote-updates.md` only for a factual command/runbook correction; do not rewrite historical implementation decisions.
- Create: `scripts/remote-architecture-contract.test.ts`

**Interfaces:**

- Consumes: final behavior and exact validation commands from Tasks 1-7.
- Produces: living documentation that states current lifecycle truth and repeatable native checks.

- [x] **Step 1: Add a documentation assertion for the corrected pairing and exposure claims**

Create `scripts/remote-architecture-contract.test.ts` to read
`docs/architecture/remote.md` and assert the living document contains these
truths and omits the stale retry claim:

```typescript
expect(remote).toContain("browser-session-cookie");
expect(remote).toContain("persists network-accessible only after");
expect(remote).toContain("interrupted exchange may consume the one-time token");
expect(remote).not.toContain("transport loss leaves it retryable");
```

Run that test and observe failure against the current document.

- [x] **Step 2: Rewrite the living lifecycle description**

Document all active off-host sessions regardless of access method; direct failed-mint convergence; serialized native applies; widen-last/narrow-first persistence; firewall/backend recovery; one post-narrow re-read and race-only re-widen; WebSocket caps; record-at-a-time E2EE; the 30-second update delegate timeout; and consume-before-delivery pairing semantics.

Explicitly state that post-bootstrap client verification failure can leave a visible session that the operator can revoke. Do not claim transparent retry or guaranteed credential delivery.

- [x] **Step 3: Update native runbook observations**

In cross-platform and OS runbooks, require visual evidence for:

```text
failed offer + successful cleanup -> local-only confirmation
failed offer + failed cleanup -> explicit cleanup failure
last browser session revoked -> local-only restart
concurrent new grant during narrowing -> reachable offer after one compensating widen
```

Retain platform-specific firewall, package, signing, and updater procedures. If an OS runbook needs no text change, record that fact for the final report rather than editing it gratuitously.

- [x] **Step 4: Disclose the relay handle fix without rewriting history**

Add a short remediation note to the final execution evidence section used by this plan stating that `81eff018` also dropped the writable relay executable handle before exec to prevent `ETXTBSY`; identify it as beneficial production scope discovered during E2EE interop, not part of a relay redesign.

- [x] **Step 5: Run docs checks and commit**

```bash
vp test scripts/remote-architecture-contract.test.ts
vp check
```

```bash
git add docs/architecture/remote.md docs/testing/cross-platform-validation.md docs/testing/linux-desktop.md docs/testing/macos-desktop.md docs/testing/windows-desktop.md docs/testing/connection-runtime.md scripts/remote-architecture-contract.test.ts
git commit -m "docs(remote): document fail-closed lifecycle"
```

Stage only files actually created or changed; omit reviewed-but-unchanged runbooks from `git add`.

### Task 9: Run complete repository and Docker validation

**Files:**

- Create: `packages/client-runtime/src/e2ee/dockerRemoteSmoke.test.ts`
- Modify only when a validation failure proves an in-scope regression: the closest source/test from Tasks 1-8.
- Do not commit generated `.codegraph/`, temporary Docker state, logs, container volumes, or test output.

**Interfaces:**

- Consumes: all committed remediation tasks.
- Produces: exact green evidence, a clean worktree, removed containers/network/volumes, commit hashes, and an honest residual-risk report.

- [x] **Step 1: Run all focused TypeScript and Rust regression targets**

```bash
vp test scripts/toolchain-contract.test.ts scripts/tauri-hardening.test.ts scripts/check-dependency-upgrade-ledger.test.ts scripts/remote-architecture-contract.test.ts scripts/remote-transport-hardening.test.ts packages/contracts/scripts/export-rust-auth-fixtures.test.ts packages/contracts/src/remoteUpdate.test.ts packages/shared/src/pairingCode.test.ts packages/shared/src/advertisedEndpoint.test.ts packages/client-runtime/src/connection/presentation.test.ts packages/client-runtime/src/connection/pairingAdd.test.ts packages/client-runtime/src/e2ee/frame.test.ts packages/client-runtime/src/e2ee/noise.test.ts packages/client-runtime/src/e2ee/socket.test.ts packages/client-runtime/src/e2ee/serverInterop.test.ts packages/client-runtime/src/e2ee/dockerRemoteSmoke.test.ts apps/web/src/desktopDeepLink.test.ts apps/web/src/state/shareExposureReconciler.test.tsx apps/web/src/components/settings/remote-servers/connectPresentation.test.ts apps/web/src/components/settings/remote-servers/shareOffer.test.ts apps/web/src/components/settings/remote-servers/ShareThisHostTab.test.tsx apps/web/src/tauriDesktopBridge.test.ts
cargo test -p bibcode-server auth::service::tests --lib
cargo test -p bibcode-server rpc::e2ee::tests --lib
cargo test -p bibcode-server remote_update::tests --lib
cargo test -p bibcode-server --test auth_http
cargo test -p bibcode-server --test e2ee_ws
cargo test -p bibcode-server --test remote_update_rpc
cargo test -p bibcode-server --test server_runtime route_inventory_covers_every_current_http_method_and_path -- --exact --nocapture
cargo test -p bibcode-desktop server_exposure::tests --lib
cargo test -p bibcode-desktop backend::tests --lib
cargo test -p bibcode-desktop bridge::tests --lib
```

Expected: every focused target passes. If a test is flaky, rerun its exact case to classify it, but do not call a range-introduced deterministic failure “baseline.”

- [x] **Step 2: Run repository completion gates**

```bash
vp check
vp run typecheck
vp test
cargo fmt --all --check
cargo test -p bibcode-server --no-fail-fast -j 2
cargo test -p bibcode-desktop --no-fail-fast -j 2
cargo clippy -p bibcode-server --all-targets -- -D warnings
cargo clippy -p bibcode-desktop --all-targets -- -D warnings
```

Expected: all deterministic gates pass. Record exact flaky test names, isolated reruns, and ancestry evidence for any nondeterministic failure that remains.

- [x] **Step 3: Add the opt-in Docker boundary test**

Create a test guarded by both `BIBCODE_DOCKER_SERVER_URL` and
`BIBCODE_DOCKER_ADMIN_CREDENTIAL`:

```typescript
const serverUrl = process.env["BIBCODE_DOCKER_SERVER_URL"];
const adminCredential = process.env["BIBCODE_DOCKER_ADMIN_CREDENTIAL"];

describe.skipIf(serverUrl === undefined || adminCredential === undefined)(
  "remote server Docker boundary",
  () => {
    it("pairs, runs E2EE RPC, retains browser exposure, updates, and revokes", async () => {
      const administrator = await exchangeAdministrativeCredential(serverUrl!, adminCredential!);
      const e2eeOffer = await createOffHostOffer(serverUrl!, administrator, "docker-e2ee");
      const payload = parsePairingCode(e2eeOffer.code);
      const channel = await openEncryptedTestSocket(
        serverUrl!,
        decodeBase64UrlKey(payload.hostKey),
      );
      channel.sendMessage(JSON.stringify({ type: "e2ee_auth", pairing: payload.token }));
      expect(JSON.parse(await channel.nextMessage())).toMatchObject({
        type: "e2ee_authenticated",
        credential: expect.any(String),
        environmentId: expect.any(String),
        storageInstanceId: payload.storageInstanceId,
      });
      await assertRemoteUpdateRpc(channel);
      await assertBrowserPairingRetainsAndRevokesExposure(serverUrl!, administrator);
      channel.close();
    }, 60_000);
  },
);
```

Define the named helpers in the test using real `fetch` calls and
`requestTestRpc`; each helper asserts HTTP status and decoded response shape.
The test exchanges the supplied administrative one-time credential at
`/oauth/token`, mints one off-host E2EE offer and a second off-host browser
offer, parses both with `parsePairingCode`, and performs all requests against
`serverUrl`. It does not spawn a process, read the server filesystem, or fall
back to loopback.

Run without Docker variables:

```bash
vp test packages/client-runtime/src/e2ee/dockerRemoteSmoke.test.ts
```

Expected: one explicitly skipped opt-in test and no failure.

- [x] **Step 4: Build the server binary for container validation**

```bash
cargo build -p bibcode-server
docker version
```

Expected: `target/debug/bibcode` exists and the Docker daemon responds.

- [x] **Step 5: Start isolated server and client containers**

Use fixed, narrowly scoped names and a temporary named volume:

```bash
docker network create bibcode-remote-stabilization
docker volume create bibcode-remote-stabilization-data
docker run -d --name bibcode-remote-server \
  --network bibcode-remote-stabilization \
  -v "$PWD/target/debug/bibcode:/usr/local/bin/bibcode:ro" \
  -v bibcode-remote-stabilization-data:/data \
  debian:bookworm-slim \
  /usr/local/bin/bibcode --base-dir /data --host 0.0.0.0 --port 3773 serve
for attempt in $(seq 1 40); do
  BIBCODE_DOCKER_PAIRING_JSON=$(docker exec bibcode-remote-server \
    /usr/local/bin/bibcode --base-dir /data pairing issue --json 2>/dev/null) && break
  sleep 0.25
done
BIBCODE_DOCKER_ADMIN_CREDENTIAL=$(node -e \
  'process.stdout.write(JSON.parse(process.argv[1]).credential)' \
  "$BIBCODE_DOCKER_PAIRING_JSON")
docker run --rm --name bibcode-remote-client \
  --network bibcode-remote-stabilization \
  -v "$PWD:/workspace:ro" -w /workspace \
  -e BIBCODE_DOCKER_SERVER_URL=http://bibcode-remote-server:3773 \
  -e BIBCODE_DOCKER_ADMIN_CREDENTIAL="$BIBCODE_DOCKER_ADMIN_CREDENTIAL" \
  node:26-bookworm \
  corepack pnpm exec vite-plus test packages/client-runtime/src/e2ee/dockerRemoteSmoke.test.ts
unset BIBCODE_DOCKER_PAIRING_JSON BIBCODE_DOCKER_ADMIN_CREDENTIAL
```

The test uses the server container rather than spawning a host process. The
scoped credential variables are unset immediately and never appear in the
final report or committed fixtures.

- [x] **Step 6: Assert the cross-container feature boundary**

The client test must assert, through real HTTP/WebSocket traffic:

```text
descriptor capability and remote-update support
authenticated administrative session
off-host pairing offer and pinned host key
Noise NK pairing credential exchange
authenticated E2EE RPC
browser-session consumption retains desiredExposure=wide
updater.status and updater.check
typed remote_update_manual_required install failure
browser-session revocation returns desiredExposure=loopback
```

Expected: every assertion passes with the server and client in distinct containers on the Docker bridge network.

- [x] **Step 7: Remove all Docker resources even after a failed assertion**

```bash
docker rm -f bibcode-remote-server 2>/dev/null || true
docker network rm bibcode-remote-stabilization 2>/dev/null || true
docker volume rm bibcode-remote-stabilization-data 2>/dev/null || true
```

Verify:

```bash
docker ps -a --filter name=bibcode-remote- --format '{{.Names}}'
docker network ls --filter name=bibcode-remote-stabilization --format '{{.Name}}'
docker volume ls --filter name=bibcode-remote-stabilization-data --format '{{.Name}}'
```

Expected: all three commands print nothing.

- [x] **Step 8: Commit the Docker harness and review final diff, commits, and worktree**

```bash
git add packages/client-runtime/src/e2ee/dockerRemoteSmoke.test.ts
git commit -m "test(remote): add cross-container smoke coverage"
```

```bash
git diff --check
git status --short
git log --oneline 98ac79bd..HEAD
git diff --stat 98ac79bd..HEAD
```

Expected: no unstaged or untracked implementation files, no generated graph data, no debug logging, and only intentional commits.

- [x] **Step 9: Request a final code review before declaring completion**

Use `superpowers:requesting-code-review` against `98ac79bd..HEAD`, require both standards and specification review, fix any confirmed High/Medium regression test-first, rerun affected gates, and report all commit hashes plus exact validation evidence and residual packaged-native risk.

### Task 10: Close fresh adversarial-review lifecycle findings

**Files:**

- Modify: `apps/server/src/auth/{http,service}.rs`
- Modify: `apps/server/src/persistence/{migrations,repositories}.rs`
- Modify: `apps/server/src/rpc/e2ee.rs`
- Modify: `apps/desktop/src-tauri/src/{bridge,server_exposure}.rs`
- Modify: `apps/web/src/state/shareExposureReconciler.ts`
- Modify: `packages/client-runtime/src/connection/{pairingAdd,registry}.ts`
- Modify: focused tests and living remote/testing documentation beside those owners

**Interfaces:**

- Consumes: principal-scoped pairing-offer keys, SQLite migration 47, authenticated E2EE plaintext, desktop topology settings, renderer topology generations, and exact connection-registration ownership.
- Produces: restart-durable offer replay/cancellation, byte-weighted E2EE admission, WSL-safe exposure convergence, and compare-and-remove pairing compensation.

- [x] Persist pending/completed/tombstoned pairing-offer idempotency records with the pairing grant in SQLite transactions; hydrate and prune them before capacity checks; cover completed and pending crash windows across service restart.
- [x] Replace record-count E2EE admission with global and per-connection byte budgets while retaining arbitrary legal chunk sizes, established-connection bounds, and declared wire error codes.
- [x] Reject native exposure at the desktop owner when authoritative settings are WSL-only, and invalidate renderer reconciliation when bridge, primary environment, or WSL ownership changes.
- [x] Make pairing-add compensation conditional on the exact registration object still owning the environment under the registry lease lock; cover a queued older rollback racing a replacement registration.
- [x] Restore the unrelated environment-project plan/spec and provider reconciliation assertion to the pre-range baseline in history.
- [ ] Repeat focused tests, all repository gates, complete Rust suites, Clippy, direct interop, and the separate-container Docker boundary after these changes.
- [ ] Request fresh standards, specification, and core review over `3b1864eff..HEAD`; fix every confirmed High/Medium issue before completion.

### Task 11: Make pairing-add compensation durable across client runtimes

**Files:**

- Modify: `packages/client-runtime/src/platform/persistence.ts`
- Modify: `packages/client-runtime/src/connection/registry.ts`
- Modify: `apps/web/src/connection/storage.ts`
- Modify: the closest storage-document and registry tests

**Interfaces:**

- Consumes: an exact `ConnectionRegistration`, the encrypted connection catalog compare-and-set boundary, and the registry's per-environment lease.
- Produces: conditional rollback that removes only the exact durable registration written by the failed add, even when another tab/runtime has already replaced it.

- [x] Add a failing two-store test for A-register, B-replace, A-rollback that proves B's target, profile, and credential survive.
- [x] Move conditional removal into `ConnectionRegistrationStore`; use the platform catalog CAS loop rather than process-local object identity as the durable authority.
- [x] Keep runtime cleanup conditional on the durable CAS outcome and cover both rollback-before-replacement and replacement-before-rollback orderings.
- [x] Run focused storage, registry, and pairing-add tests; update `docs/architecture/connection-runtime.md` if its existing cross-store guarantee needs clarification.

### Task 12: Make auth revocation and offer authority coherent across live servers

**Files:**

- Modify: `apps/server/src/auth/service.rs`
- Modify: `apps/server/src/persistence/repositories.rs`
- Modify: `apps/server/tests/auth_http.rs`
- Modify: repository/service tests and `docs/architecture/remote.md`

**Interfaces:**

- Consumes: simultaneously live `AuthService` instances sharing SQLite, durable sessions/pairing grants, and principal/key offer rows.
- Produces: transactional replay/reservation/quota/cancellation results and bounded cross-process live-connection revocation.

- [ ] Add a failing two-live-service test for create on A, replay/conflict/cancel on B, replay after cancellation on A, and shared 128-per-principal/4,096-global quota enforcement.
- [ ] Make SQLite keyed reservation authoritative: return the persisted existing/pending/cancelled/reserved row from one transaction, enforce both quotas there, and refresh each process-local projection from repository outcomes.
- [ ] Add a failing two-server live-subscription test proving revocation through B closes an already-ACKed stream on A before later events can be delivered.
- [ ] Implement one bounded per-service durable-state watcher while any local live connection, cached active grant/session, or access-state subscriber can require convergence; avoid one poller per socket, stop it only when the service has no remaining authority consumer, and preserve immediate same-process cancellation. Prove an off-host grant cancelled through B converges A's share state and access-change event even when A has no live socket.
- [ ] Run focused repository, auth service, auth HTTP/WebSocket, restart, and simultaneous-server tests; document the cross-process convergence bound.

### Task 13: Budget E2EE resources by principal and outbound bytes

**Files:**

- Modify: `apps/server/src/rpc/e2ee.rs`
- Modify: `apps/server/src/rpc/session.rs` only if the enqueue boundary must carry byte permits
- Modify: E2EE/session tests and `docs/architecture/remote.md`

**Interfaces:**

- Consumes: authenticated principal/session identity, plaintext record reassembly, generic RPC response enqueue, and encrypted socket writes.
- Produces: per-principal established-socket and inbound-byte quotas plus process-wide/per-connection outbound byte permits retained until encrypted write completion.

- [ ] Add failing two-principal tests proving one principal cannot consume every established socket or all inbound plaintext bytes through multiple connections.
- [ ] Key aggregate established and inbound admission by authenticated principal, clean quotas on every close/error/cancellation path, and retain global defense-in-depth caps.
- [ ] Add a failing slow-reader multi-socket test showing large bounded RPC responses cannot accumulate beyond configured process and connection byte budgets.
- [ ] Acquire outbound byte permits before response enqueue, retain them through encrypted socket write, and keep the existing five-second send failure behavior.
- [ ] Run focused E2EE, session, WebSocket, interop, and Clippy checks; update the documented exact caps and ownership.

### Task 14: Repeat completion evidence and review

- [ ] Re-run every focused regression plus `vp check`, `vp run typecheck`, `vp test`, Rust formatting, complete server/desktop suites, and both Clippy targets.
- [ ] Rebuild and run direct TypeScript-to-Rust E2EE interop and the separate Debian/Node Docker smoke; prove test-owned resources are removed.
- [ ] Complete the execution-report template without claiming unavailable native/package evidence or Docker fragmentation that was not exercised.
- [ ] Reapply the two original user-staged environment-project documentation deletions after every product commit.
- [ ] Request one final adversarial review of `3b1864eff..HEAD` and close every confirmed High/Medium issue.
