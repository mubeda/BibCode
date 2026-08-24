# VCS Core Coordination Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut duplicated/background Git work while preserving current VCS results, automatic-fetch behavior, focus freshness, mutation ordering, and sub-750 ms local-save publication.

**Architecture:** First make every status observation cheaper without changing scheduling. Then add server-owned worktree mutation epochs and physical-repository fetch ownership before allowing client refresh reads to stop blocking mutations. The server remains the correctness owner across clients; client scheduling only suppresses redundant requests.

**Tech Stack:** Rust, Tokio, Axum RPC, Git CLI porcelain v2, Effect Atom/TypeScript, Vitest/Vite+, xUnit-style Rust tests.

**Spec:** `docs/superpowers/specs/2026-08-20-vcs-core-coordination-design.md`

## Global Constraints

- Preserve `VcsStatusResult` and `VcsStatusStreamEvent` wire shapes.
- Preserve automatic-fetch default `30_000 ms`, live updates, `0 = disabled`, and failure backoff until the measurement gate explicitly changes the default to `180_000 ms`.
- Keep local status independent from slow remote fetch/ref work.
- Keep focus, visibility, Git-menu, explicit post-action, WSL, remote, cancellation, and workspace-availability behavior.
- Read-only Git commands use `GIT_OPTIONAL_LOCKS=0`; mutations and fetch do not.
- Worktree catalog operations retain their existing project/repository lock order and notify VCS owners only after terminal settlement.
- Run focused tests first, then `vp check`, `vp run typecheck`, Rust format/tests/Clippy, and final diff/status review.

---

### Task 1: Lock-safe Git read environment and command-count baseline

**Files:**
- Modify: `apps/server/src/git/repository.rs:282-309,820-1070,4258-4272`
- Test: `apps/server/src/git/repository.rs` test module
- Test: `apps/server/tests/production_git_vcs_rpc.rs`

**Interfaces:**
- Consumes: existing `git_environment()`, `GitProcessRunner`, and `CapturedGitRunner`.
- Produces: `git_read_environment() -> Vec<(OsString, OsString)>` and command-count assertions used by later tasks.

- [ ] **Step 1: Write failing read-environment and command-count tests**

```rust
#[test]
fn background_git_reads_disable_optional_locks() {
    let env = git_read_environment();
    assert!(env.iter().any(|(key, value)| key == "GIT_OPTIONAL_LOCKS" && value == "0"));
}

#[tokio::test]
async fn status_baseline_records_every_physical_git_request() {
    let runner = Arc::new(RecordingGitRunner::status_fixture());
    let repository = GitRepository::with_runner_for_test(runner.clone());
    repository.status(Path::new("/repo"), &CancellationToken::new()).await.unwrap();
    assert_eq!(runner.operation_names(), EXPECTED_PRE_FUSION_OPERATIONS);
}
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `node scripts/run-msvc-x64.mjs cargo test -p bibcode-server git::repository::tests -- --nocapture`

Expected: FAIL because `git_read_environment` and the recording helper/count contract do not exist.

- [ ] **Step 3: Add the read-only environment and route status/diff/ref reads through it**

```rust
fn git_read_environment() -> Vec<(OsString, OsString)> {
    let mut environment = git_environment();
    environment.push(("GIT_OPTIONAL_LOCKS".into(), "0".into()));
    environment
}
```

Keep `git_environment()` unchanged for fetch and mutations. Add a narrow read execution helper rather than a boolean parameter used by every command.

- [ ] **Step 4: Run focused repository and production RPC tests**

Run: `node scripts/run-msvc-x64.mjs cargo test -p bibcode-server git::repository -- --nocapture`

Run: `node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --test production_git_vcs_rpc -- --nocapture`

Expected: PASS; baseline count is recorded and read commands carry optional-lock suppression.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/git/repository.rs apps/server/tests/production_git_vcs_rpc.rs
git commit -m "perf(git): measure and isolate background reads"
```

### Task 2: One porcelain status observation with conditional parallel numstats

**Files:**
- Modify: `apps/server/src/git/repository.rs:820-1070,4780-4808`
- Modify: `apps/server/src/git/mod.rs`
- Test: `apps/server/src/git/repository.rs` test module
- Test: `apps/server/tests/production_git_vcs_rpc.rs`

