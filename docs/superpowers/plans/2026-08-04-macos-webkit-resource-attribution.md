# macOS WebKit Resource Attribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Attribute the running BiBCode desktop instance's WKWebView helper processes as exact `core/ui` rows on macOS without elevated privileges, new entitlements, or coalition-only ownership guesses.

**Architecture:** `BackendSupervisor` will retain a platform observer and pass the same observer into every in-process server start. A desktop-owned macOS observer will query private PID selectors from every live Tauri `WKWebView`, then validate those object-derived candidates against the current immutable `ProcessRow` snapshot, strict role-specific WebKit executable names, and matching nonzero resource/jetsam coalition IDs. Every selector and native query is capability-checked and fails closed into bounded `partial` or `unavailable` coverage.

**Tech Stack:** Rust 2024, Tauri 2, Tokio, objc2/objc2-web-kit, macOS `proc_pidinfo`, existing BiBCode diagnostics contracts and Vite+ repository checks.

## Global Constraints

- Follow the accepted design in `docs/superpowers/specs/2026-08-04-macos-webkit-resource-attribution-design.md`.
- Keep PID ownership object-derived. Coalition membership and executable names validate candidates; they never discover candidates.
- Use the `Arc<[ProcessRow]>` supplied to `DesktopUiProcessObserver::observe`; do not perform another machine-wide refresh.
- Require exact `(pid, started_at)` snapshot identities and nonzero matching resource and jetsam coalition IDs.
- Call every private Objective-C selector only after `respondsToSelector` succeeds.
- Keep the internal WebView callback deadline below the server sampler's existing 250 ms deadline.
- Do not change the macOS 11 deployment floor, add entitlements, or add production dependencies.
- Preserve Windows WebView2 behavior and the unavailable fallback on Linux/unsupported platforms.
- Run `vp check` and `vp run typecheck` successfully before declaring completion.

---

### Task 1: Retain and inject the desktop UI observer through backend restarts

**Files:**

- Create: `apps/desktop/src-tauri/src/backend/ui_process_observer.rs`
- Modify: `apps/desktop/src-tauri/src/backend.rs:1-6`
- Modify: `apps/desktop/src-tauri/src/backend.rs:459-621`
- Modify: `apps/desktop/src-tauri/src/backend.rs:1080-1165`
- Test: `apps/desktop/src-tauri/src/backend.rs:2073-end`

- [ ] **Step 1: Add failing supervisor storage tests**

In the existing `backend.rs` test module, add a marker observer and two async tests. The marker returns a deterministic healthy observation so the test checks behavior rather than a concrete implementation type:

```rust
#[derive(Debug)]
struct MarkerDesktopUiProcessObserver;

impl DesktopUiProcessObserver for MarkerDesktopUiProcessObserver {
    fn observe(
        &self,
        _rows: Arc<[bibcode_server::diagnostics::ProcessRow]>,
        _server_identity: bibcode_server::diagnostics::ProcessIdentity,
    ) -> Pin<
        Box<
            dyn std::future::Future<Output = DesktopUiObservation> + Send + '_,
        >,
    > {
        Box::pin(async {
            DesktopUiObservation {
                identities: Vec::new(),
                coverage: UiCoverage {
                    status: UiCoverageStatus::Available,
                    message: None,
                },
            }
        })
    }
}

#[tokio::test]
async fn new_supervisor_falls_back_to_unavailable_ui_observation() {
    let supervisor = BackendSupervisor::new();
    let observer = supervisor.ui_process_observer_for_start();
    let observation = observer
        .observe(Arc::from([]), ProcessIdentity { pid: 1, started_at: 1 })
        .await;

    assert_eq!(observation.coverage.status, UiCoverageStatus::Unavailable);
}

#[test]
fn configured_ui_observer_is_reused_for_restart_snapshots() {
    let supervisor = BackendSupervisor::new();
    let expected: Arc<dyn DesktopUiProcessObserver> =
        Arc::new(MarkerDesktopUiProcessObserver);

    supervisor.install_ui_process_observer(expected.clone());
    let first = supervisor.ui_process_observer_for_start();
    let restart = supervisor.ui_process_observer_for_start();

    assert!(Arc::ptr_eq(&expected, &first));
    assert!(Arc::ptr_eq(&first, &restart));
}
```

