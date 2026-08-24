# Worktree Catalog Fingerprint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve focus/manual worktree discovery freshness while skipping redundant Git inventory scans when bounded Git-admin evidence proves the repository unchanged.

**Architecture:** Add a subprocess-free fingerprint under the server's existing repository observation owner. Focus refresh may reuse a healthy matching fingerprint until a five-minute real-scan reconciliation; manual Explicit refresh always scans. Existing per-project joins, mutation epochs, suppressions, and catalog lock ownership remain unchanged.

**Tech Stack:** Rust, Tokio filesystem APIs, Git worktree on-disk layout, Axum RPC, Effect Schema/Atom, React, Vitest/Vite+.

**Spec:** `docs/superpowers/specs/2026-08-20-worktree-catalog-fingerprint-design.md`

## Global Constraints

- Server remains authoritative for paths, repository identity, availability, and destructive decisions.
- Fingerprint errors fail open to a real Git scan; they never prove absence or health.
- Capture fingerprint before the authoritative scan and force a real scan at least every five minutes.
- Do not extend degraded/failed snapshots or skip per-project joins, suppressions, anchor validation, or mutation epochs.
- Preserve focus/visibility discovery, manual Retry, managed-creation suppression, reusable/suffixed branch creation, cancellation, idle eviction, WSL/SSH behavior, and mixed-version clients.
- Manual Retry is Explicit; focus is separately identified and cache-eligible.

---

### Task 1: Subprocess-free Git-admin fingerprint

**Files:**
- Create: `apps/server/src/worktree_catalog/fingerprint.rs`
- Modify: `apps/server/src/worktree_catalog/mod.rs`
- Test: `apps/server/src/worktree_catalog/fingerprint.rs`

**Interfaces:**
- Consumes: host path identity helpers and trusted canonical common directory.
- Produces: `CatalogRepositoryFingerprint`, `FingerprintOutcome::{Known, Unknown}`, and `read_catalog_repository_fingerprint(FingerprintRequest)`; tests add `FingerprintFixture` for real Git/admin mutations.

- [ ] **Step 1: Write real-filesystem failing tests**

```rust
#[tokio::test]
async fn stable_repo_has_stable_fingerprint() {
    let fixture = FingerprintFixture::new().await;
    assert_eq!(fixture.read().await, fixture.read().await);
}
#[tokio::test]
async fn changes_after_add_move_lock_checkout_commit_and_remove() {
    let fixture = FingerprintFixture::new().await;
    let baseline = fixture.read_known().await;
    fixture.add_worktree("feature").await;
    assert_ne!(baseline, fixture.read_known().await);
    let after_add = fixture.read_known().await;
    fixture.lock_worktree("feature").await;
    assert_ne!(after_add, fixture.read_known().await);
}
#[tokio::test]
async fn packed_ref_and_reftable_signatures_are_included() {
    let fixture = FingerprintFixture::new().await;
    let baseline = fixture.read_known().await;
    fixture.pack_refs().await;
    assert_ne!(baseline, fixture.read_known().await);
}
#[tokio::test]
async fn malformed_or_escaping_gitdir_is_unknown() {
    let fixture = FingerprintFixture::with_gitdir("gitdir: ../../outside").await;
    assert!(matches!(fixture.read().await, FingerprintOutcome::Unknown(_)));
}
```

- [ ] **Step 2: Run tests and confirm RED**

Run: `node scripts/run-msvc-x64.mjs cargo test -p bibcode-server worktree_catalog::fingerprint -- --nocapture`

Expected: FAIL because the module and types do not exist.

- [ ] **Step 3: Implement bounded fingerprint inputs**

```rust
pub(crate) struct FingerprintRequest {
    pub common_dir: PathBuf,
    pub primary_path: PathBuf,
    pub known_worktree_paths: Vec<PathBuf>,
    pub repository_lifecycle_epoch: u64,
    pub mutation_epoch: u64,
}
```

Read sorted `worktrees` entry names, per-entry `HEAD`/`gitdir`/`locked`, selected ref/config/packed/reftable signatures, and path identity/presence. Accept only descendants of trusted Git-admin roots. Bound entry count, filename length, bytes, and concurrency to existing catalog limits.

- [ ] **Step 4: Return Unknown on every incomplete proof**

