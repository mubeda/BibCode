# Durable Turn Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make accepted user turns, attachments, bootstrap work, and provider delivery restart-safe across Codex, OpenCode, Claude, and Cursor, with an honest user-visible uncertain state where exact reconciliation is impossible.

**Architecture:** Extend the existing SQLite orchestration transaction with a command digest, attachment references, and one provider-turn outbox row. A production-owned dispatcher performs bootstrap prerequisites and provider delivery after commit, preserving order per thread and using provider-specific reconciliation. Delivery state is projected onto the existing user-message record and rendered on that message.

**Tech Stack:** Rust, Tokio, rusqlite/SQLite, serde/serde_json, existing SHA-256 helper, Axum RPC runtime, React, TypeScript, Effect Schema, Vite+

## Global Constraints

- Support Codex, Claude, OpenCode, and Cursor.
- Do not claim global exactly-once delivery for Claude or Cursor.
- Ambiguous Claude/Cursor sends become durable `uncertain` rows and are never automatically resent.
- Keep attachment bytes on disk; do not store blobs in SQLite.
- Preserve the one-server-process-per-state-root model; do not add database leases.
- Add no dependency and no generic workflow, actor, scheduler, or outbox framework.
- Preserve strict per-thread ordering; use bounded concurrency only across different threads.
- Tasks 2–6 are one internal migration sequence. Do not release or run user-facing acceptance testing until Task 7 adds the resolution UI for every blocking state.
- Reuse `crate::crypto::sha256_hex`, existing SQLite transaction/projector helpers, existing Tokio semaphore patterns, and provider runtime structures.
- Do not add agent selection or provider selection to the composer toolbar.
- Do not edit `.repos/`.
- Do not bypass repository Git safety hooks. If a commit step is blocked, record the failure and leave the verified changes unstaged.
- Before completion, `vp test`, `vp check`, `vp run typecheck`, and `git diff --check` must pass.

## File Structure

### New files

- `apps/server/src/orchestration/delivery.rs` — canonical command digest, delivery state/value types, admission metadata, and transition inputs shared by engine and production runtime.
- `apps/server/src/production/turn_delivery.rs` — outbox dispatcher, retry timing, per-thread eligibility, bootstrap prerequisite execution, restart reconciliation, and shutdown.
- `apps/server/tests/turn_delivery_recovery.rs` — subprocess crash/restart boundary tests.
- `apps/web/src/components/chat/TurnDeliveryNotice.tsx` — message-scoped pending/failed/uncertain presentation and actions.
- `apps/web/src/components/chat/TurnDeliveryNotice.test.tsx` — delivery notice rendering and accessible action tests.

### Existing files with focused changes

- `apps/server/src/orchestration/mod.rs` — export shared delivery types.
- `apps/server/src/persistence/migrations.rs` — migration 39: digest, outbox, attachment refs, message delivery projection columns, and legacy reference backfill.
- `apps/server/src/persistence/repositories.rs` — receipt digest and outbox/reference row queries.
- `apps/server/src/orchestration/engine.rs` — one owned admission envelope, replay discrimination, atomic outbox/reference insert, delivery transitions, and composite bootstrap planning.
- `apps/server/src/provider/attachments.rs` — startup final-file reconciliation and deterministic test barriers.
- `apps/server/src/production/orchestration_rpc.rs` — preflight digest, prepared admission, and removal of direct turn routing.
- `apps/server/src/production/orchestration_effects.rs` — idempotent worktree/setup ensure behavior.
- `apps/server/src/git/repository.rs` — return an existing worktree for the requested ref instead of creating a suffixed duplicate during recovery.
- `apps/server/src/production/provider_runtime.rs` — delivery-specific supervisor request/outcome and provider adapter implementations.
- `apps/server/src/provider/codex/model.rs` — `clientUserMessageId` request field.
- `apps/server/src/provider/codex/runtime.rs` — Codex send/readback by delivery key.
- `apps/server/src/provider/opencode/runtime.rs` — OpenCode `messageID` send and exact lookup.
- `apps/server/src/provider/cursor/runtime.rs` — prompt completion receipt that distinguishes pre-write failure from post-write ambiguity.
- `apps/server/src/provider/claude/runtime.rs` — expose replayed user-message acknowledgement to the driver.
- `apps/server/src/production/runtime.rs` — startup attachment reconciliation, dispatcher lifecycle, and shutdown ordering.
- `packages/contracts/src/orchestration.ts` and `packages/contracts/src/orchestration.test.ts` — delivery schemas, events, and resolution command.
- `packages/client-runtime/src/operations/commands.ts` and `packages/client-runtime/src/state/threadCommands.ts` — typed retry/dismiss command.
- `apps/web/src/types.ts` — retain the optional delivery object on `ChatMessage`.
- `apps/web/src/components/chat/MessagesTimeline.tsx` and tests — render the notice under the affected user message.
- `apps/web/src/components/ChatView.tsx`, `apps/web/src/components/ChatView.hooks.test.tsx`, and `apps/web/src/components/ChatView.test.tsx` — invoke retry/dismiss through the existing thread command runtime.
- `apps/server/tests/production_provider_runtime.rs` and `apps/server/tests/workspace_rpc.rs` — provider and registered RPC integration coverage.

---

### Task 1: Persist Delivery Identity, State, and Projection Data

