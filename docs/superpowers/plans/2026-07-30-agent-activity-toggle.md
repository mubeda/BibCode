# Per-Environment Agent Activity Toggle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an enabled-by-default, per-environment setting that immediately removes agent activity UI and stops activity-specific backend work while retaining history and keeping provider chats and terminals functional.

**Architecture:** A shared Rust `AgentActivityController` is the hard admission boundary for activity writes, reads, streams, provider extraction, and terminal observation. `NativeServerControl` persists `enableAgentActivity` and delegates effective state transitions to a production coordinator, while React gates activity consumers using the same environment setting. Disable transitions fence stale events by generation, drain admitted work, interrupt unresolved records once, and emit bounded trace diagnostics.

**Tech Stack:** Rust, Tokio, Axum RPC, SQLite/rusqlite, Serde, TypeScript, Effect Schema/Effect Atom, React, Zustand, Vitest, Cargo test, Tauri 2.

## Global Constraints

- The setting is named `enableAgentActivity`, is scoped per environment/server, and defaults to `true`.
- Disabling must not stop or corrupt the underlying provider chat or terminal.
- Existing activity history must be retained; disabled-period events are not buffered or backfilled.
- Claude, Codex, and OpenCode are in scope. Cursor and Grok are not.
- A terminal launched while disabled receives no activity instrumentation and must be reopened after re-enabling to expose activity.
- An already-instrumented terminal may retain only the minimal dormant transport required to remain functional.
- Effective-state trace records occur only at startup and setting transitions, never per activity event.
- Trace fields use bounded counters and safe primitive values; never log prompts, output, transcripts, commands, credentials, or provider payloads.
- `BIBCODE_CLAUDE_KEYCHAIN_ACCESS` must remain unset during tests and UI verification.
- `vp check` and `vp run typecheck` must pass before completion.

---

## File Responsibility Map

### New files

- `apps/server/src/activity/controller.rs` — lock-free enabled snapshot, observation generation, admitted-operation drain, and lifecycle notifications.
- `apps/server/src/production/agent_activity.rs` — coordinates controller, projection finalization, provider runtimes, terminal observers, and transition tracing.

### Shared contract files

- `packages/contracts/src/settings.ts` — persisted `enableAgentActivity` server setting and patch type.
- `packages/contracts/src/settings.test.ts` — default, explicit values, patch decoding, and invalid input coverage.
- `packages/contracts/src/activity.ts` — `featureDisabled` activity error reason.
- `packages/contracts/src/activity.test.ts` — activity error schema coverage.

### Rust settings and production files

- `apps/server/src/server_settings/mod.rs` — native settings state/patch support used by terminal inventory.
- `apps/server/tests/server_settings_domain.rs` — native persistence and reload coverage.
- `apps/server/src/production/control.rs` — JSON settings default/validation/update and transition-handler attachment.
- `apps/server/src/production/runtime.rs` — startup ordering and production coordinator wiring.
- `apps/server/src/production/mod.rs` — exports the production activity coordinator.
- `apps/server/src/diagnostics/trace.rs` — bounded success-event records in the existing trace file.

### Activity projection and RPC files

- `apps/server/src/activity/mod.rs` — exports controller types.
- `apps/server/src/activity/projection.rs` — hard mutation/read gate, generation fencing, and final disable operation.
- `apps/server/src/activity/repository.rs` — one transaction that interrupts unresolved activity records without deleting history.
- `apps/server/src/activity/rpc.rs` — reject unary reads and terminate streams with `featureDisabled`.
- `apps/server/tests/activity_repository.rs` — retained history and single interruption coverage.
- `apps/server/tests/activity_rpc.rs` — unary/stream disable and re-enable coverage.
- `apps/server/tests/activity_load.rs` — concurrent drain, stale generation, and disabled no-work coverage.

### Structured provider files

- `apps/server/src/production/provider_runtime.rs` — dynamic activity state command and provider-driver interface.
- `apps/server/src/provider/codex/runtime.rs` — stop/restart Codex activity reconciliation and tracker work.
- `apps/server/src/provider/claude/runtime.rs` — bypass Claude hook/transcript activity extraction while disabled.
- `apps/server/src/provider/opencode/runtime.rs` — stop/restart OpenCode reconciliation and coalescing work.
- `apps/server/tests/production_provider_runtime.rs` — supervisor-level transition isolation.
- `apps/server/tests/provider_codex.rs` — Codex extraction/reconciliation coverage.
- `apps/server/tests/provider_claude.rs` — Claude extraction/recovery coverage.
- `apps/server/tests/provider_opencode.rs` — OpenCode extraction/reconciliation coverage.

### Provider terminal files

- `apps/server/src/provider_terminal/model.rs` — resumable observer-control contract and transition counts.
- `apps/server/src/provider_terminal/supervisor.rs` — pass-through while disabled and live observer registry.
- `apps/server/src/provider_terminal/codex.rs` — dormant remote observer with live TUI transport.
- `apps/server/src/provider_terminal/claude.rs` — dormant authenticated hook drain with no activity decoding.
- `apps/server/src/provider_terminal/opencode.rs` — dormant event subscription with live helper/attach transport.
- `apps/server/src/terminal/manager.rs` — fan out enable/disable to active prepared observers.
- `apps/server/tests/provider_terminal_supervisor.rs` — cross-provider launch, dormancy, resume, and cleanup coverage.

### Client and UI files

- `packages/client-runtime/src/state/activity.ts` — treat `featureDisabled` as an empty state and release activity query state immediately.
- `packages/client-runtime/src/state/activity.test.ts` — stream termination and no-retry coverage.
- `apps/web/src/components/settings/SettingsPanels.tsx` — Agents switch and reset control.
- `apps/web/src/components/settings/SettingsPanels.test.tsx` — settings copy, update, reset, and rollback coverage.
- `apps/web/src/components/ChatView.tsx` — gate chat dock/panel and remove stale Activity surfaces.
- `apps/web/src/components/ChatView.test.tsx` — immediate hide, panel close, and re-enable coverage.
- `apps/web/src/components/ThreadTerminalDrawer.tsx` — gate terminal dock using the terminal environment's setting.
- `apps/web/src/components/ThreadTerminalDrawer.test.tsx` — per-environment terminal activity gating.
- `apps/web/src/components/activity/ProviderTerminalActivityDock.test.tsx` — defensive disabled visibility coverage.

---

### Task 1: Persist the Per-Environment Setting

**Files:**
- Modify: `packages/contracts/src/settings.ts:451-623`
- Modify: `packages/contracts/src/settings.test.ts`
- Modify: `apps/server/src/server_settings/mod.rs:102-215`
- Modify: `apps/server/tests/server_settings_domain.rs`
- Modify: `apps/server/src/production/control.rs:700-1160`

**Interfaces:**
- Produces: `ServerSettings["enableAgentActivity"]: boolean`
- Produces: `ServerSettingsPatch["enableAgentActivity"]?: boolean`
- Produces: `ProviderSettingsState.enable_agent_activity: bool`
- Produces: `ServerSettingsPatch.enable_agent_activity: Option<bool>` in Rust
- Default: `true` in TypeScript and Rust

