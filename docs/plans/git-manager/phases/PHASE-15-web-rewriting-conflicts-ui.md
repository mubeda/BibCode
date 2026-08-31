# Git Manager / Phase 15 — Web history rewriting and conflict UI

> **For agentic workers:** REQUIRED SUB-SKILL: invoke `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` before touching code. Atomic steps use checkbox (`- [ ]`) syntax for tracking — tick them off in this file as you go.

**Goal:** Drive PHASE-13's rewriting operations from the panel through one multi-commit operation flow with conflict resolution, commit context menus and drag affordances.

**Architecture:** This phase adds a `rewrite/` directory under `apps/web/src/components/gitManager/` holding one state machine that drives merge, rebase, cherry-pick, squash and reorder — the reference implementation's single-framework design (`research/github-desktop-analysis.md` § 1.3) — plus the conflicted-file list with marker counts and ours/theirs resolution. It consumes PHASE-13's streaming operation events and conflict state verbatim, and reuses PHASE-10's `<GitManagerOperationBanner>` and PHASE-12's `<GitManagerInProgressStrip>` rather than adding a third progress surface. It implements Slice 6's client half (`git-manager-plan.md` § Slices). No git policy is computed here.

**Tech Stack:** React 19 / Vite+ / TanStack Router / zustand / Effect Atom — apps/web. Tailwind CSS 4 + @base-ui/react + lucide-react. Virtualization @legendapp/list; drag-and-drop dnd-kit; diffs @pierre/diffs. Test: `vp test run <path>` (tests import from `vite-plus/test`; DOM opt-in per file with a `// @vitest-environment happy-dom` first-line docblock). Checks: `vp check`, `vp run typecheck`.

---

## Files

- **Create:** `apps/web/src/components/gitManager/rewrite/gitManagerMultiCommitOperation.logic.ts` — the pure state machine
- **Create:** `apps/web/src/components/gitManager/rewrite/gitManagerMultiCommitOperation.logic.test.ts`
- **Create:** `apps/web/src/components/gitManager/rewrite/GitManagerMultiCommitOperationDialog.tsx` — the step host (choose-branch, force-push warning, progress, conflicts, abort confirmation)
- **Create:** `apps/web/src/components/gitManager/rewrite/GitManagerMultiCommitOperationDialog.test.tsx`
- **Create:** `apps/web/src/components/gitManager/rewrite/GitManagerConflictList.tsx` — conflicted-file list with marker counts and ours/theirs resolution
- **Create:** `apps/web/src/components/gitManager/rewrite/GitManagerConflictList.logic.ts` + `.logic.test.ts`
- **Create:** `apps/web/src/components/gitManager/rewrite/GitManagerCommitContextMenu.logic.ts` + `.logic.test.ts` — single- and multi-selection menu item sets and their enablement
- **Create:** `apps/web/src/components/gitManager/rewrite/gitManagerCommitDrag.ts` + `.test.ts` — drop-target resolution for cherry-pick / squash / reorder
- **Modify:** `apps/web/src/components/gitManager/history/GitManagerCommitList.tsx` — supply the existing `onContextMenu` handler and wrap rows as drag sources; PHASE-06 already exposes `onSelect: (sha: string) => void` and `onContextMenu: (sha: string, event: React.MouseEvent) => void`, so this must stay a minimal edit
- **Modify:** `apps/web/src/gitManagerStore.ts` — add ONLY the `rewrite` view-state slice (`multiCommitSelection`); do not touch other slices

## Dependencies

- Phase 13: Server history-rewriting operations
- Phase 12: Web stash and merge UI

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

**Matched for this phase:**

5. `Skill(skill="web-design-guidelines")` — *destructive rewrites need explicit, accessible confirmation and a non-pointer path*
6. `Skill(skill="vercel-react-best-practices")` — *drag over a virtualized commit list must not re-render the whole list*
7. `Skill(skill="codebase-design")` — *one state machine drives five operations; the seam has to stay shallow-surfaced*

## Documents to Read

