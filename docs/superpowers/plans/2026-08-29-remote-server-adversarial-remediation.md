# Remote Server Adversarial Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair every confirmed remote-server lifecycle, transport, recovery, networking, and governance defect without weakening the approved fail-closed model.

**Architecture:** Four independently testable subprojects keep authority in the server auth service, desktop host, client runtime, and web platform respectively. Additive contracts expose actual versus configured/native versus external state; deep admission owners bound peer, byte, and process work; all privileged recovery remains behind `DesktopBridge`.

**Tech Stack:** Rust, Axum, Tokio, rusqlite, Tauri 2, TypeScript, React 19, Effect, Vitest, Docker.

**Spec:** `docs/superpowers/specs/2026-08-29-remote-server-adversarial-remediation-design.md`

## Global Constraints

- Preserve the staged environment-project-management deletions and the untracked adversarial review.
- Keep `packages/contracts` schema-only and production Node-free.
- Keep Noise NK and pairing-code v1 wire compatible.
- Start every fresh native desktop process actual local-only.
- Run the closest focused test red, then green, for every behavior.
- Commit each task with only its owned files.

---

## Subproject A — Pairing, authentication, and exposure

### Task 1: Confirm hosted pairing before token consumption

**Files:**
- Modify: `apps/web/src/components/auth/PairingRouteSurface.tsx`
- Modify: `apps/web/src/components/auth/PairingRouteSurface.test.tsx`

**Interfaces:**
- Consumes: `readHostedPairingRequest()` and `stripPairingTokenFromUrl()`.
- Produces: `HostedPairingRouteSurface` that calls `connectPairing` only from explicit user action.

- [x] **Step 1: Write the failing component tests**

Add tests that render a hosted request, assert the fragment is stripped, assert
`connectPairing` has zero calls after effects settle, verify the normalized host
is visible, click **Pair this backend**, and then assert exactly one call. Add a
second test proving an ambiguous submitted token cannot be submitted twice.

- [x] **Step 2: Verify red**

Run: `vp test apps/web/src/components/auth/PairingRouteSurface.test.tsx`

Expected: the mount-time zero-call assertion fails because the current effect
submits immediately.

- [x] **Step 3: Implement the confirmation state**

Initialize hosted status as `confirm`, strip the URL in a mount effect, delete
the mount call to `submitHostedPairingRequest`, render **Pair this backend**, and
transition to `pairing` only inside its click handler. Keep
`tokenSubmittedRef` as the page-lifetime single-use guard.

- [x] **Step 4: Verify green and commit**

Run: `vp test apps/web/src/components/auth/PairingRouteSurface.test.tsx`

Commit: `fix(remote): confirm hosted pairing before connect`

### Task 2: Expose actual/configured/native/external topology and legacy resume

**Files:**
- Modify: `packages/contracts/src/ipc.ts`
- Modify: `packages/contracts/src/ipc.test.ts`
- Modify: `apps/desktop/src-tauri/src/bridge.rs`
- Modify: `apps/web/src/tauriDesktopBridge.ts`
- Modify: `apps/web/src/state/desktopNetworkAccess.ts`
- Modify: `apps/web/src/components/settings/remote-servers/ShareThisHostTab.tsx`
- Modify: corresponding tests beside each file

**Interfaces:**
- Produces additive `DesktopServerExposureState.configuredMode` and
  `management: "native" | "external"`.
- Produces `canResumeLegacyExposure(shareState, exposureState): boolean`.

- [x] **Step 1: Write red schema/native/UI tests**

Pin these decoded values:

```ts
{
  mode: "local-only",
  configuredMode: "network-accessible",
  management: "native",
  endpointUrl: null,
  advertisedHost: null,
  tailscaleServeEnabled: false,
  tailscaleServePort: 443,
}
```

Add Rust tests proving runtime `mode` wins while configured mode remains
visible, and WSL wildcard topology returns `mode: "network-accessible"` plus
`management: "external"`. Add Share-tab tests for the four legacy-resume
predicates and the explicit bridge invocation.

- [x] **Step 2: Verify red**