- [ ] **Step 1: Add failing TypeScript contract tests**

Add these assertions to `packages/contracts/src/settings.test.ts`:

```typescript
it("defaults agent activity to enabled", () => {
  expect(decodeServerSettings({}).enableAgentActivity).toBe(true);
  expect(DEFAULT_SERVER_SETTINGS.enableAgentActivity).toBe(true);
});

it("decodes explicit agent activity settings and patches", () => {
  expect(decodeServerSettings({ enableAgentActivity: false }).enableAgentActivity).toBe(false);
  expect(decodeServerSettingsPatch({ enableAgentActivity: false }).enableAgentActivity).toBe(false);
});

it("rejects a non-boolean agent activity setting", () => {
  expect(() => decodeServerSettings({ enableAgentActivity: "false" })).toThrow();
  expect(() => decodeServerSettingsPatch({ enableAgentActivity: 0 })).toThrow();
});
```

- [ ] **Step 2: Run the contract tests and confirm red**

Run:

```bash
vp test packages/contracts/src/settings.test.ts
```

Expected: the new tests fail because `enableAgentActivity` is not part of the schema.

- [ ] **Step 3: Add the TypeScript setting and patch field**

Add the boolean beside the other server feature settings:

```typescript
export const ServerSettings = Schema.Struct({
  enableAssistantStreaming: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
  enableProviderUpdateChecks: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(true)),
  ),
  enableAgentActivity: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(true)),
  ),
  automaticGitFetchInterval: Schema.DurationFromMillis.pipe(
    Schema.withDecodingDefault(
      Effect.succeed(Duration.toMillis(DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL)),
    ),
  ),
});
```

Add `enableAgentActivity: Schema.optionalKey(Schema.Boolean)` to `ServerSettingsPatch`.
Do not add it to `ClientSettings`; the server is authoritative per environment.

- [ ] **Step 4: Add failing Rust persistence and validation tests**

In `apps/server/tests/server_settings_domain.rs`, persist `false`, reload the
store, and assert the value survives:

```rust
#[tokio::test]
async fn agent_activity_setting_defaults_enabled_and_persists_disabled() {
    let state_dir = tempfile::tempdir().expect("state dir");
    let store = ProviderSettingsStore::new(state_dir.path());

    assert!(store.get().await.expect("default settings").enable_agent_activity);

    let updated = store
        .update(ServerSettingsPatch {
            enable_agent_activity: Some(false),
            ..ServerSettingsPatch::default()
        })
        .await
        .expect("disable agent activity");
    assert!(!updated.enable_agent_activity);

    let reloaded = ProviderSettingsStore::new(state_dir.path())
        .get()
        .await
        .expect("reloaded settings");
    assert!(!reloaded.enable_agent_activity);
}
```

In `apps/server/src/production/control.rs` tests, assert `{}` defaults to
`"enableAgentActivity": true`, an update to `false` is published and persisted,
and a string value is rejected.

- [ ] **Step 5: Run the Rust settings tests and confirm red**

Run:

```bash
cargo test -p bibcode-server --test server_settings_domain agent_activity -- --nocapture
cargo test -p bibcode-server production::control::tests::agent_activity -- --nocapture
```

Expected: compilation or assertions fail because the native field and JSON
validation do not exist.

- [ ] **Step 6: Implement Rust defaults, patching, and JSON validation**

Add native state:

```rust
const fn enabled_by_default() -> bool {
    true
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ProviderSettingsState {
    #[serde(default = "enabled_by_default")]
    pub enable_agent_activity: bool,
    pub automatic_git_fetch_interval: u64,
    pub add_project_base_directory: String,
    pub worktree_base_directory: String,
    pub providers: ProvidersState,
    pub provider_instances: BTreeMap<String, ProviderInstanceState>,
    pub provider_session_defaults: BTreeMap<String, ProviderSessionDefaultState>,
}

#[derive(Clone, Debug, Default)]
pub struct ServerSettingsPatch {
    pub enable_agent_activity: Option<bool>,
    pub automatic_git_fetch_interval_ms: Option<u64>,
    pub add_project_base_directory: Option<String>,
    pub worktree_base_directory: Option<String>,
    pub providers: Option<ProvidersPatch>,
    pub provider_instances: Option<BTreeMap<String, ProviderInstanceInput>>,
    pub provider_session_defaults: Option<BTreeMap<String, ProviderSessionDefaultState>>,
}
```

Set `enable_agent_activity: true` in `Default`, copy the patch in
`apply_patch`, add `"enableAgentActivity": true` in
`apply_settings_defaults`, and call:

```rust
validate_optional_bool(object, "enableAgentActivity")?;
```

Keep unknown-field round-tripping behavior unchanged.

- [ ] **Step 7: Run focused settings tests**

Run:

```bash
vp test packages/contracts/src/settings.test.ts
cargo test -p bibcode-server --test server_settings_domain -- --nocapture
cargo test -p bibcode-server production::control::tests -- --nocapture
```

Expected: all pass.

- [ ] **Step 8: Commit the setting contract**

```bash
git add packages/contracts/src/settings.ts packages/contracts/src/settings.test.ts apps/server/src/server_settings/mod.rs apps/server/tests/server_settings_domain.rs apps/server/src/production/control.rs
git commit -m "feat(settings): persist agent activity toggle"
```

---

### Task 2: Add the Hard Activity Gate and Projection Fence

**Files:**
- Create: `apps/server/src/activity/controller.rs`
- Modify: `apps/server/src/activity/mod.rs`
- Modify: `apps/server/src/activity/projection.rs:20-330`
- Modify: `apps/server/src/activity/repository.rs:44-362`
- Modify: `apps/server/tests/activity_repository.rs`
- Modify: `apps/server/tests/activity_load.rs`

**Interfaces:**
- Consumes: `enableAgentActivity` initial boolean from Task 1
- Produces: `AgentActivityController::new(enabled: bool) -> AgentActivityController`
- Produces: `AgentActivityController::snapshot() -> AgentActivityState`
- Produces: `AgentActivityController::admit() -> Option<AgentActivityAdmission>`
- Produces: `AgentActivityController::register_stream() -> Option<AgentActivityStreamRegistration>`
- Produces: `AgentActivityController::disable() -> Future<Output = AgentActivityDisableReport>`
- Produces: `AgentActivityController::enable() -> AgentActivityState`
- Produces: `AgentActivityController::subscribe() -> watch::Receiver<AgentActivityState>`
- Produces: `ActivityProjection::with_controller(repository, controller)`
- Produces: `ActivityProjection::interrupt_for_monitoring_disabled() -> ActivityResult<usize>`

- [ ] **Step 1: Write controller concurrency tests**

Create unit tests in `activity/controller.rs` for default state, generation
changes, admission rejection, and drain ordering:

```rust
#[tokio::test]
async fn disable_closes_admission_and_waits_for_existing_work() {
    let controller = AgentActivityController::new(true);
    let admission = controller.admit().expect("enabled admission");
    let before = controller.snapshot();

    let disabling = tokio::spawn({
        let controller = controller.clone();
        async move { controller.disable().await }
    });
    tokio::task::yield_now().await;

    assert!(controller.admit().is_none());
    assert!(!disabling.is_finished());
    drop(admission);

    let disabled = disabling.await.expect("disable task");
    assert!(!disabled.state.enabled);
    assert!(disabled.state.generation > before.generation);
}
```

