# File Manager Index Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce cold and post-mutation File Manager index latency while preserving exact tracked/untracked/deleted/ignored classification and current tree behavior.

**Architecture:** Keep the canonical server index and existing single-flight cache. Replace three sequential Git listing commands with two concurrent classified reads, retain the index for content-only writes, and measure filesystem traversal separately before introducing lazy ignored-directory behavior.

**Tech Stack:** Rust, Tokio, Git CLI `ls-files`, Axum RPC, React/FileTree, Vitest/Vite+.

**Spec:** `docs/superpowers/specs/2026-08-20-file-manager-index-performance-design.md`

## Global Constraints

- Preserve the public project-entry and mutation RPC shapes.
- Preserve eager ignored-directory contents during the first rollout.
- Preserve server-owned index single-flight, generation fencing, explicit Refresh, out-of-band path signals, expansion, drag/drop recovery, and workspace guards.
- Keep VCS status/Git decorations separate from the path index.
- Use `GIT_OPTIONAL_LOCKS=0`, existing limits, cancellation, and fallback behavior for index reads.
- Add lazy ignored-directory loading later only when the approved 50%/500 ms gate is exceeded.
- Run focused tests, repository gates, and final diff/status review.

---

### Task 1: Classified two-command Git snapshot

**Files:**
- Modify: `apps/server/src/workspace/search.rs:171-317,417-451`
- Test: `apps/server/src/workspace/search.rs` test module
- Test: `apps/server/tests/workspace_rpc.rs`

**Interfaces:**
- Consumes: existing `SearchSnapshot`, `WorkspaceEntry`, `ProcessRunner`, and bounds.
- Produces: `GitListedPathKind`, `WorkspaceGitCommandRunner`, `run_git_main_listing`, `run_git_ignored_listing`, and unchanged `scan_git` output; tests add `WorkspaceSearchSandbox` and `PausingWorkspaceGitRunner`.

- [ ] **Step 1: Write failing parser and process-count tests**

```rust
#[test]
fn tagged_main_listing_distinguishes_cached_deleted_and_untracked() {
    let parsed = parse_main_listing(b"H tracked.rs\0R deleted.rs\0? new.rs\0").unwrap();
    assert_eq!(parsed[0].kind, GitListedPathKind::Cached);
    assert_eq!(parsed[1].kind, GitListedPathKind::Deleted);
    assert_eq!(parsed[2].kind, GitListedPathKind::Untracked);
}

#[tokio::test]
async fn git_snapshot_uses_two_concurrent_processes() {
    let sandbox = WorkspaceSearchSandbox::new();
    let runner = PausingWorkspaceGitRunner::new();
    let scan = scan_git_with_runner(
        sandbox.root(),
        SearchLimits::default(),
        &CancellationToken::new(),
        runner.clone(),
    );
    runner.wait_for_started(2).await;
    assert_eq!(runner.started(), 2);
    runner.release_all();
    scan.await.unwrap();
}
```

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `node scripts/run-msvc-x64.mjs cargo test -p bibcode-server workspace::search -- --nocapture`

Expected: FAIL because the classified parser/runner seam does not exist and current scan launches three sequential commands.

- [ ] **Step 3: Implement the tagged main listing**

```text
git -c core.quotePath=false ls-files -z -t --cached --others --deleted --exclude-standard --
```

Accept `H`/`S` as cached index entries, `R` as deleted, and `?` as ordinary untracked. Reject unknown/malformed tags rather than silently misclassifying them.

- [ ] **Step 4: Implement the ignored-root listing**

```text
git -c core.quotePath=false ls-files -z --others --ignored --exclude-standard --directory --
```

Run both requests with `tokio::try_join!`. If either request is unsupported, malformed, truncated, timed out, or non-zero, return `Ok(None)` so the existing bounded filesystem scan handles the request.

- [ ] **Step 5: Preserve directory and ignored-content completion**

Keep `scan_ignored_directory_contents`, `scan_directories`, duplicate suppression, empty-directory rows, and all bounds unchanged.

- [ ] **Step 6: Run workspace search/RPC tests**

Run: `node scripts/run-msvc-x64.mjs cargo test -p bibcode-server workspace::search -- --nocapture`

Run: `node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --test workspace_rpc -- --nocapture`

Expected: PASS with two Git starts, exact classifications, and unchanged fallback/tree results.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/workspace/search.rs apps/server/tests/workspace_rpc.rs
git commit -m "perf(files): reduce workspace Git listing launches"
```

### Task 2: Preserve the index for content-only writes

**Files:**
- Modify: `apps/server/src/workspace/service.rs:17-24,94-112`
- Modify: `apps/server/src/workspace/rpc.rs:214-235`
- Test: `apps/server/tests/workspace_rpc.rs`

**Interfaces:**
- Consumes: existing safe path resolution and index invalidation.
- Produces: internal `WriteFileOutcome { relative_path: String, path_set_changed: bool }`; public RPC stays `{ relativePath }`.

- [ ] **Step 1: Write failing existing-versus-created write tests**

```rust
#[tokio::test]
async fn writing_existing_file_keeps_cached_index() {
    let before = rpc.index_scans();
    write_existing(&rpc).await;
    list_entries(&rpc).await;
    assert_eq!(rpc.index_scans(), before);
}

