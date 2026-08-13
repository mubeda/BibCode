# Targeted Activity Subtree Cancellation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Stop button to cancellable Subagents rows that cancels only the selected actor, its descendants, and exactly attributable background work, while preserving its parent, siblings, root chat turn, and unrelated work.

**Architecture:** Activity protocol v2 carries persisted observation data and a separate bounded, non-persisted control overlay. A server-owned `ActivityCancellationService` joins canonical Activity lineage with provider-native handles, owns cancellation fences and residual retry state, and dispatches through the active provider runtime using generation-bound private targets. Codex supplies exact descendant thread/turn pairs; Claude supplies task IDs only after exact Agent-tool identity correlation. The client submits only canonical scope/actor IDs and concurrency revisions, then renders server-authoritative `Stopping` state while provider events remain authoritative for terminal lifecycle.

**Tech Stack:** Rust, Tokio, Serde, Axum/WebSocket RPC, TypeScript, Effect Schema, Effect Atom, React, Base UI components, Vitest/Vite+, Cargo test, Clippy.

## Global Constraints

- Cancellation means selected actor plus its canonical descendant subtree. Never target a parent, sibling, root chat turn, unrelated thread, terminal scope, or unattributed process.
- Never call the existing root composer interrupt as an Activity-row fallback.
- The browser sends no Codex thread/turn IDs, Claude agent/task IDs, process IDs, commands, prompts, or descendant lists.
- Provider-native targets stay in non-serializable Rust types and must have redacted `Debug` implementations.
- `ActivityActorSummary` remains persisted observation data. Control eligibility and cancellation intent live in a separate ephemeral overlay and are not written to SQLite.
- Protocol v2 is an exact-version change. A v1 client or server must fail closed rather than partially enabling controls.
- `Stopping` is control-plane state. Only provider lifecycle events may change an actor to `cancelled`, `interrupted`, `completed`, or `failed`.
- The selected actor is dispatched first. Descendants use a fixed concurrency limit of four, a two-second per-target timeout, and a ten-second operation deadline.
- Duplicate and overlapping requests are idempotent. Retry may target only the residual members and late descendants of the original fenced subtree.
- First release supports structured-chat `thread` scopes only. Provider-terminal Activity stays read-only.
- Claude correlation uses only the exact Agent/Task `tool_use_id` chain; never use names, roles, descriptions, prompts, timestamps, output paths, or adjacency.
- Codex targeted interrupt must reject the root provider thread even if an internal mapping bug presents it as a target.
- Control maps, pending correlations, operations, residuals, and error summaries must respect the existing 200/256 Activity bounds. No polling loop is added.
- Cancellation audit/trace data contains only canonical scope/actor, provider kind, result class, bounded target count, and duration.
- Preserve unrelated worktree changes. Do not edit `.repos/` or `.codegraph/`.
- `BIBCODE_CLAUDE_KEYCHAIN_ACCESS` must remain unset in tests.
- Completion requires focused tests, broader integration checks, `vp check`, `vp run typecheck`, Rust formatting, relevant Rust tests, and Clippy with warnings denied.

---

## File Responsibility Map

### New server files

- `apps/server/src/activity/control.rs` — wire-facing control overlay models, private native targets, generation registration, bounded handle graph, and control deltas.
- `apps/server/src/activity/cancellation.rs` — subtree admission, overlap/absorption, fences, selected-first bounded dispatch, timeout, residual state, and retry.

### Contracts and generated fixtures

- `packages/contracts/src/activity.ts` — Activity v2 control snapshot/delta, mutation inputs/results, and error reasons.
- `packages/contracts/src/environment.ts` — exact `activityProtocolVersion: 2` negotiation.
- `packages/contracts/src/rpc.ts` — `activity.cancelSubtree` and `activity.retrySubtreeCancellation`.
- `packages/contracts/src/activity.test.ts`, `rpc.test.ts`, `rpcRustParity.test.ts` — schema and RPC parity coverage.
- `packages/contracts/scripts/export-rust-rpc-fixtures.ts`, `packages/contracts/fixtures/rpc-wire/` — generated v2 method/schema fixtures.

### Activity server and security boundary

- `apps/server/src/activity/mod.rs`, `model.rs`, `projection.rs`, `rpc.rs`, `routing.rs` — control service export, snapshot/page overlay, combined stream, and typed mutation handlers.
- `apps/server/src/auth/scope.rs` — operating authorization for both mutations.
- `apps/server/src/maintenance.rs` — mutation classification.
- `apps/server/src/rpc/methods.rs` — active RPC inventory.
- `apps/server/src/production/runtime.rs`, `control.rs` — control-service lifecycle, provider-runtime attachment, registration, and protocol advertisement.
- `apps/server/tests/activity_rpc.rs`, `activity_load.rs`, `auth_http.rs`, `production_control.rs` — RPC, concurrency, authorization, inventory, and generation tests.

### Provider runtime bridge

- `apps/server/src/production/provider_runtime.rs` — runtime generation, private control updates on provider events, targeted dispatcher command, session invalidation, and bounded dispatch errors.
- `apps/server/tests/production_provider_runtime.rs` — dispatcher routing, replacement, stop, disable, shutdown, and redaction tests.

### Codex provider

- `apps/server/src/provider/codex/activity.rs` — exact child thread/active-turn handle tracking and terminal invalidation.
- `apps/server/src/provider/codex/runtime.rs` — explicit child `turn/interrupt` primitive.
- `apps/server/tests/provider_codex.rs` — child-target, root-exclusion, stale-handle, completion, and multi-level fixture coverage.

### Claude provider

- `apps/server/src/provider/claude/activity.rs` — monotonic stopped/cancelled terminal reconciliation.
- `apps/server/src/provider/claude/runtime.rs` — bounded exact Agent-tool/task correlator and task lifecycle extraction.
- `apps/server/src/provider/claude/protocol.rs` — typed task lifecycle frames.
- `apps/server/src/production/provider_runtime.rs` — `stop_task` control request/response and runtime downgrade.
- `apps/server/tests/fixtures/claude-provider/trace-targeted-task-cancellation.json` — exact correlation and stopped lifecycle fixture.
- `apps/server/tests/provider_claude.rs` — ordering, conflict, semantic-collision, unsupported, and monotonic lifecycle tests.

### Client runtime and web UI

- `packages/client-runtime/src/state/activity.ts`, `activityReducer.ts` — v2 negotiation, independent control revision, recovery, and single-flight commands.
- `packages/client-runtime/src/state/activity.test.ts`, `activityReducer.test.ts`, `activityLoad.test.ts` — control stream, command key, reconnect, and gap coverage.
- `apps/web/src/components/ChatView.tsx` — command binding and safe error presentation.
- `apps/web/src/components/activity/ActivityPanel.tsx` — cancellation banner, residual retry, and callbacks.
- `apps/web/src/components/activity/ActivityRoster.tsx` — sibling detail/Stop buttons, subtree labels, and `Stopping` status.
- `apps/web/src/components/activity/ActivityPanel.test.tsx`, `ActivityRoster.test.tsx`, `apps/web/src/components/ChatView.hooks.test.tsx` — DOM, accessibility, command, and failure behavior.

### Living documentation

- `docs/architecture/activity-observation.md`
- `docs/architecture/rpc-and-orchestration.md`
- `docs/providers/codex.md`
- `docs/providers/claude.md`
- `docs/user/workspace-ui.md`

---

### Task 1: Define Activity Protocol v2 and Typed Cancellation RPCs

**Files:**
- Modify: `packages/contracts/src/activity.ts`
- Modify: `packages/contracts/src/environment.ts`
- Modify: `packages/contracts/src/environment.test.ts`
- Modify: `packages/contracts/src/rpc.ts`
- Modify: `packages/contracts/src/activity.test.ts`
- Modify: `packages/contracts/src/rpc.test.ts`
- Modify: `packages/contracts/src/rpcRustParity.test.ts`
- Modify: `packages/contracts/scripts/export-rust-rpc-fixtures.ts`
- Regenerate: `packages/contracts/fixtures/rpc-wire/`