Add a second test proving `enable()` advances the generation, publishes one
watch state, and permits admission again. Add a third test that registers two
stream guards, starts disablement, and proves `disable()` reports
`closed_subscriptions == 2` and does not complete until both guards drop.

- [ ] **Step 2: Run the controller test and confirm red**

Run:

```bash
cargo test -p bibcode-server activity::controller::tests -- --nocapture
```

Expected: compilation fails because `controller.rs` and its types do not exist.

- [ ] **Step 3: Implement the controller**

Use atomics for the event hot path and `Notify` only for disable transitions:

```rust
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct AgentActivityState {
    pub enabled: bool,
    pub generation: u64,
}

#[derive(Clone, Debug)]
pub struct AgentActivityController {
    inner: Arc<AgentActivityControllerInner>,
}

pub struct AgentActivityAdmission {
    inner: Arc<AgentActivityControllerInner>,
    generation: u64,
}

pub struct AgentActivityStreamRegistration {
    inner: Arc<AgentActivityControllerInner>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct AgentActivityDisableReport {
    pub state: AgentActivityState,
    pub closed_subscriptions: usize,
}

impl AgentActivityController {
    #[must_use]
    pub fn new(enabled: bool) -> Self;

    #[must_use]
    pub fn snapshot(&self) -> AgentActivityState;

    #[must_use]
    pub fn admit(&self) -> Option<AgentActivityAdmission>;

    #[must_use]
    pub fn register_stream(&self) -> Option<AgentActivityStreamRegistration>;

    pub async fn disable(&self) -> AgentActivityDisableReport;

    pub fn enable(&self) -> AgentActivityState;

    #[must_use]
    pub fn subscribe(&self) -> watch::Receiver<AgentActivityState>;
}
```

`admit()` must:

1. reject when `enabled` is false;
2. increment the bounded in-flight counter;
3. re-read enabled and generation;
4. return a guard only when both still match; and
5. decrement and notify on every rejected race and on `Drop`.

`disable()` must atomically close admission, advance generation once, publish
the closed state, capture the registered stream count, and await both zero
in-flight operations and zero registered streams using the
register-notification-before-check pattern. It must allocate nothing when
`snapshot()` rejects a disabled hot-path event. Stream registration uses the
same increment/recheck/drop pattern as mutation admission so a stream cannot
appear after the captured disabled generation.

- [ ] **Step 4: Add failing projection and repository tests**

Add tests proving:

- `ensure_scope` and `apply` return successful no-op results while disabled;
- `snapshot`, `list_roster`, and `list_detail` return
  `ActivityRepositoryError::FeatureDisabled` before database work;
- an admitted apply completes before `disable()` returns;
- an event carrying the previous generation cannot publish afterward;
- unresolved actors and work items are interrupted exactly once; and
- completed history remains queryable after re-enable; and
- publication-lock and retention-worker registries are empty after effective
  disablement.

Use the database queue observer in `activity_load.rs` to assert a disabled
mutation reserves zero database jobs:

```rust
let observer = database
    .observe_queue_for_integration_test()
    .expect("queue observer");
let deltas = projection
    .apply(scope_id, "disabled-event".to_owned(), mutations, now())
    .await
    .expect("disabled apply is a no-op");
assert!(deltas.is_empty());
assert_eq!(observer.snapshot().reserved_or_queued_jobs, 0);
```

- [ ] **Step 5: Run projection tests and confirm red**

Run:

```bash
cargo test -p bibcode-server --test activity_repository monitoring_disabled -- --nocapture
cargo test -p bibcode-server --test activity_load disabled_gate -- --nocapture
```

Expected: the new error, constructor, finalization method, and no-op behavior
are missing.

- [ ] **Step 6: Integrate the controller into projection and repository**

Add the error variant:

```rust
#[error("agent activity is disabled")]
FeatureDisabled,
```

Keep `ActivityProjection::new(repository)` as an enabled test-friendly
constructor. Add:

```rust
#[must_use]
pub fn with_controller(
    repository: ActivityRepository,
    controller: AgentActivityController,
) -> Self;
```

For `ensure_scope` and `apply`, acquire `AgentActivityAdmission` before any
publication lock or database call. Return `Ok(())` or `Ok(Vec::new())` when
admission is closed. Hold the admission through repository persistence,
broadcast, retention scheduling, and apply-completion publication.

For read methods, check `controller.snapshot().enabled` before calling the
repository and return `FeatureDisabled` when closed.

Generalize the repository's existing interruption transaction into:

```rust
pub async fn interrupt_unresolved_activity_scopes(
    &self,
    reason: &'static str,
) -> ActivityRepositoryResult<usize>;
```

The transaction must update every non-terminal actor and work item to
`Interrupted`, set terminal timestamps, append one bounded state entry with
reason `"Agent activity monitoring disabled"`, update counts/revisions, and
remain idempotent. `interrupt_for_monitoring_disabled()` calls this repository
method after controller admission has drained, bypassing normal closed-gate
mutation admission exactly once.

Retention workers must obtain and hold their own admission guard so
`disable()` also waits for activity-triggered retention database work.
After the drain and final interruption transaction, clear projection
publication-lock weak entries and assert the retention-worker registry is
empty. Do not cache snapshots or records in the controller.

- [ ] **Step 7: Run controller, repository, and load tests**

Run:

```bash
cargo test -p bibcode-server activity::controller::tests -- --nocapture
cargo test -p bibcode-server --test activity_repository -- --nocapture
cargo test -p bibcode-server --test activity_load -- --nocapture
```

Expected: all pass, including zero database reservations while disabled.

- [ ] **Step 8: Commit the hard gate**

```bash
git add apps/server/src/activity/controller.rs apps/server/src/activity/mod.rs apps/server/src/activity/projection.rs apps/server/src/activity/repository.rs apps/server/tests/activity_repository.rs apps/server/tests/activity_load.rs
git commit -m "feat(activity): gate projection by environment setting"
```

---

### Task 3: Terminate Activity RPC Work While Disabled

**Files:**
- Modify: `packages/contracts/src/activity.ts:264-268`
- Modify: `packages/contracts/src/activity.test.ts`
- Modify: `apps/server/src/activity/rpc.rs:48-340`
- Modify: `apps/server/tests/activity_rpc.rs`
- Modify: `packages/client-runtime/src/state/activity.ts`
- Modify: `packages/client-runtime/src/state/activity.test.ts`

**Interfaces:**
- Consumes: controller and projection from Task 2
- Produces: `ActivityError.reason = "featureDisabled"`
- Produces: `register_activity_rpc(registry, projection, controller)`
- Produces: stream termination with the same structured error
- Produces: client state transition to empty/unsupported without retry

- [ ] **Step 1: Add failing contract and RPC tests**

Extend the activity error schema test:

```typescript
expect(
  Schema.decodeUnknownSync(ActivityError)({
    _tag: "ActivityError",
    reason: "featureDisabled",
    message: "Agent activity is disabled for this environment.",
  }).reason,
).toBe("featureDisabled");
```

Add Rust RPC tests that:

1. subscribe while enabled;
2. receive the initial snapshot;
3. disable the controller;
4. receive one `ActivityError` chunk with `reason: "featureDisabled"`;
5. observe stream completion; and
6. verify new unary reads fail without reserving a database job.

- [ ] **Step 2: Run the focused tests and confirm red**

Run:

```bash
vp test packages/contracts/src/activity.test.ts packages/client-runtime/src/state/activity.test.ts
cargo test -p bibcode-server --test activity_rpc feature_disabled -- --nocapture
```

Expected: schema decoding and RPC assertions fail because the reason and
controller stream are not wired.

- [ ] **Step 3: Add the wire error and RPC gate**

Extend the schema literal:

```typescript
reason: Schema.Literals([
  "notFound",
  "invalidScope",
  "invalidCursor",
  "featureDisabled",
  "internal",
]),
```

Map `ActivityRepositoryError::FeatureDisabled` to:

```rust
json!({
    "_tag": "ActivityError",
    "reason": "featureDisabled",
    "message": "Agent activity is disabled for this environment.",
})
```

Change `register_activity_rpc` to accept the same controller used by the
projection. In `activity_stream`, register an
`AgentActivityStreamRegistration` and
subscribe to controller state before reading the initial snapshot. Hold the
registration until the stream task exits. Add the controller receiver to both
`tokio::select!` loops. When a disabled state arrives, send the structured
error once and return, dropping the registration so effective disablement can
complete. Unary methods continue through projection read methods so the hard
gate remains in one place.

- [ ] **Step 4: Make the Effect client treat disablement as a terminal empty state**

Add a schema guard and branch:

```typescript
function isFeatureDisabledActivityFailure(failure: unknown): boolean {
  return isActivityError(failure) && failure.reason === "featureDisabled";
}
```

When snapshot recovery or stream subscription sees this reason:

- set `stateUnsupported()`;
- retire active recovery tokens;
- do not schedule recovery/retry; and
- let Effect scope finalization release the stream immediately.

Set activity roster/detail query idle TTL to zero:

```typescript
export const ACTIVITY_QUERY_IDLE_TTL_MS = 0;
```

This releases cached roster/detail results when the disabled UI unmounts.

- [ ] **Step 5: Run RPC and client tests**

Run:

```bash
vp test packages/contracts/src/activity.test.ts packages/client-runtime/src/state/activity.test.ts
cargo test -p bibcode-server --test activity_rpc -- --nocapture
```

Expected: all pass; disabled streams end without recovery loops.

- [ ] **Step 6: Regenerate RPC fixtures if the activity error fixture changes**

Run:

```bash
vp run --filter @bibcode/contracts generate:rust-rpc-fixtures
git diff --check packages/contracts/fixtures/rpc-wire
```

Stage generated fixture changes only when the generator changed them.

- [ ] **Step 7: Commit RPC disablement**

```bash
git add packages/contracts/src/activity.ts packages/contracts/src/activity.test.ts packages/contracts/fixtures/rpc-wire apps/server/src/activity/rpc.rs apps/server/tests/activity_rpc.rs packages/client-runtime/src/state/activity.ts packages/client-runtime/src/state/activity.test.ts
git commit -m "feat(activity): stop RPC work while disabled"
```

---

### Task 4: Gate Structured Claude, Codex, and OpenCode Activity Extraction

**Files:**
- Modify: `apps/server/src/production/provider_runtime.rs:195-360, 896-1485, 1895-1965`
- Modify: `apps/server/src/provider/codex/runtime.rs`
- Modify: `apps/server/src/provider/claude/runtime.rs`
- Modify: `apps/server/src/provider/opencode/runtime.rs`
- Modify: `apps/server/tests/production_provider_runtime.rs`
- Modify: `apps/server/tests/provider_codex.rs`
- Modify: `apps/server/tests/provider_claude.rs`
- Modify: `apps/server/tests/provider_opencode.rs`

**Interfaces:**
- Consumes: `AgentActivityController` from Task 2
- Produces: `ProviderDriver::set_agent_activity_enabled(enabled)`
- Produces: `ProviderRuntimeSupervisor::set_agent_activity_enabled(enabled)`
- Produces: provider-specific tracker reset/reconciliation on a new generation

- [ ] **Step 1: Add failing supervisor and provider tests**

At supervisor level, launch one capable provider session, disable activity, feed
an activity-only event, and assert:

- the normal session remains ready;
- no activity database job or delta occurs;
- the driver receives `set_agent_activity_enabled(false)` exactly once; and
- enabling invokes `true`, ensures the thread scope, and accepts subsequent
  new-generation activity.

For each real provider runtime, extend its existing fixture test with this
red/green sequence:

```rust
driver
    .set_agent_activity_enabled(false)
    .await
    .expect("disable agent activity");
let disabled_output = driver.next_event().await.expect("disabled provider event");
assert!(disabled_output.activity.is_empty());

driver
    .set_agent_activity_enabled(true)
    .await
    .expect("enable agent activity");
let resumed_output = driver.next_event().await.expect("resumed provider event");
assert!(!resumed_output.activity.is_empty());
```

Feed the provider-native child event already used by the surrounding Codex,
Claude, or OpenCode fixture between each state change. Assert the provider's
existing reconciliation or tracker counter does not advance for the disabled
event and advances once after re-enable. Do not introduce production-only test
branches.

- [ ] **Step 2: Run provider tests and confirm red**

Run:

```bash
cargo test -p bibcode-server --test production_provider_runtime agent_activity_toggle -- --nocapture
cargo test -p bibcode-server --test provider_codex disabled_agent_activity -- --nocapture
cargo test -p bibcode-server --test provider_claude disabled_agent_activity -- --nocapture
cargo test -p bibcode-server --test provider_opencode disabled_agent_activity -- --nocapture
```

Expected: driver and supervisor transition methods do not exist.

- [ ] **Step 3: Add the dynamic driver contract and supervisor command**

Extend `ProviderDriver`:

```rust
fn set_agent_activity_enabled(
    &self,
    enabled: bool,
) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
    Box::pin(async { Ok(()) })
}
```

Add:

```rust
SupervisorMessage::SetAgentActivityEnabled {
    enabled: bool,
    response: oneshot::Sender<Result<usize, ProviderRuntimeError>>,
}
```

and:

```rust
pub async fn set_agent_activity_enabled(
    &self,
    enabled: bool,
) -> Result<usize, ProviderRuntimeError>;
```

The supervisor loop calls every live driver, counts successful sessions, and
continues after a provider-specific failure while returning the first bounded
error to the production coordinator.

Give `NativeProviderDriverFactory` an `AgentActivityController`. Preserve the
existing constructors by having them create an enabled controller for tests and
non-production callers. Add a production constructor that accepts the shared
controller. Pass the initial enabled snapshot to Codex, Claude, and OpenCode
driver creation, and call `set_agent_activity_enabled` once more immediately
before `driver.start()` to fence a launch-time settings race.

