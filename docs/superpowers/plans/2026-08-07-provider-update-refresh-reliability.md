# Provider Update Refresh Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make manual provider refreshes revalidate registry versions, retry transient registry failures, and visibly distinguish failed update checks from current providers.

**Architecture:** `ProviderMaintenance` remains the source of truth for in-memory latest-version state. A monotonic refresh generation and per-package asynchronous locks make a manual refresh newer than any cached or in-flight result while retaining cross-package concurrency; only successful registry responses are cached. The existing version-advisory contract carries registry timestamps and failure copy to the web settings presentation.

**Tech Stack:** Rust, Tokio, reqwest, Axum test fixtures, serde_json, React 19, TypeScript, Vite+ tests.

## Global Constraints

- Keep provider readiness and existing snapshot data intact when registry access fails.
- Do not change public RPC method names, payload shapes, persisted settings, or provider update commands.
- Keep installed versions sourced from the executable resolved by BiBCode.
- Preserve concurrent registry lookups for different provider packages.
- Do not cache failed, malformed, or empty registry responses.
- Manual refresh must require a registry result newer than all earlier refresh generations.
- Registry logs may include only registry host, package name, and a bounded failure category.

---

### Task 1: Make latest-version caching refresh-aware and failure-safe

**Files:**
- Modify: `apps/server/src/production/provider_maintenance.rs:1-420`
- Modify: `apps/server/src/production/provider_maintenance.rs:570-1080`

**Interfaces:**
- Produces: `ProviderMaintenance::begin_latest_version_refresh(&self)` for the manual RPC caller.
- Produces: successful `VersionCacheEntry { version, checked_at, generation, expires_at }` values.
- Produces: version advisories whose `checkedAt` is the registry result/attempt time and whose `message` describes a failed lookup.
- Preserves: `ProviderMaintenance::enrich_snapshot(&self, target, snapshot, checks_enabled)` for inventory callers.

- [ ] **Step 1: Add mutable registry fixtures and the failing manual-refresh test**

Add a mutable fixture beside `npm_registry_fixture`:

```rust
async fn mutable_npm_registry_fixture(
    version: &str,
) -> (Url, Arc<tokio::sync::RwLock<String>>, Arc<AtomicUsize>) {
    let version = Arc::new(tokio::sync::RwLock::new(version.to_owned()));
    let requests = Arc::new(AtomicUsize::new(0));
    let state = (version.clone(), requests.clone());
    let app = Router::new()
        .route(
            "/{*path}",
            get(
                |State((version, requests)): State<(
                    Arc<tokio::sync::RwLock<String>>,
                    Arc<AtomicUsize>,
                )>| async move {
                    requests.fetch_add(1, Ordering::SeqCst);
                    Json(json!({ "version": version.read().await.clone() }))
                },
            ),
        )
        .with_state(state);
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("registry listener");
    let address = listener.local_addr().expect("registry address");
    tokio::spawn(async move { axum::serve(listener, app).await.expect("registry server") });
    (
        Url::parse(&format!("http://{address}/")).expect("registry URL"),
        version,
        requests,
    )
}
```

Add the regression test:

```rust
#[tokio::test]
async fn manual_refresh_observes_a_new_opencode_release() {
    let (registry_url, registry_version, requests) =
        mutable_npm_registry_fixture("1.18.11").await;
    let maintenance = ProviderMaintenance::with_registry_base_url(registry_url);
    let target = target("opencode", "opencode");
    let mut startup = installed_snapshot("opencode", "1.18.11");
    maintenance.enrich_snapshot(&target, &mut startup, true).await;

    *registry_version.write().await = "1.18.15".to_owned();
    maintenance.begin_latest_version_refresh();
    let mut manual = installed_snapshot("opencode", "1.18.11");
    manual["checkedAt"] = json!("2026-08-01T12:05:00Z");
    maintenance.enrich_snapshot(&target, &mut manual, true).await;

    assert_eq!(manual["versionAdvisory"]["status"], "behind_latest");
    assert_eq!(manual["versionAdvisory"]["latestVersion"], "1.18.15");
    assert_eq!(manual["versionAdvisory"]["checkedAt"], "2026-08-01T12:05:00Z");
    assert_eq!(requests.load(Ordering::SeqCst), 2);
}
```

