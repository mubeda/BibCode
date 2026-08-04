# Provider Capability Toolbar and Live Option Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the compact chat toolbar truthful and immediately effective across Codex, Claude, Cursor, and OpenCode: supported controls apply before the next turn, unsupported/unknown controls remain visible with an accessible reason, and active controls use solid theme-native styling.

**Architecture:** Keep provider capability discovery as the source of truth, reuse the existing thread-metadata command for immediate UI commits, and add one server-side reconciliation function that applies a canonical model-option selection before any turn is delivered. Providers that can mutate an active session do so in place; providers that cannot return `UnsupportedCapability`, which triggers the existing restart/resume path with the same canonical launch request. Do not add a new protocol, state manager, dependency, or generalized capability framework.

**Tech Stack:** React 19, TypeScript, Vite+, Effect client runtime, Rust, Tokio, Axum, Tauri 2, existing BiBCode UI primitives and Lucide icons.

## Global Constraints

- Support Codex, Claude, Cursor, and OpenCode only where their real model/session metadata supports the feature.
- Never synthesize Fast support merely because the provider is Codex or because a toolbar button exists.
- Keep Fast, effort, and Plan visible when support is unknown or absent; expose the reason on hover and keyboard focus.
- Use `aria-disabled`, guarded handlers, and accessible labels so a disabled control can still receive tooltip focus.
- Active Fast and Plan controls use existing `primary`/`primary-foreground` theme tokens. Do not introduce violet, hard-coded feature colors, or a new design token.
- Plan uses the folded-map `MapIcon`. Off means build mode in the backend; do not show a Build icon.
- Never render agent selection in the compact toolbar. Keep agent selection in the existing full settings/menu surfaces only.
- Keep attachment, context usage, and MCP controls independent of provider capabilities.
- Preserve durable delivery semantics: selected options are part of the frozen route and are reconciled before prompt delivery.
- Preserve existing user changes in the dirty worktree and do not edit `.repos/`.
- Before completion, `vp check` and `vp run typecheck` must pass.
- Finish with desktop visual verification through the Computer Use skill.

## File Map

- `packages/shared/src/model.ts`: remove fabricated Codex Fast metadata while retaining descriptor normalization.
- `packages/shared/src/providerSessionDefaults.ts`: map only real `fastMode` or advertised `serviceTier=fast` descriptors.
- `apps/server/src/provider/codex/model.rs`: keep live Codex service tiers truthful.
- `apps/server/src/provider/opencode/model.rs`: translate an advertised OpenCode `fast` variant into the canonical `fastMode` descriptor.
- `apps/server/src/production/provider_runtime.rs`: preserve canonical options in launch requests, fingerprints, metadata updates, and pre-delivery reconciliation.
- `apps/server/src/provider/codex/runtime.rs`: update Codex per-turn service tier/effort without restarting.
- `apps/server/src/provider/cursor/runtime.rs`: apply Cursor ACP config options live.
- `apps/server/src/provider/opencode/runtime.rs`: carry the selected OpenCode variant into prompt/command bodies.
- `apps/web/src/components/chat/TraitsPicker.tsx`: async option commits, visible disabled controls, applying state, and theme-native active state.
- `apps/web/src/components/chat/composerProviderState.tsx`: derive supported/unknown/unsupported toolbar availability without rendering agents.
- `apps/web/src/providerModels.ts`: expose truthful Plan availability instead of defaulting missing state to supported.
- `apps/web/src/components/chat/ChatComposer.tsx`: immediate metadata commit and the Plan button states.
- `apps/web/src/components/ChatView.tsx`: call the existing metadata command immediately and surface failures to the composer.

---

### Task 1: Make Provider Capability Metadata Truthful

**Files:**
- Modify: `packages/shared/src/model.ts`
- Modify: `packages/shared/src/providerSessionDefaults.ts`
- Modify: `packages/shared/src/model.test.ts`
- Modify: `apps/server/src/provider/codex/model.rs`
- Modify: `apps/server/src/provider/opencode/model.rs`

- [ ] **Step 1: Add failing shared-model tests for non-fabricated Fast support**

Add tests proving that an empty Codex capability set does not gain `serviceTier`, while an advertised `serviceTier` with a `fast` option is preserved:

```ts
it("does not fabricate Codex fast mode", () => {
  expect(
    getProviderCapabilityDescriptors({
      provider: ProviderDriverKind.make("codex"),
      caps: createModelCapabilities({ optionDescriptors: [] }),
    }),
  ).toEqual([]);
});

it("preserves an advertised Codex fast service tier", () => {
  const descriptors = getProviderCapabilityDescriptors({
    provider: ProviderDriverKind.make("codex"),
    caps: createModelCapabilities({
      optionDescriptors: [{
        id: "serviceTier",
        label: "Service Tier",
        type: "select",
        options: [
          { id: "default", label: "Standard", isDefault: true },
          { id: "fast", label: "Fast" },
        ],
      }],
    }),
  });
  expect(getFastModeDescriptor("codex", descriptors)?.id).toBe("serviceTier");
});
```

- [ ] **Step 2: Run the focused shared tests and confirm the fabricated descriptor fails the first test**

Run: `vp test packages/shared/src/model.test.ts packages/shared/src/providerSessionDefaults.test.ts`

Expected: FAIL because the Codex service-tier invariant inserts `default` and `fast`.

- [ ] **Step 3: Delete the Codex service-tier fabrication and retain only advertised descriptors**

Remove `codexServiceTierDescriptor`, `withCodexServiceTierInvariant`, `enforceCodexServiceTier`, and their constants. Keep the existing Codex effort normalization, but invoke it only when live effort metadata or a selected effort exists. The capability function becomes:

```ts
export function getProviderCapabilityDescriptors(input: {
  provider: ProviderDriverKind;
  caps: ModelCapabilities;
  selections?: ReadonlyArray<ProviderOptionSelection> | null;
  preservePromptInjectedSelections?: boolean;
}): ReadonlyArray<ProviderOptionDescriptor> {
  const { provider, caps, selections, preservePromptInjectedSelections = false } = input;
  const liveDescriptors = caps.optionDescriptors ?? [];
  const hasCodexEffort = liveDescriptors.some((descriptor) =>
    PROVIDER_EFFORT_OPTION_IDS.some((id) => id === descriptor.id),
  );
  const hasSelectedEffort = selections?.some((selection) =>
    PROVIDER_EFFORT_OPTION_IDS.some((id) => id === selection.id),
  );
  const optionDescriptors =
    provider === CODEX_PROVIDER_DRIVER_KIND && (hasCodexEffort || hasSelectedEffort)
      ? withCodexReasoningEffortInvariant(liveDescriptors, selections)
      : liveDescriptors;

  return getProviderOptionDescriptors({
    caps: { ...caps, optionDescriptors },
    selections,
    preservePromptInjectedSelections,
  });
}
```

Update `getFastModeDescriptor` so Codex fallback occurs only when the supplied descriptor itself advertises `fast`; never construct a descriptor inside this helper.

- [ ] **Step 4: Add provider-model tests for truthful Codex and OpenCode inventories**

Replace the Codex test that expects service tiers to be injected with these cases:

```rust
#[test]
fn fallback_models_do_not_advertise_unverified_fast() {
    let models = fallback_models(Some("gpt-private"), Some("max"), Some("fast"), &[]);
    assert!(option_descriptor(&models[0], "serviceTier").is_none());
}

#[test]
fn live_model_without_service_tiers_does_not_advertise_fast() {
    let model = live_model_fixture(json!({ "slug": "gpt-5.6", "serviceTiers": [] }));
    assert!(option_descriptor(&model, "serviceTier").is_none());
}

#[test]
fn live_model_preserves_only_advertised_service_tiers() {
    let model = live_model_fixture(json!({
        "slug": "gpt-5.6",
        "serviceTiers": [{ "id": "default", "label": "Standard" }]
    }));
    assert_eq!(select_option_ids(&model, "serviceTier"), vec!["default"]);
}
```

Add an OpenCode test proving that an advertised `fast` variant produces a boolean `fastMode` descriptor and that remaining variants stay in the generic `variant` selector:

```rust
#[test]
fn fast_variant_is_exposed_as_canonical_fast_mode() {
    let capabilities = model_capabilities(&["default", "fast", "max"]);
    assert_eq!(boolean_descriptor(&capabilities, "fastMode").current_value, Some(false));
    assert_eq!(select_option_ids(&capabilities, "variant"), vec!["default", "max"]);
}
```

- [ ] **Step 5: Implement the minimal provider metadata translations**

In Codex fallback models, omit `serviceTier` because configured defaults are not proof that the selected model/account can use Fast. In live Codex model parsing, emit `serviceTier` only when the app-server response contains tiers and preserve only those tiers. In OpenCode model parsing, split `fast` from the generic variants:

```rust
let supports_fast = variants.iter().any(|variant| variant == "fast");
let regular_variants = variants
    .iter()
    .filter(|variant| variant.as_str() != "fast")
    .cloned()
    .collect::<Vec<_>>();

if supports_fast {
    descriptors.push(json!({
        "id": "fastMode",
        "label": "Fast",
        "type": "boolean",
        "currentValue": false,
    }));
}
```

- [ ] **Step 6: Run focused tests and commit**

Run:

```powershell
vp test packages/shared/src/model.test.ts packages/shared/src/providerSessionDefaults.test.ts
cargo test -p bibcode-server provider::codex::model::tests
cargo test -p bibcode-server provider::opencode::model::tests
```

Commit:

```powershell
git add packages/shared/src/model.ts packages/shared/src/providerSessionDefaults.ts packages/shared/src/model.test.ts apps/server/src/provider/codex/model.rs apps/server/src/provider/opencode/model.rs
git commit -m "fix: report provider toolbar capabilities truthfully"
```

---

### Task 2: Preserve Canonical Options Through Durable Delivery

**Files:**
- Modify: `apps/server/src/production/provider_runtime.rs`
- Modify: `apps/server/tests/production_provider_runtime.rs`
- Modify: `apps/server/tests/turn_delivery_recovery.rs`

- [ ] **Step 1: Add failing launch-request and fingerprint tests**

Add tests proving boolean and select options survive extraction and that option changes alter the frozen-route fingerprint:

```rust
#[test]
fn launch_request_preserves_canonical_options() {
    let selection = json!({
        "instanceId": "codex",
        "model": "gpt-5.6",
        "options": [
            { "id": "fastMode", "value": true },
            { "id": "reasoningEffort", "value": "high" }
        ]
    });
    let request = launch_request_for_command(&selection, None);
    assert_eq!(request.options, vec![
        json!({ "id": "fastMode", "value": true }),
        json!({ "id": "reasoningEffort", "value": "high" }),
    ]);
}

#[test]
fn launch_request_derives_effort_from_provider_aliases() {
    for option_id in ["reasoningEffort", "effort", "reasoning"] {
        let request = launch_request_for_command(
            &selection_with_options(vec![json!({ "id": option_id, "value": "high" })]),
            None,
        );
        assert_eq!(request.effort.as_deref(), Some("high"));
    }
}

#[test]
fn delivery_fingerprint_changes_when_options_change() {
    let standard = launch_request_fixture(vec![json!({ "id": "fastMode", "value": false })]);
    let fast = launch_request_fixture(vec![json!({ "id": "fastMode", "value": true })]);
    assert_ne!(delivery_route_fingerprint(&standard), delivery_route_fingerprint(&fast));
}
```

