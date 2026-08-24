# Event-Driven VCS Observation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace high-frequency Git polling with execution-host-owned invalidation while keeping active status immediate and inactive sidebar branch/PR state fresh within 30 seconds.

**Architecture:** Add a typed passive summary stream and a server watcher that emits invalidations, not status data. Active full-status consumers use watcher signals plus a 60-second fallback; inactive sidebar consumers use a lightweight 30-second summary. Remove the three-second ref poll only after native, WSL, SSH, overflow, and fallback coverage passes.

**Tech Stack:** Rust, Tokio, `notify`, Axum RPC, Effect Schema/Atom, React, Git CLI, Vite+/Vitest.

**Spec:** `docs/superpowers/specs/2026-08-20-event-driven-vcs-observation-design.md`

## Global Constraints

- This plan starts only after `2026-08-20-vcs-core-coordination.md` is complete.
- The execution host owns watching and Git; no local client watches WSL/SSH paths.
- Keep existing full-status wire compatibility and capability-gate the new summary stream.
- Active fallback is 60 seconds; passive sidebar freshness is 30 seconds; slow-read backoff caps at five minutes.
- Preserve focus/reveal catch-up, terminal branch changes, File Manager decorations, Source Control details, provider error attribution, unresolved delivery rows, reconnect, and cancellation.
- Provider turn completion and delivery settlement are never Git invalidation signals.
- Remove the three-second ref poll only in the final task after all coverage passes.

---

### Task 1: Passive VCS summary contract and capability

**Files:**
- Modify: `packages/contracts/src/vcs.ts`
- Modify: `packages/contracts/src/rpc.ts`
- Modify: `packages/contracts/src/environment.ts`
- Modify: `apps/server/src/rpc/methods.rs`
- Modify: `apps/server/src/auth/scope.rs`
- Modify: `apps/server/src/maintenance.rs`
- Modify: `packages/contracts/scripts/export-rust-rpc-fixtures.ts`
- Test: `packages/contracts/src/vcs.test.ts`
- Test: `packages/contracts/src/rpcRustParity.test.ts`

**Interfaces:**
- Consumes: existing `SourceControlProviderInfo`, `ChangeRequest`, branded IDs, and RPC subscription patterns.
- Produces: `VcsStatusSummary`, `subscribeVcsStatusSummary`, and capability `vcsStatusSummary`.

- [ ] **Step 1: Write failing contract tests**

```typescript
const summary = VcsStatusSummary.make({
  isRepo: true,
  refName: "feature/test",
  detachedHead: null,
  hasWorkingTreeChanges: true,
  sourceControlProvider: null,
  pr: null,
  observedAt: "2026-08-20T12:00:00.000Z",
  stale: false,
})

expect(WS_METHODS.subscribeVcsStatusSummary).toBe("subscribeVcsStatusSummary")
```

Also assert older descriptors decode missing capability as false.

- [ ] **Step 2: Run contracts tests and confirm RED**

Run: `vp test run packages/contracts/src/vcs.test.ts packages/contracts/src/rpc.test.ts packages/contracts/src/rpcRustParity.test.ts`

Expected: FAIL because schema, method, fixture, and capability are absent.

- [ ] **Step 3: Add the schema and subscription**

```typescript
export const VcsStatusSummary = Schema.Struct({
  isRepo: Schema.Boolean,
  refName: Schema.NullOr(Schema.String),
  detachedHead: Schema.NullOr(Schema.String),
  hasWorkingTreeChanges: Schema.Boolean,
  sourceControlProvider: Schema.NullOr(SourceControlProviderInfo),
  pr: Schema.NullOr(ChangeRequest),
  observedAt: IsoDateTime,
  stale: Schema.Boolean,
})
```

Register the stream as read-scoped and add the negotiated capability. Do not add runtime logic to contracts.

```rust
unary_or_stream_inventory.push(stream("subscribeVcsStatusSummary"));
// required_scope("subscribeVcsStatusSummary") == orchestration:read
```

- [ ] **Step 4: Regenerate and verify Rust wire fixtures**