- `AGENTS.md` — repo-wide required pre-work, evidence and completion rules
- `docs/plans/git-manager/git-manager-spec.md` — scope and constraints; § 3.1 (history rewriting, conflict handling), § 6.5 (destructive confirmations), § 6.6 (externally started operations)
- `docs/plans/git-manager/git-manager-plan.md` — architecture and global constraints; § Ownership (client renders, never derives policy), § Client (accessibility, bounded caches)
- `docs/plans/git-manager/research/github-desktop-analysis.md` — § 1.2 (commit context menus, multi-selection, drag targets), § 1.3 rows "Multi-commit framework" and "Conflict resolution", § 2.3 (banner model)
- `docs/plans/git-manager/research/worktree-checkout-restrictions.md` — the guard table; rebase of a held branch is blocked server-side and the client renders that reason
- `docs/plans/git-manager/research/bibcode-integration-surface.md` — § 3.4 existing web git UI, § 4 client atom families and lanes
- `docs/reference/scripts.md` — the exact `vp` commands used below
- `apps/web/src/components/ui/dialog.tsx`, `apps/web/src/components/SourceControlPanel.logic.ts` — the house dialog and destructive-confirm conventions
- `apps/web/src/components/CenterPanelTabs.tsx` — the existing dnd-kit usage pattern in this codebase

---

## Pre-execution check

- [ ] **Step 15.0: Claim the phase.** Open `../tasks.md`. Change Phase 15 row → `Status = in_progress`, `Agent = phase-15` (or your subagent name), `Started = YYYY-MM-DD HH:MM`. Append a "started — picked up" entry under your Detailed Progress section.

## Atomic steps

- [ ] **Step 15.1: Locate the surface area being changed.**

	```bash
	rg -n "GitManagerOperationRequest|GitManagerOperationEvent|GitManagerConflictState|GitManagerBlockedReason" packages/contracts/src/gitManager.ts
	rg --files apps/web/src/components/gitManager
	rg -n "GitManagerInProgressStrip|GitManagerOperationBanner|groupBranches|summarizeMergePreview" apps/web/src/components/gitManager
	rg -n "@dnd-kit" apps/web/src/components/CenterPanelTabs.tsx apps/web/src/components/Sidebar.tsx
	```

	`packages/contracts/src/gitManager.ts` is authoritative for every schema and variant name; the names used below are the expected ones. Confirm PHASE-13's operation variants (`rebase`, `cherry-pick`, `squash`, `reorder`, `revert`, `reset`, `continue`, `abort`, `resolve-conflict`) and the fields of `GitManagerConflictState` (`path`, `kind`, `markerCount`, `resolution`) from the working tree.

	**Sibling contracts to reuse, not re-create:** PHASE-10's single `<GitManagerOperationBanner>` (props `operation: GitManagerOperationEvent | null`, `onCancel: () => void`) is where live operation progress renders — the app shows one operation at a time, matching the server's `operation-in-flight` rejection. PHASE-10's `groupBranches({ refs, recentNames, filter })` in `apps/web/src/components/gitManager/toolbar/branchGrouping.ts` is the only branch-list shaping function. PHASE-12's `<GitManagerInProgressStrip>` renders the repository's persisted in-progress state. PHASE-12's `summarizeMergePreview` maps `GitManagerMergePreview`. PHASE-06's `GitManagerCommitList` already exposes `onSelect` and `onContextMenu`. Record deviations in the per-phase notes of `tasks.md`.

- [ ] **Step 15.2: Author the first failing test — the state machine.**

	Path: `apps/web/src/components/gitManager/rewrite/gitManagerMultiCommitOperation.logic.test.ts`

	Import `describe, expect, it` from `"vite-plus/test"`. Pin one behaviour: `advanceMultiCommitOperation(state, event)` moves a rebase from `choose-branch` to `warn-force-push` when the chosen commits are already pushed, and straight to `show-progress` when they are not. The step set is exactly `choose-branch`, `warn-force-push`, `show-progress`, `show-conflicts`, `hide-conflicts`, `confirm-abort`, `create-branch` — the reference's seven-step framework (`research/github-desktop-analysis.md` § 1.3) minus only its two feature-flagged Copilot steps. `hide-conflicts` is load-bearing: dismissing the conflicts dialog mid-operation must not abandon the operation, it must fall back to the sticky, non-dismissable conflict banner with a "View conflicts" link (§ 2.3). The machine is pure — no atoms, no React, no timers.

