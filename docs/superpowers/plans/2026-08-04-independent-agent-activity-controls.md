# Independent Chat and AI Terminal Agent Activity Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the shared agent-activity switch with independent, per-environment Chat and AI Terminal switches, default AI Terminal activity off, label both controls Experimental, and preserve source-specific correctness from settings through UI.

**Architecture:** Two `AgentActivityController` and `ActivityProjection` instances share the existing activity repository but own independent admission, generation, stream, observer, and transition lifecycles. `ActivityProjections` routes RPCs by `ActivityScopeRef`, structured provider runtimes receive only the Chat projection, and provider terminals receive only the AI Terminal projection. Settings migrate the legacy value into Chat while defaulting AI Terminal to false; React chooses the appropriate setting from the active activity scope.

**Tech Stack:** Rust, Tokio, Axum RPC, SQLite/rusqlite, Serde, TypeScript, Effect Schema, React, Zustand, Vitest/Vite+, Cargo test, Tauri 2, Codex Computer Use (`node_repl` + `@oai/sky`).

## Global Constraints

- The current settings are named `enableChatAgentActivity` and `enableTerminalAgentActivity`.
- Chat agent activity defaults to `true`; AI Terminal agent activity defaults to `false`.
- Both settings are scoped per environment/server and support all four boolean combinations.
- A legacy `enableAgentActivity` value migrates only to Chat; AI Terminal remains off unless explicitly enabled with the new field.
- Both Settings → Agents rows display visible text `Experimental` adjacent to the title.
- Disabling one source must not stop, drain, fence, hide, or otherwise change the other source.
- Disabling activity must not stop or corrupt the underlying provider chat or terminal.
- Existing activity history is retained; disabled-period events are not buffered or backfilled.
- A terminal launched while AI Terminal activity is disabled receives no activity instrumentation and must be reopened after enabling to expose activity.
- An already-instrumented terminal may retain only the existing minimal dormant transport required to remain functional.
- Trace records occur only at startup and settings transitions, include `source: "chat" | "terminal"`, and never include prompts, output, transcripts, commands, credentials, or provider payloads.
- Do not edit `.repos/`.
- Keep `BIBCODE_CLAUDE_KEYCHAIN_ACCESS` unset or disabled during tests and visual verification.
- `vp check` and `vp run typecheck` must pass before completion.
- Completion requires Codex Computer Use validation, saved screenshots, and careful full-resolution image inspection.

---

## File Responsibility Map

### Shared settings contract

- `packages/contracts/src/settings.ts` — canonical current setting names, defaults, and patch fields.
- `packages/contracts/src/settings.test.ts` — current defaults, independent patches, and invalid-value coverage.
- `packages/shared/src/serverSettings.test.ts` — proves independent fields survive ordinary server-settings patch merging.

### Native settings and migration

- `apps/server/src/server_settings/mod.rs` — one reusable legacy normalizer plus typed Rust state and patch fields.
- `apps/server/tests/server_settings_domain.rs` — fresh defaults, legacy migration, persistence, and reload matrix.
- `apps/server/src/production/control.rs` — JSON validation/defaults, legacy-key removal, persist-first dual transition dispatch, and settings publication.

### Activity routing and storage

- Create `apps/server/src/activity/routing.rs` — `AgentActivitySource` and `ActivityProjections` source router.
- `apps/server/src/activity/mod.rs` — exports routing types.
- `apps/server/src/activity/projection.rs` — source-specific monitoring-disabled finalization.
- `apps/server/src/activity/repository.rs` — filters unresolved-record interruption by persisted source kind.
- `apps/server/tests/activity_repository.rs` — shared-history and source-isolated finalization coverage.
- `apps/server/src/activity/rpc.rs` — routes reads and streams to the controller/projection selected by request scope.
- `apps/server/tests/activity_rpc.rs` — independent unary/stream disablement and generation fencing.
- `apps/server/tests/activity_load.rs` — concurrent source-isolation load coverage.

### Production lifecycle wiring

- `apps/server/src/production/agent_activity.rs` — source-aware coordinator, transition branching, and trace attributes.
- `apps/server/src/production/runtime.rs` — creates two controllers/projections and supplies each to the correct runtime boundary.
- `apps/server/src/production/control.rs` — invokes source-specific coordinator transitions after persistence.
- `apps/server/tests/production_server_terminal_rpc.rs` — terminal setting drives only terminal observer lifecycle.
- `apps/server/tests/production_provider_runtime.rs` — Chat setting drives only structured provider runtime lifecycle.

### Settings UI and selective consumers

- `apps/web/src/components/settings/settingsLayout.tsx` — reusable optional title tag slot.
- `apps/web/src/components/settings/SettingsPanels.tsx` — two switches, Experimental tags, descriptions, and independent reset actions.
- `apps/web/src/components/settings/SettingsPanels.test.tsx` — copy, badges, defaults, patches, and resets.
- `apps/web/src/hooks/useSettings.test.ts` — independent optimistic patch rollback coverage.
- `apps/web/src/components/ChatView.logic.ts` — pure scope-to-setting selection helper.
- `apps/web/src/components/ChatView.logic.test.ts` — all four source/setting selection cases.
- `apps/web/src/components/ChatView.tsx` — gates the thread or terminal activity panel by the active scope.
- `apps/web/src/components/ChatView.test.tsx` — closes only the disabled source and leaves the other source mounted.
- `apps/web/src/components/ThreadTerminalDrawer.tsx` — renders terminal activity only when the terminal setting is enabled.
- `apps/web/src/components/ThreadTerminalDrawer.test.tsx` — default-off and explicit terminal enablement.
- `apps/web/src/components/ThreadTerminalDrawer.interactions.test.tsx` — live terminal setting changes do not unmount the terminal.

### Acceptance and documentation

- `apps/desktop/e2e/support/activity-session.ts` — explicitly enables terminal activity for the existing deterministic provider-terminal activity fixture.
- `apps/desktop/e2e/support/activity-session.test.ts` — asserts the fixture sends the new setting.
- `docs/architecture/activity-observation.md` — documents independent controls and default-off terminal instrumentation.
- `.artifacts/visual-qa/independent-agent-activity/` — ignored local screenshots produced by Computer Use; never commit these files.

---

### Task 1: Replace the Shared TypeScript Setting Contract

**Files:**
- Modify: `packages/contracts/src/settings.ts:451-647`
- Modify: `packages/contracts/src/settings.test.ts:43-60`
- Modify: `packages/shared/src/serverSettings.test.ts`

