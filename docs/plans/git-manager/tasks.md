# Git Manager — Task Tracker

**Single source of truth for phase progress.** Every teammate MUST update this file at two points (on pickup, on completion) — see § "Update protocol" below. This plan is commit-free: no row tracks git commits.

**Last updated:** 2026-08-31 — by coordinator (plan decomposition)
**Decomposition strategy:** vertical feature slices, contracts-first, with at most one Rust registry-editing phase per round so the shared RPC registries are never edited concurrently.
**Total phases:** 18 across 9 rounds
**Team name:** `git-manager`
**Coordinator:** user-dispatched coordinator (see `execute-plan.md`)
**Spec:** `git-manager-spec.md` · **Master plan:** `git-manager-plan.md`

---

## Phase status

| #   | Phase                                   | Round | Owner agent     | Status      | Agent     | Started          | Finished |
| --- | --------------------------------------- | ----- | --------------- | ----------- | --------- | ---------------- | -------- |
| 00  | Wire contracts for the whole feature    | 0     | general-purpose | pending     | —         | —                | —        |
| 01  | Server read modules and read RPCs       | 1     | general-purpose | pending     | —         | —                | —        |
| 02  | Pure guards module                      | 1     | general-purpose | pending     | —         | —                | —        |
| 03  | Web panel shell: route, button, store   | 1     | general-purpose | pending     | —         | —                | —        |
| 04  | Server staging and commit operations    | 2     | general-purpose | pending     | —         | —                | —        |
| 05  | Web changes view                        | 2     | general-purpose | pending     | —         | —                | —        |
| 06  | Web history view and diffs              | 2     | general-purpose | pending     | —         | —                | —        |
| 07  | Server branch and sync operations       | 3     | general-purpose | pending     | —         | —                | —        |
| 08  | Web staging and commit UI               | 3     | general-purpose | pending     | —         | —                | —        |
| 09  | Server stash, merge, live signal        | 4     | general-purpose | pending     | —         | —                | —        |
| 10  | Web toolbar, branch dropdown, sync UI   | 4     | general-purpose | pending     | —         | —                | —        |
| 11  | Server hunk and line staging            | 5     | general-purpose | pending     | —         | —                | —        |
| 12  | Web stash and merge UI                  | 5     | general-purpose | pending     | —         | —                | —        |
| 13  | Server history-rewriting operations     | 6     | general-purpose | pending     | —         | —                | —        |
| 14  | Web partial staging gutter              | 6     | general-purpose | pending     | —         | —                | —        |
| 15  | Web history rewriting and conflict UI   | 7     | general-purpose | pending     | —         | —                | —        |
| 16  | Tags, image diffs, provider surfaces    | 7     | general-purpose | pending     | —         | —                | —        |
| 17  | Docs, telemetry test, full verification | 8     | general-purpose | in_progress | phase-17a | 2026-09-01 08:53 | —        |

**Status legend:** `pending` · `in_progress` · `blocked` · `completed` · `dropped`

## Rounds + dependencies

```
Round 0 (sequential — 1 teammate)
    Phase 00 — Wire contracts for the whole feature
        |    (crosses the RPC fixture + count gate once, deliberately)
        v
Round 1 (parallel — 3 teammates)
    Phase 01: Server read modules and read RPCs   [Rust, registry-editing]
    Phase 02: Pure guards module                  [Rust, pure — no registry]
    Phase 03: Web panel shell                     [Web]
        |    (all three complete before Round 2)
        v
Round 2 (parallel — 3 teammates)
    Phase 04: Server staging and commit operations [Rust, registry-editing]
    Phase 05: Web changes view                     [Web]
    Phase 06: Web history view and diffs           [Web]
        |
        v
Round 3 (parallel — 2 teammates)
    Phase 07: Server branch and sync operations    [Rust, registry-editing]
    Phase 08: Web staging and commit UI            [Web]
        |
        v
Round 4 (parallel — 2 teammates)
    Phase 09: Server stash, merge, live signal     [Rust, registry-editing]
    Phase 10: Web toolbar, branch dropdown, sync   [Web]
        |
        v
Round 5 (parallel — 2 teammates)
    Phase 11: Server hunk and line staging         [Rust, registry-editing]
    Phase 12: Web stash and merge UI               [Web]
        |
        v
Round 6 (parallel — 2 teammates)
    Phase 13: Server history-rewriting operations  [Rust, registry-editing]
    Phase 14: Web partial staging gutter           [Web]
        |
        v
Round 7 (parallel — 2 teammates)
    Phase 15: Web history rewriting and conflict UI [Web]
    Phase 16: Tags, image diffs, provider surfaces  [Server + Web]
        |
        v
Round 8 (sequential — 1 teammate)
    Phase 17: Docs, telemetry test, full verification
```