Replace the static `activity_enabled` meaning with `activity_capable`; consult
the controller before scope setup, activity batch cloning, lifecycle updates,
stale compensation, or projection. Prefix native activity idempotency keys with
the controller generation:

```rust
let native_event_key = format!(
    "activity:{}:{}",
    activity_controller.snapshot().generation,
    native_event_id.as_str(),
);
```

- [ ] **Step 4: Implement provider-specific disable and resume**

Implement the new driver call with these exact behaviors:

```rust
impl ProviderDriver for CodexDriver {
    fn set_agent_activity_enabled(
        &self,
        enabled: bool,
    ) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async move {
            self.runtime.set_agent_activity_enabled(enabled).await;
            Ok(())
        })
    }
}
```

- Codex: cancel the current reconciliation pass, clear pending reconciliation
  hints and tracker-only state on disable; on enable reset the tracker epoch and
  enqueue one immediate authoritative reconciliation.
- Claude: bypass `ClaudeActivityTracker::handle_value`, transcript recovery
  requests, and recovered transcript mutation building while disabled; on
  enable reset correlation state so the next authenticated hook establishes
  the new epoch.
- OpenCode: cancel reconciliation and coalesced activity-flush tasks, clear
  pending activity-only batches on disable; on enable reset tracker state and
  request one reconciliation.
- Cursor and Grok: use the trait's constant-time default; do not add activity
  state or capability.

Do not stop provider event pumps, normal message projection, approvals, tool
handling, or provider processes.

- [ ] **Step 5: Run all structured provider tests**

Run:

```bash
cargo test -p bibcode-server --test production_provider_runtime -- --nocapture
cargo test -p bibcode-server --test provider_codex -- --nocapture
cargo test -p bibcode-server --test provider_claude -- --nocapture
cargo test -p bibcode-server --test provider_opencode -- --nocapture
```

Expected: all pass; activity extraction is absent while normal provider events
continue.

- [ ] **Step 6: Commit structured provider gating**

```bash
git add apps/server/src/production/provider_runtime.rs apps/server/src/provider/codex/runtime.rs apps/server/src/provider/claude/runtime.rs apps/server/src/provider/opencode/runtime.rs apps/server/tests/production_provider_runtime.rs apps/server/tests/provider_codex.rs apps/server/tests/provider_claude.rs apps/server/tests/provider_opencode.rs
git commit -m "feat(activity): pause structured provider tracking"
```

---

### Task 5: Make Provider Terminal Observation Dynamically Dormant

**Files:**
- Modify: `apps/server/src/provider_terminal/model.rs:466-900`
- Modify: `apps/server/src/provider_terminal/supervisor.rs:212-470`
- Modify: `apps/server/src/provider_terminal/codex.rs:341-520`
- Modify: `apps/server/src/provider_terminal/claude.rs:391-590`
- Modify: `apps/server/src/provider_terminal/opencode.rs:399-610`
- Modify: `apps/server/src/terminal/manager.rs:331-740, 1190-1465`
- Modify: `apps/server/tests/provider_terminal_supervisor.rs`

**Interfaces:**
- Consumes: `AgentActivityController` from Task 2
- Produces: `TerminalAgentActivityTransition`
- Produces: `PreparedTerminalObserver::set_agent_activity_enabled`
- Produces: `TerminalManager::set_agent_activity_enabled`
- Produces: pass-through launch before any observer preparation when disabled

- [ ] **Step 1: Add failing cross-provider terminal tests**

Add supervisor tests for:

1. disabled launch returns `PassThrough` before inventory lookup, capability
   probe, executable pin, hook overlay, listener, helper, or remote connection;
2. disabling an already-observed terminal leaves its PTY/process alive;
3. no publisher mutation occurs while dormant;
4. re-enabling an instrumented terminal resumes new activity;
5. a terminal launched while disabled remains unobserved after re-enable; and
6. terminal exit removes dormant state and owned resources.

Use counting fake factories and observer handles:

```rust
#[derive(Default)]
struct CountingObserver {
    disabled: AtomicUsize,
    enabled: AtomicUsize,
}

assert_eq!(factory.prepare_calls.load(Ordering::Acquire), 0);
assert_eq!(publisher.apply_calls.load(Ordering::Acquire), 0);
assert_eq!(terminal_probe.is_alive(), true);
```

- [ ] **Step 2: Run the terminal supervisor tests and confirm red**

Run:

```bash
cargo test -p bibcode-server --test provider_terminal_supervisor agent_activity_toggle -- --nocapture
```

Expected: transition interfaces and disabled short-circuiting are missing.

- [ ] **Step 3: Add resumable observer-control interfaces**

Add bounded counts:

```rust
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct TerminalAgentActivityTransition {
    pub stopped: usize,
    pub dormant: usize,
    pub resumed: usize,
    pub failed: usize,
}
```

Extend `PreparedTerminalObserver`:

```rust
fn set_agent_activity_enabled(
    &self,
    enabled: bool,
    generation: TerminalObserverGeneration,
    workers: TerminalObserverWorkerContext,
) -> Pin<Box<dyn Future<Output = TerminalAgentActivityTransition> + Send + '_>>;
```

Add the same fan-out operation to `PreparedObserverHandle` and:

```rust
pub async fn set_agent_activity_enabled(
    &self,
    enabled: bool,
) -> TerminalAgentActivityTransition;
```

to `TerminalManager`. Snapshot live generations under the existing bounded
registry, release the registry lock, then await observer callbacks. Never hold
the manager lifecycle lock across provider I/O.

- [ ] **Step 4: Gate terminal launch preparation**

Give `ProviderTerminalActivitySupervisor` an `AgentActivityController`.
At the first line of `prepare_inner`, return `PassThrough` when disabled:

```rust
if !self.activity_controller.snapshot().enabled {
    return TerminalLaunchPreparation::PassThrough;
}
```

This check must precede `authority.current()`, executable validation,
`factory_for`, capability probes, runtime directory generation, and helper
startup. Recheck the controller generation before returning
`TerminalLaunchPreparation::Prepared`; clean prepared resources and return
`PassThrough` if disablement raced preparation.

Add the controller parameter to `new_with_authority`. Preserve
`ProviderTerminalActivitySupervisor::new` as a test convenience that supplies
an enabled controller, and update production runtime to call the explicit
shared-controller constructor.

- [ ] **Step 5: Implement provider dormancy**

Use one provider-independent active/dormant atomic state per prepared observer
and provider-specific resource behavior:

- Codex: cancel the activity remote client/reconciliation task but retain the
  app-server helper and endpoint used by the running remote TUI. Re-enable by
  reconnecting the activity remote client to that endpoint.
- Claude: keep the launch overlay and listener only because the running CLI
  already contains the hook configuration. In dormant mode, authenticate and
  return a bounded success response without deserializing activity bodies,
  touching `ClaudeActivityTracker`, publishing mutations, or retaining request
  data. Re-enable normal authenticated decoding.
- OpenCode: cancel the activity event subscription but keep the helper and
  owned root session used by the attached TUI. Re-enable by creating a fresh
  authenticated activity subscription to the same endpoint/root.

