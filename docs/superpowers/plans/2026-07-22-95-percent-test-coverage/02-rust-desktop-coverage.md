# Rust Desktop Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add deterministic behavioral coverage for the Tauri desktop crate's preview, backend, bridge, SSH, shell, menu, and window boundaries so the crate makes its required contribution to repository-wide Rust coverage.

**Architecture:** Exercise the existing pure coordinators and parsers directly, then use Tauri's mock runtime, loopback servers, temporary files, and controlled child processes for native adapters. Where Objective-C or framework callbacks prevent deterministic execution, extract only platform-independent input validation and completion/result mapping into production helpers used by the real adapter.

**Tech Stack:** Rust 1.97.1, Cargo, Tokio, Tauri 2 test runtime, Reqwest, temporary files, loopback TCP, `cargo-llvm-cov`.

## Global Constraints

- Repository-wide Rust regions, functions, and lines must each reach at least 95%; this plan does not create a per-crate gate.
- The desktop baseline is 80.18% regions, 74.96% functions, and 82.28% lines, with 3,183 uncovered regions, 304 uncovered functions, and 2,029 uncovered lines.
- Preserve all desktop source in the Cargo workspace inventory. Do not add `#[coverage(off)]`, conditional test-only production behavior, or dummy calls.
- Keep native tests bounded. Loopback listeners bind port `0`; processes receive explicit deadlines and are reaped; temporary paths are owned by `tempfile`.
- Prefer existing in-module `#[cfg(test)] mod tests` blocks so private lifecycle state can be verified without widening production visibility.
- Any new production helper must be called by the real production path and introduced after a failing behavior test.
- Keep the workspace Rust thresholds at 90 until the final policy plan.
- Never commit LLVM profiles or coverage reports.

---

## Desktop Hotspot Order

| Production file | Uncovered regions | Uncovered functions | Uncovered lines | Primary seam |
| --- | ---: | ---: | ---: | --- |
| `preview/host.rs` | 889 | 79 | 576 | `HostCoordinator` and Tauri mock runtime |
| `backend.rs` | 478 | 40 | 320 | `BackendLifecycle`, loopback server, controlled child |
| `ssh.rs` | 422 | 41 | 268 | parsers, prompt manager, controlled `ssh` fixture |
| `preview/platform/macos.rs` | 250 | 33 | 187 | pure completion/result mapping plus worker-thread guard |
| `bridge.rs` | 296 | 27 | 151 | document normalization, loopback HTTP, Tauri mock runtime |
| `preview/commands.rs` | 202 | 39 | 141 | helper validation and mock app command dispatch |
| `shell_environment.rs` | 109 | 8 | 88 | delimiter parser and bounded shell fixture |
| `window.rs` / `context_menu.rs` | 247 | 14 | 133 | pure normalization and Tauri mock runtime |

### Task 1: Complete the Preview Host State Machine

**Files:**

- Modify: `apps/desktop/src-tauri/src/preview/host.rs`
- Test in place: `apps/desktop/src-tauri/src/preview/host.rs::tests`

**Interfaces:**

- Consumes: private `HostCoordinator::{begin, wait_until_settled, current_creation, is_created, begin_bounds_update, commit_creation, begin_close, claim_creation_cleanup, finish_creation_cleanup, finish_close, restore_close, record_navigation, is_current_navigation, reconcile_bounds}`.
- Produces: exhaustive transition coverage for a tab incarnation, label ownership, close restoration, navigation generations, and bounds reconciliation.

- [ ] **Step 1: Add a table for rejected preconditions**

Inside the existing test module, create fresh `HostCoordinator::default()` values and cover blank tab ID, blank label, duplicate tab creation, sanitized-label collision, bounds update before creation, close before creation, navigation before creation, wrong incarnation, and wrong label. Match the complete stable error strings already returned by production code.

Use this exact assertion shape for every rejection:

```rust
let error = coordinator
    .begin_bounds_update("missing-tab")
    .expect_err("a missing preview tab must reject bounds updates");
assert!(error.contains("missing-tab"), "unexpected error: {error}");
```

- [ ] **Step 2: Run the new precondition test**

Run: `cargo test -p bibcode-desktop preview::host::tests -- --nocapture`

Expected: the test passes for existing behavior. If an invariant is wrong, retain the failing assertion and correct the coordinator before adding more cases.

- [ ] **Step 3: Cover every creation settlement and commit variant**

