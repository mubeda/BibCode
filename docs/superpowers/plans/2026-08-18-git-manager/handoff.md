# Git Manager — Hand-off for code review

**Last touched:** 2026-08-18 (scaffold created at decomposition time)
**Branch:** `develop-5` _(confirm before review — the coordinator records the branch actually used)_
**Status:** _(to be filled by the coordinator after Round 5)_

_(This file is the single document a code reviewer reads first. The coordinator fills every section after the final round completes. Until then, the placeholders below stand in.)_

## What this iteration delivered

_(2–4 numbered bullets in plain English, referencing the master plan's goal and the user-visible behavior change.)_

1. _(to be filled)_
2. _(to be filled)_

Out of scope this iteration (acknowledged, copied from `master-plan.md` § Out of scope):

- Local changes, staging, commit, discard — owned by the existing thread-scoped source-control UI.
- Stash and submodules.
- Rebase (plain and interactive), cherry-pick, revert, reset, blame.
- Any worktree mutation from this panel; worktrees are listed read-only with their path.
- Checking out a branch that already has a worktree — permanently blocked and colour-marked.
- Remote branch deletion and remote tag deletion.
- Conflict-resolution UI — conflicts are aborted or left for an external tool.
- More than one Git Manager visible at once; state is cached for the two most recent projects.

## Background docs (read in this order before reviewing code)

1. `master-plan.md` — architecture, seven implementation phases, technical requirements, alternatives considered, acceptance criteria.
2. `issue.specs` — the original spec in the author's words plus `## Interview Notes` (the decisions that shaped scope).
3. `tasks.md` — phase-by-phase status board, per-phase deviations, coordination notes, round summaries.
4. `phases/PHASE-00-contracts.md` … `phases/PHASE-12-docs-and-verification.md` — the atomic instructions each teammate executed.
5. `screenshots/` — the reference client the UI is modelled on.

## Files touched

_(Fill from the per-phase "Files" sections and the actual diff.)_

**Contracts (`packages/contracts`):**
- _(to be filled)_

**Server (`apps/server/src/git`, `production`, `rpc`, `auth`):**
- _(to be filled)_

**Web (`apps/web/src/components/git-manager`, `routes`, `state`):**
- _(to be filled)_

**Documentation (`docs/`):**
- _(to be filled)_

**Tests:**
- _(to be filled — each new test file and its test count)_

Total: {N} new tests. Build status: _(record `cargo fmt --all --check`, `cargo clippy -p bibcode-server --all-targets -- -D warnings`, `cargo test -p bibcode-server`, `vp check`, `vp run typecheck`, `vp test` — with any pre-existing failures named explicitly)._

## Key deviations from the original plan (worth scrutinising)

_(For each: what the plan assumed, what the code does, why. Pull these from every phase's Detailed Progress in `tasks.md`.)_

1. _(to be filled)_
2. _(to be filled)_

Two deviations are already known and were decided during planning — confirm the code matches:

- `vcs.commitDiff` is a new **read-scoped** method rather than an extension of `review.getDiffPreview`, because that method maps to `SCOPE_REVIEW_WRITE` and read-only history browsing must not require a write scope.
- `resolveMergeConflict` is **exempt** from the dirty-working-tree guard, since it is the only operation valid while a merge is pending.

## TODOs / known limitations left in code

- _(every TODO comment that landed, with rationale)_
- _(the operation-output buffer cap chosen in Phase 09)_
- _(the commit file-list truncation cap chosen in Phase 01)_
- _(observed worst-case staleness for live updates — poll interval from Phase 07, measured latency from Phase 11)_

## How to verify before merging

1. `cargo fmt --all --check` → clean.
2. `cargo clippy -p bibcode-server --all-targets -- -D warnings` → clean.
3. `cargo test -p bibcode-server` → green.
4. `vp check` → clean. `vp run typecheck` → clean. `vp test` → green (name any pre-existing failure).
5. Manual pass in the running app (Phase 12 walked these; re-check the risky ones):
   - Open the Git Manager from a project card; click a thread; click the card again and confirm the view returns with its selection and scroll.
   - A branch that owns a worktree is colour-marked, cannot be checked out, and names the worktree path on hover.
   - Scroll several pages of history — lanes stay continuous, colours stable.
   - Select a merge commit, a rename, and a binary-file commit; confirm the diff states.
   - Fetch, pull, push against a scratch remote; cancel one mid-flight and confirm a new operation can start.
   - Merge a conflicting branch; take Abort once and Keep once; reload during the pending merge and confirm the resolve affordance returns.
   - Create a branch with checkout, check out a remote branch as local, create and push a tag, rename and delete a branch.
   - Make an external commit from a terminal and confirm it appears without pressing Refresh.
6. **Acceptance criteria walk** — `master-plan.md` § Acceptance Criteria 1–13, each with a pass/fail verdict (Phase 12 records these).

## Recommended code review

Run `/code-review` (or the `pr-review-toolkit:code-reviewer` agent) over the working tree. Focus areas:

**Rust (`apps/server`):**
- Cancellation and lock discipline in `git/operations.rs` — is the per-repository lock released on every exit path, including panic and interrupt?
- Guard re-validation at execution time; a stale client must be rejected, never trusted.
- Failure classification: are `authentication` / `non-fast-forward` / `conflict` distinguished by exit status and stderr rather than fragile string scraping?
- Non-interactive git environment on every network call — no path can hang on a credential prompt.
- Broadcaster changes: one poller per repository, no regression for existing `subscribeVcsStatus` consumers.
- Log hygiene: no branch names, paths, remote URLs, or git stderr in log strings.
- Bounded output, timeouts, and truncation on every new git invocation.

**React (`apps/web`):**
- No Git policy computed client-side — every disabled state traces to a server-supplied reason.
- Lane layout purity and page-boundary stability; the renderer adds no layout logic.
- Virtualization: stable keys, no re-render storms on streamed output chunks.
- Subscription lifecycle: one subscription per visible project, torn down on unmount, coalesced revalidation.
- Destructive flows: force push, delete, rename all require explicit confirmation with the affected ref named.
- Accessibility: disabled controls expose reasons via `aria-describedby`, dialogs trap and restore focus, the graph is keyboard-navigable.

**Contracts:**
- Schema-only (no runtime logic); every live method has exactly one declared scope; no speculative fields.

## Open questions for the reviewer to consider

- _(to be filled — e.g. whether the two-project LRU is the right cache size in practice, whether the lane cap of 24 is enough for this repository's history, whether the poll-derived staleness is acceptable or warrants a watcher later)_