Run: `vp run check:contracts`

Expected: PASS after contract typecheck, deterministic fixture export, TypeScript/Rust parity,
and Rust fixture round-trip checks, with updated method/stream/failure counts and manifest hashes.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/vcs.ts packages/contracts/src/rpc.ts packages/contracts/src/environment.ts apps/server/src/rpc/methods.rs apps/server/src/auth/scope.rs apps/server/src/maintenance.rs packages/contracts/scripts/export-rust-rpc-fixtures.ts packages/contracts/fixtures/rpc-wire packages/contracts/src/vcs.test.ts packages/contracts/src/rpcRustParity.test.ts
git commit -m "feat(vcs): define passive status summaries"
```

### Task 2: Execution-host filesystem watcher with fallback

**Files:**
- Modify: `Cargo.toml`
- Modify: `apps/server/Cargo.toml`
- Create: `apps/server/src/git/watcher.rs`
- Modify: `apps/server/src/git/mod.rs`
- Test: `apps/server/src/git/watcher.rs`

**Interfaces:**
- Consumes: canonical worktree/common-dir paths and server lifecycle cancellation.
- Produces: `GitWatchService::subscribe(GitWatchRequest) -> GitWatchSubscription` and `GitWatchEvent::{WorkingTree, Metadata, Overflow, Unavailable}`; tests add `GitWatcherHarness` and injectable `FakeWatcherBackend`.

- [ ] **Step 1: Add failing watcher lifecycle tests**

```rust
#[tokio::test]
async fn coalesces_atomic_write_burst_into_one_invalidation() {
    let harness = GitWatcherHarness::new().await;
    harness.atomic_write("tracked.txt", "changed").await;
    let event = harness.next_event().await;
    assert_eq!(event, GitWatchEvent::WorkingTree);
    assert!(harness.try_next_event().is_none());
}
#[tokio::test]
async fn overflow_emits_fallback_signal_instead_of_clean_state() {
    let harness = GitWatcherHarness::with_backend(FakeWatcherBackend::overflow());
    assert_eq!(harness.next_event().await, GitWatchEvent::Overflow);
    assert_eq!(harness.health(), GitWatcherHealth::FallbackRequired);
}
#[tokio::test]
async fn final_subscriber_stops_the_watcher() {
    let service = GitWatchService::new(FakeWatcherBackend::healthy());
    let subscription = service.subscribe(request()).await.unwrap();
    assert_eq!(service.active_count_for_test(), 1);
    drop(subscription);
    service.wait_for_active_count(0).await;
}
```

- [ ] **Step 2: Run watcher tests and confirm RED**

Run: `node scripts/run-msvc-x64.mjs cargo test -p bibcode-server git::watcher -- --nocapture`

Expected: FAIL because watcher service does not exist.

- [ ] **Step 3: Add the minimal cross-platform dependency**

Add workspace dependency `notify` with default platform backends. Do not add a debouncer crate; the VCS status owner already owns the 125 ms debounce/trailing signal.

```toml
[workspace.dependencies]
notify = "8"
```

- [ ] **Step 4: Implement watched roots and lifecycle**

Watch the active worktree recursively and the resolved per-worktree/common Git metadata roots non-recursively. Filter output/temp/access noise, but treat overflow/interruption as `Unavailable` requiring fallback. Never follow a watcher-provided path outside the admitted roots.

```rust
watcher.watch(&request.worktree_root, RecursiveMode::Recursive)?;
watcher.watch(&request.git_dir, RecursiveMode::NonRecursive)?;
watcher.watch(&request.common_dir, RecursiveMode::NonRecursive)?;
```

- [ ] **Step 5: Run watcher and process-lifecycle tests**

Run: `node scripts/run-msvc-x64.mjs cargo test -p bibcode-server git::watcher -- --nocapture`

Expected: PASS on the current native platform; compatibility branches are unit-tested for Windows/Linux/macOS event shapes.

- [ ] **Step 6: Commit**

```bash
git add Cargo.toml Cargo.lock apps/server/Cargo.toml apps/server/src/git/watcher.rs apps/server/src/git/mod.rs
git commit -m "feat(git): observe worktree changes"
```

### Task 3: Server full-status signal scheduler and safety fallback

**Files:**
- Modify: `apps/server/src/git/status_owner.rs`
- Modify: `apps/server/src/git/broadcaster.rs`
- Modify: `apps/server/src/production/git_vcs.rs`
- Test: `apps/server/src/git/status_owner.rs`
- Test: `apps/server/tests/production_git_vcs_rpc.rs`

**Interfaces:**
- Consumes: `GitWatchService` from Task 2 and mutation-fenced status owner from the VCS core plan.
- Produces: active signal debounce `125 ms`, safety interval `60 s`, one trailing invalidation, and duration-aware fallback delay; tests add `StatusSignalHarness` with read counters and paused-time scheduling.

- [ ] **Step 1: Write failing timing tests with paused Tokio time**

```rust
#[tokio::test(start_paused = true)]
async fn burst_runs_once_after_125ms() {
    let harness = StatusSignalHarness::new();
    for _ in 0..10 { harness.signal(GitWatchEvent::WorkingTree); }
    tokio::time::advance(Duration::from_millis(124)).await;
    assert_eq!(harness.read_count(), 0);
    tokio::time::advance(Duration::from_millis(1)).await;
    harness.wait_for_reads(1).await;
}
#[tokio::test(start_paused = true)]
async fn missed_signal_converges_at_60_seconds() {
    let harness = StatusSignalHarness::new();
    tokio::time::advance(Duration::from_secs(59)).await;
    assert_eq!(harness.read_count(), 0);
    tokio::time::advance(Duration::from_secs(1)).await;
    harness.wait_for_reads(1).await;
}
#[tokio::test(start_paused = true)]
async fn slow_read_extends_evidence_free_delay_but_not_past_five_minutes() {
    let harness = StatusSignalHarness::with_last_duration(Duration::from_secs(90));
    harness.schedule_safety();
    assert_eq!(harness.next_safety_delay(), Duration::from_secs(300));
}
```

- [ ] **Step 2: Run tests and confirm RED**

Run: `node scripts/run-msvc-x64.mjs cargo test -p bibcode-server git::status_owner -- --nocapture`

Run: `node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --test production_git_vcs_rpc -- --nocapture`

Expected: FAIL because watcher signals do not drive the broadcaster.

- [ ] **Step 3: Connect watcher signals to one active status owner**

Map working-tree/metadata/terminal/mutation signals to the same coalesced local refresh request. Keep remote fetch independent. Record watcher health; unavailable watcher enables safety fallback rather than clearing status.

```rust
match event {
    GitWatchEvent::WorkingTree | GitWatchEvent::Metadata => owner.signal_activity(cwd),
    GitWatchEvent::Overflow | GitWatchEvent::Unavailable => owner.enable_safety_fallback(cwd),
}
```

- [ ] **Step 4: Prove provider lifecycle is not a trigger**

Add a test that publishes assistant message, provider completion, and delivery-error events while counting status reads; count remains unchanged.

- [ ] **Step 5: Run focused integration tests**

Run: `node scripts/run-msvc-x64.mjs cargo test -p bibcode-server git::status_owner -- --nocapture`

Run: `node scripts/run-msvc-x64.mjs cargo test -p bibcode-server git::broadcaster -- --nocapture`

Run: `node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --test production_git_vcs_rpc -- --nocapture`

Expected: PASS including external edit, terminal branch, overflow, hidden/reveal, and blocked-fetch cases.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/git/status_owner.rs apps/server/src/git/broadcaster.rs apps/server/src/production/git_vcs.rs apps/server/tests/production_git_vcs_rpc.rs
git commit -m "feat(git): refresh status from change signals"
```