**Interfaces:**
- Produces: `ServerSettings.enableChatAgentActivity: boolean`
- Produces: `ServerSettings.enableTerminalAgentActivity: boolean`
- Produces: `ServerSettingsPatch.enableChatAgentActivity?: boolean`
- Produces: `ServerSettingsPatch.enableTerminalAgentActivity?: boolean`
- Defaults: `{ enableChatAgentActivity: true, enableTerminalAgentActivity: false }`

- [ ] **Step 1: Write failing contract tests**

Replace the old activity-setting test block in `packages/contracts/src/settings.test.ts` with:

```typescript
describe("ServerSettings agent activity", () => {
  it("defaults Chat on and AI Terminal off", () => {
    expect(decodeServerSettings({})).toMatchObject({
      enableChatAgentActivity: true,
      enableTerminalAgentActivity: false,
    });
    expect(DEFAULT_SERVER_SETTINGS).toMatchObject({
      enableChatAgentActivity: true,
      enableTerminalAgentActivity: false,
    });
  });

  it("decodes and patches both activity settings independently", () => {
    expect(
      decodeServerSettings({
        enableChatAgentActivity: false,
        enableTerminalAgentActivity: true,
      }),
    ).toMatchObject({
      enableChatAgentActivity: false,
      enableTerminalAgentActivity: true,
    });
    expect(decodeServerSettingsPatch({ enableChatAgentActivity: false })).toEqual({
      enableChatAgentActivity: false,
    });
    expect(decodeServerSettingsPatch({ enableTerminalAgentActivity: true })).toEqual({
      enableTerminalAgentActivity: true,
    });
  });

  it("rejects non-boolean activity settings", () => {
    expect(() => decodeServerSettings({ enableChatAgentActivity: "false" })).toThrow();
    expect(() => decodeServerSettings({ enableTerminalAgentActivity: 1 })).toThrow();
    expect(() => decodeServerSettingsPatch({ enableChatAgentActivity: 0 })).toThrow();
    expect(() => decodeServerSettingsPatch({ enableTerminalAgentActivity: "true" })).toThrow();
  });
});
```

Add this patch-merge test to `packages/shared/src/serverSettings.test.ts`:

```typescript
it("patches terminal activity without changing Chat activity", () => {
  expect(
    applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      enableTerminalAgentActivity: true,
    }),
  ).toMatchObject({
    enableChatAgentActivity: true,
    enableTerminalAgentActivity: true,
  });
});
```

- [ ] **Step 2: Run the tests and verify red**

Run:

```bash
vp test packages/contracts/src/settings.test.ts packages/shared/src/serverSettings.test.ts
```

Expected: failures because the new fields are not in `ServerSettings` or `ServerSettingsPatch`.

- [ ] **Step 3: Implement the canonical fields**

Replace the old field in `ServerSettings`:

```typescript
enableChatAgentActivity: Schema.Boolean.pipe(
  Schema.withDecodingDefault(Effect.succeed(true)),
),
enableTerminalAgentActivity: Schema.Boolean.pipe(
  Schema.withDecodingDefault(Effect.succeed(false)),
),
```

Replace the old patch field in `ServerSettingsPatch`:

```typescript
enableChatAgentActivity: Schema.optionalKey(Schema.Boolean),
enableTerminalAgentActivity: Schema.optionalKey(Schema.Boolean),
```

Do not retain `enableAgentActivity` in the current TypeScript type. The native server performs persisted legacy migration before settings reach clients.

- [ ] **Step 4: Run focused contract tests**

Run:

```bash
vp test packages/contracts/src/settings.test.ts packages/shared/src/serverSettings.test.ts
```

Expected: all pass.

- [ ] **Step 5: Commit the contract change**

```bash
git add packages/contracts/src/settings.ts packages/contracts/src/settings.test.ts packages/shared/src/serverSettings.test.ts
git commit -m "feat(settings): split agent activity defaults"
```

---

### Task 2: Migrate and Persist Native Settings

**Files:**
- Modify: `apps/server/src/server_settings/mod.rs:120-205, 280-420`
- Modify: `apps/server/tests/server_settings_domain.rs:45-75`
- Modify: `apps/server/src/production/control.rs:220-430, 1245-1270, 1620-1650, 2590-2840`

**Interfaces:**
- Consumes: current setting names from Task 1.
- Produces: `normalize_agent_activity_settings(&mut serde_json::Value)`.
- Produces: `ProviderSettingsState.enable_chat_agent_activity: bool`.
- Produces: `ProviderSettingsState.enable_terminal_agent_activity: bool`.
- Produces matching optional fields on Rust `ServerSettingsPatch`.

- [ ] **Step 1: Write failing Rust migration tests**

In `apps/server/tests/server_settings_domain.rs`, replace the old activity test with separate fresh-default, legacy, and round-trip tests. Use real files for migration:

```rust
#[tokio::test]
async fn agent_activity_defaults_chat_on_and_terminal_off() {
    let state = tempfile::tempdir().expect("state");
    let settings = ProviderSettingsStore::new(state.path())
        .get()
        .await
        .expect("settings");
    assert!(settings.enable_chat_agent_activity);
    assert!(!settings.enable_terminal_agent_activity);
}

#[tokio::test]
async fn legacy_agent_activity_migrates_only_to_chat() {
    let state = tempfile::tempdir().expect("state");
    tokio::fs::write(
        state.path().join("settings.json"),
        br#"{"enableAgentActivity":false}"#,
    )
    .await
    .expect("legacy settings");
    let settings = ProviderSettingsStore::new(state.path())
        .get()
        .await
        .expect("settings");
    assert!(!settings.enable_chat_agent_activity);
    assert!(!settings.enable_terminal_agent_activity);
}
```

Add a matrix test where an explicit new Chat field wins over the legacy field and an explicit terminal `true` survives. Extend production-control tests to assert the legacy key disappears from the next persisted settings document.

- [ ] **Step 2: Run native setting tests and verify red**

Run:

```bash
cargo test -p bibcode-server --test server_settings_domain agent_activity -- --nocapture
cargo test -p bibcode-server production::control::tests::agent_activity -- --nocapture
```

Expected: compile/test failures for missing fields and migration behavior.

- [ ] **Step 3: Add one shared legacy normalizer**

In `apps/server/src/server_settings/mod.rs`, add:

```rust
pub(crate) fn normalize_agent_activity_settings(settings: &mut Value) {
    let Some(object) = settings.as_object_mut() else {
        return;
    };
    let legacy = object.remove("enableAgentActivity");
    if !object.contains_key("enableChatAgentActivity") {
        object.insert(
            "enableChatAgentActivity".to_owned(),
            legacy.unwrap_or(Value::Bool(true)),
        );
    }
    object
        .entry("enableTerminalAgentActivity")
        .or_insert(Value::Bool(false));
}
```

Decode persisted settings through a `Value`, call the normalizer, then deserialize `ProviderSettingsState`. Replace the Rust state and patch fields with:

```rust
#[serde(default = "enabled_by_default")]
pub enable_chat_agent_activity: bool,
#[serde(default)]
pub enable_terminal_agent_activity: bool,
```

and:

```rust
pub enable_chat_agent_activity: Option<bool>,
pub enable_terminal_agent_activity: Option<bool>,
```

Update `Default` and `apply_patch` independently.

- [ ] **Step 4: Normalize the production JSON document**

Import the shared normalizer in `production/control.rs`. Validate all three possible persisted keys as booleans, call `normalize_agent_activity_settings(settings)` at the start of `apply_settings_defaults`, and change defaults to:

```rust
"enableChatAgentActivity": true,
"enableTerminalAgentActivity": false,
```

The normalizer removes `enableAgentActivity`, so the next atomic settings write persists only current fields. Keep validation before mutation on initial load so malformed legacy values still fail rather than silently defaulting.

- [ ] **Step 5: Run settings tests**

Run:

```bash
cargo test -p bibcode-server --test server_settings_domain -- --nocapture
cargo test -p bibcode-server production::control::tests -- --nocapture
vp test packages/contracts/src/settings.test.ts
```

Expected: all pass, including the explicit-new-wins migration matrix.

- [ ] **Step 6: Commit native migration**

```bash
git add apps/server/src/server_settings/mod.rs apps/server/tests/server_settings_domain.rs apps/server/src/production/control.rs
git commit -m "feat(settings): migrate split activity controls"
```

---

### Task 3: Add Source-Routed Projections and Source-Specific Finalization

**Files:**
- Create: `apps/server/src/activity/routing.rs`
- Modify: `apps/server/src/activity/mod.rs`
- Modify: `apps/server/src/activity/projection.rs:35-170, 180-245`
- Modify: `apps/server/src/activity/repository.rs:260-310, 525-590`
- Modify: `apps/server/tests/activity_repository.rs`

**Interfaces:**
- Produces: `AgentActivitySource::{Chat, Terminal}`.
- Produces: `AgentActivitySource::for_scope(&ActivityScopeRef) -> AgentActivitySource`.
- Produces: `AgentActivitySource::storage_kind(self) -> &'static str` returning `thread` or `terminal`.
- Produces: `ActivityProjections::new(repository, chat_controller, terminal_controller)`.
- Produces: `ActivityProjections::{chat, terminal, for_scope, for_source}` returning cloned projections.
- Produces: `ActivityProjections::with_capacity(repository, chat_controller, terminal_controller, capacity)` for RPC/load fixtures.
- Changes: `ActivityProjection::interrupt_for_monitoring_disabled(source)`.

- [ ] **Step 1: Write failing source-isolation tests**

Add this local helper to `activity_repository.rs` tests so both source cases use the same exact seed path:

```rust
async fn seed_running_actor(
    projection: &ActivityProjection,
    scope: &ActivityScopeSeed,
    actor_id: &str,
) {
    projection
        .ensure_scope(scope.clone())
        .await
        .expect("scope");
    projection
        .apply(
            &scope.scope_id,
            format!("event:{actor_id}"),
            vec![ProviderActivityMutation::upsert_actor(
                actor_id,
                None,
                actor_id,
                "running",
            )
            .expect("actor")],
            "2026-08-04T12:00:00Z".to_owned(),
        )
        .await
        .expect("running actor");
}
```

Use the existing `thread_scope` helper plus `ActivityScopeSeed::terminal(...)` to seed an active thread actor and active terminal actor in the same database, then disable/finalize only Chat:

```rust
let projections = ActivityProjections::new(
    ActivityRepository::new(database),
    AgentActivityController::new(true),
    AgentActivityController::new(true),
);
seed_running_actor(&projections.chat(), &thread_scope, "actor:chat").await;
seed_running_actor(&projections.terminal(), &terminal_scope, "actor:terminal").await;

assert_eq!(
    projections
        .chat()
        .interrupt_for_monitoring_disabled(AgentActivitySource::Chat)
        .await
        .expect("disable Chat"),
    1,
);
let thread_snapshot = projections
    .chat()
    .snapshot(&thread_scope.scope)
    .await
    .expect("thread snapshot");
let terminal_snapshot = projections
    .terminal()
    .snapshot(&terminal_scope.scope)
    .await
    .expect("terminal snapshot");
assert_eq!(thread_snapshot.actors[0].status, ActivityLifecycle::Interrupted);
assert_eq!(terminal_snapshot.actors[0].status, ActivityLifecycle::Running);
assert!(
    projections
        .terminal()
        .agent_activity_controller_for_integration_test()
        .snapshot()
        .enabled
);
```

Add the inverse terminal-only case and assert both sources' retained history remains queryable after re-enabling the disabled controller.

- [ ] **Step 2: Run repository tests and verify red**

Run:

```bash
cargo test -p bibcode-server --test activity_repository source_specific -- --nocapture
```

Expected: compile failure because source routing does not exist.

- [ ] **Step 3: Implement the routing unit**

Create `routing.rs` with the focused source/router API:

```rust
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AgentActivitySource {
    Chat,
    Terminal,
}

impl AgentActivitySource {
    pub const fn for_scope(scope: &ActivityScopeRef) -> Self {
        match scope {
            ActivityScopeRef::Thread { .. } => Self::Chat,
            ActivityScopeRef::Terminal { .. } => Self::Terminal,
        }
    }

    pub const fn storage_kind(self) -> &'static str {
        match self {
            Self::Chat => "thread",
            Self::Terminal => "terminal",
        }
    }

    pub const fn trace_label(self) -> &'static str {
        match self {
            Self::Chat => "chat",
            Self::Terminal => "terminal",
        }
    }
}

#[derive(Clone, Debug)]
pub struct ActivityProjections {
    chat: ActivityProjection,
    terminal: ActivityProjection,
}
```

