# Merge into another branch and Source Control merge — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users merge a branch into a branch that is not checked out (Git Manager **Merge…** dialog, new **Into** picker) and merge a fetched branch into the current worktree from the Source Control panel, with conflict recovery in the panel.

**Architecture:** One new `gitManager.runOperation` variant, `merge-into`, computes the merge in the object database (`merge-tree --write-tree` → `commit-tree`) and publishes it with fast-forward-only `git fetch . <merge>:refs/heads/<target>`, so Git refuses branches in use by any worktree. The Source Control panel reuses the existing Git Manager merge dialog and `fetch`/`merge`/`continue`/`abort`/`resolve-conflict` operations. `vcs.status` gains a `"conflicted"` file status and an `operationInProgress` field so the panel can show a merge strip.

**Tech Stack:** Rust (Axum/Tokio, git CLI via `GitRepository`), TypeScript effect/Schema contracts, React 19 + Base UI, Vite+ (`vp`) tests, `cargo test`.

**Spec:** `docs/superpowers/specs/2026-10-08-merge-into-and-source-control-merge-design.md` (read it before starting any task).

## Global Constraints

- `merge-tree --write-tree` requires Git **2.38** (the `fetch .` refusal for a branch mid-rebase in another worktree was verified on 2.39.5 and 2.55.0); `git --attr-source` with merge-tree is used only on Git **2.43** or later.
- Never use `git update-ref`, bare `--force`, or `--ignore-other-worktrees` in Git Manager paths (`docs/architecture/overview.md:1362-1365`).
- Publish command, exactly: `git -c maintenance.auto=false -c fetch.writeCommitGraph=false fetch --no-tags --no-prune --no-recurse-submodules --no-write-fetch-head --quiet . <merge>:refs/heads/<target>` with `GIT_REFLOG_ACTION="merge-into <source>"`.
- The target is always resolved as `refs/heads/<target>`; sources are full refs (`refs/heads/x` or `refs/remotes/<remote>/x`).
- Capability name: `gitManagerMergeIntoOperations` (decoding default `false`), advertised in `apps/server/src/production/control.rs` next to `gitManagerStashMergeOperations`.
- Copy (verbatim):
  - Dialog hint: "`<target>` is updated without checking it out. Your files don't change and commit hooks don't run."
  - Conflicted merge-into preview: "N files would conflict. Check out `<target>` to merge and resolve them."
  - Server conflict: "N files would conflict. Check out <target> and merge there to resolve them."
  - Target moved: "<target> changed while merging. Review the preview and try again."
  - Old Git (preview): "Merge preview needs Git 2.38 or later on this environment (found X)."
  - Old Git (merge-into): "Merging into another branch needs Git 2.38 or later on this environment (found X)."
  - Strip continue-only reason: "Resolve and stage every conflicted file first."
  - Source Control gating: "Check out a branch to merge into." / "Finish or abort the current merge first." / "Commit your changes before merging."
  - Busy: "A merge is running."
  - Toolbar tooltip: "Merge one branch into another"
- Wire failure codes: `target-is-current`, `git-too-old`, `unrelated-histories`, `conflicts`, `non-fast-forward`, `local-branch-not-found`, blocked `worktree-checked-out`. New codes are emitted through `operation_error(...)` string codes (the existing `invalid-request` pattern); `GitManagerFailureCode` is not extended.
- Every commit: run `codex review --uncommitted` detached (see "Commit protocol"), process findings with `superpowers:receiving-code-review`, then commit with the `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` trailer.
- Never stage `reports/`, `research_notes/`, or `.codegraph/`.

## Review Focus

- A remote name containing `/` (e.g. `team/origin`) with a source `refs/remotes/team/origin/feature`: Fetch must fetch `team/origin`, not `team` (Task 10 pins it with a longest-prefix test).
- The target branch is deleted between preview and Merge: the operation must fail with `local-branch-not-found`, not create the branch (Task 6 pins it).
- The user changes **Into** while a preview for the previous target is still cached: Merge must stay disabled until `preview.current === target` (Task 8 pins it).
- Source Control on a detached HEAD: the menu item must be disabled with "Check out a branch to merge into." (Task 10 pins it). An unborn branch is caught by the preview ("The current HEAD could not be resolved for merge preview."), which keeps Merge disabled.
- Fetch fails (auth, offline) inside the dialog: the dialog must stay open and show the failure, and Merge must still use the last good refs (Task 10 pins it).

---

## Setup (once, before Task 1)

- [ ] Install dependencies and confirm the toolchain:

```bash
cd /work/workspaces/bibcode/BibCode/Merge-to-from
SHARP_IGNORE_GLOBAL_LIBVIPS=1 mise exec pnpm@11.25.0 -- pnpm install --frozen-lockfile
node scripts/run-local-vp.mjs --version
git --version   # must be >= 2.38 for the integration tests
```

- Rust: always run cargo from `apps/server` with `CARGO_BUILD_JOBS=4` and the default per-worktree `target/` (never share a `CARGO_TARGET_DIR` across worktrees). Run cargo invocations one at a time (parallel cargo OOMs on this machine).

### Commit protocol (every task)

```bash
mkdir -p ~/.cache/bibcode-merge-into
setsid nohup bash -c 'cd /work/workspaces/bibcode/BibCode/Merge-to-from && codex review --uncommitted > ~/.cache/bibcode-merge-into/codex-task-N.log 2>&1; echo "exit=$?" >> ~/.cache/bibcode-merge-into/codex-task-N.log' >/dev/null 2>&1 &
# wait in the foreground, bounded, repeated as needed (a background waiter dies with the session):
# timeout 300 bash -c 'until grep -q "^exit=" ~/.cache/bibcode-merge-into/codex-task-N.log; do sleep 15; done'
```

`codex review --uncommitted` includes untracked files; `reports/` and `research_notes/` are untracked and out of scope for the review. Process each finding with `superpowers:receiving-code-review`, fix what holds, then `git add <task files>` (explicit paths only) and commit.

---

### Task 1: `vcs.status` conflict contract and shared reducer

**Files:**
- Modify: `packages/contracts/src/git.ts` (imports; `VcsWorkingTreeFileStatus` at ~48-55; file `status` field and `VcsStatusLocalShape` at ~270-299)
- Modify: `packages/shared/src/git.ts:172-186` (`toLocalStatusPart`)
- Test: `packages/contracts/src/git.test.ts`, `packages/shared/src/git.test.ts`

**Interfaces:**
- Produces: `VcsWorkingTreeFileStatus` includes `"conflicted"`; `VcsInProgressOperationKind = "merge" | "rebase" | "cherry-pick" | "revert" | "squash"`; `VcsStatusLocalResult.operationInProgress?: VcsInProgressOperationKind` (absent = none). Later web tasks read `status.operationInProgress` and `file.status === "conflicted"`.

- [ ] **Step 1: Write the failing contract tests** — append to `packages/contracts/src/git.test.ts`:

```ts
describe("VCS conflict state", () => {
  const healthy = {
    isRepo: true,
    hasPrimaryRemote: false,
    isDefaultRef: false,
    refName: "main",
    hasWorkingTreeChanges: true,
    workingTree: {
      files: [
        { path: "a.txt", insertions: 0, deletions: 0, status: "conflicted", area: "unstaged" },
      ],
      insertions: 0,
      deletions: 0,
    },
  };

  it("decodes a conflicted file and an in-progress merge", () => {
    const local = { ...healthy, operationInProgress: "merge" };
    expect(encodeStatusLocalResult(decodeStatusLocalResult(local))).toEqual(local);
    const event = { _tag: "localUpdated", local };
    expect(encodeStatusStreamEvent(decodeStatusStreamEvent(event))).toEqual(event);
  });

  it("decodes an unknown future file status and operation as absent", () => {
    const decoded = decodeStatusLocalResult({
      ...healthy,
      operationInProgress: "future-operation",
      workingTree: {
        ...healthy.workingTree,
        files: [{ path: "a.txt", insertions: 0, deletions: 0, status: "future", area: "unstaged" }],
      },
    });
    expect(Object.hasOwn(decoded, "operationInProgress")).toBe(false);
    expect(Object.hasOwn(decoded.workingTree.files[0]!, "status")).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node scripts/run-local-vp.mjs test run packages/contracts/src/git.test.ts`
Expected: FAIL — `"conflicted"` is not a valid literal.

- [ ] **Step 3: Implement the contract** — in `packages/contracts/src/git.ts`:

```ts
import * as Effect from "effect/Effect";
// ...
export const VcsWorkingTreeFileStatus = Schema.Literals([
  "modified",
  "added",
  "deleted",
  "renamed",
  "copied",
  "untracked",
  "conflicted",
]);
export type VcsWorkingTreeFileStatus = typeof VcsWorkingTreeFileStatus.Type;
/** Repository operation left in progress (MERGE_HEAD, rebase state, ...). */
export const VcsInProgressOperationKind = Schema.Literals([
  "merge",
  "rebase",
  "cherry-pick",
  "revert",
  "squash",
]);
export type VcsInProgressOperationKind = typeof VcsInProgressOperationKind.Type;
```

In the `workingTree.files` struct replace `status: Schema.optional(VcsWorkingTreeFileStatus),` with:

```ts
        // A status this client does not know, from a newer server, decodes as absent.
        status: Schema.optionalKey(
          VcsWorkingTreeFileStatus.pipe(Schema.catchDecoding(() => Effect.succeedNone)),
        ),
```

Add to `VcsStatusLocalShape` after `workingTree`:

```ts
  /** Absent when no operation is in progress, and from older servers. */
  operationInProgress: Schema.optionalKey(
    VcsInProgressOperationKind.pipe(Schema.catchDecoding(() => Effect.succeedNone)),
  ),
```

If `vp run typecheck` later reports code that writes `status: undefined` into a file entry, change that writer to omit the key (do not loosen the schema).

- [ ] **Step 4: Run to verify it passes**

Run: `node scripts/run-local-vp.mjs test run packages/contracts/src/git.test.ts`
Expected: PASS (all existing tests too).

- [ ] **Step 5: Write the failing reducer test** — append inside `describe("applyGitStatusStreamEvent", ...)` in `packages/shared/src/git.test.ts`:

```ts
  it("keeps operationInProgress when a remote update follows a local update", () => {
    const local = { ...localStatus, operationInProgress: "merge" as const };
    const updated = applyGitStatusStreamEvent(
      applyGitStatusStreamEvent(null, { _tag: "snapshot", local: localStatus, remote: null }),
      { _tag: "localUpdated", local },
    );
    const remoteUpdated = applyGitStatusStreamEvent(updated, {
      _tag: "remoteUpdated",
      remote: { hasUpstream: true, aheadCount: 1, behindCount: 0, pr: null },
    });
    expect(remoteUpdated.operationInProgress).toBe("merge");
  });
```

- [ ] **Step 6: Run to verify it fails**

Run: `node scripts/run-local-vp.mjs test run packages/shared/src/git.test.ts`
Expected: FAIL — `operationInProgress` is `undefined`.

- [ ] **Step 7: Implement** — in `toLocalStatusPart` (`packages/shared/src/git.ts`), after `workingTree: status.workingTree,` add:

```ts
    ...(status.operationInProgress === undefined
      ? {}
      : { operationInProgress: status.operationInProgress }),
```

- [ ] **Step 8: Run both suites and typecheck**

Run: `node scripts/run-local-vp.mjs test run packages/contracts/src/git.test.ts packages/shared/src/git.test.ts && node scripts/run-local-vp.mjs run typecheck`
Expected: PASS.

- [ ] **Step 9: Commit** (commit protocol), message `feat(contracts): carry conflicted files and in-progress operation in vcs status`.

---

### Task 2: Server `vcs.status` reports conflicts once and the in-progress operation

**Files:**
- Modify: `apps/server/src/git/manager/refs.rs:65-73` (`GitManagerInProgressKind` derives `Deserialize`)
- Modify: `apps/server/src/git/model.rs:99-135` (`VcsStatusLocalResult` field + both constructors)
- Modify: `apps/server/src/git/repository.rs` (`observe_status`, ~2190-2380; unit-test constant `EXPECTED_FUSED_OPERATIONS` ~7606)
- Test: `apps/server/tests/production_git_vcs_rpc.rs`

**Interfaces:**
- Consumes: `detect_in_progress_operation(repository, cwd, cancellation) -> Result<Option<GitManagerInProgressOperation>, GitManagerInProgressError>` (`apps/server/src/git/manager/in_progress.rs:83`; import it by the same path `production/git_manager_rpc.rs` uses).
- Produces: JSON `operationInProgress: "merge" | ...` on local status when present; one `{"status":"conflicted","area":"unstaged"}` entry per unmerged path.

- [ ] **Step 1: Write the failing integration test** — add to `apps/server/tests/production_git_vcs_rpc.rs` (model it on `stage_unstage_discard_and_invalid_pathspecs_round_trip_over_rpc`, same helpers):

```rust
#[tokio::test]
async fn status_reports_each_conflict_once_and_the_merge_in_progress() {
    let parallelism_permit = acquire_git_rpc_fixture().await;
    if relaunch_with_isolated_git_config(
        "status_reports_each_conflict_once_and_the_merge_in_progress",
    ) {
        return;
    }
    let temp = TempDir::new().expect("temporary server directory");
    let root = TempDir::new().expect("temporary fixture root");
    let repository = root.path().join("conflict-repository");
    fs::create_dir(&repository).expect("create repository directory");
    initialize_repository_in(&repository);
    commit_file(&repository, "tracked.txt", "base\n", "base");
    run_git_in(&repository, &["switch", "-q", "-c", "feature"]);
    commit_file(&repository, "tracked.txt", "feature\n", "feature");
    run_git_in(&repository, &["switch", "-q", "-"]);
    commit_file(&repository, "tracked.txt", "main\n", "main");
    let merge = git_command(&repository, &["merge", "feature"]).output().expect("merge");
    assert!(!merge.status.success(), "the fixture merge must conflict");

    let mut server = GitServerHarness::start(&temp, parallelism_permit).await;
    let cwd = repository.to_string_lossy();
    request(server.socket(), "401", "vcs.refreshStatus", json!({ "cwd": cwd })).await;
    let status = success_value(server.socket(), "401").await;
    let entries: Vec<_> = status["workingTree"]["files"]
        .as_array()
        .expect("file list")
        .iter()
        .filter(|file| file["path"] == "tracked.txt")
        .collect();
    assert_eq!(entries.len(), 1, "one entry per conflicted path: {entries:?}");
    assert_eq!(entries[0]["status"], "conflicted");
    assert_eq!(entries[0]["area"], "unstaged");
    assert_eq!(status["operationInProgress"], "merge");

    fs::write(repository.join("tracked.txt"), "resolved\n").expect("resolve");
    run_git_in(&repository, &["add", "tracked.txt"]);
    request(server.socket(), "402", "vcs.refreshStatus", json!({ "cwd": cwd })).await;
    let staged = success_value(server.socket(), "402").await;
    assert_eq!(staged["operationInProgress"], "merge");
    assert!(
        staged["workingTree"]["files"]
            .as_array()
            .expect("file list")
            .iter()
            .all(|file| file["status"] != "conflicted")
    );

    run_git_in(&repository, &["commit", "-q", "--no-edit"]);
    request(server.socket(), "403", "vcs.refreshStatus", json!({ "cwd": cwd })).await;
    let done = success_value(server.socket(), "403").await;
    assert!(done.get("operationInProgress").is_none());
}
```

