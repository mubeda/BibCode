# Remote Server Remediation Round 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the accepted second-round remote-server transport, pairing, exposure, persistence, and lifecycle findings without changing pairing-code v1 or the Noise NK wire format.

**Architecture:** The server gains reusable weighted byte admission and durable pending-pairing sessions; the desktop consolidates fail-closed exposure/firewall convergence; shared/client/web layers normalize trust inputs and make persistence and supervisor intent explicit. Public contracts remain additive and schema-only, while living docs and native runbooks change with the behavior they describe.

**Tech Stack:** Rust/Axum/Tokio/Rusqlite, TypeScript/Effect/Schema, React/Vitest, Tauri 2, Noise NK via `snow` and `@noble/*`, Docker integration.

**Spec:** `docs/superpowers/specs/2026-08-29-remote-server-remediation-round-2-design.md`

## Global Constraints

- Preserve the two staged deletions under `docs/plans/2026-08-24-environment-project-management/` and both untracked adversarial-review documents byte-for-byte.
- Do not edit `.codegraph/`, `.repos/`, or introduce a production Node runtime, native sidecar, Electron host, or TypeScript server.
- `packages/contracts` stays schema-only; every new RPC has a Rust method mirror, parity fixture, wire entry, and exactly one authorization scope.
- Pairing-code version 1, Noise `Noise_NK_25519_ChaChaPoly_SHA256`, 65,535-byte ciphertext records, 64 KiB pre-auth messages, 64 MiB authenticated logical messages, 2,048 records, empty handshake payloads, and close 4403 identity semantics remain unchanged.
- Privileged topology/firewall/settings work crosses `DesktopBridge`; browser and desktop application traffic uses typed HTTP/WebSocket RPC.
- Fresh desktop processes start the actual backend local-only; only authoritative live share state can justify widening.
- Follow red-green-refactor for every behavior change. A test must fail for the intended missing behavior before production code changes.
- Commit only task-owned paths with subjects matching their executable contents. Never absorb the protected staged deletions into a task commit.

---

### Task 1: Reusable weighted byte admission and bounded outbound progress

**Files:**
- Modify: `apps/server/src/rpc/session.rs`
- Modify: `apps/server/src/rpc/e2ee.rs`
- Test: inline `#[cfg(test)]` modules in both files

**Interfaces:**
- Produces: `pub(crate) struct WeightedByteBudget`, `WeightedByteBudget::new(capacity)`, and `WeightedByteBudget::acquire(bytes, deadline)` returning an owned RAII grant.
- Produces: `send_established_encrypted_message` with per-record five-second progress timeout plus `5 seconds + ceil(plaintext_bytes / 65_536)` aggregate seconds.
- Consumes later: Task 2 uses `WeightedByteBudget` for global and principal inbound capacity.

- [x] **Step 1: Write failing allocator and connection-tier tests**

Add tests that name the production breaks:

```rust
#[tokio::test(start_paused = true)]
async fn fit_first_budget_does_not_block_small_waiters_behind_an_aged_large_waiter() {
    // Hold all but a small slice, queue a near-capacity request, advance >1 s,
    // then prove a fitting small request receives the released slice.
}

#[tokio::test(start_paused = true)]
async fn outbound_connection_wait_uses_the_same_absolute_deadline_as_process_wait() {
    // Exhaust the connection tier and prove acquire returns None at five seconds.
}

#[tokio::test(start_paused = true)]
async fn cancelled_weighted_waiter_is_removed_and_capacity_is_refunded_once() {
    // Abort a queued acquire, release capacity, and prove the next waiter succeeds.
}
```

The first test must fail against the aged-head reservation behavior; the second must hang or outlive the deadline against the current connection semaphore.

- [x] **Step 2: Verify the allocator tests are red**

Run:

```bash
cargo test -p bibcode-server --lib fit_first_budget_does_not_block_small_waiters_behind_an_aged_large_waiter -- --nocapture
cargo test -p bibcode-server --lib outbound_connection_wait_uses_the_same_absolute_deadline_as_process_wait -- --nocapture
cargo test -p bibcode-server --lib cancelled_weighted_waiter_is_removed_and_capacity_is_refunded_once -- --nocapture
```

Expected: each new test fails for the named scheduling/deadline behavior, not a fixture or compilation typo.

- [x] **Step 3: Generalize the process allocator and replace the connection semaphore**

Extract the existing process waiter state into one implementation with this semantic shape:

```rust
pub(crate) struct WeightedByteBudget {
    capacity: usize,
    state: tokio::sync::Mutex<WeightedByteBudgetState>,
}

impl WeightedByteBudget {
    pub(crate) async fn acquire(
        self: &Arc<Self>,
        bytes: usize,
        deadline: tokio::time::Instant,
    ) -> Option<WeightedByteGrant>;
}
```

Grant the first request that fits during each queue scan, continue scanning for other fitting requests, remove the aged-head total-blockade branch, preserve cancellation-safe waiter removal, and keep exact-once refunds. Give every `RpcOutboundBudget` connection its own `Arc<WeightedByteBudget>` and use the caller's existing absolute deadline for connection then process acquisition.

- [x] **Step 4: Write failing encrypted-write progress tests**

Replace the current test that pins one flat logical deadline with controlled-sink tests:

```rust
#[tokio::test(start_paused = true)]
async fn outbound_logical_message_accepts_progress_across_record_deadlines() {
    // Complete each record before its five-second stall deadline while total
    // elapsed time exceeds five seconds; the full message must succeed.
}

#[tokio::test(start_paused = true)]
async fn outbound_logical_message_rejects_a_stalled_record() {
    // Keep one writer.send future pending, advance five seconds, and assert
    // the encrypted send returns the established timeout error.
}

#[tokio::test(start_paused = true)]
async fn outbound_logical_message_enforces_the_size_derived_total_deadline() {
    // Keep individual writes moving but advance past base + ceil(len / 64 KiB).
}
```

- [x] **Step 5: Implement progress and aggregate deadlines**

Compute the aggregate deadline from plaintext length with checked/saturating duration arithmetic. Wrap each `writer.send` in a fresh five-second `timeout`; also fail when the aggregate deadline expires. Do not reset the Noise nonce, pre-encrypt the whole message, or interleave logical messages.

- [x] **Step 6: Verify and commit Task 1**

Run:

```bash
cargo test -p bibcode-server rpc::session::tests --lib
cargo test -p bibcode-server rpc::e2ee::tests --lib
cargo fmt --all --check
cargo clippy -p bibcode-server --all-targets -- -D warnings
```

Commit only `session.rs` and `e2ee.rs`:

```bash
git commit --only -m "fix(server): bound encrypted byte admission progress" -- apps/server/src/rpc/session.rs apps/server/src/rpc/e2ee.rs
```

---

### Task 2: Inbound backpressure, pre-auth partitioning, WebSocket caps, and RAII connection accounting

**Files:**
- Modify: `apps/server/src/rpc/e2ee.rs`
- Modify: `apps/server/src/http.rs`
- Modify: `apps/server/src/auth/service.rs`
- Test: `apps/server/tests/e2ee_ws.rs`
- Test: `apps/server/tests/auth_http.rs`
- Test: inline server unit tests

**Interfaces:**
- Consumes: `WeightedByteBudget` from Task 1.
- Produces: global/principal inbound waits that return only on capacity, cancellation, or session shutdown; per-connection oversize remains a protocol error.
- Produces: `PreauthNetworkKey` canonicalizing IPv4 `/24`, IPv6 `/64`, loopback-forwarder, and unspecified peers.
- Produces: an RAII authenticated connection guard used by both `/ws` and `/ws-e2ee`.

- [x] **Step 1: Write failing inbound pressure and assembly-progress tests**

Add real multi-connection tests proving:

```rust
#[tokio::test]
async fn principal_pressure_backpressures_a_second_connection_without_closing_it() {
    send_encrypted_continuations(
        &mut first_partial,
        &mut first_transport,
        E2EE_INBOUND_BUFFER_BUDGET_BYTES_PER_PRINCIPAL,
    ).await;
    send_encrypted(&mut second_socket, &mut second_transport, br#"{"_tag":"Ping"}"#).await;
    assert!(timeout(Duration::from_millis(100), second_socket.next()).await.is_err());
    first_partial.close(None).await.expect("release principal capacity");
    assert_get_config(&mut second_socket, &mut second_transport).await;
}

#[tokio::test(start_paused = true)]
async fn incomplete_authenticated_message_closes_after_ten_seconds_without_progress() {
    send_encrypted_continuations(&mut socket, &mut transport, 1).await;
    tokio::time::advance(Duration::from_secs(10)).await;
    let outcome = socket.next().await;
    assert!(matches!(outcome, None | Some(Ok(Message::Close(_))) | Some(Err(_))));
}

#[tokio::test(start_paused = true)]
async fn idle_authenticated_connection_has_no_reassembly_deadline() {
    tokio::time::advance(Duration::from_secs(60)).await;
    assert_get_config(&mut socket, &mut transport).await;
}

#[tokio::test]
async fn inbound_permits_release_after_dispatch_before_handler_completion() {
    // Block an authenticated handler after dispatch, then prove another
    // connection can acquire the released plaintext capacity.
}
```

The first fills one principal's budget with an incomplete message, sends a valid request on another socket, proves that socket remains open, releases the first socket, and then receives the valid response.

- [x] **Step 2: Verify red, then implement cancellable fit-first inbound budgets**

Run:

```bash
cargo test -p bibcode-server principal_pressure_backpressures_a_second_connection_without_closing_it -- --nocapture
cargo test -p bibcode-server incomplete_authenticated_message_closes_after_ten_seconds_without_progress -- --nocapture
cargo test -p bibcode-server idle_authenticated_connection_has_no_reassembly_deadline -- --nocapture
cargo test -p bibcode-server inbound_permits_release_after_dispatch_before_handler_completion -- --nocapture
```

Confirm each test fails for the intended capacity/timeout behavior. Replace the global semaphore and principal `try_acquire_many_owned` with `WeightedByteBudget`. Do not apply a five-second capacity timeout. Select capacity acquisition against session cancellation. Expose `E2eeChannel::has_incomplete_message()`; once it is true, carry one ten-second absolute progress deadline through receipt, decrypt, validation, and budget charging of the next record, and reset it only after the record is accepted. The existing assembler continues to enforce 64 MiB, 2,048 records, and empty-continuation rejection. Release message grants after authorization and dispatch, before a spawned request handler completes.

- [x] **Step 3: Write failing subnet and loopback-forwarder admission tests**

Add literal cases:

```rust
#[test]
fn preauth_network_keys_canonicalize_ipv4_24_and_ipv6_64() {
    // Assert 192.0.2.1 and 192.0.2.200 share a key while 192.0.3.1 does not;
    // assert 2001:db8:1::1 and 2001:db8:1::ffff share a key while 2001:db8:2::1 does not.
}

#[tokio::test]
async fn one_public_subnet_cannot_consume_more_than_half_the_global_pool() {
    // Admit sixteen distinct public peers in one prefix and assert the
    // seventeenth receives the bounded busy response.
}

#[tokio::test]
async fn loopback_forwarder_can_use_global_capacity_without_the_public_peer_cap() {
    // Admit at least five loopback-forwarded handshakes and prove they remain
    // subject to the global pool rather than the public exact-peer cap.
}

#[tokio::test]
async fn missing_connect_info_uses_the_strict_unspecified_bucket() {
    // Four unspecified peers are admitted; the fifth receives busy.
}

#[tokio::test]
async fn unrelated_public_networks_still_stop_at_the_global_cap() {
    // Thirty-two peers from unrelated prefixes are admitted; the thirty-third receives busy.
}

#[tokio::test(start_paused = true)]
async fn idle_preauth_peer_and_network_entries_are_pruned_without_exceeding_the_map_cap() {
    // Create and release enough unique peers/prefixes to reach the hard cap,
    // advance past the TTL, and prove both maps shrink before new admission.
}
```

- [x] **Step 4: Implement bounded peer and network registries**

First run:

```bash
cargo test -p bibcode-server preauth_network_keys_canonicalize_ipv4_24_and_ipv6_64 -- --nocapture
cargo test -p bibcode-server one_public_subnet_cannot_consume_more_than_half_the_global_pool -- --nocapture
cargo test -p bibcode-server loopback_forwarder_can_use_global_capacity_without_the_public_peer_cap -- --nocapture
cargo test -p bibcode-server missing_connect_info_uses_the_strict_unspecified_bucket -- --nocapture
cargo test -p bibcode-server unrelated_public_networks_still_stop_at_the_global_cap -- --nocapture
cargo test -p bibcode-server idle_preauth_peer_and_network_entries_are_pruned_without_exceeding_the_map_cap -- --nocapture
```

Confirm the new tests fail. Then track exact public peer and network-prefix counters in `E2eePreauthAdmission`. Public exact peers remain capped at four; public `/24` or `/64` prefixes cap at sixteen; loopback skips those two caps but remains under the global 32; unspecified uses the strict exact bucket. TTL prune and hard-cap both maps. A lease owns and releases all counters it acquired.

- [x] **Step 5: Write route-level cap and connection-accounting tests**

Add integration tests that fail if upgrade configuration is deleted:

```rust
#[tokio::test]
async fn plain_ws_rejects_a_single_frame_larger_than_16_mib() {
    // Authenticate against the real route, send one 16 MiB + 1 byte frame,
    // and assert a bounded close/terminal result.
}

#[tokio::test]
async fn e2ee_ws_upgrade_rejects_ciphertext_larger_than_65_535_bytes() {
    // Complete Noise authentication, send one 65,536-byte ciphertext frame,
    // and assert the WebSocket layer terminates it.
}

#[tokio::test]
async fn authenticated_connection_count_is_released_when_the_session_task_aborts() {
    // Abort real plain and encrypted session tasks after mark_connected, then
    // assert both sessions report disconnected exactly once.
}
```

Assert a bounded close/terminal result, not only that a helper returned. Keep the E2EE protocol oversize tests separate.

- [x] **Step 6: Restore the plain frame cap and add the RAII guard**

Configure plain routes with `.max_frame_size(16 * 1024 * 1024)` and `.max_message_size(64 * 1024 * 1024)`. Keep E2EE upgrade caps at 65,535. Move post-`mark_connected` cleanup into a guard whose drop path owns exactly one `mark_disconnected` call; normal completion explicitly closes the guard, and cancellation/panic cannot leak it.

- [x] **Step 7: Verify and commit Task 2**

Run:

```bash
cargo test -p bibcode-server --test e2ee_ws --no-fail-fast
cargo test -p bibcode-server --test auth_http --no-fail-fast
cargo test -p bibcode-server rpc::e2ee::tests --lib
cargo fmt --all --check
cargo clippy -p bibcode-server --all-targets -- -D warnings
```

Commit the task-owned server paths with `fix(server): harden websocket admission and cleanup`.

---

### Task 3: Durable pending-pairing confirmation

**Files:**
- Modify: `apps/server/src/persistence/migrations.rs`
- Modify: `apps/server/src/persistence/repositories.rs`
- Modify: `apps/server/src/auth/model.rs`
- Modify: `apps/server/src/auth/service.rs`
- Modify: `apps/server/src/auth/rpc.rs`
- Modify: `apps/server/src/auth/scope.rs`
- Modify: `apps/server/src/rpc/e2ee.rs`
- Modify: `apps/server/src/rpc/session.rs`
- Modify: `apps/server/src/rpc/methods.rs`
- Modify: `packages/contracts/src/rpc.ts`
- Modify: `packages/contracts/scripts/export-rust-rpc-fixtures.ts`
- Modify: `packages/contracts/scripts/export-rust-rpc-fixtures.test.ts`
- Modify: `packages/contracts/fixtures/rpc-wire/manifest.json` and generated fixture files changed by the exporter
- Modify: `packages/client-runtime/src/connection/pairingAdd.ts`
- Test: `apps/server/tests/repositories.rs`
- Test: inline migration tests in `apps/server/src/persistence/migrations.rs`
- Test: `apps/server/tests/e2ee_ws.rs`
- Test: `apps/server/tests/rpc_wire.rs`
- Test: `packages/contracts/src/rpc.test.ts`
- Test: `packages/contracts/src/rpcRustParity.test.ts`
- Test: `packages/client-runtime/src/connection/pairingAdd.test.ts`
- Test: `packages/client-runtime/src/e2ee/serverInterop.test.ts`