Construct each projection with the same cloneable repository and its own controller. `for_scope` must delegate through `AgentActivitySource::for_scope`; `for_source` must match directly on the enum. Both return clones so RPC closures do not borrow across `await`. `with_capacity` supplies the same bounded capacity to both projection event buses for existing RPC/load fixtures.

- [ ] **Step 4: Filter monitoring-disabled cleanup by source**

Change the repository query to join `activity_scopes` and filter `s.source_kind = ?`. Pass `source.storage_kind()` into the database closure. Keep startup-only `interrupt_unresolved_terminal_scopes()` unchanged.

Change projection finalization to accept `AgentActivitySource` and call the filtered repository method. Clear only the projection instance's publication locks and retention-worker registrations; because each source owns a distinct projection instance, the other source is untouched.

- [ ] **Step 5: Run repository and controller tests**

Run:

```bash
cargo test -p bibcode-server --test activity_repository -- --nocapture
cargo test -p bibcode-server activity::controller::tests -- --nocapture
```

Expected: all pass.

- [ ] **Step 6: Commit projection routing**

```bash
git add apps/server/src/activity/routing.rs apps/server/src/activity/mod.rs apps/server/src/activity/projection.rs apps/server/src/activity/repository.rs apps/server/tests/activity_repository.rs
git commit -m "feat(activity): isolate source projections"
```

---

### Task 4: Route Activity RPC by Scope

**Files:**
- Modify: `apps/server/src/activity/rpc.rs:65-320`
- Modify: `apps/server/tests/activity_rpc.rs`
- Modify: `apps/server/tests/activity_load.rs`

**Interfaces:**
- Consumes: `ActivityProjections` from Task 3.
- Changes: `register_activity_rpc(registry: &mut RpcRegistry, projections: ActivityProjections)`.
- Guarantees: a thread request uses only the Chat controller/projection; a terminal request uses only the terminal controller/projection.

- [ ] **Step 1: Write failing independent RPC tests**

Build a fixture with both projections and both scopes. Open one subscription per scope, disable Chat, and assert using the existing `next_message`, `unary`, and WebSocket request helpers:

```rust
assert!(matches!(
    next_message(&mut chat_socket).await,
    ServerMessage::Exit {
        exit: bibcode_server::RpcExit::Failure { .. },
        ..
    }
));
assert!(
    tokio::time::timeout(
        Duration::from_millis(50),
        next_message(&mut terminal_socket),
    )
    .await
    .is_err()
);
assert!(
    unary(
        &mut terminal_socket,
        "terminal-snapshot",
        "activity.getSnapshot",
        json!({ "_tag": "terminal", "threadId": "rpc", "terminalId": "terminal-rpc" }),
    )
    .await
    .is_ok()
);
assert_eq!(
    unary(
        &mut chat_socket,
        "chat-snapshot",
        "activity.getSnapshot",
        json!({ "_tag": "thread", "threadId": "rpc" }),
    )
    .await
    .expect_err("Chat disabled")["reason"],
    "featureDisabled",
);
```

Then apply a terminal delta and assert the terminal stream receives it. Add the inverse test. Retain the queue-backpressure assertion proving disabled-source unary requests reserve no database job.

- [ ] **Step 2: Run RPC tests and verify red**

Run:

```bash
cargo test -p bibcode-server --test activity_rpc source_specific -- --nocapture
```

Expected: compile/failure because RPC registration still accepts one controller.

- [ ] **Step 3: Route unary methods after decoding scope**

Change each unary closure to select after decoding:

```rust
let projection = projections.for_scope(&scope);
encode_admitted_read(projection.snapshot_admitted(&scope).await)
```

For roster/detail, select from `input.scope` before moving the remaining fields. Do not query the repository before selection/admission.

- [ ] **Step 4: Route streams and state watchers**

In `activity_stream`, decode the scope first, then select:

```rust
let projection = projections.for_scope(&scope);
let controller = projection.agent_activity_controller();
let mut controller_states = controller.subscribe();
let Some(_registration) = controller.register_stream() else {
    let _ = send(&sender, Err(feature_disabled_error()), &cancellation).await;
    return;
};
```

Use that same projection/controller for initial snapshots, delta subscription, fresh snapshots, and response fencing. A state change from the other controller is therefore invisible to the stream.

- [ ] **Step 5: Update fixtures and run RPC/load coverage**

Update all test registration call sites to construct `ActivityProjections`. For single-source tests, keep the unused controller enabled and seed only the relevant scope.

Run:

```bash
cargo test -p bibcode-server --test activity_rpc -- --nocapture
cargo test -p bibcode-server --test activity_load -- --nocapture
```

Expected: all pass, including both source-specific disable races.

- [ ] **Step 6: Commit RPC routing**

```bash
git add apps/server/src/activity/rpc.rs apps/server/tests/activity_rpc.rs apps/server/tests/activity_load.rs
git commit -m "feat(activity): route RPC by activity source"
```

---

### Task 5: Make the Production Coordinator Source-Aware

**Files:**
- Modify: `apps/server/src/production/agent_activity.rs`

**Interfaces:**
- Consumes: `AgentActivitySource` and `ActivityProjections`.
- Changes: `AgentActivitySettingsHandler::transition(source, enabled, settings_generation)`.
- Produces: source-specific startup and transition traces.
- Guarantees: Chat transitions call provider-runtime lifecycle only; terminal transitions call terminal-manager lifecycle only.

- [ ] **Step 1: Write failing coordinator tests**

Extend the in-module fake runtime to record calls. Construct one coordinator per source, call `transition(&runtime, false, 1)`, and assert exact sequences:

```rust
let trace_directory = tempfile::tempdir().expect("trace directory");
let trace_store = TraceDiagnosticsStore::new(trace_directory.path().join("trace.ndjson"));
let chat = AgentActivityCoordinator::new(
    AgentActivitySource::Chat,
    AgentActivityController::new(true),
    trace_store.clone(),
    "environment".to_owned(),
);
chat.transition(&runtime, false, 1).await;
assert_eq!(runtime.take_calls(), vec!["finalize:chat", "provider:false"]);

let terminal = AgentActivityCoordinator::new(
    AgentActivitySource::Terminal,
    AgentActivityController::new(true),
    trace_store,
    "environment".to_owned(),
);
terminal.transition(&runtime, false, 2).await;
assert_eq!(runtime.take_calls(), vec!["finalize:terminal", "terminal:false"]);
```

Assert Chat transitions report no terminal observer epochs/counts, terminal transitions do not increment provider stopped/resumed counts, and trace records contain the correct `source` string.

