# Project Data Recovery Visual Blockers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Require a visible native confirmation before storage adoption and automatically open the privileged recovery dialog when desktop store startup fails with a typed recovery-required classification.

**Architecture:** The web sidebar will use the existing `LocalApi.dialogs.confirm` boundary. The desktop supervisor will retain a failed authoritative launch plan and emit a bounded project-data status invalidation event; the additive `DesktopBridge` subscription will make the recovery coordinator re-read Rust-owned statuses on mount and on invalidation. Event payloads never classify a store or carry paths; `getProjectDataStatuses` remains the source of truth.

**Tech Stack:** React 19, TypeScript, Effect/Vite+ tests, Tauri 2, Rust/Tokio, Axum persistence inspection, Codex Computer Use.

## Global Constraints

- Do not infer recovery from HTTP status codes or error-message text.
- Do not accept renderer filesystem paths, storage IDs, credentials, or raw errors in the invalidation event.
- Do not add T4Code discovery, migration, compatibility, or aliases.
- Do not automatically adopt, merge, delete, or replace a store.
- Keep remote bearer, relay, and SSH environments outside privileged local recovery.
- Preserve the existing browser confirmation fallback and Rust fail-closed database behavior.
- Use RED-to-GREEN tests before each production edit.
- Final validation must include an isolated packaged app, Codex Computer Use, original-resolution screenshots, and marker/database hash comparison.

---

### Task 1: Route Storage Adoption Through the Native Dialog Boundary

**Files:**
- Modify: `apps/web/src/components/Sidebar.test.tsx`
- Modify: `apps/web/src/components/Sidebar.tsx`

**Interfaces:**
- Consumes: `readLocalApi(): LocalApi | undefined`, `LocalApi.dialogs.confirm(message): Promise<boolean>`, and the existing `adoptProjectStorage(EnvironmentId)` command.
- Produces: `handleAdoptProjectStorage(environmentId)` that performs no transition unless the local API resolves confirmation to `true`.

- [ ] **Step 1: Write the failing cancellation and confirmation tests**

Extend the project-availability test section so the storage-changed fixture installs `fakeLocalApi()`. Add one test with `h.spies.dialogConfirm.mockResolvedValue(false)` and assert:

```ts
expect(h.spies.dialogConfirm).toHaveBeenCalledWith(
  "Use this project data location? Projects from the two locations will not be merged.",
);
expect(h.spies.windowConfirm).not.toHaveBeenCalled();
expect(h.state.commandCalls).not.toContainEqual({
  label: "environment.adoptStorage",
  input: ENV_MAIN,
});
```

Keep the positive case and assert exactly one `environment.adoptStorage` command only after the promise resolves `true`.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
vp test apps/web/src/components/Sidebar.test.tsx -t "storage adoption"
```

Expected: FAIL because `window.confirm` is called directly and adoption occurs despite the local API cancellation result.

- [ ] **Step 3: Implement the minimal asynchronous confirmation**

Replace the direct `window.confirm` callback with:

```ts
const handleAdoptProjectStorage = useCallback(
  (environmentId: EnvironmentId) => {
    const api = readLocalApi();
    if (!api) return;
    void api.dialogs
      .confirm("Use this project data location? Projects from the two locations will not be merged.")
      .then((confirmed) => {
        if (confirmed) void adoptProjectStorage(environmentId);
      })
      .catch(() => undefined);
  },
  [adoptProjectStorage],
);
```

Do not fall back to a second prompt after a native dialog rejection.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the same `vp test` command. Expected: both cancel and confirm cases PASS; raw `window.confirm` remains uncalled.

- [ ] **Step 5: Commit the independently testable dialog fix**

```bash
git add apps/web/src/components/Sidebar.tsx apps/web/src/components/Sidebar.test.tsx
git commit -m "fix(web): confirm storage adoption natively"
```

---

### Task 2: Retain Failed Desktop Plans and Emit Status Invalidations

**Files:**
- Modify: `apps/desktop/src-tauri/src/backend.rs`
- Test: `apps/desktop/src-tauri/src/backend.rs` test module

**Interfaces:**
- Consumes: `BackendLaunchPlan`, `BackendSupervisor`, `AppHandle<R>`, and `tauri::Emitter`.
- Produces: `PROJECT_DATA_STATUS_CHANGED_EVENT: &str = "desktop:project-data-status-changed"`; a payload `{ "environmentId": string }`; and failed slots that retain `launch_plan` while publishing no bootstrap.

- [ ] **Step 1: Write a real failed-start regression test**

Use a Tauri mock app with `IsolatedTestDataRoot`, create the resolved installed state directory, and write a malformed `environment-id`. Register an event listener, call `supervisor.start_default(app.handle().clone())`, and assert:

```rust
assert!(result.is_err());
assert!(supervisor.local_environment_bootstraps().is_empty());
assert_eq!(supervisor.project_data_targets().len(), 1);
assert_eq!(supervisor.project_data_targets()[0].environment_id, PRIMARY_LOCAL_ENVIRONMENT_ID);
assert_eq!(event_payload["environmentId"], PRIMARY_LOCAL_ENVIRONMENT_ID);
```

Also assert the retained target uses the isolated root and no backend is running.

- [ ] **Step 2: Run the exact Rust test and verify RED**

```bash
cargo test -p bibcode-desktop backend::tests::failed_default_backend_retains_project_data_target_and_emits_status_change -- --exact --nocapture --test-threads=1
```

Expected: FAIL because the event constant does not exist and generic primary start failure records no launch plan.

- [ ] **Step 3: Add the minimal failure owner and event**

Add:

```rust
pub const PROJECT_DATA_STATUS_CHANGED_EVENT: &str = "desktop:project-data-status-changed";