**Interfaces:**
- Produces: `ActivityCapabilities.targetedActorCancellation: boolean`
- Produces: `ActivityActorControl`, `ActivityCancellationOperationSummary`
- Produces: `ActivityControlSnapshot`, `ActivityControlDelta`
- Produces: `ActivityCancelSubtreeInput`, `ActivityRetrySubtreeCancellationInput`
- Produces: `ActivitySubtreeCancellationResult`
- Produces: `WS_METHODS.activityCancelSubtree`, `WS_METHODS.activityRetrySubtreeCancellation`

- [ ] **Step 1: Add failing protocol-v2 schema tests**

In `packages/contracts/src/activity.test.ts`, add fixtures and assertions for:

- `protocolVersion: 2` and rejection of `protocolVersion: 1`;
- `targetedActorCancellation` defaulting to `false` only when decoding older non-Activity capability holders, never inside a v2 Activity snapshot;
- actor controls in `unsupported`, `available`, and `requested` states;
- `activeDescendantCount` and non-negative `controlRevision`;
- requested/partial operation summaries with bounded message and residual count;
- independent control snapshot/delta revisions;
- roster `actorControls` and detail `actorControl`;
- cancel/retry inputs and every disposition;
- rejection of unknown states, negative revisions/counts, native-ID-shaped extra fields, terminal scopes for the mutation schema, and overlong safe messages.

Use this exact contract shape:

```typescript
export const ActivityActorControl = Schema.Struct({
  actorId: ActivityRecordId,
  state: Schema.Literals(["unsupported", "available", "requested"]),
  controlRevision: NonNegativeInt,
  activeDescendantCount: NonNegativeInt,
});

export const ActivityCancellationOperationSummary = Schema.Struct({
  rootActorId: ActivityRecordId,
  state: Schema.Literals(["requested", "partial"]),
  residualCount: NonNegativeInt,
  message: Schema.NullOr(ActivitySummaryText),
  operationRevision: NonNegativeInt,
});

export const ActivityControlSnapshot = Schema.Struct({
  scopeId: ActivityScopeId,
  revision: NonNegativeInt,
  actors: Schema.Array(ActivityActorControl).check(
    Schema.isMaxLength(ACTIVITY_PAGE_MAX_LENGTH),
  ),
  operations: Schema.Array(ActivityCancellationOperationSummary).check(
    Schema.isMaxLength(ACTIVITY_PAGE_MAX_LENGTH),
  ),
});
```

Define `ActivityControlChange` as actor/operation upsert/remove variants and
`ActivityControlDelta` with `scopeId`, `previousRevision`, `revision`, and one
to 256 changes. Add `control: ActivityControlSnapshot` to `ActivitySnapshot`.
Add `control-snapshot` and `control-delta` variants to `ActivityStreamItem`.

- [ ] **Step 2: Run the contract tests and confirm red**

```bash
vp test packages/contracts/src/activity.test.ts packages/contracts/src/environment.test.ts packages/contracts/src/rpc.test.ts packages/contracts/src/rpcRustParity.test.ts
```

Expected: schema and RPC assertions fail because protocol v2 and both methods do not exist.

- [ ] **Step 3: Implement the v2 schemas and RPC definitions**

Add these mutation contracts:

```typescript
export const ActivityCancelSubtreeInput = Schema.Struct({
  scope: Schema.TaggedStruct("thread", { threadId: ActivityThreadId }),
  scopeId: ActivityScopeId,
  actorId: ActivityRecordId,
  expectedControlRevision: NonNegativeInt,
});

export const ActivityRetrySubtreeCancellationInput = Schema.Struct({
  scope: Schema.TaggedStruct("thread", { threadId: ActivityThreadId }),
  scopeId: ActivityScopeId,
  rootActorId: ActivityRecordId,
  expectedOperationRevision: NonNegativeInt,
});

export const ActivitySubtreeCancellationResult = Schema.Struct({
  disposition: Schema.Literals(["accepted", "inProgress", "alreadyTerminal"]),
  rootActorId: ActivityRecordId,
  operationRevision: Schema.NullOr(NonNegativeInt),
});
```

Extend `ActivityError.reason` with:

```typescript
"cancellationUnsupported",
"staleScope",
"staleActor",
"staleOperation",
"providerUnavailable",
"targetUnavailable",
"partialCancellation",
"dispatchTimeout",
```

Add both unary RPCs to `WsRpcGroup`. Their typed error is
`Schema.Union([ActivityError, EnvironmentAuthorizationError])`.

- [ ] **Step 4: Bump exact environment negotiation to v2**

Change both exact literals:

```typescript
activityProtocolVersion: Schema.NullOr(Schema.Literal(2))
protocolVersion: Schema.Literal(2)
```

Do not change provider-specific probe payload versions that happen to contain a
field named `protocolVersion`; only BiBCode Activity protocol negotiation moves.
Update `packages/contracts/src/environment.test.ts` to accept `2` and reject
`1`, `0`, and unknown future versions.

- [ ] **Step 5: Update RPC inventory expectations and regenerate fixtures**

```bash
vp run --filter @bibcode/contracts generate:rust-rpc-fixtures
git diff --check packages/contracts/fixtures/rpc-wire
vp test packages/contracts/src/activity.test.ts packages/contracts/src/environment.test.ts packages/contracts/src/rpc.test.ts packages/contracts/src/rpcRustParity.test.ts
```

Expected: generated manifest contains five Activity unary methods plus
`subscribeActivity`, all contract tests pass, and generated data contains no
provider-native identifier fields.

- [ ] **Step 6: Commit the protocol boundary**

```bash
git add packages/contracts/src/activity.ts packages/contracts/src/environment.ts packages/contracts/src/environment.test.ts packages/contracts/src/rpc.ts packages/contracts/src/activity.test.ts packages/contracts/src/rpc.test.ts packages/contracts/src/rpcRustParity.test.ts packages/contracts/scripts/export-rust-rpc-fixtures.ts packages/contracts/fixtures/rpc-wire
git commit -m "feat(activity): define targeted cancellation protocol"
```

---

### Task 2: Build the Bounded Activity Control Registry and Overlay

**Files:**
- Create: `apps/server/src/activity/control.rs`
- Modify: `apps/server/src/activity/mod.rs`
- Modify: `apps/server/src/activity/model.rs`
- Modify: `apps/server/src/activity/projection.rs`
- Modify: `apps/server/src/production/agent_activity.rs`
- Modify: `apps/server/src/production/provider_runtime.rs`
- Modify: `apps/server/src/provider/codex/activity.rs`
- Modify: `apps/server/src/provider/codex/runtime.rs`
- Modify: `apps/server/src/provider/claude/activity.rs`
- Modify: `apps/server/src/provider/claude/runtime.rs`
- Modify: `apps/server/src/provider/opencode/runtime.rs`
- Modify: `apps/server/src/provider_terminal/claude.rs`
- Modify: `apps/server/src/provider_terminal/opencode.rs`
- Modify: `apps/server/tests/activity_repository.rs`
- Modify: `apps/server/tests/production_provider_runtime.rs`
- Modify: `apps/server/tests/provider_claude.rs`
- Modify: `apps/server/tests/provider_opencode.rs`
- Modify: `apps/server/tests/activity_load.rs`

**Interfaces:**
- Produces: `ProviderActivityNativeTarget` (non-serializable, redacted `Debug`)
- Produces: `ProviderActivityControlUpdate`
- Produces: `ActivityRuntimeControlRegistration`
- Produces: `ActivityControlRegistry::observe_provider_batch(...)`
- Produces: snapshot/page/detail overlay lookup and `ActivityControlEvent`

- [ ] **Step 1: Write registry tests before implementation**

In `apps/server/src/activity/control.rs`, add unit tests proving:

- a runtime registration starts with revision zero and no available actor;
- observing an active actor without a native target emits `unsupported`;
- adding an exact target emits `available` and advances only control revision;
- replacing/removing a handle advances that actor's `control_revision`;
- changing only descendant count advances the overlay revision but not the actor's target-fencing revision;
- terminal actors lose availability;
- runtime replacement removes all old handles and advances revisions;
- terminal scopes never gain control capability;
- actor, operation, and pending update counts cannot exceed existing bounds;
- `Debug` output for native targets contains variant names but not native IDs.

The private target enum is exact and deliberately not `Serialize`/`Deserialize`:

```rust
#[derive(Clone, Eq, PartialEq)]
pub(crate) enum ProviderActivityNativeTarget {
    CodexTurn { thread_id: String, turn_id: String },
    ClaudeTask { task_id: String },
}
```

Implement a manual `Debug` that prints `CodexTurn { .. }` or
`ClaudeTask { .. }` only.

- [ ] **Step 2: Run the registry tests and confirm red**

```bash
cargo test -p bibcode-server activity::control::tests -- --nocapture
```

Expected: compilation fails because the control module and types are absent.

- [ ] **Step 3: Implement generation-bound registration and updates**

Use these core types:

```rust
#[derive(Clone, Copy, Eq, Hash, PartialEq)]
pub(crate) struct ActivityRuntimeGeneration(Uuid);

pub(crate) enum ProviderActivityControlUpdate {
    ActorTarget {
        actor_id: String,
        target: Option<ProviderActivityNativeTarget>,
    },
    WorkTarget {
        work_item_id: String,
        target: Option<ProviderActivityNativeTarget>,
    },
}

impl ActivityControlRegistry {
    pub(crate) fn register_runtime(
        &self,
        scope: ActivityScopeRef,
        scope_id: String,
        provider_instance_id: Option<String>,
    ) -> ActivityRuntimeControlRegistration;

    pub(crate) async fn observe_provider_batch(
        &self,
        registration: &ActivityRuntimeControlRegistration,
        activity: &[ProviderActivityMutation],
        controls: &[ProviderActivityControlUpdate],
    ) -> Vec<ActivityDispatchJob>;

    pub(crate) async fn snapshot(&self, scope_id: &str) -> ActivityControlSnapshot;
}
```

`observe_provider_batch` must first validate all canonical graph mutations,
then apply handle updates, then evaluate cancellation fences, and only then
publish one bounded control delta. Return late-descendant dispatch jobs to the
caller after the lock is released.

- [ ] **Step 4: Keep observation storage and control storage separate**

Do not add control fields to `ActivityActorSummary`, repository rows, SQLite
migrations, or `ProviderActivityMutation`. Add Rust wire models matching Task
1 and overlay helpers that join by actor ID only at the RPC boundary:

```rust
pub(crate) async fn actor_controls_for(
    &self,
    scope_id: &str,
    actors: &[ActivityActorSummary],
) -> Vec<ActivityActorControl>;

pub(crate) async fn actor_control_for(
    &self,
    scope_id: &str,
    actor_id: &str,
) -> Option<ActivityActorControl>;
```

Historical actors after server restart remain `unsupported` until the new
runtime re-proves an exact handle.

- [ ] **Step 5: Migrate every Rust capability literal fail-closed**

Add `targeted_actor_cancellation: false` to every existing
`ActivityCapabilities` literal and constructor outside the new structured-chat
Codex/Claude control paths. Locate the complete set with:

```bash
rg -n "ActivityCapabilities \\{" apps/server/src apps/server/tests
```

OpenCode and all provider-terminal observers remain false. Tasks 6 and 8 turn
the capability on only after their exact provider runtime requirements are
satisfied.

- [ ] **Step 6: Add bounded-load tests**

In `apps/server/tests/activity_load.rs`, construct 200 actors with a four-level
tree and assert:

- descendant counts are correct;
- one provider batch produces at most one control delta;
- the registry rejects the 201st retained control record without unbounded allocation;
- replacing a runtime clears old targets in one bounded operation;
- no database queue work is reserved by control-only updates.

```bash
cargo test -p bibcode-server --test activity_load control_registry -- --nocapture
cargo test -p bibcode-server activity::control::tests -- --nocapture
```

Expected: all registry and load tests pass.

- [ ] **Step 7: Commit the control overlay**

```bash
git add apps/server/src/activity/control.rs apps/server/src/activity/mod.rs apps/server/src/activity/model.rs apps/server/src/activity/projection.rs apps/server/src/production/agent_activity.rs apps/server/src/production/provider_runtime.rs apps/server/src/provider/codex/activity.rs apps/server/src/provider/codex/runtime.rs apps/server/src/provider/claude/activity.rs apps/server/src/provider/claude/runtime.rs apps/server/src/provider/opencode/runtime.rs apps/server/src/provider_terminal/claude.rs apps/server/src/provider_terminal/opencode.rs apps/server/tests/activity_repository.rs apps/server/tests/activity_load.rs apps/server/tests/production_provider_runtime.rs apps/server/tests/provider_claude.rs apps/server/tests/provider_opencode.rs
git commit -m "feat(activity): add ephemeral control overlay"
```

---

### Task 3: Implement Subtree Admission, Fences, Overlap, and Residual Retry

**Files:**
- Create: `apps/server/src/activity/cancellation.rs`
- Modify: `apps/server/src/activity/control.rs`
- Modify: `apps/server/src/activity/mod.rs`
- Modify: `apps/server/tests/activity_load.rs`

**Interfaces:**
- Produces: `ActivityCancellationService`
- Produces: `ActivityCancellationDispatcher` trait
- Produces: `cancel_subtree(...)` and `retry_subtree_cancellation(...)`
- Produces: bounded operation state and cancellation summaries

- [ ] **Step 1: Write exact-subtree selection tests**

Build this graph in cancellation unit tests:

```text
root
├── alpha
│   ├── alpha-one
│   └── alpha-two
│       └── alpha-two-child
└── beta
    └── beta-one
```

Selecting `alpha` must dispatch exactly `alpha`, `alpha-one`, `alpha-two`, and
`alpha-two-child`. Assert that `root`, `beta`, and `beta-one` are absent. Add a
second scope with duplicate labels and prove no cross-scope target is selected.

Add provider-attributed work to `alpha-two` and unattributed work beside it.
Only the attributed work with an exact target may join the operation.

- [ ] **Step 2: Write concurrency, overlap, and retry tests**

Use a fake dispatcher with barriers and counters to prove:

- the selected actor reaches dispatch before any descendant;
- descendant concurrency never exceeds four;
- duplicate root requests return `inProgress` and dispatch each target once;
- selecting a covered descendant joins the ancestor operation;
- selecting an ancestor absorbs active descendant operations without duplicate native dispatch;
- a late child observed after fence installation enters `requested` and is dispatched;
- natural terminal completion before dispatch is a successful no-op;
- partial failure retains only active residual members;
- retry dispatches only residuals plus already-fenced late descendants;
- stale operation revision performs no provider I/O;
- timeout does not terminalize observation state;
- runtime replacement, disablement, and shutdown invalidate the operation.

- [ ] **Step 3: Run the service tests and confirm red**

```bash
cargo test -p bibcode-server activity::cancellation::tests -- --nocapture
```

Expected: compilation fails because the cancellation service is absent.

- [ ] **Step 4: Implement the dispatcher seam and operation model**

```rust
pub(crate) trait ActivityCancellationDispatcher: Send + Sync {
    fn cancel_target(
        &self,
        scope: ActivityScopeRef,
        generation: ActivityRuntimeGeneration,
        target: ProviderActivityNativeTarget,
    ) -> BoxFuture<'static, Result<ActivityTargetDispatchDisposition, ActivityDispatchError>>;
}

struct CancellationOperation {
    root_actor_id: String,
    generation: ActivityRuntimeGeneration,
    covered_actor_ids: HashSet<String>,
    covered_work_item_ids: HashSet<String>,
    dispatched_targets: HashSet<ProviderActivityNativeTarget>,
    residual_actor_ids: HashSet<String>,
    residual_work_item_ids: HashSet<String>,
    state: CancellationOperationState,
    operation_revision: u64,
}
```