Every resume starts with the current controller generation. The publisher
rechecks admission, so a callback that races disablement becomes a no-op.
Cleanup on terminal exit removes endpoint credentials, overlay files,
generation directories, helper processes, and restart descriptors.

- [ ] **Step 6: Run provider terminal tests**

Run:

```bash
cargo test -p bibcode-server --test provider_terminal_supervisor -- --nocapture
```

Expected: all existing and new terminal lifecycle tests pass.

- [ ] **Step 7: Commit terminal dormancy**

```bash
git add apps/server/src/provider_terminal/model.rs apps/server/src/provider_terminal/supervisor.rs apps/server/src/provider_terminal/codex.rs apps/server/src/provider_terminal/claude.rs apps/server/src/provider_terminal/opencode.rs apps/server/src/terminal/manager.rs apps/server/tests/provider_terminal_supervisor.rs
git commit -m "feat(activity): pause provider terminal observers"
```

---

### Task 6: Coordinate Effective State and Add Low-Overhead Trace Records

**Files:**
- Create: `apps/server/src/production/agent_activity.rs`
- Modify: `apps/server/src/production/mod.rs`
- Modify: `apps/server/src/production/runtime.rs:95-255`
- Modify: `apps/server/src/production/control.rs:91-330`
- Modify: `apps/server/src/diagnostics/trace.rs:22-90`
- Modify: `apps/server/tests/production_provider_runtime.rs`
- Modify: `apps/server/tests/production_server_terminal_rpc.rs`

**Interfaces:**
- Consumes: settings from Task 1, controller/projection from Task 2, provider transitions from Tasks 4-5
- Produces: `AgentActivitySettingsHandler`
- Produces: `ProductionAgentActivity::transition`
- Produces: bounded `AgentActivityTransitionReport`
- Produces: `TraceDiagnosticsStore::record_event`

- [ ] **Step 1: Add failing trace and coordinator tests**

Add trace-store coverage that records an event, reads aggregation, and verifies
bounded safe attributes:

```rust
store
    .record_event(
        "agent_activity_disabled",
        json!({
            "enabled": false,
            "settingsGeneration": 4,
            "observationGeneration": 7,
            "closedSubscriptions": 2,
            "stoppedObservers": 3,
            "dormantObservers": 1,
            "resumedObservers": 0,
            "failedObservers": 0,
            "finalizedRecords": 5,
            "durationMs": 12,
        }),
    )
    .expect("record effective state");
```

Add coordinator tests proving:

- requested trace precedes transition;
- effective-disabled trace occurs after gate drain, record finalization, RPC
  closure, provider disable, and terminal dormancy;
- repeated `false` is idempotent;
- enabling remains effective when one observer resume fails and reports
  `failedObservers: 1`;
- an invariant-level coordinator failure records one bounded
  `agent_activity_transition_failed` event; and
- 10,000 rejected activity events create no additional trace records.

- [ ] **Step 2: Run focused coordinator tests and confirm red**

Run:

```bash
cargo test -p bibcode-server diagnostics::trace::tests::agent_activity -- --nocapture
cargo test -p bibcode-server production::agent_activity::tests -- --nocapture
```

Expected: module, handler, report, and trace event API are missing.

- [ ] **Step 3: Add bounded trace success events**

Implement:

```rust
pub fn record_event(&self, name: &str, attributes: Value) -> io::Result<()>;
```

Encode the record in the existing `native-span` shape with:

- one bounded name;
- success exit;
- one event containing only the supplied redacted object; and
- the existing file-count and file-size rotation.

Reject non-object attributes and run `redact_sensitive_value` before
serialization. Call this synchronous API only from `tokio::task::spawn_blocking`
inside state transitions. Do not create a queue, timer, cache, or dedicated
thread.

- [ ] **Step 4: Implement the production coordinator**

Define:

```rust
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct AgentActivityTransitionReport {
    pub enabled: bool,
    pub settings_generation: u64,
    pub observation_generation: u64,
    pub closed_subscriptions: usize,
    pub stopped_observers: usize,
    pub dormant_observers: usize,
    pub resumed_observers: usize,
    pub failed_observers: usize,
    pub finalized_records: usize,
    pub duration_ms: u64,
}

pub trait AgentActivitySettingsHandler: Send + Sync {
    fn transition(
        &self,
        enabled: bool,
        settings_generation: u64,
    ) -> Pin<Box<dyn Future<Output = AgentActivityTransitionReport> + Send + '_>>;
}
```

`ProductionAgentActivity` holds clones of:

- `AgentActivityController`;
- `ActivityProjection`;
- `ProviderRuntimeSupervisor`;
- `TerminalManager`; and
- `TraceDiagnosticsStore`.

It also stores the stable environment identifier from the environment
descriptor for transition trace attributes.

Disable order:

1. emit `agent_activity_change_requested`;
2. call `controller.disable().await` and retain its
   `closed_subscriptions` count;
3. `projection.interrupt_for_monitoring_disabled().await`;
4. `provider_runtime.set_agent_activity_enabled(false).await`;
5. `terminal_manager.set_agent_activity_enabled(false).await`;
6. aggregate bounded counts; and
7. emit `agent_activity_disabled`.

Enable order:

1. emit requested;
2. `controller.enable()`;
3. enable provider runtimes;
4. resume terminal observers;
5. aggregate counts; and
6. emit `agent_activity_enabled`.

Log bounded provider failures with `tracing::warn!` once per transition and
count them in the effective event. Emit `agent_activity_transition_failed` only
for a coordinator invariant or transition operation that cannot reach the
requested hard state; include the requested boolean and bounded error category,
not a provider payload or unbounded error chain. The hard gate remains
authoritative even if observer cleanup reports failure.

- [ ] **Step 5: Attach transitions to persisted settings**

Add an attachable handler to `NativeServerControl`:

```rust
pub async fn attach_agent_activity_handler(
    &self,
    handler: Arc<dyn AgentActivitySettingsHandler>,
);

pub async fn agent_activity_enabled(&self) -> bool;
```

In `update_settings`:

1. capture the previous boolean;
2. validate and persist the patch;
3. increment settings generation;
4. if the boolean changed, await the attached handler;
5. update in-memory settings and publish `settingsUpdated`; and
6. return the updated settings.

If persistence fails, do not call the handler. Handler transition failures are
represented in the bounded report rather than rolling back a safely closed
gate.

Refactor `ProductionRuntime::start` so control loads settings before activity
services:

```rust
let control = Arc::new(
    NativeServerControl::with_trace_diagnostics(
        config.clone(),
        auth_descriptor,
        trace_diagnostics.clone(),
    )
    .await,
);
let activity_controller =
    AgentActivityController::new(control.agent_activity_enabled().await);
```

Construct projection, provider runtime, terminal supervisor, and terminal
manager with this controller. Register activity RPC with the same authority:

```rust
register_activity_rpc(
    &mut registry,
    activity_projection.clone(),
    activity_controller.clone(),
);
```

Create and attach `ProductionAgentActivity` after those services exist. Emit
exactly one startup effective-state trace with cause `"startup"` and do not run
a transition when the initial setting is disabled.

- [ ] **Step 6: Run production and trace tests**

Run:

```bash
cargo test -p bibcode-server production::agent_activity::tests -- --nocapture
cargo test -p bibcode-server production::control::tests -- --nocapture
cargo test -p bibcode-server diagnostics::trace::tests -- --nocapture
cargo test -p bibcode-server --test production_provider_runtime agent_activity -- --nocapture
cargo test -p bibcode-server --test production_server_terminal_rpc agent_activity -- --nocapture
```

Expected: all pass; event-volume assertions show constant transition log count.

- [ ] **Step 7: Commit production coordination and tracing**

```bash
git add apps/server/src/production/agent_activity.rs apps/server/src/production/mod.rs apps/server/src/production/runtime.rs apps/server/src/production/control.rs apps/server/src/diagnostics/trace.rs apps/server/tests/production_provider_runtime.rs apps/server/tests/production_server_terminal_rpc.rs
git commit -m "feat(activity): coordinate effective toggle state"
```

---

### Task 7: Add the Settings → Agents Toggle

**Files:**
- Modify: `apps/web/src/components/settings/SettingsPanels.tsx:862-1020`
- Modify: `apps/web/src/components/settings/SettingsPanels.test.tsx:809-900`
- Modify: `apps/web/src/hooks/useSettings.test.ts`

**Interfaces:**
- Consumes: `settings.enableAgentActivity` from Task 1
- Consumes: `useUpdatePrimarySettings()`
- Produces: accessible switch named `Agent activity for this environment`

- [ ] **Step 1: Add failing Settings panel tests**

Add tests for copy, default checked state, update, reset, and rejected update:

```typescript
it("renders the per-environment agent activity switch", () => {
  const markup = render(<AgentsSettingsPanel />);
  expect(markup).toContain("Agent activity for this environment");
  expect(markup).toContain(
    "Show live agent and background-task activity in chats and AI terminals.",
  );
});

it("updates and resets agent activity", () => {
  render(<AgentsSettingsPanel />);
  settingsUi.switch("Agent activity for this environment", false);
  expect(updateSettings).toHaveBeenCalledWith({ enableAgentActivity: false });
});
```

Extend the existing update hook test so a failed server command restores the
authoritative settings atom rather than leaving the optimistic value.

- [ ] **Step 2: Run Settings tests and confirm red**

Run:

```bash
vp test apps/web/src/components/settings/SettingsPanels.test.tsx apps/web/src/hooks/useSettings.test.ts
```

Expected: label and update assertions fail.

- [ ] **Step 3: Implement the Settings row**

Insert the row after Default Agent:

```tsx
<SettingsRow
  title="Agent activity for this environment"
  description="Show live agent and background-task activity in chats and AI terminals. Disabling this stops activity monitoring and collection."
  resetAction={
    settings.enableAgentActivity !== DEFAULT_SERVER_SETTINGS.enableAgentActivity ? (
      <SettingResetButton
        label="agent activity"
        onClick={() =>
          updateSettings({
            enableAgentActivity: DEFAULT_SERVER_SETTINGS.enableAgentActivity,
          })
        }
      />
    ) : null
  }
  control={
    <Switch
      checked={settings.enableAgentActivity}
      onCheckedChange={(checked) =>
        updateSettings({ enableAgentActivity: Boolean(checked) })
      }
      aria-label="Agent activity for this environment"
    />
  }
/>
```

Use `DEFAULT_SERVER_SETTINGS`, not a duplicated `true` literal. Preserve the
existing per-primary-environment routing used by the Agents settings page.

- [ ] **Step 4: Run Settings and settings-hook tests**

Run:

```bash
vp test apps/web/src/components/settings/SettingsPanels.test.tsx apps/web/src/hooks/useSettings.test.ts
```

Expected: all pass.

- [ ] **Step 5: Commit the Settings UI**

```bash
git add apps/web/src/components/settings/SettingsPanels.tsx apps/web/src/components/settings/SettingsPanels.test.tsx apps/web/src/hooks/useSettings.test.ts
git commit -m "feat(settings): add agent activity switch"
```

---

### Task 8: Tear Down Chat and Terminal Activity UI Immediately

**Files:**
- Modify: `apps/web/src/components/ChatView.tsx:1440-1460, 1800-1850, 5670-5830`
- Modify: `apps/web/src/components/ChatView.test.tsx`
- Modify: `apps/web/src/components/ThreadTerminalDrawer.tsx:680-710, 1695-1725`
- Modify: `apps/web/src/components/ThreadTerminalDrawer.test.tsx`
- Modify: `apps/web/src/components/activity/ProviderTerminalActivityDock.test.tsx`
- Modify: `packages/client-runtime/src/state/activity.test.ts`

**Interfaces:**
- Consumes: `useEnvironmentSettings(environmentId, selector)`
- Consumes: `useRightPanelStore.closeSurface`
- Produces: no activity atom, dock, panel, or cached query consumer while disabled

- [ ] **Step 1: Add failing chat UI tests**

Test a thread with visible activity:

1. render with `enableAgentActivity: true`;
2. assert the dock and Activity panel can render;
3. publish `settingsUpdated` with `false`;
4. assert the dock unmounts immediately;
5. assert `closeSurface(threadRef, "activity")` removes the Activity surface;
6. assert the activity stream cancellation finalizer ran; and
7. publish `true` and assert a new stream can mount.

Include a stale persisted Activity surface in the store before rendering with
the setting disabled and assert it is removed without an activity RPC call.

- [ ] **Step 2: Add failing terminal UI tests**

Render two terminal drawers belonging to different environment IDs. Set one
environment enabled and the other disabled. Assert:

```typescript
expect(enabledDrawer.queryByTestId("provider-terminal-activity-host")).not.toBeNull();
expect(disabledDrawer.queryByTestId("provider-terminal-activity-host")).toBeNull();
```

Then flip only the enabled environment to false and assert the terminal itself
remains mounted while its activity host disappears.

- [ ] **Step 3: Run frontend activity tests and confirm red**

Run:

```bash
vp test apps/web/src/components/ChatView.test.tsx apps/web/src/components/ThreadTerminalDrawer.test.tsx apps/web/src/components/activity/ProviderTerminalActivityDock.test.tsx packages/client-runtime/src/state/activity.test.ts
```

Expected: activity surfaces ignore the new setting.

- [ ] **Step 4: Gate ChatView and remove stale Activity surfaces**

Read:

```typescript
const enableAgentActivity = settings.enableAgentActivity;
```

Require it in `activityStateTarget`:

```typescript
const activityStateTarget = useMemo<ActivityStateTarget | null>(
  () =>
    enableAgentActivity &&
    activeThreadRef !== null &&
    activityScope !== null &&
    (isPanel || !siblingChatOwnsCenter)
      ? { environmentId: activeThreadRef.environmentId, input: activityScope }
      : null,
  [
    activeThreadRef,
    activityScope,
    enableAgentActivity,
    isPanel,
    siblingChatOwnsCenter,
  ],
);
```

Add an effect that removes an Activity surface when disabled:

```typescript
useEffect(() => {
  if (enableAgentActivity || activeThreadRef === null) return;
  const threadState = selectThreadRightPanelState(
    useRightPanelStore.getState().byThreadKey,
    activeThreadRef,
  );
  const activitySurface = threadState.surfaces.find(
    (surface) => surface.kind === "activity",
  );
  if (activitySurface) {
    useRightPanelStore.getState().closeSurface(activeThreadRef, activitySurface.id);
  }
}, [activeThreadRef, enableAgentActivity]);
```

Keep the existing `activityStateTarget !== null` guards around
`ActivityDockBinding` and `ActivityPanelBinding`. Because the target becomes
null, Effect atom scopes finalize and streams cancel.

- [ ] **Step 5: Gate terminal docks by their own environment**

Replace primary-only feature access with:

```typescript
const enableAgentActivity = useEnvironmentSettings(
  environmentId,
  (settings) => settings.enableAgentActivity,
);
```

Require `enableAgentActivity` in the condition that renders
`ProviderTerminalActivityDock`. Do not remove the terminal's
`ProviderTerminalActivityLaunch` metadata; the backend uses it for the accepted
instrumented-terminal resume path.

- [ ] **Step 6: Run frontend activity tests**

Run:

```bash
vp test apps/web/src/components/ChatView.test.tsx apps/web/src/components/ThreadTerminalDrawer.test.tsx apps/web/src/components/activity/ProviderTerminalActivityDock.test.tsx packages/client-runtime/src/state/activity.test.ts
```

Expected: all pass; terminal content remains mounted when the activity host is
removed.

- [ ] **Step 7: Commit frontend teardown**

```bash
git add apps/web/src/components/ChatView.tsx apps/web/src/components/ChatView.test.tsx apps/web/src/components/ThreadTerminalDrawer.tsx apps/web/src/components/ThreadTerminalDrawer.test.tsx apps/web/src/components/activity/ProviderTerminalActivityDock.test.tsx packages/client-runtime/src/state/activity.test.ts
git commit -m "feat(activity): hide disabled environment surfaces"
```

---

### Task 9: Verify Resource Shutdown, Trace Evidence, and Desktop UX

**Files:**
- No planned source modifications.
- Record implementation evidence in the final task report; do not add generated screenshots to Git.

**Interfaces:**
- Consumes: all previous task deliverables
- Produces: verified effective disable/re-enable behavior and clean repository state

- [ ] **Step 1: Run the complete focused TypeScript suite**

Run:

```bash
vp test packages/contracts/src/settings.test.ts packages/contracts/src/activity.test.ts packages/client-runtime/src/state/activity.test.ts apps/web/src/hooks/useSettings.test.ts apps/web/src/components/settings/SettingsPanels.test.tsx apps/web/src/components/ChatView.test.tsx apps/web/src/components/ThreadTerminalDrawer.test.tsx apps/web/src/components/activity/ActivityDock.test.tsx apps/web/src/components/activity/ActivityPanel.test.tsx apps/web/src/components/activity/ProviderTerminalActivityDock.test.tsx
```

Expected: all pass.

- [ ] **Step 2: Run the complete focused Rust suite**

Run:

```bash
env -u BIBCODE_CLAUDE_KEYCHAIN_ACCESS cargo test -p bibcode-server \
  --test server_settings_domain \
  --test activity_repository \
  --test activity_rpc \
  --test activity_load \
  --test production_provider_runtime \
  --test production_server_terminal_rpc \
  --test provider_claude \
  --test provider_codex \
  --test provider_opencode \
  --test provider_terminal_supervisor
```

Expected: all pass.

- [ ] **Step 3: Prove disabled load has no work or log growth**

Run the named load test with output:

```bash
env -u BIBCODE_CLAUDE_KEYCHAIN_ACCESS cargo test -p bibcode-server \
  --test activity_load disabled_gate_rejects_volume_without_work_or_trace_growth \
  -- --nocapture
```

Expected assertions:

- zero database queue reservations;
- zero projection deltas;
- zero active activity streams;
- zero terminal helper launches for disabled launches;
- bounded restart-descriptor count equal to live previously instrumented
  terminals; and
- exactly the startup/requested/effective transition trace records, independent
  of event volume.

- [ ] **Step 4: Run repository-wide required gates**

Run:

```bash
vp test
vp check
vp run typecheck
```

Expected: all pass with no formatting, lint, type, or test failures.

- [ ] **Step 5: Build the debug desktop application**

Run:

```bash
cd apps/desktop
env -u BIBCODE_CLAUDE_KEYCHAIN_ACCESS pnpm exec tauri build --debug
```

Expected: a debug application bundle is created under
`target/debug/bundle/macos/T4Code (Alpha).app`.

- [ ] **Step 6: Verify the enabled state with Computer Use**

Launch the newly built worktree application, not an installed copy. Register
the current worktree if needed. In a Codex chat, create one real subagent and
verify:

- the floating dock appears;
- collapsed/expanded states work;
- the roster and detail panel open; and
- retained history remains visible.

Open Claude Terminal, Codex Terminal, and OpenCode Terminal once while enabled
and confirm each eligible terminal can show the activity host. Confirm no macOS
Keychain prompt appears with `BIBCODE_CLAUDE_KEYCHAIN_ACCESS` unset.

- [ ] **Step 7: Verify immediate disablement with Computer Use**

Keep one instrumented provider terminal and one activity-enabled chat open.
Navigate to **Settings → Agents** and switch off
**Agent activity for this environment**. Verify:

- the chat dock disappears immediately;
- the terminal dock disappears immediately;
- an open Activity right panel closes;
- chat remains usable;
- the running terminal remains usable;
- newly opened Claude, Codex, and OpenCode terminals contain no activity host;
  and
- Cursor and Grok receive no new activity controls.

- [ ] **Step 8: Verify trace and resource evidence**

Use the existing trace diagnostics surface or `server.getTraceDiagnostics` and
confirm one bounded `agent_activity_disabled` record contains:

```text
enabled=false
settingsGeneration is a positive integer
observationGeneration is a positive integer
closedSubscriptions is a bounded nonnegative integer
stoppedObservers is a bounded nonnegative integer
dormantObservers is a bounded nonnegative integer
resumedObservers=0
failedObservers is a bounded nonnegative integer
finalizedRecords is a bounded nonnegative integer
durationMs is a bounded nonnegative integer
```

Inspect process/resource diagnostics and confirm terminals launched while
disabled did not start activity helper processes. Do not record prompt,
terminal output, transcript, command, credential, or provider payload content.

- [ ] **Step 9: Verify re-enable semantics with Computer Use**

Switch the setting on and verify:

- retained activity history returns;
- the already-instrumented terminal resumes new activity when supported;
- the terminal launched while disabled remains unmonitored;
- reopening that terminal enables observation; and
- the trace contains one bounded `agent_activity_enabled` record with resume
  and failure counts.

- [ ] **Step 10: Check the final diff**

Run:

```bash
git diff --check
git status --short --branch
```

Expected: no unstaged implementation changes and no whitespace errors. If
verification finds a defect, stop Task 9, return to the task that owns the
affected component, add a failing regression test there, implement the fix,
rerun that task's focused suite, commit it with that task's file list, and then
restart Task 9. Do not create an empty verification commit.