**Shippable checkpoints.** Each round leaves the application shippable. After
Round 1 the panel exists but is inert; after Round 2 it is a usable read-only
git viewer; every later round adds one coherent capability.

**Wall-clock estimate:** ~50 h if run sequentially; ~26 h with each round fully
parallelised (sum of the longest phase in each round). Estimates are per-phase
guesses, not measurements.

## File-conflict matrix (parallel rounds)

The binding rule: **at most one Rust registry-editing phase per round.** Phases
01, 04, 07, 09, 11, 13 each touch `apps/server/src/production/git_manager_rpc.rs`
and the shared registries, and are deliberately spread one per round. Phase 02
is a pure module and touches no registry, so it is safe beside Phase 01.

Round 1:

| File                                              | Phase 01 | Phase 02 | Phase 03 |
| ------------------------------------------------- | -------- | -------- | -------- |
| `apps/server/src/git/manager/refs.rs`, `graph.rs` | Create   | —        | —        |
| `apps/server/src/git/manager/guards.rs`           | —        | Create   | —        |
| `apps/server/src/git/manager/mod.rs`              | Create   | Modify   | —        |
| `apps/server/src/production/git_manager_rpc.rs`   | Create   | —        | —        |
| `apps/web/src/gitManagerStore.ts`                 | —        | —        | Create   |
| `apps/web/src/components/Sidebar.tsx`             | —        | —        | Modify   |
| `apps/web/src/routes/` (new project route)        | —        | —        | Create   |

**Coordination rule for `apps/server/src/git/manager/mod.rs`:** Phase 01 creates
it and declares `pub mod refs; pub mod graph;`. Phase 02 adds only the single
line `pub mod guards;`. Phase 02 must re-read the file immediately before
editing and append its line rather than rewriting the file. If Phase 02 reaches
that step first, it creates `mod.rs` with only its own line and Phase 01 appends
instead — whichever arrives second appends.

Round 2:

| File                                            | Phase 04 | Phase 05 | Phase 06 |
| ----------------------------------------------- | -------- | -------- | -------- |
| `apps/server/src/git/manager/operations.rs`     | Create   | —        | —        |
| `apps/web/src/components/gitManager/changes/**` | —        | Create   | —        |
| `apps/web/src/components/gitManager/history/**` | —        | —        | Create   |
| `apps/web/src/gitManagerStore.ts`               | —        | Modify   | Modify   |

**Coordination rule for `gitManagerStore.ts` in Round 2:** Phases 05 and 06 both
add a slice to the store created in Phase 03. Each adds only its own keys and
actions (`changes*` for Phase 05, `history*` for Phase 06) and must re-read the
file immediately before editing. Neither may restructure the store's shape,
rename existing keys, or change its persistence version; any such need is a
blocker to be raised in § Active blockers, not resolved unilaterally.

Rounds 3–7 pair one server phase with one web phase touching disjoint trees; no
file conflicts. Round 7 pairs a web-only phase (15) with a cross-layer phase
(16); Phase 16 is the only registry-editing phase in that round.

---

## Update protocol

### When you (the teammate) START a phase

1. Open this file (`tasks.md`) with your Edit tool.
2. Change the phase's `Status` from `pending` to `in_progress`.
3. Fill the `Agent` column with your subagent name (e.g. `phase-01`) and `Started` with `YYYY-MM-DD HH:MM` (24h, machine-local time).
4. Append a one-line entry under your Detailed Progress section: `- YYYY-MM-DD HH:MM — picked up`.