**Interfaces:**
- Produces: migration 49 `AuthPairingDeliveryState` with `delivery_state TEXT NOT NULL DEFAULT 'active'` and allowed values `active|pending-pairing`.
- Produces: `WS_METHODS.authConfirmPairing = "auth.confirmPairing"`, empty payload/success, scope `access:write`.
- Produces: repository operations to create pending pairing sessions, confirm the current pending session idempotently, and revoke pending sessions at startup.
- Produces: a cloneable confirmation latch in `RpcSessionContext`; only the E2EE-minted session receives it, and the delivery guard observes it on every exit.

- [x] **Step 1: Write failing migration and repository tests**

Tests must prove existing rows read as active, a new pending row round-trips, confirmation changes only the named session, repeated same-session confirmation succeeds, expiry/pruning treats pending rows like active rows, and startup cleanup revokes every still-pending row while preserving active rows.

Run:

```bash
cargo test -p bibcode-server migration_49_adds_active_pairing_delivery_state -- --nocapture
cargo test -p bibcode-server pending_auth_session -- --nocapture
```

Confirm they fail because migration 49 and the repository methods do not exist.

- [x] **Step 2: Add migration 49 and delivery-state repository APIs**

Use an additive guarded migration:

```sql
ALTER TABLE auth_sessions
ADD COLUMN delivery_state TEXT NOT NULL DEFAULT 'active';
```

Validate allowed values at the Rust decode/write boundary because SQLite cannot add a table constraint safely with this additive migration. Extend `AUTH_SESSION_SELECT`, `NewAuthSession`, and `AuthSession`. Add these transactional repository methods:

```rust
confirm_pending_auth_session(session_id, now) -> Result<bool>
revoke_pending_auth_sessions(now) -> Result<Vec<String>>
```

Every changed row bumps the authoritative access revision through the existing transaction helper.

- [x] **Step 3: Write failing RPC contract, scope, parity, and wire tests**

Add literal expectations for `auth.confirmPairing`, its empty input/output schema, active-method inventory, Rust mirror, and exactly `access:write`. Increment the exporter/test's literal active-method count and regenerate `fixtures/rpc-wire/manifest.json` only after the contract is intentionally extended. Run `vp run check:contracts` and verify it is red before adding production registration.

- [x] **Step 4: Implement the typed confirmation RPC**

Register one mutation-unary handler. It obtains the current session ID from `RpcSessionContext`; no request field names another session. Pending-to-active and already-active current sessions return success. After the repository transaction commits, it marks the context's confirmation latch. Missing/revoked/wrong-session state returns the repository's established authorization error shape.

- [x] **Step 5: Write failing E2EE delivery lifecycle tests**

Cover:

```rust
#[tokio::test]
async fn delivered_pairing_session_stays_pending_until_confirm_rpc() {
    // Consume an off-host offer, verify share state remains wide, call the
    // confirmation RPC, and assert the row becomes active.
}

#[tokio::test]
async fn closing_before_confirm_revokes_the_pending_session() {
    // Close the bootstrap socket and assert the pending bearer is revoked and
    // rejected by a reconnect attempt.
}

#[tokio::test]
async fn confirmed_pairing_session_survives_disconnect_and_restart_cleanup() {
    // Confirm, disconnect, run startup pending-session cleanup, and reconnect
    // with the active bearer.
}
```

- [x] **Step 6: Keep the delivery guard armed through confirmation**

Mint pairing sessions with `pending-pairing`. Move the still-armed delivery guard and its latch from handshake admission into the established session; do not commit it merely because the encrypted credential reply was written. Share the latch with `RpcSessionContext` and disarm only after the repository confirmation transaction commits. Guard compensation calls a compare-and-revoke-pending repository operation, so a cancellation racing the post-commit latch update cannot revoke an active session. Auth service initialization revokes pending sessions before it publishes share state. Normal bearer sessions continue to be created active.

- [x] **Step 7: Write failing client rollback/confirmation tests**

In `pairingAdd.test.ts`, assert order and compensation:

```typescript
expect(events).toEqual(["verify", "register", "accept-identity", "confirm"]);
```

Registration, identity, or confirm failure must close the bootstrap session; local registration/identity is rolled back when it was written. Confirmation failure returns `local-persistence-failed` with actual cleanup details, not a manual server-revocation instruction.

- [x] **Step 8: Move persistence inside the bootstrap scope and confirm**

Keep `RpcSession` alive through registration and identity persistence. Call `session.client[WS_METHODS.authConfirmPairing]({})` after both durable local writes. On any later error, perform local rollback before leaving the scope; scope closure lets the server revoke the pending session.

- [x] **Step 9: Verify interop and commit Task 3**

Run:

```bash
vp run check:contracts
vp test packages/contracts/src/rpc.test.ts packages/contracts/src/rpcRustParity.test.ts packages/client-runtime/src/connection/pairingAdd.test.ts
cargo test -p bibcode-server --test repositories --no-fail-fast
cargo test -p bibcode-server --test e2ee_ws --no-fail-fast
cargo test -p bibcode-server --test rpc_wire --no-fail-fast
cargo build -p bibcode-server
BIBCODE_E2EE_SERVER_BIN="$(git rev-parse --show-toplevel)/target/debug/bibcode" vp test packages/client-runtime/src/e2ee/serverInterop.test.ts
cargo fmt --all --check
cargo clippy -p bibcode-server --all-targets -- -D warnings
```

Commit all contract, migration, server (including `rpc/session.rs`), client-runtime, parity, and interop paths together as `fix(remote): confirm durable pairing delivery`.

---

### Task 4: Normalize pairing targets and saved bearer security state

**Files:**
- Modify: `packages/shared/src/remote.ts`
- Modify: `packages/shared/src/remote.test.ts`
- Modify: `apps/web/src/hostedPairing.ts`
- Modify: `apps/web/src/hostedPairing.test.ts`
- Modify: `apps/web/src/components/auth/PairingRouteSurface.tsx`
- Modify: `apps/web/src/components/auth/PairingRouteSurface.test.tsx`
- Modify: `apps/web/src/routes/pair.tsx`
- Modify: `apps/web/src/routes/pair.test.tsx`
- Modify: `apps/web/src/routes/settings.remote-servers.tsx`
- Modify: `apps/web/src/routes/settings.remote-servers.test.tsx`
- Modify: `apps/web/src/components/settings/remote-servers/shared.tsx`
- Modify: `apps/web/src/components/settings/remote-servers/ConnectTab.tsx`
- Modify: `packages/client-runtime/src/connection/catalog.ts`
- Modify: `packages/client-runtime/src/platform/storageDocument.test.ts`
- Modify: `packages/client-runtime/src/authorization/layer.test.ts`
- Modify: `packages/client-runtime/src/connection/presentation.test.ts`
- Modify: `apps/web/src/components/settings/remote-servers/ConnectTab.test.tsx`

**Interfaces:**
- Produces: normalized hosted request `{ httpBaseUrl, displayHost, token, label }` with `displayHost` derived from `new URL(httpBaseUrl).host`.
- Produces: bearer-profile decode normalization mapping null/missing/blank `hostKey` to `null`.

- [x] **Step 1: Write failing URL trust tests**

Use literal cases for `https://trusted.example@attacker.example:8080`, `https://user:password@example.test`, and Cyrillic `https://аpple.com`. Assert userinfo is rejected and IDN display is `xn--pple-43d.com`. Pairing-route tests must prove the rendered host and submitted `httpBaseUrl` come from the same normalized request.

- [x] **Step 2: Reject userinfo and normalize before rendering**

After parsing the URL, reject when `url.username !== "" || url.password !== ""`. The `packages/shared` parser returns null for invalid targets; valid targets carry one normalized base URL and `URL.host`. Replace the duplicate parser in `apps/web/src/hostedPairing.ts` with the shared owner, and delete raw-host rendering/submission paths.

- [x] **Step 3: Write and implement query credential scrubbing tests**

For both `/pair` and `/settings/remote-servers`, read legacy `?code=` once, then assert the route issues an immediate `replace: true` navigation whose search excludes `code` and preserves unrelated safe parameters. The captured code remains available to the one auto-submit/add attempt after replacement. Hosted-browser tokens remain accepted from the fragment, and `stripPairingTokenFromUrl` removes any legacy query `token` without deleting `host`, `label`, `tab`, or `action`.

- [x] **Step 4: Write failing blank-host-key persistence tests**

Decode stored profiles containing missing, null, `""`, and `" \t "`; each expected `hostKey` is null. Decode a valid non-empty key unchanged. Resolve authorization for a blank legacy record and assert `/ws`, non-null plain HTTP authorization, and the unencrypted presentation badge.

- [x] **Step 5: Normalize once at the catalog schema boundary**

Use an Effect Schema transform/refinement owned by `packages/client-runtime` so all consumers receive `string | null` with blanks already mapped to null. Simplify authorization/presentation checks to consume this invariant without a second policy implementation.

- [x] **Step 6: Replace the Connect-tab full policy mock**

Use `vi.importActual`/`importOriginal` to preserve `connectionTransportSecurity` and override only the stateful exports required by the component harness. Delete the copied switch and add a case whose fake implementation previously diverged.

- [x] **Step 7: Verify and commit Task 4**

Run:

```bash
vp test packages/shared/src/remote.test.ts apps/web/src/hostedPairing.test.ts apps/web/src/components/auth/PairingRouteSurface.test.tsx apps/web/src/routes/pair.test.tsx apps/web/src/routes/settings.remote-servers.test.tsx
vp test packages/client-runtime/src/platform/storageDocument.test.ts packages/client-runtime/src/authorization/layer.test.ts packages/client-runtime/src/connection/presentation.test.ts
vp test apps/web/src/components/settings/remote-servers/ConnectTab.test.tsx apps/web/src/components/settings/remote-servers/RemoteServersSettings.test.tsx
vp run typecheck
```

Commit the listed Task 4 files as `fix(remote): normalize pairing trust inputs`.

---

### Task 5: Fail-closed IPv4 endpoint discovery and classification

