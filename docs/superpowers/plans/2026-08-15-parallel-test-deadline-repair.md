# Parallel Test Deadline Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the affected server load and provider-fixture tests deterministic inside the parallel workspace graph without changing production behavior or serializing tests.

**Architecture:** Keep activity performance elapsed time as diagnostics while retaining every deterministic correctness and resource-bound assertion. Introduce a private test-only absolute provider fixture deadline that is created once per affected test and consumed by positive request, delivery, and event milestones through `timeout_at`.

**Tech Stack:** Rust, Tokio test time, Axum/WebSocket integration fixtures, SQLite activity projection tests, Cargo, Vite+.

## Global Constraints

- Production provider and process deadlines remain unchanged.
- Workspace, Rust-harness, and fixture concurrency remain enabled.
- Add no global locks, scheduling sleeps, retries, or serialization flags.
- Keep paging, retention, ordering, stream replacement, memory, provider payload, cancellation, shutdown, kill, and reap assertions intact.
- Use one absolute 30-second integration-test deadline per affected provider test; later milestones consume its remaining budget.
- Stop a full workspace verification on the first different failure and report it without a blind rerun.

---

### Task 1: Make activity elapsed time diagnostic-only

**Files:**

- Modify: `apps/server/tests/activity_load.rs:1312-1546`

**Interfaces:**

- Consumes: the existing `Instant` timing diagnostic and all existing activity projection/RPC assertions.
- Produces: the same load-test output and deterministic correctness coverage without a host-load wall-clock failure.

- [ ] **Step 1: Preserve the recorded RED evidence**

Record the already-observed failure from the unchanged workspace graph:

```text
high_volume_rpc_stream_replaces_lagged_subscribers_and_retains_exact_caps
assertion failed: started_at.elapsed() < Duration::from_secs(30)
activity_load: 7 passed, 1 failed, 30.41s
```

This is the RED for a defect in the test contract itself. Do not manufacture a source-text assertion that merely checks the old line is absent.

- [ ] **Step 2: Remove only the aggregate elapsed assertion**

Delete:

```rust
assert!(started_at.elapsed() < Duration::from_secs(30));
```

Keep `started_at`, the emitted elapsed diagnostic, the RSS bound, the exact 5,000-row journal/idempotency caps, paging, stream replacement, and subscriber cleanup unchanged. Add a short comment beside the diagnostic explaining that wall time is intentionally observational because this correctness test runs in the parallel package graph.

- [ ] **Step 3: Run the exact load test**

Run:

```bash
cargo test -p bibcode-server --test activity_load \
  high_volume_rpc_stream_replaces_lagged_subscribers_and_retains_exact_caps \
  -- --exact --nocapture
```

Expected: 1 passed; the output still reports elapsed time, RSS, retained summaries, detail entries, and exact journal/idempotency rows.

- [ ] **Step 4: Run the full activity load binary**

Run:

```bash
cargo test -p bibcode-server --test activity_load -- --nocapture
```

Expected: all eight tests pass and both high-volume diagnostics remain present.

---

### Task 2: Give provider fixture milestones one absolute deadline

**Files:**

- Modify: `apps/server/src/production/provider_runtime.rs:9580-9775`
- Modify: `apps/server/src/production/provider_runtime.rs:10987-11225`
- Modify: `apps/server/src/production/provider_runtime.rs:12149-12541`
- Modify: `apps/server/src/production/provider_runtime.rs:15378-15735`

**Interfaces:**

- Consumes: Tokio `Instant`, `timeout_at`, the existing fixture capture files, real provider driver futures, and existing `FixtureEvent` milestones.
- Produces: private test-only `ProviderFixtureDeadline` with `after(Duration) -> Self`, `instant() -> tokio::time::Instant`, and `observe(Future) -> Result<Output, Elapsed>`; `captured_request` receives this deadline explicitly and returns its deadline error to the cleanup-owning call site.

- [ ] **Step 1: Write the failing absolute-deadline regression**

Add this private test beside the existing Codex startup milestone deadline coverage:

```rust
#[tokio::test(start_paused = true)]
async fn provider_fixture_deadline_is_not_restarted_between_milestones() {
    let started_at = tokio::time::Instant::now();
    let deadline = ProviderFixtureDeadline::after(std::time::Duration::from_secs(15));

    tokio::time::advance(std::time::Duration::from_secs(10)).await;
    deadline
        .observe(std::future::ready("first"))
        .await
        .expect("first milestone before the deadline");
    deadline
        .observe(std::future::pending::<()>())
        .await
        .expect_err("second milestone must retain the original deadline");

    assert_eq!(
        tokio::time::Instant::now().duration_since(started_at),
        std::time::Duration::from_secs(15),
    );
}
```

The production change that makes this test fail is replacing the stored absolute `Instant` with a fresh duration for every observation.

- [ ] **Step 2: Run the regression to verify RED**

Run:

```bash
cargo test -p bibcode-server --lib \
  production::provider_runtime::tests::provider_fixture_deadline_is_not_restarted_between_milestones \
  -- --exact --nocapture
```

Expected: compile failure because `ProviderFixtureDeadline` does not exist. Do not add production code to satisfy it.

- [ ] **Step 3: Implement the private test deadline**

Inside the existing `#[cfg(test)]` provider-runtime tests module, add:

```rust
const PROVIDER_FIXTURE_INTEGRATION_TIMEOUT: std::time::Duration =
    std::time::Duration::from_secs(30);

#[derive(Clone, Copy, Debug)]
struct ProviderFixtureDeadline(tokio::time::Instant);

impl ProviderFixtureDeadline {
    fn after(duration: std::time::Duration) -> Self {
        Self(tokio::time::Instant::now() + duration)
    }

    fn integration() -> Self {
        Self::after(PROVIDER_FIXTURE_INTEGRATION_TIMEOUT)
    }

    fn instant(self) -> tokio::time::Instant {
        self.0
    }

    async fn observe<F>(self, future: F) -> Result<F::Output, tokio::time::error::Elapsed>
    where
        F: std::future::Future,
    {
        tokio::time::timeout_at(self.0, future).await
    }
}
```

Keep this type private and test-only.

- [ ] **Step 4: Verify the deadline regression is GREEN**

Run the exact command from Step 2.

Expected: 1 passed at paused time; the final virtual elapsed duration is the literal 15 seconds rather than 25 seconds.

- [ ] **Step 5: Route captured requests through the absolute deadline**

Change the helper signature to:

```rust
async fn captured_request(
    deadline: ProviderFixtureDeadline,
    path: &std::path::Path,
    predicate: impl Fn(&Value) -> bool,
) -> Result<Value, tokio::time::error::Elapsed> {
    deadline
        .observe(async {
            loop {
                let captured = std::fs::read_to_string(path).unwrap_or_default();
                if let Some(request) = captured
                    .lines()
                    .filter_map(|line| serde_json::from_str::<Value>(line).ok())
                    .find(|request| predicate(request))
                {
                    return request;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
}
```

Create one `ProviderFixtureDeadline::integration()` before the first observed operation in each test that calls `captured_request`, and pass that same value to every capture and related owner wait in that test. Every deadline error must be handled at the call site (or by a call-site guard): abort and join any retained spawned owner, await the exact driver's shutdown/reap path, and only then convert the error into a stage-specific test panic. For Unix-only FIFO coverage, keep the FIFO readiness milestone; Windows capture uses the same absolute deadline.

- [ ] **Step 6: Route the three observed provider failures through the same owner**

In these tests:

- `claude_delivery_disconnect_after_write_without_replay_is_ambiguous`
- `claude_completion_queries_order_stream_usage_mcp_status_then_completion`
- `native_process_adapters_cover_live_codex_claude_cursor_and_grok_commands`

replace the local two-second fixture observers with `deadline.observe(...)` and stage-specific failure handling that performs owner abort/join and driver shutdown/reap before panicking. In the native-adapter test, reuse `deadline.instant()` for the existing Codex startup milestone rather than creating a second 15-second window. Keep dedicated production-timeout regressions unchanged.

