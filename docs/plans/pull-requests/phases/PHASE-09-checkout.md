# Pull Requests / Phase 09 — Checkout for local verification (server + web)

> **For agentic workers:** implemented by Codex (`codex:rescue`), reviewed by the coordinating Claude session. Tick checkboxes as you go. Red → green.

**Goal:** `pullRequests.checkout` on the server (into the selected checkout, another worktree, or a new managed worktree from the PR head ref, guarded by the Git Manager guard table) and the Checkout split button with "Open Git Manager there" on the web.

**Architecture:** `checkout.rs` reuses `git::manager::guards` (dirty tree, branch held by another worktree, in-progress operation) and the worktree catalog lock, runs `gh pr checkout` / `glab mr checkout` in the target `cwd` for local mode, and for worktree mode fetches `head_ref_spec(number)` into a local branch and calls the existing managed-worktree creation path used by `worktree.createManaged`. The client offers three targets and shows the result location.

**Tech Stack:** Rust (`git::manager::guards`, `worktree_catalog`, Phase 01 runner), React (`@base-ui/react` Menu), Vitest, cargo test.

---

## Files

- **Modify:** `apps/server/src/pull_requests/checkout.rs`, `mod.rs` (`checkout`), `host.rs` (`head_ref_spec` already declared), `production/pull_requests_rpc.rs` (dispatch `pullRequests.checkout`)
- **Create:** `apps/server/tests/pull_requests_checkout.rs`
- **Create:** `apps/web/src/components/pullRequests/PullRequestsCheckoutMenu.tsx` + test, `pullRequestsCheckout.logic.ts` + test
- **Modify:** `detail/PullRequestsHeader.tsx`, `usePullRequestsAction.ts` (or a sibling `useRunPullRequestsCheckout`)

## Dependencies

- Phase 07 (server action plumbing), Phase 08 (header).

## Owner Agent

Codex via `codex:rescue`. Reviewer: coordinator.

## Risk / Effort

Risk: Medium (guards, worktree creation). Effort: ~5 h.

---

## Discipline

- `AGENTS.md`. Never `--ignore-other-worktrees`, `worktree add -f`, or `update-ref`. Reuse the worktree catalog's lock; never add a second.
- Blocked reasons come from the guards module verbatim as `GitManagerBlockedReason`.
- The target `cwd` must belong to the same project as the PR's `cwd` (resolve both through `Repositories` like `git_manager_rpc.rs` does; mismatch → `blocked` with code `project-mismatch`).

## Documents to Read

- `pull-requests-spec.md` § 8.5 checkout
- `docs/plans/git-manager/git-manager-spec.md` § 7 guards, `research/worktree-checkout-restrictions.md` there
- `apps/server/src/git/manager/guards.rs`, `apps/server/src/production/worktree_catalog_rpc.rs` (or wherever `worktree.createManaged` is handled — find with `rg -n createManaged apps/server/src`)
- `apps/web/src/components/CreateWorktreeDialog.tsx` (pre-fill props)

---

## Pre-execution check

- [x] **Step 09.0: Claim the phase** (`codex-09`).

## Atomic steps

- [x] **Step 09.1: Server test first.** `apps/server/tests/pull_requests_checkout.rs`: a temp repository with `origin` = a second temp repository that has a branch `feature` and a ref `refs/pull/7/head` pointing at it; stub `gh` whose `pr checkout 7` runs `git fetch origin refs/pull/7/head:feature && git checkout feature` in `$PWD`. Cases: (1) local checkout on a clean tree → `checked_out { cwd, branch: "feature" }` and HEAD is `feature`; (2) dirty tree → `blocked { reason.code: "dirty-working-tree" }` and the stub was not called; (3) branch held by another worktree → `blocked` with `worktree-checked-out` naming the path; (4) worktree mode → `worktree_created { cwd, branch }`, the new worktree's HEAD is `feature`, the catalog lists it, and no `gh` call happened (only `git fetch`); (5) worktree mode when local `feature` exists at a different sha → branch name `feature-pr-7`.