Implement redacted `Debug` for the operation or omit `Debug`; never derive it
while it contains native targets.

- [ ] **Step 5: Implement admission under the scope lock**

`cancel_subtree` must perform this order before provider I/O:

1. require a current thread-scope registration and matching `scopeId`;
2. find the actor and compare `expectedControlRevision`;
3. return `alreadyTerminal` for terminal actor state;
4. require an exact selected-actor target;
5. compute the canonical descendant closure and exact attributable work;
6. install the root fence;
7. join or absorb overlap;
8. publish requested actor controls and operation summary;
9. clone the selected dispatch job and remaining bounded jobs;
10. release the lock.

Dispatch the selected job and observe its bounded result before spawning the
remaining jobs. Use `Semaphore::new(4)`, `timeout(Duration::from_secs(2), ...)`
per target, and a ten-second operation deadline. Provider success means request
delivery only; it does not remove a residual until an authoritative terminal
mutation is observed.

- [ ] **Step 6: Implement residual and retry semantics**

Publish a partial operation only when the operation deadline or a definite
provider failure leaves active exact or delayed targets. The safe message is a
static category such as `"Some agents are still running."`; provider errors and
native IDs never enter it.

`retry_subtree_cancellation` validates the original root and
`expectedOperationRevision`, uses the stored residual set, and does not perform
a new upward/outward traversal. It may include late children already admitted
under the fence. When all covered observations become terminal, remove the
operation and fence and publish one removal delta.

- [ ] **Step 7: Run service and load tests**

```bash
cargo test -p bibcode-server activity::cancellation::tests -- --nocapture
cargo test -p bibcode-server --test activity_load cancellation -- --nocapture
```

Expected: all pass; peak descendant dispatch is four, and retry never expands
the original cancellation boundary.

- [ ] **Step 8: Commit the cancellation core**

```bash
git add apps/server/src/activity/cancellation.rs apps/server/src/activity/control.rs apps/server/src/activity/mod.rs apps/server/tests/activity_load.rs
git commit -m "feat(activity): coordinate subtree cancellation"
```

---

### Task 4: Integrate Control Snapshots, Streaming, RPC, Authorization, and Maintenance

**Files:**
- Modify: `apps/server/src/activity/rpc.rs`
- Modify: `apps/server/src/activity/projection.rs`
- Modify: `apps/server/src/auth/scope.rs`
- Modify: `apps/server/src/maintenance.rs`
- Modify: `apps/server/src/rpc/methods.rs`
- Modify: `apps/server/src/production/runtime.rs`
- Modify: `apps/server/src/production/control.rs`
- Modify: `apps/server/tests/activity_rpc.rs`
- Modify: `apps/server/tests/auth_http.rs`
- Modify: `apps/server/tests/production_control.rs`

**Interfaces:**
- Consumes: `ActivityCancellationService` from Task 3
- Produces: v2 snapshot/page/detail overlay and independent control streaming
- Produces: authorized cancel/retry unary handlers

- [ ] **Step 1: Add failing Rust RPC wire tests**

Extend `apps/server/tests/activity_rpc.rs` to assert:

- snapshots use `protocolVersion: 2` and contain `control`;
- roster returns controls only for actor records in that page;
- actor detail returns its control and work-item detail returns `null`;
- the stream emits initial combined snapshot, persistent delta, control delta,
  and a full `control-snapshot` after a control revision gap;
- terminal scopes expose empty controls and reject both mutations;
- stale scope, stale actor revision, stale operation revision, missing actor,
  and unsupported target send no dispatcher call;
- duplicate request returns `inProgress`;
- already-terminal race returns `alreadyTerminal`;
- serialized responses contain none of the fake native IDs.

- [ ] **Step 2: Add authorization, maintenance, and inventory tests**

In `auth_http.rs`, prove `orchestration:read` can read/subscribe but receives
`EnvironmentAuthorizationError` for both mutations, while
`orchestration:operate` succeeds. In maintenance tests, prove both methods are
mutations and are rejected while mutation admission is closed. Update active
method inventory expectations to include:

```rust
unary("activity.cancelSubtree"),
unary("activity.retrySubtreeCancellation"),
```

- [ ] **Step 3: Run focused RPC tests and confirm red**

```bash
cargo test -p bibcode-server --test activity_rpc -- --nocapture
cargo test -p bibcode-server --test auth_http activity -- --nocapture
cargo test -p bibcode-server maintenance::tests::rpc_mutability -- --nocapture
cargo test -p bibcode-server --test production_control rpc_inventory -- --nocapture
```

Expected: protocol version, registrations, overlay, and scope classifications fail.

- [ ] **Step 4: Register the service and merge read responses**

Change registration to:

```rust
pub fn register_activity_rpc(
    registry: &mut RpcRegistry,
    projections: ActivityProjections,
    cancellation: ActivityCancellationService,
)
```

For each read, preserve the existing `ActivityUnaryResponseGuard`, then join
the control overlay only after the admitted repository read succeeds. Validate
that returned observation `scope_id` matches the overlay scope before encoding.

For subscriptions, subscribe to the control broadcast before reading its
snapshot, track observation and control revisions independently, and use
`tokio::select!` across both receivers. A control lag sends a fresh
`control-snapshot`; an observation lag keeps the existing fresh combined
snapshot path.

- [ ] **Step 5: Implement mutation handlers and error mapping**

Register both as guarded unary mutations. RPC-level authorization is
`orchestration:operate`; service admission still validates scope and generation.
Map internal errors to the bounded Task 1 reasons. Do not format native targets
or provider payloads into `message`.

- [ ] **Step 6: Wire protocol advertisement and production ownership**

Construct one `ActivityCancellationService` in `ProductionRuntime::start`, pass
it to the provider runtime and Activity RPC, and invalidate it during runtime
shutdown. Change the environment advertisement and its tests from `1` to `2`.

- [ ] **Step 7: Run all focused RPC/security checks**

```bash
cargo test -p bibcode-server --test activity_rpc -- --nocapture
cargo test -p bibcode-server --test auth_http -- --nocapture
cargo test -p bibcode-server maintenance::tests -- --nocapture
cargo test -p bibcode-server --test production_control -- --nocapture
```

Expected: all pass, reads remain under `orchestration:read`, mutations require
`orchestration:operate`, and maintenance closes both mutations.

- [ ] **Step 8: Regenerate auth/RPC fixtures if parity changed**

```bash
vp run --filter @bibcode/contracts generate:rust-auth-fixtures
vp run --filter @bibcode/contracts generate:rust-rpc-fixtures
git diff --check packages/contracts/fixtures
```

Expected: only intentional method/scope/schema fixture changes.

- [ ] **Step 9: Commit the server RPC boundary**

```bash
git add apps/server/src/activity/rpc.rs apps/server/src/activity/projection.rs apps/server/src/auth/scope.rs apps/server/src/maintenance.rs apps/server/src/rpc/methods.rs apps/server/src/production/runtime.rs apps/server/src/production/control.rs apps/server/tests/activity_rpc.rs apps/server/tests/auth_http.rs apps/server/tests/production_control.rs packages/contracts/fixtures/rpc-wire packages/contracts/fixtures/auth-http
git commit -m "feat(activity): expose authorized cancellation RPCs"
```

---

### Task 5: Add the Provider-Runtime Targeted Dispatch Bridge

**Files:**
- Modify: `apps/server/src/production/provider_runtime.rs`
- Modify: `apps/server/src/production/operational_logs.rs`
- Modify: `apps/server/tests/production_provider_runtime.rs`
- Modify: `apps/server/tests/production_operational_logs.rs`
- Modify: `apps/server/tests/activity_load.rs`

**Interfaces:**
- Produces: provider runtime generation on each live session
- Produces: `ProviderDriver::cancel_activity_target(...)`
- Produces: `ProviderRuntimeSupervisor` implementation of `ActivityCancellationDispatcher`
- Produces: `ProviderEvent.activity_controls`