### Task 4: Passive summary runtime and subscription

**Files:**
- Modify: `apps/server/src/git/repository.rs`
- Create: `apps/server/src/git/summary.rs`
- Modify: `apps/server/src/git/mod.rs`
- Modify: `apps/server/src/production/git_vcs.rs`
- Test: `apps/server/src/git/summary.rs`
- Test: `apps/server/tests/production_git_vcs_rpc.rs`

**Interfaces:**
- Consumes: Task 1 contract and existing `PullRequestService` enrichment.
- Produces: `GitStatusSummaryService::subscribe`, one lightweight summary observation per passive worktree, and 30-second freshness.

- [ ] **Step 1: Write failing summary tests**

Cover named branch, detached HEAD, dirty/clean, provider/PR, no repository, stale retained result, connection loss, and no numstat invocation.

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `node scripts/run-msvc-x64.mjs cargo test -p bibcode-server git::summary -- --nocapture`

Expected: FAIL because summary runtime does not exist.

- [ ] **Step 3: Implement lightweight summary observation**

Use one porcelain-v2 branch/status read without numstats or full file rows. Enrich PR state through the existing bounded provider seam. Retain the last summary with `stale: true` on failure.

```rust
pub(crate) async fn summary_status(
    &self,
    cwd: &Path,
    token: &CancellationToken,
) -> Result<VcsStatusSummary, GitCommandError>;
```

