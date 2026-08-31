# Git Manager / Phase 02 — Pure guards module

> **For agentic workers:** REQUIRED SUB-SKILL: invoke `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` before touching code. Atomic steps use checkbox (`- [ ]`) syntax for tracking — tick them off in this file as you go.

**Goal:** Implement `apps/server/src/git/manager/guards.rs` as a pure function that turns repository state into the server-authored blocked reasons every ref and operation carries.

**Architecture:** One pure module, no I/O, no async, no RPC or registry imports. It takes parsed refs, the worktree inventory, the dirty flag, the default branch, the in-progress-operation state and the lock state, and returns the blocked list per ref as `{ operation, code, message }`. Purity is the point: it is unit-tested without a repository, and it lets this phase run in parallel with PHASE-01 because it touches no shared registry file. It is the single source of truth for "why is this control disabled" — the client renders `message` verbatim and derives no git policy. Implements the master plan's § Server (Guards) and spec § 7.

**Tech Stack:** Rust 2021 / Axum / Tokio — apps/server. Build: `cargo build -p bibcode-server`. Test: `cargo test -p bibcode-server`. Lint: `cargo clippy -p bibcode-server --all-targets -- -D warnings`. Format: `cargo fmt --all --check`. Inline `#[cfg(test)]` unit tests; integration tests in `apps/server/tests/`.

---

## Files

- **Modify:** `apps/server/src/git/manager/guards.rs` — the pure guard evaluation and its inline unit tests (skeleton created by PHASE-00)

**Nothing else.** This phase must not edit `apps/server/src/git/mod.rs`, `apps/server/src/git/manager/mod.rs`, any `production/*_rpc.rs`, `apps/server/src/rpc/methods.rs`, `apps/server/src/auth/scope.rs`, or `packages/contracts/`. PHASE-00 already declared the module. If a re-export is genuinely missing, record it in `tasks.md` and let the coordinator assign it — do not add it here, because PHASE-01 is editing `git/mod.rs` in the same round.

## Dependencies

- Phase 00: Wire contracts for the whole feature

## Owner Agent

`general-purpose`

## Risk / Effort

Risk: Medium. Effort: ~2 h.

---

## Skills to Invoke (teammate-side)

Invoke these skills via the `Skill` tool BEFORE doing any work. Order matters: always-on first, then matched.

**Always-on (every phase):**

1. `Skill(skill="superpowers:using-superpowers")` — establish skill discipline
2. `Skill(skill="superpowers:subagent-driven-development")` — execution discipline for this phase
3. `Skill(skill="superpowers:test-driven-development")` — red-green-refactor for the new tests
4. `Skill(skill="superpowers:verification-before-completion")` — required gate before marking complete

**Matched for this phase:**

5. `Skill(skill="codebase-design")` — *the guard function is the feature's deepest single-purpose interface*

## Documents to Read

- `AGENTS.md` — repo-wide required pre-work, evidence and completion rules
- `docs/plans/git-manager/git-manager-spec.md` — scope and constraints (§ 7 is the normative guard table)
- `docs/plans/git-manager/git-manager-plan.md` — architecture and global constraints (§ Server, Guards)
- `docs/plans/git-manager/research/worktree-checkout-restrictions.md` — the empirically verified refusal behaviour, the missing-directory case (§ A.3), and the suggested message wording (§ Recommended guard set)
- `docs/architecture/worktree-catalog.md` — what the worktree inventory carries, including `directory_state` for a registration whose directory is gone
- `docs/plans/git-manager/phases/PHASE-00-contracts.md` § Notes for downstream phases — `GitManagerBlockedCode` and the `{ operation, code, message }` shape

If a file does not exist, report it back in the per-phase notes section of `tasks.md` and continue with what's available.

---

## Pre-execution check

- [ ] **Step 02.0: Claim the phase.** Open `../tasks.md`. Change Phase 02 row → `Status = in_progress`, `Agent = phase-02`, `Started = YYYY-MM-DD HH:MM`. Append a "started — picked up" entry under your Detailed Progress section.

## Atomic steps