**Files:**
- Create: `apps/server/src/orchestration/delivery.rs`
- Modify: `apps/server/src/orchestration/mod.rs`
- Modify: `apps/server/src/persistence/migrations.rs:22-77,1487-1506,1508-1530`
- Modify: `apps/server/src/persistence/repositories.rs:105-129,275-317,685-704,747-758,908,978-990,1045-1058`
- Modify: `packages/contracts/src/orchestration.ts:277-292,636-758,844-875,960-985,1100-1135`
- Test: `packages/contracts/src/orchestration.test.ts`
- Test: migration/repository tests in the Rust files above

**Interfaces:**
- Produces: `canonical_command_digest<T: Serialize>(&T) -> Result<String, String>`.
- Produces: `TurnDeliveryState`, `NewProviderTurnDelivery`, `ProviderTurnDelivery`, `AttachmentReference`, `CommandAdmission`, and `TurnDeliveryTransition`.
- Produces: wire `TurnDelivery`, `TurnDeliveryResolutionAction`, and `thread.turn-delivery-updated` payload/event.
- Consumed by: every later delivery task.

- [ ] **Step 1: Add failing contract tests for delivery wire shapes**

Add tests that decode the exact message delivery object and resolution command:

```ts
const message = Schema.decodeUnknownSync(OrchestrationMessage)({
  id: "message-1",
  role: "user",
  text: "ship it",
  turnId: null,
  streaming: false,
  delivery: {
    state: "uncertain",
    provider: "claudeAgent",
    detail: "connection lost after write",
  },
  createdAt: "2026-08-01T00:00:00Z",
  updatedAt: "2026-08-01T00:00:01Z",
});
expect(message.delivery?.state).toBe("uncertain");

const command = Schema.decodeUnknownSync(OrchestrationCommand)({
  type: "thread.turn-delivery.resolve",
  commandId: "resolve-1",
  threadId: "thread-1",
  messageId: "message-1",
  action: "retry",
  createdAt: "2026-08-01T00:00:02Z",
});
expect(command.action).toBe("retry");
```

- [ ] **Step 2: Run the contract test and verify the new shapes fail**

Run: `vp test run packages/contracts/src/orchestration.test.ts`

Expected: FAIL because `delivery` and `thread.turn-delivery.resolve` are not defined.

- [ ] **Step 3: Add the exact contract types and event union member**

Define:

```ts
export const TurnDeliveryState = Schema.Literals([
  "pending",
  "sending",
  "delivered",
  "uncertain",
  "dismissed",
  "failed",
]);

export const TurnDelivery = Schema.Struct({
  state: TurnDeliveryState,
  provider: ProviderDriverKind,
  detail: Schema.optional(TrimmedNonEmptyString),
});

export const TurnDeliveryResolutionAction = Schema.Literals(["retry", "dismiss"]);
```

Add optional `delivery` to `OrchestrationMessage`, add `ThreadTurnDeliveryResolveCommand` to both server/client command unions, and add `ThreadTurnDeliveryUpdatedPayload` plus the `thread.turn-delivery-updated` event union member.

- [ ] **Step 4: Add failing migration tests for a fresh and upgraded database**

Extend `apps/server/src/persistence/migrations.rs` tests to assert migration 39 creates:

```rust
for table in ["provider_turn_outbox", "orchestration_attachment_refs"] {
    assert!(table_exists(&connection, table)?);
}
assert!(column_exists(&connection, "orchestration_command_receipts", "payload_digest")?);
for column in ["delivery_state", "delivery_provider", "delivery_detail"] {
    assert!(column_exists(&connection, "projection_thread_messages", column)?);
}
```

Seed a pre-39 accepted user event with one attachment and assert the migration inserts `(command_id, attachment_id, size_bytes)` while leaving `content_digest` null.

- [ ] **Step 5: Run the migration tests and verify migration 39 is missing**

Run: `node scripts/run-msvc-x64.mjs cargo test -p bibcode-server persistence::migrations::tests -- --nocapture`

Expected: FAIL because migration 39 and its schema are absent.

- [ ] **Step 6: Implement migration 39 and legacy reference backfill**

Append `Migration::new(39, "DurableProviderTurnDelivery", migration_039)` and implement the approved schema. Include `message_id` in `provider_turn_outbox`, the unique message index, and the three nullable projection columns.

Within the same migration transaction, query historical `thread.message-sent` events with non-null `command_id`, parse `payload_json`, and insert each user attachment with:

```rust
transaction.execute(
    "INSERT OR IGNORE INTO orchestration_attachment_refs \
     (command_id, attachment_id, content_digest, size_bytes) VALUES (?, ?, NULL, ?)",
    params![command_id, attachment_id, size_bytes],
)?;
```

Collect rows before inserting so the query statement is dropped before mutable transaction work continues.

- [ ] **Step 7: Add Rust delivery types and canonical digest tests**

Create `delivery.rs` with the exact states and admission records. Canonicalize every JSON object recursively into sorted key order, serialize once, and call `crate::crypto::sha256_hex`.

Use these storage/service types so every later task shares one vocabulary:

```rust
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum TurnDeliveryState {
    Pending,
    Sending,
    Delivered,
    Uncertain,
    Dismissed,
    Failed,
}

#[derive(Clone, Debug)]
pub struct AttachmentReference {
    pub attachment_id: String,
    pub content_digest: Option<String>,
    pub size_bytes: i64,
}

#[derive(Clone, Debug)]
pub struct NewProviderTurnDelivery {
    pub command_id: String,
    pub thread_id: String,
    pub message_id: String,
    pub provider_instance_id: String,
    pub provider_kind: String,
    pub provider_session_id: Option<String>,
    pub delivery_key: String,
    pub payload: Value,
    pub created_at: String,
}

#[derive(Clone, Debug)]
pub struct CommandAdmission {
    pub payload_digest: String,
    pub attachment_refs: Vec<AttachmentReference>,
    pub provider_turn: Option<NewProviderTurnDelivery>,
}

#[derive(Clone, Debug)]
pub struct ProviderTurnDelivery {
    pub command_id: String,
    pub thread_id: String,
    pub message_id: String,
    pub provider_instance_id: String,
    pub provider_kind: String,
    pub provider_session_id: Option<String>,
    pub delivery_key: String,
    pub payload: Value,
    pub state: TurnDeliveryState,
    pub attempts: i64,
    pub last_error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug)]
pub struct TurnDeliveryTransition {
    pub command_id: String,
    pub expected_states: Vec<TurnDeliveryState>,
    pub expected_attempt: i64,
    pub next_state: TurnDeliveryState,
    pub detail: Option<String>,
    pub updated_at: String,
}
```

Test that reordered object keys hash equally and changed attachment `dataUrl` hashes differently:

```rust
#[test]
fn canonical_digest_sorts_keys_and_binds_attachment_content() {
    let left = json!({"b":2,"a":{"y":2,"x":1}});
    let right = json!({"a":{"x":1,"y":2},"b":2});
    assert_eq!(canonical_command_digest(&left).unwrap(), canonical_command_digest(&right).unwrap());
    assert_ne!(
        canonical_command_digest(&json!({"dataUrl":"data:text/plain;base64,YQ=="})).unwrap(),
        canonical_command_digest(&json!({"dataUrl":"data:text/plain;base64,Yg=="})).unwrap(),
    );
}
```

- [ ] **Step 8: Extend repository rows and message projection decoding**

Add `payload_digest: Option<String>` to `CommandReceipt`. Add the outbox/reference structs and focused methods:

```rust
pub async fn get_provider_turn_delivery(&self, command_id: String) -> Result<Option<ProviderTurnDelivery>>;
pub async fn list_provider_turn_deliveries(&self, states: Vec<TurnDeliveryState>) -> Result<Vec<ProviderTurnDelivery>>;
pub async fn list_referenced_attachment_ids(&self) -> Result<Vec<String>>;
pub async fn claim_provider_turn(&self, command_id: String, updated_at: String) -> Result<Option<ProviderTurnDelivery>>;
```

Extend `ProjectionThreadMessage` and `MESSAGE_SELECT` with delivery fields. Serialize them as one optional `delivery` object through the existing snapshot path.

- [ ] **Step 9: Run focused storage and contract tests**

Run:

```powershell
vp test run packages/contracts/src/orchestration.test.ts
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server persistence::migrations::tests -- --nocapture
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server persistence::repositories -- --nocapture
```

Expected: PASS.

- [ ] **Step 10: Commit the storage contract**

```powershell
git add apps/server/src/orchestration/delivery.rs apps/server/src/orchestration/mod.rs apps/server/src/persistence/migrations.rs apps/server/src/persistence/repositories.rs packages/contracts/src/orchestration.ts packages/contracts/src/orchestration.test.ts
git commit -m "feat: persist provider turn delivery state"
```

If the safety hook blocks the commit, record it and do not bypass it.

---

### Task 2: Atomically Admit Turns and Dispatch the Outbox

**Files:**
- Create: `apps/server/src/production/turn_delivery.rs`
- Modify: `apps/server/src/production/mod.rs`
- Modify: `apps/server/src/orchestration/engine.rs:710-970,1120-1315,2120-2225,2600-2665,3194-3225`
- Modify: `apps/server/src/production/orchestration_rpc.rs:23-70,100-170`
- Modify: `apps/server/src/production/provider_runtime.rs:199-250,411-507,560-635,1179-1245`
- Modify: `apps/server/src/production/runtime.rs:74-85,135-275,395-406`
- Test: unit tests in all modified Rust modules

**Interfaces:**
- Consumes: Task 1 `CommandAdmission`, outbox rows, digest, and transition types.
- Produces: `TurnDeliveryService::start`, `TurnDeliveryService::wake`, and `TurnDeliveryService::shutdown`.
- Produces: `OrchestrationEngine::dispatch_with_admission` and `OrchestrationEngine::transition_turn_delivery`.
- Produces: temporary conservative routing: Codex/OpenCode success becomes delivered; Claude/Cursor success becomes uncertain until Task 6 adds acknowledgement.

- [ ] **Step 1: Add failing engine tests for replay ownership and atomic inserts**

Write tests that submit the same command ID with the same and different digests. Capture the commit callback count and query all three durable records:

```rust
assert_eq!(same_replay.sequence, first.sequence);
assert_eq!(commit_count.load(Ordering::SeqCst), 1);
assert!(matches!(different, Err(OrchestrationError::CommandConflict { .. })));
assert_eq!(repositories.list_provider_turn_deliveries(vec![TurnDeliveryState::Pending]).await?.len(), 1);
assert_eq!(repositories.list_referenced_attachment_ids().await?, vec!["notes-1".to_owned()]);
```

Add a projector failpoint assertion that receipt, event, outbox, and attachment refs all roll back.

- [ ] **Step 2: Run the focused engine tests and confirm current replay behavior fails**

Run: `node scripts/run-msvc-x64.mjs cargo test -p bibcode-server orchestration::engine::tests::delivery -- --nocapture`