Run: `vp test packages/contracts/src/ipc.test.ts apps/web/src/state/desktopNetworkAccess.test.ts apps/web/src/components/settings/remote-servers/ShareThisHostTab.test.tsx`

Run: `cargo test -p bibcode-desktop server_exposure_state -- --nocapture`

- [x] **Step 3: Implement the additive contract and consent action**

Extend the schema with defaults for old bridge payloads, return both actual and
configured modes from Rust, classify WSL from `BackendRunConfig`, and add:

```ts
export function canResumeLegacyExposure(
  share: AuthShareExposureState,
  exposure: DesktopServerExposureState,
): boolean
```

The button calls `applyServerExposure("network-accessible")`; it does not alter
startup logic. Render WSL copy that names externally managed WSL/Hyper-V policy
and removes automatic-narrowing promises.

- [x] **Step 4: Verify green and commit**

Repeat the focused commands and commit:
`fix(remote): make exposure recovery explicit`

### Task 3: Lock Rust/TypeScript endpoint classifier parity

**Files:**
- Create: `packages/shared/fixtures/pairing-endpoint-classification.json`
- Modify: `packages/shared/src/advertisedEndpoint.test.ts`
- Modify: `apps/server/src/auth/http.rs`
- Modify: `apps/server/src/auth/http_tests.rs` or the existing auth HTTP test module

**Interfaces:**
- Fixture rows: `{ "endpoint": string, "classification": "loopback" | "private-network" | "public" | "unconnectable" }`.
- Rust normalizes `Ipv6Addr::to_ipv4_mapped()` before classification.

- [x] **Step 1: Add red parity fixtures/tests**

Include `http://[::ffff:127.0.0.1]:3773`, mapped RFC1918, mapped public,
wildcard, port zero, DNS names beginning with `fd`, and path text containing
`:0`.

- [x] **Step 2: Verify red**

Run: `vp test packages/shared/src/advertisedEndpoint.test.ts`

Run: `cargo test -p bibcode-server pairing_endpoint -- --nocapture`

- [x] **Step 3: Normalize mapped addresses and consume the shared fixture**

Use `to_ipv4_mapped().map(IpAddr::V4).unwrap_or(IpAddr::V6(value))` in Rust.
Both tests deserialize the same JSON file; production ownership stays in each
language because Rust cannot depend on a TypeScript runtime package.

- [x] **Step 4: Verify green and commit**

Commit: `fix(auth): align pairing endpoint classification`

### Task 4: Compensate failed credential delivery and recover pending offers

**Files:**
- Modify: `apps/server/src/auth/service.rs`
- Modify: `apps/server/src/auth/http.rs`
- Modify: `apps/server/src/persistence/repositories.rs`
- Modify: `apps/server/src/rpc/e2ee.rs`
- Modify: existing unit/integration tests in those modules and `apps/server/tests/e2ee_ws.rs`

**Interfaces:**
- Produces internal `AuthService::revoke_failed_pairing_session(session_id)`.
- Changes matching pending replay to atomic revoke/remove plus fresh issuance.
- Produces an internal delivery guard whose `commit()` disarms compensation.

- [x] **Step 1: Write red repository/service/E2EE tests**

Test a matching pending row, retry, and assert the old pairing is revoked and a
new completed result is replayable. Test mismatch/tombstone unchanged. Inject a
credential-reply writer failure and an established-capacity bind failure;
assert the minted session is absent from share state and clients afterward.

- [x] **Step 2: Verify red**

Run: `cargo test -p bibcode-server pairing_offer -- --nocapture`

Run: `cargo test -p bibcode-server --test e2ee_ws -- --nocapture`

- [x] **Step 3: Implement transactional retry and delivery compensation**

Add one repository transaction for matching pending cleanup. Construct a
session guard after exchange, revoke on every return before successful encrypted
reply delivery, and disarm only after the final send resolves. Preserve the
original protocol error if cleanup also fails and log only IDs, never tokens.

- [x] **Step 4: Verify green and commit**

Commit: `fix(auth): compensate incomplete pairing issuance`

## Subproject B — E2EE admission and backpressure

### Task 5: Bound unauthenticated E2EE work by peer