fn emit_project_data_status_changed<R: Runtime>(
    app: &AppHandle<R>,
    environment_id: &str,
) -> Result<(), String> {
    app.emit(
        PROJECT_DATA_STATUS_CHANGED_EVENT,
        json!({ "environmentId": environment_id }),
    )
    .map_err(|error| format!("Could not emit project-data status change: {error}"))
}
```

Refactor plan failure recording to accept `Option<BackendPlanError>` while always retaining the supplied launch plan, clearing runtime/pid state, hiding bootstraps through `last_error`, and preserving WSL preflight classification. In `start_default_with_reason`, record the primary plan before returning every post-planning start error, then emit the invalidation. Log an event failure without replacing the original startup error.

- [ ] **Step 4: Verify generic and WSL failure behavior GREEN**

Run:

```bash
cargo test -p bibcode-desktop backend::tests::failed_default_backend_retains_project_data_target_and_emits_status_change -- --exact --nocapture --test-threads=1
cargo test -p bibcode-desktop backend::tests::record_plan_error_resets_runtime_state_and_hides_bootstrap -- --exact --nocapture --test-threads=1
cargo test -p bibcode-desktop backend::tests::wsl_primary_start_failure -- --nocapture --test-threads=1
```

Expected: retained targets, hidden bootstraps, and typed WSL failures all PASS.

- [ ] **Step 5: Commit the independently testable host fix**

```bash
git add apps/desktop/src-tauri/src/backend.rs
git commit -m "fix(desktop): retain failed project data targets"
```

---

### Task 3: Add the Typed DesktopBridge Invalidation Subscription

**Files:**
- Modify: `packages/contracts/src/ipc.ts`
- Modify: `packages/contracts/src/ipc.test.ts`
- Modify: `apps/web/src/tauriDesktopBridge.ts`
- Modify: `apps/web/src/tauriDesktopBridge.test.ts`

**Interfaces:**
- Produces:

```ts
export interface DesktopProjectDataStatusChangedEvent {
  readonly environmentId: string;
}

onProjectDataStatusChanged?: (
  listener: (event: DesktopProjectDataStatusChangedEvent) => void,
) => () => void;
```

- Consumes: native event `desktop:project-data-status-changed` and existing `tauriListen` disposal semantics.

- [ ] **Step 1: Write contract and adapter RED tests**

Add a contract fixture that implements and calls the optional subscription. Extend the Tauri harness test to install the bridge, subscribe, emit:

```ts
harness.listeners.get("desktop:project-data-status-changed")?.({
  payload: { environmentId: "primary" },
});
```

Assert the exact payload is delivered once and disposal calls the registered unlistener once.

- [ ] **Step 2: Run the focused tests and verify RED**

```bash
vp test packages/contracts/src/ipc.test.ts apps/web/src/tauriDesktopBridge.test.ts -t "project data status"
```

Expected: type/test failure because the bridge subscription and event listener are absent.

- [ ] **Step 3: Add the interface and adapter implementation**

Add the event interface and optional `DesktopBridge` method. In `tauriDesktopBridge.ts`, define the event constant and return:

```ts
onProjectDataStatusChanged: (listener) =>
  tauriListen<DesktopProjectDataStatusChangedEvent>(
    PROJECT_DATA_STATUS_CHANGED_EVENT,
    listener,
  ),