- [ ] **Step 15.3: Run the new test; expect FAIL** (the module does not exist yet).

	```bash
	vp test run apps/web/src/components/gitManager/rewrite/gitManagerMultiCommitOperation.logic.test.ts
	```

- [ ] **Step 15.4: Implement the minimum to make Step 15.2 pass.**

	Path: `apps/web/src/components/gitManager/rewrite/gitManagerMultiCommitOperation.logic.ts`

	Export `type GitManagerMultiCommitStep`, `type GitManagerMultiCommitKind = "merge" | "rebase" | "cherry-pick" | "squash" | "reorder"`, `interface GitManagerMultiCommitState`, and `advanceMultiCommitOperation`.

- [ ] **Step 15.5: Run the test; expect PASS.**

- [ ] **Step 15.6: Add the remaining state-machine tests and implementation, one at a time.**

	- A `failed` event carrying a conflict code moves to `show-conflicts`; the conflict list is the server's, unmodified.
	- `show-conflicts` → `show-progress` only when every conflicted path reports `markerCount === 0` or a non-null `resolution`; otherwise Continue stays disabled with the server's reason.
	- `show-conflicts` → `hide-conflicts` on dismiss, and back to `show-conflicts` from the banner's "View conflicts" link. Assert that `hide-conflicts` does **not** abort, does not clear the conflict list, and keeps the banner sticky and non-dismissable — the operation is still in progress in the repository, and PHASE-12's `<GitManagerInProgressStrip>` proves it independently of this machine.
	- Abort always routes through `confirm-abort`; confirming dispatches the `abort` variant and returns to idle on `finished`.
	- The state machine records the pre-operation tip so an undo affordance can offer to reset to it, matching the reference's `originalBranchTip` behaviour; assert the tip is captured from the server's `started` event and never recomputed.
	- A `started` event for an operation this client did not initiate (spec § 6.6) is accepted and drives the same machine — the flow must not require local initiation.

- [ ] **Step 15.7: Add the conflict-list tests, then implement it.**

	Path: `apps/web/src/components/gitManager/rewrite/GitManagerConflictList.logic.ts` and `GitManagerConflictList.tsx`.

	- `resolveConflictCount(markerCount)` returns `Math.ceil(markerCount / 3)` — the reference's "N conflicts" contract. If PHASE-13's contract already exposes a pre-divided field, use it and delete this helper rather than dividing twice; assert whichever path you take.
	- A path with zero markers renders as resolved with a check, and offers Undo.
	- A `binary` or `submodule` conflict renders a "Resolve ▾" menu with exactly two options, Ours and Theirs, each dispatching the `resolve-conflict` variant with `{ path, side }`. The client sends no git arguments.
	- Component test: every row's action carries an `aria-label`; the list is keyboard-navigable; a disabled Continue exposes the server's reason via `title` and `aria-describedby`.
	- Committing while any path still reports markers raises a warning dialog before proceeding (reference contract, `commit-conflicts-warning`).

- [ ] **Step 15.8: Add the operation-dialog tests, then implement the dialog host.**

	Path: `apps/web/src/components/gitManager/rewrite/GitManagerMultiCommitOperationDialog.tsx`.

	Build on `Dialog` / `DialogPopup` / `DialogHeader` / `DialogTitle` / `DialogDescription` / `DialogFooter` from `apps/web/src/components/ui/dialog.tsx` — the house convention is a plain `Dialog`, not `AlertDialog`. Use PHASE-10's `groupBranches` for the `choose-branch` step's list and PHASE-12's `summarizeMergePreview` for its preview line. Assert:
	- the `warn-force-push` step states that history will be rewritten and that a force push will be needed, and its confirm is `variant="destructive"`;
	- the `show-progress` step renders "Commit i of N" from the `{ current, total }` carried on the refs snapshot's `GitManagerInProgressOperation`, which PHASE-13 fills from `.git/rebase-merge/{msgnum,end}` and the sequencer snapshot. There is **no** per-line progress stream: PHASE-07 recorded that the supervised process path has no incremental output observer, so `output` events arrive one per completed git command. Design for chunked output and add no fake percentage; the client parses no git text either way;
	- Cancel during progress dispatches cancellation on the operation stream and reaches a terminal state rather than leaving the dialog stuck;
	- the collapsible raw-output area renders the server's `output` payload verbatim and is collapsed by default;
	- live operation progress renders through PHASE-10's single `<GitManagerOperationBanner>`, and the ambient repository state through PHASE-12's `<GitManagerInProgressStrip>`; render no third banner.

	Every operation dispatch goes through the `createRuntimeCommand` wrapper PHASE-10 established — `gitManager.runOperation` is a streaming **command** in `EnvironmentStreamCommandRpcTag` (not `EnvironmentSubscriptionRpcTag`), consumed on the existing per-`(environmentId, cwd)` lane, never via `runStream` from a component. Any force push uses PHASE-07's force-push variant, which is `--force-with-lease` server-side; the client never chooses git flags.