- [x] **Step 09.2: Implement `checkout.rs`.** `pub async fn checkout(service, catalog, repositories, runner, cwd, number, target, c) -> Result<CheckoutResult, PullRequestsOperationError>`: scope → for `checkout` target: verify project match → evaluate guards for a checkout of the PR head branch name (`detail.headBranch`, read via `host.detail` or a lighter `head_branch(number)` adapter method — add it to the trait with a default that calls `detail`) → if blocked return `Blocked`; else run `gh pr checkout <n> --repo …` / `glab mr checkout <n> -b <headBranch>` with `cwd = target.cwd` under the catalog's repository lock → `CheckedOut`. For `worktree`: branch name = `target.branchName ?? headBranch`, collision check (`git rev-parse --verify <branch>` exists and differs from the fetched sha → suffix `-pr-<n>`), `git fetch origin <head_ref_spec>:<branch>` (runner.git, non-interactive env, 60 s), then the managed-worktree creation path with `{ projectId, branch, baseRef: branch }` (match the exact input shape of the existing service) → `WorktreeCreated { cwd, branch, worktreeId }`.

- [x] **Step 09.3: RPC dispatch** for `pullRequests.checkout` (`PullRequestsCheckoutInput` → `PullRequestsCheckoutResult`); the result's `blocked` variant is an `Ok` payload, not an error.

- [x] **Step 09.4: Web logic test first.** `pullRequestsCheckout.logic.ts`: `checkoutTargets(worktrees, selectedCwd)` → `[{ kind: "checkout", cwd: selected, label: "Current checkout" }, ...others as "Another worktree…" entries, { kind: "worktree", label: "New worktree…" }]`; `resultMessage(result)` → "Checked out feature in <path>" / "Created worktree <path> on feature" / the blocked reason.

- [x] **Step 09.5: Checkout menu.** `PullRequestsCheckoutMenu` in the header (replaces the Phase 04 placeholder): split button — primary "Checkout" = current checkout; chevron opens the menu with the targets; "New worktree…" opens `CreateWorktreeDialog` pre-filled with the branch name and a note "from pull request #N" if the dialog supports a preset; otherwise call `checkout { target: { kind: "worktree", branchName: null } }` directly and show the result. After success: toast with `resultMessage` and an action "Open Git Manager there" → navigate to `/project/$environmentId/$projectId/git` and set the Git Manager store's selected worktree to the result `cwd` (`useGitManagerStore.getState().setSelectedWorktree(projectRef, cwd)`). Blocked → toast with the reason and, for `worktree-checked-out`, an action "Switch to that worktree" that re-runs checkout with that cwd. Tests.

- [x] **Step 09.6: Gate.**

  ```bash
  cargo fmt --all --check && cargo clippy -p bibcode-server --all-targets -- -D warnings
  cargo test -p bibcode-server --test pull_requests_checkout -j 2
  cargo test -p bibcode-server pull_requests -j 2
  vp test run apps/web/src/components/pullRequests
  vp run typecheck && vp check
  ```

- [x] **Step 09.7: TDD proof.** Skip the guard evaluation; test (2) fails. Drop the collision suffix; test (5) fails. Restore.

- [x] **Step 09.8: Mark complete.** Implementation handed off as `review`; coordinator acceptance remains outstanding.

---

## Implementation evidence (`codex-09`)

20 checkout integration tests and 396 Pull Requests web tests pass. Rust format,
Clippy, workspace typecheck and `vp check` pass. Both required mutation proofs
failed behaviorally, were restored, and the full checkout suite passes.

Step 09.6 remains unchecked: the broad Rust command reaches a TCP-listener test
that is **blocked** in this sandbox with `Bind { address: "127.0.0.1:0", source:
Os { code: 1, kind: PermissionDenied, message: "Operation not permitted" } }`.
An additional managed-worktree RPC rollback test has the same blocker. These
scenarios are neither passed nor skipped. Exact commands/results, adaptations,
React/UI reviews, runbook updates and all touched files are in `tasks.md` under
Phase 09. Playwright remains coordinator-owned and was not run.

## Verification (coordinator)

- [x] Server tests (1)–(5) green; no forbidden git flags in the module (`rg -n "ignore-other-worktrees|worktree add -f|update-ref" apps/server/src/pull_requests` empty).
- [x] Playwright: on a throwaway PR, Checkout → current checkout on a clean main checkout switches the branch (verify with `git branch --show-current` in the project); dirty the tree → blocked toast with the reason; New worktree → a worktree appears in the sidebar, "Open Git Manager there" lands in the Git Manager on that worktree.
- [x] Runbooks under `docs/testing/` that list worktree flows are updated or recorded as reviewed (Phase 10 also checks).

## Notes for downstream phases

- Phase 10 documents checkout in `workspace-ui.md` and the guard interplay in `rpc-and-orchestration.md`.