Expected: FAIL because receipts do not compare digests and outbox/reference rows are not part of `persist_command`.

- [ ] **Step 3: Replace callback-only admission with typed admission metadata**

Add:

```rust
pub(crate) async fn dispatch_with_admission(
    &self,
    command: OrchestrationCommand,
    admission: CommandAdmission,
    on_commit: impl FnOnce() + Send + 'static,
) -> Result<DispatchResult, OrchestrationError>;
```

Store `CommandAdmission` on `CommandEnvelope`. Make `process_envelope` return:

```rust
struct ProcessEnvelopeOutcome {
    result: DispatchResult,
    accepted_new: bool,
}
```

Invoke `on_commit` only when `accepted_new` is true. On matching replay, return the existing receipt with `accepted_new: false`; on a digest mismatch return a new `CommandConflict` error.

- [ ] **Step 4: Insert receipt, reference rows, outbox row, and initial pending projection atomically**

Pass admission metadata into `persist_command`. In its existing SQLite transaction:

1. append/project all planned events;
2. insert attachment references;
3. insert the outbox row;
4. upsert the command receipt including `payload_digest`;
5. commit.

Add `thread.turn-delivery-updated` with `pending` to the planned turn events so `projection_thread_messages` receives the initial state in the same transaction.

- [ ] **Step 5: Add the engine-owned delivery transition path**

Change the worker mailbox to an internal enum with command and delivery-transition envelopes. Implement:

```rust
pub(crate) async fn transition_turn_delivery(
    &self,
    transition: TurnDeliveryTransition,
) -> Result<bool, OrchestrationError>;
```

The transition transaction must condition on `command_id`, current state, and `expected_attempt`, update the outbox, append/project `thread.turn-delivery-updated`, commit, then broadcast. Return `false` for stale outcomes without emitting.

- [ ] **Step 6: Add failing production RPC tests for preflight and cancellation**

Assert that an accepted same-digest replay does not call attachment preparation and that a disconnected RPC after engine commit still leaves one pending outbox row. Use a deterministic engine admission barrier rather than a sleep.

- [ ] **Step 7: Move turn routing from the RPC into `TurnDeliveryService`**

In `orchestration_rpc.rs`:

1. decode the typed command;
2. compute the raw canonical digest;
3. preflight the existing receipt;
4. prepare attachments only for a new command;
5. create `CommandAdmission` with sanitized payload, references, stable UUID `delivery_key`, message ID, provider instance/kind, and timestamps;
6. dispatch the admission;
7. call `turn_delivery.wake()` after new acceptance.

Keep direct `route_orchestration_command` only for non-turn runtime commands.

- [ ] **Step 8: Implement the first safe dispatcher loop**

`TurnDeliveryService` owns a cancellation token, wake `Notify`, local in-flight command/thread sets, and a bounded semaphore. On startup and wake:

- recover `sending` rows conservatively;
- select the oldest eligible `pending` row per thread;
- claim it with an attempt token;
- deserialize the frozen `OrchestrationCommand`;
- call the existing provider routing path outside a database transaction;
- persist the outcome through `transition_turn_delivery`.

Until provider acknowledgement work lands:

```rust
match (row.provider_kind.as_str(), route_result) {
    ("codex" | "opencode", Ok(())) => TurnDeliveryState::Delivered,
    ("claudeAgent" | "cursor", Ok(())) => TurnDeliveryState::Uncertain,
    (_, Ok(())) => TurnDeliveryState::Delivered,
    (_, Err(error)) => {
        detail = Some(error.to_string());
        TurnDeliveryState::Failed
    }
}
```

This temporary behavior is conservative: it never silently retries an ambiguous provider.

- [ ] **Step 9: Wire production startup and shutdown**

Start the dispatcher after provider runtime and orchestration effects are available but before RPC registration. Store it on `ProductionRuntime`. Shutdown order must be:

1. stop new turn claims;
2. stop orchestration effects;
3. stop provider runtime;
4. stop orchestration engine.

- [ ] **Step 10: Run focused engine/RPC/dispatcher tests**

Run:

```powershell
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server orchestration::engine::tests::delivery -- --nocapture
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server production::orchestration_rpc -- --nocapture
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server production::turn_delivery -- --nocapture
```

Expected: PASS with no provider call before commit and no RPC-owned accepted work.

- [ ] **Step 11: Commit durable admission and dispatch**

```powershell
git add apps/server/src/orchestration/engine.rs apps/server/src/production/mod.rs apps/server/src/production/orchestration_rpc.rs apps/server/src/production/provider_runtime.rs apps/server/src/production/runtime.rs apps/server/src/production/turn_delivery.rs
git commit -m "feat: dispatch accepted turns from a durable outbox"
```

If blocked, do not bypass the safety hook.

---

### Task 3: Reconcile Attachment Finals After Process Abort

**Files:**
- Modify: `apps/server/src/provider/attachments.rs:24-97,144-242,448-537,1190-1345`
- Modify: `apps/server/src/production/runtime.rs:135-205`
- Test: `apps/server/tests/turn_delivery_recovery.rs`

**Interfaces:**
- Consumes: Task 1 attachment-reference repository query.
- Produces: `AttachmentMaterializer::reconcile_startup(&HashSet<String>)`.
- Produces: deterministic test-only barriers immediately after stage write and final publication.

- [ ] **Step 1: Add a failing startup-GC unit test**

Create one referenced final, one unreferenced final, and one stale `.upload` file. Assert only the referenced final remains after reconciliation.