Permission, symlink/junction, malformed content, disappearing path, unsupported layout, cancellation, or bound overflow returns `Unknown` with bounded diagnostics—not a partial hash.

```rust
let value = read_bounded(path, limits).await.ok();
let Some(value) = value else {
    return FingerprintOutcome::Unknown(FingerprintFailure::Unreadable);
};
```

- [ ] **Step 5: Run fingerprint tests**

Run: `node scripts/run-msvc-x64.mjs cargo test -p bibcode-server worktree_catalog::fingerprint -- --nocapture`

Expected: PASS across main/linked/bare repo fixtures and failure cases.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/worktree_catalog/fingerprint.rs apps/server/src/worktree_catalog/mod.rs
git commit -m "feat(worktrees): fingerprint Git admin state"
```

### Task 2: Repository observation reuse and five-minute reconciliation

**Files:**
- Modify: `apps/server/src/worktree_catalog/service.rs:139-165,803-940,1943-1998`
- Modify: `apps/server/src/worktree_catalog/tests.rs`

**Interfaces:**
- Consumes: fingerprint reader from Task 1 and existing `CatalogRefreshTrigger`.
- Produces: fingerprint/real-scan bookkeeping on repository observation state and focus reuse decision; tests add `CatalogFingerprintHarness` with controlled fingerprint/inventory behavior.

- [ ] **Step 1: Write failing paused-time service tests**

```rust
#[tokio::test(start_paused = true)]
async fn matching_focus_fingerprint_skips_git_until_reconciliation() {
    let harness = CatalogFingerprintHarness::healthy();
    harness.focus_refresh().await.unwrap();
    assert_eq!(harness.inventory_count(), 0);
}
#[tokio::test(start_paused = true)]
async fn changed_or_unknown_fingerprint_runs_git() {
    let harness = CatalogFingerprintHarness::changed();
    harness.focus_refresh().await.unwrap();
    assert_eq!(harness.inventory_count(), 1);
}
#[tokio::test(start_paused = true)]
async fn matching_fingerprint_forces_real_scan_at_five_minutes() {
    let harness = CatalogFingerprintHarness::healthy();
    tokio::time::advance(Duration::from_secs(5 * 60)).await;
    harness.focus_refresh().await.unwrap();
    assert_eq!(harness.inventory_count(), 1);
}
#[tokio::test]
async fn fingerprint_captured_before_scan_cannot_hide_mid_scan_mutation() {
    let harness = CatalogFingerprintHarness::pausing_scan();
    let scan = harness.start_scan();
    harness.wait_for_inventory_start().await;
    harness.mutate_repository();
    harness.release_inventory();
    scan.await.unwrap();
    harness.focus_refresh().await.unwrap();
    assert_eq!(harness.inventory_count(), 2);
}
```

- [ ] **Step 2: Run tests and confirm current focus always scans after TTL**

Run: `node scripts/run-msvc-x64.mjs cargo test -p bibcode-server worktree_catalog::tests::fingerprint -- --nocapture`

Expected: FAIL because repository state has no fingerprint bookkeeping.

- [ ] **Step 3: Store pre-scan fingerprint and real-scan timestamp**

Extend repository-owned state with:

```rust
last_fingerprint: Option<CatalogRepositoryFingerprint>,
last_real_scan_at: Option<Instant>,
```

Capture before inventory. Publish it only with the matching successful lifecycle/epoch result.

- [ ] **Step 4: Add the narrow focus reuse branch**

After existing result-TTL/lifecycle checks, Focus may reuse only when snapshot is healthy/authoritative, fingerprint is Known/equal, and real scan age is under five minutes. Explicit, Mutation, MetadataChanged, AvailabilityChanged, failure retry, and unknown fingerprint run the normal scan.

```rust
if trigger == CatalogRefreshTrigger::Focus
    && fingerprint_matches
    && last_real_scan_at.elapsed() < Duration::from_secs(5 * 60)
{
    return self.rejoin_project_snapshot(entry).await;
}
```

- [ ] **Step 5: Preserve per-project snapshot rebuilding**

Fingerprint reuse skips repository Git observation only. Re-run project projection join, suppressions, and availability reconciliation before returning the project's latest snapshot.

```rust
let project = self.load_project(project_id).await?;
self.snapshot_from_observation(project, &retained_observation, generation, previous, suppressions, cancellation).await
```

- [ ] **Step 6: Run catalog service tests**

Run: `node scripts/run-msvc-x64.mjs cargo test -p bibcode-server worktree_catalog::tests -- --nocapture`

Expected: PASS including existing focus TTL, shared-repository, stale-generation, mutation, cancellation, and eviction tests.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/worktree_catalog/service.rs apps/server/src/worktree_catalog/tests.rs
git commit -m "perf(worktrees): reuse unchanged repository observations"
```