For a fresh tab, exercise creator/waiter distinction, successful commit, canceled creation, failed creation, cleanup after attempted creation, cleanup before attempted creation, duplicate waiter, and an old-incarnation cleanup racing a new incarnation. Assert `owns_label`, `is_created`, current incarnation, and the exact `CreationSettlement`/`CreationCommit` variant after each transition.

Use pattern matching rather than debug-string assertions:

```rust
match coordinator.begin("tab-1", "preview-tab-1").expect("begin") {
    BeginCreation::Started(progress) => assert_eq!(progress.incarnation, 1),
    BeginCreation::InProgress { .. } | BeginCreation::AlreadyCreated { .. } => {
        panic!("the first caller must own creation")
    }
}
```

- [ ] **Step 4: Cover close, bounds, and navigation interleavings**

Exercise these exact sequences on separate coordinators:

1. create → bounds update → newer bounds revision → commit old revision → retry latest revision;
2. create → begin close → restore close → navigate;
3. create → begin close → finish close → late navigation callback;
4. create incarnation 1 → close → create incarnation 2 → late incarnation-1 close/cleanup;
5. create → navigation generations 1 and 2 → accept generation 2 and reject generation 1.

Assert state after every arrow, not only final state.

- [ ] **Step 5: Cover event and profile helpers**

Add rows for `ensure_macos_isolated_profile_available(true/false)`, `now_iso()` RFC3339 parseability, and complete desktop preview event JSON for loading, ready, navigation, title, error, and closed states.

- [ ] **Step 6: Run and commit the host cohort**

```bash
cargo test -p bibcode-desktop preview::host::tests -- --nocapture
git add apps/desktop/src-tauri/src/preview/host.rs
git commit -m "test: cover preview host lifecycle"
```

Expected: all host tests pass without global-coordinator test order dependence.

### Task 2: Cover Preview Commands and macOS Result Mapping

**Files:**

- Modify: `apps/desktop/src-tauri/src/preview/commands.rs`
- Modify: `apps/desktop/src-tauri/src/preview/platform/macos.rs`
- Modify only after a red test: `apps/desktop/src-tauri/src/preview/platform/mod.rs`
- Test in place: the corresponding `tests` modules.

**Interfaces:**

- Consumes: `parse_preview_url`, `validate_artifact_path`, `run_on_worker`, preview Tauri commands, `completion_wait_guard`, and `PlatformWebviewOps`.
- Produces: covered command validation, worker panic/error propagation, mock-app dispatch, and portable mapping for Objective-C completion values.

- [ ] **Step 1: Complete command helper boundary tests**

Add URL rows for `http`, `https`, mixed-case host, query/fragment, relative URL, missing host, `file`, `javascript`, and malformed percent encoding. Add artifact rows for a valid file, directory, missing path, sibling-prefix path, traversal, symlink escape, and canonicalization failure. Assert returned canonical paths or exact error categories.

Use a real `tempfile::TempDir` and create a file before calling `validate_artifact_path`; never compare unresolved paths.

- [ ] **Step 2: Cover worker completion semantics**

Add `#[tokio::test]` cases for `run_on_worker(|| Ok(7))`, `run_on_worker(|| Err("failed".to_owned()))`, and a worker panic. Assert success, preserved operation error, and stable join-error mapping.

```rust
assert_eq!(run_on_worker(|| Ok::<_, String>(7)).await.expect("success"), 7);
assert_eq!(
    run_on_worker(|| Err::<(), _>("failed".to_owned()))
        .await
        .expect_err("operation failure"),
    "failed"
);
```

- [ ] **Step 3: Exercise Tauri command dispatch with the mock runtime**

Build one test app with `tauri::test::mock_builder()` and invoke create, close, bounds, navigate, back, forward, refresh, hard reload, zoom, devtools, clear-data, screenshot, and reveal commands. For commands that require a real child webview, assert their stable missing-tab or unsupported-operation errors; for validation-first commands, assert invalid input is rejected before platform access.

- [ ] **Step 4: Extract portable macOS completion mapping after the helper test fails to compile**

First add tests that call the not-yet-defined helpers and run the focused test to obtain the red `cannot find function` failure. Then introduce private production helpers used inside the Objective-C completion blocks:

```rust
fn javascript_completion(
    value: Option<String>,
    error_description: Option<String>,
) -> Result<String, PreviewPlatformError> {
    if let Some(description) = error_description {
        return Err(PreviewPlatformError::Js(description));
    }
    Ok(value.unwrap_or_else(|| "{\"ok\":null}".to_owned()))
}

fn required_completion<T>(
    value: Option<T>,
    error_description: Option<String>,
    missing_value_message: &'static str,
) -> Result<T, PreviewPlatformError> {
    if let Some(description) = error_description {
        return Err(PreviewPlatformError::Js(description));
    }
    value.ok_or_else(|| PreviewPlatformError::Unavailable(missing_value_message.to_owned()))
}
```

Write failing tests first for value/no-error, value/error, no-value/no-error, and no-value/error. Then use `javascript_completion` in `eval_json` and `required_completion` in screenshot completion. Keep clear-data's unit-valued completion on `required_completion(Some(()), ...)` only where WebKit reports successful completion. Do not instantiate `WKWebView` in a unit test.

- [ ] **Step 5: Complete macOS guard and conversion cases**

Test main-thread rejection, worker-thread acceptance, missing value, native error, invalid JSON text, `null`, boolean, numeric, string, object, and screenshot byte mapping through production helpers used by the real callbacks.

- [ ] **Step 6: Run and commit the preview adapter cohort**

```bash
cargo test -p bibcode-desktop preview::commands::tests -- --nocapture
cargo test -p bibcode-desktop preview::platform::macos::tests -- --nocapture
git add apps/desktop/src-tauri/src/preview/commands.rs apps/desktop/src-tauri/src/preview/platform/macos.rs apps/desktop/src-tauri/src/preview/platform/mod.rs
git commit -m "test: cover desktop preview adapters"
```

Expected: deterministic tests pass on macOS without pumping an application event loop or accessing a real website data store.

### Task 3: Close Backend Supervisor Lifecycle Gaps

**Files:**

- Modify: `apps/desktop/src-tauri/src/backend.rs`
- Test in place: `apps/desktop/src-tauri/src/backend.rs::tests`

**Interfaces:**

- Consumes: `BackendLifecycle`, `BackendState`, launch planning, readiness probes, shutdown/restart configuration, controlled child processes, and in-process server handles.
- Produces: covered start/stop/restart races, cleanup error retention, readiness deadlines, output draining, and plan selection.

- [ ] **Step 1: Cover pure configuration and plan branches**

Add table rows for default and malformed desktop settings; port lower/upper bounds; local/LAN/Tailscale exposure; configured/unconfigured WSL distro; x64/arm64 candidates; explicit/missing binary; renderer host normalization; log segment sanitization; exponential restart attempt 0 through cap; and saturated run IDs. Assert complete `BackendRunConfig` and `BackendLaunchPlan` values.

- [ ] **Step 2: Cover readiness and shutdown protocol errors**

Use ephemeral loopback listeners to return HTTP/1.0 and HTTP/1.1 200, 204, 400, 500, malformed status, partial response, immediate EOF, and delayed success. Cover invalid URL, unsupported scheme, refused connection, timeout retaining the last status, bootstrap-token header, soft-shutdown non-success, and soft-shutdown connection failure.

- [ ] **Step 3: Cover lifecycle concurrency transitions**

Extend existing tests for concurrent starts, concurrent stops, start during stop, stop during publish gate, restart scheduled then canceled, restart desired with/without backend, late cleanup success/failure, failed shutdown blocking restart, child already exited, child ignoring soft shutdown, and local runtime cleanup. Use the existing oneshot gates and bounded Tokio timeouts; assert lifecycle state and shared cleanup error for every waiter.

- [ ] **Step 4: Cover output and child cleanup boundaries**

Test stdout/stderr prefixes, empty chunks, partial chunks, EOF, read error, absent stream, log parent creation, invalid log target, live-child termination, already-exited child, and force-kill after the shutdown deadline. Assert the child is reaped and the log contains the exact stream prefixes.

- [ ] **Step 5: Run and commit the backend cohort**

```bash
cargo test -p bibcode-desktop backend::tests -- --nocapture
git add apps/desktop/src-tauri/src/backend.rs
git commit -m "test: cover desktop backend supervision"
```

Expected: all tests finish within their configured deadlines and leave no child process running.

### Task 4: Cover Desktop Bridge Documents and Remote HTTP

**Files:**

- Modify: `apps/desktop/src-tauri/src/bridge.rs`
- Test in place: `apps/desktop/src-tauri/src/bridge.rs::tests`

**Interfaces:**

- Consumes: settings/catalog normalization, URL derivation, WSL path conversion, Tailscale endpoint projection, diagnostic archive validation, loopback JSON server, and Tauri IPC handlers.
- Produces: covered document success/error/idempotence, remote HTTP status/JSON/abort behavior, and IPC contract serialization.