- [ ] **Step 15.9: Add the commit context-menu tests, then implement the logic module.**

	Path: `apps/web/src/components/gitManager/rewrite/GitManagerCommitContextMenu.logic.ts`.

	Export `buildCommitMenuItems(selection, context)` returning the item set for a single-commit selection (Reset to commit, Revert, Cherry-pick, Reorder, Create branch from commit, Create tag, Copy SHA) and for a multi-commit selection (Cherry-pick N, Squash N, Reorder N). Assert, following the reference contract in `research/github-desktop-analysis.md` § 1.2:
	- squash and reorder require a **contiguous** selection, and the contiguity check is over the loaded commit order;
	- a merge commit blocks squash and reorder;
	- every item that the server reports blocked is present but disabled with the server's `message` verbatim — items are never hidden to express policy;
	- a non-contiguous multi-selection suppresses the diff and shows the explanatory blank slate rather than an arbitrary diff.

	Render the menu through the existing native context-menu path (`readLocalApi()?.contextMenu.show`, with the browser fallback in `apps/web/src/contextMenuFallback.ts`) used elsewhere in `apps/web/src/components/Sidebar.tsx`.

- [ ] **Step 15.10: Add the drag-target tests, then implement `gitManagerCommitDrag.ts`.**

	Export `resolveCommitDropTarget(drag, over)` mapping a commit drag onto one of: a branch row → cherry-pick onto that branch; the "New branch" pseudo-row → cherry-pick to a new branch; another commit row → squash; a list insertion point → reorder; anything else → `null`. Use `@dnd-kit/core` (already a dependency) with the same sensor/modifier conventions as `apps/web/src/components/CenterPanelTabs.tsx`. Assert a keyboard reorder path exists (arrow keys plus Enter) so the affordance is not pointer-only, and that a drop onto a target the server reports blocked is refused with the server's reason rather than dispatched.

- [ ] **Step 15.11: Add the store slice and its test.**

	Add only `multiCommitSelection: readonly string[]` to `apps/web/src/gitManagerStore.ts`, inside the existing per-project view-state record keyed by `(environmentId, projectId)`, plus its setter alongside PHASE-03's existing action set, and add it to the sanitiser. The persisted key stays `bibcode:git-manager-state:v1`. PHASE-03's note requires a new field to be requested through `tasks.md` before it is added, and **PHASE-16 shares this round and also edits this file** — coordinate both before editing. Extend PHASE-03's existing store test.

- [ ] **Step 15.12: Full build + test gate.**

	```bash
	vp test run apps/web/src/components/gitManager/rewrite apps/web/src/gitManagerStore.test.ts
	vp run typecheck
	vp check
	```

	Expected: zero warnings, zero errors, all tests green.

- [ ] **Step 15.13: Exercise the flow in the running app.**

	`vp run dev`, and verify against **both** a local project and a remote-hosted project (attach one per `docs/user/remote-access.md`): a rebase that conflicts shows the conflict list with marker counts; resolving with Theirs and continuing completes; aborting mid-operation restores the tip; a cherry-pick of two commits onto a branch works by drag and by context menu; the force-push warning appears before rewriting pushed commits; and a conflict started with `git rebase` in a terminal drives the same flow.

- [ ] **Step 15.14: TDD proof.** Make `advanceMultiCommitOperation` always return its input state and `resolveCommitDropTarget` always return `null`. Re-run the Step 15.12 test filter and confirm the affected tests DO fail. Restore the real implementations.

- [ ] **Step 15.15: Mark phase complete.** Change Phase 15 row in `tasks.md` → `Status = completed`, `Finished = YYYY-MM-DD HH:MM`. Append a final summary entry under your Detailed Progress section: what was delivered, how many tests landed, any deviations from the plan.