Extend the test module's diagnostics imports with `DesktopUiObservation`, `ProcessIdentity`, `UiCoverage`, and `UiCoverageStatus`.

- [ ] **Step 2: Run the focused tests and confirm the red state**

Run:

```bash
cargo test -p bibcode-desktop configured_ui_observer -- --nocapture
cargo test -p bibcode-desktop new_supervisor_falls_back -- --nocapture
```

Expected: compilation fails because `install_ui_process_observer` and `ui_process_observer_for_start` do not exist.

- [ ] **Step 3: Add synchronized observer ownership to `BackendSupervisor`**

Keep `#[derive(Debug, Clone, Default)]` by storing an optional trait object:

```rust
pub struct BackendSupervisor {
    state: Arc<Mutex<BackendState>>,
    start_completed: Arc<Notify>,
    ui_process_observer: Arc<Mutex<Option<Arc<dyn DesktopUiProcessObserver>>>>,
    // existing test-only fields remain unchanged
}
```

Add the two private helpers:

```rust
fn install_ui_process_observer(&self, observer: Arc<dyn DesktopUiProcessObserver>) {
    *self
        .ui_process_observer
        .lock()
        .expect("desktop UI observer mutex poisoned") = Some(observer);
}

fn ui_process_observer_for_start(&self) -> Arc<dyn DesktopUiProcessObserver> {
    self.ui_process_observer
        .lock()
        .expect("desktop UI observer mutex poisoned")
        .clone()
        .unwrap_or_else(|| Arc::new(UnavailableDesktopUiProcessObserver))
}
```

The slot persists independently of backend lifecycle state, so `stop`, crash monitoring, and automatic restart cannot clear it.

- [ ] **Step 4: Move platform selection behind a small factory**

Declare `mod ui_process_observer;` next to `backend.rs` imports and create `backend/ui_process_observer.rs` with the current behavior first:

```rust
use std::sync::Arc;

use bibcode_server::diagnostics::{
    DesktopUiProcessObserver, UnavailableDesktopUiProcessObserver,
};
#[cfg(windows)]
use bibcode_server::diagnostics::WebView2DesktopUiProcessObserver;
use tauri::{AppHandle, Runtime};

pub(super) fn for_app<R: Runtime>(
    _app: &AppHandle<R>,
) -> Arc<dyn DesktopUiProcessObserver> {
    #[cfg(windows)]
    if let Some(executable_name) = std::env::current_exe().ok().and_then(|path| {
        path.file_name()
            .map(|name| name.to_string_lossy().into_owned())
    }) {
        return Arc::new(WebView2DesktopUiProcessObserver::new(executable_name));
    }

    Arc::new(UnavailableDesktopUiProcessObserver)
}
```

Remove the old free `desktop_ui_process_observer` function and its Windows-only import from `backend.rs`.

- [ ] **Step 5: Install the factory result before any default launch and inject snapshots into starts**

At the beginning of `start_default_with_reason`, before `default_launch_plans`, install the live-app observer:

```rust
self.install_ui_process_observer(ui_process_observer::for_app(&app));
```

Snapshot it in `start_with_options_inner` and pass it to the launch function:

```rust
let permit = self.begin_start(reset_restart_attempt)?;
let ui_process_observer = self.ui_process_observer_for_start();
let (config, managed, pid) = start_managed_backend(
    plan.clone(),
    readiness,
    ui_process_observer,
    permit.run_id,
)
.await?;
```

Change the launch signature and in-process branch:

```rust
async fn start_managed_backend(
    plan: BackendLaunchPlan,
    readiness: BackendReadinessConfig,
    ui_process_observer: Arc<dyn DesktopUiProcessObserver>,
    run_id: u64,
) -> Result<(BackendRunConfig, ManagedBackend, Option<u32>), String> {
    // ...
    let handle = ServerRuntime::start_with_ui_process_observer(
        server_config,
        ui_process_observer,
    )
    .await
    // ...
}
```