**Interfaces:**
- Consumes: `git_read_environment()` from Task 1 and existing porcelain/numstat parsers.
- Produces: private `StatusObservation`, `observe_status(&Path, &CancellationToken)`, and unchanged public `local_status`, `remote_status`, and `status` results.

- [ ] **Step 1: Write failing semantic and command-count tests**

```rust
#[tokio::test]
async fn full_status_reuses_one_porcelain_snapshot() {
    let runner = Arc::new(RecordingGitRunner::dirty_tracked_fixture());
    let repository = GitRepository::with_runner_for_test(runner.clone());
    let result = repository.status(Path::new("/repo"), &CancellationToken::new()).await.unwrap();
    assert_eq!(result.local.ref_name.as_deref(), Some("feature/test"));
    assert_eq!(result.remote.ahead_count, 2);
    assert_eq!(result.remote.behind_count, 1);
    assert_eq!(runner.count_arg("status"), 1);
}

#[tokio::test]
async fn clean_status_starts_no_numstat_process() {
    let runner = Arc::new(RecordingGitRunner::clean_fixture());
    let repository = GitRepository::with_runner_for_test(runner.clone());
    repository.status(Path::new("/repo"), &CancellationToken::new()).await.unwrap();
    assert_eq!(runner.count_arg("--numstat"), 0);
}
```

- [ ] **Step 2: Run tests and confirm duplicate status/numstat behavior fails the new expectations**

Run: `node scripts/run-msvc-x64.mjs cargo test -p bibcode-server git::repository::tests -- --nocapture`

Expected: FAIL with two status calls and unconditional numstat calls.

- [ ] **Step 3: Introduce one private observation**

```rust
pub(crate) struct StatusObservation {
    local: VcsStatusLocalResult,
    upstream_ref: Option<String>,
    ahead_count: u64,
    behind_count: u64,
}

pub(crate) async fn observe_status(
    &self,
    cwd: &Path,
    cancellation: &CancellationToken,
) -> Result<StatusObservation, GitCommandError>;
```

Infer repository success from the porcelain command result, parse branch headers once, and start staged/unstaged numstats with `tokio::try_join!` only when the parsed areas require them. Preserve untracked line counting and partial-staging duplicate rows.

- [ ] **Step 4: Make public status methods delegate without schema change**

`local_status` maps `StatusObservation.local`. `status` combines the observation with default-ref/provider metadata and optional default-branch delta. `remote_status` remains the post-fetch branch-specific comparison seam but reuses shared parsing functions.

```rust
pub async fn local_status(&self, cwd: &Path, token: &CancellationToken) -> Result<VcsStatusLocalResult, GitCommandError> {
    self.observe_status(cwd, token).await.map(|observation| observation.local)
}
```

- [ ] **Step 5: Run repository, contract fixture, and frontend status consumer tests**

Run: `node scripts/run-msvc-x64.mjs cargo test -p bibcode-server git::repository -- --nocapture`

Run: `node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --test production_git_vcs_rpc -- --nocapture`

Run: `vp test run packages/contracts/src/vcs.test.ts apps/web/src/components/SourceControlPanel.test.tsx apps/web/src/components/files/FileBrowserPanel.test.tsx apps/web/src/components/GitActionsControl.test.tsx`

Expected: PASS with unchanged status payloads, staging areas, counts, branch/default/PR presentation, and reduced command counts.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/git/repository.rs apps/server/src/git/mod.rs apps/server/tests/production_git_vcs_rpc.rs
git commit -m "perf(git): reuse one status observation"
```

### Task 3: Server-owned status read leases and mutation epochs

**Files:**
- Create: `apps/server/src/git/status_owner.rs`
- Modify: `apps/server/src/git/mod.rs`
- Modify: `apps/server/src/git/broadcaster.rs`
- Test: `apps/server/src/git/status_owner.rs`
- Test: `apps/server/tests/production_git_vcs_rpc.rs`

**Interfaces:**
- Consumes: `StatusObservation` seam from Task 2.
- Produces: `StatusReadOwner`, `StatusReadLease`, `StatusMutationGuard`, and `StatusReadKey { canonical_cwd, output_kind }`; tests add `StatusOwnerHarness` with controlled load completion/cancellation and `StatusValue` fixtures.

- [ ] **Step 1: Write failing lease/epoch tests**

```rust
#[tokio::test]
async fn concurrent_readers_share_one_physical_load() {
    let harness = StatusOwnerHarness::new();
    let first = harness.start_read();
    let second = harness.start_read();
    harness.wait_for_loads(1).await;
    harness.complete(StatusValue::clean());
    assert_eq!(first.await.unwrap(), StatusValue::clean());
    assert_eq!(second.await.unwrap(), StatusValue::clean());
}