```rust
let referenced = HashSet::from(["keep-1".to_owned()]);
materializer.reconcile_startup(&referenced).await.unwrap();
assert!(attachments_dir.join("keep-1").exists());
assert!(!attachments_dir.join("orphan-1").exists());
assert!(!attachments_dir.join(".stale.upload").exists());
```

- [ ] **Step 2: Run the focused attachment test and verify it fails**

Run: `node scripts/run-msvc-x64.mjs cargo test -p bibcode-server provider::attachments::tests::startup_reconciliation -- --nocapture`

Expected: FAIL because only `.upload` stages are scavenged today.

- [ ] **Step 3: Implement rooted startup reconciliation**

Under the existing root transaction lock, enumerate direct regular-file leaves only. Keep validated referenced IDs, remove `.upload` stages, remove unreferenced valid final IDs, and reject/skip links and reparse leaves through the existing canonical resolver. Mark `root_initialized` only after the pass succeeds.

- [ ] **Step 4: Call reconciliation before accepting RPC traffic**

In `ProductionRuntime::start`, load `list_referenced_attachment_ids`, build a `HashSet`, and await reconciliation before the provider factory, asset access, and RPC registry expose the attachment root.

- [ ] **Step 5: Add a subprocess crash test after final publication**

Use the test binary itself as a child process with an environment selector. The child prepares an attachment, waits at a test barrier immediately after hard-link publication, then calls `std::process::abort()`. The parent restarts the runtime and asserts the unreferenced final disappears.

- [ ] **Step 6: Add a deterministic open-write cancellation test**

Pause after `write_all` and before `flush`, prove the prepare future is still pending, abort it, release the barrier, and assert both stage and final are absent. This must distinguish true cancellation from aborting an already-completed future.

- [ ] **Step 7: Run attachment and recovery tests**

Run:

```powershell
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --lib provider::attachments -- --nocapture
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --test turn_delivery_recovery attachment -- --nocapture
```

Expected: PASS.

- [ ] **Step 8: Commit crash-safe attachment ownership**

```powershell
git add apps/server/src/provider/attachments.rs apps/server/src/production/runtime.rs apps/server/tests/turn_delivery_recovery.rs
git commit -m "fix: reconcile attachment ownership after restart"
```

---

### Task 4: Move Bootstrap Side Effects Behind Durable Ownership

**Files:**
- Modify: `apps/server/src/orchestration/engine.rs:158-233,775-1070,1415-1810`
- Modify: `apps/server/src/production/turn_delivery.rs`
- Modify: `apps/server/src/production/orchestration_effects.rs:205-340`
- Modify: `apps/server/src/git/repository.rs:790-930`
- Test: existing engine/effects/git tests and `apps/server/tests/turn_delivery_recovery.rs`

**Interfaces:**
- Consumes: frozen bootstrap JSON in Task 2 outbox payload.
- Produces: `GitRepository::ensure_worktree(CreateWorktreeInput, &CancellationToken)`.
- Produces: idempotent bootstrap prerequisite execution while the row remains `pending`.

- [ ] **Step 1: Add a failing engine test for one composite bootstrap admission**

Dispatch a bootstrap turn, cancel the response receiver after queue admission, and assert one transaction leaves `thread.created`, user message, turn request, receipt, and outbox row. Assert no worktree/setup effect ran before commit.

- [ ] **Step 2: Run the bootstrap engine test and confirm the current multi-dispatch path fails**

Run: `node scripts/run-msvc-x64.mjs cargo test -p bibcode-server orchestration::engine::tests::bootstrap_delivery -- --nocapture`

Expected: FAIL because `dispatch_bootstrap_turn` currently creates the thread and performs effects outside the final envelope.

- [ ] **Step 3: Plan bootstrap thread creation and the first turn as one command**

Remove the pre-envelope `dispatch_bootstrap_turn` sequence. In the `ThreadTurnStart` planner, when the thread is absent and `bootstrap.create_thread` is present, prepend one `thread.created` event built from that exact create input, use the resulting thread values for the message/turn events, and leave `bootstrap` frozen in the outbox payload.

Do not run worktree or setup effects inside the engine worker.

- [ ] **Step 4: Add failing Git recovery tests for an already-created branch worktree**

Create a worktree, call `ensure_worktree` again with the same ref, and assert the same canonical path is returned and no suffixed worktree appears.

- [ ] **Step 5: Implement `ensure_worktree` at the shared repository boundary**

Before `git worktree add`, inspect the worktree map for the target ref. If found, return that existing canonical path. Otherwise call the current creation path unchanged. This is the root-cause guard used by all bootstrap retries.

- [ ] **Step 6: Execute bootstrap prerequisites before claiming the outbox row**

In `turn_delivery.rs`, keep the row in `pending` and local in-flight sets while:

1. ensuring the worktree;
2. dispatching `ThreadMetaUpdate` with branch/path;
3. checking for the deterministic setup terminal ID;
4. launching the setup script only when absent;
5. recording setup activity.

Only then perform the atomic `pending -> sending` claim. A crash during bootstrap therefore leaves a retryable pending row, never a falsely ambiguous provider send.

- [ ] **Step 7: Make setup-script launch idempotent**

Extend `OrchestrationEffectCallbacks` with a read-only lookup:

```rust
fn setup_script_is_running<'a>(
    &'a self,
    thread_id: &'a str,
    terminal_id: &'a str,
) -> BoxEffectFuture<'a, bool>;
```

Use the existing deterministic `setup-{script_id}` terminal ID. If it exists, return `Started` without a second launch; otherwise launch once.