**Files:**
- Create: `packages/shared/fixtures/advertised-endpoint-classification.json`
- Modify: `packages/shared/src/advertisedEndpoint.ts`
- Modify: `packages/shared/src/advertisedEndpoint.test.ts`
- Modify: `apps/desktop/src-tauri/src/network_interfaces.rs`
- Modify: `apps/desktop/src-tauri/src/backend.rs`
- Modify: `apps/desktop/src-tauri/src/bridge.rs`
- Modify: `apps/web/src/components/settings/remote-servers/shared.tsx`
- Modify: `apps/web/src/components/settings/remote-servers/ShareTab.test.tsx`
- Modify: `apps/web/src/components/settings/remote-servers/ShareThisHostTab.test.tsx`

**Interfaces:**
- Produces: one Rust `classify_advertised_address(IpAddr)` returning reachability, label kind, and default eligibility.
- Produces: desktop endpoints only for IPv4 addresses accepted by `is_usable_unicast`.

- [x] **Step 1: Add the literal cross-language classification fixture and red tests**

Fixture cases include `127.0.0.1`, `169.254.1.1`, `192.168.1.20`, `100.100.100.100`, `8.8.8.8`, `::1`, `fe80::1`, `fd7a:115c:a1e0::1`, and `2001:4860:4860::8888`. Each row has literal `pairingClassification`, `advertisedReachability`, `usable`, and `advertiseWithIpv4Listener` values. TypeScript tests consume pairing fields; Rust tests deserialize and assert desktop fields.

- [x] **Step 2: Restore default-route usability and centralize Rust classification**

Make `is_usable_unicast` available to `backend.rs`. `resolve_lan_advertised_host` accepts only usable IPv4. Interface enumeration and Tailscale-derived endpoint construction both suppress IPv6 for the current IPv4-only listener. `bridge.rs` uses the classifier result instead of branch order over `is_cgnat_or_tailscale` and `is_private_network`.

- [x] **Step 3: Write failing presentation/default tests**

Prove RFC1918 default route is labeled `Local network` and selected by default; CGNAT is `Private network`; public is `Public address`, `reachability: public`, and `isDefault: false`; IPv6 produces no available endpoint. If public is the only off-host option, endpoint selection returns null until explicit user selection.

- [x] **Step 4: Implement safe labels and explicit public selection**

Only usable private/CGNAT IPv4 candidates may be defaults. Add public warning description and preserve Linux/macOS unmanaged-firewall copy. Remove the stale fallback that labels an arbitrary persisted public endpoint `Local network`.

- [x] **Step 5: Verify and commit Task 5**

Run:

```bash
vp test packages/shared/src/advertisedEndpoint.test.ts apps/web/src/components/settings/remote-servers/ShareTab.test.tsx apps/web/src/components/settings/remote-servers/ShareThisHostTab.test.tsx
cargo test -p bibcode-desktop network_interfaces --lib
cargo test -p bibcode-desktop backend --lib
cargo test -p bibcode-desktop bridge --lib
cargo fmt --all --check
cargo clippy -p bibcode-desktop --all-targets -- -D warnings
vp run typecheck
```

Commit the listed Task 5 files as `fix(remote): fail closed on advertised endpoints`.

---

### Task 6: Desktop exposure, WSL, reconciliation, and firewall convergence

**Files:**
- Modify: `apps/desktop/src-tauri/src/server_exposure.rs`
- Modify: `apps/desktop/src-tauri/src/bridge.rs`
- Modify: `apps/desktop/src-tauri/src/firewall.rs`
- Modify: `apps/web/src/state/shareExposureReconciler.ts`
- Modify: `apps/web/src/state/shareExposureReconciler.test.tsx`
- Modify: `apps/web/src/components/settings/remote-servers/shareOffer.ts`
- Modify: `apps/web/src/components/settings/remote-servers/shareOffer.test.ts`
- Modify: `apps/web/src/components/settings/remote-servers/ShareThisHostTab.tsx`
- Test: inline tests in `apps/desktop/src-tauri/src/server_exposure.rs`
- Test: inline tests in `apps/desktop/src-tauri/src/bridge.rs`
- Test: inline tests in `apps/desktop/src-tauri/src/firewall.rs`

**Interfaces:**
- Produces: one internal local-recovery routine used by narrowing and failed widening.
- Produces: a serialized firewall worker whose caller deadline includes spawn and whose timed-out job is followed by verified deletion.
- Produces: `reconcileShareExposureOnce` compensation that is not gated by component mount after a committed narrow.

- [x] **Step 1: Write failing shared-recovery and WSL transition tests**

Injected side-effect tests must assert the exact attempted order even when each prior step fails:

```text
persist local-only -> restart/recover local -> firewall disable -> verify local
```

Entering WSL-only from wide must close the firewall, persist local-only, and never restart native wide. Leaving WSL-only must start local-only.

- [x] **Step 2: Extract one recovery routine and route WSL through the coordinator**

Return a combined error containing the initiating error plus every failed safeguard. Do not use `?` inside the safeguard sequence. Keep the existing coordinator mutex across settings, topology, verification, and firewall synchronization.

- [x] **Step 3: Write failing late-spawn firewall tests**

With an injected worker/runner, hold spawn past the five-second caller deadline, then release it as a successful rule add. Assert the caller already received failure/local-only, the worker next executes delete-and-verify, and no later enable overtakes that cleanup. Add normal idempotent enable/disable and failed-delete verification cases.

- [x] **Step 4: Implement serialized job ownership and compensating deletion**