#[tokio::test]
async fn first_cancel_does_not_abort_the_second_reader() {
    let harness = StatusOwnerHarness::new();
    let (first, first_cancel) = harness.start_cancellable_read();
    let second = harness.start_read();
    first_cancel.cancel();
    assert!(first.await.is_err());
    assert!(!harness.physical_cancellation().is_cancelled());
    harness.complete(StatusValue::clean());
    assert!(second.await.is_ok());
}

#[tokio::test]
async fn final_cancel_aborts_the_physical_read() {
    let harness = StatusOwnerHarness::new();
    let (read, cancel) = harness.start_cancellable_read();
    cancel.cancel();
    assert!(read.await.is_err());
    assert!(harness.physical_cancellation().is_cancelled());
}

#[tokio::test]
async fn mutation_retires_pre_mutation_result_and_requests_one_trailing_read() {
    let owner = StatusReadOwner::new();
    let harness = StatusOwnerHarness::new();
    let read = harness.start_read();
    let mutation = owner.begin_mutation(key().canonical_cwd.clone()).await;
    harness.complete(StatusValue::clean());
    assert!(read.await.is_err());
    mutation.finish().await;
    assert_eq!(owner.trailing_refresh_count_for_test(), 1);
}
```

- [ ] **Step 2: Run owner tests and confirm RED**

Run: `node scripts/run-msvc-x64.mjs cargo test -p bibcode-server git::status_owner -- --nocapture`

Expected: FAIL because the module and types do not exist.

- [ ] **Step 3: Implement the minimum owner state**

```rust
struct WorktreeStatusState {
    epoch: u64,
    mutation_lock: Arc<tokio::sync::Mutex<()>>,
    in_flight: HashMap<StatusReadKey, SharedStatusRead>,
    trailing_refresh: bool,
}
```

Use per-caller cancellation leases. A read captures `epoch`; completion returns a stale error when it no longer matches. `begin_mutation` acquires the worktree lock, increments the epoch, retires active reads, and returns a guard whose explicit `finish` requests one trailing refresh.

- [ ] **Step 4: Route broadcaster bootstrap, fallback, invalidation, and explicit refresh through the owner**

Preserve the independent local worker and remote/ref worker. Do not hold the mutation lock while publishing or awaiting subscribers.

```rust
let status = self.status_owner.read(key, cancellation, |shared| {
    self.repository.status(cwd, shared)
}).await?;
self.publish_if_current(cwd, status).await
```

- [ ] **Step 5: Add multi-client stale-publication integration coverage**

Use two WebSocket clients: block a refresh read, admit a stage/write mutation, release the old read, and assert subscribers observe only the post-mutation generation.

- [ ] **Step 6: Run focused broadcaster/RPC tests**

Run: `node scripts/run-msvc-x64.mjs cargo test -p bibcode-server git:: -- --nocapture`

Run: `node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --test production_git_vcs_rpc -- --nocapture`

Expected: PASS; existing `<750 ms` and blocked-fetch independence tests remain passing.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/git/status_owner.rs apps/server/src/git/mod.rs apps/server/src/git/broadcaster.rs apps/server/tests/production_git_vcs_rpc.rs
git commit -m "fix(git): fence status reads across mutations"
```

### Task 4: Apply mutation ownership to every in-scope mutator

**Files:**
- Modify: `apps/server/src/production/git_vcs.rs:353-580,978-1065,1599-1765`
- Modify: `apps/server/src/production/runtime.rs`
- Modify: `apps/server/src/workspace/rpc.rs:214-313`
- Modify: `apps/server/src/production/worktree_catalog_rpc.rs`
- Test: `apps/server/tests/production_git_vcs_rpc.rs`
- Test: `apps/server/tests/production_worktree_catalog_rpc.rs`