### Task 3: Distinguish Focus from manual Explicit refresh over RPC

**Files:**
- Modify: `packages/contracts/src/worktree.ts`
- Modify: `packages/contracts/src/rpc.ts`
- Modify: `apps/server/src/production/worktree_catalog_rpc.rs:577-601`
- Modify: `packages/client-runtime/src/state/worktrees.ts:298-400`
- Modify: `apps/web/src/state/worktrees.ts:14-56`
- Test: `packages/contracts/src/worktree.test.ts`
- Test: `packages/client-runtime/src/state/worktrees.test.ts`
- Test: `apps/web/src/state/worktrees.test.tsx`
- Test: `apps/server/tests/production_worktree_catalog_rpc.rs`

**Interfaces:**
- Consumes: `CatalogRefreshTrigger::Focus` behavior from Task 2.
- Produces: optional `reason: "focus" | "explicit"` on `vcs.refreshWorktreeCatalog`; omitted decodes as Explicit.

- [ ] **Step 1: Write failing compatibility tests**

Assert omitted reason remains Explicit, focus hook sends `focus`, manual retry omits/sends `explicit`, older request fixtures decode, and server maps only exact `focus` to `CatalogRefreshTrigger::Focus`.

- [ ] **Step 2: Run focused tests and confirm all requests currently map Explicit**

Run: `vp test run packages/contracts/src/worktree.test.ts packages/client-runtime/src/state/worktrees.test.ts apps/web/src/state/worktrees.test.tsx`

Run: `node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --test production_worktree_catalog_rpc refresh -- --nocapture`

Expected: FAIL because reason is absent and handler hardcodes Explicit.

- [ ] **Step 3: Add optional reason schema and server mapping**

```typescript
reason: Schema.optionalKey(Schema.Literals(["focus", "explicit"]))
```

Rust decoding defaults missing to Explicit. Reject no current clients; unknown future values remain typed decode failures.

- [ ] **Step 4: Update only the focus hook**

`useWorktreeCatalogFocusRefresh` sends `{ projectId, reason: "focus" }`. Sidebar availability Retry and all correctness-sensitive internal service calls remain Explicit.

```typescript
void refresh({ environmentId, input: { projectId, reason: "focus" } })
```

- [ ] **Step 5: Regenerate wire fixtures and run parity tests**

Run: `node packages/contracts/scripts/export-rust-rpc-fixtures.ts`

Run: `vp run build:contracts`

Run: `vp test run packages/contracts/src/rpcRustParity.test.ts packages/contracts/src/worktree.test.ts packages/client-runtime/src/state/worktrees.test.ts apps/web/src/state/worktrees.test.tsx`

