# Git Manager / Phase 07 — Server branch and sync operations (streaming)

> **For agentic workers:** REQUIRED SUB-SKILL: invoke `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` before touching code. Atomic steps use checkbox (`- [ ]`) syntax for tracking — tick them off in this file as you go.

**Goal:** Execute every branch-lifecycle and sync operation on the server behind one guarded, cancellable streaming RPC that emits stable started/output/finished/failed events.

**Architecture:** This is Slice 3's server half in `git-manager-plan.md`. `apps/server/src/git/manager/operations.rs` gains the operation executor: it rejects a second concurrent operation on the same repository with `operation-in-flight`, acquires the worktree catalog's **existing** project→repository lock (`WorktreeCatalogService::with_project_mutation_lock_cancellation`), re-validates PHASE-02's guards under that lock, opens the status broadcaster's mutation fence (`StatusBroadcaster::begin_mutation`), then runs the git command lines from `research/github-desktop-analysis.md` § 3.5–3.6 through the supervised process path. The handler in `apps/server/src/production/git_manager_rpc.rs` mirrors the existing `stacked_action_stream` shape in `apps/server/src/production/git_vcs.rs` (indicative :1330 — re-verify). Occupancy is never inferred from stderr; stderr is classified only to label a failure.

**Tech Stack:** Rust 2021 / Axum / Tokio — apps/server. Build: `cargo build -p bibcode-server`. Test: `cargo test -p bibcode-server`. Lint: `cargo clippy -p bibcode-server --all-targets -- -D warnings`. Format: `cargo fmt --all --check`. Inline `#[cfg(test)]` unit tests; integration tests in `apps/server/tests/`.

---

## Files

- **Modify:** `apps/server/src/git/manager/operations.rs` — the in-flight registry, the branch/sync executor, and the stderr→code classification table.
- **Modify:** `apps/server/src/git/repository.rs` — add the branch-delete, fetch, non-`--ff-only` pull, push/publish/force-push-with-lease primitives (do not change existing `pull_current_branch`, `push_current_branch`, `switch_ref`, `create_ref`, `rename_ref` signatures; existing callers depend on them).
- **Modify:** `apps/server/src/production/git_manager_rpc.rs` — replace the `gitManager.runOperation` stub handler with the real streaming handler and add the catalog handle to its services struct.
- **Modify:** `apps/server/src/production/runtime.rs` — pass `WorktreeCatalogService` into the Git Manager RPC services if PHASE-01 did not already.
- **Modify:** `apps/server/tests/production_git_manager_rpc.rs` — integration coverage for the stream event order, the blocked path and cancellation. Create the file if PHASE-01 did not.

## Dependencies

- Phase 00: Wire contracts for the whole feature
- Phase 01: Server read modules and read RPCs
- Phase 02: Pure guards module

## Owner Agent

`general-purpose`

## Risk / Effort

Risk: High. Effort: ~3 h.

---

## Skills to Invoke (teammate-side)

Invoke these skills via the `Skill` tool BEFORE doing any work. Order matters: always-on first, then matched.

**Always-on (every phase):**

1. `Skill(skill="superpowers:using-superpowers")` — establish skill discipline
2. `Skill(skill="superpowers:subagent-driven-development")` — execution discipline for this phase
3. `Skill(skill="superpowers:test-driven-development")` — red-green-refactor for the new tests
4. `Skill(skill="superpowers:verification-before-completion")` — required gate before marking complete

_(no domain-specific matches for this phase in the current skill inventory; always-on superpowers cover it)_

## Documents to Read

- `AGENTS.md` — repo-wide required pre-work, evidence and completion rules.
- `docs/plans/git-manager/git-manager-spec.md` — scope and constraints; § 7 is the guard table this phase enforces.
- `docs/plans/git-manager/git-manager-plan.md` — architecture and global constraints; the Server section governs locking, the mutation fence and log hygiene.
- `docs/plans/git-manager/research/github-desktop-analysis.md` — § 3.5 and § 3.6 carry the exact command lines this phase must run.
- `docs/plans/git-manager/research/worktree-checkout-restrictions.md` — § A is the empirical refusal table; § A.2 lists the escape hatches that are forbidden.
- `docs/architecture/rpc-and-orchestration.md` — stream handler and admission-lease conventions.
- `docs/architecture/worktree-catalog.md` — the lock this phase reuses and its acquisition order.
- `docs/reference/scripts.md` — the exact command names used below.

---

## Pre-execution check