#[tokio::test]
async fn write_file_that_creates_a_path_invalidates_index() {
    let before = rpc.index_scans();
    write_new_nested_file(&rpc).await;
    list_entries(&rpc).await;
    assert_eq!(rpc.index_scans(), before + 1);
}
```

- [ ] **Step 2: Run tests and confirm both writes currently invalidate**

Run: `node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --test workspace_rpc write_file -- --nocapture`

Expected: existing-file assertion fails because `projects.writeFile` always invalidates.

- [ ] **Step 3: Return internal path-set metadata from the service**

```rust
pub(crate) struct WriteFileOutcome {
    pub relative_path: String,
    pub path_set_changed: bool,
}
```

Resolve the safe target, check target and required parent existence before creation, write the file, and set `path_set_changed` when the file or parent path was absent. Keep the check and write inside the existing workspace operation/finalization boundary.

- [ ] **Step 4: Invalidate only when the path set changed**

```rust
if outcome.path_set_changed {
    self.invalidate_index(&input.cwd).await;
}
observer.workspace_mutated(Path::new(&input.cwd)).await;
Ok(json!({ "relativePath": outcome.relative_path }))
```

VCS mutation notification still runs for both cases.

- [ ] **Step 5: Run service/RPC/FileBrowser tests**

Run: `node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --test workspace_rpc -- --nocapture`

Run: `vp test run apps/web/src/components/files/FileBrowserPanel.test.tsx`

Expected: PASS; RPC shape and FileBrowser refresh behavior remain unchanged.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/workspace/service.rs apps/server/src/workspace/rpc.rs apps/server/tests/workspace_rpc.rs
git commit -m "perf(files): retain index after content saves"
```

### Task 3: Index phase instrumentation and cache evidence

**Files:**
- Modify: `apps/server/src/workspace/search.rs`
- Modify: `apps/server/src/workspace/rpc.rs:591-625`
- Test: `apps/server/tests/workspace_rpc.rs`
- Modify: `docs/operations/observability.md`

**Interfaces:**
- Consumes: two-command snapshot and existing `index_scans` counter.
- Produces: structured phase durations for cache wait/build, Git listing, ignored walk, and directory walk.

- [ ] **Step 1: Write failing phase-observer test**

Add a test-only observer to `WorkspaceRpcDependencies` that records `WorkspaceIndexPhase { phase, elapsed }`; assert one cold build emits all phases and a warm hit emits only `cache_hit`.

- [ ] **Step 2: Run the focused observer test and confirm RED**

Run: `node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --test workspace_rpc index_phase -- --nocapture`

Expected: FAIL because no phase observer exists.

- [ ] **Step 3: Emit bounded structured timing events**

Use `Instant::now()` at phase boundaries and `tracing::debug!` fields `operation`, `phase`, `elapsed_ms`, `entry_count`, and `cache_outcome`. Do not log raw paths or entry names.

```rust
tracing::debug!(
    operation = "WorkspaceSearchIndex.refresh",
    phase,
    elapsed_ms = started.elapsed().as_millis(),
    entry_count,
    cache_outcome,
);
```

- [ ] **Step 4: Document how to distinguish File Manager and VCS cost**

Add `WorkspaceSearchIndex.gitSnapshot` and phase fields to observability guidance; keep execution-specific timings in reports, not the runbook.

- [ ] **Step 5: Run focused tests**

Run: `node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --test workspace_rpc -- --nocapture`

Expected: PASS; warm path performs no Git work.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/workspace/search.rs apps/server/src/workspace/rpc.rs apps/server/tests/workspace_rpc.rs docs/operations/observability.md
git commit -m "chore(files): measure workspace index phases"
```

### Task 4: Regression suite and living documentation

**Files:**
- Modify: `docs/architecture/rpc-and-orchestration.md`
- Modify: `docs/user/workspace-ui.md`
- Review: `docs/testing/cross-platform-validation.md`
- Test: `apps/server/tests/workspace_rpc.rs`
- Test: `apps/web/src/components/files/FileBrowserPanel.test.tsx`

**Interfaces:**
- Consumes: all prior tasks.
- Produces: current index contract and measurement gate for lazy ignored-directory loading.

- [ ] **Step 1: Add a real-Git classification fixture**

Create tracked, deleted, ordinary untracked, ignored file, ignored directory, empty directory, and non-Git workspace cases. Assert exact `WorkspaceEntry { path, kind, ignored }` results and bounds.

- [ ] **Step 2: Run focused server and web tests**

Run: `node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --test workspace_rpc -- --nocapture`

Run: `vp test run apps/web/src/components/files/FileBrowserPanel.test.tsx packages/contracts/src/project.test.ts`

- [ ] **Step 3: Update living docs**

Document two concurrent Git listings, content-only index retention, unchanged eager ignored behavior, and the explicit Refresh/fallback contract. State that testing runbooks were reviewed; update them only if commands/evidence requirements changed.

- [ ] **Step 4: Execute the File Manager benchmark gate**

Measure cold/warm p95 phase times. If ignored walking is over 50% of build time or over 500 ms p95, open the separately reviewed lazy-loading change described by the spec; do not add it to this patch.

- [ ] **Step 5: Run repository gates and final review**

Run: `vp check`

Run: `vp run typecheck`

Run: `cargo fmt --all --check`

Run: `node scripts/run-msvc-x64.mjs cargo clippy -p bibcode-server --all-targets -- -D warnings`

Run: `git diff --check && git status --short`

- [ ] **Step 6: Commit**

```bash
git add docs/architecture/rpc-and-orchestration.md docs/user/workspace-ui.md docs/testing/cross-platform-validation.md apps/server/tests/workspace_rpc.rs apps/web/src/components/files/FileBrowserPanel.test.tsx
git commit -m "docs: describe optimized File Manager index"
```