```

Do not add browser emulation or path/error fields.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run the same combined `vp test` command. Expected: contract and adapter event/disposal cases PASS.

- [ ] **Step 5: Commit the additive bridge boundary**

```bash
git add packages/contracts/src/ipc.ts packages/contracts/src/ipc.test.ts apps/web/src/tauriDesktopBridge.ts apps/web/src/tauriDesktopBridge.test.ts
git commit -m "feat(desktop): notify project data status changes"
```

---

### Task 4: Open Recovery from Mount-Time and Event-Time Inspection

**Files:**
- Modify: `apps/web/src/AppRoot.tsx`
- Modify: `apps/web/src/ProjectDataRecoveryCoordinator.test.tsx`
- Modify: `apps/web/src/AppRoot.lifecycle.test.tsx` if its bridge fixture requires the additive callback

**Interfaces:**
- Consumes: `DesktopBridge.getProjectDataStatuses`, optional `DesktopBridge.onProjectDataStatusChanged`, existing shell statuses, and `projectDataSafetyStore.open(environmentId, "automatic")`.
- Produces: one automatic open per local recovery-required episode, independent of successful environment registration.

- [ ] **Step 1: Write mount-race and event-race RED tests**

Extend the coordinator harness with a mutable status result, a captured event listener, and an unlistener. Add tests for:

```ts
// Failure already recorded before mount.
h.projectDataStatuses = [recoveryRequiredPrimary];
await act(async () => root.render(<ProjectDataRecoveryCoordinator />));
expect(h.open).toHaveBeenCalledWith("primary", "automatic");

// Mount probes healthy, then failure event changes the authoritative result.
h.projectDataStatuses = [healthyPrimary];
await act(async () => root.render(<ProjectDataRecoveryCoordinator />));
h.projectDataStatuses = [recoveryRequiredPrimary];
await act(async () => h.projectDataStatusListener?.({ environmentId: "primary" }));
expect(h.open).toHaveBeenCalledWith("primary", "automatic");
```

Also assert healthy, unavailable, and remote-only results do not open; repeated failure notifications open once; a later healthy inspection resets the episode; and unmount disposes the listener.

- [ ] **Step 2: Run the coordinator tests and verify RED**

```bash
vp test apps/web/src/ProjectDataRecoveryCoordinator.test.tsx
```

Expected: mount/event cases FAIL because the coordinator only observes registered shell environments.

- [ ] **Step 3: Implement the authoritative probe**

Add local React state for the bridge-derived recovery environment. In one effect:

```ts
const inspect = async () => {
  const statuses = await bridge.getProjectDataStatuses?.();
  if (!active || statuses === undefined) return;
  setBridgeRecoveryEnvironmentId(
    statuses.find((status) => status.status === "recovery-required")?.environmentId ?? null,
  );
};