- [ ] **Step 07.0: Claim the phase.** Open `../tasks.md`. Change Phase 07 row → `Status = in_progress`, `Agent = phase-07`, `Started = YYYY-MM-DD HH:MM`. Append a "started — picked up" entry under your Detailed Progress section.

## Atomic steps

- [ ] **Step 07.1: Locate the surface area being changed.**

  ```bash
  rg -n "gitManager" apps/server/src/rpc/methods.rs apps/server/src/auth/scope.rs
  rg -n "fn |pub struct" apps/server/src/production/git_manager_rpc.rs
  rg -n "fn |pub struct|pub enum" apps/server/src/git/manager/operations.rs apps/server/src/git/manager/guards.rs
  sed -n '1330,1435p' apps/server/src/production/git_vcs.rs
  sed -n '1567,1675p' apps/server/src/worktree_catalog/service.rs
  rg -n "fn git_environment|fn execute_with_environment|fn run\(" apps/server/src/git/repository.rs
  ```

  Three preconditions to confirm before writing code, each a stop-and-record item in `tasks.md` if it fails:
  1.  `gitManager.runOperation` (verify the exact name in the landed `packages/contracts/src/gitManager.ts`) is present in `ACTIVE_RPC_METHODS` **and** already has a stub handler registered — `RpcRegistry::validate_complete()` (`apps/server/src/rpc/session.rs`, indicative :468) fails server startup for any declared method without one.
  2.  The request schema carries **both** `cwd` and `projectId`. The catalog lock is keyed by project id and the worktree catalog exposes no cwd→project accessor; without `projectId` the lock cannot be acquired. If it is missing, escalate through `tasks.md` — the schema lives in PHASE-00.
  3.  The helpers `guard_git_path`, `await_git_rpc_operation`, `send_event`, `decode`, `request_error` and `STREAM_CAPACITY` in `apps/server/src/production/git_vcs.rs` are `pub(crate)`. If PHASE-01 left them private, widen the visibility rather than duplicating them.

- [ ] **Step 07.2: Author the first failing test.**

  Path: `apps/server/src/git/manager/operations.rs` (inline `#[cfg(test)] mod tests`)

  ```rust
  #[test]
  fn a_second_operation_on_the_same_repository_is_rejected_as_in_flight() {
      let registry = GitManagerOperationRegistry::default();
      let first = registry
          .try_begin(Path::new("/repo/.git"))
          .expect("first operation is admitted");
      assert!(registry.try_begin(Path::new("/repo/.git")).is_none());
      drop(first);
      assert!(registry.try_begin(Path::new("/repo/.git")).is_some());
  }
  ```

- [ ] **Step 07.3: Run the new test; expect FAIL** (the type does not exist yet).

  ```bash
  cargo test -p bibcode-server a_second_operation_on_the_same_repository_is_rejected_as_in_flight
  ```

- [ ] **Step 07.4: Implement the minimum to make Step 07.2 pass.**

  In `apps/server/src/git/manager/operations.rs` add `GitManagerOperationRegistry` — a `Mutex<HashSet<PathBuf>>` keyed by the **canonical common dir** — with `try_begin(&self, repository_key: &Path) -> Option<GitManagerOperationLease>`; the lease removes its key on `Drop`. This is not a second serialisation lock: serialisation stays with the catalog lock. The registry only makes the "another operation is running" condition observable so it can be rejected fast (`operation-in-flight`) instead of queued, and it is the in-progress-operation input PHASE-02's guards already take.

- [ ] **Step 07.5: Run the test; expect PASS.**

- [ ] **Step 07.6: Add the failure-classification table.** Add `classify_operation_failure(exit_code: i32, stderr: &str) -> GitManagerFailureCode` with codes `authentication`, `non-fast-forward`, `stale-info`, `local-changes-overwritten`, `conflicts`, `no-upstream`, `cancelled`, `timed-out`, `unknown`. Match case-insensitively on: `authentication failed` / `could not read username` / `could not read password` / `permission denied (publickey)`; `non-fast-forward` / `updates were rejected`; `stale info`; `your local changes to the following files would be overwritten`; `conflict (` / `automatic merge failed`; `there is no tracking information`. One unit test per code plus a fallback test. **This table is for error reporting only** — occupancy and every other guard condition are pre-computed (spec § 7); a reviewer finding occupancy inferred from stderr rejects the change.