- [ ] **Step 1: Add failing supervisor routing tests**

Use fake drivers to assert:

- a target for thread A routes only to thread A's active driver;
- a mismatched runtime generation fails before driver invocation;
- restart invalidates the old generation and all old handles;
- session stop, activity disablement, and supervisor shutdown invalidate controls;
- concurrent cancellation does not enter the ordered root turn-delivery lane;
- queue closure and response drop map to safe categories;
- logs and `Debug` output do not contain native target strings.

- [ ] **Step 2: Run supervisor tests and confirm red**

```bash
cargo test -p bibcode-server --test production_provider_runtime targeted_activity -- --nocapture
```

Expected: driver and supervisor have no targeted Activity dispatch seam.

- [ ] **Step 3: Add internal control updates to provider events**

Extend the internal-only event type:

```rust
pub struct ProviderEvent {
    // existing fields
    pub activity: Vec<ProviderActivityMutation>,
    pub activity_controls: Vec<ProviderActivityControlUpdate>,
}
```

This field is never serialized into orchestration events or operational logs.
Update all constructors to use an empty vector unless a structured provider
supplies exact handles.

- [ ] **Step 4: Add generation and driver dispatch to the supervisor**

Generate `ActivityRuntimeGeneration` before driver creation and retain it in
`SessionEntry`. Register the thread scope with the control service before event
pumping. Add:

```rust
fn cancel_activity_target(
    &self,
    target: ProviderActivityNativeTarget,
) -> BoxRuntimeFuture<'_, Result<ActivityTargetDispatchDisposition, ProviderRuntimeError>> {
    Box::pin(async {
        Err(ProviderRuntimeError::UnsupportedCapability {
            provider: "activity".to_owned(),
            capability: "targeted activity cancellation",
        })
    })
}
```

Keep this as a default trait method so Cursor, Grok, OpenCode, fake drivers, and
delivery-recovery fixtures remain source-compatible and fail closed. Codex and
Claude override it. The default provider label is the safe static category
`"activity"`; it must not be copied into client errors. Unsupported providers
never call root `interrupt`.

Add a `SupervisorMessage::CancelActivityTarget` carrying thread scope,
generation, target, and a typed response. Handle it directly against the
current `SessionEntry`; do not translate it into `ThreadTurnInterrupt`.

- [ ] **Step 5: Feed provider batches to the cancellation service before projection**

In the event pump, call `observe_provider_batch` after native event validation
but before `ActivityProjection::apply`. Spawn any returned late-descendant jobs
only after both service and projection locks are released. A terminal provider
mutation must retire residual state even if the control update vector is empty.

- [ ] **Step 6: Run supervisor and load tests**

```bash
cargo test -p bibcode-server --test production_provider_runtime targeted_activity -- --nocapture
cargo test -p bibcode-server --test activity_load cancellation_dispatch -- --nocapture
```

Expected: exact routing, replacement fencing, backpressure, and redaction tests pass.

- [ ] **Step 7: Commit the provider bridge**

```bash
git add apps/server/src/production/provider_runtime.rs apps/server/src/production/operational_logs.rs apps/server/tests/production_provider_runtime.rs apps/server/tests/production_operational_logs.rs apps/server/tests/activity_load.rs
git commit -m "feat(providers): route targeted activity controls"
```

---

### Task 6: Produce and Dispatch Exact Codex Child Turn Targets

**Files:**
- Modify: `apps/server/src/provider/codex/activity.rs`
- Modify: `apps/server/src/provider/codex/runtime.rs`
- Modify: `apps/server/src/production/provider_runtime.rs`
- Modify: `apps/server/tests/provider_codex.rs`
- Modify: `apps/server/tests/production_provider_runtime.rs`

**Interfaces:**
- Produces: Codex actor target updates with child `threadId` + active `turnId`
- Produces: `CodexRuntime::interrupt_targeted_turn(thread_id, turn_id)`

- [ ] **Step 1: Add failing tracker tests for exact active-turn handles**

In `provider/codex/activity.rs` tests, prove:

- verified descendant `turn/started` emits one `ActorTarget` with its canonical actor ID;
- `turn/completed` removes that target;
- reconciliation of an active child turn creates the same target;
- a provisional/unverified child, root thread, missing turn ID, terminal turn,
  conflicting turn, oversized ID, and stale completion emit no available target;
- reopening a canonical child with a new active turn changes the control revision.

Add `active_turn_id: Option<String>` to `ActivityActorState`. Update it only
from validated live/reconciled turn lifecycle for that same native child.

- [ ] **Step 2: Add failing runtime request tests**

Mock App Server JSON-RPC and assert targeted cancellation sends exactly:

```json
{
  "method": "turn/interrupt",
  "params": { "threadId": "child-thread-2", "turnId": "child-turn-7" }
}
```

Assert the captured request never contains the root thread ID. Cover natural
completion before request, provider error, stale target, and a multi-level tree.

- [ ] **Step 3: Run Codex tests and confirm red**

```bash
cargo test -p bibcode-server provider::codex::activity::tests::targeted_control -- --nocapture
cargo test -p bibcode-server --test provider_codex targeted_cancel -- --nocapture
```

Expected: the tracker does not retain active child turns and runtime interrupt is root-bound.

- [ ] **Step 4: Implement the explicit targeted interrupt primitive**

```rust
pub async fn interrupt_targeted_turn(
    &self,
    thread_id: &str,
    turn_id: &str,
) -> Result<(), RuntimeError>;
```

Validate both IDs with existing native-ID bounds. Read the root provider thread
and reject equality before sending. Keep existing `interrupt_turn` for composer
behavior, but do not call it from targeted dispatch.

- [ ] **Step 5: Emit private targets and wire the Codex driver**

Add control updates to `CodexActivityOutput`/`CodexProviderEvent` and map them to
`ProviderEvent.activity_controls`. `CodexDriver::cancel_activity_target` accepts
only `ProviderActivityNativeTarget::CodexTurn` and calls the explicit primitive.
Any other variant fails closed.

Current Codex background-terminal reconciliation does not prove an
`ownerActorId` and exposes no scoped cancellation method. Keep those work items
out of the cancellation target set; do not call root background-terminal cleanup
or kill operating-system descendants.

- [ ] **Step 6: Run complete focused Codex coverage**

```bash
cargo test -p bibcode-server provider::codex::activity::tests -- --nocapture
cargo test -p bibcode-server --test provider_codex -- --nocapture
cargo test -p bibcode-server --test production_provider_runtime codex_targeted_activity -- --nocapture
```

Expected: all pass; child handles become available only while active, and the
root thread is absent from every targeted request capture.

- [ ] **Step 7: Commit Codex targeted control**

```bash
git add apps/server/src/provider/codex/activity.rs apps/server/src/provider/codex/runtime.rs apps/server/src/production/provider_runtime.rs apps/server/tests/provider_codex.rs apps/server/tests/production_provider_runtime.rs
git commit -m "feat(codex): interrupt exact child turns"
```

---

### Task 7: Correlate Claude Actors to Background Tasks Without Guessing

**Files:**
- Modify: `apps/server/src/provider/claude/protocol.rs`
- Modify: `apps/server/src/provider/claude/runtime.rs`
- Modify: `apps/server/src/provider/claude/activity.rs`
- Create: `apps/server/tests/fixtures/claude-provider/trace-targeted-task-cancellation.json`
- Modify: `apps/server/tests/provider_claude.rs`

**Interfaces:**
- Produces: bounded `ClaudeTaskControlCorrelator`
- Produces: Claude actor target updates only after the full identity chain
- Produces: stopped-task terminal reconciliation

- [ ] **Step 1: Add the exact-correlation fixture**

The fixture must contain the same-session facts in at least two event orders:

1. Agent tool use ID `tool-agent-a`;
2. authenticated root `PostToolUse` with `tool_name: "Agent"`,
   `tool_response.status: "async_launched"`, and `agentId: "agent-a"`;