- [ ] **Step 1: Complete document normalization cases**

Add malformed JSON type rows for desktop settings, client settings, and connection catalog; valid/invalid server exposure, update channel, Tailscale port, WSL distro, and theme values; missing file, directory-as-file, protected document corruption, idempotent write, idempotent clear, and parent creation failure. Assert safe defaults and stable error context.

- [ ] **Step 2: Complete URL and advertised endpoint cases**

Cover HTTP/HTTPS with default/nondefault ports, trailing path/query/fragment stripping, WS/WSS derivation, IPv4/IPv6, localhost, invalid port, unsupported scheme, hosted-HTTPS compatibility, loopback/LAN/Tailscale combinations, MagicDNS configured/unconfigured/unprobed, and absent runtime state.

- [ ] **Step 3: Complete WSL and dialog conversions**

Cover UTF-8/UTF-16 distro lists; default marker; malformed rows; invalid distro names; environment ID extraction; UNC to Linux and Linux to UNC root/nested/trailing slash; configured distro precedence; home fallback; dialog string conversion; and unsupported file URI.

- [ ] **Step 4: Complete loopback remote API tests**

Extend `spawn_json_test_server` or add a scripted variant that returns status, headers, and body. Test descriptor GET, bearer session-state GET, OAuth exchange POST, WebSocket-ticket POST, 204 with no body, 400/401/500, malformed JSON, incomplete body, refused connection, and request cancellation. Assert method, path, authorization, content type, and JSON body from the captured request.

- [ ] **Step 5: Exercise all runtime-agnostic IPC handlers**

Use `tauri::test::mock_builder()` to assert bridge metadata, settings get/set, exposure state, WSL state, theme mapping, picker option normalization, invalid diagnostic archive, and commands whose unsupported mock-runtime path must return a stable error instead of panicking.

- [ ] **Step 6: Run and commit the bridge cohort**

```bash
cargo test -p bibcode-desktop bridge::tests -- --nocapture
git add apps/desktop/src-tauri/src/bridge.rs
git commit -m "test: cover desktop bridge boundaries"
```

Expected: all bridge tests pass without real Tailscale, WSL, dialog UI, credential storage, or remote environment.

### Task 5: Cover SSH, Shell, Window, and Context Menu Boundaries

**Files:**

- Modify: `apps/desktop/src-tauri/src/ssh.rs`
- Modify: `apps/desktop/src-tauri/src/shell_environment.rs`
- Modify: `apps/desktop/src-tauri/src/window.rs`
- Modify: `apps/desktop/src-tauri/src/context_menu.rs`
- Test in place: each file's existing `tests` module.

**Interfaces:**

- Consumes: SSH target/config/known-host parsers, prompt manager, launch plan, bounded shell probe, window-state normalization, and context-menu normalization.
- Produces: covered parsing and state behavior across all deterministic branches plus bounded failure coverage at process/UI boundaries.

- [ ] **Step 1: Complete SSH pure-function matrices**

Add rows for empty/trimmed/invalid host, username, and port; IPv4/IPv6 host spec; target and remote-state keys; batch/password auth; AskPass environment; all recognized authentication failure messages; last nonempty output line; external/managed launch JSON defaults and malformed values; quoted/unquoted include tokens; wildcard `*`/`?`; include cycles; missing/unreadable files; known-host markers, comma lists, ports, hashed/pattern entries, and normalization.

- [ ] **Step 2: Complete SSH prompt and manager lifecycle cases**

Test duplicate request ID, blank response, successful password, cancellation, expiration, service stop, missing ID, cache replace/clear/miss, tunnel replace/clear, and unreachable target. Assert pending entries are removed exactly once and secrets do not appear in debug/error output.

- [ ] **Step 3: Complete shell hydration boundaries**

Test delimiter missing/reversed/empty/oversized; embedded NUL; ASCII whitespace; inherited duplicates; shell-first order; spaces; trusted/missing/non-executable configured shell; platform action for macOS/Linux/Windows/unsupported; spawn failure; nonzero exit; noisy stdout; timeout; descendant holding stdout; partial read; and no process-environment mutation. Use existing bounded probe helpers.

- [ ] **Step 4: Complete window and menu normalization**