**Interfaces:**
- Consumes: `StatusMutationGuard` from Task 3.
- Produces: one server mutation path for workspace writes and Git mutators; worktree catalog operations notify after their own terminal lock/receipt settlement.

- [ ] **Step 1: Write failing mutation coverage**

Add table-driven tests for init, stage, unstage, discard, switch/create ref, pull, commit/push stacked actions, workspace write, and managed worktree creation. Each test starts an old read, runs the mutation, and asserts one trailing local refresh with no stale publication.

- [ ] **Step 2: Run the focused tests and confirm RED**

Run: `node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --test production_git_vcs_rpc -- --nocapture`

Run: `node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --test production_worktree_catalog_rpc -- --nocapture`

Expected: FAIL for mutators not yet connected to the status owner.

- [ ] **Step 3: Wrap Git/workspace mutators with explicit mutation settlement**

```rust
let mutation = status_owner.begin_mutation(&cwd).await?;
let result = run_mutation().await;
mutation.finish().await;
result
```

Finish after potentially partial failures too. For catalog-managed create/retarget/remove, call the notification seam only after the catalog's existing terminal receipt and lock ownership settle; do not nest or reorder catalog locks.

- [ ] **Step 4: Preserve reusable and suffixed branch creation tests**

Run: `vp test run apps/web/src/components/CreateWorktreeDialog.logic.test.ts apps/web/src/components/CreateWorktreeDialog.test.tsx`

Run: `node scripts/run-msvc-x64.mjs cargo test -p bibcode-server create_managed -- --nocapture`

Expected: PASS for free local branch reuse and occupied-branch safe suffixing.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/production/git_vcs.rs apps/server/src/production/runtime.rs apps/server/src/workspace/rpc.rs apps/server/src/production/worktree_catalog_rpc.rs apps/server/tests/production_git_vcs_rpc.rs apps/server/tests/production_worktree_catalog_rpc.rs
git commit -m "fix(git): coordinate status around mutations"
```

### Task 5: Physical-repository automatic-fetch ownership

**Files:**
- Create: `apps/server/src/git/fetch_owner.rs`
- Modify: `apps/server/src/git/mod.rs`
- Modify: `apps/server/src/git/broadcaster.rs`
- Modify: `apps/server/src/git/repository.rs`
- Modify: `apps/server/src/production/git_vcs.rs`
- Test: `apps/server/src/git/fetch_owner.rs`
- Test: `apps/server/tests/production_git_vcs_rpc.rs`

**Interfaces:**
- Consumes: a narrow `GitRepository::resolve_common_dir` read and the existing automatic-fetch interval signal.
- Produces: `RepositoryFetchOwner::attach`, `detach`, `update_interval`, `invalidate_after_catalog_mutation`, and one fetch result fan-out per physical repository; tests add `FetchOwnerHarness` with fetch/reconciliation counters.

- [ ] **Step 1: Write failing shared-repository fetch tests**

```rust
#[tokio::test(start_paused = true)]
async fn five_worktrees_share_one_fetch_per_interval() {
    let harness = FetchOwnerHarness::with_worktrees(5, Duration::from_secs(30));
    harness.start().await;
    tokio::time::advance(Duration::from_secs(30)).await;
    harness.wait_for_fetches(1).await;
    assert_eq!(harness.fetch_count(), 1);
}

#[tokio::test(start_paused = true)]
async fn zero_disables_and_live_interval_change_rearms_without_restart() {
    let harness = FetchOwnerHarness::with_worktrees(2, Duration::ZERO);
    harness.start().await;
    tokio::time::advance(Duration::from_secs(60)).await;
    assert_eq!(harness.fetch_count(), 0);
    harness.update_interval(Duration::from_secs(30));
    tokio::time::advance(Duration::from_secs(30)).await;
    harness.wait_for_fetches(1).await;
}