3. `system/task_started` with `task_id: "task-a"`,
   `tool_use_id: "tool-agent-a"`, and `task_type: "local_agent"`;
4. `SubagentStart` with `agent_id: "agent-a"`;
5. `task_notification` with `task_id: "task-a"` and `status: "stopped"`;
6. `SubagentStop` for `agent-a` after the stopped notification.

Add two concurrent agents with identical names, roles, descriptions, and
prompts but different IDs to prove semantic fields are irrelevant.

- [ ] **Step 2: Add failing correlator tests**

Test all permutations of the four identity facts and assert exactly one mapping
`claude:agent:agent-a -> task-a`. Add rejection tests for:

- missing tool-use link;
- non-Agent/Task tool;
- non-async result;
- non-agent task type;
- conflicting agent for one tool use;
- conflicting task for one tool use;
- duplicate task assigned to two actors;
- wrong session or generation;
- oversized/control-character IDs;
- unauthenticated hook input;
- saturated bounded maps.

- [ ] **Step 3: Run Claude tests and confirm red**

```bash
cargo test -p bibcode-server --test provider_claude targeted_task_correlation -- --nocapture
```

Expected: system task lifecycle is currently ignored for Activity and root
PostToolUse without `agent_id` cannot contribute correlation.

- [ ] **Step 4: Implement typed task lifecycle parsing and bounded joins**

Add internal typed structs for `task_started` and `task_notification`, retaining
only bounded identity/status fields. Implement:

```rust
struct ClaudeTaskControlCorrelator {
    agent_by_tool_use: BoundedMap<String, String>,
    task_by_tool_use: BoundedMap<String, String>,
    actor_target_by_agent: BoundedMap<String, String>,
    terminal_status_by_task: BoundedMap<String, ActivityLifecycle>,
}
```

The root authenticated-hook path extracts only `session_id`, `tool_name`,
`tool_use_id`, `tool_response.status`, and `tool_response.agentId`. It must not
forward root tool output into child Activity entries or retain arbitrary tool
response content.

- [ ] **Step 5: Emit Claude task targets and reconcile terminal order**

When all facts agree, emit:

```rust
ProviderActivityControlUpdate::ActorTarget {
    actor_id: canonical_actor_id,
    target: Some(ProviderActivityNativeTarget::ClaudeTask { task_id }),
}
```

On `task_notification(status: "stopped")`, project actor lifecycle as
`Cancelled`, retire its exact target, and remember terminal authority long
enough for a following `SubagentStop`. Change `handle_subagent_stop` so it never
rewrites `Cancelled`/`Interrupted`/`Failed` to `Completed`.

- [ ] **Step 6: Run all Claude activity tests**

```bash
cargo test -p bibcode-server provider::claude::activity::tests -- --nocapture
cargo test -p bibcode-server --test provider_claude -- --nocapture
```

Expected: all pass, identical semantic text cannot cross-wire actors, and
stopped task lifecycle remains cancelled after SubagentStop.

- [ ] **Step 7: Commit exact Claude task correlation**

```bash
git add apps/server/src/provider/claude/protocol.rs apps/server/src/provider/claude/runtime.rs apps/server/src/provider/claude/activity.rs apps/server/tests/fixtures/claude-provider/trace-targeted-task-cancellation.json apps/server/tests/provider_claude.rs
git commit -m "feat(claude): correlate agents with background tasks"
```

---

### Task 8: Send Claude `stop_task` and Downgrade Unsupported Runtimes

**Files:**
- Modify: `apps/server/src/provider/claude/runtime.rs`
- Modify: `apps/server/src/production/provider_runtime.rs`
- Modify: `apps/server/tests/production_provider_runtime.rs`
- Modify: `apps/server/tests/provider_claude.rs`

**Interfaces:**
- Produces: `ControlRequestBody::StopTask { task_id }`
- Produces: typed `query_claude_control` result for success/unsupported/timeout
- Produces: generation-scoped targeted-control downgrade

- [ ] **Step 1: Add failing serialization and response tests**

Assert this exact request shape:

```json
{
  "type": "control_request",
  "request_id": "bibcode-41",
  "request": { "subtype": "stop_task", "task_id": "task-a" }
}
```

Add response-router tests for success, explicit unsupported/error, timeout,
connection close, and mismatched request ID. Assert error values are categorized
without copying raw provider text into Activity errors.

- [ ] **Step 2: Add failing driver/capability tests**

Prove:

- a correlated Claude task calls `stop_task` once;
- foreground/unmapped subagents expose no Stop target;
- the driver rejects Codex target variants;
- an authoritative unsupported response removes all Claude availability for the
  current runtime generation and future clicks fail before provider I/O;
- a replacement runtime may re-prove support independently;
- root `interrupt` is never written during targeted cancellation.

- [ ] **Step 3: Run focused tests and confirm red**

```bash
cargo test -p bibcode-server provider::claude::runtime::tests::stop_task -- --nocapture
cargo test -p bibcode-server --test production_provider_runtime claude_targeted_activity -- --nocapture
```

Expected: `stop_task` is absent and control queries currently collapse errors to `Option`.

- [ ] **Step 4: Implement the typed control query path**

Add `StopTask { task_id: String }` and `ClaudeControlRequest::stop_task`.
Refactor the shared query internals to return a typed enum:

```rust
enum ClaudeControlQueryOutcome {
    Success(Value),
    Unsupported,
    Timeout,
    Closed,
    Failed,
}
```

Keep context-usage and MCP callers adapting this result back to their current
optional semantics. Cancellation consumes the complete outcome.

- [ ] **Step 5: Gate and downgrade support safely**

Treat targeted task control as provisionally supported only when the existing
Claude compatibility probe reports both `--include-hook-events` and
`--forward-subagent-text`, and an exact task correlation exists. Do not issue a
destructive probe. The first authoritative unsupported response downgrades the
current runtime generation, clears its exact targets through the control
registry, and publishes `unsupported`. Do not persist the downgrade across a
new executable/runtime generation.

- [ ] **Step 6: Run focused and broader Claude control tests**

```bash
cargo test -p bibcode-server provider::claude::runtime::tests -- --nocapture
cargo test -p bibcode-server --test provider_claude -- --nocapture
cargo test -p bibcode-server --test production_provider_runtime claude -- --nocapture
```

Expected: all pass; targeted cancellation writes only `stop_task`, and an
unsupported runtime fails closed after one authoritative response.

- [ ] **Step 7: Commit Claude targeted dispatch**

```bash
git add apps/server/src/provider/claude/runtime.rs apps/server/src/production/provider_runtime.rs apps/server/tests/production_provider_runtime.rs apps/server/tests/provider_claude.rs
git commit -m "feat(claude): stop exact background tasks"
```

---

### Task 9: Add Client-Runtime Control Reduction and Single-Flight Commands

**Files:**
- Modify: `packages/client-runtime/src/state/activityReducer.ts`
- Modify: `packages/client-runtime/src/state/activity.ts`
- Modify: `packages/client-runtime/src/state/activityReducer.test.ts`
- Modify: `packages/client-runtime/src/state/activity.test.ts`
- Modify: `packages/client-runtime/src/state/activityLoad.test.ts`
- Modify: `packages/client-runtime/src/environment/knownEnvironment.test.ts`

**Interfaces:**
- Consumes: Activity protocol v2 from Task 1
- Produces: independent control-snapshot/delta reducer
- Produces: `environmentActivity.cancelSubtree` and `retrySubtreeCancellation`

- [ ] **Step 1: Add failing control reducer tests**

Cover:

- initial combined snapshot;
- actor control and operation upsert/remove;
- duplicate control delta ignored;
- control revision gap requests only snapshot recovery;
- observation delta applies while control revision is unchanged;
- control delta applies while observation revision is unchanged;
- scope mismatch is ignored and triggers no cross-scope merge;
- terminal observation can coexist briefly with requested control until the
  server removal delta arrives;
- a replacement full snapshot atomically replaces both domains.