- [ ] **Step 2: Run coordinator tests and verify red**

Run:

```bash
cargo test -p bibcode-server production::agent_activity::tests -- --nocapture
```

Expected: new source-aware assertions fail.

- [ ] **Step 3: Add source to coordinator lifecycle**

Store `source: AgentActivitySource` on each `AgentActivityCoordinator`. Include `"source": self.source.trace_label()` in requested, success, failure, and startup trace attributes.

Update the transition runtime interface to:

```rust
fn finalize_disabled_activity(
    &self,
    source: AgentActivitySource,
) -> BoxAgentActivityFuture<'_, Result<usize, ()>>;

fn set_provider_activity_enabled(
    &self,
    enabled: bool,
) -> BoxAgentActivityFuture<'_, Result<usize, ()>>;

fn set_terminal_activity_enabled(
    &self,
    enabled: bool,
) -> BoxAgentActivityFuture<'_, TerminalAgentActivityTransition>;
```

Branch enable/disable observer work on the coordinator's source. Do not call the irrelevant lifecycle method with a no-op boolean.

- [ ] **Step 4: Hold two coordinators in production**

Change `ProductionAgentActivity` to own `chat_coordinator`, `terminal_coordinator`, and `ActivityProjections`. Select the coordinator by source and finalize through the corresponding projection:

```rust
let projection = self.projections.for_source(source);
projection
    .interrupt_for_monitoring_disabled(source)
    .await
    .map_err(|_| ())
```

`record_startup` records both sources. `transition` accepts the source. Existing bounded failure semantics remain per source.

- [ ] **Step 5: Run coordinator tests**

Run:

```bash
cargo test -p bibcode-server production::agent_activity::tests -- --nocapture
```

Expected: all pass with source-specific call sequences and trace fields.

- [ ] **Step 6: Commit coordinator changes**

```bash
git add apps/server/src/production/agent_activity.rs
git commit -m "feat(activity): split production transitions by source"
```

---

### Task 6: Wire Independent Settings Through Production Runtime

**Files:**
- Modify: `apps/server/src/production/control.rs:150-430, 1920-2840`
- Modify: `apps/server/src/production/runtime.rs:1-300, 1030-1210`
- Modify: `apps/server/tests/production_server_terminal_rpc.rs`
- Modify: `apps/server/tests/production_provider_runtime.rs`

**Interfaces:**
- Consumes: Task 2 settings, Task 3 projections, and Task 5 handler.
- Produces: `NativeServerControl::agent_activity_enabled(source)`.
- Production provider runtime receives only Chat controller/projection.
- Provider terminal supervisor receives only terminal controller/projection.

- [ ] **Step 1: Write failing persist-first transition tests**

Change the test handler to record `(AgentActivitySource, bool, u64)`. Add tests that patch one setting while the other is unchanged:

```rust
control
    .update_settings(json!({"patch":{"enableTerminalAgentActivity":true}}))
    .await
    .expect("enable terminal");
assert_eq!(handler.calls(), vec![(AgentActivitySource::Terminal, true, 1)]);
assert!(control.agent_activity_enabled(AgentActivitySource::Chat).await);
assert!(control.agent_activity_enabled(AgentActivitySource::Terminal).await);
```

Add the inverse Chat-only update, a patch changing both values, a persistence-failure case with no calls, and cancellation/order coverage matching the existing persist-before-publication test.

- [ ] **Step 2: Run control/runtime tests and verify red**

Run:

```bash
cargo test -p bibcode-server production::control::tests::agent_activity -- --nocapture
cargo test -p bibcode-server production::runtime::tests::agent_activity -- --nocapture
cargo test -p bibcode-server --test production_server_terminal_rpc agent_activity -- --nocapture
```

Expected: compile/failures for the old single setting and controller.

- [ ] **Step 3: Dispatch only changed source transitions**

Add a private value reader:

```rust
fn agent_activity_enabled(settings: &Value, source: AgentActivitySource) -> bool {
    let (field, fallback) = match source {
        AgentActivitySource::Chat => ("enableChatAgentActivity", true),
        AgentActivitySource::Terminal => ("enableTerminalAgentActivity", false),
    };
    settings.get(field).and_then(Value::as_bool).unwrap_or(fallback)
}
```

Before patching, capture both values; after persistence, iterate `[Chat, Terminal]` in deterministic order and call the handler only when that source changed. Publish the settings document after transition attempts using the existing commit task.

- [ ] **Step 4: Construct two production controllers and projections**

In `ProductionRuntime::start`:

```rust
let chat_activity_controller = AgentActivityController::new(
    control.agent_activity_enabled(AgentActivitySource::Chat).await,
);
let terminal_activity_controller = AgentActivityController::new(
    control.agent_activity_enabled(AgentActivitySource::Terminal).await,
);
let activity_repository = ActivityRepository::new(repositories.database().clone());
let activity_projections = ActivityProjections::new(
    activity_repository,
    chat_activity_controller.clone(),
    terminal_activity_controller.clone(),
);
```

Pass `activity_projections.chat()` and the Chat controller to the native provider factory/runtime. Pass `activity_projections.terminal()` and the terminal controller to `ProviderTerminalActivitySupervisor`. Register RPC with the whole router. Construct `ProductionAgentActivity` with both sources and expose `activity_projections` on `ProductionRuntime` instead of the singular projection.

- [ ] **Step 5: Update production integration tests**

Change terminal settings updates to `enableTerminalAgentActivity`; change structured-provider updates to `enableChatAgentActivity`. Add a startup test from legacy `{"enableAgentActivity":true}` proving Chat starts enabled and terminal starts disabled. Assert terminal enablement never changes the Chat controller generation and Chat disablement never changes terminal observer state.

- [ ] **Step 6: Run production integration coverage**

Run:

```bash
cargo test -p bibcode-server production::control::tests -- --nocapture
cargo test -p bibcode-server production::runtime::tests -- --nocapture
cargo test -p bibcode-server --test production_provider_runtime agent_activity -- --nocapture
cargo test -p bibcode-server --test production_server_terminal_rpc agent_activity -- --nocapture
cargo test -p bibcode-server --test provider_terminal_supervisor agent_activity -- --nocapture
```

Expected: all pass.

- [ ] **Step 7: Commit production wiring**

```bash
git add apps/server/src/production/control.rs apps/server/src/production/runtime.rs apps/server/tests/production_server_terminal_rpc.rs apps/server/tests/production_provider_runtime.rs
git commit -m "feat(activity): wire independent production gates"
```