> **No commit step.** This skill is commit-free: no phase ever produces or requests a git commit. Whether and when to commit the resulting work is a decision the user makes after execution, outside the scope of any phase.

---

## Verification

- [ ] One state machine drives merge, rebase, cherry-pick, squash and reorder; `rg -n "useState.*step|setStep" apps/web/src/components/gitManager/rewrite` shows no second, parallel step model.
- [ ] Progress text comes from the refs snapshot's structured `{ current, total }`; `rg -n "Rebasing \\(" apps/web/src` returns nothing — the client parses no git output, and no fake percentage is shown.
- [ ] Every disabled control's tooltip and `aria-describedby` is the server's `message` verbatim; no client-authored policy strings exist under `apps/web/src/components/gitManager/rewrite`.
- [ ] Force-push warning precedes every rewrite of already-pushed commits; the underlying push is `--force-with-lease` server-side and the client never passes git flags.
- [ ] Abort always routes through an explicit confirmation, and the conflict flow works for an operation started outside the panel.
- [ ] Drag affordances have a keyboard equivalent; the commit list stays virtualized during drag.
- [ ] All new tests green: `vp test run apps/web/src/components/gitManager/rewrite`.
- [ ] `vp check` clean and `vp run typecheck` clean.
- [ ] Validated end to end against **both** a local project and a remote-hosted project.
- [ ] **Zero-telemetry check:** this phase added no analytics, crash reporting, usage counter, remote feature flag, avatar or identity fetch, third-party host contact, or new dependency. Confirm with `git diff apps/web/package.json` (empty) and by grepping the new files for `fetch(`, `XMLHttpRequest`, `new Image(`, `src="http` — all must be absent.
- [ ] Final `git diff` and `git status --short` review for unintended edits, generated files, debug output and dependency drift.
- [ ] TDD-proof step performed and described in the per-phase notes.

## Notes for downstream phases

- **PHASE-16 shares this round and must not touch these files.** This phase owns `apps/web/src/components/gitManager/rewrite/**` and the `multiCommitSelection` store field; PHASE-16 owns `apps/web/src/components/gitManager/tags/**`, `.../diff/**`, `.../provider/**` and its own store fields. The only shared file is `apps/web/src/gitManagerStore.ts` and `apps/web/src/components/gitManager/history/GitManagerCommitList.tsx` — coordinate both edits through `tasks.md` before starting.
- PHASE-16's "Create tag" and "Delete tag" items belong in `buildCommitMenuItems` in `GitManagerCommitContextMenu.logic.ts`. This phase already emits them as menu entries with `onSelect` callbacks supplied by the caller; PHASE-16 supplies the handlers and must not fork the menu builder.
- Exported contracts other phases rely on: `advanceMultiCommitOperation(state, event)`, `GitManagerMultiCommitState`, `GitManagerMultiCommitStep`, `GitManagerMultiCommitKind`, `resolveConflictCount(markerCount)`, `buildCommitMenuItems(selection, context)`, `resolveCommitDropTarget(drag, over)`.
- `GitManagerMultiCommitOperationDialog` props are `{ state: GitManagerMultiCommitState; onAdvance: (event: GitManagerOperationEvent) => void; onCancel: () => void; onConfirmAbort: () => void }` — pass stable memoized callbacks.
- `GitManagerConflictList` props are `{ conflicts: readonly GitManagerConflictState[]; onResolve: (path: string, side: "ours" | "theirs") => void; onUndoResolve: (path: string) => void; continueBlocked: GitManagerBlockedReason | null }`.
- This phase reuses PHASE-12's `<GitManagerInProgressStrip>` and PHASE-10's `<GitManagerOperationBanner>` unchanged. If either's props turn out to be insufficient, extend them where they live and record the change in `tasks.md` — do not add a third progress surface.
- **Divergence carried forward from PHASE-07/10:** `gitManager.runOperation` is a streaming *command*, so it lives in `EnvironmentStreamCommandRpcTag` in `packages/client-runtime/src/rpc/client.ts`, not in the subscription-tag union the brief mentions. Consume it through a `createRuntimeCommand` wrapper mirroring `packages/client-runtime/src/state/vcsAction.ts`.