- [ ] **Step 2: Run the focused server test and confirm options are dropped**

Run: `cargo test -p bibcode-server --lib production::provider_runtime::tests::launch_request_preserves_canonical_options`

Expected: FAIL because `ProviderLaunchRequest` has no canonical options field.

- [ ] **Step 3: Add deterministic option normalization at the trust boundary**

Use `BTreeMap` so duplicate ids resolve last-value-wins and the result is stable for equality/fingerprints. Ignore malformed entries rather than allowing them to perturb routing:

```rust
fn selection_options(selection: &Value) -> Vec<Value> {
    let mut options = BTreeMap::<String, Value>::new();
    for option in selection
        .get("options")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(id) = option.get("id").and_then(Value::as_str).map(str::trim) else {
            continue;
        };
        let Some(value) = option.get("value") else { continue };
        if id.is_empty() || !(value.is_string() || value.is_boolean()) {
            continue;
        }
        options.insert(id.to_owned(), value.clone());
    }
    options
        .into_iter()
        .map(|(id, value)| json!({ "id": id, "value": value }))
        .collect()
}
```

Add `pub options: Vec<Value>` to `ProviderLaunchRequest`. Derive legacy `service_tier`, `effort`, and `agent` fields from this normalized vector so existing launch argument code stays small. Resolve effort from the existing canonical aliases in priority order:

```rust
fn selection_effort(options: &[Value]) -> Option<String> {
    ["reasoningEffort", "effort", "reasoning"]
        .into_iter()
        .find_map(|id| selection_string_option_from(options, id))
}
```

- [ ] **Step 4: Include normalized options in route equality and fingerprints**

Compare `request.options` when deciding whether a session matches. Serialize the already-sorted vector into the fingerprint payload and bump `DELIVERY_ROUTE_FINGERPRINT_VERSION` from `provider-route-v3` to `provider-route-v4` so old and new fingerprints cannot collide:

```rust
let payload = json!({
    "version": DELIVERY_ROUTE_FINGERPRINT_VERSION,
    "instanceId": request.provider_instance_id,
    "model": request.model,
    "options": request.options,
});
```

Update every test fixture constructing `ProviderLaunchRequest` with `options: Vec::new()` or the asserted options.

- [ ] **Step 5: Run durable-delivery tests and commit**

Run:

```powershell
cargo test -p bibcode-server --lib production::provider_runtime::tests
cargo test -p bibcode-server --test production_provider_runtime
cargo test -p bibcode-server --test turn_delivery_recovery
```

Commit:

```powershell
git add apps/server/src/production/provider_runtime.rs apps/server/tests/production_provider_runtime.rs apps/server/tests/turn_delivery_recovery.rs
git commit -m "fix: preserve provider options in delivery routes"
```

---

### Task 3: Reconcile Model Options Before Every Turn

**Files:**
- Modify: `apps/server/src/production/provider_runtime.rs`
- Modify: `apps/server/tests/production_provider_runtime.rs`

- [ ] **Step 1: Add failing tests for live apply, restart fallback, and failure safety**

Extend the fake provider driver to record `set_options` calls. Add three behavioral tests:

```rust
#[tokio::test]
async fn metadata_update_applies_options_to_the_live_session() {
    let harness = RuntimeHarness::running_thread().await;
    harness.update_metadata(selection_with_fast(true)).await.unwrap();
    assert_eq!(harness.driver.option_updates(), vec![vec![
        json!({ "id": "fastMode", "value": true })
    ]]);
}

#[tokio::test]
async fn unsupported_live_update_restarts_with_the_new_options() {
    let harness = RuntimeHarness::driver_rejecting_option_updates().await;
    harness.update_metadata(selection_with_fast(true)).await.unwrap();
    assert_eq!(harness.last_launch().options, vec![json!({ "id": "fastMode", "value": true })]);
}

#[tokio::test]
async fn failed_reconciliation_does_not_deliver_the_prompt() {
    let harness = RuntimeHarness::driver_failing_option_updates_and_restart().await;
    assert!(harness.deliver_turn(selection_with_fast(true), "do work").await.is_err());
    assert!(harness.driver.prompts().is_empty());
}

#[tokio::test]
async fn initial_launch_rejects_unknown_options_before_delivery() {
    let harness = RuntimeHarness::new().await;
    let selection = selection_with_options(vec![json!({ "id": "madeUpMode", "value": true })]);
    assert!(harness.deliver_turn(selection, "do work").await.is_err());
    assert!(harness.driver.prompts().is_empty());
}

#[tokio::test]
async fn unsupported_option_keeps_the_existing_session() {
    let harness = RuntimeHarness::running_thread().await;
    let session_id = harness.active_session_id();
    let result = harness
        .update_metadata(selection_with_options(vec![json!({ "id": "madeUpMode", "value": true })]))
        .await;
    assert!(result.is_err());
    assert_eq!(harness.active_session_id(), session_id);
}
```

- [ ] **Step 2: Run the focused tests and confirm current code delivers without applying options**

Run: `cargo test -p bibcode-server --test production_provider_runtime metadata_update_applies_options_to_the_live_session`

Expected: FAIL because metadata updates currently reconcile only the model/restart path.

- [ ] **Step 3: Add the single shared reconciliation function**

Extend `ProviderDriver` with one narrow operation:

```rust
pub trait ProviderDriver: Send + Sync {
    fn set_options(
        &self,
        options: Vec<Value>,
    ) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>>;
    // existing methods stay unchanged
}
```