The worker, not the timed caller future, owns the spawn task and child. Caller timeout enqueues cleanup behind the outstanding job. The worker publishes completion for diagnostics but never detaches a child that could mutate firewall state after ownership is lost.

- [x] **Step 5: Write failing unmount and ambiguous-cancel reconciliation tests**

Prove unmount after a committed narrow cannot suppress a compensating widen when re-fetched state is wide. Prove cancellation retries are bounded and narrowing happens only after authoritative share state returns loopback; unknown/wide state remains wide with honest copy. Preserve the existing pending cancellation tombstone and five-minute offer expiry as later convergence. Bridge calls time out visibly.

- [x] **Step 6: Separate start gating from mandatory compensation**

Check mount/generation before the first native apply. Once narrow succeeds, always complete the re-fetch and at most one re-widen using the captured bridge. Add bounded cancellation retry followed by authoritative reconciliation; never narrow solely because cancellation threw.

- [x] **Step 7: Verify and commit Task 6**

Run:

```bash
vp test apps/web/src/state/shareExposureReconciler.test.tsx apps/web/src/components/settings/remote-servers/shareOffer.test.ts apps/web/src/components/settings/remote-servers/ShareThisHostTab.test.tsx
cargo test -p bibcode-desktop server_exposure --lib
cargo test -p bibcode-desktop firewall --lib
cargo test -p bibcode-desktop bridge --lib
cargo fmt --all --check
cargo clippy -p bibcode-desktop --all-targets -- -D warnings
vp run typecheck
```

Commit the listed Task 6 files as `fix(remote): converge exposure and firewall state`.

---

### Task 7: IndexedDB recovery lifecycle and destructive confirmation

**Files:**
- Modify: `apps/web/src/connection/databaseHealth.ts`
- Modify: `apps/web/src/connection/databaseHealth.test.ts`
- Modify: `apps/web/src/components/ConnectionDatabaseRecoveryDialog.tsx`
- Modify: `apps/web/src/components/ConnectionDatabaseRecoveryDialog.test.tsx`

**Interfaces:**
- Produces: blocked-but-pending reset state; the reset promise settles only on delete success/error.
- Produces: explicit checkbox confirmation plus always-available Reload.

- [x] **Step 1: Write failing queued-delete lifecycle tests**

Use a real-shaped `IDBOpenDBRequest` fake. Fire `blocked`, assert the reset promise remains unsettled and health is blocked; then fire `success`, assert health becomes ready, reset resolves, and the injected reload boundary runs once. Fire `error` after blocked and assert rejection/unavailable without reload. The production change that must break the test is settling in `onblocked`.

- [x] **Step 2: Keep ownership until terminal request events**

Remove the `settled` branch from `onblocked`. Publish blocked status and leave handlers attached. Only `onsuccess` or `onerror` settles. The dialog remains busy while pending and explains that the browser queued deletion until other connections close.

- [x] **Step 3: Write failing non-destructive and double-click tests**

Assert Reload renders in the incompatible branch. Dispatch two click events on `Reset saved connection data`; deletion must not run. Check the explicit acknowledgement checkbox, then click the separately rendered destructive confirmation once; deletion runs exactly once.

- [x] **Step 4: Replace button swapping with checkbox confirmation**

Keep Reload enabled when not actively reloading. Disable destructive confirmation until checked and while reset is pending. Do not render the confirmation button at the same pointer location as the initial action.

- [x] **Step 5: Verify and commit Task 7**

Run:

```bash
vp test apps/web/src/connection/databaseHealth.test.ts apps/web/src/components/ConnectionDatabaseRecoveryDialog.test.tsx
vp run typecheck
```

Commit the listed Task 7 files as `fix(web): make connection database reset explicit`.

---

### Task 8: Preserve supervisor intent and bound complete update operations

**Files:**
- Modify: `packages/client-runtime/src/connection/registry.ts`
- Modify: `packages/client-runtime/src/connection/registry.test.ts`
- Modify: `packages/client-runtime/src/state/runtime.ts`
- Modify: `packages/client-runtime/src/state/remoteUpdates.ts`
- Modify: `packages/client-runtime/src/state/remoteUpdates.test.ts`

**Interfaces:**
- Produces: registry-owned desired-state map independent of disposable supervisor scopes.
- Produces: a command execution seam whose timeout encloses acquisition, readiness, and RPC.

- [x] **Step 1: Write failing desired-state lifecycle tests**

Cover explicit disconnect followed by catalog profile drift: the recreated supervisor remains `desired: false` and does not dial. A passive `state` lookup must not change desired intent. New saved registration and registry bootstrap establish `desired: true` explicitly. Removal clears the stored intent.

- [x] **Step 2: Move desired ownership above service scopes**

Add a registry map/ref keyed by `EnvironmentId`. `connect`/`disconnect` update it before acting. `createServiceScope` receives the stored boolean and calls `supervisor.connect` only when true. Catalog drift carries the same value. Read-only state access never writes it.

- [x] **Step 3: Write failing whole-update deadline tests**

Hold `acquireSupervisor` beyond 30 seconds with paused time and assert the update check returns timeout without invoking RPC. Repeat with fast acquisition and a stalled RPC. In fan-out, a timed-out environment releases its worker slot so the next environment starts.

- [x] **Step 4: Move timeout outside acquisition and RPC**