**Files:**
- Modify: `apps/server/src/lifecycle.rs`
- Modify: `apps/server/src/http.rs`
- Modify: `apps/server/src/rpc/e2ee.rs`
- Modify: `apps/server/tests/e2ee_ws.rs`

**Interfaces:**
- Produces `E2eePreauthAdmission::try_admit(peer_ip, now)` returning an owned lease.
- Limits: global 32, per peer 4, burst 8, refill 1/s, handshake 10s.

- [x] **Step 1: Write red admission tests**

Use a paused Tokio clock and distinct loopback aliases to prove one peer cannot
consume all 32 slots, the fifth concurrent peer connection is rejected, tokens
refill, and peer-map entries disappear after leases/rate state expire.

- [x] **Step 2: Verify red**

Run: `cargo test -p bibcode-server rpc::e2ee::tests::preauth -- --nocapture`

Run: `cargo test -p bibcode-server --test e2ee_ws preauth -- --nocapture`

- [x] **Step 3: Implement socket-peer admission**

Serve the production router with socket connect info, extract
`Option<ConnectInfo<SocketAddr>>`, and use only `SocketAddr::ip()` as the peer
key. Tests without connect info receive a deterministic test/unknown key and
remain under global admission.

- [x] **Step 4: Verify green and commit**

Commit: `fix(e2ee): partition preauth admission by peer`

### Task 6: Backpressure inbound records and bound fragmentation

**Files:**
- Modify: `apps/server/src/rpc/e2ee.rs`
- Modify: `packages/client-runtime/src/e2ee/frame.ts`
- Modify: `packages/client-runtime/src/e2ee/frame.test.ts`
- Modify: `packages/client-runtime/src/e2ee/socket.test.ts`
- Modify: `apps/server/tests/e2ee_ws.rs`

**Interfaces:**
- Produces `DecryptedRecord { final_record: bool, chunk: Vec<u8> }`.
- Produces `MAX_E2EE_RECORDS_PER_MESSAGE = 2_048` in both implementations.
- Global byte admission waits up to five seconds per record after Noise unlock.

- [x] **Step 1: Write red tests**

Replace the current victim-close expectation with a test that holds global
capacity, starts another channel, releases capacity, and observes successful
assembly. Add a timeout case. Add Rust/TS tests rejecting 2,049 records and an
empty continuation while accepting an empty final record.

- [x] **Step 2: Verify red**

Run: `cargo test -p bibcode-server rpc::e2ee::tests::inbound -- --nocapture`

Run: `vp test packages/client-runtime/src/e2ee/frame.test.ts packages/client-runtime/src/e2ee/socket.test.ts`

- [x] **Step 3: Split decrypt from async admission**

Decrypt one record under the channel lock, return the chunk, release the lock,
await only the global record-sized semaphore, then take per-session and
per-connection permits without waiting. Append only after all permits exist.
Drop completed-message input permits immediately after decode/authorize/dispatch
rather than cloning them into response-stream tasks.

- [x] **Step 4: Verify green and commit**

Commit: `fix(e2ee): backpressure inbound records fairly`

### Task 7: Remove outbound head-of-line blocking and resettable deadlines

**Files:**
- Modify: `apps/server/src/rpc/session.rs`
- Modify: `apps/server/src/rpc/e2ee.rs`
- Modify: unit tests in both modules

**Interfaces:**
- Replaces the process semaphore with `RpcOutboundProcessBudget::acquire(bytes, deadline)`.
- Keeps `RpcOutboundBudget` as the session-facing facade.
- One `Instant` covers all record sends for a dequeued message.

- [x] **Step 1: Write red deterministic tests**

Hold enough process bytes that a large waiter cannot fit, enqueue it, then
enqueue a small response and assert the small permit arrives first. Release
capacity and assert the aged large waiter later succeeds. With paused time and
a writer that accepts one record per four seconds, assert a multi-record message
fails at five total seconds rather than after five seconds per record.

- [x] **Step 2: Verify red**

Run: `cargo test -p bibcode-server rpc::session::tests::outbound -- --nocapture`

Run: `cargo test -p bibcode-server rpc::e2ee::tests::outbound -- --nocapture`

- [x] **Step 3: Implement fit-first allocation with aging**