- [ ] **Step 2: Run the manual-refresh test and verify RED**

Run:

```bash
cargo test -p bibcode-server --lib manual_refresh_observes_a_new_opencode_release -- --nocapture
```

Expected: compilation fails because `begin_latest_version_refresh` does not
exist. This is the intended RED signal for the wished-for refresh-generation
API; no production implementation exists yet.

- [ ] **Step 3: Add the failing transient-failure recovery test**

Import `AtomicBool` beside `AtomicUsize`, add an Axum fixture whose shared flag
chooses between `503 Service Unavailable` and a valid JSON response, then assert
immediate recovery:

```rust
async fn recovering_npm_registry_fixture(
    version: &str,
) -> (Url, Arc<AtomicBool>, Arc<AtomicUsize>) {
    let failing = Arc::new(AtomicBool::new(true));
    let requests = Arc::new(AtomicUsize::new(0));
    let state = (version.to_owned(), failing.clone(), requests.clone());
    let app = Router::new()
        .route(
            "/{*path}",
            get(
                |State((version, failing, requests)): State<(
                    String,
                    Arc<AtomicBool>,
                    Arc<AtomicUsize>,
                )>| async move {
                    requests.fetch_add(1, Ordering::SeqCst);
                    if failing.load(Ordering::SeqCst) {
                        (StatusCode::SERVICE_UNAVAILABLE, Json(json!({})))
                    } else {
                        (StatusCode::OK, Json(json!({ "version": version })))
                    }
                },
            ),
        )
        .with_state(state);
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("registry listener");
    let address = listener.local_addr().expect("registry address");
    tokio::spawn(async move { axum::serve(listener, app).await.expect("registry server") });
    (
        Url::parse(&format!("http://{address}/")).expect("registry URL"),
        failing,
        requests,
    )
}
```

Then add:

```rust
#[tokio::test]
async fn failed_registry_lookup_is_retried_without_waiting_for_cache_expiry() {
    let (registry_url, failing, requests) = recovering_npm_registry_fixture("1.18.15").await;
    let maintenance = ProviderMaintenance::with_registry_base_url(registry_url);
    let target = target("opencode", "opencode");
    let mut failed = installed_snapshot("opencode", "1.18.11");
    maintenance.enrich_snapshot(&target, &mut failed, true).await;
    assert_eq!(failed["versionAdvisory"]["status"], "unknown");
    assert!(failed["versionAdvisory"]["message"].is_string());

    failing.store(false, Ordering::SeqCst);
    let mut recovered = installed_snapshot("opencode", "1.18.11");
    recovered["checkedAt"] = json!("2026-08-01T12:01:00Z");
    maintenance.enrich_snapshot(&target, &mut recovered, true).await;

    assert_eq!(recovered["versionAdvisory"]["status"], "behind_latest");
    assert_eq!(recovered["versionAdvisory"]["latestVersion"], "1.18.15");
    assert_eq!(requests.load(Ordering::SeqCst), 2);
}
```

- [ ] **Step 4: Run the failure-recovery test and verify RED**

Run:

```bash
cargo test -p bibcode-server --lib failed_registry_lookup_is_retried_without_waiting_for_cache_expiry -- --nocapture
```

Expected: FAIL because the first failed lookup is cached and the request count remains one.

- [ ] **Step 5: Implement refresh generations, package locks, successful-only caching, timestamps, and bounded failures**

Change the maintenance state to:

```rust
struct ProviderMaintenanceInner {
    client: reqwest::Client,
    registry_base_url: Url,
    latest_version_generation: AtomicU64,
    latest_versions: tokio::sync::Mutex<HashMap<&'static str, VersionCacheEntry>>,
    latest_version_locks: Mutex<HashMap<&'static str, Arc<tokio::sync::Mutex<()>>>>,
    updates: Arc<Mutex<ProviderUpdateCoordinator>>,
    command_locks: Mutex<HashMap<&'static str, Arc<tokio::sync::Mutex<()>>>>,
}

#[derive(Clone, Debug)]
struct VersionCacheEntry {
    expires_at: tokio::time::Instant,
    version: String,
    checked_at: String,
    generation: u64,
}

enum LatestVersionCheck {
    Success { version: String, checked_at: String },
    Failed { checked_at: String },
}
```

Initialize the atomic and lock map in `with_registry_base_url_inner`. Add:

```rust
pub(crate) fn begin_latest_version_refresh(&self) {
    self.inner
        .latest_version_generation
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |generation| generation.checked_add(1))
        .expect("provider latest-version generations exhausted");
}

fn latest_version_lock(&self, package_name: &'static str) -> Arc<tokio::sync::Mutex<()>> {
    self.inner
        .latest_version_locks
        .lock()
        .expect("provider latest-version locks")
        .entry(package_name)
        .or_default()
        .clone()
}
```

Rewrite `latest_version` so it acquires the package lock, loads the required generation, rechecks the cache under that lock, and caches only a valid non-empty version. Split HTTP failures into bounded categories (`invalid_url`, `request`, `http_status`, `invalid_json`, `missing_version`) and log only:

```rust
tracing::warn!(
    registry_host = self.inner.registry_base_url.host_str().unwrap_or("unknown"),
    package_name,
    failure = failure.as_str(),
    "provider registry version check failed"
);
```

Return `LatestVersionCheck::Failed` without inserting a cache entry. In `enrich_snapshot`, set `checkedAt` from the cached fetch or current attempt, and use:

```rust
const UPDATE_CHECK_FAILED_MESSAGE: &str =
    "Could not check for provider updates. Refresh provider status to try again.";
```

Set this message only for a failed registry lookup; retain `UPDATE_MESSAGE` for `behind_latest`.

- [ ] **Step 6: Update existing cache tests for the new cache shape and timestamp semantics**

Update `expired_cache_entry_is_refetched` to include `checked_at` and `generation`. Extend `enriches_snapshot_and_caches_npm_latest_for_one_hour` so the second provider probe has a later `checkedAt` but its advisory retains the first successful registry timestamp. Keep `fetches_different_package_versions_concurrently` unchanged as the cross-package concurrency guard.

- [ ] **Step 7: Run all provider-maintenance tests and verify GREEN**

Run:

```bash
cargo test -p bibcode-server --lib production::provider_maintenance::tests -- --nocapture
```

Expected: all provider-maintenance tests PASS, including the two new regressions and the concurrency test.

- [ ] **Step 8: Commit Task 1**

```bash
git add apps/server/src/production/provider_maintenance.rs
git commit -m "fix(server): refresh provider registry versions reliably"
```

---

### Task 2: Wire manual RPC refreshes to a new registry generation

**Files:**
- Modify: `apps/server/src/production/control.rs:523-545`
- Test: `apps/server/src/production/control.rs:2069-2160`

**Interfaces:**
- Consumes: `ProviderMaintenance::begin_latest_version_refresh(&self)` from Task 1.
- Produces: `server.refreshProviders` behavior that starts a new latest-version generation once per accepted manual invocation.
- Preserves: scheduled provider checks use the current generation and do not advance it.

- [ ] **Step 1: Add a failing control-level wiring test**

Add a test-only generation accessor to `ProviderMaintenance`:

```rust
#[cfg(test)]
fn latest_version_generation(&self) -> u64 {
    self.inner.latest_version_generation.load(Ordering::Acquire)
}
```

Add beside the scheduler tests:

```rust
#[tokio::test]
async fn manual_provider_refresh_advances_latest_version_generation_once() {
    let temp = tempfile::tempdir().expect("state directory");
    let control = scheduler_control(&temp).await;
    let before = control.provider_maintenance.latest_version_generation();

    control.refresh_providers(&json!({})).await;

    assert_eq!(
        control.provider_maintenance.latest_version_generation(),
        before + 1
    );
}
```