- [ ] **Step 07.7: Add the git primitives to `repository.rs`, one failing test each.** Use the exact command lines below; each runs through the existing `self.run(...)` / `self.execute(...)` path so it inherits the supervised runner, the timeout, the output cap, the cancellation token and `git_environment()` (`GIT_TERMINAL_PROMPT=0`, empty `GIT_ASKPASS`, `SSH_ASKPASS_REQUIRE=never`, `GIT_CONFIG_NOSYSTEM=1`).

  | Operation                | Command line                                                                                                                                                                                                                                                                   |
  | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
  | branch create            | `git branch <name> [<start-point>] --no-track`; with checkout `git switch -c <name> [<start-point>]`                                                                                                                                                                           |
  | checkout local           | `git switch <name>`                                                                                                                                                                                                                                                            |
  | checkout remote-tracking | `git switch -c <local> --track <remote>/<branch>`                                                                                                                                                                                                                              |
  | branch rename            | `git branch -m <old> <new>`, retried as `git branch -M <old> <new>` for a case-only rename                                                                                                                                                                                     |
  | branch delete            | `git branch -d <name>`, or `git branch -D <name>` only when the caller passed the force flag                                                                                                                                                                                   |
  | remote branch delete     | `git push <remote> :<branch>` — never `update-ref -d`                                                                                                                                                                                                                          |
  | fetch                    | `git fetch --prune --recurse-submodules=on-demand <remote>`                                                                                                                                                                                                                    |
  | pull                     | `git -c rebase.backend=merge pull --recurse-submodules <remote>`, adding `--ff` only when both `pull.ff` and `pull.rebase` are unset (read them with `git config --get`). No explicit branch argument — pull targets the current branch's configured upstream (research § 3.6) |
  | push                     | `git push <remote> <local>[:<remote-branch>]`                                                                                                                                                                                                                                  |
  | publish branch           | the push line plus `--set-upstream`                                                                                                                                                                                                                                            |
  | force push               | the push line plus `--force-with-lease`                                                                                                                                                                                                                                        |

  Forbidden anywhere in this phase: bare `--force`, `--ignore-other-worktrees`, `git worktree add -f`, plumbing `update-ref`. Omit `--progress`: output is captured on completion, not streamed, so `--progress` only fills the output cap with carriage-return spam.

- [ ] **Step 07.8: Implement the executor.** In `operations.rs` add `run_branch_or_sync_operation(...)` performing, in this order: (1) `registry.try_begin(repository_key)` → `operation-in-flight` on `None`; (2) `catalog.with_project_mutation_lock_cancellation(&project_id, &cancellation, ...)`; (3) inside the lock, re-read the refs snapshot and re-run PHASE-02's guard evaluation, returning a structured `GitManagerOperationError` carrying `{ operation, code, message }` if the operation is now blocked — never raw stderr for a guard condition; (4) `broadcaster.begin_mutation(&cwd)` and `mutation.finish()` around the git calls; (5) execute; (6) classify a failure with Step 07.6. Log stable codes plus lengths and counts only: never interpolate a branch name, ref name, absolute path, remote URL or git stderr into a log string.

- [ ] **Step 07.9: Implement the streaming handler.** In `apps/server/src/production/git_manager_rpc.rs` replace the stub with a handler modelled on `stacked_action_stream`: decode the payload, take the workspace admission lease via `guard_git_path`, emit `started`, run the executor, emit one `output` event per completed underlying git command (capped stdout/stderr from `ProcessOutput`), then `finished` or `failed`. Register it with `registry.register_stream(...)`. Cancellation of the RPC must cancel the child process through the operation's `CancellationToken` child.

- [ ] **Step 07.10: Add the remaining tests.** One at a time, each failing first:
  - event order is exactly `started` → `output`* → `finished` for a successful fetch;
  - a guard-blocked checkout emits `started` → `failed` with the server-authored message and no git process spawned;
  - a second concurrent operation on the same repository fails with `operation-in-flight` while the first is still running;
  - cancelling the stream terminates the child and emits `failed` with code `cancelled`;
  - force-push builds an argument vector containing `--force-with-lease` and **not** `--force`;
  - a delete of a branch held by a registered worktree whose directory is missing is blocked with the prune-first message (research § A.3).

- [ ] **Step 07.11: Full build + test gate.**

  ```bash
  cargo fmt --all --check
  cargo test -p bibcode-server
  cargo clippy -p bibcode-server --all-targets -- -D warnings
  vp check
  vp run typecheck
  ```

  Expected: zero warnings, zero errors, all tests green.