Implement one helper used by metadata updates and both delivery paths. Each concrete driver accepts only the canonical ids and values it implements. Unknown or unadvertised values return a normal `ProviderRuntimeError::Provider` rejection so the current session is preserved; reserve `UnsupportedCapability` for a supported change that specifically requires restart/resume. This is the server boundary that prevents stale or older clients from sending arbitrary options:

```rust
fn unsupported_option(provider: &str, option_id: &str) -> ProviderRuntimeError {
    ProviderRuntimeError::Provider {
        provider: provider.to_owned(),
        detail: format!("option {option_id} is not supported by the selected model/session"),
    }
}
```

```rust
async fn reconcile_model_selection(
    engine: &OrchestrationEngine,
    factory: &Arc<dyn ProviderDriverFactory>,
    activity: &ActivityProjection,
    sessions: &mut HashMap<String, SessionEntry>,
    thread_id: &str,
    selection: &Value,
    operational_log: Option<&ProviderOperationalLog>,
) -> Result<(), ProviderRuntimeError> {
    let target_model = model_from_selection(selection);
    let target_options = selection_options(selection);
    let mut restart_launch = None;
    {
        let entry = sessions
            .get_mut(thread_id)
            .ok_or_else(|| ProviderRuntimeError::SessionNotFound {
                thread_id: thread_id.to_owned(),
            })?;
        let model_changed = entry.launch.model != target_model;
        let options_changed = entry.launch.options != target_options;
        let update = async {
            if model_changed {
                if let Some(model) = target_model.clone() {
                    entry.driver.set_model(model).await?;
                }
            }
            if options_changed {
                entry.driver.set_options(target_options.clone()).await?;
            }
            Ok::<(), ProviderRuntimeError>(())
        }
        .await;
        match update {
            Ok(()) => {
                entry.launch.model = target_model;
                entry.launch.options = target_options;
                persist_entry(&engine.repositories(), entry, "ready").await?;
            }
            Err(ProviderRuntimeError::UnsupportedCapability { .. }) => {
                let mut launch = entry.launch.clone();
                launch.model = target_model;
                launch.options = target_options;
                restart_launch = Some(launch);
            }
            Err(error) => return Err(error),
        }
    }
    if let Some(launch) = restart_launch {
        restart_session(
            engine,
            factory,
            activity,
            sessions,
            thread_id,
            launch,
            operational_log,
        )
        .await?;
    }
    Ok(())
}
```

Use the existing restart/resume helper and operational logging parameters present in `provider_runtime.rs`; do not duplicate session construction. Persist `current.launch` only after all updates acknowledge success. Log provider instance, model, canonical option id, requested value, application method (`live` or `restart`), and result through the existing operational log; never log prompts, environment values, credentials, or serialized settings.

Apply the normalized option vector once during initial session startup too, after `driver.start()` has exposed provider session metadata but before the `SessionEntry` can deliver a turn:

```rust
let started = driver.start().await?;
if let Err(error) = driver.set_options(request.options.clone()).await {
    let _ = driver.shutdown().await;
    persist_runtime(
        &engine.repositories(),
        &request,
        "error",
        started.resume_cursor.clone(),
        Some(json!({ "error": error.to_string() })),
    )
    .await?;
    return Err(error);
}
```

For launch-configured providers such as Claude, `set_options` acknowledges an option vector equal to the launch vector and rejects a different or unknown vector. For Cursor this post-start call is where the advertised ACP config ids are validated and applied.

- [ ] **Step 4: Route initial launch and all three update/delivery call sites through reconciliation**

Call the helper from:

1. Initial `launch_session` validation/application before the session becomes deliverable.
2. `ThreadMetaUpdate` when a live session exists.
3. Non-durable `ThreadTurnStart` before prompt delivery.
4. Durable supervisor `Deliver` before `spawn_delivery` and before provider identity is frozen for the attempt.

If reconciliation returns an error, return/record the failure and do not invoke the prompt delivery method.

- [ ] **Step 5: Run runtime tests and commit**

Run:

```powershell
cargo test -p bibcode-server --lib production::provider_runtime::tests
cargo test -p bibcode-server --test production_provider_runtime
cargo test -p bibcode-server --test turn_delivery_recovery
```

Commit:

```powershell
git add apps/server/src/production/provider_runtime.rs apps/server/tests/production_provider_runtime.rs
git commit -m "fix: reconcile provider options before turn delivery"
```

---

### Task 4: Apply Codex and Cursor Options Live

**Files:**
- Modify: `apps/server/src/provider/codex/runtime.rs`
- Modify: `apps/server/src/provider/cursor/runtime.rs`
- Modify: `apps/server/src/provider/cursor/model.rs`
- Modify: `apps/server/src/production/provider_runtime.rs`
- Modify: `apps/server/tests/provider_cursor.rs`

- [ ] **Step 1: Add failing adapter tests**

For Codex, assert that updating service tier and reasoning effort changes the next `turn/start` payload without creating a new session. For Cursor, assert that `fastMode=true` sends `session/set_config_option` with `{ configId: "fast", value: "true" }` and stores the returned `configOptions`.

```rust
#[tokio::test]
async fn codex_option_update_changes_the_next_turn_payload() {
    let runtime = codex_runtime_fixture().await;
    runtime.set_turn_options(Some("fast".into()), Some("high".into())).await;
    runtime.send_turn("hello", vec![]).await.unwrap();
    assert_eq!(last_turn_start()["serviceTier"], "fast");
    assert_eq!(last_turn_start()["effort"], "high");
}

#[tokio::test]
async fn cursor_fast_mode_uses_acp_config_update() {
    let runtime = cursor_runtime_fixture_with_fast_config().await;
    runtime.set_options(vec![json!({ "id": "fastMode", "value": true })]).await.unwrap();
    assert_eq!(last_rpc_params(), json!({ "sessionId": "s1", "configId": "fast", "value": "true" }));
}
```