---

### Task 7: Render Two Experimental Settings Rows

**Files:**
- Modify: `apps/web/src/components/settings/settingsLayout.tsx:54-105`
- Modify: `apps/web/src/components/settings/SettingsPanels.tsx:930-985`
- Modify: `apps/web/src/components/settings/SettingsPanels.test.tsx:810-860`
- Modify: `apps/web/src/hooks/useSettings.test.ts:400-445`

**Interfaces:**
- Consumes: Task 1 settings and defaults.
- Produces: accessible switches `Chat agent activity` and `AI Terminal agent activity`.
- Produces: two visible `Experimental` tags.

- [ ] **Step 1: Write failing settings-panel tests**

Replace the single-row assertions with:

```typescript
it("renders independent experimental activity settings", () => {
  const markup = render(<AgentsSettingsPanel />);
  expect(markup).toContain("Chat agent activity");
  expect(markup).toContain("AI Terminal agent activity");
  expect(markup.match(/Experimental/g)).toHaveLength(2);
  expect(markup).toContain("Show live agent and background-task activity in the Chat panel.");
  expect(markup).toContain("Show live agent and background-task activity in AI Terminals.");
});

it("uses independent defaults", () => {
  render(<AgentsSettingsPanel />);
  expect(control("switch", "Chat agent activity").props.checked).toBe(true);
  expect(control("switch", "AI Terminal agent activity").props.checked).toBe(false);
});
```

Add update/reset tests asserting exact single-field patches. Extend `useSettings.test.ts` with a rejected terminal update and prove optimistic rollback restores only that field.

- [ ] **Step 2: Run UI tests and verify red**

Run:

```bash
vp test apps/web/src/components/settings/SettingsPanels.test.tsx apps/web/src/hooks/useSettings.test.ts
```

Expected: missing labels, tags, and fields.

- [ ] **Step 3: Add a reusable title-tag slot**

Extend `SettingsRow` with `titleTag?: ReactNode` and render it between `<h3>` and the existing reset-action container:

```tsx
<div className="flex min-h-5 items-center gap-1.5">
  <h3 className="text-[13px] font-semibold tracking-[-0.01em] text-foreground">
    {title}
  </h3>
  {titleTag}
  <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">
    {resetAction}
  </span>
</div>
```

- [ ] **Step 4: Render both rows with badges and defaults**

Use `<Badge variant="warning" size="sm">Experimental</Badge>` as `titleTag` on both rows. Use the exact titles/descriptions from the approved spec and `DEFAULT_SERVER_SETTINGS` for each reset. Switch callbacks send only the matching boolean field.

- [ ] **Step 5: Run settings tests**

Run:

```bash
vp test apps/web/src/components/settings/SettingsPanels.test.tsx apps/web/src/hooks/useSettings.test.ts
```

Expected: all pass.

- [ ] **Step 6: Commit settings UI**

```bash
git add apps/web/src/components/settings/settingsLayout.tsx apps/web/src/components/settings/SettingsPanels.tsx apps/web/src/components/settings/SettingsPanels.test.tsx apps/web/src/hooks/useSettings.test.ts
git commit -m "feat(settings): show experimental activity controls"
```

---

### Task 8: Gate Frontend Activity by Active Scope

**Files:**
- Modify: `apps/web/src/components/ChatView.logic.ts:20-60`
- Modify: `apps/web/src/components/ChatView.logic.test.ts`
- Modify: `apps/web/src/components/ChatView.tsx:1480-1500, 1860-1900`
- Modify: `apps/web/src/components/ChatView.test.tsx`
- Modify: `apps/web/src/components/ThreadTerminalDrawer.tsx:690-710, 1700-1725`
- Modify: `apps/web/src/components/ThreadTerminalDrawer.test.tsx`
- Modify: `apps/web/src/components/ThreadTerminalDrawer.interactions.test.tsx:390-470, 560-590`

**Interfaces:**
- Produces: `isAgentActivityScopeEnabled(scope, settings) -> boolean`.
- Chat/thread scope consumes `enableChatAgentActivity`.
- Terminal scope consumes `enableTerminalAgentActivity`.
- Terminal drawer consumes only `enableTerminalAgentActivity` for its environment.

- [ ] **Step 1: Write failing pure selection tests**

Add to `ChatView.logic.test.ts`:

```typescript
it.each([
  [{ _tag: "thread", threadId: "thread-1" }, true, false, true],
  [{ _tag: "thread", threadId: "thread-1" }, false, true, false],
  [{ _tag: "terminal", threadId: "thread-1", terminalId: "term-1" }, false, true, true],
  [{ _tag: "terminal", threadId: "thread-1", terminalId: "term-1" }, true, false, false],
])("selects the matching source setting", (scope, chat, terminal, expected) => {
  expect(
    isAgentActivityScopeEnabled(scope as ActivityScopeRef, {
      enableChatAgentActivity: chat,
      enableTerminalAgentActivity: terminal,
    }),
  ).toBe(expected);
});
```

- [ ] **Step 2: Write failing component isolation tests**

Update the ChatView harness to publish both fields. Test that disabling Chat closes a thread Activity surface but leaves an open terminal Activity surface mounted when terminal is enabled. Add the inverse case. In terminal drawer tests, default terminal activity to false, explicitly enable it to render the host, then disable it and assert the terminal xterm mount remains.

- [ ] **Step 3: Run frontend activity tests and verify red**

Run:

```bash
vp test apps/web/src/components/ChatView.logic.test.ts apps/web/src/components/ChatView.test.tsx apps/web/src/components/ThreadTerminalDrawer.test.tsx apps/web/src/components/ThreadTerminalDrawer.interactions.test.tsx
```

Expected: the old shared field cannot satisfy the isolation cases.

- [ ] **Step 4: Add the pure scope selector**

Implement in `ChatView.logic.ts`:

```typescript
export function isAgentActivityScopeEnabled(
  scope: ActivityScopeRef,
  settings: {
    readonly enableChatAgentActivity: boolean;
    readonly enableTerminalAgentActivity: boolean;
  },
): boolean {
  return scope._tag === "terminal"
    ? settings.enableTerminalAgentActivity
    : settings.enableChatAgentActivity;
}
```

- [ ] **Step 5: Gate ChatView and close only matching stale surfaces**

Compute `activityScopeEnabled` from the resolved scope and both settings. Require it in `activityStateTarget`. In the cleanup effect, inspect the persisted activity surface's scope and close it only when its corresponding setting is false. Do not close a terminal surface merely because Chat is disabled.