- [ ] **Step 07.12: Stack-specific verification.** Against a scratch repository with a linked worktree, exercise fetch, pull, push, publish-branch, branch create/rename/delete and an occupied-branch checkout through the RPC, and confirm the blocked cases never spawn git. Repeat against a remote-hosted project (spec § 10 requires both).

- [ ] **Step 07.13: TDD proof.** Temporarily make `classify_operation_failure` return `GitManagerFailureCode::Unknown` unconditionally and make `try_begin` always return `Some`. Re-run `cargo test -p bibcode-server` and confirm the classification and in-flight tests fail. Restore both and re-run.

- [ ] **Step 07.14: Mark phase complete.** Change Phase 07 row in `tasks.md` → `Status = completed`, `Finished = YYYY-MM-DD HH:MM`. Append a final summary entry: what was delivered, how many tests landed, any deviations from the plan.

> **No commit step.** This decomposition is commit-free: no phase ever produces or requests a git commit. Whether and when to commit the resulting work is a decision the user makes after execution, outside the scope of any phase.

---

## Verification

- [ ] Every branch and sync operation runs under the catalog's existing project→repository lock; no second lock was introduced.
- [ ] A concurrent operation on the same repository is rejected with `operation-in-flight` and never queued.
- [ ] Guards are re-validated under the lock; a stale client receives a structured `{ operation, code, message }` error, not raw stderr.
- [ ] Force push uses `--force-with-lease`; `rg -n -- "--force\b|--ignore-other-worktrees|worktree add -f|update-ref" apps/server/src/git` finds no new occurrence from this phase.
- [ ] Every new git invocation goes through the supervised path with timeout, output cap and cancellation, and through `git_environment()`.
- [ ] Log strings contain no branch name, ref name, absolute path, remote URL or git stderr.
- [ ] All new tests green; `cargo test -p bibcode-server` passes.
- [ ] `cargo fmt --all --check` clean; `cargo clippy -p bibcode-server --all-targets -- -D warnings` clean; `vp check` and `vp run typecheck` clean.
- [ ] **Zero-telemetry check:** this phase added no analytics, crash reporting, usage counters, remote feature flags, avatar or identity fetches, third-party host contact, and no new crate in `apps/server/Cargo.toml`. The only outbound traffic is the user-initiated git network operation against the repository's own configured remote.
- [ ] Final `git diff` and `git status --short` reviewed for unintended edits, generated files, debug output and dependency drift.
- [ ] TDD-proof step performed and described in the per-phase notes.

## Notes for downstream phases

- **`GitManagerOperationRegistry`** (`apps/server/src/git/manager/operations.rs`) with `try_begin(&Path) -> Option<GitManagerOperationLease>` keyed by canonical common dir is the single in-flight source of truth. **PHASE-09 and PHASE-13 must reuse it**, not add their own; it is also the in-progress-operation input to PHASE-02's guards.
- **`classify_operation_failure(exit_code, stderr) -> GitManagerFailureCode`** is the only stderr matcher in the feature. PHASE-09 and PHASE-13 extend its code list; they must not add a second matcher and must not use it for occupancy.
- **`run_branch_or_sync_operation`** establishes the mandatory order: in-flight registry → catalog lock → guard re-validation → `begin_mutation` → execute → `mutation.finish()`. PHASE-09, PHASE-11 and PHASE-13 follow the same order.
- **Stream event contract for PHASE-10:** `gitManager.runOperation` emits `started`, zero or more `output` (one per completed underlying git command, carrying capped `stdout`/`stderr`), then exactly one of `finished` / `failed`. `failed` carries `{ operation, code, message }`.
- **Client tag union correction:** `gitManager.runOperation` is a streaming _command_, so it belongs in `EnvironmentStreamCommandRpcTag` (`packages/client-runtime/src/rpc/client.ts`, indicative :60) beside `gitRunStackedAction` — **not** in `EnvironmentSubscriptionRpcTag`. The brief's generic wording is imprecise here.
- **Divergence recorded:** the supervised process path (`apps/server/src/process/supervised.rs`) has no incremental output observer, so per-line `--progress` streaming is deliberately out of scope. Adding one would change shared process infrastructure and needs its own change.
- **Divergence recorded:** the maintenance classification (`apps/server/src/maintenance.rs`) derives mutability from `ACTIVE_RPC_METHODS` via `method_mutability` (`apps/server/src/rpc/methods.rs`, indicative :161). No separate maintenance allowlist edit is needed for any `gitManager.*` method.