- [ ] **Step 02.1: Locate the surface area being changed.** Line numbers are indicative; re-verify.

	```bash
	rg -n 'GitManagerBlockedCode|GitManagerBlockedReason' packages/contracts/src/gitManager.ts
	rg -n 'pub struct WorktreeDescriptor' -A20 apps/server/src/worktree_catalog/model.rs
	cat apps/server/src/git/manager/guards.rs
	```

	Confirm the nine codes PHASE-00 declared: `worktree-checked-out`, `dirty-working-tree`, `operation-in-flight`, `merge-in-progress`, `current-branch`, `default-branch`, `no-upstream`, `detached-head`, `no-remote`. If the working tree disagrees with this list, the working tree wins — record the deviation in `tasks.md`.

- [ ] **Step 02.2: Author the first failing test.** Path: `apps/server/src/git/manager/guards.rs` (inline `#[cfg(test)]`)

	```rust
	#[test]
	fn checkout_of_a_branch_held_by_another_worktree_is_blocked() {
	    let input = GuardInput {
	        refs: vec![branch("feature", Occupancy::Worktree("/repo/wt-feature"))],
	        dirty: false,
	        default_branch: Some("main".into()),
	        current_branch: Some("main".into()),
	        in_progress: None,
	        lock_held: false,
	    };
	    let blocked = evaluate_guards(&input);
	    let reason = blocked["feature"]
	        .iter()
	        .find(|reason| reason.operation == "checkout")
	        .expect("checkout is blocked");
	    assert_eq!(reason.code, BlockedCode::WorktreeCheckedOut);
	    assert!(reason.message.contains("/repo/wt-feature"));
	}
	```

- [ ] **Step 02.3: Run the new test; expect FAIL** (`evaluate_guards` and its input types do not exist).

	```bash
	cargo test -p bibcode-server git::manager::guards
	```

- [ ] **Step 02.4: Implement the minimum to make Step 02.2 pass.** Path: `apps/server/src/git/manager/guards.rs`. Define `GuardInput`, `GuardedRef`, `Occupancy`, `BlockedCode`, `BlockedReason { operation, code, message }`, and `pub fn evaluate_guards(input: &GuardInput) -> BTreeMap<String, Vec<BlockedReason>>`. No `async`, no `tokio`, no `std::fs`, no `Command`, no imports from `crate::production` or `crate::rpc`.

- [ ] **Step 02.5: Run the test; expect PASS.**

- [ ] **Step 02.6+: Add one failing test per remaining case, in this order.** Each fails first, then passes.

	| Test | Operation | Code | Required message content |
	| --- | --- | --- | --- |
	| already the current branch here | `checkout` | `current-branch` | "Already checked out." |
	| dirty working tree | `checkout`, `merge`, `rebase` | `dirty-working-tree` | names the uncommitted changes |
	| delete a branch held by a worktree | `delete-branch` | `worktree-checked-out` | names the worktree path |
	| delete a branch whose worktree directory is **missing** | `delete-branch` | `worktree-checked-out` | says the worktree must be removed or pruned first |
	| delete the current branch | `delete-branch` | `current-branch` | states it is the current branch |
	| delete the default branch | `delete-branch` | `default-branch` | states it is the default branch |
	| rename a branch held by another worktree | `rename-branch` | `worktree-checked-out` | names the worktree path (app-policy: git would allow it) |
	| force-move / reset a held branch | `force-move`, `reset` | `worktree-checked-out` | names the worktree path |
	| pull/fetch into a held destination branch | `fetch`, `pull` | `worktree-checked-out` | names the worktree path |
	| any mutation while the repository lock is held | every mutating operation | `operation-in-flight` | names the running operation |
	| any mutation while a merge/rebase/cherry-pick is in progress | every mutating operation except resolve/abort | `merge-in-progress` | names the pending operation |
	| push with no upstream | `push` | `no-upstream` | states the branch has no upstream |
	| push/fetch/pull with no remote configured | `push`, `fetch`, `pull` | `no-remote` | states no remote is configured |
	| any branch operation while HEAD is detached | `commit-to-branch` | `detached-head` | states HEAD is detached |
	| **negative case** — a clean, non-current local branch with an upstream, no lock, no in-progress operation | — | — | the blocked list is **empty** |

	Notes that must hold in the implementation:
	- Occupancy counts **registered** worktrees, including one whose directory is missing (research § A.3). A prunable registration produces the prune-first message, not the plain one.
	- The resolve/abort path is exempt from `merge-in-progress` — otherwise the user cannot get out of a conflicted state.
	- Renaming a held branch is blocked as **app policy**, not because git refuses it; git allows the rename and silently retargets the other worktree's HEAD (spec § 7.2).
	- Messages are the user-facing text. They are payload, never a log line.