For window state, cover NaN/infinite/negative/zero/oversized dimensions, absent and partial position, maximized/fullscreen combinations, encode/decode failure, capture, apply, and all known/unknown menu IDs. For context menus, cover separators; blank/missing IDs and labels; disabled/checked items; nested submenu; malformed/nonobject entries; negative/NaN/infinite position; empty/no-selectable menus; pending-menu replacement; and selection/cancel cleanup.

- [ ] **Step 5: Run and commit the boundary cohort**

```bash
cargo test -p bibcode-desktop ssh::tests -- --nocapture
cargo test -p bibcode-desktop shell_environment::tests -- --nocapture
cargo test -p bibcode-desktop window::tests -- --nocapture
cargo test -p bibcode-desktop context_menu::tests -- --nocapture
git add apps/desktop/src-tauri/src/ssh.rs apps/desktop/src-tauri/src/shell_environment.rs apps/desktop/src-tauri/src/window.rs apps/desktop/src-tauri/src/context_menu.rs
git commit -m "test: cover desktop native boundaries"
```

Expected: tests are deterministic, secrets are redacted, temporary homes are removed, and no UI remains open.

### Task 6: Measure Desktop Contribution and Consume Its Reserve

**Files:**

- Modify the existing in-module tests for the ranked reserve files below when fresh report data still shows uncovered stable behavior.
- Generate locally: `target/desktop-llvm-cov.json`

**Interfaces:**

- Consumes: complete desktop test suite and fresh per-file coverage.
- Produces: a desktop cohort report with at least 94% lines and regions and at least 92% functions, plus the maximum practical portable coverage of platform-native adapters.

- [ ] **Step 1: Run package coverage from clean profiles**

```bash
RUSTUP_TOOLCHAIN_NAME="$(rustup show active-toolchain | awk '{print $1}')"
RUSTUP_TOOLCHAIN_ROOT="$(rustup run "$RUSTUP_TOOLCHAIN_NAME" rustc --print sysroot)"
RUSTUP_TOOLCHAIN_HOST="$(rustup run "$RUSTUP_TOOLCHAIN_NAME" rustc -vV | sed -n 's/^host: //p')"
export LLVM_PROFDATA="$RUSTUP_TOOLCHAIN_ROOT/lib/rustlib/$RUSTUP_TOOLCHAIN_HOST/bin/llvm-profdata"
export LLVM_COV="$RUSTUP_TOOLCHAIN_ROOT/lib/rustlib/$RUSTUP_TOOLCHAIN_HOST/bin/llvm-cov"
LLVM_PROFDATA="$LLVM_PROFDATA" LLVM_COV="$LLVM_COV" cargo llvm-cov clean --workspace
LLVM_PROFDATA="$LLVM_PROFDATA" LLVM_COV="$LLVM_COV" cargo llvm-cov --package bibcode-desktop --all-targets --json --output-path target/desktop-llvm-cov.json --jobs 1
LLVM_PROFDATA="$LLVM_PROFDATA" LLVM_COV="$LLVM_COV" cargo llvm-cov report --summary-only
```

Expected: desktop tests pass and the report is generated with the unchanged crate inventory.

- [ ] **Step 2: Consume remaining desktop reserve in fixed order**

Use the JSON report to select uncovered stable behaviors in this order:

1. `apps/desktop/src-tauri/src/updates.rs`: channel selection, manifest validation, no-update/update, download/progress/cancel/install failures.
2. `apps/desktop/src-tauri/src/config.rs`: defaults, legacy migration, malformed documents, path and environment precedence.
3. `apps/desktop/src-tauri/src/lib.rs`: setup success/failure and runtime-agnostic command registration through the mock builder.
4. `apps/desktop/src-tauri/src/window.rs`: every remaining application-menu action mapping and close/focus lifecycle.
5. residual portable branches in `preview/host.rs`, `backend.rs`, `bridge.rs`, and `ssh.rs`, ranked by uncovered region count.

Do not chase Objective-C, Windows COM, or Linux WebKit statements by adding host-specific exclusions. Test their portable validation/result contracts and leave direct framework calls in inventory.

- [ ] **Step 3: Assert the desktop contribution floor**

Read the package `TOTAL` row. Continue reserve work until lines and regions are at least 94.00% and functions are at least 92.00%, unless the full workspace already exceeds 95.20% in all three metrics. These are execution targets, not committed gates.

- [ ] **Step 4: Run desktop tests and commit the final reserve**

```bash
cargo test -p bibcode-desktop --all-targets
git add apps/desktop/src-tauri/src
git status --short
git commit -m "test: complete desktop coverage sweep"
```

Expected: all desktop targets pass and generated profiles remain ignored.