- [ ] **Step 6: Gate terminal drawer with terminal setting only**

Read:

```typescript
const enableTerminalAgentActivity = useEnvironmentSettings(
  environmentId,
  (settings) => settings.enableTerminalAgentActivity,
);
```

Require it in the `ProviderTerminalActivityDock` host condition. Preserve the terminal command and `command.activity` metadata so eligible dormant observer resume remains possible.

- [ ] **Step 7: Run frontend activity coverage**

Run:

```bash
vp test apps/web/src/components/ChatView.logic.test.ts apps/web/src/components/ChatView.test.tsx apps/web/src/components/ThreadTerminalDrawer.test.tsx apps/web/src/components/ThreadTerminalDrawer.interactions.test.tsx apps/web/src/components/activity/ProviderTerminalActivityDock.test.tsx
```

Expected: all pass; every setting combination selects the correct source.

- [ ] **Step 8: Commit selective frontend gating**

```bash
git add apps/web/src/components/ChatView.logic.ts apps/web/src/components/ChatView.logic.test.ts apps/web/src/components/ChatView.tsx apps/web/src/components/ChatView.test.tsx apps/web/src/components/ThreadTerminalDrawer.tsx apps/web/src/components/ThreadTerminalDrawer.test.tsx apps/web/src/components/ThreadTerminalDrawer.interactions.test.tsx
git commit -m "feat(activity): gate UI by activity source"
```

---

### Task 9: Update Deterministic Acceptance Coverage and Architecture Docs

**Files:**
- Modify: `apps/desktop/e2e/support/activity-session.ts:315-335`
- Modify: `apps/desktop/e2e/support/activity-session.test.ts`
- Modify: `docs/architecture/activity-observation.md`

**Interfaces:**
- Existing activity E2E explicitly opts into terminal activity before opening a provider terminal.
- Architecture documentation describes independent defaults and source routing.

- [ ] **Step 1: Write a failing activity-session assertion**

In `activity-session.test.ts`, assert the server settings command includes:

```typescript
expect(setupRequests).toContainEqual({
  tag: "server.updateSettings",
  payload: {
    patch: expect.objectContaining({
      enableTerminalAgentActivity: true,
    }),
  },
});
```

- [ ] **Step 2: Run the support test and verify red**

Run:

```bash
vp test apps/desktop/e2e/support/activity-session.test.ts
```

Expected: the deterministic terminal fixture does not opt in yet.

- [ ] **Step 3: Opt the terminal activity fixture in explicitly**

Add `enableTerminalAgentActivity: true` to the patch sent by `configureDesktopActivityCodexExecutable`. Do not change global E2E settings defaults; unrelated tests must continue exercising the real default-off behavior.

- [ ] **Step 4: Update architecture documentation**

Add a controls section to `docs/architecture/activity-observation.md` stating:

```markdown
## Independent activity controls

Each environment has separate Chat and AI Terminal activity gates. Chat defaults
on and owns `thread` scopes. AI Terminal defaults off and owns `terminal` scopes.
RPC admission, generation fencing, projection, cleanup, and observer lifecycle
are selected from the request scope; changing one gate does not transition the
other. Legacy `enableAgentActivity` values migrate only to Chat.
```

Also amend the terminal topology section to say terminal observation requires explicit enablement before launch.

- [ ] **Step 5: Run support and focused acceptance tests**

Run:

```bash
vp test apps/desktop/e2e/support/activity-session.test.ts
vp test packages/contracts/src/settings.test.ts apps/web/src/components/settings/SettingsPanels.test.tsx apps/web/src/components/ChatView.logic.test.ts
```

Expected: all pass.

- [ ] **Step 6: Commit acceptance/docs updates**

```bash
git add apps/desktop/e2e/support/activity-session.ts apps/desktop/e2e/support/activity-session.test.ts docs/architecture/activity-observation.md
git commit -m "test(activity): opt terminal acceptance fixture in"
```

---

### Task 10: Run Full Verification and Codex Computer Use Visual QA

**Files:**
- Create locally, ignored: `.artifacts/visual-qa/independent-agent-activity/*.png`
- No planned tracked source changes; any discovered defect returns to its owning task and repeats focused plus full verification.

**Interfaces:**
- Consumes the complete feature.
- Produces test evidence and full-resolution screenshots for the final report.
- Required skill: `superpowers:verification-before-completion`.
- Required skill/tool: `computer-use:computer-use` through `mcp__node_repl__js` and plugin wrapper `scripts/computer-use-client.mjs`.

- [ ] **Step 1: Run focused TypeScript tests**

```bash
vp test packages/contracts/src/settings.test.ts packages/shared/src/serverSettings.test.ts apps/web/src/hooks/useSettings.test.ts apps/web/src/components/settings/SettingsPanels.test.tsx apps/web/src/components/ChatView.logic.test.ts apps/web/src/components/ChatView.test.tsx apps/web/src/components/ThreadTerminalDrawer.test.tsx apps/web/src/components/ThreadTerminalDrawer.interactions.test.tsx apps/web/src/components/activity/ProviderTerminalActivityDock.test.tsx apps/desktop/e2e/support/activity-session.test.ts
```

Expected: all pass.

- [ ] **Step 2: Run focused Rust tests**

```bash
env -u BIBCODE_CLAUDE_KEYCHAIN_ACCESS cargo test -p bibcode-server --test server_settings_domain -- --nocapture
env -u BIBCODE_CLAUDE_KEYCHAIN_ACCESS cargo test -p bibcode-server --test activity_repository -- --nocapture
env -u BIBCODE_CLAUDE_KEYCHAIN_ACCESS cargo test -p bibcode-server --test activity_rpc -- --nocapture
env -u BIBCODE_CLAUDE_KEYCHAIN_ACCESS cargo test -p bibcode-server --test activity_load -- --nocapture
env -u BIBCODE_CLAUDE_KEYCHAIN_ACCESS cargo test -p bibcode-server production::agent_activity::tests -- --nocapture
env -u BIBCODE_CLAUDE_KEYCHAIN_ACCESS cargo test -p bibcode-server production::control::tests -- --nocapture
env -u BIBCODE_CLAUDE_KEYCHAIN_ACCESS cargo test -p bibcode-server production::runtime::tests -- --nocapture
env -u BIBCODE_CLAUDE_KEYCHAIN_ACCESS cargo test -p bibcode-server --test production_provider_runtime agent_activity -- --nocapture
env -u BIBCODE_CLAUDE_KEYCHAIN_ACCESS cargo test -p bibcode-server --test production_server_terminal_rpc agent_activity -- --nocapture
```