#[tokio::test]
async fn fetch_fans_out_branch_specific_remote_reconciliation() {
    let harness = FetchOwnerHarness::with_branches(["main", "feature/test"]);
    harness.fetch_now().await;
    assert_eq!(harness.reconciled_branches(), ["main", "feature/test"]);
    assert_ne!(harness.remote_result("main"), harness.remote_result("feature/test"));
}
```

- [ ] **Step 2: Run tests and confirm per-cwd fetch multiplication**

Run: `node scripts/run-msvc-x64.mjs cargo test -p bibcode-server git::fetch_owner -- --nocapture`

Run: `node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --test production_git_vcs_rpc automatic_git_fetch_setting_changes_apply_without_restart -- --nocapture`

Expected: FAIL because each broadcaster entry still owns fetch.

- [ ] **Step 3: Implement one repository owner with independent worktree reconciliation**

Resolve and cache the canonical common directory with one bounded `rev-parse --git-common-dir` read; do not call the full worktree inventory merely to key fetch. Keep one timer/fetch/backoff per common directory. After fetch, signal every attached worktree to recompute ahead/behind/default delta and PR state; never copy a sibling's result.

```rust
let repository_key = repository.resolve_common_dir(cwd, cancellation).await?;
fetch_owner.attach(repository_key, cwd.to_path_buf(), subscriber_id).await;
```

- [ ] **Step 4: Prove local invalidation remains independent**

Extend `local_invalidation_starts_while_remote_refresh_is_blocked` to block the repository fetch owner while a workspace save publishes within 750 ms.

- [ ] **Step 5: Run focused and package tests**

Run: `node scripts/run-msvc-x64.mjs cargo test -p bibcode-server git::fetch_owner -- --nocapture`

Run: `node scripts/run-msvc-x64.mjs cargo test -p bibcode-server git::broadcaster -- --nocapture`

Run: `node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --test production_git_vcs_rpc -- --nocapture`

Expected: PASS; fetch count depends on repository count, not worktree count.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/git/fetch_owner.rs apps/server/src/git/mod.rs apps/server/src/git/broadcaster.rs apps/server/src/git/repository.rs apps/server/src/production/git_vcs.rs apps/server/tests/production_git_vcs_rpc.rs
git commit -m "perf(git): share automatic fetch by repository"
```

### Task 6: Client mutation priority and coalesced refresh lane

**Files:**
- Modify: `packages/client-runtime/src/state/vcsCommandScheduler.ts`
- Modify: `packages/client-runtime/src/state/vcs.ts`
- Modify: `packages/client-runtime/src/state/vcsAction.ts`
- Modify: `apps/web/src/components/GitActionsControl.tsx:146-162,1189-1220,1744-1749`
- Test: `packages/client-runtime/src/state/runtime.test.ts`
- Test: `packages/client-runtime/src/state/vcsAction.test.ts`
- Test: `apps/web/src/components/GitActionsControl.test.tsx`

**Interfaces:**
- Consumes: server mutation fencing from Tasks 3–4.
- Produces: mutation serial lane plus `vcsStatusRefreshScheduler` that shares active refresh, retains one trailing signal, and never queues a mutation behind a read; tests define a local `deferred<T>()` helper and scheduler harness with `settled(key)`.

- [ ] **Step 1: Write failing scheduler tests**

```typescript
it("starts a mutation while a refresh read is active", async () => {
  const refresh = deferred<void>()
  const mutation = vi.fn(async () => undefined)
  scheduler.scheduleRefresh("environment-1", "/repo", () => refresh.promise)
  await scheduler.scheduleMutation("environment-1", "/repo", mutation)
  expect(mutation).toHaveBeenCalledTimes(1)
  refresh.resolve()
})

it("coalesces focus visibility and menu signals", async () => {
  const refresh = deferred<void>()
  const run = vi.fn(() => refresh.promise)
  scheduler.signalRefresh(key, run)
  scheduler.signalRefresh(key, run)
  scheduler.signalRefresh(key, run)
  expect(run).toHaveBeenCalledTimes(1)
  refresh.resolve()
  await scheduler.settled(key)
  expect(run).toHaveBeenCalledTimes(2)
})

it("keeps explicit post-mutation refresh after the mutation", async () => {
  const order: string[] = []
  await scheduler.scheduleMutation(key.environmentId, key.cwd, async () => order.push("mutation"))
  await scheduler.scheduleExplicitRefresh(key, async () => order.push("refresh"))
  expect(order).toEqual(["mutation", "refresh"])
})
```

- [ ] **Step 2: Run focused tests and confirm current serial blocking**