- [ ] **Step 8: Add cancellation and restart tests**

Cover cancellation before enqueue, after composite commit, during worktree ensure, and after setup launch. Assert every resource belongs to the persisted thread and restart resumes without a second worktree or setup terminal.

- [ ] **Step 9: Run bootstrap, Git, and recovery tests**

Run:

```powershell
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server orchestration::engine::tests::bootstrap_delivery -- --nocapture
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server production::orchestration_effects -- --nocapture
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server git::repository -- --nocapture
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --test turn_delivery_recovery bootstrap -- --nocapture
```

- [ ] **Step 10: Commit durable bootstrap ownership**

```powershell
git add apps/server/src/orchestration/engine.rs apps/server/src/production/turn_delivery.rs apps/server/src/production/orchestration_effects.rs apps/server/src/git/repository.rs apps/server/tests/turn_delivery_recovery.rs
git commit -m "fix: move turn bootstrap behind durable admission"
```

---

### Task 5: Add Delivery Outcomes and Stable-ID Reconciliation for Codex/OpenCode

**Files:**
- Modify: `apps/server/src/production/provider_runtime.rs:199-250,411-507,1179-1245,2350-2405,2956-3010`
- Modify: `apps/server/src/provider/codex/model.rs:482-535`
- Modify: `apps/server/src/provider/codex/runtime.rs:755-795`
- Modify: `apps/server/src/provider/opencode/runtime.rs:657-690`
- Modify: `apps/server/src/production/turn_delivery.rs`
- Test: provider unit and production integration tests

**Interfaces:**
- Produces: `ProviderDeliveryOutcome` and `ProviderDeliveryHandle`.
- Produces: `ProviderRuntimeSupervisor::deliver_turn(command, delivery_key)` and `reconcile_turn(row)`.
- Produces: Codex/OpenCode exact-ID recovery.

- [ ] **Step 1: Add failing provider contract tests**

Assert Codex `turn/start` contains exactly `clientUserMessageId: "delivery-1"`. Assert OpenCode `prompt_async` contains exactly `messageID: "delivery-1"`. Add readback fixtures for found and absent IDs.

- [ ] **Step 2: Run provider tests and confirm IDs are missing**

Run:

```powershell
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server provider::codex::model -- --nocapture
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server provider::opencode::runtime -- --nocapture
```

Expected: FAIL.

- [ ] **Step 3: Define the shared delivery result without changing non-turn commands**

Add:

```rust
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProviderDeliveryOutcome {
    Accepted { turn_id: Option<String> },
    DefinitelyNotSent { detail: String },
    Ambiguous { detail: String },
    Rejected { detail: String },
}

pub struct ProviderDeliveryHandle {
    completion: oneshot::Receiver<ProviderDeliveryOutcome>,
}
```

Add a delivery-specific supervisor message. The supervisor clones the session driver and spawns the long-running send so approval/interrupt messages remain responsive. The returned handle is awaited by `TurnDeliveryService`, not by the supervisor mailbox.

- [ ] **Step 4: Send and reconcile Codex client IDs**

Add `client_user_message_id: Option<String>` to `BuildTurnStartInput` and serialize it as `clientUserMessageId`. Pass the stored delivery key from driver to runtime. Add a readback helper that requests the resumed thread with turns included and returns `Found`, `Absent`, or `Unavailable` only after a valid complete response.

- [ ] **Step 5: Send and reconcile OpenCode message IDs**

Add `message_id: Option<&str>` to `send_turn`, serialize `messageID`, and add:

```rust
pub async fn message_exists(&self, message_id: &str) -> Result<bool, OpenCodeRuntimeError>;
```

Treat an exact successful lookup as found and an authoritative HTTP 404 as absent. Transport/schema failures are unavailable and must not trigger resend.

- [ ] **Step 6: Drive recovered `sending` rows through reconciliation**

At dispatcher startup:

- Codex/OpenCode found -> `delivered`;
- authoritative absent -> `pending` with immediate eligibility;
- unavailable -> leave `sending`, log, and retry reconciliation later;
- never resend on a failed/unknown readback.

- [ ] **Step 7: Classify live pre-send errors**

Materialization, missing session launch prerequisites, and request construction failures become `Rejected` or `DefinitelyNotSent`. A provider transport failure after request admission becomes `Ambiguous`. Persist retry backoff only for `DefinitelyNotSent`.

- [ ] **Step 8: Add exact recovery integration tests**

For each stable-ID provider, force process loss after provider acceptance and before the outbox transition. Restart, return found, and assert one provider send. Repeat with authoritative absent and assert exactly one resend using the same delivery key.

- [ ] **Step 9: Run stable-provider tests**

Run:

```powershell
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server provider::codex -- --nocapture
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server provider::opencode -- --nocapture
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server production::turn_delivery -- --nocapture
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --test production_provider_runtime delivery -- --nocapture
```

- [ ] **Step 10: Commit stable-ID reconciliation**

```powershell
git add apps/server/src/production/provider_runtime.rs apps/server/src/provider/codex/model.rs apps/server/src/provider/codex/runtime.rs apps/server/src/provider/opencode/runtime.rs apps/server/src/production/turn_delivery.rs apps/server/tests/production_provider_runtime.rs
git commit -m "feat: reconcile Codex and OpenCode turn delivery"
```

---

### Task 6: Make Claude/Cursor Acknowledgement and Ambiguity Explicit

