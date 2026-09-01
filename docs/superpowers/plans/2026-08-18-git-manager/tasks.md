# Git Manager — Task Tracker

> **SUPERSEDED (2026-08-31)** by `docs/plans/git-manager/`. No phase below was
> ever started. See the note at the top of `master-plan.md`.

**Single source of truth for phase progress.** Every teammate MUST update this file at two points (on pickup, on completion) — see § "Update protocol". This plan is commit-free: no row tracks git commits.

**Last updated:** 2026-08-18 — by coordinator (plan decomposition)
**Decomposition strategy:** contracts-first foundation, then layer-parallel fan-out (server / web-shell / pure-algorithm) with one server phase per round so the shared Rust registries are never edited concurrently, closing with docs + whole-feature verification.
**Total phases:** 13 across 6 rounds
**Team name:** `git-manager`
**Coordinator:** user-dispatched coordinator (see `execute-plan.md`)

---

## Phase status

| # | Phase | Round | Owner agent | Status | Agent | Started | Finished |
|---|---|---|---|---|---|---|---|
| 00 | Wire contracts for the whole feature | 0 | general-purpose | pending | — | — | — |
| 01 | Server read modules and read RPCs | 1 | general-purpose | pending | — | — | — |
| 02 | Project route, panel shell, store, sidebar button | 1 | general-purpose | pending | — | — | — |
| 03 | Incremental lane-layout module | 1 | general-purpose | pending | — | — | — |
| 04 | Streaming repository operations | 2 | general-purpose | pending | — | — | — |
| 05 | Ref tree with server-authored guards | 2 | general-purpose | pending | — | — | — |
| 06 | Virtualized commit graph | 2 | general-purpose | pending | — | — | — |
| 07 | Live repository change signal | 3 | general-purpose | pending | — | — | — |
| 08 | Commit detail pane with diff | 3 | general-purpose | pending | — | — | — |
| 09 | Toolbar, progress banner, fetch/pull/push/merge dialogs | 3 | general-purpose | pending | — | — | — |
| 10 | Branch and tag lifecycle | 4 | general-purpose | pending | — | — | — |
| 11 | Client live-refresh wiring | 4 | general-purpose | pending | — | — | — |
| 12 | Living documentation and full verification | 5 | general-purpose | pending | — | — | — |

**Status legend:** `pending` · `in_progress` · `blocked` · `completed` · `dropped`

## Rounds + dependencies

```
Round 0 (sequential — 1 teammate)
    Phase 00 — Contracts: every schema + all six RPC declarations
        |
        v
Round 1 (parallel — 3 teammates, no shared files)
    Phase 01 — Server read modules + read RPCs (graph, refs, guards, wiring)
    Phase 02 — Web route, shell, store, sidebar button, region placeholders
    Phase 03 — Pure lane-layout module
        |    (all three complete before Round 2)
        v
Round 2 (parallel — 3 teammates)
    Phase 04 — Server streaming operations        (needs 00, 01)
    Phase 05 — Ref tree region                    (needs 00, 02)
    Phase 06 — Commit graph region                (needs 02, 03)
        |
        v
Round 3 (parallel — 3 teammates)
    Phase 07 — Server live change signal          (needs 00, 01, 04)
    Phase 08 — Commit detail region + diff        (needs 02, 06)
    Phase 09 — Operations region: toolbar/progress/dialogs (needs 02, 04, 05)
        |
        v
Round 4 (parallel — 2 teammates)
    Phase 10 — Branch/tag lifecycle dialogs + context menu (needs 04, 05, 09)
    Phase 11 — Client live-refresh wiring         (needs 02, 07)
        |
        v
Round 5 (sequential — 1 teammate)
    Phase 12 — Living docs + full verification    (needs all)
```

**Wall-clock estimate:** ~28 h if run strictly sequentially; ~15 h with each round fully parallelised (R0 2 h + R1 3 h + R2 3 h + R3 3 h + R4 2.5 h + R5 2 h).

## File-conflict matrix (parallel rounds)

### Round 1 — confirm before dispatch