### As you make progress during the phase

Append one-line entries under your Detailed Progress section as you land meaningful steps (test added, implementation done, verification ran). No git commits are involved; the progress log captures the substantive milestones.

### When you FINISH the phase

1. Change `Status` to `completed`.
2. Fill `Finished` with `YYYY-MM-DD HH:MM`.
3. Append a final summary entry to your Detailed Progress section: deliverables, test count, deviations.
4. Hand back to the coordinator.

### When you are BLOCKED

1. Change `Status` to `blocked`.
2. Add an entry to **Active blockers** below with: phase #, blocker summary, who needs to resolve.
3. Hand back to the coordinator with a one-paragraph explanation.

### When the phase is DROPPED

1. Change `Status` to `dropped`.
2. Add a justification line under **Decisions** below.

### Hard rules

- Edit ONLY your own row and your own Detailed Progress section. Never touch other phases' rows or sections.
- This plan is commit-free. Do NOT run, suggest, or wait for any `git` operation that mutates history (`git add`, `git commit`, `git push`). Read-only inspection (`git status`, `git diff`) is required by the verification gates and is fine.
- Date/time format is always absolute (`YYYY-MM-DD HH:MM`), never relative.
- Preserve unrelated working-tree changes (AGENTS.md § Required Pre-Work).

---

## Detailed Progress

### Phase 00 — Wire contracts for the whole feature

- _(updates appended by phase-00 teammate)_

### Phase 01 — Server read modules and read RPCs

- _(updates appended by phase-01 teammate)_

### Phase 02 — Pure guards module

- _(updates appended by phase-02 teammate)_

### Phase 03 — Web panel shell: route, button, store

- _(updates appended by phase-03 teammate)_

### Phase 04 — Server staging and commit operations

- _(updates appended by phase-04 teammate)_

### Phase 05 — Web changes view

- _(updates appended by phase-05 teammate)_

### Phase 06 — Web history view and diffs

- _(updates appended by phase-06 teammate)_

### Phase 07 — Server branch and sync operations

- _(updates appended by phase-07 teammate)_

### Phase 08 — Web staging and commit UI

- _(updates appended by phase-08 teammate)_

### Phase 09 — Server stash, merge, live signal

- _(updates appended by phase-09 teammate)_

### Phase 10 — Web toolbar, branch dropdown, sync UI

- _(updates appended by phase-10 teammate)_

### Phase 11 — Server hunk and line staging

- _(updates appended by phase-11 teammate)_

### Phase 12 — Web stash and merge UI

- _(updates appended by phase-12 teammate)_

### Phase 13 — Server history-rewriting operations

- _(updates appended by phase-13 teammate)_

### Phase 14 — Web partial staging gutter

- _(updates appended by phase-14 teammate)_

### Phase 15 — Web history rewriting and conflict UI

- _(updates appended by phase-15 teammate)_

### Phase 16 — Tags, image diffs, provider surfaces

- _(updates appended by phase-16 teammate)_

### Phase 17 — Docs, telemetry test, full verification

- 2026-09-01 08:53 — phase-17a picked up living-document alignment and the Markdown format gate; telemetry tests are owned by the concurrent phase-17 agent.
- 2026-09-01 09:06 — phase-17a completed Steps 17.1–17.6: aligned the owned architecture, user, integration, and shared testing docs to source; corrected the historical supersession note; and recorded shipped deviations (no Git Manager keybinding commands, six fine-grained flags not consumed by React, and unmounted rewrite/conflict/tag-delete/tag-push UI). Platform runbooks and the remaining reviewed-only living docs remain accurate. The Phase 17 row stays in progress for the concurrent telemetry and final verification work.

---

## Active blockers

_none_

## Decisions

_none yet_

## Coordination Notes

Coordinator-only section. Round summaries, cross-phase decisions, file-conflict resolutions, reassignments, scope adjustments.

