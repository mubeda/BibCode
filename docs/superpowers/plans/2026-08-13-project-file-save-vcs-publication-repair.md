# Project File Save VCS Publication Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:systematic-debugging before diagnosis, superpowers:test-driven-development for the repair, and superpowers:verification-before-completion before reporting success. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Classify and repair the concurrent-load failure in which a successful `projects.writeFile` did not produce the subscribed local Git-status update before the 30-second fallback poller.

**Architecture:** `apps/server` owns the entire path: `WorkspaceRpc` commits the file write, its `WorkspaceMutationObserver` signals `StatusBroadcaster`, and the broadcaster publishes `VcsStatusStreamEvent::LocalUpdated` through the existing WebSocket stream. Diagnosis must prove the failing boundary first. If the observed failure is the current single poller task awaiting remote or ref Git work before it can receive a local invalidation, split local invalidation ownership from slower periodic remote/ref work while retaining one coalescing local worker per canonical repository and the existing bounded subscriber channel.

**Tech Stack:** Rust 1.97.1, Tokio channels and cancellation, Axum/Effect WebSocket RPC, real Git integration fixtures.

## Global Constraints

- Scope is limited to `apps/server` Git/VCS/workspace-file event ownership, its closest tests, and living architecture text only if a lifecycle invariant changes.
- Preserve the public RPC shapes, authentication and availability admission, persistence, the 30-second fallback local-status interval, the shared 15-second diagnostic WebSocket bound, and the 750ms event-driven publication assertion.
- Do not add sleeps, yields, polling, blanket retries, global locks, package serialization, reduced test threads, or wider timeouts.
- Ordering tests use positive barrier/channel readiness and exact owner events; wall-clock timeouts are diagnostic failure bounds only.
- Local invalidations may coalesce, but a mutation observed after a clean snapshot must not be lost behind unrelated remote/ref work. Each canonical repository retains one local refresh owner and bounded subscriber delivery.
- Preserve cancellation, final-subscriber release, duplicate-event suppression, bounded Git process execution, and fallback polling.
- Classify descendant/supervised-cleanup warnings only when causal evidence connects them to this failure; otherwise record them as a separate residual.

---

## Evidence Behind This Amendment

Task 9 ran the server and desktop package commands concurrently from clean `54883b30`. The server library passed `1181/1181`, but `production_git_vcs_rpc` ended `28/29`: `project_file_save_publishes_git_status_without_waiting_for_the_fallback_poller` reached the shared 15-second WebSocket receive panic. The original output did not identify which receive was pending, so this amendment authorizes the exact test and test-owned checkpoints before any fix.

The source trace is:

1. `apps/server/src/workspace/rpc.rs::WorkspaceRpc::handle("projects.writeFile")` writes the file, invalidates the search index, awaits `WorkspaceMutationObserver::workspace_mutated`, then returns success.
2. `apps/server/src/production/git_vcs.rs::GitVcsRpcServices::workspace_mutated` awaits `StatusBroadcaster::notify_local_change`.
3. `apps/server/src/git/broadcaster.rs::notify_local_change` increments a per-repository `watch` generation.
4. One spawned broadcaster task first awaits `refresh_remote`, then serially performs local invalidation, local fallback, remote refresh, and ref refresh branches. A local generation is retained by `watch`, but publication latency can be coupled to an already-running unrelated Git operation.
5. `apps/server/src/production/git_vcs.rs::status_stream` transports the broadcaster event to the WebSocket subscriber.

The owner and source of truth are unchanged: the filesystem owns written bytes, `GitRepository::local_status` owns the current local snapshot, `StatusBroadcaster` owns the latest per-repository snapshot and subscriber set, and the WebSocket stream is only the delivery boundary.

## Alternatives and Trade-offs

### A. Separate local invalidation ownership from remote/ref work — selected if diagnosis confirms owner-task blocking

Keep one repository entry and cancellation token, but give mutation/fallback local refreshes a single coalescing local worker that cannot be blocked by remote initialization, fetch, or ref refresh. Remote/ref work remains bounded and may update the same repository entry through the existing short state mutex. This preserves fast file saves, prevents overlapping local refresh storms, and maintains bounded publication; it adds a small amount of explicit worker lifecycle state that must be canceled and released with the final subscriber.

