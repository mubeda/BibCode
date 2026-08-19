# Git Manager / Phase 04 — Streaming repository operations

> **For agentic workers:** REQUIRED SUB-SKILL: invoke `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` before touching code. Atomic steps use checkbox (`- [ ]`) syntax — tick them off in this file as you go.

**Goal:** Execute every Git Manager mutation through one cancellable, per-repository-serialized streaming RPC that reports progress, classifies failures, and never leaves a lock or a prompt hanging.

**Architecture:** Implements § "Phase 5 — Mutating operations, progress, serialization" of `../master-plan.md`. A new `apps/server/src/git/operations.rs` owns the tagged operation executor, the per-repository lock, and failure classification; `git.runRepositoryOperation` is dispatched from `git_vcs.rs` following the existing `git.runStackedAction` streaming handler. This is the only Round 2 phase touching the Rust registries.

**Tech Stack:** Rust (Axum/Tokio). Build: `cargo build -p bibcode-server`. Test: `cargo test -p bibcode-server git::operations`. Lint: `cargo clippy -p bibcode-server --all-targets -- -D warnings`. Format: `cargo fmt --all --check`.

---

## Files

- **Create:** `apps/server/src/git/operations.rs` — operation executor, lock acquisition over the catalog's repository lock, `operation_kind()`, failure classification (with unit tests).
- **Modify:** `apps/server/src/git/mod.rs` — declare the module.
- **Modify:** `apps/server/src/git/repository.rs` — extend `push_current_branch` (or add a sibling) with `remote` / `force` / `pushTags`; the current signature supports none of them.
- **Modify:** `apps/server/src/worktree_catalog/service.rs` — only if the repository lock must be exposed for reuse; keep the change minimal and do not alter the catalog's own acquisition order.
- **Modify:** `apps/server/src/production/git_vcs.rs` — stream handler for `git.runRepositoryOperation`, add it to `GIT_VCS_STREAM_METHODS`, plus RPC-level tests.
- **Modify:** `apps/server/src/rpc/methods.rs` — register the streaming method.
- **Modify:** `apps/server/src/auth/scope.rs` — map it to the same write scope as `git.runStackedAction`.

## Dependencies

- Phase 00: Wire contracts for the whole feature.
- Phase 01: Server read modules and read RPCs (guards, refs, `mod.rs`).

## Owner Agent

`general-purpose`

## Risk / Effort

Risk: High (destructive git operations, concurrency, cancellation, credential failure modes). Effort: ~3 h.

---

## Skills to Invoke (teammate-side)

**Always-on:**

1. `Skill(skill="superpowers:using-superpowers")` — establish skill discipline
2. `Skill(skill="superpowers:subagent-driven-development")` — execution discipline for this phase
3. `Skill(skill="superpowers:test-driven-development")` — red-green-refactor for the operation and lock tests
4. `Skill(skill="superpowers:verification-before-completion")` — required gate before marking complete

**Matched for this phase:**

5. `Skill(skill="ponytail:ponytail")` — one executor, no per-operation handler zoo
6. `Skill(skill="superpowers:systematic-debugging")` — for the conflict/cancellation paths when a fixture misbehaves

## Documents to Read

- `../master-plan.md` — § Phase 5 in full (operation union, event union, server notes), § Technical Requirements → Server, § Global Constraints.
- `../issue.specs` — § Interview Notes → "Merge conflicts" and "Progress and errors".
- `AGENTS.md` (repo root) — log hygiene, failure/cancellation/concurrency requirements, task completion requirements.
- `docs/architecture/worktree-catalog.md` — mutation arbitration, physical-path identity (the lock key), availability admission.
- `apps/server/src/production/git_vcs.rs:988` — the `git.runStackedAction` streaming handler: decode → `guard_git_path` → child cancellation token → sender events.
- `apps/server/src/git/repository.rs:2727` — `push_current_branch`, and the pull implementation behind `vcs.pull`: the streaming operations must call these, not re-implement remote policy.
- `apps/server/src/git/repository.rs:4258` — `git_environment()`; every network operation must use it.
- `apps/server/src/git/guards.rs` (from Phase 01) — re-validate guards at execution time.

---

## Pre-execution check

- [ ] **Step 04.0: Claim the phase.** Set Phase 04 in `../tasks.md` → `in_progress`, `Agent = phase-04`, `Started = YYYY-MM-DD HH:MM`; append a "picked up" line.

## Atomic steps

- [ ] **Step 04.1: Locate the surface area.**

	```bash
	grep -n "GIT_VCS_STREAM_METHODS\|runStackedAction" apps/server/src/production/git_vcs.rs | head -20
	grep -n "pub async fn push_current_branch\|pub async fn pull" apps/server/src/git/repository.rs
	```

	Read the streaming handler end-to-end, including how it releases admission on every exit path. Note deviations in `../tasks.md`.