- [ ] **Step 02.k-3: Full build + test gate.**

	```bash
	cargo fmt --all --check
	cargo test -p bibcode-server git::manager::guards
	cargo test -p bibcode-server
	cargo clippy -p bibcode-server --all-targets -- -D warnings
	vp check
	vp run typecheck
	```

	Expected: zero warnings, zero errors, all tests green.

- [ ] **Step 02.k-2: Purity and isolation check.**

	```bash
	rg -n 'async|tokio|std::fs|std::process|Command|crate::production|crate::rpc|CancellationToken' apps/server/src/git/manager/guards.rs
	git status --short
	```

	The first command must return nothing. `git status --short` must show `apps/server/src/git/manager/guards.rs` as the only file this phase changed.

- [ ] **Step 02.k: TDD proof.** Make `evaluate_guards` return an empty map unconditionally. Re-run `cargo test -p bibcode-server git::manager::guards` and confirm every positive case fails while the negative case still passes. Then make it return one hard-coded reason for every ref and confirm the negative case fails. Restore.

- [ ] **Step 02.k+1: Mark phase complete.** Change Phase 02 row in `tasks.md` → `Status = completed`, `Finished = YYYY-MM-DD HH:MM`. Append a final summary: what landed, how many tests, and the exact `evaluate_guards` signature so PHASE-07 can call it without re-reading the module.

> **No commit step.** This skill is commit-free: no phase ever produces or requests a git commit. Whether and when to commit the resulting work is a decision the user makes after execution, outside the scope of any phase.

---

## Verification

- [ ] Every one of the nine `GitManagerBlockedCode` values is produced by at least one unit test, and the negative case asserts an **empty** blocked list.
- [ ] The missing-worktree-directory delete case is covered and produces the prune-first message.
- [ ] The rename-of-a-held-branch case is covered and is documented in code as app policy, not a git refusal.
- [ ] `evaluate_guards` is pure: no `async`, no filesystem, no process, no RPC/registry imports (proven by the Step 02.k-2 grep).
- [ ] `guards.rs` is the **only** file this phase changed — no conflict with PHASE-01 or PHASE-03 in the same round.
- [ ] No message is written to a log; messages are payload only.
- [ ] `cargo fmt --all --check`, `cargo test -p bibcode-server`, `cargo clippy -p bibcode-server --all-targets -- -D warnings` clean; `vp check` and `vp run typecheck` clean.
- [ ] **Zero telemetry:** this phase adds no analytics, crash reporting, usage counter, remote feature flag, avatar/identity fetch, third-party host contact, or new dependency. `git diff apps/server/Cargo.toml Cargo.lock` shows no change.
- [ ] Final `git diff` and `git status --short` review: no generated files, no debug output, no unrelated edits.
- [ ] TDD-proof step performed and described in the per-phase notes.

## Notes for downstream phases

- **The public entry point is `git::manager::guards::evaluate_guards(&GuardInput) -> BTreeMap<String, Vec<BlockedReason>>`**, keyed by short ref name. Keep the name and shape stable; PHASE-07, PHASE-09 and PHASE-13 all call it.
- **`GuardInput` fields** are `refs`, `dirty`, `default_branch`, `current_branch`, `in_progress`, `lock_held`. PHASE-01's `refs.rs` already assembles every one of them; PHASE-07 is responsible for joining `evaluate_guards`'s output into `GitManagerRefEntry.blocked` before the snapshot leaves the server.
- **Guards are advisory until re-validated.** PHASE-07/09/13 must call `evaluate_guards` a second time **under the repository lock, immediately before execution**, and reject a stale client with a structured `GitManagerOperationError` carrying the blocked reason — never raw stderr.
- **Lock state comes from the worktree catalog's existing lock**, `WorktreeCatalogService::with_project_mutation_lock` / `with_project_mutation_lock_cancellation` (apps/server/src/worktree_catalog/service.rs, indicative :1567-1592), which acquires the project lock first and then the repository lock keyed by the canonical common dir. It is keyed by **`project_id`, not `cwd`** — the phase that wires operations owns the cwd→project resolution. Introduce no second lock.
- **`lock_held: true` must yield `operation-in-flight` for every mutating operation**, and the operation is **rejected, never queued**.
- **The client never re-derives any of this.** `apps/web` renders `message` verbatim, exposes it through both a tooltip and `aria-describedby` on the disabled control, and fails closed on an unknown code.