### Decomposition notes (2026-08-31)

- **Inferred fields.** The master plan (`git-manager-plan.md`) was written before
  this decomposition and does not itself contain a round table, an owner-agent
  column, or a pre-merge contract. Rounds, owner agents, effort estimates and
  the file-conflict matrix were inferred from its § Slices and § Architecture
  and are recorded here rather than in the plan.
- **Skill inventory gap.** No Rust-specialist skill exists in this environment,
  so the Rust phases (01, 02, 04, 07, 09, 11, 13, and the server half of 16)
  carry only the always-on superpowers. Web phases match
  `vercel-react-best-practices` and `web-design-guidelines`. If a Rust skill is
  installed later, the Rust phases should be re-tagged.
- **Owner agent.** Every phase is `general-purpose`; this environment exposes no
  stack-specialist subagent types.
- **The RPC count gate — corrected during decomposition.** There are **three**
  hard-coded count sites, not two: `packages/contracts/scripts/export-rust-rpc-fixtures.ts`,
  `packages/contracts/scripts/export-rust-rpc-fixtures.test.ts`, and
  `apps/server/tests/rpc_wire.rs`. Verified 2026-08-31: all three currently
  **agree** — 101 methods, 18 streams, 65 stream shapes, 65 stream-shape
  fixtures, 23 orchestration event shapes, 242 typed failures. (An earlier
  decomposition note claimed they were mutually stale; that was wrong.) Phase 00
  still re-reads all three from the working tree rather than trusting these
  numbers, and bumps them together.
- **`apps/server/src/maintenance.rs` needs no edit.** Maintenance mutability is
  derived from the `mutability` field on `ACTIVE_RPC_METHODS`, so declaring a
  method with `read_unary`/`read_stream` _is_ its maintenance classification.
  There is no separate allowlist.
- **`validate_complete` forces stubs in Phase 00.** The RPC registry validates
  that every `ACTIVE_RPC_METHODS` entry has a registered handler, and
  `finalize_rpc_registry` runs it at real startup. Declaring the whole method
  surface in Phase 00 without handlers would stop the server booting until the
  last handler phase landed — and `apps/server/tests/rpc_wire.rs` would not
  catch it, because it uses `start_with_registry`. Phase 00 therefore ships
  `apps/server/src/production/git_manager_rpc.rs` with stub handlers plus a
  production-registry completeness test, and later phases replace the stubs.
- **Phase 00 also creates the `apps/server/src/git/manager/` skeleton** (module
  file plus empty submodule files) so Phases 01 and 02 never both edit
  `apps/server/src/git/mod.rs`. This supersedes the Round 1 coordination rule
  for `manager/mod.rs` recorded in the file-conflict matrix above.
- **Phase 00 owns `packages/client-runtime/src/state/gitManager.ts`** (plus its
  `package.json` exports entry and the subscription-tag union), so Phases 05 and
  06 do not collide over it in Round 2. Phase 03 adds only the thin web wrapper.
- **The repository lock is keyed by project, not cwd.** It is
  `WorktreeCatalogService::with_project_mutation_lock`, keyed by `project_id`.
  The `cwd` → project resolution is owned by Phases 07, 09 and 13.
- **`VcsWorkingTreeFileStatus` expresses no unmerged or submodule state.** The
  changes view joins conflicted paths from the Phase 01 refs snapshot onto the
  `subscribeVcsStatus` file list rather than expecting the stream to carry them.
- **No incremental process output — affects the progress banner.** The
  supervised process path has no incremental output observer: it returns output
  when a command completes. The spec's "collapsible area streaming git
  stdout/stderr" therefore emits one chunk per completed git command in the
  first implementation, not per-line `--progress` output. `--progress` is
  dropped rather than passed and ignored. Per-line streaming is deliberately
  deferred and needs a supervised-process change; raise it as a scope decision
  before attempting it inside a phase.