- [ ] **Step 04.2: Author the first failing test** in `operations.rs`. Note what is being tested: the operation **reuses the worktree catalog's existing repository lock** rather than introducing a second one, so the test asserts mutual exclusion against that lock, not against a new type:

	```rust
	#[tokio::test]
	async fn rejects_a_second_operation_while_one_is_running_for_the_same_repository() {
	    let repo = fixture_repo().await;
	    let locks = catalog_locks_for_tests();               // the catalog's lock registry
	    let first = acquire_repository_operation(&locks, repo.common_dir())
	        .await
	        .expect("first acquires");
	    let second = acquire_repository_operation(&locks, repo.common_dir()).await;
	    assert!(matches!(second, Err(OperationRejection::InFlight { .. })));
	    drop(first);
	    assert!(acquire_repository_operation(&locks, repo.common_dir()).await.is_ok());
	}
	```

- [ ] **Step 04.3: Run it; expect FAIL** (function not found).

	```bash
	cargo test -p bibcode-server git::operations::
	```

- [ ] **Step 04.4: Implement `acquire_repository_operation` over the catalog's lock.** Read `apps/server/src/worktree_catalog/service.rs:1505-1569` first: the catalog already takes a **project lock** and then an optional **repository lock** keyed by the canonicalized common directory. Git Manager operations must go through that same registry, in that same order, so a push or merge can never interleave with a worktree add/remove on one physical repository. Do **not** add a second, independent lock — two uncoordinated locks over the same resource is the bug this step exists to prevent. Where the catalog's lock is not directly reachable from `operations.rs`, expose it through the service that owns it rather than duplicating the registry. Acquisition returns a guard that releases on drop, including on cancellation and panic; a contended acquire returns `OperationRejection::InFlight` instead of waiting.

- [ ] **Step 04.4b: Add the cross-subsystem exclusion test.** While a Git Manager operation holds the lock, a concurrent worktree-catalog mutation on the same repository must not proceed (and vice versa). This is the test that proves reuse actually bought the guarantee — a test that only exercises two Git Manager operations would pass just as well with a separate lock.

- [ ] **Step 04.5: Run the test; expect PASS.**

- [ ] **Step 04.6: Implement the executor skeleton + fetch.** `run_operation(repository, input, cancellation, sink)` dispatches on the operation tag and emits `started` → `output`* → `finished`/`failed`. Implement `fetch` first (`git fetch [--prune] [--tags] <remote>` via the supervised path and `git_environment()`), streaming stdout/stderr as `output` events. Test against a local bare-repo remote: events arrive in order and `finished` carries a summary.

- [ ] **Step 04.7: Implement `pull` and `push` through `repository.rs`, extending it where it falls short.** Read `push_current_branch` (`repository.rs:2727-2760`) before writing anything: it takes only `cwd` and a cancellation token, resolves the current branch, checks `@{upstream}`, and **hardcodes `origin`** in its set-upstream path. It has no `remote`, `force` or `pushTags` parameter. The Push dialog needs all three, so **extend that method (or add a sibling beside it) in `repository.rs`** — remote policy stays in the module that owns it — and have `operations.rs` call it with progress plumbing only. Copying its body into the executor would fork remote policy and violate `AGENTS.md`'s "keep shared logic in the package that owns it".

	Tests (in `repository.rs` for the new parameters, in `operations.rs` for the streaming behavior): push to a local bare remote succeeds; an explicit non-`origin` remote is honoured; `pushTags` pushes tags; a rejected push classifies as `non-fast-forward`; `force` overrides it; the existing `push_current_branch` callers keep working unchanged.

- [ ] **Step 04.8: Add failure classification + tests.** Map exit status and stderr to `GitRepositoryOperationFailureCode`: credential/permission text → `authentication` (message includes the "configure a credential helper or SSH agent" hint), `non-fast-forward`/`fetch first`/`rejected` → `non-fast-forward`, cancellation → `cancelled`, guard rejection → `blocked`, everything else → `git-error`. Test the auth path with an unreachable remote — with `git_environment()` it must fail fast, never hang. Assert the test completes well inside the process timeout.

- [ ] **Step 04.9: Implement `merge` + the conflict path.** Refuse up front when the working tree is dirty (`blocked`). Run `git merge` with the mode flag (`--no-ff` / `--squash` / `--no-commit` / none). On conflict emit `conflict` with `git diff --name-only --diff-filter=U` paths and stop **without deciding**. Tests: a clean merge finishes; a conflicting merge emits `conflict` and leaves `MERGE_HEAD` present.

- [ ] **Step 04.10: Implement `resolveMergeConflict` + tests.** Accepted **only** while a merge is in progress, and **exempt from the dirty-tree guard**. `abort` runs `git merge --abort` and the fixture returns to its pre-merge head; `keep` leaves the state and returns a summary. Test both, plus rejection with `blocked` when no merge is in progress.