Add `readonly timeoutMs?: number` to `EnvironmentAtomOptions`. In
`createEnvironmentCommand`, build the lazy `runInEnvironment` effect first
and, when `timeoutMs` is present, apply `Effect.timeout(timeoutMs)` to that whole
effect before passing it to `createRuntimeCommand`. Configure the remote update
check with `timeoutMs: 30_000` and make its `execute` return the raw
`request(WS_METHODS.updaterCheck, input)`. Delete the request-only timeout helper
so acquisition and RPC share one clock.

- [x] **Step 5: Verify and commit Task 8**

Run:

```bash
vp test packages/client-runtime/src/connection/registry.test.ts packages/client-runtime/src/state/runtime.test.ts packages/client-runtime/src/state/remoteUpdates.test.ts
vp run typecheck
```

Commit the listed Task 8 files as `fix(client-runtime): preserve remote connection intent`.

---

### Task 9: Living documentation, historical pointer, validation, and Docker evidence

**Files:**
- Modify: `docs/architecture/remote.md`
- Modify: `docs/architecture/overview.md`
- Modify: `docs/plans/remote-servers/remote-servers-spec.md` only to add a dated supersession pointer
- Modify: `docs/testing/connection-runtime.md`
- Modify: `docs/testing/cross-platform-validation.md`
- Modify: `docs/testing/linux-desktop.md`
- Modify: `docs/testing/macos-desktop.md`
- Modify: `docs/testing/windows-desktop.md`
- Modify: `packages/client-runtime/src/e2ee/dockerRemoteSmoke.test.ts`
- Create: `docs/testing/reports/2026-08-29-remote-server-remediation-round-2.md`

**Interfaces:**
- Consumes: all behavior and commands from Tasks 1-8.
- Produces: current living architecture, repeatable validation instructions, tested executable SHA, and cross-container evidence.

- [x] **Step 1: Update living architecture and the historical pointer**

Document fit-first admission without aged blockade, five-second record progress plus size-derived aggregate deadline, inbound capacity waiting and ten-second incomplete-message progress, subnet/loopback admission, pending-pairing confirmation, normalized hosted target, IPv4-only advertisement, public-address confirmation, exposure/firewall convergence, IndexedDB pending deletion, supervisor intent, whole-update deadlines, and 16 MiB plain frame cap. State that inbound permits end at dispatch, not request completion.

At the top of the historical spec add only a dated note linking this approved design and `docs/architecture/remote.md`; do not rewrite its historical decisions.

- [x] **Step 2: Update affected native and connection-runtime runbooks**

Verify commands against manifests/source. Add route-cap, pending-pairing, Windows firewall late-spawn, endpoint family, database recovery, reconnect-intent, and whole-update deadline evidence where applicable. Keep platform-specific unavailable evidence explicit.

- [x] **Step 3: Extend Docker smoke with real boundaries**

The separate Debian server and Node client containers must cover pending pairing before/after confirmation, authenticated reconnect, subnet admission fixture or exposed helper behavior, maximum-record progress without a flat five-second message failure, route cap close, revocation/final loopback state, updater timeout/result isolation where container-controllable, and cleanup. Do not log credentials.

- [x] **Step 4: Verify and commit the extended Docker smoke before validation**

Run the exact `Cross-container remote-server gate` shell block from `docs/testing/cross-platform-validation.md`. Confirm the client test passes and all filtered container, network, and volume listings are empty. Then commit only the executable smoke-test change:

```bash
git commit --only -m "test(remote): extend remediation docker smoke" -- packages/client-runtime/src/e2ee/dockerRemoteSmoke.test.ts
```

- [x] **Step 5: Run focused and broad validation against executable HEAD**

Record `git rev-parse HEAD`, then run:

```bash
vp run check:contracts
vp run check:dependency-ledger
vp check . '!docs/plans/remote-servers/2026-08-29-adversarial-review.md' '!docs/plans/remote-servers/2026-08-29-remediation-adversarial-review.md'
vp run typecheck
vp test
cargo fmt --all --check
cargo test -p bibcode-server --no-fail-fast
cargo test -p bibcode-desktop --no-fail-fast
cargo clean -p bibcode-server -p bibcode-desktop
cargo clippy -p bibcode-server --all-targets -- -D warnings
cargo clippy -p bibcode-desktop --all-targets -- -D warnings
cargo build -p bibcode-server
BIBCODE_E2EE_SERVER_BIN="$(git rev-parse --show-toplevel)/target/debug/bibcode" vp test packages/client-runtime/src/e2ee/serverInterop.test.ts
```

Re-run the exact current cross-container block from `docs/testing/cross-platform-validation.md`, then verify filtered container, network, volume, and process listings are empty.

- [x] **Step 6: Write the execution report and commit documentation only**

The report names the exact executable tested SHA, dirty protected paths, every command/result/count, Docker runtime, cleanup evidence, unavailable Windows/macOS packaged validation, flakes with provenance, and residual distributed-DoS/platform risk. The final commit contains documentation/report paths only:

```bash
git commit --only -m "docs(remote): record second remediation validation" -- docs/architecture docs/plans/remote-servers/remote-servers-spec.md docs/testing
```

- [x] **Step 7: Final worktree and history audit**

Run `git diff --check`, `git status --short`, `git log --oneline 0e4767b5..HEAD`, and inspect every task commit's path list. Confirm no debug output, generated `.codegraph` data, dependency drift, `.repos` edits, protected-review edits, or staged-deletion commits.