Update every direct test call to `start_managed_backend` with `Arc::new(UnavailableDesktopUiProcessObserver)` immediately before `run_id`. External-process branches accept but do not use the observer; name the argument normally because the in-process branch uses it.

- [ ] **Step 6: Run the supervisor tests and desktop compile check**

Run:

```bash
cargo test -p bibcode-desktop configured_ui_observer -- --nocapture
cargo test -p bibcode-desktop new_supervisor_falls_back -- --nocapture
cargo check -p bibcode-desktop --all-targets
```

Expected: both tests pass and the desktop crate compiles without unused imports or dead code.

- [ ] **Step 7: Commit the observer lifecycle plumbing**

```bash
git add apps/desktop/src-tauri/src/backend.rs apps/desktop/src-tauri/src/backend/ui_process_observer.rs
git commit -m "refactor: inject desktop UI process observers"
```

---

### Task 2: Implement the fail-closed macOS candidate validator

**Files:**

- Create: `apps/desktop/src-tauri/src/backend/ui_process_observer/macos.rs`
- Modify: `apps/desktop/src-tauri/src/backend/ui_process_observer.rs`

- [ ] **Step 1: Declare the macOS module and add validation fixtures**

Under `#[cfg(target_os = "macos")]`, declare `mod macos;` in `ui_process_observer.rs`. In `macos.rs`, introduce the intended private domain types and a test module. The production declarations and the tests must use these exact shapes:

```rust
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
enum WebKitProcessRole {
    WebContent,
    Gpu,
    Networking,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
struct WebKitProcessCandidate {
    pid: u32,
    role: WebKitProcessRole,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct CoalitionIds {
    resource: u64,
    jetsam: u64,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
enum MacosObservationIssue {
    WebviewDispatch,
    WebviewDeadline,
    PrivateSelector,
    ServerSnapshot,
    ServerCoalition,
    CandidateSnapshot,
    CandidateExecutable,
    CandidateCoalition,
}

#[derive(Debug, Default)]
struct WebKitPidCollection {
    candidates: Vec<WebKitProcessCandidate>,
    issues: BTreeSet<MacosObservationIssue>,
}
```

Use `ProcessRow::fixture` to build a server row plus WebContent, GPU, Networking, enhanced-security WebContent, unrelated WebKit, and ordinary-process rows. Use a `HashMap<u32, Result<CoalitionIds, ()>>` as the injected coalition lookup.

- [ ] **Step 2: Add the complete validation test matrix**

Add tests whose names begin with `macos_ui_` and exercise `build_observation_with`:

```rust
fn build_observation_with(
    rows: &[ProcessRow],
    server_identity: ProcessIdentity,
    collection: WebKitPidCollection,
    coalition_for: impl FnMut(u32) -> Result<CoalitionIds, ()>,
) -> DesktopUiObservation;
```

The tests must assert:

- `macos_ui_accepts_all_role_matched_candidates_in_the_host_coalition`: WebContent, provisional WebContent, GPU, Networking, and Enhanced Security WebContent candidates produce exact snapshot identities and `Available`.
- `macos_ui_deduplicates_candidates_from_multiple_webviews_and_ignores_zero`: repeated typed candidates count once and PID zero never becomes an identity.
- `macos_ui_marks_missing_snapshot_candidate_partial_when_another_is_valid`: retain the valid identity, report `Partial`.
- `macos_ui_rejects_a_different_coalition`: an unrelated WebKit row is excluded even when its role-specific executable matches.
- `macos_ui_rejects_a_non_webkit_process_in_the_host_coalition`: matching coalition alone cannot claim the row.
- `macos_ui_coalition_failure_is_partial_with_a_valid_peer`: a lookup failure cannot remove already validated identities.
- `macos_ui_coalition_failure_is_unavailable_without_a_valid_identity`: zero identities always report `Unavailable`.
- `macos_ui_collection_failures_preserve_validated_rows_as_partial`: pre-populated dispatch, selector, and deadline issues remain visible after validation.
- `macos_ui_requires_the_exact_server_start_identity`: a reused server PID with a different `started_at` reports `Unavailable` before candidate validation.
- `macos_ui_requires_nonzero_resource_and_jetsam_coalitions`: either zero host coalition field fails closed.
- `macos_ui_rejects_role_swaps`: a GPU selector PID pointing at WebContent is not accepted.