void inspect().catch(() => undefined);
const dispose = bridge.onProjectDataStatusChanged?.(() => {
  void inspect().catch(() => undefined);
});
return () => {
  active = false;
  dispose?.();
};
```

Select the existing shell-derived local recovery ID first, then the bridge-derived ID. Reuse the existing `lastAutomaticEnvironmentId` episode gate and reset it when both sources are clear. Never inspect a renderer-provided path or parse an error string.

- [ ] **Step 4: Run coordinator and lifecycle tests GREEN**

```bash
vp test apps/web/src/ProjectDataRecoveryCoordinator.test.tsx apps/web/src/AppRoot.lifecycle.test.tsx
```

Expected: all mount, event, deduplication, remote exclusion, and existing lifecycle cases PASS.

- [ ] **Step 5: Commit the automatic recovery coordinator**

```bash
git add apps/web/src/AppRoot.tsx apps/web/src/ProjectDataRecoveryCoordinator.test.tsx apps/web/src/AppRoot.lifecycle.test.tsx
git commit -m "fix(web): open recovery after startup failure"
```

---

### Task 5: Align Living Documentation and Run Automated Gates

**Files:**
- Modify: `docs/architecture/overview.md`
- Modify: `docs/guides/project-data-recovery.md`

**Interfaces:**
- Documents: native confirmation, retained failed launch plans, invalidation-only event payload, mount/event race closure, and typed recovery-only automatic opening.

- [ ] **Step 1: Update living documentation**

State explicitly that desktop storage adoption uses the native dialog boundary, and that failed local backend plans remain inspectable without becoming live. Document that the renderer treats the event only as an invalidation and re-reads Rust classification.

- [ ] **Step 2: Run affected focused and package tests**

```bash
vp test apps/web/src/components/Sidebar.test.tsx apps/web/src/ProjectDataRecoveryCoordinator.test.tsx apps/web/src/tauriDesktopBridge.test.ts packages/contracts/src/ipc.test.ts
cargo test -p bibcode-desktop -j 2 -- --test-threads=1
cargo test -p bibcode-server --test project_data_safety -- --test-threads=1
```

Expected: zero failures.

- [ ] **Step 3: Run static and workspace gates**

```bash
cargo fmt --all --check
cargo clippy -p bibcode-desktop --all-targets -- -D warnings
vp check
vp run --concurrency-limit 1 typecheck
```

Expected: every command exits 0; only already-documented Effect suggestions may appear.

- [ ] **Step 4: Review diff and commit documentation**

```bash
git diff --check
git status --short
git add docs/architecture/overview.md docs/guides/project-data-recovery.md
git commit -m "docs: describe startup recovery invalidation"
```

---

### Task 6: Rebuild and Retest the Packaged App with Codex Computer Use

**Files:**
- Reuse ignored config: `.superpowers/visual-test/tauri.visual.conf.json`
- Write ignored evidence: `.superpowers/visual-test/evidence/*.jpeg`

**Interfaces:**
- Consumes: isolated `BIBCODE_HOME`, the custom Tauri identifier `dev.bibcode.visual-safety-test`, and Codex Computer Use through `@oai/sky`.
- Produces: original-resolution screenshots and byte hashes proving both visual blockers fixed without touching real user data.

- [ ] **Step 1: Build the isolated packaged debug bundle**

```bash
cd apps/desktop
node ../../scripts/run-msvc-x64.mjs pnpm exec tauri build --debug --bundles app \
  --config ../../.superpowers/visual-test/tauri.visual.conf.json
```

Expected: `target/debug/bundle/macos/BiBCode Visual Safety Test.app` is rebuilt from the fixed source.

- [ ] **Step 2: Verify native adoption cancellation visually**

Launch the bundle with the isolated `BIBCODE_HOME`, force a storage-identity mismatch, click **Use this data location**, and capture the native dialog. Use Computer Use to click Cancel; assert the storage-changed sidebar remains and no accepted-identity transition occurs.

- [ ] **Step 3: Verify native adoption confirmation visually**

Open the native dialog again, click OK, and assert the mismatch clears only after confirmation. Capture and inspect the confirmation screenshot at original resolution.

- [ ] **Step 4: Verify automatic malformed-marker recovery visually**

Quit cleanly, record SHA-256 hashes, install a malformed marker only in the isolated root, and relaunch. Assert the **Project data recovery** dialog opens automatically instead of the generic HTTP 500 surface. Verify requested/effective roots and the malformed-marker issue are present.

- [ ] **Step 5: Exercise fail-closed actions**

Click Retry and confirm the dialog remains recovery-required. Open Start empty, capture the preservation confirmation, click Cancel, and verify marker/database hashes remain unchanged.

- [ ] **Step 6: Inspect screenshots and close cleanly**

Save screenshots under `.superpowers/visual-test/evidence`, inspect each with original pixel detail, then quit through the macOS application menu. Leave the real `~/.bibcode` and installed application untouched.

- [ ] **Step 7: Run final repository verification and commit any final scoped fixes**

```bash
codegraph sync .
git diff --check
git status --short
git log -8 --oneline
```

Expected: CodeGraph sync succeeds, tracked status is clean after scoped commits, and no manifest or lockfile drift exists.