| File | Phase 01 | Phase 02 | Phase 03 |
|---|---|---|---|
| `packages/contracts/**` | — | — | — |
| `apps/server/src/git/{graph,refs,guards}.rs` | Create | — | — |
| `apps/server/src/git/mod.rs` | Modify | — | — |
| `apps/server/src/production/git_vcs.rs` | Modify | — | — |
| `apps/server/src/rpc/methods.rs`, `auth/scope.rs`, `maintenance.rs` | Modify | — | — |
| `apps/web/src/routes/_chat.project.*.tsx` | — | Create | — |
| `apps/web/src/gitManagerStore.ts`, `state/gitManager.ts` | — | Create | — |
| `apps/web/src/components/git-manager/GitManagerView.tsx` + 4 region files | — | Create | — |
| `apps/web/src/components/Sidebar.tsx` | — | Modify | — |
| `apps/web/src/components/git-manager/commitGraphLayout.ts` | — | — | Create |

No row has two writers. ✅

### Round 2 — confirm before dispatch

| File | Phase 04 | Phase 05 | Phase 06 |
|---|---|---|---|
| `apps/server/src/git/operations.rs` | Create | — | — |
| `apps/server/src/git/mod.rs`, `production/git_vcs.rs`, `rpc/methods.rs`, `auth/scope.rs` | Modify | — | — |
| `apps/web/src/components/git-manager/RefTree*.tsx`, `refBlockedReason.ts` | — | Create | — |
| `apps/web/src/components/git-manager/RefTreeRegion.tsx` | — | Modify | — |
| `apps/web/src/components/git-manager/CommitGraph*.tsx` | — | — | Create |
| `apps/web/src/components/git-manager/CommitGraphRegion.tsx` | — | — | Modify |

No row has two writers. ✅

### Round 3 — confirm before dispatch

| File | Phase 07 | Phase 08 | Phase 09 |
|---|---|---|---|
| `apps/server/src/git/broadcaster.rs` | Modify | — | — |
| `apps/server/src/production/git_vcs.rs`, `rpc/methods.rs`, `auth/scope.rs`, `maintenance.rs` | Modify | — | — |
| `apps/web/src/components/git-manager/CommitDetail*.tsx`, `CommitFileList.tsx` | — | Create | — |
| `apps/web/src/components/git-manager/CommitDetailRegion.tsx` | — | Modify | — |
| `apps/web/src/state/gitManagerOperations.ts` | — | — | Create |
| `apps/web/src/components/git-manager/{GitManagerToolbar,GitOperationProgress,PushDialog,MergeDialog,MergeConflictDialog}.tsx` | — | — | Create |
| `apps/web/src/components/git-manager/OperationsRegion.tsx` | — | — | Modify |

No row has two writers. ✅

### Round 4 — confirm before dispatch