### B. Refresh local status inline in `workspace_mutated` — rejected

Calling `refresh_local` directly would make the file-write RPC wait for Git and would couple editor save latency to process admission and repository size. It can also duplicate the poller's local scan. This is correct-looking but violates the performance-first boundary and does not isolate unrelated Git load.

### C. Bias the existing `tokio::select!` toward local notifications — rejected

Bias can choose local work when the loop is idle, but it cannot preempt the initial remote refresh or a remote/ref future already awaited inside a selected branch. It does not cover the observed concurrency envelope.

### D. Increase timeouts, retain the 100ms settling sleep, retry receives, or serialize tests — rejected

These mask the interleaving, weaken the fallback-latency contract, and provide no owner-level correctness guarantee.

### E. Fixture-only checkpoint repair — selected only if diagnosis disproves production blocking

If exact checkpoints prove the event arrives correctly and the failure is caused solely by the test's 100ms guess about immediate poller work, replace that sleep with a positive event/readiness boundary owned by the fixture. Do not change production behavior. The test must still exercise the real server, Git repository, RPC, and WebSocket delivery.

---

### Task 1: Diagnose the exact pending boundary

**Files:**
- Inspect: `apps/server/tests/production_git_vcs_rpc.rs`
- Inspect: `apps/server/src/workspace/rpc.rs`
- Inspect: `apps/server/src/production/git_vcs.rs`
- Inspect: `apps/server/src/git/broadcaster.rs`

**Interfaces:**
- Consumes: `projects.writeFile`, `WorkspaceMutationObserver::workspace_mutated`, `StatusBroadcaster::notify_local_change`, `subscribeVcsStatus`.
- Produces: a written classification of the exact pending checkpoint and one falsifiable root-cause hypothesis.

- [ ] **Step 1: Run the approved exact reproduction once on unchanged code**

```bash
cargo test -p bibcode-server --test production_git_vcs_rpc project_file_save_publishes_git_status_without_waiting_for_the_fallback_poller -- --exact --nocapture
```

Record whether it passes in isolation. An isolated pass is not concurrency proof.

- [ ] **Step 2: Add test-owned named receive checkpoints only if the exact output remains ambiguous**

Change the integration helper call sites in this test to name `initial snapshot`, `initial remote`, `write success`, and `local update` in panic diagnostics without changing any duration. Run the exact test and, if necessary, the original concurrent server/desktop envelope once to identify the pending boundary. Remove purely diagnostic scaffolding unless it remains useful failure context in the final test.

- [ ] **Step 3: Confirm or reject the production-blocking hypothesis**

Hypothesis: a local mutation generation is retained but its scan is delayed because the only poller owner is awaiting initial remote, later remote, or ref Git work. Evidence must show both that the mutation notification was published and that the local Git scan did not start while unrelated Git work owned the single poller task. If the evidence instead identifies fixture readiness, subscriber eviction, path mismatch, channel overflow, cancellation, or process admission, stop and update this amendment before behavior edits.

### Task 2: Add the owner-seam RED regression

**Files:**
- Modify test module: `apps/server/src/git/broadcaster.rs`
- Optionally modify test-only support: `apps/server/src/git/repository.rs`

**Interfaces:**
- Consumes: `GitRepository::with_runner_for_test`, `GitProcessRunner`, `StatusBroadcaster::{subscribe,notify_local_change}`, `StatusSubscription::recv`.
- Produces: `local_invalidation_starts_while_remote_refresh_is_blocked` (or an equivalently precise name matching the diagnosed boundary).

- [ ] **Step 1: Name the break before writing the test**

The regression must fail if local mutation processing shares a non-preemptible worker with remote/ref Git work. It must assert a real `LocalUpdated` snapshot derived from literal fake Git outputs, not merely assert that a fake was called.

- [ ] **Step 2: Write a barrier-controlled test**

Use a test-only `GitProcessRunner` whose initial clean local-status calls complete, whose remote-status operation publishes `remote_entered` and waits on `release_remote`, and whose later local-status calls return a literal dirty `tracked.txt` porcelain result. After the subscription snapshot and positive `remote_entered` checkpoint, call `notify_local_change`. Assert through a channel that the second local-status scan starts and through `StatusSubscription::recv` that `LocalUpdated { local.has_working_tree_changes == true }` arrives before releasing remote work. Finally release the remote barrier and prove cancellation/final-subscriber cleanup completes.