- [ ] **Step 7: Run exact provider tests**

Run each command sequentially:

```bash
cargo test -p bibcode-server --lib \
  production::provider_runtime::tests::claude_completion_queries_order_stream_usage_mcp_status_then_completion \
  -- --exact --nocapture
cargo test -p bibcode-server --lib \
  production::provider_runtime::tests::claude_delivery_disconnect_after_write_without_replay_is_ambiguous \
  -- --exact --nocapture
cargo test -p bibcode-server --lib \
  production::provider_runtime::tests::native_process_adapters_cover_live_codex_claude_cursor_and_grok_commands \
  -- --exact --nocapture
```

Expected: each passes; real payload/event assertions and shutdown remain exercised.

- [ ] **Step 8: Run the provider-runtime matrix**

Run sequentially:

```bash
cargo test -p bibcode-server --lib production::provider_runtime::tests -- --nocapture
cargo test -p bibcode-server --lib production::provider_runtime::tests -- --test-threads=8
cargo test -p bibcode-server --lib production::provider_runtime::tests -- --test-threads=12
cargo test -p bibcode-server --lib -j 2
```

Expected: every provider-runtime test passes at the focused widths and the full
server library passes at the native harness default.

---

### Task 3: Verify the repository and commit the repair

**Files:**

- Review: `apps/server/tests/activity_load.rs`
- Review: `apps/server/src/production/provider_runtime.rs`
- Review: `docs/testing/README.md`
- Review: `docs/testing/cross-platform-validation.md`
- Review: `docs/superpowers/specs/2026-08-15-parallel-test-deadline-repair-design.md`
- Review: `docs/superpowers/plans/2026-08-15-parallel-test-deadline-repair.md`

**Interfaces:**

- Consumes: Tasks 1 and 2.
- Produces: a committed test-harness repair with focused, static, and workspace-graph evidence.

- [ ] **Step 1: Run Rust formatting and Clippy**

Run:

```bash
cargo fmt --all --check
cargo clippy -p bibcode-server --all-targets -- -D warnings
```

Expected: both exit 0. The existing macOS compact-unwind linker warning may appear and must be reported separately because it is not a Rust lint failure.

- [ ] **Step 2: Run repository static gates**

Run:

```bash
vp check
vp run typecheck
```

Expected: both exit 0. Existing nonfatal Effect schema suggestions may be reported but are not failures.

- [ ] **Step 3: Run the server package**

Run:

```bash
cargo test -p bibcode-server -j 2
```

Expected: server library, integrations, and doc tests all pass.

- [ ] **Step 4: Run one fresh workspace graph**

Run:

```bash
vp run test
```

Expected: all nine package tasks pass. If a different failure appears, stop and report it without another broad rerun or unrelated edit.

- [ ] **Step 5: Review scope and runbook accuracy**

Run:

```bash
git diff --check
git status --short
git diff 38256661..HEAD -- apps/server/src/production/provider_runtime.rs \
  apps/server/tests/activity_load.rs docs/superpowers/specs \
  docs/superpowers/plans
```

Confirm no production deadline, package script, CI workflow, serialization flag, dependency, or generated file changed. Review `docs/testing/`; it should remain accurate because commands and platform procedures are unchanged.

- [ ] **Step 6: Commit the implementation**

```bash
git add apps/server/src/production/provider_runtime.rs \
  apps/server/tests/activity_load.rs
git commit -m "test(server): stabilize loaded fixture deadlines"
```

- [ ] **Step 7: Report exact evidence and residual risk**

Report:

- RED and GREEN commands and results;
- exact/default/8/12 test counts;
- server package and workspace graph outcomes;
- static gate outcomes;
- unchanged production deadlines and concurrency;
- whether testing runbooks were updated or reviewed and remain accurate; and
- native Windows execution as unverified residual evidence if it could not run on macOS; it must be covered by a future explicit server-test CI step or a native Windows run.