- [ ] **Step 4: Register capability-gated stream**

Authorize and route `subscribeVcsStatusSummary`; make latest-value backpressure/cancellation match other status streams.

```rust
registry.register_latest_stream("subscribeVcsStatusSummary", move |request, cancellation| {
    summary_services.subscribe(request, cancellation)
});
```

- [ ] **Step 5: Run RPC/contract parity tests**

Run: `node scripts/run-msvc-x64.mjs cargo test -p bibcode-server git::summary -- --nocapture`

Run: `node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --test production_git_vcs_rpc -- --nocapture`

Run: `node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --test rpc_wire -- --nocapture`

Expected: PASS; passive summary starts no numstat process.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/git/repository.rs apps/server/src/git/summary.rs apps/server/src/git/mod.rs apps/server/src/production/git_vcs.rs apps/server/tests/production_git_vcs_rpc.rs
git commit -m "feat(git): stream passive status summaries"
```

### Task 5: Client summary atoms and sidebar migration

**Files:**
- Modify: `packages/client-runtime/src/state/vcs.ts`
- Create: `packages/client-runtime/src/state/vcs.test.ts`
- Modify: `apps/web/src/state/vcs.ts`
- Modify: `apps/web/src/components/Sidebar.tsx`
- Modify: `apps/web/src/components/ThreadStatusIndicators.tsx`
- Modify: `apps/web/src/hooks/useProjectBranchPolling.ts`
- Test: `packages/client-runtime/src/state/runtime.test.ts`
- Test: `apps/web/src/components/Sidebar.test.tsx`
- Test: `apps/web/src/components/ThreadStatusIndicators.test.tsx`

**Interfaces:**
- Consumes: summary contract/runtime from Tasks 1 and 4.
- Produces: `vcsEnvironment.summary` atom family and capability fallback to existing full status.

- [ ] **Step 1: Write failing selector/render tests**

Assert inactive rows use summary, active full consumers still use full status, missing capability retains legacy full-status behavior, PR requires matching branch, and provider failure/unresolved delivery subrows remain visible during summary updates.

- [ ] **Step 2: Run focused tests and confirm legacy full-status subscriptions**

Run: `vp test run packages/client-runtime/src/state/vcs.test.ts apps/web/src/components/Sidebar.test.tsx apps/web/src/components/ThreadStatusIndicators.test.tsx apps/web/src/hooks/useProjectBranchPolling.test.ts`

Expected: FAIL because summary atoms do not exist.

- [ ] **Step 3: Add capability-gated summary atom family**

Use a latest-value subscription and retain the last usable summary through reconnect. When capability is absent, return the existing full-status atom so mixed-version clients preserve behavior.

```typescript
summary: createEnvironmentSubscriptionAtomFamily(runtime, {
  label: "environment-data:vcs:summary",
  subscribe: subscribeToVcsStatusSummary,
})
```

- [ ] **Step 4: Migrate only passive consumers**

Primary/inactive thread rows and command-palette leading indicators use summary. Source Control, Files, Git actions, Diff/Chat gates, and branch toolbar remain full-status consumers.

```typescript
const status = useEnvironmentQuery(
  isPassiveRow ? vcsEnvironment.summary(target) : vcsEnvironment.status(target),
)
```

- [ ] **Step 5: Run frontend and client-runtime suites**

Run: `vp test run packages/client-runtime/src/state/vcs.test.ts apps/web/src/components/Sidebar.test.tsx apps/web/src/components/ThreadStatusIndicators.test.tsx apps/web/src/components/GitActionsControl.test.tsx apps/web/src/components/files/FileBrowserPanel.test.tsx apps/web/src/components/SourceControlPanel.test.tsx`

Expected: PASS with 30-second passive freshness and unchanged delivery/error presentation.

- [ ] **Step 6: Commit**

```bash
git add packages/client-runtime/src/state/vcs.ts packages/client-runtime/src/state/vcs.test.ts apps/web/src/state/vcs.ts apps/web/src/components/Sidebar.tsx apps/web/src/components/ThreadStatusIndicators.tsx apps/web/src/hooks/useProjectBranchPolling.ts apps/web/src/components/Sidebar.test.tsx apps/web/src/components/ThreadStatusIndicators.test.tsx
git commit -m "perf(web): use passive VCS summaries in sidebar"
```

### Task 6: Remove the three-second ref subprocess poll after parity verification

**Files:**
- Modify: `apps/server/src/production/git_vcs.rs:39-41,274-286`
- Modify: `apps/server/src/git/broadcaster.rs:349-391`
- Modify: `docs/architecture/overview.md`
- Modify: `docs/architecture/rpc-and-orchestration.md`
- Modify: `docs/testing/cross-platform-validation.md`
- Modify: `docs/testing/windows-desktop.md`
- Test: `apps/server/tests/production_git_vcs_rpc.rs`

**Interfaces:**
- Consumes: watcher, safety fallback, summary, and client migration from Tasks 2–5.
- Produces: no three-second `git symbolic-ref` loop; bounded watcher/fallback freshness.

- [ ] **Step 1: Add regression tests that fail if periodic ref Git remains**

Use paused time and a recording runner: advance 59 seconds with no signals and assert zero ref/status Git; advance to 60 seconds and assert one safety read. Trigger terminal branch change and assert one debounced read.

- [ ] **Step 2: Run native focused tests before deletion**

Run: `node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --test production_git_vcs_rpc ref_poll -- --nocapture`

Expected: FAIL because current three-second ref poll starts commands.

- [ ] **Step 3: Remove ref interval/worker branch**

Delete `REF_REFRESH_INTERVAL` and periodic `refresh_ref`; retain remote-fetch ownership and active/passive safety scheduling.

```rust
// remote/fetch worker retains only interval updates and fetch deadlines;
// branch/ref freshness is driven by watcher signals and safety owners.
```

- [ ] **Step 4: Run cross-platform/remote evidence**

Run the shared validation runbook on Windows and compatibility tests for Linux/macOS, WSL direct Git, SSH provider routing, watcher unavailable/overflow, reconnect, and hidden/reveal.

- [ ] **Step 5: Run complete gates and review runbooks**

Run: `vp check`

Run: `vp run typecheck`

Run: `cargo fmt --all --check`

Run: `node scripts/run-msvc-x64.mjs cargo test -p bibcode-server -j 2 -- --test-threads=2`

Run: `node scripts/run-msvc-x64.mjs cargo clippy -p bibcode-server --all-targets -- -D warnings`

Run: `git diff --check && git status --short`

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/production/git_vcs.rs apps/server/src/git/broadcaster.rs apps/server/tests/production_git_vcs_rpc.rs docs/architecture/overview.md docs/architecture/rpc-and-orchestration.md docs/testing/cross-platform-validation.md docs/testing/windows-desktop.md
git commit -m "perf(git): replace ref polling with observation"
```