Maintain available bytes and queued requests behind one Tokio mutex plus
per-request oneshot completion. On release, grant fitting requests; after the
aging threshold reserve progress for the oldest request. Cancellation removes
the waiter. In the E2EE pump compute one deadline before the record loop and use
`timeout_at(deadline, socket.send(...))` for every write.

- [x] **Step 4: Verify green and commit**

Commit: `fix(rpc): make outbound byte admission work conserving`

### Task 8: Make plain WebSocket lifecycle limits explicit

**Files:**
- Modify: `apps/server/src/http.rs`
- Modify: `apps/server/tests/auth_http.rs` or closest WebSocket integration test
- Modify: `apps/server/tests/server_runtime.rs`

**Interfaces:**
- Both upgrades set explicit frame/message limits.
- `mark_connected` occurs only inside `on_upgrade`.

- [x] **Step 1: Write a red failed-upgrade behavior test**

Open a raw TCP request that authenticates but never completes a valid WebSocket
upgrade, then query the client list and assert connected count remains zero.

- [x] **Step 2: Verify red**

Run: `cargo test -p bibcode-server --test auth_http failed_websocket_upgrade -- --nocapture`

- [x] **Step 3: Move lifecycle ownership into the upgrade and set caps**

Construct the live-connection token inside `on_upgrade`; keep it owned by the
session future. Set plain RPC to its documented 64 MiB transport ceiling and
E2EE to the single-record ceiling.

- [x] **Step 4: Verify green and commit**

Commit: `fix(rpc): bind websocket lifecycle to successful upgrade`

## Subproject C — Desktop networking and process bounds

### Task 9: Enumerate all usable native addresses and packaged Tailscale paths