For command fixtures, use full representative paths as the first argument, for example:

```rust
row.command = "/System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/\
com.apple.WebKit.GPU.xpc/Contents/MacOS/com.apple.WebKit.GPU --type=gpu".to_string();
```

- [ ] **Step 3: Run the macOS tests and confirm the red state**

Run:

```bash
cargo test -p bibcode-desktop macos_ui_ -- --nocapture
```

Expected: compilation fails until the validator and observer types are implemented.

- [ ] **Step 4: Implement strict executable-role validation**

Extract only the first command token and compare its final path component exactly:

```rust
fn command_matches_role(command: &str, role: WebKitProcessRole) -> bool {
    let Some(executable) = command.split_ascii_whitespace().next() else {
        return false;
    };
    let Some(name) = Path::new(executable).file_name().and_then(OsStr::to_str) else {
        return false;
    };

    match role {
        WebKitProcessRole::WebContent => matches!(
            name,
            "com.apple.WebKit.WebContent"
                | "com.apple.WebKit.WebContent.EnhancedSecurity"
        ),
        WebKitProcessRole::Gpu => name == "com.apple.WebKit.GPU",
        WebKitProcessRole::Networking => name == "com.apple.WebKit.Networking",
    }
}
```

Do not use substring matching and do not inspect later command arguments.

- [ ] **Step 5: Isolate the coalition FFI and require exact bytes**

Keep the private numeric flavor and layout local to `macos.rs`:

```rust
const PROC_PIDCOALITIONINFO: c_int = 20;

#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
struct ProcPidCoalitionInfo {
    coalition_id: [u64; 2],
    reserved: [u64; 3],
}

fn coalition_ids(pid: u32) -> Result<CoalitionIds, ()> {
    let mut info = ProcPidCoalitionInfo::default();
    let size = size_of::<ProcPidCoalitionInfo>();
    let size = c_int::try_from(size).map_err(|_| ())?;
    let pid = c_int::try_from(pid).map_err(|_| ())?;

    // SAFETY: the C-compatible buffer has the exact private coalition-info
    // layout and remains valid for the complete query.
    let read = unsafe {
        libc::proc_pidinfo(
            pid,
            PROC_PIDCOALITIONINFO,
            0,
            from_mut(&mut info).cast(),
            size,
        )
    };
    if read != size {
        return Err(());
    }

    let ids = CoalitionIds {
        resource: info.coalition_id[0],
        jetsam: info.coalition_id[1],
    };
    (ids.resource != 0 && ids.jetsam != 0)
        .then_some(ids)
        .ok_or(())
}
```

Add `const _: () = assert!(size_of::<ProcPidCoalitionInfo>() == 40);` beside the structure so an accidental layout change fails compilation.

- [ ] **Step 6: Implement snapshot validation and coverage reduction**

`build_observation_with` must:

1. Find the server row by exact PID and start identity.
2. Query its nonzero coalition once.
3. Ignore PID zero before lookup.
4. Find each candidate by PID in the supplied snapshot.
5. Apply exact role matching.
6. Query and compare both candidate coalition fields.
7. Reuse the row's `started_at` for `ProcessIdentity`.
8. Deduplicate `(pid, role)` candidates before native queries, cache coalition results by PID, deduplicate accepted values with a `HashSet<ProcessIdentity>`, and sort identities by PID for deterministic tests.
9. Record an issue for every rejected nonzero candidate.

Reduce coverage in one helper:

```rust
fn coverage_for(
    has_identities: bool,
    issues: &BTreeSet<MacosObservationIssue>,
) -> UiCoverage {
    let status = if !has_identities {
        UiCoverageStatus::Unavailable
    } else if issues.is_empty() {
        UiCoverageStatus::Available
    } else {
        UiCoverageStatus::Partial
    };
    let message = (status != UiCoverageStatus::Available)
        .then(|| bounded_issue_message(status, issues));
    UiCoverage { status, message }
}
```