- [ ] **Step 04.11: Implement the ref lifecycle operations + tests** — `createBranch` (with optional checkout), `checkout` (with `createLocalTracking` for a remote branch), `createTag` (annotated when a message is given, optional push), `deleteBranch` (with `force`), `renameBranch`, `deleteTag`. Each re-validates guards from Phase 01 at execution time; a stale client request is rejected with `blocked`, never trusted. Tests: checkout of a branch owned by a worktree is refused; deleting the current or default branch is refused; creating a tag that exists is refused; a remote-branch checkout creates the tracking branch.

- [ ] **Step 04.12: Wire the streaming RPC.** Add `"git.runRepositoryOperation"` to the dispatch in `git_vcs.rs` and to `GIT_VCS_STREAM_METHODS`, taking `guard_git_path` admission and a child cancellation token exactly like `git.runStackedAction`. Register in `rpc/methods.rs` and give it the same write scope as `git.runStackedAction` in `auth/scope.rs`. Add RPC-level tests: malformed payload rejected; an interrupt mid-operation cancels the git process **and leaves no lock held** (re-acquire succeeds afterwards).

- [ ] **Step 04.12b: Add `operation_kind()` — the single owner of the tag→kind translation.** The contracts deliberately use camelCase `_tag` values (`resolveMergeConflict`, `deleteBranch`) and kebab-case `VcsGraphOperationKind` values (`resolve-merge-conflict`, `delete-branch`), and `push { force: true }` maps to the derived kind `force-push`. Implement `pub fn operation_kind(op: &GitRepositoryOperation) -> VcsGraphOperationKind` here and have both the guards and the `runningOperation` summary call it. Nothing else may re-derive the mapping. Test every tag, including the force-push derivation.

- [ ] **Step 04.13: Trigger a refresh on completion.** After any successful mutation, fire the broadcaster's existing immediate-refresh request for that repository so clients revalidate. Test that the request is issued exactly once per completed operation.

- [ ] **Step 04.14: Log-hygiene sweep.**

	```bash
	grep -n "tracing::\|log::" apps/server/src/git/operations.rs
	```

	Codes, counts and lengths only — no branch names, paths, remote URLs, or git stderr text in log strings.

- [ ] **Step 04.15: Full gate.**

	```bash
	cargo fmt --all --check
	cargo clippy -p bibcode-server --all-targets -- -D warnings
	cargo test -p bibcode-server
	```

- [ ] **Step 04.16: TDD proof.** Make the lock's `acquire` always succeed and re-run — the serialization and cancellation tests must fail. Restore, re-run, confirm green.

- [ ] **Step 04.17: Mark complete.** Phase 04 row → `completed`, `Finished = YYYY-MM-DD HH:MM`, plus a summary (operations covered, test count, deviations).

> **No commit step.** This plan is commit-free — including inside the executor: no operation in this phase creates a commit on the user's behalf beyond what `merge` itself produces.

---

## Verification

- [ ] All eleven operation tags execute against fixture repositories and emit `started` → … → `finished`/`failed`.
- [ ] Two concurrent operations on the same repository: the second is rejected with `operation-in-flight`, never queued silently.
- [ ] Serialization goes through the **worktree catalog's existing repository lock**, not a second one, and a concurrent catalog mutation on the same repository is excluded by it (proved by the cross-subsystem test, not just by two Git Manager operations).
- [ ] `push` supports an explicit remote, force, and push-tags — implemented in `repository.rs`, not forked into the executor — and existing `push_current_branch` callers still work.
- [ ] `operation_kind()` is the only place mapping operation tags to `VcsGraphOperationKind`, including `push { force: true }` → `force-push`.
- [ ] Cancellation mid-operation stops the git process and releases the lock (a subsequent acquire succeeds).
- [ ] A merge conflict emits `conflict` with the conflicted paths and does not decide; `abort` restores the pre-merge head; `keep` leaves the state.
- [ ] `resolveMergeConflict` is accepted with a dirty tree and refused when no merge is in progress.
- [ ] An unreachable/denying remote fails fast with `authentication` — no hang, no prompt.
- [ ] Guards are re-validated server-side at execution time; a stale request is rejected with `blocked`.
- [ ] `cargo fmt --all --check`, clippy with `-D warnings`, and `cargo test -p bibcode-server` all clean.
- [ ] No branch name, path, remote URL, or git stderr text in any log string.
- [ ] TDD-proof step performed and described in the per-phase notes.

## Notes for downstream phases

- Phase 09 consumes the event stream. Tell it, in your completion notes, the exact `label` strings you emit for `started` and the summary shape for `finished` — the banner renders them verbatim.
- Phase 07 will edit `broadcaster.rs`, `git_vcs.rs`, `methods.rs` and `scope.rs` next round; leave the registry lists sorted and the stream-method list tidy.
- If you had to add a helper for "is a merge in progress", export it from `refs.rs` (Phase 01's module) rather than duplicating the `MERGE_HEAD` check — the refs snapshot already reports it.
- Any operation you could not implement safely must be reported in `../tasks.md` § Active blockers rather than silently downgraded — Phase 09 and Phase 10 build UI for all of them.