- [ ] **Step 2: Run the control test and verify RED**

Run:

```bash
cargo test -p bibcode-server --lib manual_provider_refresh_advances_latest_version_generation_once -- --nocapture
```

Expected: FAIL because `refresh_providers` does not advance the generation.

- [ ] **Step 3: Advance the generation once at the manual RPC boundary**

At the beginning of `NativeServerControl::refresh_providers`, before taking the settings snapshot or beginning the provider probe, add:

```rust
self.provider_maintenance.begin_latest_version_refresh();
```

Do not add this call to `request_full_provider_refresh`; scheduled checks must not invalidate successful cache entries.

- [ ] **Step 4: Run the control and maintenance tests and verify GREEN**

Run:

```bash
cargo test -p bibcode-server --lib manual_provider_refresh_advances_latest_version_generation_once -- --nocapture
cargo test -p bibcode-server --lib production::provider_maintenance::tests -- --nocapture
```

Expected: both commands PASS.

- [ ] **Step 5: Commit Task 2**

```bash
git add apps/server/src/production/control.rs apps/server/src/production/provider_maintenance.rs
git commit -m "fix(server): force registry checks on provider refresh"
```

---

### Task 3: Present failed update checks without exposing update actions

**Files:**
- Modify: `apps/web/src/components/settings/providerStatus.ts:90-125`
- Test: `apps/web/src/components/settings/providerStatus.test.ts:100-140`
- Modify: `apps/web/src/components/settings/ProviderInstanceCard.tsx:1-15`
- Modify: `apps/web/src/components/settings/ProviderInstanceCard.tsx:615-705`
- Test: `apps/web/src/components/settings/ProviderInstanceCard.test.tsx:480-540`
- Modify: `docs/architecture/providers.md`

**Interfaces:**
- Consumes: existing `ServerProviderVersionAdvisory` with `status: "unknown"`, a non-null failure `message`, and a registry-attempt `checkedAt`.
- Produces: `ProviderVersionAdvisoryPresentation.kind` values `"update" | "check_failed"` with explicit title and detail.
- Preserves: current/unknown-without-message advisories remain hidden; behind-latest advisories retain update actions.

- [ ] **Step 1: Add failing pure-presentation tests**

Replace the current “hides current and unknown advisories” expectation with separate coverage:

```ts
it("hides current and unexplained unknown advisories", () => {
  expect(getProviderVersionAdvisoryPresentation(undefined)).toBeNull();
  expect(getProviderVersionAdvisoryPresentation(advisory({ status: "current" }))).toBeNull();
  expect(
    getProviderVersionAdvisoryPresentation(advisory({ status: "unknown", message: null })),
  ).toBeNull();
});

it("presents a failed update check without an update command", () => {
  expect(
    getProviderVersionAdvisoryPresentation(
      advisory({
        status: "unknown",
        message: "Could not check for provider updates.",
        updateCommand: "provider update",
      }),
    ),
  ).toEqual({
    kind: "check_failed",
    title: "Update check failed",
    detail: "Could not check for provider updates.",
    updateCommand: null,
    emphasis: "strong",
  });
});
```

Extend the behind-latest test to assert `kind: "update"` and `title: "Update available"`.

- [ ] **Step 2: Run the presentation test and verify RED**

Run:

```bash
vp test run apps/web/src/components/settings/providerStatus.test.ts
```

Expected: FAIL because unknown advisories are hidden and update presentations lack `kind` and `title`.

- [ ] **Step 3: Implement the typed presentation variants**

Return this shape from `getProviderVersionAdvisoryPresentation`:

```ts
{
  readonly kind: "update" | "check_failed";
  readonly title: string;
  readonly detail: string;
  readonly updateCommand: string | null;
  readonly emphasis: "normal" | "strong";
} | null
```

For `status === "unknown"`, return `null` without a message; otherwise return `kind: "check_failed"`, title `Update check failed`, the server message, a null command, and strong emphasis. For `behind_latest`, retain the existing detail fallback and return `kind: "update"`, title `Update available`.