`bounded_issue_message` selects the first deterministic issue and returns only a fixed string naming the failed boundary. When `issues` is empty but no WebKit PID is running, use a fixed generic no-identity message rather than indexing the empty set. It must never interpolate a PID, command, path, or operating-system error. For `Unavailable`, append the existing user-facing fact that native server usage remains included.

- [ ] **Step 7: Run the validation tests**

Run:

```bash
cargo test -p bibcode-desktop macos_ui_ -- --nocapture
```

Expected: all pure validation tests pass. Any unused production item at this point is resolved in Task 3 before committing.

---

### Task 3: Query every Tauri WKWebView and wire the macOS observer

**Files:**

- Modify: `apps/desktop/src-tauri/src/backend/ui_process_observer/macos.rs`
- Modify: `apps/desktop/src-tauri/src/backend/ui_process_observer.rs`

- [ ] **Step 1: Add failing collection-reducer tests**

Add pure `macos_ui_collection_` tests for a reducer with this interface:

```rust
fn reduce_webview_results(
    expected_callbacks: usize,
    dispatch_failures: usize,
    timed_out: bool,
    results: Vec<WebViewPidResult>,
) -> WebKitPidCollection;
```

Use:

```rust
#[derive(Debug, Default)]
struct WebViewPidResult {
    candidates: Vec<WebKitProcessCandidate>,
    missing_selectors: usize,
}
```

Verify all of the following:

- candidates from multiple WebViews are retained;
- a dispatch failure adds `WebviewDispatch`;
- fewer results than scheduled callbacks plus `timed_out` adds `WebviewDeadline`;
- any missing selector adds `PrivateSelector`;
- no callback and no candidate cannot produce healthy coverage; and
- zero PIDs are absent before validation.

- [ ] **Step 2: Run the collection tests and confirm the red state**

Run:

```bash
cargo test -p bibcode-desktop macos_ui_collection_ -- --nocapture
```

Expected: compilation fails because the reducer and WebView result type are incomplete.

- [ ] **Step 3: Implement capability-checked selector reads on the UI thread**

Import `objc2::{msg_send, sel}`, `objc2::runtime::NSObjectProtocol`, and `objc2_web_kit::WKWebView`. Add a helper that is called only inside Tauri's `with_webview` closure:

```rust
fn read_webview_pids(wk: &WKWebView) -> WebViewPidResult {
    let mut result = WebViewPidResult::default();

    if wk.respondsToSelector(sel!(_webProcessIdentifier)) {
        // SAFETY: runtime capability check proves the private pid_t getter is
        // implemented by this WKWebView instance.
        let pid: libc::pid_t = unsafe { msg_send![wk, _webProcessIdentifier] };
        push_candidate(&mut result, pid, WebKitProcessRole::WebContent);
    } else {
        result.missing_selectors += 1;
    }

    if wk.respondsToSelector(sel!(_provisionalWebProcessIdentifier)) {
        let pid: libc::pid_t =
            unsafe { msg_send![wk, _provisionalWebProcessIdentifier] };
        push_candidate(&mut result, pid, WebKitProcessRole::WebContent);
    } else {
        result.missing_selectors += 1;
    }

    if wk.respondsToSelector(sel!(_gpuProcessIdentifier)) {
        let pid: libc::pid_t = unsafe { msg_send![wk, _gpuProcessIdentifier] };
        push_candidate(&mut result, pid, WebKitProcessRole::Gpu);
    } else {
        result.missing_selectors += 1;
    }

    // SAFETY: generated public getters retain their returned Objective-C
    // objects for the duration of these local values.
    let data_store = unsafe { wk.configuration().websiteDataStore() };
    if data_store.respondsToSelector(sel!(_networkProcessIdentifier)) {
        let pid: libc::pid_t =
            unsafe { msg_send![&data_store, _networkProcessIdentifier] };
        push_candidate(&mut result, pid, WebKitProcessRole::Networking);
    } else {
        result.missing_selectors += 1;
    }

    result
}
```

`push_candidate` converts only strictly positive `pid_t` values to `u32`; zero and negative values are ignored. Do not call `performSelector`, because these getters have a scalar return type.

- [ ] **Step 4: Implement bounded asynchronous fan-out over current WebViews**