**Files:**
- Modify: `apps/server/src/production/provider_runtime.rs:3097-3135,3425-3470,3578-3750,3890-3965,4370-4425`
- Modify: `apps/server/src/provider/claude/runtime.rs:318-340`
- Modify: `apps/server/src/provider/cursor/runtime.rs:282-352`
- Modify: `apps/server/src/provider/cursor/protocol.rs`
- Modify: `apps/server/src/production/turn_delivery.rs`
- Test: provider/runtime/dispatcher tests

**Interfaces:**
- Consumes: Task 5 `ProviderDeliveryHandle` and outcome enum.
- Produces: Claude replay acknowledgement and Cursor prompt completion outcomes.
- Preserves: no automatic resend after ambiguity.

- [ ] **Step 1: Add failing Claude launch and acknowledgement tests**

Assert launch args contain `--replay-user-messages`. Write a duplex test where a user message is written, its replay arrives, and delivery becomes accepted. A disconnect after write without replay must become ambiguous.

- [ ] **Step 2: Add failing Cursor boundary tests**

Cover failure before request serialization/write as `DefinitelyNotSent`, normal `session/prompt` response as `Accepted`, and connection loss after write before response as `Ambiguous`.

- [ ] **Step 3: Run the focused tests and confirm current immediate-success behavior fails**

Run:

```powershell
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server production::provider_runtime::tests::claude_delivery -- --nocapture
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server provider::cursor::runtime -- --nocapture
```

- [ ] **Step 4: Add Claude replay-user-message acknowledgement**

Add `--replay-user-messages` to the launch arguments. Give `ClaudeDriver` one mutex-protected pending acknowledgement sender because the outbox enforces one in-flight turn per thread. `emit_claude_value` recognizes the official raw `type: "user"` replay before projection and completes the pending sender. The send future:

1. materializes input before registering ambiguity;
2. registers the acknowledgement;
3. writes and flushes the JSON line;
4. waits for replay or output shutdown;
5. returns accepted on replay and ambiguous on post-write shutdown.

- [ ] **Step 5: Return a Cursor prompt receipt without blocking supervisor control**

Change Cursor request handling to expose a completion receiver after the request is written. Keep its existing event-emission task, but resolve the receipt with accepted or ambiguous. The delivery task awaits that receipt outside the supervisor mailbox, so interrupt and approval commands remain processable.

- [ ] **Step 6: Persist no-ID provider outcomes**

Map normal acknowledgement/response to `delivered`, definite pre-write failure to retryable `pending`, post-write loss to `uncertain`, and permanent validation failure to `failed`. On restart, every Claude/Cursor row left in `sending` becomes `uncertain` without a provider call.

- [ ] **Step 7: Add no-duplicate restart tests**

For Claude and Cursor, force a crash after write but before acknowledgement/response. Restart and assert:

```rust
assert_eq!(row.state, TurnDeliveryState::Uncertain);
assert_eq!(provider_send_count.load(Ordering::SeqCst), 1);
```

- [ ] **Step 8: Run Claude/Cursor and dispatcher tests**

Run:

```powershell
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server provider::claude -- --nocapture
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server provider::cursor -- --nocapture
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server production::turn_delivery -- --nocapture
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --test production_provider_runtime delivery -- --nocapture
```

- [ ] **Step 9: Commit explicit no-ID delivery behavior**

```powershell
git add apps/server/src/production/provider_runtime.rs apps/server/src/provider/claude/runtime.rs apps/server/src/provider/cursor/runtime.rs apps/server/src/provider/cursor/protocol.rs apps/server/src/production/turn_delivery.rs apps/server/tests/production_provider_runtime.rs
git commit -m "feat: expose uncertain Claude and Cursor delivery"
```

---

### Task 7: Render Delivery State and Wire Retry/Dismiss

**Files:**
- Create: `apps/web/src/components/chat/TurnDeliveryNotice.tsx`
- Create: `apps/web/src/components/chat/TurnDeliveryNotice.test.tsx`
- Modify: `packages/client-runtime/src/operations/commands.ts`
- Modify: `packages/client-runtime/src/state/threadCommands.ts`
- Modify: `apps/server/src/orchestration/engine.rs`
- Modify: `apps/web/src/types.ts`
- Modify: `apps/web/src/components/chat/MessagesTimeline.tsx:130-180,831-965`
- Modify: `apps/web/src/components/ChatView.tsx`
- Test: `apps/web/src/components/chat/MessagesTimeline.test.tsx`
- Test: `apps/web/src/components/ChatView.hooks.test.tsx`
- Test: `apps/web/src/components/ChatView.test.tsx`

**Interfaces:**
- Consumes: Task 1 wire `TurnDelivery` and resolution command.
- Produces: `resolveTurnDelivery({ threadId, messageId, action })` client operation.
- Produces: message-scoped `TurnDeliveryNotice`.

- [ ] **Step 1: Add failing rendering tests**

Render uncertain and failed messages. Assert visible provider-specific copy, accessible buttons, and no notice for delivered/dismissed messages:

```tsx
expect(markup).toContain("Delivery uncertain");
expect(markup).toContain("Claude may have received this message");
expect(markup).toContain('aria-label="Retry message delivery"');
expect(markup).toContain('aria-label="Dismiss delivery warning"');
```

- [ ] **Step 2: Run web tests and verify the notice is absent**

Run: `vp test run apps/web/src/components/chat/TurnDeliveryNotice.test.tsx apps/web/src/components/chat/MessagesTimeline.test.tsx`

Expected: FAIL.