(`commit_file` switches nothing; if `initialize_repository_in` names the default branch something other than the branch `switch -` returns to, the test still holds because it only uses `-`.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/server && CARGO_BUILD_JOBS=4 cargo test --test production_git_vcs_rpc status_reports_each_conflict_once -- --nocapture`
Expected: FAIL — two entries for `tracked.txt`.

- [ ] **Step 3: Implement**
  - `refs.rs`: `#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]` on `GitManagerInProgressKind` (add `Deserialize` to the `serde` import).
  - `model.rs` `VcsStatusLocalResult`, after `working_tree`:

```rust
    /// Repository operation left in progress; absent when none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation_in_progress: Option<crate::git::GitManagerInProgressKind>,
```

    Set `operation_in_progress: None` in `non_repository()` and every other struct literal of `VcsStatusLocalResult` the compiler reports.
  - `repository.rs` `observe_status`: replace the sequential `remotes` read with a join that also probes the operation (a failed probe degrades to `None`; status must not fail because of it):

```rust
        let (remotes, in_progress) = tokio::join!(
            self.execute_read(
                "GitVcsDriver.statusDetailsLocal.remotes",
                cwd,
                &strings(&["remote"]),
                true,
                cancellation,
            ),
            // ponytail: one `rev-parse --git-path` per status read; cache the resolved
            // paths per worktree if status reads become a measured hot spot.
            detect_in_progress_operation(self, cwd, cancellation),
        );
        let remotes = remotes?;
        let operation_in_progress = in_progress.ok().flatten().map(|operation| operation.kind);
```

    In the `for record in records` loop, before the `index_changed` branch:

```rust
            if record.unmerged {
                // One entry per conflicted path: staging it is how the user marks it resolved.
                let (insertions, deletions) =
                    unstaged_stats.get(&record.path).copied().unwrap_or((0, 0));
                files.push(VcsWorkingTreeFile {
                    path: record.path,
                    insertions,
                    deletions,
                    status: Some(VcsWorkingTreeFileStatus::Conflicted),
                    area: Some(VcsStagingArea::Unstaged),
                });
                continue;
            }
```

    and set `operation_in_progress,` in the returned `VcsStatusLocalResult`.
  - Add `"GitManager.getRefs.inProgressPaths"` to `EXPECTED_FUSED_OPERATIONS` (and any other repository unit-test list of status operations that the run reports as missing it). Also add an output for `GitManager.getRefs.inProgressPaths` to `RecordingGitRunner::status_fixture()` and `dirty_tracked_fixture()` (the runner panics on missing outputs): eleven lines of paths that do not exist under the sandbox, e.g. `(0..11).map(|i| format!(".git/bibcode-none-{i}")).collect::<Vec<_>>().join("\n")`, so the probe reports no operation. If a test compares an ordered list, place it where the recorded request order puts it (it runs concurrently with `statusDetailsLocal.remotes`; if order is nondeterministic, compare as a set in that test).

- [ ] **Step 4: Run focused tests**

Run: `cd apps/server && CARGO_BUILD_JOBS=4 cargo test --test production_git_vcs_rpc status_reports_each_conflict_once && CARGO_BUILD_JOBS=4 cargo test --lib git::`
Expected: PASS.

- [ ] **Step 5: Commit** (commit protocol), message `feat(server): report conflicted files once and the in-progress operation in vcs status`.

---

### Task 3: Validate Git Manager branch/sync operations under the worktree mutation guard

**Files:**
- Modify: `apps/server/src/git/manager/operations.rs:923-1009` (`run_branch_or_sync_operation`)
- Modify: `apps/server/tests/production_git_manager_rpc.rs` (`Fixture` keeps `broadcaster`)
- Test: `apps/server/tests/production_git_manager_rpc.rs`

**Interfaces:**
- Produces: every `runOperation` branch/sync operation holds `broadcaster.begin_mutation(cwd)` from snapshot through execution.

- [ ] **Step 1: Keep the broadcaster on the fixture** — add `broadcaster: StatusBroadcaster,` to `struct Fixture`. In `Fixture::build`, `GitManagerRpcServices::with_dependencies` already receives `broadcaster.clone()`; store the original in the returned `Self { _root: root, repository_path, remote_path, services, broadcaster }`.

- [ ] **Step 2: Write the failing test**

```rust
#[tokio::test]
async fn branch_operations_validate_after_taking_the_worktree_mutation_guard() {
    let fixture = Fixture::new().await;
    let cwd = fixture.repository_path.clone();
    git(&cwd, &["switch", "-q", "-c", "feature"]);
    fs::write(cwd.join("feature.txt"), "feature\n").expect("feature file");
    git(&cwd, &["add", "feature.txt"]);
    git(&cwd, &["commit", "-q", "-m", "feature"]);
    git(&cwd, &["switch", "-q", "main"]);
    let main_tip = git_stdout(&cwd, &["rev-parse", "main"]);

    let guard = fixture.broadcaster.begin_mutation(&cwd).await;
    let receiver = fixture.operation(
        "490",
        json!({ "_tag": "merge", "cwd": cwd, "projectId": "project-1",
                "source": "feature", "noVerify": false }),
    );
    tokio::time::sleep(Duration::from_millis(500)).await;
    // A vcs.* writer holding the guard dirties the tree before the merge may validate.
    fs::write(cwd.join("tracked.txt"), "dirty while waiting\n").expect("dirty tracked file");
    guard.finish().await;

    let events = collect_events(receiver).await;
    let last = events.last().expect("terminal event");
    assert_eq!(last["_tag"], "failed", "{events:?}");
    assert_eq!(last["code"], "dirty-working-tree", "{events:?}");
    assert_eq!(git_stdout(&cwd, &["rev-parse", "main"]), main_tip);
}
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd apps/server && CARGO_BUILD_JOBS=4 cargo test --test production_git_manager_rpc branch_operations_validate_after_taking`
Expected: FAIL — the merge finishes (validated against the clean snapshot taken before the guard).
If it unexpectedly PASSES, the operation stream may only start when polled: move `collect_events(receiver)` into `tokio::spawn` before `guard.finish()` and join it after the release, then re-run (the assertion stays the same).

- [ ] **Step 4: Implement** — inside the `try_with_project_mutation_lock_cancellation` closure, acquire the guard first and run the rest in an inner async block so every path finishes the guard:

```rust
        .try_with_project_mutation_lock_cancellation(&project_id, &cancellation, || async move {
            // vcs.* writes take this per-worktree guard but not the project lock, so it is
            // held from the snapshot onward: validation and execution see the same HEAD.
            let mutation = tokio::select! {
                biased;
                () = operation_cancellation.cancelled() => {
                    return Err(cancelled_error(operation));
                }
                mutation = locked_broadcaster.begin_mutation(locked_request.cwd()) => mutation,
            };
            let result = async {
                let mut snapshot = build_refs_snapshot(
                    &locked_repository,
                    locked_request.cwd(),
                    &operation_cancellation,
                )
                .await
                .map_err(|error| refs_snapshot_error(operation, error))?;
                snapshot.in_progress_operation = detect_in_progress_operation(
                    &locked_repository,
                    locked_request.cwd(),
                    &operation_cancellation,
                )
                .await
                .map_err(|_| {
                    operation_error(
                        operation,
                        "repository-state-unavailable",
                        "Git repository operation state could not be revalidated.",
                    )
                })?;
                if let Some(reason) = blocked_reason_for_operation(&snapshot, &locked_request) {
                    return Err(blocked_operation_error(operation, reason));
                }
                if operation_cancellation.is_cancelled() {
                    return Err(cancelled_error(operation));
                }
                execute_branch_or_sync_operation(
                    &locked_repository,
                    &snapshot,
                    &locked_request,
                    &operation_cancellation,
                )
                .await
            }
            .await;
            mutation.finish().await;
            result
        })
```

- [ ] **Step 5: Run focused and neighbouring tests**

Run: `cd apps/server && CARGO_BUILD_JOBS=4 cargo test --test production_git_manager_rpc`
Expected: PASS (the whole file — every operation path moved).

- [ ] **Step 6: Commit** (commit protocol), message `fix(server): validate Git Manager operations under the worktree mutation guard`.

---

### Task 4: Git version gate and hardened merge-tree classification (preview)

**Files:**
- Create: `apps/server/src/git/version.rs`
- Modify: `apps/server/src/git/mod.rs` (`mod version; pub use version::GitVersion;`)
- Modify: `apps/server/src/git/repository.rs` (field `git_version`, constructors, `git_manager_git_version`, `git_manager_merge_tree` gains `attr_source`)
- Modify: `apps/server/src/git/manager/merge.rs` (classification, preview `target`, errors)
- Modify: `apps/server/src/git/manager/mod.rs:92-450` (register the new read in the non-interactive test)
- Modify: `apps/server/src/production/git_manager_rpc.rs:1150-1154, ~421, 1704-1727` (preview input `target`, error mapping)
- Test: unit tests in `version.rs` and `merge.rs`; `apps/server/tests/production_git_manager_rpc.rs`

**Interfaces:**
- Produces:
  - `GitVersion { major: u32, minor: u32, patch: u32 }` with `GitVersion::parse(&str) -> Option<GitVersion>`, consts `MERGE_TREE_WRITE` (2.38.0) and `MERGE_TREE_ATTR_SOURCE` (2.43.0), `Display` as `2.34.1`.
  - `GitRepository::git_manager_git_version(&self, cwd: &Path, cancellation) -> Result<Option<GitVersion>, GitCommandError>` (cached per repository; `None` when unparseable).
  - `GitRepository::git_manager_merge_tree(cwd, ours_tip, theirs_tip, attr_source: Option<&str>, cancellation)`.
  - `merge::classify_merge_tree(exit_code: i32, stdout: &str, stderr: &str) -> Result<GitManagerMergePreview, GitManagerMergeError>`.
  - `merge::merge_tree_tree_oid(stdout: &str) -> Option<&str>`.
  - `merge::ensure_merge_tree_supported(repository, cwd, cancellation) -> Result<Option<GitVersion>, GitManagerMergeError>`.
  - `merge::preview(repository, cwd, source, target: Option<&str>, cancellation)`.
  - `GitManagerMergeError::{InvalidTarget, GitTooOld { found: GitVersion }, MergeTreeFailed}`.

- [ ] **Step 1: Write failing unit tests** — `apps/server/src/git/version.rs`:

```rust
//! Parsed `git --version` output for feature gating.

use std::fmt;

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct GitVersion {
    pub major: u32,
    pub minor: u32,
    pub patch: u32,
}

impl GitVersion {
    /// `git merge-tree --write-tree`.
    pub const MERGE_TREE_WRITE: Self = Self { major: 2, minor: 38, patch: 0 };
    /// `git --attr-source` combined with merge-tree (2.43 fixed a crash).
    pub const MERGE_TREE_ATTR_SOURCE: Self = Self { major: 2, minor: 43, patch: 0 };

    #[must_use]
    pub fn parse(output: &str) -> Option<Self> {
        todo!()
    }
}

impl fmt::Display for GitVersion {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}.{}.{}", self.major, self.minor, self.patch)
    }
}

#[cfg(test)]
mod tests {
    use super::GitVersion;

    fn version(major: u32, minor: u32, patch: u32) -> GitVersion {
        GitVersion { major, minor, patch }
    }

    #[test]
    fn parses_release_vendor_and_windows_builds() {
        assert_eq!(GitVersion::parse("git version 2.34.1\n"), Some(version(2, 34, 1)));
        assert_eq!(
            GitVersion::parse("git version 2.50.1 (Apple Git-155)"),
            Some(version(2, 50, 1))
        );
        assert_eq!(GitVersion::parse("git version 2.55.0.windows.1"), Some(version(2, 55, 0)));
        assert_eq!(GitVersion::parse("git version 2.38"), Some(version(2, 38, 0)));
    }

    #[test]
    fn rejects_unrecognised_output() {
        assert_eq!(GitVersion::parse(""), None);
        assert_eq!(GitVersion::parse("hub version 2.14.2"), None);
    }

    #[test]
    fn orders_against_feature_floors() {
        assert!(version(2, 34, 1) < GitVersion::MERGE_TREE_WRITE);
        assert!(version(2, 39, 5) >= GitVersion::MERGE_TREE_WRITE);
        assert!(version(2, 39, 5) < GitVersion::MERGE_TREE_ATTR_SOURCE);
        assert_eq!(version(2, 34, 1).to_string(), "2.34.1");
    }
}
```

Add to `apps/server/src/git/mod.rs`: `mod version;` and `pub use version::GitVersion;`.

In `merge.rs` add `use crate::git::GitVersion;` to the imports, and replace the three existing `parse_merge_tree_preview` tests with:

```rust
    const TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

    #[test]
    fn classifies_a_clean_merge_tree() {
        assert_eq!(
            classify_merge_tree(0, &format!("{TREE}\0"), "").expect("clean"),
            GitManagerMergePreview::Clean
        );
        assert_eq!(merge_tree_tree_oid(&format!("{TREE}\0")), Some(TREE));
    }

    #[test]
    fn counts_conflicted_files_after_the_tree_record() {
        assert_eq!(
            classify_merge_tree(1, &format!("{TREE}\0first.txt\0second.txt\0"), "")
                .expect("conflicted"),
            GitManagerMergePreview::Conflicted { file_count: 2 }
        );
    }

    #[test]
    fn exit_one_without_a_tree_is_a_failure_not_a_conflict() {
        assert!(matches!(
            classify_merge_tree(1, "", "fatal: unknown ref"),
            Err(GitManagerMergeError::MergeTreeFailed { detail }) if detail == "fatal: unknown ref"
        ));
    }

    #[test]
    fn only_gits_unrelated_histories_refusal_is_unrelated() {
        assert_eq!(
            classify_merge_tree(128, "", "fatal: refusing to merge unrelated histories\n")
                .expect("unrelated"),
            GitManagerMergePreview::UnrelatedHistories
        );
        assert!(matches!(
            classify_merge_tree(129, "", "usage: git merge-tree [--write-tree]"),
            Err(GitManagerMergeError::MergeTreeFailed { .. })
        ));
    }
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/server && CARGO_BUILD_JOBS=4 cargo test --lib git::` (cargo accepts one filter; `git::` covers both modules)
Expected: FAIL (`todo!()` panics; `classify_merge_tree` missing).

- [ ] **Step 3: Implement `GitVersion::parse`**

```rust
    #[must_use]
    pub fn parse(output: &str) -> Option<Self> {
        let token = output.trim().strip_prefix("git version ")?.split_whitespace().next()?;
        let mut parts = token.split('.');
        let mut number = |required: bool| -> Option<u32> {
            match parts.next() {
                Some(part) => {
                    let digits: String = part.chars().take_while(char::is_ascii_digit).collect();
                    digits.parse().ok()
                }
                None if required => None,
                None => Some(0),
            }
        };
        Some(Self { major: number(true)?, minor: number(true)?, patch: number(false)? })
    }
```

- [ ] **Step 4: Implement classification and preview** in `merge.rs`:

```rust
#[derive(Debug, Error)]
pub enum GitManagerMergeError {
    #[error("the merge source is invalid")]
    InvalidSource,
    #[error("the merge target is invalid")]
    InvalidTarget,
    #[error("the current HEAD is unavailable")]
    CurrentUnavailable,
    #[error("Git returned malformed merge comparison state")]
    MalformedComparison,
    #[error("Git {found} cannot compute merges without a checkout")]
    GitTooOld { found: GitVersion },
    /// First non-empty stderr line, shown to the user so the failure can be diagnosed.
    #[error("git merge-tree failed: {detail}")]
    MergeTreeFailed { detail: String },
    #[error(transparent)]
    Git(#[from] GitCommandError),
}

/// The first `-z` record of `merge-tree --write-tree` output, when it is an object id.
#[must_use]
pub fn merge_tree_tree_oid(stdout: &str) -> Option<&str> {
    let first = stdout.split(['\0', '\n']).next()?.trim();
    (matches!(first.len(), 40 | 64) && first.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .then_some(first)
}

/// Exit 1 means conflicts only when Git still printed the merged tree; an unknown ref
/// also exits 1. Only Git's own refusal is reported as unrelated histories.
pub fn classify_merge_tree(
    exit_code: i32,
    stdout: &str,
    stderr: &str,
) -> Result<GitManagerMergePreview, GitManagerMergeError> {
    match exit_code {
        0 if merge_tree_tree_oid(stdout).is_some() => Ok(GitManagerMergePreview::Clean),
        1 if merge_tree_tree_oid(stdout).is_some() => Ok(GitManagerMergePreview::Conflicted {
            file_count: stdout.matches('\0').count().saturating_sub(1) as u64,
        }),
        128 if stderr.contains("refusing to merge unrelated histories") => {
            Ok(GitManagerMergePreview::UnrelatedHistories)
        }
        _ => Err(GitManagerMergeError::MergeTreeFailed {
            detail: stderr
                .lines()
                .map(str::trim)
                .find(|line| !line.is_empty())
                .map_or_else(|| format!("merge-tree exited with {exit_code}"), str::to_owned),
        }),
    }
}

/// Fails with `GitTooOld` below 2.38; an unparseable version is allowed through and the
/// merge-tree classifier reports any failure.
pub async fn ensure_merge_tree_supported(
    repository: &GitRepository,
    cwd: &Path,
    cancellation: &CancellationToken,
) -> Result<Option<GitVersion>, GitManagerMergeError> {
    let version = repository.git_manager_git_version(cwd, cancellation).await?;
    match version {
        Some(found) if found < GitVersion::MERGE_TREE_WRITE => {
            Err(GitManagerMergeError::GitTooOld { found })
        }
        _ => Ok(version),
    }
}

fn valid_revision(value: &str) -> bool {
    !value.is_empty() && value.trim() == value && !value.starts_with('-')
}
```

Delete `parse_merge_tree_preview`. Rewrite `preview` to take `target: Option<&str>`:

```rust
pub async fn preview(
    repository: &GitRepository,
    cwd: &Path,
    source: &str,
    target: Option<&str>,
    cancellation: &CancellationToken,
) -> Result<GitManagerMergePreviewResult, GitManagerMergeError> {
    if !valid_revision(source) {
        return Err(GitManagerMergeError::InvalidSource);
    }
    if target.is_some_and(|target| !valid_revision(target)) {
        return Err(GitManagerMergeError::InvalidTarget);
    }
    let version = ensure_merge_tree_supported(repository, cwd, cancellation).await?;
    // A tag named like the branch must not shadow the target.
    let ours_revision = target.map_or_else(|| "HEAD".to_owned(), |name| format!("refs/heads/{name}"));
    let (ours, theirs, current_ref) = tokio::try_join!(
        repository.git_manager_resolve_merge_tip(cwd, &ours_revision, cancellation),
        repository.git_manager_resolve_merge_tip(cwd, source, cancellation),
        repository.git_manager_head_ref(cwd, cancellation),
    )?;
    let ours_tip = successful_tip(&ours).ok_or(if target.is_some() {
        GitManagerMergeError::InvalidTarget
    } else {
        GitManagerMergeError::CurrentUnavailable
    })?;
    let theirs_tip = successful_tip(&theirs).ok_or(GitManagerMergeError::InvalidSource)?;
    let attr_source = (target.is_some()
        && version.is_some_and(|version| version >= GitVersion::MERGE_TREE_ATTR_SOURCE))
    .then_some(ours_tip);
    let (merge_tree, counts) = tokio::try_join!(
        repository.git_manager_merge_tree(cwd, ours_tip, theirs_tip, attr_source, cancellation),
        repository.git_manager_merge_ahead_behind(cwd, ours_tip, theirs_tip, cancellation),
    )?;
    let (behind, ahead) = parse_ahead_behind(&counts.stdout)?;
    let current = match target {
        Some(name) => name.to_owned(),
        None => (current_ref.exit_code == 0)
            .then(|| current_ref.stdout.trim().to_owned())
            .filter(|current| !current.is_empty())
            .unwrap_or_else(|| ours_tip.to_owned()),
    };
    Ok(GitManagerMergePreviewResult {
        preview: classify_merge_tree(merge_tree.exit_code, &merge_tree.stdout, &merge_tree.stderr)?,
        source: source.to_owned(),
        current,
        ahead,
        behind,
    })
}
```

(`ProcessOutput` exposes `stderr`; if the field name differs, use the one `require_last_success` reads.)

- [ ] **Step 5: Repository changes** (`repository.rs`):
  - Field on `GitRepository`: `git_version: Arc<Mutex<Option<crate::git::GitVersion>>>,` initialised `Arc::new(Mutex::new(None))` next to every `worktree_porcelain_z_supported: Arc::new(Mutex::new(None)),` (Default, `with_worktree_settings`, `with_runner_for_test`, and any other constructor the compiler lists).
  - Method:

```rust
    /// `git --version`, read once per repository value and cached; `None` when unparseable.
    pub(crate) async fn git_manager_git_version(
        &self,
        cwd: &Path,
        cancellation: &CancellationToken,
    ) -> Result<Option<crate::git::GitVersion>, GitCommandError> {
        if let Some(version) = *self.git_version.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) {
            return Ok(Some(version));
        }
        let output = self
            .git_manager_bounded_read(
                "GitManager.gitVersion",
                cwd,
                &strings(&["--version"]),
                true,
                4 * 1024,
                cancellation,
            )
            .await?;
        let version = crate::git::GitVersion::parse(&output.stdout);
        if let Some(version) = version {
            *self.git_version.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(version);
        }
        Ok(version)
    }
```

  - `git_manager_merge_tree` gains `attr_source: Option<&str>`: build `let mut args = Vec::new(); if let Some(tree) = attr_source { args.push(format!("--attr-source={tree}")); }` then extend with the existing `merge-tree …` arguments.
  - `manager/mod.rs` non-interactive test: add `repository.git_manager_git_version(cwd, &cancellation).await.expect("git version read");` and update the existing `git_manager_merge_tree` call (if any) to pass `None`.

- [ ] **Step 6: RPC wiring** (`production/git_manager_rpc.rs`):

```rust
#[derive(Deserialize)]
struct GitManagerPreviewMergeInput {
    cwd: PathBuf,
    source: String,
    #[serde(default)]
    target: Option<String>,
}
```

  Call `merge::preview(&self.repository, &input.cwd, &input.source, input.target.as_deref(), &cancellation)`. In `merge_error` add:

```rust
        GitManagerMergeError::InvalidTarget => operation_error(
            operation,
            "local-branch-not-found",
            "The merge target branch no longer exists; refresh the repository refs.",
        ),
        GitManagerMergeError::GitTooOld { found } => operation_error(
            operation,
            "git-too-old",
            &format!("Merge preview needs Git 2.38 or later on this environment (found {found})."),
        ),
        GitManagerMergeError::MergeTreeFailed { detail } => operation_error(
            operation,
            "merge-tree-failed",
            &format!("Git could not compute the merge preview: {detail}"),
        ),
```

- [ ] **Step 7: Integration test for preview with a target** — add to `production_git_manager_rpc.rs`:

```rust
#[tokio::test]
async fn merge_preview_compares_against_a_named_target_branch() {
    let fixture = Fixture::new().await;
    let cwd = fixture.repository_path.clone();
    git(&cwd, &["branch", "target"]);
    git(&cwd, &["switch", "-q", "-c", "feature"]);
    fs::write(cwd.join("feature.txt"), "feature\n").expect("feature file");
    git(&cwd, &["add", "feature.txt"]);
    git(&cwd, &["commit", "-q", "-m", "feature"]);
    git(&cwd, &["switch", "-q", "main"]);
    // A tag named like the target must not shadow the branch.
    git(&cwd, &["tag", "target", "feature"]);

    let preview = fixture
        .read(
            "34",
            "gitManager.previewMerge",
            json!({ "cwd": cwd, "source": "refs/heads/feature", "target": "target" }),
        )
        .await
        .expect("merge preview");

    assert_eq!(preview["_tag"], "clean");
    assert_eq!(preview["current"], "target");
    assert_eq!(preview["ahead"], 1);
}
```

- [ ] **Step 8: Run**

Run: `cd apps/server && CARGO_BUILD_JOBS=4 cargo test --lib git:: && CARGO_BUILD_JOBS=4 cargo test --test production_git_manager_rpc merge_preview`
Expected: PASS.

- [ ] **Step 9: Commit** (commit protocol), message `feat(server): gate merge previews on Git 2.38 and classify merge-tree failures`.

---

### Task 5: `merge-into` contract, preview target, and capability (TypeScript)

**Files:**
- Modify: `packages/contracts/src/gitManager.ts` (operation union after `squash-merge` ~270; `GitManagerPreviewMergeInput` ~407)
- Modify: `packages/contracts/src/environment.ts:45` (capability)
- Modify: `packages/shared/src/testSupport.ts:19` (capability default in test config)
- Test: `packages/contracts/src/gitManager.test.ts`, `packages/contracts/src/environment.test.ts`

**Interfaces:**
- Produces: request `{ _tag: "merge-into", cwd, projectId, source, target }`; preview input `{ cwd, source, target? }`; `capabilities.gitManagerMergeIntoOperations: boolean`.

- [ ] **Step 1: Failing tests** — in `gitManager.test.ts` add `{ ...base, _tag: "merge-into", source: "refs/heads/topic", target: "main" }` to the operations list (expected tag `"merge-into"` at the same index), and:

```ts
  it("decodes a merge preview input with and without a target", () => {
    const decode = Schema.decodeUnknownSync(GitManagerPreviewMergeInput);
    expect(decode({ cwd: "/repo", source: "topic" })).toEqual({ cwd: "/repo", source: "topic" });
    expect(decode({ cwd: "/repo", source: "topic", target: "release" })).toEqual({
      cwd: "/repo",
      source: "topic",
      target: "release",
    });
  });
```

In `environment.test.ts` add `"gitManagerMergeIntoOperations"` to the capability list at line ~20 (follow how that list is asserted).

- [ ] **Step 2: Run to verify failure** — `node scripts/run-local-vp.mjs test run packages/contracts/src/gitManager.test.ts packages/contracts/src/environment.test.ts` → FAIL.

- [ ] **Step 3: Implement**

```ts
  Schema.TaggedStruct("merge-into", {
    ...GitManagerOperationBase.fields,
    /** Full ref: `refs/heads/<name>` or `refs/remotes/<remote>/<name>`. */
    source: TrimmedNonEmptyStringSchema,
    /** Local branch updated without checking it out. */
    target: TrimmedNonEmptyStringSchema,
  }),
```

```ts
export const GitManagerPreviewMergeInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  source: TrimmedNonEmptyStringSchema,
  /** Compare against this local branch instead of HEAD; servers without merge-into ignore it. */
  target: Schema.optionalKey(TrimmedNonEmptyStringSchema),
});
```

`environment.ts`, after `gitManagerStashMergeOperations`:

```ts
  gitManagerMergeIntoOperations: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
```

`testSupport.ts`: `gitManagerMergeIntoOperations: false,`.

- [ ] **Step 4: Run** — the two test files, then `node scripts/run-local-vp.mjs run typecheck` and `node scripts/run-local-vp.mjs run check:contracts` (commit any regenerated fixtures it reports) → PASS.

- [ ] **Step 5: Commit** (commit protocol), message `feat(contracts): add merge-into operation, preview target, and capability`.

---

### Task 6: Server `merge-into` operation

**Files:**
- Modify: `apps/server/src/git/manager/operations.rs` (enum variant ~370, exhaustive methods ~450-597, `blocked_reason_for_operation` ~1011, execute arm ~1325, unit tests)
- Modify: `apps/server/src/git/manager/guards.rs` (`MUTATING_OPERATIONS`; `add_worktree_occupancy_reasons`)
- Modify: `apps/server/src/git/manager/merge.rs` (`merge_into`, `merge_into_message`, `classify_publish_failure`)
- Modify: `apps/server/src/git/repository.rs` (new `git_manager_*` methods)
- Modify: `apps/server/src/git/manager/mod.rs` (non-interactive test registration)
- Modify: `apps/server/src/production/control.rs:2410, 6314` (capability + its test list)
- Test: `apps/server/tests/production_git_manager_rpc.rs`, unit tests in `merge.rs` and `operations.rs`

**Interfaces:**
- Consumes: Task 4 `ensure_merge_tree_supported`, `classify_merge_tree`, `merge_tree_tree_oid`, `GitVersion`, `git_manager_merge_tree(.., attr_source, ..)`; Task 3 admission order.
- Produces: `GitManagerOperationRequest::MergeInto { cwd, project_id, source, target }`; wire events `finished` ("Merged `<source>` into `<target>`." / "Already up to date.") or `failed` with the codes in Global Constraints.

- [ ] **Step 1: Repository methods** (`repository.rs`, beside `git_manager_merge`):

```rust
    pub(crate) async fn git_manager_is_ancestor(
        &self,
        cwd: &Path,
        ancestor: &str,
        descendant: &str,
        cancellation: &CancellationToken,
    ) -> Result<ProcessOutput, GitCommandError> {
        self.git_manager_bounded_read(
            "GitManager.mergeInto.isAncestor",
            cwd,
            &["merge-base".into(), "--is-ancestor".into(), ancestor.into(), descendant.into()],
            true,
            4 * 1024,
            cancellation,
        )
        .await
    }

    /// `commit.gpgSign`; commit-tree ignores it, so callers pass `-S` themselves.
    pub(crate) async fn git_manager_commit_gpg_sign(
        &self,
        cwd: &Path,
        cancellation: &CancellationToken,
    ) -> Result<bool, GitCommandError> {
        let output = self
            .git_manager_bounded_read(
                "GitManager.mergeInto.gpgSign",
                cwd,
                &strings(&["config", "--bool", "--get", "commit.gpgSign"]),
                true,
                4 * 1024,
                cancellation,
            )
            .await?;
        Ok(output.exit_code == 0 && output.stdout.trim() == "true")
    }

    pub(crate) async fn git_manager_commit_tree(
        &self,
        cwd: &Path,
        tree: &str,
        parents: [&str; 2],
        message: &str,
        sign: bool,
        cancellation: &CancellationToken,
    ) -> Result<ProcessOutput, GitCommandError> {
        let mut args = vec!["commit-tree".to_owned()];
        if sign {
            args.push("-S".to_owned());
        }
        args.extend([
            tree.to_owned(),
            "-p".to_owned(),
            parents[0].to_owned(),
            "-p".to_owned(),
            parents[1].to_owned(),
            "-F".to_owned(),
            "-".to_owned(),
        ]);
        self.execute_with_stdin(
            "GitManager.mergeInto.commitTree",
            cwd,
            &args,
            message.as_bytes().to_vec(),
            true,
            cancellation,
        )
        .await
    }

    /// Fast-forward-only publish: Git refuses a branch checked out, rebased, or bisected
    /// in any worktree, which `update-ref` would not (docs/architecture/overview.md).
    pub(crate) async fn git_manager_publish_merge(
        &self,
        cwd: &Path,
        commit: &str,
        target: &str,
        source: &str,
        cancellation: &CancellationToken,
    ) -> Result<ProcessOutput, GitCommandError> {
        let mut environment = git_environment();
        environment.push(("GIT_REFLOG_ACTION".into(), format!("merge-into {source}").into()));
        self.execute_with_environment(
            "GitManager.mergeInto.publish",
            cwd,
            &[
                "-c".into(),
                "maintenance.auto=false".into(),
                "-c".into(),
                "fetch.writeCommitGraph=false".into(),
                "fetch".into(),
                "--no-tags".into(),
                "--no-prune".into(),
                "--no-recurse-submodules".into(),
                "--no-write-fetch-head".into(),
                "--quiet".into(),
                ".".into(),
                format!("{commit}:refs/heads/{target}"),
            ],
            GitExecutionOptions {
                allow_non_zero_exit: true,
                max_output_bytes: DEFAULT_OUTPUT_LIMIT,
                output_policy: OutputPolicy::Truncate,
            },
            environment,
            cancellation,
        )
        .await
    }
```

Register all four in the non-interactive test in `manager/mod.rs` (e.g. `git_manager_commit_tree(cwd, SHA, [SHA, PARENT_SHA], "Merge", false, &cancellation)`).

- [ ] **Step 2: Failing unit tests for the pure helpers** (`merge.rs` tests):

```rust
    #[test]
    fn merge_into_message_names_local_and_remote_sources() {
        assert_eq!(
            merge_into_message("refs/heads/feature", "release"),
            "Merge branch 'feature' into release"
        );
        assert_eq!(
            merge_into_message("refs/remotes/origin/feature", "release"),
            "Merge remote-tracking branch 'origin/feature' into release"
        );
    }

    #[test]
    fn classifies_publish_refusals() {
        assert_eq!(
            classify_publish_failure(
                "fatal: refusing to fetch into branch 'refs/heads/t' checked out at '/w/t'\n"
            ),
            PublishFailure::InUse { path: Some("/w/t".into()) }
        );
        assert_eq!(
            classify_publish_failure(" ! [rejected]        abc -> t  (non-fast-forward)\n"),
            PublishFailure::Moved
        );
        assert_eq!(
            classify_publish_failure("fatal: reference-transaction hook declined\n"),
            PublishFailure::Other
        );
    }
```

- [ ] **Step 3: Implement `merge.rs` additions**

```rust
#[derive(Debug, Eq, PartialEq)]
pub enum PublishFailure {
    InUse { path: Option<String> },
    Moved,
    Other,
}

#[must_use]
pub fn classify_publish_failure(stderr: &str) -> PublishFailure {
    if let Some(rest) = stderr.split("checked out at '").nth(1) {
        return PublishFailure::InUse { path: rest.split('\'').next().map(str::to_owned) };
    }
    if stderr.contains("refusing to fetch into branch") {
        return PublishFailure::InUse { path: None };
    }
    if stderr.contains("non-fast-forward") || stderr.contains("[rejected]") {
        return PublishFailure::Moved;
    }
    PublishFailure::Other
}

#[must_use]
pub fn merge_into_message(source: &str, target: &str) -> String {
    match source.strip_prefix("refs/remotes/") {
        Some(remote) => format!("Merge remote-tracking branch '{remote}' into {target}"),
        None => format!(
            "Merge branch '{}' into {target}",
            source.strip_prefix("refs/heads/").unwrap_or(source)
        ),
    }
}

#[derive(Debug)]
pub enum MergeIntoError {
    Merge(GitManagerMergeError),
    TargetMissing,
    Conflicts { file_count: u64 },
    UnrelatedHistories,
    CommitFailed(ProcessOutput),
    TargetMoved,
    InUse { path: Option<String> },
    PublishFailed(ProcessOutput),
}

impl From<GitCommandError> for MergeIntoError {
    fn from(error: GitCommandError) -> Self {
        Self::Merge(GitManagerMergeError::Git(error))
    }
}

pub struct MergeIntoOutcome {
    pub outputs: Vec<ProcessOutput>,
    pub up_to_date: bool,
}

pub async fn merge_into(
    repository: &GitRepository,
    cwd: &Path,
    source: &str,
    target: &str,
    cancellation: &CancellationToken,
) -> Result<MergeIntoOutcome, MergeIntoError> {
    let version = ensure_merge_tree_supported(repository, cwd, cancellation)
        .await
        .map_err(MergeIntoError::Merge)?;
    let target_ref = format!("refs/heads/{target}");
    let (target_tip, source_tip) = tokio::try_join!(
        repository.git_manager_resolve_merge_tip(cwd, &target_ref, cancellation),
        repository.git_manager_resolve_merge_tip(cwd, source, cancellation),
    )?;
    let target_tip = successful_tip(&target_tip).ok_or(MergeIntoError::TargetMissing)?.to_owned();
    let source_tip = successful_tip(&source_tip)
        .ok_or(MergeIntoError::Merge(GitManagerMergeError::InvalidSource))?
        .to_owned();
    if repository
        .git_manager_is_ancestor(cwd, &source_tip, &target_tip, cancellation)
        .await?
        .exit_code
        == 0
    {
        return Ok(MergeIntoOutcome { outputs: Vec::new(), up_to_date: true });
    }
    let attr_source = version
        .is_some_and(|version| version >= GitVersion::MERGE_TREE_ATTR_SOURCE)
        .then_some(target_tip.as_str());
    let merge_tree = repository
        .git_manager_merge_tree(cwd, &target_tip, &source_tip, attr_source, cancellation)
        .await?;
    let tree = match classify_merge_tree(merge_tree.exit_code, &merge_tree.stdout, &merge_tree.stderr)
        .map_err(MergeIntoError::Merge)?
    {
        GitManagerMergePreview::Clean => merge_tree_tree_oid(&merge_tree.stdout)
            .ok_or_else(|| {
                MergeIntoError::Merge(GitManagerMergeError::MergeTreeFailed {
                    detail: "merge-tree printed no tree".to_owned(),
                })
            })?
            .to_owned(),
        GitManagerMergePreview::Conflicted { file_count } => {
            return Err(MergeIntoError::Conflicts { file_count });
        }
        GitManagerMergePreview::UnrelatedHistories => return Err(MergeIntoError::UnrelatedHistories),
    };
    let sign = repository.git_manager_commit_gpg_sign(cwd, cancellation).await?;
    let commit = repository
        .git_manager_commit_tree(
            cwd,
            &tree,
            [&target_tip, &source_tip],
            &merge_into_message(source, target),
            sign,
            cancellation,
        )
        .await?;
    if commit.exit_code != 0 {
        return Err(MergeIntoError::CommitFailed(commit));
    }
    let merge_commit = commit.stdout.trim().to_owned();
    let reread = repository.git_manager_resolve_merge_tip(cwd, &target_ref, cancellation).await?;
    if successful_tip(&reread) != Some(target_tip.as_str()) {
        return Err(MergeIntoError::TargetMoved);
    }
    let publish = repository
        .git_manager_publish_merge(cwd, &merge_commit, target, source, cancellation)
        .await?;
    if publish.exit_code != 0 {
        return Err(match classify_publish_failure(&publish.stderr) {
            PublishFailure::InUse { path } => MergeIntoError::InUse { path },
            PublishFailure::Moved => MergeIntoError::TargetMoved,
            PublishFailure::Other => MergeIntoError::PublishFailed(publish),
        });
    }
    Ok(MergeIntoOutcome { outputs: vec![commit, publish], up_to_date: false })
}
```


- [ ] **Step 4: Operation variant and guards** (`operations.rs`, `guards.rs`)
  - Enum variant after `SquashMerge`:

```rust
    MergeInto {
        cwd: PathBuf,
        project_id: String,
        source: String,
        target: String,
    },
```

  - `operation()`: `Self::MergeInto { .. } => "merge-into",`; add `| Self::MergeInto { cwd, .. }` to `cwd()`, `| Self::MergeInto { project_id, .. }` to `project_id()`, `| Self::MergeInto { .. }` to `is_implemented_through_phase_16()`. `changes_worktree_heads()` stays `true` for it (not in the exclusion list).
  - `blocked_reason_for_operation`, after the `Merge | SquashMerge` arm:

```rust
        GitManagerOperationRequest::MergeInto { target, .. } => {
            (Some(target.as_str()), "merge-into")
        }
```

  - `guards.rs`: add `"merge-into",` to `MUTATING_OPERATIONS` (alphabetical, after `"merge"`). In `add_worktree_occupancy_reasons` change `for operation in ["fetch", "pull"]` to `for operation in ["fetch", "pull", "merge-into"]` (appended after the existing reasons; the dirty-tree list is unchanged, so a dirty selected worktree never blocks `merge-into`). Add `"merge-into"` to the exact expected operation set in the existing `missing_worktree_directory_still_holds_the_branch_for_all_occupancy_guards` test (and any other exact occupancy set the run reports).
  - Execute arm, after `SquashMerge`:

```rust
        GitManagerOperationRequest::MergeInto {
            cwd, source, target, ..
        } => {
            validate_merge_source(operation, source)?;
            validate_revision(operation, target)?;
            if snapshot.head_ref.as_deref() == Some(target.as_str()) {
                return Err(operation_error(
                    operation,
                    "target-is-current",
                    "This branch is checked out here; use Merge into the current branch instead.",
                ));
            }
            if !snapshot.local_branches.iter().any(|branch| branch.name == *target) {
                return Err(local_branch_not_found(operation));
            }
            let outcome = merge::merge_into(repository, cwd, source, target, cancellation)
                .await
                .map_err(|error| merge_into_error(operation, target, error))?;
            let label = source
                .strip_prefix("refs/heads/")
                .or_else(|| source.strip_prefix("refs/remotes/"))
                .unwrap_or(source);
            return Ok(GitManagerOperationOutcome {
                operation: operation.to_owned(),
                message: if outcome.up_to_date {
                    "Already up to date.".to_owned()
                } else {
                    format!("Merged {label} into {target}.")
                },
                outputs: outcome.outputs,
            });
        }
```

  - Helpers (near `operation_error`):

```rust
fn local_branch_not_found(operation: &str) -> GitManagerOperationError {
    operation_error(
        operation,
        "local-branch-not-found",
        "The target branch no longer exists; refresh the repository refs.",
    )
}

fn first_stderr_line(output: &ProcessOutput) -> &str {
    output.stderr.lines().map(str::trim).find(|line| !line.is_empty()).unwrap_or("")
}

fn merge_into_error(
    operation: &str,
    target: &str,
    error: merge::MergeIntoError,
) -> GitManagerOperationError {
    use merge::{GitManagerMergeError, MergeIntoError};
    match error {
        MergeIntoError::Merge(GitManagerMergeError::GitTooOld { found }) => operation_error(
            operation,
            "git-too-old",
            &format!(
                "Merging into another branch needs Git 2.38 or later on this environment (found {found})."
            ),
        ),
        MergeIntoError::Merge(GitManagerMergeError::Git(error)) => {
            git_command_error(operation, error, Vec::new())
        }
        MergeIntoError::Merge(GitManagerMergeError::InvalidSource) => operation_error(
            operation,
            "invalid-merge-source",
            "The requested merge source could not be resolved.",
        ),
        MergeIntoError::Merge(GitManagerMergeError::MergeTreeFailed { detail }) => operation_error(
            operation,
            "unknown",
            &format!("Git could not compute the merge: {detail}"),
        ),
        MergeIntoError::Merge(_) => operation_error(
            operation,
            "unknown",
            "Git could not compute the merge.",
        ),
        MergeIntoError::TargetMissing => local_branch_not_found(operation),
        MergeIntoError::Conflicts { file_count } => operation_error(
            operation,
            "conflicts",
            &format!(
                "{file_count} files would conflict. Check out {target} and merge there to resolve them."
            ),
        ),
        MergeIntoError::UnrelatedHistories => operation_error(
            operation,
            "unrelated-histories",
            "These branches have unrelated histories and cannot be merged.",
        ),
        MergeIntoError::TargetMoved => operation_error(
            operation,
            "non-fast-forward",
            &format!("{target} changed while merging. Review the preview and try again."),
        ),
        MergeIntoError::InUse { path } => blocked_operation_error(
            operation,
            GitManagerBlockedReason {
                operation: operation.to_owned(),
                code: "worktree-checked-out".to_owned(),
                message: path.map_or_else(
                    || "Cannot update this branch: Git reports it is in use by another worktree."
                        .to_owned(),
                    |path| format!("Cannot update this branch: it is checked out in the worktree at {path}."),
                ),
            },
        ),
        MergeIntoError::CommitFailed(output) => GitManagerOperationError {
            operation: operation.to_owned(),
            code: "unknown".to_owned(),
            message: format!("Git could not create the merge commit: {}", first_stderr_line(&output)),
            blocked: None,
            outputs: vec![output],
        },
        MergeIntoError::PublishFailed(output) => GitManagerOperationError {
            operation: operation.to_owned(),
            code: "unknown".to_owned(),
            message: format!("Git could not update {target}: {}", first_stderr_line(&output)),
            blocked: None,
            outputs: vec![output],
        },
    }
}
```

  (`GitManagerBlockedReason` construction: match the field types the existing `ProjectMutationAttempt::InFlight` arm uses.)

- [ ] **Step 5: Guard unit tests** (`operations.rs` tests, modelled on `rebase_guard_revalidation_blocks_a_target_held_by_another_worktree`):

```rust
    fn merge_into_snapshot(worktree_path: Option<&str>, dirty: bool) -> crate::git::GitManagerRefsSnapshot {
        crate::git::GitManagerRefsSnapshot {
            generation: 1,
            head_ref: Some("main".into()),
            detached_sha: None,
            is_dirty: dirty,
            default_branch: Some("main".into()),
            remotes: Vec::new(),
            local_branches: vec![crate::git::GitManagerRefEntry {
                name: "release".into(),
                tip_sha: "0123456789012345678901234567890123456789".into(),
                upstream: None,
                ahead: 0,
                behind: 0,
                current: false,
                is_default: false,
                worktree_path: worktree_path.map(Into::into),
                blocked: Vec::new(),
            }],
            remote_branches: Vec::new(),
            tags: Vec::new(),
            worktrees: Vec::new(),
            in_progress_operation: None,
            conflicted_paths: Vec::new(),
        }
    }

    fn merge_into_request() -> GitManagerOperationRequest {
        GitManagerOperationRequest::MergeInto {
            cwd: PathBuf::from("/repo"),
            project_id: "project-1".into(),
            source: "refs/heads/feature".into(),
            target: "release".into(),
        }
    }

    #[test]
    fn merge_into_blocks_a_target_held_by_another_worktree() {
        let reason = blocked_reason_for_operation(
            &merge_into_snapshot(Some("/repo/release-worktree"), false),
            &merge_into_request(),
        )
        .expect("occupied merge-into target is blocked");
        assert_eq!(reason.operation, "merge-into");
        assert_eq!(reason.code, "worktree-checked-out");
        assert!(reason.message.contains("/repo/release-worktree"));
    }

    #[test]
    fn merge_into_ignores_a_dirty_selected_worktree() {
        assert_eq!(
            blocked_reason_for_operation(&merge_into_snapshot(None, true), &merge_into_request()),
            None
        );
    }
```

- [ ] **Step 6: Failing integration tests** — add to `production_git_manager_rpc.rs`:

```rust
/// main checkout on `main`; `release` and `feature` branch from it with one commit each.
fn merge_into_fixture(cwd: &Path, feature_file: &str, feature_text: &str, release_text: &str) {
    git(cwd, &["switch", "-q", "-c", "release"]);
    fs::write(cwd.join("tracked.txt"), release_text).expect("release change");
    git(cwd, &["commit", "-qam", "release"]);
    git(cwd, &["switch", "-q", "-c", "feature", "main"]);
    fs::write(cwd.join(feature_file), feature_text).expect("feature change");
    git(cwd, &["add", "."]);
    git(cwd, &["commit", "-q", "-m", "feature"]);
    git(cwd, &["switch", "-q", "main"]);
}

fn merge_into(fixture: &Fixture, id: &str, cwd: &Path, source: &str, target: &str)
    -> mpsc::Receiver<Result<Vec<Value>, Value>> {
    fixture.operation(
        id,
        json!({ "_tag": "merge-into", "cwd": cwd, "projectId": "project-1",
                "source": source, "target": target }),
    )
}

fn merge_head_exists(cwd: &Path) -> bool {
    git_output(cwd, &["rev-parse", "-q", "--verify", "MERGE_HEAD"]).status.success()
}

#[tokio::test]
async fn merge_into_from_a_linked_worktree_leaves_that_checkout_untouched() {
    let fixture = Fixture::new().await;
    let main = fixture.repository_path.clone();
    merge_into_fixture(&main, "feature.txt", "feature\n", "release\n");
    let linked = fixture._root.path().join("linked");
    git(&main, &["worktree", "add", "-q", "-b", "linked", path(&linked), "main"]);
    configure_identity(&linked);
    fs::write(linked.join("scratch.txt"), "uncommitted\n").expect("dirty linked checkout");
    let before = (
        git_stdout(&linked, &["rev-parse", "HEAD"]),
        git_stdout(&linked, &["ls-files", "-s"]),
        git_stdout(&linked, &["status", "--porcelain"]),
    );
    let release_tip = git_stdout(&main, &["rev-parse", "release"]);
    let feature_tip = git_stdout(&main, &["rev-parse", "feature"]);

    let events = collect_events(merge_into(&fixture, "501", &linked, "refs/heads/feature", "release")).await;

    assert_eq!(events.last().and_then(|event| event["_tag"].as_str()), Some("finished"), "{events:?}");
    let parents = git_stdout(&main, &["rev-list", "--parents", "-n", "1", "release"]);
    let parents: Vec<_> = parents.split_whitespace().skip(1).map(str::to_owned).collect();
    assert_eq!(parents, [release_tip, feature_tip]);
    assert_eq!(
        git_stdout(&main, &["log", "-1", "--format=%s", "release"]),
        "Merge branch 'feature' into release"
    );
    let after = (
        git_stdout(&linked, &["rev-parse", "HEAD"]),
        git_stdout(&linked, &["ls-files", "-s"]),
        git_stdout(&linked, &["status", "--porcelain"]),
    );
    assert_eq!(before, after);
}

#[tokio::test]
async fn conflicting_merge_into_is_refused_before_any_write() {
    let fixture = Fixture::new().await;
    let main = fixture.repository_path.clone();
    merge_into_fixture(&main, "tracked.txt", "feature\n", "release\n");
    let release_tip = git_stdout(&main, &["rev-parse", "release"]);

    let events = collect_events(merge_into(&fixture, "502", &main, "refs/heads/feature", "release")).await;

    let last = events.last().expect("terminal event");
    assert_eq!(last["_tag"], "failed");
    assert_eq!(last["code"], "conflicts");
    assert!(last["message"].as_str().unwrap_or("").contains("Check out release"));
    assert_eq!(git_stdout(&main, &["rev-parse", "release"]), release_tip);
    assert!(!merge_head_exists(&main));
}

#[tokio::test]
async fn merge_into_blocks_a_target_checked_out_in_another_worktree() {
    let fixture = Fixture::new().await;
    let main = fixture.repository_path.clone();
    merge_into_fixture(&main, "feature.txt", "feature\n", "release\n");
    let holder = fixture._root.path().join("holder");
    git(&main, &["worktree", "add", "-q", path(&holder), "release"]);
    let release_tip = git_stdout(&main, &["rev-parse", "release"]);

    let events = collect_events(merge_into(&fixture, "503", &main, "refs/heads/feature", "release")).await;

    let last = events.last().expect("terminal event");
    assert_eq!(last["code"], "worktree-checked-out", "{events:?}");
    assert!(!last["blocked"].is_null());
    assert_eq!(git_stdout(&main, &["rev-parse", "release"]), release_tip);
}

#[tokio::test]
async fn merge_into_maps_gits_refusal_for_a_target_mid_rebase_elsewhere() {
    let fixture = Fixture::new().await;
    let main = fixture.repository_path.clone();
    merge_into_fixture(&main, "feature.txt", "feature\n", "release\n");
    git(&main, &["switch", "-q", "-c", "other", "main"]);
    fs::write(main.join("tracked.txt"), "other\n").expect("other change");
    git(&main, &["commit", "-qam", "other"]);
    git(&main, &["switch", "-q", "main"]);
    let holder = fixture._root.path().join("holder");
    git(&main, &["worktree", "add", "-q", path(&holder), "release"]);
    configure_identity(&holder);
    // The rebase stops on a conflict, leaving `release` detached but in use.
    assert!(!git_output(&holder, &["rebase", "other"]).status.success());
    let release_tip = git_stdout(&main, &["rev-parse", "release"]);

    let events = collect_events(merge_into(&fixture, "504", &main, "refs/heads/feature", "release")).await;

    let last = events.last().expect("terminal event");
    assert_eq!(last["code"], "worktree-checked-out", "{events:?}");
    assert_eq!(git_stdout(&main, &["rev-parse", "release"]), release_tip);
}

#[tokio::test]
async fn merge_into_fails_without_moving_the_target_when_signing_fails() {
    let fixture = Fixture::new().await;
    let main = fixture.repository_path.clone();
    merge_into_fixture(&main, "feature.txt", "feature\n", "release\n");
    git(&main, &["config", "commit.gpgSign", "true"]);
    git(&main, &["config", "gpg.program", "false"]);
    let release_tip = git_stdout(&main, &["rev-parse", "release"]);

    let events = collect_events(merge_into(&fixture, "505", &main, "refs/heads/feature", "release")).await;

    assert_eq!(events.last().expect("terminal event")["_tag"], "failed", "{events:?}");
    assert_eq!(git_stdout(&main, &["rev-parse", "release"]), release_tip);
}

#[tokio::test]
async fn merge_into_updates_the_branch_not_a_same_named_tag() {
    let fixture = Fixture::new().await;
    let main = fixture.repository_path.clone();
    merge_into_fixture(&main, "feature.txt", "feature\n", "release\n");
    git(&main, &["tag", "release", "feature"]);
    let release_tip = git_stdout(&main, &["rev-parse", "refs/heads/release"]);

    let events = collect_events(merge_into(&fixture, "506", &main, "refs/heads/feature", "release")).await;

    let last = events.last().expect("terminal event");
    assert_eq!(last["_tag"], "finished", "{events:?}");
    assert_ne!(last["message"], "Already up to date.");
    assert_ne!(git_stdout(&main, &["rev-parse", "refs/heads/release"]), release_tip);
}

#[tokio::test]
async fn merge_into_reports_already_up_to_date_without_writing() {
    let fixture = Fixture::new().await;
    let main = fixture.repository_path.clone();
    merge_into_fixture(&main, "feature.txt", "feature\n", "release\n");
    git(&main, &["branch", "behind", "release~1"]);
    let release_tip = git_stdout(&main, &["rev-parse", "release"]);

    let events = collect_events(merge_into(&fixture, "507", &main, "refs/heads/behind", "release")).await;

    assert_eq!(events.last().expect("terminal")["message"], "Already up to date.");
    assert_eq!(git_stdout(&main, &["rev-parse", "release"]), release_tip);
}

#[tokio::test]
async fn merge_into_rejects_the_current_and_a_deleted_target() {
    let fixture = Fixture::new().await;
    let main = fixture.repository_path.clone();
    merge_into_fixture(&main, "feature.txt", "feature\n", "release\n");

    let current = collect_events(merge_into(&fixture, "508", &main, "refs/heads/feature", "main")).await;
    assert_eq!(current.last().expect("terminal")["code"], "target-is-current");

    let missing = collect_events(merge_into(&fixture, "509", &main, "refs/heads/feature", "gone")).await;
    assert_eq!(missing.last().expect("terminal")["code"], "local-branch-not-found");
    assert!(!git_output(&main, &["rev-parse", "-q", "--verify", "refs/heads/gone"]).status.success());
}

#[tokio::test]
async fn merge_into_records_a_remote_tracking_source() {
    let fixture = Fixture::new().await;
    let main = fixture.repository_path.clone();
    merge_into_fixture(&main, "feature.txt", "feature\n", "release\n");
    git(&main, &["push", "-q", "origin", "feature"]);
    git(&main, &["fetch", "-q", "origin"]);

    let events = collect_events(
        merge_into(&fixture, "510", &main, "refs/remotes/origin/feature", "release"),
    )
    .await;

    assert_eq!(events.last().expect("terminal")["_tag"], "finished", "{events:?}");
    assert_eq!(
        git_stdout(&main, &["log", "-1", "--format=%s", "release"]),
        "Merge remote-tracking branch 'origin/feature' into release"
    );
}

/// The Source Control path (spec criterion 3): fetch, merge a remote-tracking ref into the
/// current branch, resolve the conflict, and finish through `continue` with two parents.
#[tokio::test]
async fn remote_tracking_merge_conflict_finishes_through_continue_with_two_parents() {
    let fixture = Fixture::new().await;
    let main = fixture.repository_path.clone();
    merge_into_fixture(&main, "tracked.txt", "feature\n", "release\n");
    git(&main, &["push", "-q", "origin", "feature"]);
    fs::write(main.join("tracked.txt"), "main\n").expect("main change");
    git(&main, &["commit", "-qam", "main"]);
    let fetched = collect_events(fixture.operation(
        "512",
        json!({ "_tag": "fetch", "cwd": main, "projectId": "project-1", "remote": "origin" }),
    ))
    .await;
    assert_eq!(fetched.last().expect("terminal")["_tag"], "finished", "{fetched:?}");
    let main_tip = git_stdout(&main, &["rev-parse", "main"]);
    let source_tip = git_stdout(&main, &["rev-parse", "refs/remotes/origin/feature"]);

    let merged = collect_events(fixture.operation(
        "513",
        json!({ "_tag": "merge", "cwd": main, "projectId": "project-1",
                "source": "refs/remotes/origin/feature", "noVerify": false }),
    ))
    .await;
    assert_eq!(merged.last().expect("terminal")["code"], "conflicts", "{merged:?}");
    assert!(merge_in_progress(&main));

    let resolved = collect_events(fixture.operation(
        "514",
        json!({ "_tag": "resolve-conflict", "cwd": main, "projectId": "project-1",
                "path": "tracked.txt", "side": "theirs" }),
    ))
    .await;
    assert_eq!(resolved.last().expect("terminal")["_tag"], "finished", "{resolved:?}");
    let finished = collect_events(fixture.operation(
        "515",
        json!({ "_tag": "continue", "cwd": main, "projectId": "project-1", "operation": "merge" }),
    ))
    .await;
    assert_eq!(finished.last().expect("terminal")["_tag"], "finished", "{finished:?}");
    assert_eq!(head_parents(&main), [main_tip, source_tip]);
}

#[cfg(unix)]
#[tokio::test]
async fn a_rejecting_reference_transaction_hook_leaves_the_target_unchanged() {
    use std::os::unix::fs::PermissionsExt;
    let fixture = Fixture::new().await;
    let main = fixture.repository_path.clone();
    merge_into_fixture(&main, "feature.txt", "feature\n", "release\n");
    let hook = main.join(".git/hooks/reference-transaction");
    fs::write(&hook, "#!/bin/sh\n[ \"$1\" = prepared ] && exit 1\nexit 0\n").expect("hook");
    fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).expect("hook mode");
    let release_tip = git_stdout(&main, &["rev-parse", "release"]);

    let events = collect_events(merge_into(&fixture, "511", &main, "refs/heads/feature", "release")).await;

    assert_eq!(events.last().expect("terminal")["_tag"], "failed", "{events:?}");
    assert_eq!(git_stdout(&main, &["rev-parse", "release"]), release_tip);
}
```

- [ ] **Step 7: Run to verify failures, then implement until green**

Run: `cd apps/server && CARGO_BUILD_JOBS=4 cargo test --test production_git_manager_rpc merge_into && CARGO_BUILD_JOBS=4 cargo test --test production_git_manager_rpc a_rejecting_reference_transaction && CARGO_BUILD_JOBS=4 cargo test --test production_git_manager_rpc remote_tracking_merge_conflict && CARGO_BUILD_JOBS=4 cargo test --lib git::manager`
Expected before Steps 1-4: FAIL (unknown `_tag`). After: PASS.

- [ ] **Step 8: Capability** — `control.rs`: add `"gitManagerMergeIntoOperations": true,` after `"gitManagerStashMergeOperations": true,` and `"gitManagerMergeIntoOperations",` to the test list at ~6314. Run `CARGO_BUILD_JOBS=4 cargo test --lib production::control`.

- [ ] **Step 9: Rust gates** — `cd apps/server && cargo fmt --all --check && CARGO_BUILD_JOBS=4 cargo clippy --all-targets -- -D warnings`.

- [ ] **Step 10: Commit** (commit protocol), message `feat(server): merge into a branch that is not checked out`.

---

### Task 7: Merge dialog accepts remote sources and sends full refs

**Files:**
- Modify: `apps/web/src/components/gitManager/merge/GitManagerMergeDialog.tsx`
- Modify: `apps/web/src/components/gitManager/merge/GitManagerMergeDialog.logic.ts`
- Modify: `apps/web/src/components/gitManager/GitManagerPanel.tsx:1238-1247` (pass `remoteRefs`)
- Test: `merge/GitManagerMergeDialog.test.tsx`, `merge/GitManagerMergeDialog.logic.test.ts`

**Interfaces:**
- Produces: `GitManagerMergeDialogProps.remoteRefs?: ReadonlyArray<GitManagerRefEntry>`; sources sent as `refs/heads/<name>` / `refs/remotes/<name>`; `shortRefName(ref: string): string` exported from the logic module.

- [ ] **Step 1: Failing tests**
  - Logic: `expect(shortRefName("refs/heads/feature")).toBe("feature"); expect(shortRefName("refs/remotes/origin/x")).toBe("origin/x"); expect(shortRefName("main")).toBe("main");` and `summarizeMergePreview(preview({ _tag: "clean", source: "refs/heads/feature" })).message` contains `` `feature` `` and not `refs/heads/` (use the file's existing `preview(...)` helper; adapt the override shape to its signature).
  - Dialog: update the existing payload expectation to `source: "refs/heads/feature"` and set `cleanPreview.source = "refs/heads/feature"`. Add:

```tsx
  it("lists remote branches and sends their full ref with the repository-level block", async () => {
    const message = "Merge is blocked: the working tree has uncommitted changes.";
    const main = { ...branch("main", true), blocked: [{ operation: "merge", code: "dirty-working-tree", message }] } as GitManagerRefEntry;
    h.preview = { ...cleanPreview, source: "refs/remotes/origin/topic" };
    await renderDialog([main, branch("feature")], vi.fn(), null, [branch("origin/topic")]);
    expect(container.textContent).toContain("origin/topic");
    await act(async () => buttonWithText("origin/topic").click());
    expect(h.previewMerge).toHaveBeenLastCalledWith(
      expect.objectContaining({ input: { cwd: "/repo", source: "refs/remotes/origin/topic" } }),
    );
    expect(buttonWithText("Merge")).toMatchObject({ disabled: true, title: message });
  });
```

  (`renderDialog` gains a 4th parameter `remoteRefs: ReadonlyArray<GitManagerRefEntry> = []` passed as `remoteRefs`; the source-list button text is the branch name, so give the list item an exact-text label.)

- [ ] **Step 2: Run to verify failure** — `cd apps/web && node ../../scripts/run-local-vp.mjs test run --project unit src/components/gitManager/merge/` → FAIL.

- [ ] **Step 3: Implement**
  - Logic: `export function shortRefName(ref: string): string { return ref.replace(/^refs\/(heads|remotes)\//, ""); }` and use `shortRefName(preview.source)` / `shortRefName(preview.current)` in every message.
  - Dialog: build a source option list instead of raw entries:

```tsx
interface MergeSourceOption {
  readonly ref: string; // full ref sent to the server
  readonly label: string;
  readonly entry: GitManagerRefEntry;
  readonly remote: boolean;
}
```

    Local options from `[...grouped.default, ...grouped.recent, ...grouped.other]` with `ref: \`refs/heads/${name}\``; remote options from `grouped.remote` (pass `remoteRefs` into `groupBranches`) with `ref: \`refs/remotes/${name}\``. Render a "Remote" heading before remote options. `selectedSourceName` stores the full ref. `previewMerge` input uses the full ref. `blockedReason` for a remote option is the repository-level reason: the first reason on any local entry with `operation === operationTag` and `code` in `["dirty-working-tree", "merge-in-progress"]`; for a local option keep `entry.blocked.find(...)`. Keep the existing exclusion of the current branch for now (Task 8 replaces it).
  - `GitManagerPanel.tsx`: pass `remoteRefs={snapshot?.remoteBranches ?? EMPTY_REFS}` to `GitManagerMergeDialog`; change the description copy to "Select a source branch and review the server-computed merge preview." In `mergeDisabledReason`, report "No source branch is available." only when `localBranches.every((branch) => branch.current) && (snapshot?.remoteBranches ?? EMPTY_REFS).length === 0`, so a repository with one local branch and a remote branch can still open Merge… (no existing test pins this string; cover it in the panel's test file if one renders the toolbar, otherwise extract the condition into `GitManagerMergeDialog.logic.ts` as `hasMergeSource(localBranches, remoteBranches)` and unit-test it there).

- [ ] **Step 4: Run** — same command → PASS; then `node ../../scripts/run-local-vp.mjs test run --project unit src/components/gitManager/` → PASS.

- [ ] **Step 5: Commit** (commit protocol), message `feat(web): merge remote branches from the merge dialog`.

---

### Task 8: Merge dialog **Into** picker for `merge-into`

**Files:**
- Modify: `apps/web/src/components/gitManager/merge/GitManagerMergeDialog.tsx`
- Modify: `apps/web/src/components/gitManager/merge/GitManagerMergeDialog.logic.ts`
- Modify: `apps/web/src/components/gitManager/gitManagerAvailability.ts` (reason for missing capability)
- Modify: `apps/web/src/components/gitManager/GitManagerPanel.tsx` (pass `mergeIntoAvailable`, tooltip)
- Test: `merge/GitManagerMergeDialog.test.tsx`, `merge/GitManagerMergeDialog.logic.test.ts`

**Interfaces:**
- Consumes: Task 5 contract; Task 7 `MergeSourceOption`, `shortRefName`.
- Produces: `GitManagerMergeDialogProps.mergeIntoAvailable?: boolean` (default `false`), `GitManagerMergeDialogProps.targetMode?: "any-target" | "current-branch"` (default `"any-target"`; Source Control passes `"current-branch"`; named apart from the dialog's internal merge/squash `mode` state); logic `summarizeMergePreview(preview, { intoOtherBranch: boolean })`.

- [ ] **Step 1: Failing logic test**

```ts
  it("disables a conflicted merge into another branch with the check-out hint", () => {
    const summary = summarizeMergePreview(
      { _tag: "conflicted", source: "refs/heads/feature", current: "release", ahead: 1, behind: 0, fileCount: 2 },
      { intoOtherBranch: true },
    );
    expect(summary.mergeEnabled).toBe(false);
    expect(summary.message).toBe("2 files would conflict. Check out `release` to merge and resolve them.");
  });
```

- [ ] **Step 2: Failing dialog tests** (use the `chooseSource`-style combobox helper from `dialogs/GitManagerBranchDialogs.test.tsx`, adapted to the input id `git-manager-merge-target`):

```tsx
  it("merges the checked-out branch into another branch with merge-into", async () => {
    h.preview = { ...cleanPreview, source: "refs/heads/main", current: "release" };
    await renderDialog([branch("main", true), branch("release")], vi.fn(), null, [], { mergeIntoAvailable: true });
    await chooseTarget("release");
    expect(container.textContent).toContain("`release` is updated without checking it out.");
    expect(buttonWithText("Squash merge", { optional: true })).toBeNull();
    await act(async () => buttonWithText("main").click()); // the current branch is now a source
    await act(async () => buttonWithText("Merge").click());
    expect(h.runOperation).toHaveBeenLastCalledWith(
      expect.anything(),
      { environmentId: "env-a", input: { _tag: "merge-into", cwd: "/repo", projectId: "project-a", source: "refs/heads/main", target: "release" } },
      expect.any(Function),
    );
  });

  it("keeps Merge disabled until the preview matches the chosen target", async () => {
    h.preview = { ...cleanPreview, current: "main" }; // stale preview for the old target
    await renderDialog([branch("main", true), branch("release"), branch("feature")], vi.fn(), null, [], { mergeIntoAvailable: true });
    await chooseTarget("release");
    expect(buttonWithText("Merge").disabled).toBe(true);
  });

  it("hides the Into picker without the capability", async () => {
    await renderDialog([branch("main", true), branch("feature")]);
    expect(document.querySelector("#git-manager-merge-target")).toBeNull();
  });
```

(`renderDialog` gains a 5th `extra: Partial<GitManagerMergeDialogProps>` spread onto the element; `buttonWithText` gains an `{ optional }` option that returns `null` instead of throwing.)

- [ ] **Step 3: Run to verify failure** — `cd apps/web && node ../../scripts/run-local-vp.mjs test run --project unit src/components/gitManager/merge/` → FAIL.

- [ ] **Step 4: Implement**
  - Logic: add the second parameter with a default that preserves today's behaviour — `summarizeMergePreview(preview, options: { readonly intoOtherBranch?: boolean } = {})` and `resolveMergeConfirmCopy(mode, target: string | null = null)` — so existing one-argument callers and tests keep compiling; when `options.intoOtherBranch && preview._tag === "conflicted"` return `{ kind, message: \`${preview.fileCount} files would conflict. Check out \`${shortRefName(preview.current)}\` to merge and resolve them.\`, mergeEnabled: false, ...base }`. `resolveMergeConfirmCopy(mode, target: string | null)`: when `target !== null` return `{ title: \`Merge into ${target}\`, confirmLabel: "Merge" }`.
  - Dialog state: `const currentName = refs.find((ref) => ref.current)?.name ?? null; const [targetName, setTargetName] = useState<string | null>(null); const target = targetName ?? currentName; const intoOtherBranch = mergeIntoAvailable && targetMode !== "current-branch" && target !== null && target !== currentName;`
  - Into combobox (shown when `mergeIntoAvailable && targetMode !== "current-branch"`), label "Into", id `git-manager-merge-target`, items = local `refs` names, built exactly like the New Branch "From" combobox (`Combobox`, `ComboboxInput`, `ComboboxPopup`, `ComboboxList`, `ComboboxItem`, imports from `~/components/ui/combobox` as in `GitManagerBranchDialogs.tsx`).
  - Sources: filter out the **selected target** instead of `branch.current` (local options only; remote options are never targets). When `target` changes and the selected source equals `refs/heads/${target}`, clear `selectedSourceName`.
  - Mode: when `intoOtherBranch`, force `mode = "merge"` and do not render the "Squash merge" button.
  - Preview input: `{ cwd, source, ...(intoOtherBranch ? { target } : {}) }`; include `intoOtherBranch`/`target` in the `useMemo` deps. Accept the preview only when `preview.source === selectedSource && (!intoOtherBranch || preview.current === target)`.
  - Old Git: export `MERGE_PREVIEW_GIT_TOO_OLD_PREFIX = "Merge preview needs Git"` from the logic module (it mirrors the server's `git-too-old` preview message, which reaches the client only as text). When `!intoOtherBranch && previewQuery.error?.startsWith(MERGE_PREVIEW_GIT_TOO_OLD_PREFIX)`, skip the "Loading merge preview." / preview-required clause so Merge stays enabled for the current branch while the error text is shown; for another target the clause still disables Merge. Tests:

```tsx
  it("allows merging into the current branch when Git is too old to preview", async () => {
    h.preview = null;
    h.error = "Merge preview needs Git 2.38 or later on this environment (found 2.34.1).";
    await renderDialog([branch("main", true), branch("feature")]);
    expect(buttonWithText("Merge").disabled).toBe(false);
    expect(container.textContent).toContain("found 2.34.1");
  });

  it("keeps merge-into disabled when Git is too old to preview", async () => {
    h.preview = null;
    h.error = "Merge preview needs Git 2.38 or later on this environment (found 2.34.1).";
    await renderDialog([branch("main", true), branch("release")], vi.fn(), null, [], { mergeIntoAvailable: true });
    await chooseTarget("release");
    expect(buttonWithText("Merge").disabled).toBe(true);
  });
```

  - Blocked reason when `intoOtherBranch`: `refs.find((ref) => ref.name === target)?.blocked.find((reason) => reason.operation === "merge-into") ?? null`.
  - Request when `intoOtherBranch`: `{ _tag: "merge-into", cwd, projectId: projectRef.projectId, source: selectedSource, target }`; otherwise today's `merge`/`squash-merge` request.
  - Hint paragraph under the Into picker when `intoOtherBranch`: `` `{target}` is updated without checking it out. Your files don't change and commit hooks don't run. `` (render the backticked name in `<code>` if the surrounding copy does; the test matches the text with backticks — keep literal backticks to match `summary` copy style).
  - `GitManagerPanel.tsx`: pass `mergeIntoAvailable={serverConfig?.environment.capabilities.gitManagerMergeIntoOperations === true}` (use the same `serverConfig` source as `resolveGitManagerCapabilityDisabledReasons`; thread it as a prop to the inner surface if needed). Tooltip `"Merge one branch into another"`. `mergeDisabledReason`'s "No source branch is available." stays (a single-branch repo still has nothing to merge).

- [ ] **Step 5: Run** — merge folder tests, then the whole `src/components/gitManager/` folder → PASS.

- [ ] **Step 6: Reviews** — review changed components against `/vercel-react-best-practices` and `UI.md` (record findings in the commit body).

- [ ] **Step 7: Commit** (commit protocol), message `feat(web): merge into another branch from the merge dialog`.

---

### Task 9: In-progress strip keeps Abort available while Continue waits

**Files:**
- Modify: `apps/web/src/components/gitManager/GitManagerInProgressStrip.tsx`
- Create: `apps/web/src/components/gitManager/GitManagerInProgressStrip.test.tsx`

**Interfaces:**
- Produces: props `continueDisabledReason?: string | null` (disables only Continue) and `continueLabel?: string` (default `"Continue"`).

- [ ] **Step 1: Failing test** (happy-dom, mock `~/components/ui/dialog` like the merge dialog test):

```tsx
// @vitest-environment happy-dom
// ...imports and dialog mock as in GitManagerMergeDialog.test.tsx...
it("disables only Continue with a continue-only reason", async () => {
  await act(async () =>
    root?.render(
      <GitManagerInProgressStrip
        blocked={null}
        continueDisabledReason="Resolve and stage every conflicted file first."
        continueLabel="Commit merge"
        operation={{ kind: "merge", current: null, total: null }}
        onAbort={vi.fn()}
        onContinue={vi.fn()}
      />,
    ),
  );
  expect(buttonWithText("Commit merge")).toMatchObject({
    disabled: true,
    title: "Resolve and stage every conflicted file first.",
  });
  expect(buttonWithText("Abort").disabled).toBe(false);
});
```

- [ ] **Step 2: Run to verify failure** — `cd apps/web && node ../../scripts/run-local-vp.mjs test run --project unit src/components/gitManager/GitManagerInProgressStrip.test.tsx` → FAIL.

- [ ] **Step 3: Implement** — `const continueReason = disabledReason ?? continueDisabledReason;` Continue uses `continueReason` for `disabled`/`title`; Abort keeps `disabledReason`. The reason paragraph shows `disabledReason ?? continueDisabledReason ?? resolveInProgressBlockedReason(blocked)`; give it the id whenever either reason is set. Button text `{continueLabel}`.

- [ ] **Step 4: Run** → PASS, plus `src/components/gitManager/` → PASS.

- [ ] **Step 5: Commit** (commit protocol), message `feat(web): let the in-progress strip disable Continue without Abort`.

---

### Task 10: Source Control "Merge into current branch…" with Fetch

**Files:**
- Modify: `apps/web/src/components/SourceControlPrimaryAction.logic.ts` (menu id/kind, gating, stale comments at ~23 and ~290)
- Modify: `apps/web/src/components/SourceControlPanel.tsx` (props `projectRef`, dialog mount, refs query, menu dispatch)
- Modify: `apps/web/src/components/ChatView.tsx:6632-6638` (pass `projectRef={activeProjectRef}`)
- Modify: `apps/web/src/components/gitManager/merge/GitManagerMergeDialog.tsx` (Fetch button, `remotes`, `onRefsStale`)
- Create: `apps/web/src/components/gitManager/merge/resolveFetchRemote.ts`
- Test: `SourceControlPrimaryAction.logic.test.ts`, `SourceControlPanel.test.tsx`, `merge/resolveFetchRemote.test.ts`, `merge/GitManagerMergeDialog.test.tsx`

**Interfaces:**
- Consumes: Tasks 7-8 dialog (`targetMode="current-branch"`, `remoteRefs`), Task 1 `operationInProgress`.
- Produces: `SourceControlMenuItemId` gains `"merge"`; `SourceControlMenuItem.kind` gains `"open_merge"`; `SourceControlPrimaryActionInput` gains `mergeAvailable: boolean`; `resolveFetchRemote(sourceRef: string | null, remotes: ReadonlyArray<string>): ReadonlyArray<string>`; dialog props `remotes?: ReadonlyArray<string>` and `onRefsStale?: () => void`.

- [ ] **Step 1: Failing logic tests**

```ts
// resolveFetchRemote.test.ts
import { describe, expect, it } from "vite-plus/test";
import { resolveFetchRemote } from "./resolveFetchRemote";

describe("resolveFetchRemote", () => {
  it("picks the longest remote prefix of a remote-tracking source", () => {
    expect(resolveFetchRemote("refs/remotes/team/origin/feature", ["team", "team/origin"])).toEqual(["team/origin"]);
  });
  it("fetches every remote for a local or missing source", () => {
    expect(resolveFetchRemote("refs/heads/feature", ["origin", "upstream"])).toEqual(["origin", "upstream"]);
    expect(resolveFetchRemote(null, ["origin"])).toEqual(["origin"]);
  });
});
```

In `SourceControlPrimaryAction.logic.test.ts`:

```ts
  it.each([
    [{ refName: null }, "Check out a branch to merge into."],
    [{ operationInProgress: "merge" }, "Finish or abort the current merge first."],
    [{ hasWorkingTreeChanges: true }, "Commit your changes before merging."],
  ])("gates Merge into current branch (%o)", (overrides, reason) => {
    const items = buildSourceControlMenuItems({ ...baseInput, mergeAvailable: true, gitStatus: { ...baseStatus, ...overrides } });
    expect(items.find((item) => item.id === "merge")).toMatchObject({ disabled: true, reason, kind: "open_merge", group: "remote" });
  });

  it("explains a missing merge capability first", () => {
    const items = buildSourceControlMenuItems({ ...baseInput, mergeAvailable: false, gitStatus: { ...baseStatus, refName: null } });
    expect(items.find((item) => item.id === "merge")?.reason).toBe(
      "This environment does not support Git Manager stash and merge operations.",
    );
  });
```

(Use the file's existing status/input fixtures in place of `baseStatus`/`baseInput`; add `mergeAvailable: true` to that fixture.) Update every existing exact expectation in this file (`menuIds(...)` lists and group arrays, e.g. the fixed-order, no-remote and open-PR cases near lines 300, 370, 403, 469, 478) to include `"merge"` immediately after `"pull"` in the `remote` group.

- [ ] **Step 2: Run to verify failure** — `cd apps/web && node ../../scripts/run-local-vp.mjs test run --project unit src/components/SourceControlPrimaryAction.logic.test.ts src/components/gitManager/merge/` → FAIL.

- [ ] **Step 3: Implement the logic**

```ts
// resolveFetchRemote.ts
/** Remotes to fetch before merging `sourceRef`; remote names may contain `/`. */
export function resolveFetchRemote(
  sourceRef: string | null,
  remotes: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const tracking = sourceRef?.startsWith("refs/remotes/")
    ? sourceRef.slice("refs/remotes/".length)
    : null;
  if (tracking === null) return remotes;
  const owner = remotes
    .filter((remote) => tracking.startsWith(`${remote}/`))
    .sort((left, right) => right.length - left.length)[0];
  return owner === undefined ? remotes : [owner];
}
```

  In `SourceControlPrimaryAction.logic.ts`: add `"merge"` to `SourceControlMenuItemId`, `"open_merge"` to `kind`, `mergeAvailable: boolean` to the input, and push after the Pull item:

```ts
    {
      id: "merge",
      label: "Merge into current branch…",
      group: "remote",
      kind: "open_merge",
      ...gate(
        (input.mergeAvailable ? undefined : GIT_MANAGER_STASH_MERGE_DISABLED_REASON) ??
          (hasBranch ? undefined : "Check out a branch to merge into.") ??
          (gitStatus.operationInProgress === undefined
            ? undefined
            : "Finish or abort the current merge first.") ??
          (gitStatus.hasWorkingTreeChanges ? "Commit your changes before merging." : undefined),
      ),
    },
```

  (import `GIT_MANAGER_STASH_MERGE_DISABLED_REASON` from `./gitManager/gitManagerAvailability`). Replace the two stale comments ("No stash / amend …" and "Fetch / Force-push / Rebase / Sync menu items are intentionally omitted …") with accurate ones: fetch and merge now route through Git Manager operations; force-push, rebase and stash remain Git Manager–only.

- [ ] **Step 4: Dialog Fetch button** — in `GitManagerMergeDialog`, when `remotes.length > 0`, render a `Fetch` button (outline, `size="sm"`) beside the filter. Clicking it runs, sequentially, `runGitManagerOperation(registry, { environmentId, input: { _tag: "fetch", cwd, projectId: projectRef.projectId, remote } }, onEvent)` for each remote from `resolveFetchRemote(selectedSource, remotes)`, reusing the dialog's `operationRunning`/`operationEvent`/`failureCode` state and banner. On each `finished` continue with the next remote; after the last, call `onRefsStale()` and `previewQuery.refresh()`. On `failed` stop, keep the dialog open, show the failure (existing failure paragraph). Merge stays disabled while fetching ("The selected Git operation is running.").

  Dialog test:

```tsx
  it("fetches the selected source's remote, then asks for fresh refs", async () => {
    const onRefsStale = vi.fn();
    h.preview = { ...cleanPreview, source: "refs/remotes/origin/topic" };
    await renderDialog([branch("main", true)], vi.fn(), null, [branch("origin/topic")], { remotes: ["origin"], onRefsStale });
    await act(async () => buttonWithText("origin/topic").click());
    await act(async () => buttonWithText("Fetch").click());
    expect(h.runOperation).toHaveBeenLastCalledWith(
      expect.anything(),
      { environmentId: "env-a", input: { _tag: "fetch", cwd: "/repo", projectId: "project-a", remote: "origin" } },
      expect.any(Function),
    );
    await act(async () => h.onEvent?.({ _tag: "finished", operation: "fetch", message: "Fetched." }));
    expect(onRefsStale).toHaveBeenCalledTimes(1);
  });

  it("keeps the dialog open and shows a failed fetch", async () => {
    const onOpenChange = await renderDialog([branch("main", true), branch("feature")], vi.fn(), null, [], { remotes: ["origin"] });
    await act(async () => buttonWithText("Fetch").click());
    await act(async () => h.onEvent?.({ _tag: "failed", operation: "fetch", code: "authentication", message: "Authentication failed.", blocked: null }));
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(container.textContent).toContain("Authentication failed.");
  });
```

  Note: the existing `finished` handler closes the dialog; branch on `event.operation === "fetch"` so a finished fetch never closes it.

  Also in this step:
  - New prop `onRunningChange?: (running: boolean) => void`, called from a `useEffect` on `operationRunning` (fetch and merge), so the panel can mark itself busy.
  - When `targetMode === "current-branch"` and a `merge` fails with code `conflicts`, call `onFinished()` and `onOpenChange(false)` so the panel's conflict strip is visible; every other failure (fetch, refused `merge-into`, Git Manager surface) keeps the dialog open. Test:

```tsx
  it("closes on a conflicted current-branch merge so the panel strip shows", async () => {
    const onOpenChange = await renderDialog([branch("main", true), branch("feature")], vi.fn(), null, [], { targetMode: "current-branch" });
    await act(async () => buttonWithText("Merge").click());
    await act(async () => h.onEvent?.({ _tag: "failed", operation: "merge", code: "conflicts", message: "Conflicts.", blocked: null }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
```

- [ ] **Step 5: Panel wiring**
  - `ChatView.tsx`: `<SourceControlPanel ... projectRef={activeProjectRef} />`.
  - `SourceControlPanel.tsx` props: `projectRef?: ScopedProjectRef | null`. State `const [mergeDialogOpen, setMergeDialogOpen] = useState(false)`. Capability: `const capabilities = useServerConfigs().get(environmentId)?.environment.capabilities; const mergeAvailable = capabilities?.gitManagerStashMergeOperations === true && capabilities?.gitManagerBranchSyncOperations === true && projectRef != null;`. Add `mergeAvailable` to `primaryActionInput` (and its deps).
  - Refs only while open:

```tsx
  const refsAtom = useMemo(
    () =>
      mergeDialogOpen && gitCwd !== null
        ? (gitManagerEnvironment.getRefs?.({ environmentId, input: { cwd: gitCwd } }) ?? null)
        : null,
    [environmentId, gitCwd, mergeDialogOpen],
  );
  const refsQuery = useEnvironmentQuery(refsAtom);
```

  - `onScMenuItem`: `case "open_merge": setMergeDialogOpen(true); return;`.
  - Busy state: rename the existing hook result `const vcsBusy = useSourceControlActionRunning(scope, RUNNING_ACTIONS);`, add `const [mergeOperationRunning, setMergeOperationRunning] = useState(false);` and `const isBusy = vcsBusy || mergeOperationRunning;` so every existing `isBusy` consumer (primary action input, menus, sections) is disabled while the dialog's fetch/merge runs.
  - Mount next to the PR dialog:

```tsx
      {projectRef != null && gitCwd !== null ? (
        <GitManagerMergeDialog
          targetMode="current-branch"
          open={mergeDialogOpen}
          projectRef={projectRef}
          refs={refsQuery.data?.localBranches ?? EMPTY_REFS}
          remoteRefs={refsQuery.data?.remoteBranches ?? EMPTY_REFS}
          remotes={refsQuery.data?.remotes ?? EMPTY_REMOTES}
          scope={scope}
          onFinished={() => setCommitSignal((value) => value + 1)}
          onOpenChange={setMergeDialogOpen}
          onRefsStale={refsQuery.refresh}
          onRunningChange={setMergeOperationRunning}
        />
      ) : null}
```

    (`EMPTY_REFS`/`EMPTY_REMOTES` as module-level frozen arrays; `scope` must be `{ environmentId, cwd: gitCwd }` with a non-null `cwd`.) In `targetMode="current-branch"` the dialog also hides "Squash merge" (merge commit only in the panel).
  - Panel test (`SourceControlPanel.test.tsx`, follow its `vi.mock` setup at ~206-293; mock `./gitManager/merge/GitManagerMergeDialog` to render a marker with its props): clicking the "Merge into current branch…" menu item renders the dialog marker with `targetMode: "current-branch"` and the thread's `projectRef`.

- [ ] **Step 6: Run** — `cd apps/web && node ../../scripts/run-local-vp.mjs test run --project unit src/components/SourceControlPrimaryAction.logic.test.ts src/components/SourceControlPanel.test.tsx src/components/gitManager/` → PASS; then from the repository root `node scripts/run-local-vp.mjs run typecheck` → PASS.

- [ ] **Step 7: Reviews** — `/vercel-react-best-practices` and `UI.md` on `SourceControlPanel.tsx`, `GitManagerMergeDialog.tsx`.

- [ ] **Step 8: Commit** (commit protocol), message `feat(web): merge a fetched branch from the Source Control panel`.

---

### Task 11: Source Control merge conflicts — strip, Merge Changes, busy state

**Files:**
- Modify: `apps/web/src/components/SourceControlPanel.tsx`
- Modify: `apps/web/src/components/SourceControlPanel.logic.ts` (`groupFilesByArea` → adds `conflicted`)
- Create: `apps/web/src/components/SourceControlMergeChanges.tsx`
- Modify: `apps/web/src/state/gitManager.ts` (`useRunGitManagerOperation`)
- Test: `SourceControlPanel.logic.test.ts` (or the existing logic test file), `SourceControlPanel.test.tsx`

**Interfaces:**
- Consumes: Task 1 (`status.operationInProgress`, `"conflicted"`), Task 9 strip props, Task 10 `projectRef`.
- Produces: `WorkingTreeGroups.conflicted: WorkingTreeFile[]`; `SourceControlMergeChanges` props `{ files, disabled, onResolve(path, side), onOpenInEditor(path) }`.

- [ ] **Step 1: Failing logic test**

```ts
  it("groups conflicted files apart from ordinary changes", () => {
    const groups = groupFilesByArea([
      { path: "a.txt", insertions: 0, deletions: 0, status: "conflicted", area: "unstaged" },
      { path: "b.txt", insertions: 1, deletions: 0, status: "modified", area: "unstaged" },
    ]);
    expect(groups.conflicted.map((file) => file.path)).toEqual(["a.txt"]);
    expect(groups.unstaged.map((file) => file.path)).toEqual(["b.txt"]);
  });
```

- [ ] **Step 2: Failing panel tests** (status fixture with `operationInProgress: "merge"` and one conflicted file; mock `runGitManagerOperation` from `~/state/gitManager`):
  - The strip renders "Commit merge" disabled with "Resolve and stage every conflicted file first." and an enabled "Abort".
  - The "Merge Changes" section lists the conflicted path with "Ours" and "Theirs" buttons; clicking "Ours" calls `runGitManagerOperation` with `{ _tag: "resolve-conflict", cwd, projectId, path: "a.txt", side: "ours" }`.
  - With no conflicted files and `operationInProgress: "merge"`, "Commit merge" is enabled and sends `{ _tag: "continue", cwd, projectId, operation: "merge" }`; the stacked Commit primary button is not rendered.
  - While that operation runs (no `finished` yet), the Stage all button is disabled with title "A merge is running." and the strip shows the operation banner with a Cancel control.
  - With `mergeAvailable` false, both strip buttons are disabled with the stash/merge capability reason.

- [ ] **Step 3: Run to verify failure** — `cd apps/web && node ../../scripts/run-local-vp.mjs test run --project unit src/components/SourceControlPanel.test.tsx src/components/SourceControlPanel.logic.test.ts` → FAIL.

- [ ] **Step 4: Implement**
  - `groupFilesByArea`: `conflicted: []` in the result; `if (file.status === "conflicted") groups.conflicted.push(file); else if ...` (before the area checks).
  - `SourceControlMergeChanges.tsx` (memo component): heading "Merge Changes", one row per file with the path, an "Open" ghost button (`onOpenInEditor(path)`), and "Ours"/"Theirs" outline `xs` buttons (`onResolve(path, "ours" | "theirs")`), all `disabled` when `disabled`.
  - Runner hook in `apps/web/src/state/gitManager.ts` (the panel test calls the component with mocked hooks, so the registry read lives in a mockable hook, not in the panel):

```ts
/** Binds `runGitManagerOperation` to the current atom registry. */
export function useRunGitManagerOperation() {
  const registry = useContext(RegistryContext);
  return useCallback(
    (
      target: { readonly environmentId: EnvironmentId; readonly input: GitManagerOperationRequest },
      onEvent: (event: GitManagerOperationEvent) => void,
    ) => runGitManagerOperation(registry, target, onEvent),
    [registry],
  );
}
```

    (imports: `useCallback, useContext` from `react`, `RegistryContext` from `@effect/atom-react`.) In `SourceControlPanel.test.tsx` extend the `~/state/gitManager` mock (or add one) with `useRunGitManagerOperation: () => h.runOperation` and `gitManagerEnvironment: { getRefs: vi.fn(() => null) }`, where `h.runOperation` records `(target, onEvent)` and returns `{ result: new Promise(() => undefined), cancel: vi.fn() }`.
  - Panel (the `mergeOperationRunning` state and `isBusy = vcsBusy || mergeOperationRunning` composition already exist from Task 10):

```tsx
  const runOperation = useRunGitManagerOperation();
  const recoveryHandleRef = useRef<GitManagerOperationHandle | null>(null);
  const [recoveryEvent, setRecoveryEvent] = useState<GitManagerOperationEvent | null>(null);
  useEffect(() => () => recoveryHandleRef.current?.cancel(), []);
  const mergeInProgress = status?.operationInProgress === "merge";
  // A complete scope is required to build any recovery request.
  const recoveryScope =
    projectRef != null && gitCwd !== null
      ? { cwd: gitCwd, projectId: projectRef.projectId }
      : null;
  const runRecovery = useCallback(
    (input: GitManagerOperationRequest) => {
      if (recoveryHandleRef.current !== null) return;
      setMergeOperationRunning(true);
      setRecoveryEvent({ _tag: "started", operation: input._tag });
      const handle = runOperation({ environmentId, input }, setRecoveryEvent);
      recoveryHandleRef.current = handle;
      void handle.result.finally(() => {
        if (recoveryHandleRef.current === handle) recoveryHandleRef.current = null;
        setMergeOperationRunning(false);
      });
    },
    [environmentId, runOperation],
  );
  const cancelRecovery = useCallback(() => {
    recoveryHandleRef.current?.cancel();
  }, []);
  const stripDisabledReason =
    (mergeAvailable ? null : GIT_MANAGER_STASH_MERGE_DISABLED_REASON) ??
    (mergeOperationRunning ? "A merge is running." : vcsBusy ? BUSY_REASON : null);
```

    (`BUSY_REASON` = "Git action in progress.", exported from `SourceControlPrimaryAction.logic.ts`; `GitManagerOperationHandle`/`GitManagerOperationEvent` types from `~/state/gitManager` and `@bibcode/contracts`.) Set the Stage all button `title` to "A merge is running." when `mergeOperationRunning`.
  - Above the file sections, when `mergeInProgress && recoveryScope !== null`:

```tsx
        <GitManagerOperationBanner operation={recoveryEvent} onCancel={cancelRecovery} />
        <GitManagerInProgressStrip
          blocked={null}
          continueDisabledReason={
            groups.conflicted.length > 0 ? "Resolve and stage every conflicted file first." : null
          }
          continueLabel="Commit merge"
          disabledReason={stripDisabledReason}
          operation={{ kind: "merge", current: null, total: null }}
          onAbort={() => runRecovery({ _tag: "abort", ...recoveryScope, operation: "merge" })}
          onContinue={() => runRecovery({ _tag: "continue", ...recoveryScope, operation: "merge" })}
        />
```

    and, when `groups.conflicted.length > 0 && recoveryScope !== null`, `<SourceControlMergeChanges files={groups.conflicted} disabled={isBusy || !mergeAvailable} onOpenInEditor={onOpenExternalEditor} onResolve={(path, side) => runRecovery({ _tag: "resolve-conflict", ...recoveryScope, path, side })} />`. A `failed` recovery event stays visible in the banner (`GitManagerOperationBanner` renders failures) until the next operation; add a panel test that a failed Continue shows its message.
  - Hide the stacked-commit primary button and the commit menu group while `mergeInProgress` (render nothing for the primary `Button` + `Menu` block when `hasAreas && mergeInProgress`), so the merge completes only through `continue`.

- [ ] **Step 5: Run** — the two test files, then `src/components/` folder → PASS; root typecheck → PASS.

- [ ] **Step 6: Reviews** — `/vercel-react-best-practices` and `UI.md` on `SourceControlPanel.tsx` and `SourceControlMergeChanges.tsx`.

- [ ] **Step 7: Commit** (commit protocol), message `feat(web): resolve and finish merges from the Source Control panel`.

---

### Task 12: Documentation, changelog, runbooks, full gates

**Files:**
- Modify: `docs/user/workspace-ui.md` (Merge section ~636-648; Source Control section ~931-972)
- Modify: `docs/architecture/rpc-and-orchestration.md` (~421-427 Git Manager operations)
- Modify: `docs/architecture/overview.md:1362-1365`
- Modify: `docs/integrations/source-control-providers.md:294-314, 416-418`
- Modify: `CHANGELOG.md` (Unreleased)
- Modify: `docs/superpowers/specs/2026-10-08-merge-into-and-source-control-merge-design.md` ("Failure codes": new codes are `operation_error` string codes, not `GitManagerFailureCode` values)
- Review: `docs/testing/` runbooks

- [ ] **Step 1: Write docs**
  - `overview.md`, append to the force-push/`update-ref` bullet: "`merge-into` publishes its merge commit with fast-forward-only `git fetch . <commit>:refs/heads/<target>`, which Git refuses for a branch checked out, rebased, or bisected in any worktree; it never uses `update-ref`."
  - `rpc-and-orchestration.md`: document the `merge-into` operation (plumbing steps, failure codes, capability `gitManagerMergeIntoOperations`), the optional preview `target`, and `vcs.status` `operationInProgress` / `"conflicted"` (one entry per path, unstaged area), plus the admission-order rule (cwd mutation guard held from snapshot to execution).
  - `workspace-ui.md`: Merge dialog **Into** picker (default current branch; other targets are updated without checkout; Squash hidden; conflicts refused with the check-out hint; commit hooks don't run; signing honoured), remote sources; Source Control "Merge into current branch…" (gating reasons, Fetch, merge commit only, strip with Commit merge/Abort, Merge Changes Ours/Theirs).
  - `source-control-providers.md`: update the Source Control panel action list.
  - `CHANGELOG.md` Unreleased: two user-facing bullets (merge into another branch; merge from Source Control with conflict resolution) and one fix bullet (status no longer breaks during merge conflicts).
- [ ] **Step 2: Runbooks** — read `docs/testing/README.md` and the native runbooks for packaged UI flows that cover the merge dialog or Source Control panel; update any affected procedure, otherwise record "reviewed and remain accurate" in the final report.
- [ ] **Step 3: Full gates** (serialized):

```bash
cd /work/workspaces/bibcode/BibCode/Merge-to-from
node scripts/run-local-vp.mjs check
node scripts/run-local-vp.mjs run typecheck
node scripts/run-local-vp.mjs run test
cd apps/server && cargo fmt --all --check && CARGO_BUILD_JOBS=4 cargo clippy --all-targets -- -D warnings && CARGO_BUILD_JOBS=4 cargo test
```

Expected: all PASS. Any failure is fixed in the task that owns the code, not papered over here.
- [ ] **Step 4: Final diff review** — `git diff main...HEAD --stat`, `git status --short` (only `reports/` and `research_notes/` untracked).
- [ ] **Step 5: Commit** (commit protocol), message `docs: document merge-into and Source Control merge`.