- [ ] **Step 2: Add failing negotiation/stream tests**

Change supported negotiation expectation to exactly `2`. Prove `1`, `null`,
and unknown future versions remain unsupported. Update
`knownEnvironment.test.ts` to preserve v2 capability data. Add stream tests for
`control-snapshot` and `control-delta`, reconnect restoration of requested or
partial operations, and feature-disable cleanup.

- [ ] **Step 3: Add failing command-concurrency tests**

Use a shared `createAtomCommandScheduler()` and assert:

- duplicate cancel calls for environment/scope/actor share one in-flight RPC;
- different actors run independently;
- retry single-flight key is environment/scope/root/operation revision;
- command input contains canonical IDs and revisions only;
- command failure does not invent local `Stopping` state.

Use these keys:

```typescript
JSON.stringify([environmentId, input.scopeId, input.actorId])
JSON.stringify([environmentId, input.scopeId, input.rootActorId, input.expectedOperationRevision])
```

- [ ] **Step 4: Run client-runtime tests and confirm red**

```bash
vp test packages/client-runtime/src/environment/knownEnvironment.test.ts packages/client-runtime/src/state/activityReducer.test.ts packages/client-runtime/src/state/activity.test.ts packages/client-runtime/src/state/activityLoad.test.ts
```

Expected: v2 stream variants and commands are not handled.

- [ ] **Step 5: Implement independent control reduction**

Keep `ActivitySnapshot.control.revision` independent of
`ActivitySnapshot.revision`. A control gap calls `activity.getSnapshot`; do not
fabricate a delta or reset retained observation before recovery succeeds.

Add lookup helpers:

```typescript
export function activityActorControl(
  snapshot: ActivitySnapshot,
  actorId: ActivityRecordId,
): ActivityActorControl | null;

export function activityCancellationOperation(
  snapshot: ActivitySnapshot,
  rootActorId: ActivityRecordId,
): ActivityCancellationOperationSummary | null;
```

- [ ] **Step 6: Implement the command families**

Use `createEnvironmentRpcCommand`, one shared scheduler, and `singleFlight`.
Do not optimistically mutate Activity state. The accepted RPC result is an
admission acknowledgement; the control stream supplies `requested`/partial
state.

- [ ] **Step 7: Run client-runtime coverage**

```bash
vp test packages/client-runtime/src/environment/knownEnvironment.test.ts packages/client-runtime/src/state/activityReducer.test.ts packages/client-runtime/src/state/activity.test.ts packages/client-runtime/src/state/activityLoad.test.ts
```

Expected: all pass, including independent gap recovery and command key tests.

- [ ] **Step 8: Commit client runtime support**

```bash
git add packages/client-runtime/src/state/activityReducer.ts packages/client-runtime/src/state/activity.ts packages/client-runtime/src/state/activityReducer.test.ts packages/client-runtime/src/state/activity.test.ts packages/client-runtime/src/state/activityLoad.test.ts packages/client-runtime/src/environment/knownEnvironment.test.ts
git commit -m "feat(client-runtime): consume activity cancellation state"
```

---

### Task 10: Add the Subagents Stop Button and Residual Retry UI

**Files:**
- Modify: `apps/web/src/components/ChatView.tsx`
- Modify: `apps/web/src/components/activity/ActivityPanel.tsx`
- Modify: `apps/web/src/components/activity/ActivityRoster.tsx`
- Create: `apps/web/src/components/activity/ActivityRoster.test.tsx`
- Modify: `apps/web/src/components/activity/ActivityPanel.test.tsx`
- Modify: `apps/web/src/components/ChatView.hooks.test.tsx`
- Modify: `apps/web/src/components/ChatView.test.tsx`
- Modify: `apps/web/src/components/ThreadTerminalPanel.interactions.test.tsx`
- Modify: `apps/web/src/components/activity/ActivityDock.test.tsx`
- Modify: `apps/web/src/components/activity/ProviderTerminalActivityDock.test.tsx`
- Modify: `apps/web/src/components/activity/activityPresentation.test.ts`

**Interfaces:**
- Consumes: `environmentActivity.cancelSubtree`, `retrySubtreeCancellation`
- Produces: `onCancelActor` and `onRetryCancellation` panel callbacks

- [ ] **Step 1: Add failing row DOM/accessibility tests**

Render active actor rows for available, requested, unsupported, and terminal
states. Assert:

- only active+available has a persistent trailing Stop button;
- requested shows `Stopping` and a disabled Stop button;
- unsupported omits the button rather than rendering a disabled mystery icon;
- done actors omit the button;
- the main detail action and Stop are sibling buttons, never nested;
- Stop has a visible focus class, keyboard activation, and tooltip;
- label is `Stop Lovelace` for zero descendants and
  `Stop Lovelace and 2 child agents` for two descendants;
- clicking Stop does not call detail navigation;
- narrow panel markup keeps the label truncatable and Stop non-shrinking.

- [ ] **Step 2: Add failing panel/banner tests**

Assert a partial operation renders:

```text
Some agents are still running. 2 remaining.
Retry remaining
```

The retry callback must receive root actor and operation revision from the
server summary only. Requested operations render no error banner. Stale,
unsupported, provider-unavailable, and timeout command failures preserve the
last Activity lifecycle.

- [ ] **Step 3: Add failing ChatView binding tests**

Mock `useAtomCommand` and prove:

- row Stop calls `activity.cancelSubtree` with environment, scope, actor ID,
  and current control revision;
- retry calls `activity.retrySubtreeCancellation` with root and operation revision;
- failure maps to bounded user copy and never exposes the mocked native error payload;
- duplicate DOM clicks still produce one client-runtime in-flight command;
- terminal Activity surfaces receive no mutation callback.

- [ ] **Step 4: Run web tests and confirm red**

```bash
vp test apps/web/src/components/activity/ActivityRoster.test.tsx apps/web/src/components/activity/ActivityPanel.test.tsx apps/web/src/components/activity/ActivityDock.test.tsx apps/web/src/components/activity/ProviderTerminalActivityDock.test.tsx apps/web/src/components/activity/activityPresentation.test.ts apps/web/src/components/ChatView.test.tsx apps/web/src/components/ChatView.hooks.test.tsx apps/web/src/components/ThreadTerminalPanel.interactions.test.tsx
```

Expected: the Activity panel is read-only and row content is one full-width button.

- [ ] **Step 5: Refactor the row into sibling controls**

Use a wrapper with a main ghost `Button` and a trailing icon button. Reuse the
composer's stop-square visual language:

```tsx
<svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
  <rect x="2" y="2" width="8" height="8" rx="1.5" />
</svg>
```

Wrap the trailing button with existing `Tooltip`, `TooltipTrigger`, and
`TooltipPopup`. `onClick` and `onPointerDown` must stop propagation. Preserve
row focus restoration by registering the main detail button, not the wrapper or
Stop button.

- [ ] **Step 6: Render server-authoritative state and partial retry**

Join roster page `actorControls` by actor ID; fall back to snapshot controls for
the initially visible actors. Never infer `requested` from local command
pending. Show the server's safe message plus residual count, and label the
action exactly `Retry remaining`.

- [ ] **Step 7: Bind commands and safe failures in ChatView**

Use `useAtomCommand(..., { reportFailure: false })`. On failure, discriminate
typed `ActivityError.reason` and present fixed user copy. Never display
`Cause.pretty`, provider payloads, or raw server error strings in the panel.

- [ ] **Step 8: Run focused web tests**

Before running, migrate all existing web Activity snapshot builders to
`protocolVersion: 2`, add an empty/control-appropriate `control` snapshot, and
add `targetedActorCancellation: false` unless that fixture explicitly exercises
the new structured-chat control. Provider-terminal fixtures remain read-only.