- [ ] **Step 2: Run the focused tests and confirm no live option method exists**

Run:

```powershell
cargo test -p bibcode-server provider::codex::runtime::tests::codex_option_update_changes_the_next_turn_payload
cargo test -p bibcode-server --test provider_cursor cursor_fast_mode_uses_acp_config_update
```

Expected: FAIL at compile time or assertion because adapters cannot update options.

- [ ] **Step 3: Add mutable Codex per-turn options**

Keep immutable session identity separate from per-turn values:

```rust
#[derive(Clone, Default)]
struct CodexTurnOptions {
    service_tier: Option<String>,
    effort: Option<String>,
}

// RuntimeInner
turn_options: Mutex<CodexTurnOptions>,

pub async fn set_turn_options(&self, service_tier: Option<String>, effort: Option<String>) {
    *self.inner.turn_options.lock().await = CodexTurnOptions { service_tier, effort };
}
```

Read one cloned snapshot at the start of `send_turn` and put it into the existing `turn/start` payload. Implement `CodexDriver::set_options` by translating `serviceTier` and `reasoningEffort`; reject any option id or value the adapter cannot represent for the initialized model/account without requesting a restart.

- [ ] **Step 4: Reuse Cursor's existing ACP mapping and apply it**

Use `resolve_acp_config_updates` rather than duplicating provider-specific ids:

```rust
pub async fn apply_config_updates(&self, options: &[Value]) -> Result<(), CursorRuntimeError> {
    let current = self.inner.config_options.lock().await.clone();
    let updates = resolve_acp_config_updates(&current, options)?;
    for update in updates {
        let response = self
            .inner.client
            .set_session_config_option(&self.inner.session_id, update.config_id, update.value)
            .await?;
        *self.inner.config_options.lock().await = response.config_options;
    }
    Ok(())
}
```

Reject a missing advertised config option or unknown canonical id as an unsupported option without restarting; ACP configuration support cannot be created by relaunching the same provider/model.

- [ ] **Step 5: Run adapter/runtime tests and commit**

Run:

```powershell
cargo test -p bibcode-server provider::codex::runtime::tests
cargo test -p bibcode-server provider::cursor::runtime::tests
cargo test -p bibcode-server --test provider_cursor
cargo test -p bibcode-server --test production_provider_runtime
```

Commit:

```powershell
git add apps/server/src/provider/codex/runtime.rs apps/server/src/provider/cursor/runtime.rs apps/server/src/provider/cursor/model.rs apps/server/src/production/provider_runtime.rs apps/server/tests/provider_cursor.rs
git commit -m "fix: apply Codex and Cursor options live"
```

---

### Task 5: Translate Claude and OpenCode Options Safely

**Files:**
- Modify: `apps/server/src/production/provider_runtime.rs`
- Modify: `apps/server/src/provider/opencode/runtime.rs`
- Modify: `apps/server/tests/provider_opencode.rs`

- [ ] **Step 1: Add failing Claude launch and OpenCode request tests**

Assert that Claude Fast is session-local and that OpenCode sends the selected variant:

```rust
#[test]
fn claude_fast_mode_is_merged_into_session_settings() {
    let request = launch_request_fixture(vec![json!({ "id": "fastMode", "value": true })]);
    let args = build_claude_launch_arguments(&request, Some(json!({ "hooks": {} })));
    let settings = settings_argument(&args);
    assert_eq!(settings["fastMode"], true);
    assert!(settings.get("hooks").is_some());
}

#[tokio::test]
async fn opencode_fast_mode_adds_fast_variant_to_prompt() {
    let runtime = opencode_runtime_fixture().await;
    runtime.set_variant(Some("fast".into())).await;
    runtime.send_turn("hello", vec![]).await.unwrap();
    assert_eq!(last_prompt_body()["variant"], "fast");
}
```

- [ ] **Step 2: Run the focused tests and confirm current payloads omit Fast**

Run:

```powershell
cargo test -p bibcode-server claude_fast_mode_is_merged_into_session_settings
cargo test -p bibcode-server --test provider_opencode opencode_fast_mode_adds_fast_variant_to_prompt
```

Expected: FAIL because Claude settings currently contain hooks only and OpenCode bodies omit `variant`.

- [ ] **Step 3: Merge Claude session settings without touching global config**

Build one JSON settings object from existing hook settings plus canonical options:

```rust
fn claude_session_settings(request: &ProviderLaunchRequest, hooks: Option<Value>) -> Option<Value> {
    let mut settings = hooks.and_then(|value| value.as_object().cloned()).unwrap_or_default();
    if let Some(fast) = selection_boolean_option(&request.options, "fastMode") {
        settings.insert("fastMode".into(), Value::Bool(fast));
    }
    (!settings.is_empty()).then(|| Value::Object(settings))
}
```

Pass the serialized value through the existing `--settings` argument. `ClaudeDriver::set_options` acknowledges its exact launch option vector, returns `UnsupportedCapability` when a supported session-local option changes, and rejects unknown ids without restart. The shared reconciliation path therefore restarts/resumes Claude only for a known supported change. Do not write `~/.claude/settings.json` or mutate any global setting.

- [ ] **Step 4: Carry OpenCode variant in runtime state and request bodies**

Add `selected_variant: Mutex<Option<String>>` to the existing runtime inner. Map canonical `fastMode=true` to `fast`, `fastMode=false` to the selected/default non-fast variant, and preserve a canonical `variant` selection for other advertised variants:

```rust
pub async fn set_variant(&self, variant: Option<String>) {
    *self.inner.selected_variant.lock().await = variant;
}

let variant = self.inner.selected_variant.lock().await.clone();
let mut body = json!({ "parts": parts });
if let Some(variant) = variant {
    body["variant"] = Value::String(variant);
}
```

Apply the same field to command bodies. Reject a requested variant not advertised by the selected model or an unknown canonical id without restarting.

- [ ] **Step 5: Run adapter/runtime tests and commit**

Run:

```powershell
cargo test -p bibcode-server claude_session_settings
cargo test -p bibcode-server provider::opencode::runtime::tests
cargo test -p bibcode-server --test provider_opencode
cargo test -p bibcode-server --test production_provider_runtime
```

Commit:

```powershell
git add apps/server/src/production/provider_runtime.rs apps/server/src/provider/opencode/runtime.rs apps/server/tests/provider_opencode.rs
git commit -m "fix: translate Claude and OpenCode toolbar options"
```

---

### Task 6: Commit Toolbar Option Changes Immediately

**Files:**
- Modify: `apps/web/src/components/chat/TraitsPicker.tsx`
- Modify: `apps/web/src/components/chat/ChatComposer.tsx`
- Modify: `apps/web/src/components/ChatView.tsx`
- Modify: `apps/web/src/components/chat/TraitsPicker.test.tsx`
- Modify: `apps/web/src/components/ChatView.test.tsx`

- [ ] **Step 1: Add failing UI tests for immediate commit and rollback**

Cover both success and failure:

```tsx
it("commits Fast through thread metadata before showing it active", async () => {
  const updateMetadata = vi.fn().mockResolvedValue({ _tag: "Success", value: undefined });
  renderThread({ updateMetadata });
  await user.click(screen.getByRole("button", { name: "Enable fast mode" }));
  expect(updateMetadata).toHaveBeenCalledWith(expect.objectContaining({
    modelSelection: expect.objectContaining({
      options: expect.arrayContaining([{ id: "fastMode", value: true }]),
    }),
  }));
  expect(screen.getByRole("button", { name: "Disable fast mode" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

it("keeps the previous selection when metadata update fails", async () => {
  renderComposer({ onModelOptionsChange: vi.fn().mockRejectedValue(new Error("provider rejected Fast")) });
  await user.click(screen.getByRole("button", { name: "Enable fast mode" }));
  expect(screen.getByRole("button", { name: "Enable fast mode" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  expect(toastManager.add).toHaveBeenCalledWith(expect.objectContaining({
    description: "provider rejected Fast",
  }));
});
```

- [ ] **Step 2: Run focused web tests and confirm options are currently local-only**

Run: `vp test apps/web/src/components/chat/TraitsPicker.test.tsx apps/web/src/components/ChatView.test.tsx`

Expected: FAIL because the current updater writes the draft store synchronously and does not await server acknowledgement.

- [ ] **Step 3: Make the existing option updater asynchronous**

Do not add a new store. Change the callback and updater types:

```ts
type CommitModelOptions = (
  nextOptions: ProviderOptions | undefined,
) => void | Promise<void>;

type UpdateDescriptor = (
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
  descriptorId: string,
  currentValue: string | boolean | undefined,
) => Promise<void>;
```

Return pending/error state from the hook. An external callback owns its acknowledged store write; the local draft branch writes directly:

```ts
const commitDescriptor = useCallback(async (descriptors, descriptorId, currentValue) => {
  const nextOptions = buildProviderOptionSelectionsFromDescriptors(
    replaceDescriptorCurrentValue(descriptors, descriptorId, currentValue),
  );
  setPendingDescriptorId(descriptorId);
  try {
    if ("onModelOptionsChange" in persistence) {
      await persistence.onModelOptionsChange(nextOptions);
      return;
    }
    const threadTarget = persistence.threadRef ?? persistence.draftId;
    if (!threadTarget) return;
    setProviderModelOptions(threadTarget, provider, nextOptions, {
      ...(instanceId ? { instanceId } : {}),
      model,
      persistSticky: true,
    });
  } catch (error) {
    toastManager.add({
      type: "error",
      title: "Could not update provider option",
      description: error instanceof Error ? error.message : "The provider rejected this option.",
    });
  } finally {
    setPendingDescriptorId(null);
  }
}, [instanceId, model, persistence, provider, setProviderModelOptions]);
```

For a draft without a server thread, the local branch resolves immediately after the store write. On rejection, retain old options and show the normalized error through the existing toast manager.

- [ ] **Step 4: Wire the existing metadata command from ChatView**

Add one callback prop to `ChatComposer`:

```ts
onCommitModelSelection?: (selection: ModelSelection) => Promise<void>;
```

In `ChatView`, reuse `threadEnvironment.updateMetadata`:

```tsx
const commitComposerModelSelection = useCallback(
  async (selection: ModelSelection) => {
    if (routeKind !== "server") return;
    const result = await updateThreadMetadata({
      environmentId,
      input: {
        threadId,
        modelSelection: selection,
      },
    });
    if (result._tag === "Failure") {
      throw squashAtomCommandFailure(result);
    }
  },
  [environmentId, routeKind, threadId, updateThreadMetadata],
);
```

In `ChatComposer`, build the next `ModelSelection` with existing `createModelSelection`, await this callback, then persist the acknowledged options in the composer draft store:

```tsx
const commitComposerModelOptions = useCallback(
  async (nextOptions: ModelSelection["options"]) => {
    const selection = createModelSelection(
      selectedInstanceId,
      selectedModel,
      nextOptions,
    );
    await onCommitModelSelection?.(selection);
    setProviderModelOptions(composerDraftTarget, selectedProvider, nextOptions, {
      instanceId: selectedInstanceId,
      model: selectedModel,
      persistSticky: true,
    });
  },
  [
    composerDraftTarget,
    onCommitModelSelection,
    selectedModel,
    selectedProvider,
    selectedInstanceId,
    setProviderModelOptions,
  ],
);
```

Pass this function to `ComposerTraitControls`. Keep the existing pre-turn metadata safeguard as an idempotent fallback.

- [ ] **Step 5: Run focused tests and commit**

Run:

```powershell
vp test apps/web/src/components/chat/TraitsPicker.test.tsx apps/web/src/components/ChatView.test.tsx
vp run typecheck
```

Commit:

```powershell
git add apps/web/src/components/chat/TraitsPicker.tsx apps/web/src/components/chat/ChatComposer.tsx apps/web/src/components/ChatView.tsx apps/web/src/components/chat/TraitsPicker.test.tsx apps/web/src/components/ChatView.test.tsx
git commit -m "fix: apply composer options immediately"
```

---

### Task 7: Render Truthful Disabled, Applying, and Active Toolbar States

**Files:**
- Modify: `apps/web/src/components/chat/composerProviderState.tsx`
- Modify: `apps/web/src/providerModels.ts`
- Modify: `apps/web/src/components/chat/TraitsPicker.tsx`
- Modify: `apps/web/src/components/chat/ChatComposer.tsx`
- Modify: `apps/web/src/components/chat/composerProviderState.test.tsx`
- Modify: `apps/web/src/components/chat/TraitsPicker.test.tsx`
- Modify: `apps/web/src/components/chat/ChatComposer.test.tsx`

- [ ] **Step 1: Add failing availability and styling tests**

Add coverage for supported, unsupported, unknown, applying, and active states:

```tsx
it("keeps unsupported Fast visible with a focusable reason", async () => {
  renderComposer({ models: [modelWithoutFast()] });
  const button = screen.getByRole("button", { name: /fast mode is not supported/i });
  expect(button).toHaveAttribute("aria-disabled", "true");
  button.focus();
  expect(await screen.findByText(/not supported by .* through/i)).toBeVisible();
});

it("uses theme tokens for active Fast", () => {
  renderComposer({ models: [modelWithFast(true)] });
  expect(screen.getByRole("button", { name: "Disable fast mode" })).toHaveClass(
    "bg-primary",
    "text-primary-foreground",
  );
});

it("shows Plan as unknown while provider state is unresolved", () => {
  renderComposer({ providerSnapshot: undefined });
  expect(screen.getByRole("button", { name: /plan mode availability is still loading/i }))
    .toHaveAttribute("aria-disabled", "true");
});

it("shows selected effort and edit mode as solid icon-only controls", () => {
  renderComposer({ effort: "high", runtimeMode: "auto-accept-edits" });
  expect(screen.getByRole("button", { name: /reasoning effort: high/i })).toHaveClass(
    "bg-primary",
    "text-primary-foreground",
  );
  expect(screen.getByRole("button", { name: "Auto-accept edits" })).toHaveClass(
    "bg-primary",
    "text-primary-foreground",
  );
  expect(screen.queryByText("Auto-accept edits")).not.toBeInTheDocument();
});

it("shows an inoperable applying state until Fast is acknowledged", async () => {
  let acknowledge!: () => void;
  const commit = new Promise<void>((resolve) => {
    acknowledge = resolve;
  });
  renderComposer({ onModelOptionsChange: () => commit });
  await user.click(screen.getByRole("button", { name: "Enable fast mode" }));
  expect(screen.getByRole("button", { name: "Applying fast mode" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  acknowledge();
});

it("does not carry Fast or agent controls across provider changes", async () => {
  const commit = vi.fn();
  const view = renderComposer({ provider: "codex", fastMode: true, commit });
  view.rerender(composer({ provider: "opencode", model: modelWithoutFast(), commit }));
  expect(screen.getByRole("button", { name: /fast mode is not supported/i }))
    .toHaveAttribute("aria-disabled", "true");
  expect(screen.queryByRole("button", { name: /agent/i })).not.toBeInTheDocument();
  expect(commit).not.toHaveBeenCalled();
});

it("turns Plan off as build mode without rendering a Build icon", async () => {
  const onToggle = vi.fn();
  renderComposer({ interactionMode: "plan", onToggleInteractionMode: onToggle });
  await user.click(screen.getByRole("button", { name: "Disable plan mode" }));
  expect(onToggle).toHaveBeenCalledOnce();
  expect(screen.queryByLabelText(/build mode/i)).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run focused tests and confirm controls are hidden or visually muted**

Run:

```powershell
vp test apps/web/src/components/chat/composerProviderState.test.tsx apps/web/src/components/chat/TraitsPicker.test.tsx apps/web/src/components/chat/ChatComposer.test.tsx
```

Expected: FAIL because missing traits return `null`, missing Plan state defaults to supported, and active Plan uses hard-coded blue classes.

- [ ] **Step 3: Derive a local three-state availability value**

Keep this UI-only type local rather than expanding contracts:

```ts
export type ComposerControlAvailability =
  | { state: "supported" }
  | { state: "unknown"; reason: string }
  | { state: "unsupported"; reason: string };