- [ ] **Step 3: Verify RED for the expected reason**

```bash
cargo test -p bibcode-server --lib git::broadcaster::tests::local_invalidation_starts_while_remote_refresh_is_blocked -- --exact --nocapture
```

Expected on the diagnosed implementation: the local-scan readiness bound expires while the fake remote operation remains deliberately blocked. A compile error, fixture parse error, or generic receive timeout is not an accepted RED.

### Task 3: Implement the smallest owner-level repair

**Files:**
- Modify: `apps/server/src/git/broadcaster.rs`
- Modify only if wiring requires it: `apps/server/src/production/git_vcs.rs`
- Update if the lifecycle invariant changes: `docs/architecture/overview.md`

**Interfaces:**
- Preserve: `StatusBroadcaster::{subscribe,refresh_local,notify_local_change,refresh_status}` and `StatusSubscription` public behavior.
- Produce: per-canonical-repository local invalidations serviced independently of remote/ref awaits, with one coalescing local owner and exact final-subscriber cancellation.

- [ ] **Step 1: Implement only the diagnosed repair**

Move local invalidation/fallback scheduling into its own repository-owned task or equivalent independently polled future. Keep `watch` latest-generation coalescing, the existing 30-second local fallback interval, state comparison before publication, bounded `try_send`, and one cancellation token rooted in the repository entry. Do not spawn one task per mutation and do not perform Git work while holding the state mutex.

- [ ] **Step 2: Verify GREEN and lifecycle neighbors**

```bash
cargo test -p bibcode-server --lib git::broadcaster::tests::local_invalidation_starts_while_remote_refresh_is_blocked -- --exact --nocapture
cargo test -p bibcode-server --test git_rpc status_subscription_starts_with_snapshot_deduplicates_and_stops_last_poller -- --exact
cargo test -p bibcode-server --test git_rpc status_subscription_poller_observes_external_working_tree_changes -- --exact
```

- [ ] **Step 3: Re-run the public event path**

Remove the existing 100ms readiness guess only when a positive fixture checkpoint replaces it. Keep the 750ms assertion.

```bash
cargo test -p bibcode-server --test production_git_vcs_rpc project_file_save_publishes_git_status_without_waiting_for_the_fallback_poller -- --exact --nocapture
```

### Task 4: Concurrency and repository gates

**Files:**
- Verify: all scoped source, tests, documentation, manifests, and CI contracts.
- Append ignored evidence: `.superpowers/sdd/2026-08-11-parallel-rust-test-sandboxes/task-9-report.md`
- Append ignored ledger: `.superpowers/sdd/2026-08-11-parallel-rust-test-sandboxes/progress.md`

- [ ] **Step 1: Exercise the complete integration binary at three harness widths**

```bash
cargo test -p bibcode-server --test production_git_vcs_rpc
cargo test -p bibcode-server --test production_git_vcs_rpc -- --test-threads=8
cargo test -p bibcode-server --test production_git_vcs_rpc -- --test-threads=12
```

- [ ] **Step 2: Re-run the original package envelope concurrently**

Start both at the same time and require both exits to be zero:

```text
vp run --filter bibcode test
vp run --filter @bibcode/desktop test
```

Record descendant/supervised-cleanup warnings separately. Investigate them here only when diagnostics connect them to this owner path.

- [ ] **Step 3: Run affected-package and static gates**

```bash
cargo test -p bibcode-server -j 2
cargo fmt --all --check
cargo clippy -p bibcode-server --all-targets -- -D warnings
vp check
vp run typecheck
```

- [ ] **Step 4: Review and commit intentionally**

Review `git diff`, `git status --short`, and affected tests for accidental timeout widening, sleeps/yields, unbounded spawning, lock-held I/O, debug output, dependency drift, and missing living documentation. Obtain an independent read-only review of the scoped RED-to-GREEN diff. Commit the amendment separately before the repair when practical, then commit the coherent source/test repair.