Set `WEBVIEW_PID_COLLECTION_TIMEOUT` to 175 ms. On each observation:

1. Call `app.webviews()` once to snapshot the current main and preview WebViews.
2. Create a Tokio unbounded channel of `WebViewPidResult`.
3. For each WebView, call `with_webview`; inside the callback cast `platform.inner()` to `&WKWebView`, call `read_webview_pids`, and send the result.
4. Count immediate `with_webview` errors as dispatch failures.
5. Drop the root sender.
6. Receive scheduled results until all arrive, the channel closes, or the internal deadline expires.
7. Pass completed results, scheduled count, dispatch failure count, and timeout state to `reduce_webview_results`.

Use the established Tauri safety pattern from `preview/platform/macos.rs`:

```rust
webview.with_webview(move |platform| {
    // SAFETY: on macOS Tauri provides its live WKWebView and executes this
    // closure on the main/UI thread.
    let wk: &WKWebView = unsafe { &*platform.inner().cast() };
    let _ = sender.send(read_webview_pids(wk));
})
```

Late callbacks may send into a closed receiver and are intentionally ignored. Do not block the UI thread and do not use a synchronous receive inside the callback.

- [ ] **Step 5: Implement `MacosDesktopUiProcessObserver`**

The observer owns only a cloned Tauri app handle:

```rust
pub(super) struct MacosDesktopUiProcessObserver<R: Runtime> {
    app: AppHandle<R>,
}

impl<R: Runtime> MacosDesktopUiProcessObserver<R> {
    pub(super) fn new(app: AppHandle<R>) -> Self {
        Self { app }
    }
}

impl<R: Runtime> Debug for MacosDesktopUiProcessObserver<R> {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("MacosDesktopUiProcessObserver")
            .finish_non_exhaustive()
    }
}

impl<R: Runtime> DesktopUiProcessObserver for MacosDesktopUiProcessObserver<R> {
    fn observe(
        &self,
        rows: Arc<[ProcessRow]>,
        server_identity: ProcessIdentity,
    ) -> Pin<Box<dyn Future<Output = DesktopUiObservation> + Send + '_>> {
        Box::pin(async move {
            let collection = collect_webview_pids(&self.app).await;
            build_observation_with(
                &rows,
                server_identity,
                collection,
                coalition_ids,
            )
        })
    }
}
```

Import `tauri::Manager` for `AppHandle::webviews`. Do not cache WebViews or PIDs between samples.

- [ ] **Step 6: Select the macOS implementation in the platform factory**

Add:

```rust
#[cfg(target_os = "macos")]
use self::macos::MacosDesktopUiProcessObserver;
```

At the top of `for_app`, before the Windows branch:

```rust
#[cfg(target_os = "macos")]
return Arc::new(MacosDesktopUiProcessObserver::new(_app.clone()));
```

Rename `_app` to `app` and add `#[cfg(not(target_os = "macos"))] let _ = app;` only if the compiler requires it on a non-macOS/non-Windows target. Keep the existing Windows executable-name logic unchanged.

- [ ] **Step 7: Run focused macOS and observer tests**

Run:

```bash
cargo fmt --all
cargo test -p bibcode-desktop macos_ui_ -- --nocapture
cargo test -p bibcode-server observer -- --nocapture
cargo check -p bibcode-desktop --all-targets
```

Expected: all macOS observer tests and existing server observer tests pass; the desktop crate has no warning-denied code.

- [ ] **Step 8: Commit the macOS observer**

```bash
git add apps/desktop/src-tauri/src/backend/ui_process_observer.rs apps/desktop/src-tauri/src/backend/ui_process_observer/macos.rs
git commit -m "feat: attribute macOS WebKit resource usage"
```

---

### Task 4: Document coverage, private SPI, and operational expectations

**Files:**

- Modify: `docs/operations/observability.md:101-112`
- Test: `docs/operations/observability.md`

- [ ] **Step 1: Replace the unsupported-platform statement with exact macOS behavior**

Keep the Windows paragraph and add a separate macOS paragraph stating:

- PIDs come from every WKWebView owned by the current Tauri `AppHandle`;
- exact role-specific executable and resource/jetsam coalition matches validate them;
- coalition membership is not a discovery mechanism;
- missing private selector, dispatch, snapshot row, or coalition data yields `partial`/`unavailable` coverage;
- the mechanism requires no elevated privileges or new entitlement; and
- it uses private WebKit/process SPI and is incompatible with a strict Mac App Store public-API-only policy.

End with Linux and other unsupported desktop targets continuing to report `unavailable`.

- [ ] **Step 2: Check the documentation for contradictory claims**

Run:

```bash
rg -n "Unsupported platforms|WebView2|WKWebView|coalition|Mac App Store" docs/operations docs/superpowers/specs/2026-08-04-macos-webkit-resource-attribution-design.md
git diff --check
```

Expected: no operations guide statement still claims macOS is unsupported, and the documentation has no whitespace errors.

- [ ] **Step 3: Commit the operations documentation**

```bash
git add docs/operations/observability.md
git commit -m "docs: explain macOS WebKit attribution"
```

---

### Task 5: Verify regression safety and packaged macOS behavior

**Files:**

- Verify: `apps/desktop/src-tauri/src/backend.rs`
- Verify: `apps/desktop/src-tauri/src/backend/ui_process_observer.rs`
- Verify: `apps/desktop/src-tauri/src/backend/ui_process_observer/macos.rs`
- Verify: `apps/server/src/diagnostics/resource_sampler.rs`
- Verify: `docs/operations/observability.md`

- [ ] **Step 1: Run formatting and focused tests from a clean test process**

Run:

```bash
cargo fmt --all -- --check
cargo test -p bibcode-desktop macos_ui_ -- --nocapture
cargo test -p bibcode-desktop configured_ui_observer -- --nocapture
cargo test -p bibcode-desktop new_supervisor_falls_back -- --nocapture
cargo test -p bibcode-server observer -- --nocapture
```

Expected: every command exits zero.

- [ ] **Step 2: Run the repository-required gates**

Run:

```bash
vp check
vp run typecheck
```

If either command reports missing workspace packages rather than a code failure, restore the locked workspace dependencies with:

```bash
pnpm install --frozen-lockfile
```

Then rerun both required gates. Do not classify missing dependencies as a passing gate.

- [ ] **Step 3: Build the packaged desktop application**

Run:

```bash
vp run build:desktop
```

Expected: the macOS application links and packages successfully, proving the dynamic Objective-C selector calls and `proc_pidinfo` symbol resolve in the production target.

- [ ] **Step 4: Perform the live Resource Manager smoke test**

Launch the newly built application, open Resource Manager, and record evidence for each check:

- complete observation removes the unavailable warning;
- `core/server` and role-validated `core/ui` rows appear;
- Combined equals Core plus External for memory, CPU, and process count;
- opening and closing a native preview WebView updates the Core UI process set on a later sample;
- provider and terminal processes remain External;
- another application's `com.apple.WebKit.*` helpers do not appear; and
- quitting the packaged app leaves no BiBCode-owned WebKit or supervised helper behind.

If a supported macOS version lacks one private selector, confirm the UI reports `partial` with validated rows retained. If no PID validates, confirm it reports `unavailable`; do not weaken validation to make the warning disappear.

- [ ] **Step 5: Review the final diff for scope and unsafe-call documentation**

Run:

```bash
git status --short
git diff --stat HEAD~3..HEAD
rg -n "unsafe" apps/desktop/src-tauri/src/backend/ui_process_observer/macos.rs
git diff --check HEAD~3..HEAD
```

Confirm every unsafe block has a local safety explanation, `.repos/` is unchanged, no entitlement/deployment-target file changed, and only the planned implementation/documentation files are in scope.

- [ ] **Step 6: Request a final code review before completion**

Invoke `superpowers:requesting-code-review` against the completed commit range. Address correctness findings through `superpowers:receiving-code-review`, then rerun every affected focused test plus `vp check` and `vp run typecheck`.

- [ ] **Step 7: Record final verification evidence**

In the handoff, report the exact commands that passed, the packaged macOS version used for the smoke test, observed coverage status, and any private-SPI compatibility caveat. Do not claim completion if either required repository gate or the packaged smoke test failed.