- [ ] **Step 4: Add a failing provider-card behavior test**

Add:

```tsx
it("shows update-check failures without update or copy actions", () => {
  const markup = render(
    baseProps({
      liveProvider: advisoryProvider({
        versionAdvisory: {
          status: "unknown",
          currentVersion: "1.0.0",
          latestVersion: null,
          updateCommand: "npm i -g codex@latest",
          canUpdate: true,
          checkedAt: NOW,
          message: "Could not check for provider updates.",
        },
      }),
      onRunUpdate: vi.fn(),
    }),
  );

  expect(markup).toContain("Update check failed");
  expect(markup).toContain("Could not check for provider updates.");
  expect(markup).not.toContain("Update now");
  expect(ui.filter("Button", (p) => p["aria-label"] === "Copy update command")).toHaveLength(0);
});
```

- [ ] **Step 5: Run the provider-card test and verify RED**

Run:

```bash
vp test run apps/web/src/components/settings/ProviderInstanceCard.test.tsx
```

Expected: FAIL because the card hard-codes update-specific title, icon, aria copy, and action rendering.

- [ ] **Step 6: Render warning-specific card content**

Import `TriangleAlertIcon`. Use `versionAdvisory.kind` to select:

- `TriangleAlertIcon` without animation for `check_failed`;
- `ArrowUpCircleIcon` with the existing animation for `update`;
- aria-label `Provider update check failed — view details` for failures;
- `versionAdvisory.title` for the popover heading;
- run/copy/manual-command controls only when `kind === "update"`.

Keep the failure text warning-colored and retain the current update styling.

- [ ] **Step 7: Document current provider-maintenance behavior**

Add a `Provider maintenance` section to `docs/architecture/providers.md` stating that the server owns registry checks, successful results are cached for one hour, manual refresh advances a generation, failures remain uncached and visible without affecting readiness, and installed versions come from the resolved executable.

- [ ] **Step 8: Run focused web tests and verify GREEN**

Run:

```bash
vp test run apps/web/src/components/settings/providerStatus.test.ts
vp test run apps/web/src/components/settings/ProviderInstanceCard.test.tsx
```

Expected: both commands PASS without warnings.

- [ ] **Step 9: Commit Task 3**

```bash
git add \
  apps/web/src/components/settings/providerStatus.ts \
  apps/web/src/components/settings/providerStatus.test.ts \
  apps/web/src/components/settings/ProviderInstanceCard.tsx \
  apps/web/src/components/settings/ProviderInstanceCard.test.tsx \
  docs/architecture/providers.md
git commit -m "fix(web): surface provider update check failures"
```

---

### Task 4: Verify the complete provider-refresh change

**Files:**
- Review: all files changed by Tasks 1-3

**Interfaces:**
- Consumes: the complete server, RPC wiring, UI presentation, and living-documentation changes.
- Produces: completion evidence required by repository `AGENTS.md`.

- [ ] **Step 1: Run focused tests together**

```bash
cargo test -p bibcode-server --lib production::provider_maintenance::tests -- --nocapture
cargo test -p bibcode-server --lib manual_provider_refresh_advances_latest_version_generation_once -- --nocapture
vp test run apps/web/src/components/settings/providerStatus.test.ts
vp test run apps/web/src/components/settings/ProviderInstanceCard.test.tsx
```

- [ ] **Step 2: Run Rust formatting, package tests, and Clippy**

```bash
cargo fmt --all --check
cargo test -p bibcode-server
cargo clippy -p bibcode-server --all-targets -- -D warnings
```

- [ ] **Step 3: Run repository checks**

```bash
vp check
vp run typecheck
```

- [ ] **Step 4: Inspect the final diff and worktree**

```bash
git diff HEAD~3 --check
git diff HEAD~3 --stat
git diff HEAD~3
git status --short
rg -n '\[DEBUG-' apps/server/src apps/web/src || true
```

Confirm there are no generated files, dependency changes, debug logs, unrelated edits, or undocumented behavior changes.