```

For Fast and effort:

- models/provider snapshot not loaded: `unknown`;
- selected model loaded and descriptor present: `supported`;
- selected model loaded and descriptor absent: `unsupported`.

Use a concrete reason such as `Fast mode is not supported by GPT-5.6 through OpenCode.` For Plan, replace the unconditional boolean fallback with an availability helper: no selected provider snapshot is unknown, an explicit `showInteractionModeToggle: false` is unsupported, and a loaded snapshot with `true` or the existing omitted/default value is supported. This preserves the four built-in providers' current Plan behavior while avoiding a false-ready state during provider loading.

- [ ] **Step 4: Keep disabled controls focusable and show reasons**

Render Fast, effort, and Plan regardless of availability. Wrap disabled controls with the existing tooltip primitives:

```tsx
<Tooltip>
  <TooltipTrigger
    render={
      <Button
        type="button"
        size="sm"
        variant={isActive ? "default" : "ghost"}
        aria-disabled={availability.state !== "supported" || isApplying}
        aria-label={ariaLabel}
        onClick={() => {
          if (availability.state !== "supported" || isApplying) return;
          void onToggle();
        }}
      />
    }
  >
    <ZapIcon aria-hidden="true" className="size-3.5" />
    <span className="hidden lg:inline">Fast</span>
  </TooltipTrigger>
  {availability.state === "supported" ? null : (
    <TooltipPopup>{availability.reason}</TooltipPopup>
  )}
</Tooltip>
```

Use the current spinner icon/pattern while applying and set `aria-label="Applying fast mode"`. The prior selection remains visually active until acknowledgement. For effort, use `variant="default"` when a confirmed selection exists, keep only `EffortLevelIcon` in the toolbar, and retain full labels in its menu. Do not include `agentDescriptor` in `shouldRenderComposerTraitControls` or `ComposerTraitControls`.

- [ ] **Step 5: Use theme-native solid state for Plan and the selected edit mode**

Keep `MapIcon`, use `variant={interactionMode === "plan" ? "default" : "ghost"}`, and remove the blue class branch. Its click handler continues to toggle only between `plan` and `build`; off has no Build icon or label.

The runtime/edit mode control already shows only `RuntimeModeIcon` and keeps labels in `SelectPopup`. Preserve that structure and give its selected trigger the same solid theme classes without adding a new select variant:

```tsx
<SelectTrigger
  variant="ghost"
  size="sm"
  className="shrink-0 border-primary bg-primary px-2 text-primary-foreground [&_svg]:text-primary-foreground"
  aria-label={runtimeModeOption.label}
/>
```

- [ ] **Step 6: Run UI tests, accessibility assertions, and commit**

Run:

```powershell
vp test apps/web/src/components/chat/composerProviderState.test.tsx apps/web/src/components/chat/TraitsPicker.test.tsx apps/web/src/components/chat/ChatComposer.test.tsx apps/web/src/components/ChatView.test.tsx
vp run typecheck
```

Commit:

```powershell
git add apps/web/src/components/chat/composerProviderState.tsx apps/web/src/providerModels.ts apps/web/src/components/chat/TraitsPicker.tsx apps/web/src/components/chat/ChatComposer.tsx apps/web/src/components/chat/composerProviderState.test.tsx apps/web/src/components/chat/TraitsPicker.test.tsx apps/web/src/components/chat/ChatComposer.test.tsx
git commit -m "feat: clarify provider toolbar capability states"
```

---

### Task 8: Full Verification and Desktop Visual Check

**Files:**
- Verify only; fix failures in the owning files from Tasks 1–7.

- [ ] **Step 1: Run repository-required checks**

Run:

```powershell
vp check
vp run typecheck
```

Expected: both exit successfully with no new diagnostics.

- [ ] **Step 2: Run the relevant TypeScript and Rust suites**

Run:

```powershell
vp test packages/shared/src/model.test.ts packages/shared/src/providerSessionDefaults.test.ts apps/web/src/components/chat/composerProviderState.test.tsx apps/web/src/components/chat/TraitsPicker.test.tsx apps/web/src/components/chat/ChatComposer.test.tsx apps/web/src/components/ChatView.test.tsx
cargo test -p bibcode-server provider::codex
cargo test -p bibcode-server provider::cursor
cargo test -p bibcode-server provider::opencode
cargo test -p bibcode-server --test production_provider_runtime
cargo test -p bibcode-server --test turn_delivery_recovery
cargo test -p bibcode-server --test provider_cursor
cargo test -p bibcode-server --test provider_opencode
```

Expected: all selected suites pass.

- [ ] **Step 3: Build and run the Tauri desktop app**

Run `vp run build:desktop`, then launch the development desktop with `vp run start:desktop`. Keep the process running for visual inspection.

- [ ] **Step 4: Use the Computer Use skill for visual and interaction verification**

Inspect the desktop app at normal and narrow widths in both light and dark themes. Verify:

1. Codex, Claude, Cursor, and OpenCode show only capabilities proven for the selected model.
2. Unsupported/unknown Fast, effort, and Plan remain visible and expose their reason on mouse hover and keyboard focus.
3. Fast off is neutral; Fast on is solid using the current theme; applying is visibly distinct; failure restores the prior state.
4. Plan uses the folded-map icon; active Plan is solid theme-native; inactive Plan means build without a Build icon.
5. Effort shows only the level icon in the toolbar and the full labels in its menu.
6. No provider shows an agent selector in the compact toolbar.
7. Attachment, context usage, and MCP buttons remain present and functional.
8. No clipping or overlap appears at compact width.

Capture screenshots for the active, unsupported, and dark-theme cases as verification evidence.

- [ ] **Step 5: Inspect the final diff and commit verification fixes only if needed**

Run:

```powershell
git status --short
git diff --check
git diff --stat
```

If verification required code fixes, return to the owning task, rerun its focused tests, and use that task's explicit scoped `git add` command before committing. If verification changed no files, do not create an empty commit. Do not include unrelated pre-existing worktree changes.