Expected: PASS with backward-compatible optional field.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/worktree.ts packages/contracts/src/rpc.ts packages/contracts/fixtures/rpc-wire apps/server/src/production/worktree_catalog_rpc.rs packages/client-runtime/src/state/worktrees.ts apps/web/src/state/worktrees.ts packages/contracts/src/worktree.test.ts packages/client-runtime/src/state/worktrees.test.ts apps/web/src/state/worktrees.test.tsx apps/server/tests/production_worktree_catalog_rpc.rs
git commit -m "fix(worktrees): preserve focus refresh intent"
```

### Task 4: Managed-creation invalidation and suppression parity

**Files:**
- Modify: `apps/server/src/worktree_catalog/service.rs`
- Modify: `apps/server/src/production/worktree_catalog_rpc.rs`
- Test: `apps/server/tests/production_worktree_catalog_rpc.rs`
- Test: `apps/web/src/components/CreateWorktreeDialog.logic.test.ts`
- Test: `apps/web/src/components/CreateWorktreeDialog.test.tsx`

**Interfaces:**
- Consumes: fingerprint repository bookkeeping from Task 2.
- Produces: managed create/retarget/remove fingerprint invalidation after terminal settlement while retaining managed-creation suppression.

- [ ] **Step 1: Write failing reusable/suffixed branch fingerprint tests**

For a free reusable local branch and an occupied branch that receives a safe suffix: create managed worktree, assert fingerprint generation changes, immediate focus does not expose the managed checkout as adoptable, and the immutable creation receipt remains authoritative.

- [ ] **Step 2: Run tests and confirm fingerprint is not invalidated**

Run: `node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --test production_worktree_catalog_rpc managed_creation -- --nocapture`

Expected: FAIL until managed settlement invalidates fingerprint bookkeeping.

- [ ] **Step 3: Invalidate after existing terminal ownership settles**

Call the fingerprint invalidation seam after durable worktree/thread creation or terminal remove/retarget settlement. Do not move the call before rollback identity/receipt is known and do not reorder catalog locks.

```rust
let result = operation.await?;
catalog.invalidate_repository_fingerprint(&result.repository_key).await;
Ok(result)
```

- [ ] **Step 4: Run server and dialog regression tests**

Run: `node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --test production_worktree_catalog_rpc -- --nocapture`

Run: `vp test run apps/web/src/components/CreateWorktreeDialog.logic.test.ts apps/web/src/components/CreateWorktreeDialog.test.tsx`

Expected: PASS for reusable branch, suffixing, suppression, retry receipts, and rollback.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/worktree_catalog/service.rs apps/server/src/production/worktree_catalog_rpc.rs apps/server/tests/production_worktree_catalog_rpc.rs
git commit -m "fix(worktrees): invalidate fingerprints after mutation"
```

### Task 5: Performance evidence, living docs, and full verification

**Files:**
- Modify: `docs/architecture/worktree-catalog.md`
- Modify: `docs/architecture/rpc-and-orchestration.md`
- Modify: `docs/architecture/overview.md`
- Modify: `docs/testing/cross-platform-validation.md`
- Modify: `docs/testing/windows-desktop.md`
- Test: `apps/server/src/worktree_catalog/tests.rs`

**Interfaces:**
- Consumes: all prior tasks.
- Produces: measured focus/manual behavior, documented five-minute reconciliation, and complete validation evidence.

- [ ] **Step 1: Add a fleet workload test**

Use ten local repositories, repeated focus at one-second simulated cadence, and 30 minutes of paused time. Assert unchanged fingerprint suppresses Git scans until each five-minute reconciliation; changed/unknown fingerprints scan immediately.

- [ ] **Step 2: Run focused catalog suites**

Run: `node scripts/run-msvc-x64.mjs cargo test -p bibcode-server worktree_catalog -- --nocapture`

Run: `vp test run packages/contracts/src/worktree.test.ts packages/client-runtime/src/state/worktrees.test.ts apps/web/src/state/worktrees.test.tsx apps/web/src/components/Sidebar.test.tsx`

- [ ] **Step 3: Update living architecture and runbooks**

Document fingerprint inputs/bounds, pre-scan capture, focus/explicit split, five-minute reconciliation, failure-open behavior, and managed suppression. Review affected runbooks and state when they remain accurate.

- [ ] **Step 4: Run repository gates**

Run: `vp check`

Run: `vp run typecheck`

Run: `cargo fmt --all --check`

Run: `node scripts/run-msvc-x64.mjs cargo test -p bibcode-server -j 2`

Run: `node scripts/run-msvc-x64.mjs cargo clippy -p bibcode-server --all-targets -- -D warnings`

- [ ] **Step 5: Review final diff/status**

Run: `git diff --check && git status --short`

Expected: no `.codegraph`, debug artifacts, unrelated contract drift, or undocumented behavior.

- [ ] **Step 6: Commit**

```bash
git add docs/architecture/worktree-catalog.md docs/architecture/rpc-and-orchestration.md docs/architecture/overview.md docs/testing/cross-platform-validation.md docs/testing/windows-desktop.md apps/server/src/worktree_catalog/tests.rs
git commit -m "docs: describe catalog fingerprint reuse"
```