- [ ] **Step 3: Implement the focused notice component**

The component accepts:

```ts
interface TurnDeliveryNoticeProps {
  delivery: TurnDelivery;
  onRetry: () => void;
  onDismiss: () => void;
  disabled: boolean;
}
```

Use existing `Button`, warning/destructive tokens, provider display-name formatting, and accessible status text. Render nothing for `delivered` or `dismissed`. Keep it under the affected user bubble; do not place it in the toolbar.

- [ ] **Step 4: Add the typed client command**

Add `resolveTurnDelivery` to operations and `threadCommands` using the existing serial key `[environmentId, threadId]`. The command payload is exactly `thread.turn-delivery.resolve` with a fresh command ID and timestamp.

- [ ] **Step 5: Implement atomic manual resolution in the engine**

For `retry`, condition on `uncertain` or `failed`, set `pending`, reset attempts to zero, clear error, emit/project the update, and wake the dispatcher. For `dismiss`, condition on `uncertain` or `failed`, set `dismissed`, retain diagnostic detail, emit/project, and unblock the next row. Matching command replay returns its original receipt without a second transition.

- [ ] **Step 6: Wire timeline and ChatView callbacks**

Pass one `onResolveTurnDelivery(messageId, action)` callback through `MessagesTimelineProps`. Render the notice immediately below `CollapsibleUserMessageBody`. Disable actions while the corresponding command is pending. For uncertain retry, show the existing confirmation dialog mechanism with copy stating that the provider may receive a duplicate.

- [ ] **Step 7: Add action tests**

Assert retry emits `action: "retry"`, dismiss emits `action: "dismiss"`, a failed/uncertain row blocks later delivery until resolution, retry becomes immediately eligible, and dismiss permits the next row.

- [ ] **Step 8: Run focused server/client/web tests**

Run:

```powershell
vp test run packages/contracts/src/orchestration.test.ts apps/web/src/components/chat/TurnDeliveryNotice.test.tsx apps/web/src/components/chat/MessagesTimeline.test.tsx apps/web/src/components/ChatView.hooks.test.tsx apps/web/src/components/ChatView.test.tsx
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server orchestration::engine::tests::delivery_resolution -- --nocapture
```

- [ ] **Step 9: Commit delivery UX**

```powershell
git add packages/client-runtime/src/operations/commands.ts packages/client-runtime/src/state/threadCommands.ts apps/server/src/orchestration/engine.rs apps/web/src/types.ts apps/web/src/components/chat/TurnDeliveryNotice.tsx apps/web/src/components/chat/TurnDeliveryNotice.test.tsx apps/web/src/components/chat/MessagesTimeline.tsx apps/web/src/components/chat/MessagesTimeline.test.tsx apps/web/src/components/ChatView.tsx apps/web/src/components/ChatView.hooks.test.tsx apps/web/src/components/ChatView.test.tsx
git commit -m "feat: show and resolve provider delivery state"
```

---

### Task 8: Prove Crash Boundaries and Run Full Verification

**Files:**
- Modify: `apps/server/tests/turn_delivery_recovery.rs`
- Modify: `apps/server/tests/production_provider_runtime.rs`
- Modify: `apps/server/tests/workspace_rpc.rs`
- Modify: focused web tests only if an integration assertion exposes a missing state

**Interfaces:**
- Consumes: all prior delivery tasks.
- Produces: executable regression coverage for every approved crash and provider boundary.

- [ ] **Step 1: Complete the crash truth-table subprocess test**

Use deterministic child-process exits at:

- final attachment published before DB commit;
- DB commit before provider send;
- Codex/OpenCode provider acceptance before outbox transition;
- Claude/Cursor write before acknowledgement/response.

The parent restarts the runtime and asserts the exact state/send count from the approved truth table.

- [ ] **Step 2: Add per-thread order and cross-thread concurrency tests**

Block thread A's first delivery and enqueue A2 plus B1. Assert B1 starts, A2 does not, and A2 starts only after A1 becomes delivered/dismissed. Assert the active send count never exceeds the configured semaphore limit.

- [ ] **Step 3: Add registered RPC integration coverage**

Through the real `orchestration.dispatchCommand` registration, submit mixed file/image turns for all four providers, replay one command, cancel one caller after commit, and verify one outbox row and one provider submission per new command.

- [ ] **Step 4: Run all focused delivery suites**

Run:

```powershell
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --test turn_delivery_recovery -- --nocapture
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --test production_provider_runtime delivery -- --nocapture
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --test workspace_rpc -- --nocapture
vp test run packages/contracts/src/orchestration.test.ts apps/web/src/components/chat/TurnDeliveryNotice.test.tsx apps/web/src/components/chat/MessagesTimeline.test.tsx apps/web/src/components/ChatView.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Run repository-wide required gates**

Run:

```powershell
vp test
vp check
vp run typecheck
git diff --check
```

Expected: all pass. Do not treat the delivery work as complete otherwise.

- [ ] **Step 6: Review migration and restart compatibility manually**

Start once with a pre-39 state fixture, verify legacy messages/attachments remain, restart again, verify migration idempotency, and confirm no historical outbox rows were synthesized.

- [ ] **Step 7: Commit final recovery coverage**

```powershell
git add apps/server/tests/turn_delivery_recovery.rs apps/server/tests/production_provider_runtime.rs apps/server/tests/workspace_rpc.rs
git commit -m "test: cover durable turn delivery recovery"
```

If commits remain blocked, leave the verified worktree intact and report the hook result.