**Files:**
- Create: `apps/desktop/src-tauri/src/network_interfaces.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Modify: `apps/desktop/src-tauri/src/backend.rs`
- Modify: `apps/desktop/src-tauri/src/bridge.rs`
- Modify: `apps/desktop/src-tauri/src/tailscale.rs`
- Modify: `Cargo.toml`, `apps/desktop/src-tauri/Cargo.toml`, `Cargo.lock`
- Modify dependency ledger/inventory files if a crate is added

**Interfaces:**
- Produces `NetworkAddress { interface_name, ip, is_default_route }`.
- Produces `enumerate_advertised_addresses(provider) -> Vec<NetworkAddress>`.
- Produces ordered `tailscale_command_candidates()`.

- [x] **Step 1: Write red pure tests**

Inject Ethernet, Wi-Fi, VPN/CGNAT, duplicate, loopback, unspecified, IPv4
link-local, IPv6 global, and IPv6 link-local fixtures. Assert filtering,
deduplication, ordering, stable endpoint IDs, and bracketed IPv6 URLs. Test
absolute macOS/Windows/Linux candidate preference and `PATH` fallback.

- [x] **Step 2: Verify red**

Run: `cargo test -p bibcode-desktop network_interfaces -- --nocapture`

Run: `cargo test -p bibcode-desktop tailscale -- --nocapture`

- [x] **Step 3: Implement the focused provider**

Use one maintained cross-platform interface-enumeration crate only after
checking its current primary documentation and repository compatibility. Keep
the UDP probe as a ranking hint. Convert all addresses to normalized `IpAddr`,
filter in the new module, then let bridge presentation build endpoints.

- [x] **Step 4: Update dependency governance, verify, and commit**

Run: `vp run check:dependency-ledger`

Commit: `feat(desktop): enumerate remote access endpoints`

### Task 10: Bound firewall commands and report WSL honestly

**Files:**
- Modify: `apps/desktop/src-tauri/src/firewall.rs`
- Modify: `apps/desktop/src-tauri/src/bridge.rs`
- Modify: `packages/contracts/src/ipc.ts`
- Modify: `apps/web/src/components/settings/remote-servers/ShareThisHostTab.tsx`
- Modify: focused tests beside each file

**Interfaces:**
- Firewall runner returns timeout as a normal transition error after child reap.
- WSL state uses `management: "external"`, actual network-accessible mode.

- [x] **Step 1: Write red timeout and WSL tests**

Use paused time plus a pending fake runner to assert return at 15 seconds and a
recorded terminate/reap. Assert WSL rendering never promises automatic switch-
off and native exposure commands remain rejected.

- [x] **Step 2: Verify red**

Run: `cargo test -p bibcode-desktop firewall -- --nocapture`

Run the Task 2 focused web/contract tests.

- [x] **Step 3: Implement one absolute command deadline**

Set child `kill_on_drop(true)`, wrap output collection with `timeout`, explicitly
kill/wait on timeout, and preserve bounded stdout/stderr. Update WSL copy/state
only; do not add an unreviewed firewall manager.

- [x] **Step 4: Verify green and commit**

Commit: `fix(desktop): bound firewall work and expose WSL topology`

## Subproject D — Browser recovery, updates, shared policy, and governance

### Task 11: Add boot-level IndexedDB conflict recovery

**Files:**
- Create: `apps/web/src/connection/databaseHealth.ts`
- Create: `apps/web/src/connection/databaseHealth.test.ts`
- Create: `apps/web/src/components/ConnectionDatabaseRecoveryDialog.tsx`
- Create: `apps/web/src/components/ConnectionDatabaseRecoveryDialog.test.tsx`
- Modify: `apps/web/src/connection/storage.ts`
- Modify: `apps/web/src/connection/storage.test.ts`
- Modify: `apps/web/src/AppRoot.tsx`
- Modify: `apps/web/src/AppRoot.test.tsx`

**Interfaces:**
- Produces external store state `ready | incompatible | blocked | unavailable`.
- Produces `deleteIncompatibleConnectionDatabase(): Promise<"deleted" | "blocked">`.

- [x] **Step 1: Write red event and dialog tests**

Fake `IDBOpenDBRequest` events for `VersionError`, `blocked`, generic error, and
success-after-blocked. Assert the dialog is independent of the failed Effect
runtime, lists every deleted data category, requires explicit confirmation,
reports blocked deletion, and reloads only after delete success.

- [x] **Step 2: Verify red**

Run: `vp test apps/web/src/connection/databaseHealth.test.ts apps/web/src/components/ConnectionDatabaseRecoveryDialog.test.tsx apps/web/src/connection/storage.test.ts apps/web/src/AppRoot.test.tsx`

- [x] **Step 3: Implement the boot health owner and dialog**

Keep database constants in `databaseHealth.ts`. Publish events from the existing
open request. Implement delete with `success`, `error`, and `blocked` listeners.
Subscribe through `useSyncExternalStore` in AppRoot so no connection-runtime
service is required to render recovery.

- [x] **Step 4: Verify green and commit**

Commit: `fix(web): recover incompatible connection database`

### Task 12: Fix cold disconnect and bound update checks

**Files:**
- Modify: `packages/client-runtime/src/connection/registry.ts`
- Modify: `packages/client-runtime/src/connection/registry.test.ts`
- Modify: `packages/client-runtime/src/state/remoteUpdates.ts`
- Modify: `packages/client-runtime/src/state/remoteUpdates.test.ts`
- Modify: nearest web update-control tests

**Interfaces:**
- `disconnect` never creates a supervisor.
- Remote update check timeout is 30 seconds and produces a settled failure.

- [x] **Step 1: Write red lifecycle/timeout tests**

Assert disconnecting a registered-but-cold environment makes zero resolver and
driver calls. With a never-settling RPC check and fake clock, assert the batch
settles that row at 30 seconds while another row completes and worker capacity
is released.

- [x] **Step 2: Verify red**

Run: `vp test packages/client-runtime/src/connection/registry.test.ts packages/client-runtime/src/state/remoteUpdates.test.ts`

- [x] **Step 3: Split lookup from connected acquisition and add Effect timeout**

Have `disconnect` inspect the supervisor map under its existing lock and return
when absent. Wrap `updater.check` at the Effect command boundary with a typed
30-second timeout so interruption reaches the RPC session; keep fan-out at two.

- [x] **Step 4: Verify green and commit**

Commit: `fix(client-runtime): bound remote update lifecycle`

### Task 13: Consolidate shared policy and honest cleanup results

**Files:**
- Modify: `packages/client-runtime/src/connection/presentation.ts`
- Modify: `packages/client-runtime/src/connection/presentation.test.ts`
- Modify: web connection badge consumers/tests
- Create: `apps/server/src/auth/limits.rs`
- Modify: `apps/server/src/auth/mod.rs`
- Modify: `apps/server/src/auth/service.rs`
- Modify: `apps/server/src/persistence/repositories.rs`
- Modify: `apps/web/src/components/settings/remote-servers/shareOffer.ts`
- Modify: `apps/web/src/components/settings/remote-servers/shareOffer.test.ts`
- Modify: `apps/web/src/components/settings/remote-servers/ShareThisHostTab.tsx`

**Interfaces:**
- `connectionTransportSecurity` treats blank/whitespace host keys as absent.
- One auth limits module owns pairing/session capacity constants.
- Cleanup returns `local-confirmed | active-reason | cancellation-unconfirmed | cleanup-failed`.

- [x] **Step 1: Write red shared-policy and cleanup tests**

Pin whitespace host keys, all target types, and each cleanup copy/outcome.
Compile-time imports prove service/repository consume `auth::limits`.

- [x] **Step 2: Verify red**

Run focused presentation, share-offer, and Share-tab tests.

- [x] **Step 3: Move policy without compatibility aliases**

Delete mirrored web transport classification and private capacity literals.
Return the discriminated cleanup result through the ceremony and render exact
actual-state copy.

- [x] **Step 4: Verify green and commit**

Commit: `refactor(remote): centralize transport and cleanup policy`

### Task 14: Align living docs, gates, runbooks, and Docker evidence

**Files:**
- Modify: `docs/architecture/remote.md`
- Modify: `docs/architecture/overview.md`
- Modify: `docs/superpowers/specs/2026-08-28-remote-server-stabilization-design.md`
- Modify affected files under `docs/testing/`
- Modify affected gate fixtures/scripts only where behavior or dependencies changed
- Create execution report from the current testing template if required by runbooks

**Interfaces:**
- Living docs describe current behavior; prior design gets a supersession note.
- Historical phase specs are not rewritten.

- [x] **Step 1: Update architecture and runbooks in the same patch**

Document explicit legacy resume, external WSL management, peer admission,
record-count cap, global waiting, fit-first outbound admission, total message
deadline, session compensation, pending-offer recovery, IndexedDB reset, full
interface enumeration, Tailscale paths, firewall/update timeouts, and behavioral
failed-upgrade coverage.

- [x] **Step 2: Run focused gate and package validation**

Run:

```bash
vp run check:contracts
vp run check:dependency-ledger
vp check
vp run typecheck
vp test
cargo fmt --all --check
cargo test -p bibcode-server --no-fail-fast
cargo test -p bibcode-desktop --no-fail-fast
cargo clippy -p bibcode-server --all-targets -- -D warnings
cargo clippy -p bibcode-desktop --all-targets -- -D warnings
```

- [x] **Step 3: Run Docker remote-server integration**

Build separate Linux server and client containers. Exercise descriptor
negotiation, hosted-confirmation-independent server pairing, E2EE pairing and
returning auth, RPC, share-state, revocation, update status/check/manual-install
failure, pre-auth overflow, record-count failure, and cleanup. Remove containers,
volumes, images created for the test, and the dedicated network afterward.

- [x] **Step 4: Review repository state and commit documentation/evidence**

Run:

```bash
git diff --check
git diff --stat
git status --short
```

Confirm the two staged deletions and untracked adversarial review remain exactly
as received. Commit: `docs(remote): record adversarial remediation validation`

## Self-review

- Spec coverage: all four approved subprojects map to Tasks 1–14.
- Intentional non-change: exact-size two-pass outbound serialization remains for
  pre-allocation memory safety; Task 7 documents and tests the retained bound.
- Intentional non-change: WSL receives truthful external-management semantics,
  not an unreviewed privileged firewall owner.
- No task rewrites pushed implementation history or user-owned plan deletions.
- Public property names are consistent: `configuredMode`, `management`, and the
  four cleanup outcomes are introduced once and consumed afterward.