| File | Phase 10 | Phase 11 |
|---|---|---|
| `apps/web/src/components/git-manager/{CreateBranchDialog,CreateTagDialog,ConfirmRefActionDialog,RefContextMenu}.tsx`, `refNameValidation.ts` | Create | — |
| `apps/web/src/components/git-manager/RefTree.tsx` (Phase 05's, now closed) | Modify | — |
| `apps/web/src/components/git-manager/GitManagerToolbar.tsx` (Phase 09's, now closed) | Modify | — |
| `apps/web/src/components/git-manager/useGitGraphLiveRefresh.ts` | — | Create |
| `apps/web/src/state/gitManager.ts` | — | Modify |
| `apps/web/src/components/git-manager/GitManagerView.tsx` | — | Modify |

No row has two writers. ✅

---

## Update protocol

### When you (the teammate) START a phase

1. Open this file (`tasks.md`).
2. Change the phase's `Status` from `pending` to `in_progress`.
3. Fill `Agent` with your subagent name (e.g. `phase-01`) and `Started` with `YYYY-MM-DD HH:MM` (24 h, machine-local).
4. Append `- YYYY-MM-DD HH:MM — picked up` under your Detailed Progress section.

### As you make progress

Append one-line entries under your own Detailed Progress section as you land meaningful steps (test added, implementation done, verification ran, deviation found).

### When you FINISH

1. Change `Status` to `completed`; fill `Finished`.
2. Append a final summary: deliverables, test count, deviations, and anything the "Notes for downstream phases" section of your phase file told you to record.

### When you are BLOCKED

1. Change `Status` to `blocked`; add an entry to **Active blockers** with the phase number, the blocker, and who must resolve it.
2. Hand back to the coordinator with a one-paragraph explanation.

### Hard rules

- Edit ONLY your own row and your own Detailed Progress section.
- Commit-free: never run, suggest, or wait for a **history-mutating** git operation (`git add`, `git commit`, `git push`, `git tag`, `git reset`, `git rebase`) as part of phase work. Read-only inspection (`git status`, `git diff`, `git log`) and git inside test fixtures or the feature's own server code are expected and allowed.
- Dates are absolute (`YYYY-MM-DD HH:MM`), never relative.
- Never edit `master-plan.md` or `issue.specs` — deviations are recorded here.

---

## Detailed Progress

### Phase 00 — Wire contracts for the whole feature
- _(updates appended by phase-00 teammate)_

### Phase 01 — Server read modules and read RPCs
- _(updates appended by phase-01 teammate)_

### Phase 02 — Project route, panel shell, store, sidebar button
- _(updates appended by phase-02 teammate)_

### Phase 03 — Incremental lane-layout module
- _(updates appended by phase-03 teammate)_

### Phase 04 — Streaming repository operations
- _(updates appended by phase-04 teammate)_

### Phase 05 — Ref tree with server-authored guards
- _(updates appended by phase-05 teammate)_

### Phase 06 — Virtualized commit graph
- _(updates appended by phase-06 teammate)_

### Phase 07 — Live repository change signal
- _(updates appended by phase-07 teammate)_

### Phase 08 — Commit detail pane with diff
- _(updates appended by phase-08 teammate)_

### Phase 09 — Toolbar, progress banner, fetch/pull/push/merge dialogs
- _(updates appended by phase-09 teammate)_

### Phase 10 — Branch and tag lifecycle
- _(updates appended by phase-10 teammate)_

### Phase 11 — Client live-refresh wiring
- _(updates appended by phase-11 teammate)_

### Phase 12 — Living documentation and full verification
- _(updates appended by phase-12 teammate)_

---

## Active blockers

_none_

## Decisions

_none yet_

## Coordination Notes

Coordinator-only section. Round summaries, cross-phase decisions, file-conflict resolutions, reassignments, scope adjustments.

### Decomposition-time notes (2026-08-18)

- **Rounds and owner agents were inferred**, not copied. `master-plan.md` states seven implementation phases and their dependencies but has no round table, phase index, or owner-agent column. The 13 phases here are a finer-grained split of those seven; `general-purpose` is the owner for every phase because the available agent roster has no Rust or React specialist.
- **Conflict-avoidance mechanism (important for anyone re-planning):** two structural rules make every parallel round conflict-free. (1) Exactly one server phase per round owns the shared Rust registries (`git/mod.rs`, `production/git_vcs.rs`, `rpc/methods.rs`, `auth/scope.rs`, `maintenance.rs`). (2) The web hub `GitManagerView.tsx` renders four **region files** created by Phase 02 as placeholders, and each later web phase replaces exactly one region. If a teammate proposes editing a file it does not own, route it through this section instead.
- **Skill-inventory gaps.** The active inventory has no Rust/Tokio/Axum skill and no Effect-Schema skill. Phases 00, 01, 04 and 07 therefore rely on the always-on superpowers plus `ponytail:ponytail`, with `.repos/effect-smol/LLMS.md` and the existing modules under `apps/server/src/git/` as the substitute references. Install a Rust specialist skill before execution if you want stronger coverage on the three highest-risk phases (01, 04, 09).
- **Tech-stack profiles.** `tech-stack-profiles.md` has no Rust profile; the Rust commands in every phase (`cargo fmt --all --check`, `cargo clippy -p bibcode-server --all-targets -- -D warnings`, `cargo test -p bibcode-server`) come from the master plan's Tech Stack section and `AGENTS.md` § Task Completion Requirements. The React commands (`vp check`, `vp run typecheck`, `vp test`) come from `docs/reference/scripts.md` — note `vp test` is the built-in Vite+ command and `vp run test` is the package-script graph; the phases use `vp test`.
- **Coding rules.** This repository has no `.claude/rules/*.md`. The governing rules are the root `AGENTS.md` (architecture, log hygiene, task completion) — every phase cites it under "Documents to Read" instead of a rules directory.
- **Front-loading the contracts is safe across the TS↔Rust gap, but NOT free — corrected 2026-08-18 after external review.** The original note here claimed nothing asserts method parity. That was checked only on the Rust side and was wrong in an important way: there is no TS↔Rust *dispatch* parity check (`ACTIVE_RPC_METHODS` is consumed only by `rpc/session.rs` and the scope test, so a declared-but-unregistered method simply has no handler until its phase lands) — **but** `packages/contracts/src/rpcRustParity.test.ts:359` asserts the checked-in wire manifest equals the live RPC group, `packages/contracts/fixtures/rpc-wire/manifest.json` pins 95 methods, and `packages/contracts/scripts/export-rust-rpc-fixtures.ts:707-731` hard-throws unless the counts match (95 methods / 16 streams / 224 typed-failure fixtures / 23 orchestration shapes). Phase 00 must regenerate the fixtures and bump those numbers or it fails its own gate — see PHASE-00 Step 00.14.
- **Shared working tree.** All teammates run in one checkout. Scoped tests are reliable; full-workspace gates (`vp check`, `vp run typecheck`, `cargo test`) can transiently fail on a same-round neighbour's half-written file. That is not a blocker — the coordinator re-runs the full gate at end-of-round.
- **Contract freeze.** Phase 00 lands every schema for all later phases specifically so `packages/contracts/src/rpc.ts` is written once. A later phase needing a new field must raise it here first; silent edits will collide with whatever else is in flight.
- **Two master-plan decisions worth re-reading before Round 2:** `vcs.commitDiff` is read-scoped on purpose (`review.getDiffPreview` is write-scoped), and `resolveMergeConflict` is exempt from the dirty-tree guard (otherwise the resolution path blocks itself).

### External review outcome (Codex, 2026-08-18)

An independent Codex review of the master plan and this decomposition returned **Approve-with-changes**. Its verdict on the structure: all four file-conflict matrices were independently re-derived and confirmed correct, the region-file and one-server-phase-per-round mechanisms hold, and coverage against `issue.specs` has no orphans. Every finding below was re-verified against source before being applied; the plan and phase files already carry the fixes.

Decisions taken in response (these override earlier wording anywhere it survives):

1. **Wire fixtures are the sixth registration place.** See the corrected note above; PHASE-00 gained Step 00.14.
2. **Operation serialization reuses the worktree catalog's repository lock** (`worktree_catalog/service.rs:1505-1569`) instead of introducing a second, independent lock — so a Git Manager push/merge and a catalog worktree mutation on one physical repository cannot interleave. PHASE-04 gained a cross-subsystem exclusion test; a test using only two Git Manager operations would pass with a separate lock and prove nothing.
3. **Commit pages are pinned to a tip snapshot.** `--skip` against `--all` is unstable when a commit lands (the ref tick is 3 s and agent threads commit constantly). The first page resolves and returns the ref tips; later pages echo them back; a generation bump splices new commits above the snapshot instead of discarding loaded pages. Over 500 tips the server falls back to `--all` with `tipsPinned: false` and the UI must say so. Contract, PHASE-01, PHASE-02, PHASE-06 and PHASE-11 all updated.
4. **`push_current_branch` must be extended, not just wrapped** — it takes only `cwd` + cancellation and hardcodes `origin` (`repository.rs:2727-2760`). Remote/force/push-tags belong in `repository.rs`, not forked into the operations executor.
5. **The broadcaster description was corrected to the real implementation** — `RepositoryState` has no signature/generation field yet, there are already two subscriber-gated poller tasks, and `subscribeVcsGraph` must trigger the same subscribe-driven start so a graph-only subscriber still gets ticks.
6. **`operation_kind()` in `operations.rs` is the single owner** of the camelCase `_tag` → kebab-case `VcsGraphOperationKind` mapping, including `push { force: true }` → `force-push`.
7. **Regions take no props** — each reads the route params itself. Prop-drilling would force every web phase to edit `GitManagerView.tsx` and destroy the conflict-free rounds.
8. Smaller corrections applied: `git_environment()` is at `repository.rs:4258` (not 4261); `@pierre/trees` is already a dependency and must be evaluated before hand-rolling the ref tree; `state/vcs.ts` wraps `@bibcode/client-runtime` atoms rather than raw zustand; AC13 (all environment kinds) now has coverage in PHASE-02; the ~1 s first-page criterion is now a **measured** number in PHASE-06; empty-repository (unborn HEAD) and shared-repository-via-worktrees cases are now explicit tests in PHASE-01.

Not adopted: folding PHASE-11 into PHASE-07. They are different stacks in different rounds, and merging client work into the round's designated server phase would break the one-server-phase-per-round rule that keeps Round 3 conflict-free. The review itself called this "defensible, not required".

Standing recommendation from the review: **PHASE-04 deserves a human Rust-focused pass before merge** — its lock-release-on-cancellation/panic guarantee and the `resolveMergeConflict` guard exemption are the two claims a non-specialist teammate could get subtly wrong without any gate failing.

---

## Final Summary

_(Written by the coordinator once every phase reaches `completed`. Summarise what was delivered, deviations from the master plan, open items, and link to `handoff.md` for code review.)_