Expected: all pass.

- [ ] **Step 3: Run repository gates**

```bash
vp check
vp run typecheck
```

Expected: both exit 0, as required by `AGENTS.md`.

- [ ] **Step 4: Launch an isolated desktop instance**

Use a recoverable temporary directory without touching the user's normal BiBCode data:

```bash
qa_activity_home="$(mktemp -d)"
mkdir -p .artifacts/visual-qa/independent-agent-activity
BIBCODE_HOME="$qa_activity_home" \
BIBCODE_DEV_INSTANCE=independent-agent-activity-qa \
BIBCODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD=1 \
BIBCODE_CLAUDE_KEYCHAIN_ACCESS=disabled \
vp run dev:desktop
```

Keep the PTY session running. Do not delete the temporary state until all screenshots and persistence checks are complete.

- [ ] **Step 5: Initialize Codex Computer Use and inspect the fresh defaults**

Use `mcp__node_repl__js` with the plugin wrapper:

```javascript
if (!globalThis.sky) {
  var { setupComputerUseRuntime } = await import(
    "/Users/admin/.codex/plugins/cache/openai-bundled/computer-use/1.0.1000550/scripts/computer-use-client.mjs"
  );
  await setupComputerUseRuntime({ globals: globalThis });
}
var bibcodeState = await sky.get_app_state({ app: "BiBCode", disableDiff: true });
nodeRepl.write(bibcodeState.text);
```

Navigate using fresh accessibility indices to **Settings → Agents**. Verify from the AX tree that both switch names exist, both `Experimental` texts are visible, Chat is on, and AI Terminal is off.

- [ ] **Step 6: Save and emit the default screenshot**

```javascript
var qaFs = await import("node:fs/promises");
var { fileURLToPath: qaFileURLToPath } = await import("node:url");
var qaDefaultPath = `${nodeRepl.cwd}/.artifacts/visual-qa/independent-agent-activity/settings-default.png`;
await qaFs.copyFile(qaFileURLToPath(bibcodeState.screenshot.url), qaDefaultPath);
await nodeRepl.emitImage({ bytes: await qaFs.readFile(qaDefaultPath), mimeType: "image/png" });
```

Open the saved file with `view_image(detail: "original")`. Inspect title/tag alignment, row spacing, clipping, contrast, switch state, label copy, and reset-icon placement at full resolution. Record any defect before continuing.

- [ ] **Step 7: Exercise and capture all four combinations**

Using accessibility-index clicks followed by a fresh `get_app_state` after every action, set and verify:

1. Chat on / AI Terminal off (fresh default).
2. Chat off / AI Terminal off.
3. Chat off / AI Terminal on.
4. Chat on / AI Terminal on.

Save `settings-both-off.png`, `settings-terminal-only.png`, and `settings-both-on.png`. Reopen Settings after an app/server restart and verify the last combination persisted. Then reset both rows and verify Chat returns on and AI Terminal returns off.

- [ ] **Step 8: Prove source-selective activity surfaces visually**

Use the isolated bootstrapped project and the installed Codex provider:

- With Chat on / AI Terminal off, start a Chat action that exposes activity. Confirm the Chat activity dock/panel appears while a newly opened Codex Terminal has no provider-terminal activity host. Save `chat-only-surfaces.png`.
- Set Chat off / AI Terminal on. Confirm the thread activity surface closes immediately without ending the Chat. Close and reopen the Codex Terminal because instrumentation is launch-time, trigger provider activity, and confirm its activity dock appears. Save `terminal-only-surfaces.png`.
- Set both off and confirm both activity surfaces disappear while chat and terminal content remain usable. Save `both-off-surfaces.png`.

If the development provider cannot emit deterministic activity, build and run the existing packaged desktop fixture with:

```bash
BIBCODE_E2E_BUNDLE=app vp run test:ui:desktop:build
BIBCODE_E2E_SPEC=./specs/chat-activity-panel.e2e.ts vp run test:ui:desktop
```

Use the retained artifact path printed by the runner to review its native screenshots, and repeat the interactive Computer Use inspection against the packaged BiBCode app while the fixture is running. Do not substitute a static component story or HTML mock.

- [ ] **Step 9: Inspect every screenshot carefully**

For each PNG, use `view_image` with `detail: "original"` and check:

- both Experimental tags are adjacent to the correct titles and legible;
- no row, text, badge, reset control, or switch clips at the tested window size;
- default and toggled switch states match the AX tree and persisted settings;
- disabling Chat removes only thread-scoped activity;
- disabling AI Terminal removes only terminal-scoped activity;
- the underlying chat and terminal remain visible and functional;
- no stale Activity right panel remains for a disabled source;
- light/dark theme contrast is acceptable if the current app theme changes during the run.

Any mismatch is a failed verification: fix it, rerun the owning focused tests, rerun `vp check` and `vp run typecheck`, and recapture affected screenshots.

- [ ] **Step 10: Inspect final diff and report evidence**

```bash
git status --short
git diff --check origin/main...HEAD
git log --oneline --decorate -12
```

Confirm no screenshot or temporary state is tracked. The final response must link the implementation files, list the exact test commands that passed, and embed at least the default settings, terminal-only settings, Chat-only surface, and terminal-only surface screenshots using absolute paths.

---

## Completion Checklist

- [ ] Legacy false migrates to Chat false / terminal false.
- [ ] Legacy true migrates to Chat true / terminal false.
- [ ] Explicit new fields override legacy input.
- [ ] Chat and AI Terminal settings support all four combinations.
- [ ] Both Settings rows show Experimental tags.
- [ ] Chat transitions touch only structured provider activity.
- [ ] Terminal transitions touch only provider-terminal observation.
- [ ] RPC reads/streams are fenced by the matching source controller.
- [ ] Source-specific finalization does not interrupt the other source.
- [ ] Terminal activity is disabled on fresh launch and skipped at terminal preparation time.
- [ ] Existing history remains and no disabled-period backfill is implied.
- [ ] Focused TypeScript and Rust tests pass.
- [ ] `vp check` passes.
- [ ] `vp run typecheck` passes.
- [ ] Codex Computer Use verifies the real desktop UI.
- [ ] Screenshots are saved, emitted, and inspected at full resolution.