- **`operation-in-flight` needs a marker, not a second lock.** The catalog lock
  (`with_project_mutation_lock_cancellation`) _blocks_ rather than failing fast,
  so a fast rejection needs an in-flight marker keyed by the canonical common
  directory alongside — not instead of — the existing lock. Serialisation still
  uses the one existing lock. This also means `GitManagerOperationRequest` must
  carry `projectId`, which is a Phase 00 contract requirement discovered during
  decomposition.
- **`execute_with_environment` hard-codes `stdin: None`.** The underlying
  process request supports stdin, but the git wrapper does not pass it. A
  stdin-capable variant is needed for `git commit -F -` and `git apply --cached`;
  whichever of Phase 04 or Phase 11 lands first adds it.
- **`gitManager.runOperation` is a streaming command, not a subscription.** It
  joins the stream-command tag union, not the subscription tag union.
- **Already exists, do not rebuild:** `apps/web/src/lib/lruCache.ts` (reused for
  the bounded commit lookup) and the diff worker pool's highlight cap. No
  identicon or initials helper exists; Phase 06 creates a pure local one.
- **Commit-draft sharing lands in Phase 08, not Phase 03.** The existing
  `sourceControlPanelStore` is thread-keyed; reconciling it with the
  project-keyed Git Manager draft is Phase 08's work. Phase 03 only provides the
  `commitDraft` field.
- **Naming.** RPC methods use the `gitManager.*` prefix (verified unused).
  Schema symbols use the `GitManager` prefix, except this feature's error type,
  which is `GitManagerOperationError` — because `GitManagerError` and
  `GitManagerServiceError` already exist in `packages/contracts/src/git.ts` for
  the server's internal git service and must not be touched.
- **Naming drift reconciled at decomposition time (2026-08-31).** The phase
  files were drafted by three authors in parallel and diverged on four method
  names. `PHASE-00-contracts.md` is the contract owner and won every
  disagreement; the affected files were corrected. Canonical names:
  `gitManager.getDiff` (one method with a `GitManagerDiffSource` union covering
  working-tree, commit and stash — there is **no** `getCommitDiff` or
  `getStashDiff`), `subscribeGitManagerSignal` (bare `subscribeXxx`, no dot,
  matching every existing stream method), and
  `gitManager.stagePartial` / `gitManager.unstagePartial` /
  `gitManager.discardPartial` (not `*Selection`).
  All nine capability-flag names were already consistent across authors and
  needed no change. Before Round 0 dispatch, re-run:
  `grep -nE 'gitManager\.(getCommitDiff|getStashDiff|subscribeRepository|stageSelection|discardSelection)' docs/plans/git-manager/phases/*.md`
  — matches should appear only inside `PHASE-00-contracts.md`, whose
  reconciliation note legitimately quotes the old names.
- **Contract decision made before implementation — stash identity.** The stash
  arm of `GitManagerDiffSource` carries `sha`, and `GitManagerStashEntry.sha` is
  its stable identity. Phase 09 resolves that sha against the current stash
  list to obtain the `stash@{n}` ref git needs and returns a structured error if
  the stash was dropped or popped. Phase 12 persists the selected sha and passes
  it directly to `getDiff`, refetching `getStashes` when it is no longer present.
  This avoids silently selecting a different stash after index shifts or a
  localStorage-backed reload.
- **Contract decision made before implementation — partial unstaging.** Phase
  00 declares `gitManager.unstagePartial` beside `stagePartial` and
  `discardPartial`, under the existing `gitManagerPartialStaging` capability.
  BiBCode keeps a visible, incrementally staged index, so it needs a true
  partial-unstage operation: Phase 11 applies the selected patch with
  `git apply --cached --reverse` to change only the index, and Phase 14 exposes
  that control for staged selections. Discard remains a working-tree operation
  and must never be substituted for unstage.
- **Superseded predecessor.** `docs/superpowers/plans/2026-08-18-git-manager/`
  is a different, never-implemented plan. Ignore it entirely; it is retained
  only as historical evidence and carries a superseded banner.

---

## Final Summary

_(Written by the coordinator once every phase reaches `completed`. Summarise what was delivered, deviations from the master plan, open items, and link to `handoff.md` for code review.)_