Run: `vp test run packages/client-runtime/src/state/runtime.test.ts packages/client-runtime/src/state/vcsAction.test.ts apps/web/src/components/GitActionsControl.test.tsx`

Expected: FAIL because refresh and mutation share one FIFO lane.

- [ ] **Step 3: Add a dedicated refresh scheduler without changing mutation serialization**

```typescript
export const vcsStatusRefreshScheduler = createAtomCommandScheduler()
export const vcsStatusRefreshConcurrency = {
  mode: "latest",
  key: ({ environmentId, input }) => JSON.stringify([environmentId, input.cwd]),
} as const
```

Use the server epoch to make overlap safe. Keep pull/stage/commit on `vcsCommandScheduler`. Preserve one trailing refresh after a signal received during an active read.

- [ ] **Step 4: Preserve focus/menu freshness tests**

Update tests to assert trigger retention and physical-call coalescing, not deletion. Hidden documents still schedule nothing.

- [ ] **Step 5: Run client/web suites**

Run: `vp test run packages/client-runtime/src/state/runtime.test.ts packages/client-runtime/src/state/vcsAction.test.ts apps/web/src/components/GitActionsControl.test.tsx apps/web/src/state/sourceControlActions.behavior.test.ts`

Expected: PASS; Stage is not held behind refresh and post-action status still refreshes.

- [ ] **Step 6: Commit**

```bash
git add packages/client-runtime/src/state/vcsCommandScheduler.ts packages/client-runtime/src/state/vcs.ts packages/client-runtime/src/state/vcsAction.ts apps/web/src/components/GitActionsControl.tsx packages/client-runtime/src/state/runtime.test.ts packages/client-runtime/src/state/vcsAction.test.ts apps/web/src/components/GitActionsControl.test.tsx
git commit -m "perf(client): prioritize VCS mutations over refresh"
```

### Task 7: Documentation, measurement gate, and complete verification

**Files:**
- Modify: `docs/architecture/overview.md`
- Modify: `docs/architecture/rpc-and-orchestration.md`
- Modify: `docs/testing/cross-platform-validation.md`
- Modify: `docs/testing/windows-desktop.md`
- Test: `apps/server/tests/production_git_vcs_rpc.rs`

**Interfaces:**
- Consumes: all prior tasks.
- Produces: living architecture/runbook updates and a recorded decision on whether the automatic-fetch default advances to 180 seconds.

- [ ] **Step 1: Update living docs with exact ownership and commands**

Document worktree status owner, mutation epoch, repository fetch owner, optional-lock policy, focus freshness, and measurement procedure. Do not put one machine's timings in living runbooks.

- [ ] **Step 2: Run focused verification**

Run: `vp test run packages/contracts/src/vcs.test.ts apps/web/src/components/SourceControlPanel.test.tsx apps/web/src/components/files/FileBrowserPanel.test.tsx apps/web/src/components/GitActionsControl.test.tsx apps/web/src/components/Sidebar.test.tsx apps/web/src/components/ThreadStatusIndicators.test.tsx`

Run: `node scripts/run-msvc-x64.mjs cargo test -p bibcode-server git:: -- --nocapture`

Run: `node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --test production_git_vcs_rpc -- --nocapture`

- [ ] **Step 3: Run repository gates**

Run: `vp check`

Run: `vp run typecheck`

Run: `cargo fmt --all --check`

Run: `node scripts/run-msvc-x64.mjs cargo clippy -p bibcode-server --all-targets -- -D warnings`

- [ ] **Step 4: Execute the ten-minute Windows idle/foreground benchmark**

Record top-level Git processes/minute per physical repository and p95 foreground queue delay. If either approved threshold is exceeded, change the default to `180_000 ms` in the same follow-up commit with settings tests/docs; otherwise record that the 30-second default remains.

- [ ] **Step 5: Review final diff/status**

Run: `git diff --check && git status --short`

Expected: only intended VCS/docs/test changes; no generated `.codegraph`, debug output, or dependency drift.

- [ ] **Step 6: Commit**

```bash
git add docs/architecture/overview.md docs/architecture/rpc-and-orchestration.md docs/testing/cross-platform-validation.md docs/testing/windows-desktop.md apps/server/tests/production_git_vcs_rpc.rs
git commit -m "docs: describe coordinated VCS observation"
```