```bash
vp test apps/web/src/components/activity/ActivityRoster.test.tsx apps/web/src/components/activity/ActivityPanel.test.tsx apps/web/src/components/activity/ActivityDock.test.tsx apps/web/src/components/activity/ProviderTerminalActivityDock.test.tsx apps/web/src/components/activity/activityPresentation.test.ts apps/web/src/components/ChatView.test.tsx apps/web/src/components/ChatView.hooks.test.tsx apps/web/src/components/ThreadTerminalPanel.interactions.test.tsx
```

Expected: all pass, including keyboard, tooltip, no-navigation, and retry-boundary assertions.

- [ ] **Step 9: Commit the Activity row controls**

```bash
git add apps/web/src/components/ChatView.tsx apps/web/src/components/ChatView.test.tsx apps/web/src/components/ChatView.hooks.test.tsx apps/web/src/components/ThreadTerminalPanel.interactions.test.tsx apps/web/src/components/activity/ActivityPanel.tsx apps/web/src/components/activity/ActivityRoster.tsx apps/web/src/components/activity/ActivityRoster.test.tsx apps/web/src/components/activity/ActivityPanel.test.tsx apps/web/src/components/activity/ActivityDock.test.tsx apps/web/src/components/activity/ProviderTerminalActivityDock.test.tsx apps/web/src/components/activity/activityPresentation.test.ts
git commit -m "feat(web): stop activity subagent subtrees"
```

---

### Task 11: Prove Cross-Layer Isolation and Reconnect Behavior

**Files:**
- Modify: `apps/server/tests/activity_rpc.rs`
- Modify: `apps/server/tests/production_provider_runtime.rs`
- Modify: `apps/server/tests/provider_codex.rs`
- Modify: `apps/server/tests/provider_claude.rs`
- Modify: `packages/client-runtime/src/state/activityLoad.test.ts`
- Create: `apps/web/src/components/ActivitySurfaces.test.tsx`

- [ ] **Step 1: Add the Codex integration scenario**

Use a fixture with root, sibling `alpha`, sibling `beta`, nested
`alpha/child`, and a late `alpha/late`. Cancel `alpha` and assert captured App
Server requests target only alpha's three child thread/turn pairs. Continue
emitting beta/root events and assert they remain live. Reconnect the Activity
stream mid-operation and assert its control snapshot restores `requested`.

- [ ] **Step 2: Add the Claude integration scenario**

Use two exactly correlated sibling tasks and one nested task. Cancel one sibling
and assert only its correlated task IDs receive `stop_task`; the other sibling
and root keep producing activity. Include an unmapped foreground subagent and
assert it remains observable without a Stop button.

- [ ] **Step 3: Add failure/retry and replacement scenarios**

Force one descendant timeout and one success. Assert the server publishes a
partial operation with one residual, reconnect preserves it, retry targets only
that residual, and a new runtime generation rejects the old operation revision
without provider I/O.

- [ ] **Step 4: Add responsive and keyboard surface tests**

Render both right-panel and sheet Activity surfaces. Tab to the trailing Stop
button, activate with Enter and Space, and verify focus/navigation behavior.
Assert no Stop action appears in terminal Activity.

- [ ] **Step 5: Run cross-layer tests**

```bash
cargo test -p bibcode-server --test activity_rpc cancellation -- --nocapture
cargo test -p bibcode-server --test production_provider_runtime targeted_activity -- --nocapture
cargo test -p bibcode-server --test provider_codex targeted_cancel -- --nocapture
cargo test -p bibcode-server --test provider_claude targeted_task -- --nocapture
vp test packages/client-runtime/src/state/activityLoad.test.ts apps/web/src/components/ActivitySurfaces.test.tsx
```

Expected: all pass; selected subtree stops, root/sibling continue, late child is
caught, reconnect restores server state, and retry never expands.

- [ ] **Step 6: Commit cross-layer proofs**

```bash
git add apps/server/tests/activity_rpc.rs apps/server/tests/production_provider_runtime.rs apps/server/tests/provider_codex.rs apps/server/tests/provider_claude.rs packages/client-runtime/src/state/activityLoad.test.ts apps/web/src/components/ActivitySurfaces.test.tsx
git commit -m "test(activity): prove targeted cancellation isolation"
```

---

### Task 12: Update Living Documentation and Complete Verification

**Files:**
- Modify: `docs/architecture/activity-observation.md`
- Modify: `docs/architecture/rpc-and-orchestration.md`
- Modify: `docs/providers/codex.md`
- Modify: `docs/providers/claude.md`
- Modify: `docs/user/workspace-ui.md`
- Modify: `docs/superpowers/specs/2026-08-11-targeted-activity-subtree-cancellation-design.md`

- [ ] **Step 1: Update living architecture and provider documents**

Document these current invariants explicitly:

- Activity is observation plus capability-gated targeted control, not globally read-only;
- observation persists but control overlay/handles/operations do not;
- control and observation have independent monotonic revisions;
- mutation authorization is `orchestration:operate` and terminal scopes remain read-only;
- Codex uses verified child thread plus active child turn and rejects root fallback;
- Claude uses exact Agent-tool/task correlation and `stop_task` only;
- `Stopping` is server-authoritative intent while provider events own terminal lifecycle;
- partial retry is confined to residuals under the original fence.

Update the approved design's implementation status only after code and tests are complete.

- [ ] **Step 2: Run formatting and focused TypeScript suites**

```bash
vp run fmt
vp test packages/contracts/src/activity.test.ts packages/contracts/src/environment.test.ts packages/contracts/src/rpc.test.ts packages/contracts/src/rpcRustParity.test.ts
vp test packages/client-runtime/src/environment/knownEnvironment.test.ts packages/client-runtime/src/state/activityReducer.test.ts packages/client-runtime/src/state/activity.test.ts packages/client-runtime/src/state/activityLoad.test.ts
vp test apps/web/src/components/activity/ActivityRoster.test.tsx apps/web/src/components/activity/ActivityPanel.test.tsx apps/web/src/components/ChatView.hooks.test.tsx apps/web/src/components/ActivitySurfaces.test.tsx
```

Expected: formatting succeeds and every focused TypeScript test passes.

- [ ] **Step 3: Run focused and broader Rust suites**

```bash
cargo fmt --all --check
cargo test -p bibcode-server activity::control::tests -- --nocapture
cargo test -p bibcode-server activity::cancellation::tests -- --nocapture
cargo test -p bibcode-server --test activity_rpc -- --nocapture
cargo test -p bibcode-server --test activity_load -- --nocapture
cargo test -p bibcode-server --test auth_http -- --nocapture
cargo test -p bibcode-server --test production_provider_runtime -- --nocapture
cargo test -p bibcode-server --test provider_codex -- --nocapture
cargo test -p bibcode-server --test provider_claude -- --nocapture
```

Expected: all pass.

- [ ] **Step 4: Run repository-required gates**

```bash
vp check
vp run typecheck
cargo clippy -p bibcode-server --all-targets -- -D warnings
```

Expected: all pass with no warnings.

- [ ] **Step 5: Review generated and source diffs**

```bash
git diff --check
git status --short
git diff --stat
git diff -- packages/contracts/fixtures/rpc-wire packages/contracts/fixtures/auth-http
rg -n "turn/interrupt|root.*fallback|semantic.*match" apps/server/src/activity apps/server/src/provider/codex apps/server/src/provider/claude
```

Expected: only intentional files changed; fixtures are generator-owned; no
debug output, native identifiers, dependency drift, root fallback, or semantic
Claude correlation entered the implementation.

- [ ] **Step 6: Commit documentation and final cleanup**

```bash
git add docs/architecture/activity-observation.md docs/architecture/rpc-and-orchestration.md docs/providers/codex.md docs/providers/claude.md docs/user/workspace-ui.md docs/superpowers/specs/2026-08-11-targeted-activity-subtree-cancellation-design.md
git commit -m "docs(activity): document targeted subtree cancellation"
```

- [ ] **Step 7: Record completion evidence**

In the implementation handoff, report every validation command, its result,
any command that could not run, and residual risk. If any required command is
blocked by missing workspace dependencies, report the exact missing packages
and do not claim completion until the environment is repaired and the command
passes.
