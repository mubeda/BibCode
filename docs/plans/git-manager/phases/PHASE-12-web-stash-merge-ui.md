# Git Manager / Phase 12 — Web stash and merge UI

> **For agentic workers:** REQUIRED SUB-SKILL: invoke `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` before touching code. Atomic steps use checkbox (`- [ ]`) syntax for tracking — tick them off in this file as you go.

**Goal:** Give the Git Manager panel a full native stash surface, merge/squash-merge dialogs with a mergeability preview, and an in-progress-operation affordance that appears no matter who started the operation.

**Architecture:** This phase is pure client work over the server surfaces landed by PHASE-09 (stash list/apply/pop/drop, stash diff, `merge-tree --write-tree` mergeability preview, `.git` state probes for externally started merge/rebase/cherry-pick) and the streaming operation RPC landed by PHASE-07. It adds a `stash/` and a `merge/` directory under `apps/web/src/components/gitManager/`, plus one shared in-progress strip — distinct from PHASE-10's operation banner, which continues to render live operation progress. It implements Slice 4's client half (`git-manager-plan.md` § Slices) and derives no git policy: blocked reasons arrive as `{ operation, code, message }` and are rendered verbatim.

**Tech Stack:** React 19 / Vite+ / TanStack Router / zustand / Effect Atom — apps/web. Tailwind CSS 4 + @base-ui/react + lucide-react. Virtualization @legendapp/list; diffs @pierre/diffs. Test: `vp test run <path>` (tests import from `vite-plus/test`; DOM opt-in per file with a `// @vitest-environment happy-dom` first-line docblock). Checks: `vp check`, `vp run typecheck`.

---

## Files

- **Create:** `apps/web/src/components/gitManager/stash/GitManagerStashList.tsx` — virtualized stash list with per-entry actions
- **Create:** `apps/web/src/components/gitManager/stash/GitManagerStashList.logic.ts` — pure row model, action enablement, confirm copy
- **Create:** `apps/web/src/components/gitManager/stash/GitManagerStashList.logic.test.ts`
- **Create:** `apps/web/src/components/gitManager/stash/GitManagerStashList.test.tsx`
- **Create:** `apps/web/src/components/gitManager/stash/GitManagerStashDiff.tsx` — per-entry diff pane reusing the existing `@pierre/diffs` path
- **Create:** `apps/web/src/components/gitManager/merge/GitManagerMergeDialog.tsx` — merge and squash-merge dialog
- **Create:** `apps/web/src/components/gitManager/merge/GitManagerMergeDialog.logic.ts` — pure preview summary + confirm copy
- **Create:** `apps/web/src/components/gitManager/merge/GitManagerMergeDialog.logic.test.ts`
- **Create:** `apps/web/src/components/gitManager/merge/GitManagerMergeDialog.test.tsx`
- **Create:** `apps/web/src/components/gitManager/GitManagerInProgressStrip.tsx` — continue/abort affordance derived from repository state, distinct from PHASE-10's operation banner
- **Create:** `apps/web/src/components/gitManager/GitManagerInProgressStrip.logic.ts` + `.logic.test.ts`
- **Modify:** `apps/web/src/gitManagerStore.ts` — add ONLY the `stash` view-state slice (`selectedStashSha`, `stashPaneOpen`); do not touch other slices
- **Modify:** `apps/web/src/components/gitManager/GitManagerPanel.tsx` — mount the stash pane, the merge dialog trigger, and the in-progress strip (one line each; coordinate through `tasks.md`)
- **Modify:** `apps/web/src/state/gitManager.ts` — re-export the stash/merge atoms if PHASE-09's web wrapper is incomplete

## Dependencies

- Phase 09: Server stash, merge, in-progress detection, live signal
- Phase 10: Web toolbar, branch dropdown, sync UI

## Owner Agent

`general-purpose`

## Risk / Effort

Risk: Medium. Effort: ~3 h.

---

## Skills to Invoke (teammate-side)

Invoke these skills via the `Skill` tool BEFORE doing any work. Order matters: always-on first, then matched.

**Always-on (every phase):**

1. `Skill(skill="superpowers:using-superpowers")` — establish skill discipline
2. `Skill(skill="superpowers:subagent-driven-development")` — execution discipline for this phase
3. `Skill(skill="superpowers:test-driven-development")` — red-green-refactor for the new tests
4. `Skill(skill="superpowers:verification-before-completion")` — required gate before marking complete

**Matched for this phase:**

5. `Skill(skill="web-design-guidelines")` — _destructive stash actions need labelled, keyboard-reachable confirmations_
6. `Skill(skill="vercel-react-best-practices")` — _stash list re-renders on every status generation bump_

## Documents to Read

- `AGENTS.md` — repo-wide required pre-work, evidence and completion rules
- `docs/plans/git-manager/git-manager-spec.md` — scope and constraints; § 6.3 (full native stash list), § 6.4 (switch-with-changes), § 6.5 (confirmations), § 6.6 (externally started operations)
- `docs/plans/git-manager/git-manager-plan.md` — architecture and global constraints; § Client, § Slices (Slice 4)
- `docs/plans/git-manager/research/github-desktop-analysis.md` — § 3.8 stash commands and list shape, § 3.7 merge/`merge-tree` preview, § 1.3 merge dialog contract
- `docs/plans/git-manager/research/bibcode-integration-surface.md` — § 3.4 existing web git UI, § 4 client atom families and lanes
- `docs/architecture/connection-runtime.md` — capability gating and reconnect behaviour for the atoms this pane reads
- `docs/reference/scripts.md` — the exact `vp` commands used below
- `apps/web/src/components/SourceControlPanel.tsx` and `apps/web/src/components/SourceControlPanel.logic.ts` — the house destructive-confirm pattern (nullable `pending*` state + a pure `resolve*DialogCopy`)
- `apps/web/src/components/ui/dialog.tsx`, `apps/web/src/components/ui/button.tsx` — the `@base-ui/react` primitives and `size="icon-sm"` icon-button convention

---

## Pre-execution check

- [ ] **Step 12.0: Claim the phase.** Open `../tasks.md`. Change Phase 12 row → `Status = in_progress`, `Agent = phase-12` (or your subagent name), `Started = YYYY-MM-DD HH:MM`. Append a "started — picked up" entry under your Detailed Progress section.

## Atomic steps

- [ ] **Step 12.1: Locate the surface area being changed.**

  ```bash
  rg -n "GitManagerStash|GitManagerConflictState|GitManagerMerge|inProgressOperation" packages/contracts/src/gitManager.ts
  rg -n "getStashes|getDiff|previewMerge|runOperation" packages/client-runtime/src/state/gitManager.ts apps/web/src/state/gitManager.ts
  rg -n "GitManagerStashEntry|GitManagerDiffSource|GitManagerMergePreview" packages/contracts/src/gitManager.ts
  rg --files apps/web/src/components/gitManager
  rg -n "gitManagerStore" apps/web/src --glob '*.ts*'
  ```

  **PHASE-00's Step 00.7 method table is binding and wins every disagreement.** Only four RPCs sit behind this phase:

  - `gitManager.getStashes` → the full native stash list as `GitManagerStashEntry` values. **A stash's changed-file list comes from here too** — there is no separate file-list call.
  - `gitManager.getDiff` with a `GitManagerDiffSource` of `{ _tag: "stash", sha, path }` → the patch for **one path** inside one stash. **There is no dedicated stash-diff method**, whatever an earlier draft may have said: `getDiff` is the single diff method, and its `working-tree` / `commit` / `stash` source arms are exactly why it is one method and not three.
  - `gitManager.previewMerge` → `GitManagerMergePreview`.
  - Every mutation — `stash-push`, `stash-apply`, `stash-pop`, `stash-drop`, `merge`, `squash-merge` — is a `GitManagerOperationRequest` variant on the single `gitManager.runOperation` stream.

  Read the exact field names of `GitManagerStashEntry`, `GitManagerDiffSource` and `GitManagerMergePreview` from `packages/contracts/src/gitManager.ts` in the working tree. PHASE-09's `GitManagerStashRecord` is a **server-internal Rust parse type** in `apps/server/src/git/manager/stash.rs`, not the wire schema — the web consumes `GitManagerStashEntry`. `GitManagerMergePreview`'s variants are `clean`, `conflicted { fileCount }` and `unrelated-histories`; `GitManagerInProgressOperation` rides on the refs snapshot. Record any further deviation in the per-phase notes of `tasks.md`.

  Read PHASE-03's `apps/web/src/gitManagerStore.ts` API before touching it: `useGitManagerStore` with `selectViewState(ref)` and the actions `touchProject`, `setSelectedWorktree`, `setActiveTab`, `setSelectedRef`, `setSelectedCommit`, `setSelectedFile`, `setFilterText`, `setScrollAnchor`, `setLoadedPageCount`. Read PHASE-03's `gitManagerAvailability.ts` — capability gating goes through it, never through an ad-hoc `serverConfig` read.

- [ ] **Step 12.2: Author the first failing test.**

  Path: `apps/web/src/components/gitManager/stash/GitManagerStashList.logic.test.ts`

  Import `describe, expect, it` from `"vite-plus/test"`. Pin one behaviour: `buildStashRows(entries, blockedReasons)` returns one row per `GitManagerStashEntry` in the server's order (LIFO, `stash@{0}` first), each row carrying the entry's `index`, its identity fields and `blocked: GitManagerBlockedReason | null` taken verbatim from the server payload — never recomputed. Assert the list is repository-wide and is **not** filtered or grouped by the selected worktree (spec § 6.3; research doc `worktree-checkout-restrictions.md` cross-cutting rule 4; PHASE-09's downstream note repeats this).

  Retain and test `resolveStashIndex(entries, sha)` only for apply/pop/drop mutation dispatch, whose current operation variants still need the entry's current `stash@{n}` selector: it returns the entry's **current** `index`, or `null` when the sha is gone. Stash indices shift on every push and drop, so an index is only valid against the list it came from. The stash `getDiff` source does not use this helper; it carries the selected sha directly.

- [ ] **Step 12.3: Run the new test; expect FAIL** (the logic module does not exist yet).

  ```bash
  vp test run apps/web/src/components/gitManager/stash/GitManagerStashList.logic.test.ts
  ```

- [ ] **Step 12.4: Implement the minimum to make Step 12.2 pass.**

  Path: `apps/web/src/components/gitManager/stash/GitManagerStashList.logic.ts`

  Export `interface GitManagerStashRow`, `buildStashRows(...)`, and nothing else yet. Keep it pure — no React, no atom access.

- [ ] **Step 12.5: Run the test; expect PASS.**

- [ ] **Step 12.6: Add the stash action-enablement and confirm-copy tests, then implement.**

  In the same logic module add `resolveStashActionState(row, { operationInFlight })` returning `{ apply, pop, drop }` each as `{ enabled: boolean; reason: string | null }`, where `reason` is the server's `message` verbatim when blocked and `null` otherwise, and `resolveStashDiscardDialogCopy(row)` returning `{ title, body, confirmLabel, destructive: true }` for drop. Mirror `resolveDiscardDialogCopy` in `apps/web/src/components/SourceControlPanel.logic.ts` (indicative :146 — re-verify). Cover: an `operation-in-flight` blocked reason disables all three; a `null` blocked reason enables all three; the drop copy names the stash ref and says the entry cannot be recovered.

- [ ] **Step 12.7: Add the component test for the stash list, then implement the component.**

  Path: `apps/web/src/components/gitManager/stash/GitManagerStashList.test.tsx`, then `GitManagerStashList.tsx`.

  Follow the dominant house style in `apps/web/src/components/SourceControlSection.test.tsx`: `vi.hoisted` harness + `renderToStaticMarkup` from `react-dom/server`, no jsdom. Assert: rows render at the fixed 29px changed-file row height contract from the spec § 8; each icon-only action carries an `aria-label`; a disabled action exposes its server-authored reason through both `title` and `aria-describedby`; selecting a row calls the `onSelectStash` prop exactly once with the entry **sha**, never its index. Virtualize with `@legendapp/list` (already a dependency, `3.3.3`). The component receives `{ scope: { environmentId, cwd }, projectRef }` from `GitManagerPanel`, matching the prop contract PHASE-03 published for every child surface.

- [ ] **Step 12.8: Add the stash-diff pane test, then implement it.**

  Path: `apps/web/src/components/gitManager/stash/GitManagerStashDiff.tsx`.

  Render the selected stash's changed-file list from the `GitManagerStashEntry` already returned by `gitManager.getStashes` — do **not** issue a call for it. For the selected path, pass `selectedStashSha` straight through to `gitManagerEnvironment.getDiff({ environmentId, input: { cwd, source: { _tag: "stash", sha: selectedStashSha, path } } })`. Do not resolve an index for the diff request. Hand the patch to `getRenderablePatch(patch, "git-manager-stash")` from `apps/web/src/lib/diffRendering.ts` and render through the existing `AnnotatableCodeView` path used by `apps/web/src/components/DiffPanel.tsx`. Do NOT add a second diff renderer or a second worker pool — `DiffWorkerPoolProvider` already bounds the pool.

  Assert: the `raw` fallback branch of `RenderablePatch` renders its `reason` rather than throwing; a selected sha missing from the current entries renders an "entry no longer present" state and refetches the list instead of issuing `getDiff`; and a structured missing-stash `GitManagerOperationError` from the server is an expected outcome when the stash is dropped or popped between list and diff. In that case the UI refetches `gitManager.getStashes` rather than surfacing a hard failure.

- [ ] **Step 12.9: Add the merge-dialog logic tests, then implement the logic module.**

  Path: `apps/web/src/components/gitManager/merge/GitManagerMergeDialog.logic.ts` + `.logic.test.ts`.

  Export `summarizeMergePreview(preview)` mapping PHASE-09's `GitManagerMergePreview` — whose variants are exactly `clean`, `conflicted { fileCount }` and `unrelated-histories` — to the three presentations in `research/github-desktop-analysis.md` § 1.3 / § 3.7: clean ("This will merge N commits from `<source>` into `<current>`"), conflicted ("There will be N conflicted files"), unrelated histories (merge disabled). Do **not** re-derive mergeability; PHASE-09's `parse_merge_tree_preview` is the only place it is computed. Also export `resolveMergeConfirmCopy(mode)` for `mode: "merge" | "squash"`. Assert ahead/behind counts come from the server payload and are never recomputed client-side.

- [ ] **Step 12.10: Add the merge-dialog component test, then implement it.**

  Path: `apps/web/src/components/gitManager/merge/GitManagerMergeDialog.tsx` + `.test.tsx`.

  Build on `Dialog`/`DialogPopup`/`DialogHeader`/`DialogTitle`/`DialogDescription`/`DialogFooter` from `apps/web/src/components/ui/dialog.tsx` — not `AlertDialog`; the destructive-confirm convention in this codebase is a plain `Dialog` driven by nullable `pending*` state. Reuse PHASE-10's `groupBranches({ refs, recentNames, filter })` from `apps/web/src/components/gitManager/toolbar/branchGrouping.ts` for the source-branch picker; it is the only branch-list shaping function. The dialog dispatches a `GitManagerOperationRequest` of kind `merge` or `squash-merge` through the `createRuntimeCommand` wrapper PHASE-10 established — `gitManager.runOperation` is a streaming **command** in `EnvironmentStreamCommandRpcTag`, never `runStream` called from a component, and never a raw RPC `request`. Its progress renders through PHASE-10's single `<GitManagerOperationBanner>`; do not add a second operation banner. Assert: the confirm button is disabled while the preview is pending and while the preview is `unrelated-histories`; a server blocked reason renders verbatim and disables confirm; the dialog closes on `finished` and stays open showing the failure code on `failed`.

- [ ] **Step 12.11: Add the in-progress strip tests, then implement it.**

  Path: `apps/web/src/components/gitManager/GitManagerInProgressStrip.tsx` + `.logic.ts` + `.logic.test.ts`.

  **This is not PHASE-10's `<GitManagerOperationBanner>` and must not replace it.** That banner renders the _live operation stream_ this client dispatched; this strip renders the _repository's persisted in-progress state_ from PHASE-09's `detect_in_progress_operation` probes, which is present after a reconnect, after a server restart, and when an agent or a terminal started the operation (spec § 6.6). Both can be visible at once and each must be individually testable.

  Cover every kind `GitManagerInProgressOperation` reports — merge, rebase, cherry-pick, revert — and assert: the strip is `role="alert"` and non-dismissable; it offers Continue and Abort; Abort goes behind a confirmation; every other mutation control receives the server's blocking reason rather than a locally invented one; and the strip survives a reconnect (re-render from a fresh snapshot with the same in-progress kind must not flicker to the idle state).

- [ ] **Step 12.12: Add the store slice and its test.**

  Modify `apps/web/src/gitManagerStore.ts` to add only `selectedStashSha: string | null` and `stashPaneOpen: boolean` inside the existing per-project view-state record, plus their setters alongside PHASE-03's existing action set. **Store the sha, never the index** — this state is persisted across reloads and stash indices shift on every push and drop, so a persisted index would silently resolve to a different entry. The store key stays `(environmentId, projectId)` — never a bare `projectId` — and the persisted key stays `bibcode:git-manager-state:v1`. PHASE-03's note is explicit that a field is either already there or is requested through `tasks.md`: request these two before editing. If the sanitiser drops unknown fields, add both in the same edit. Extend PHASE-03's existing store test rather than creating a parallel one.

- [ ] **Step 12.13: Full build + test gate.**

  ```bash
  vp test run apps/web/src/components/gitManager/stash apps/web/src/components/gitManager/merge apps/web/src/components/gitManager/GitManagerInProgressStrip.logic.test.ts apps/web/src/gitManagerStore.test.ts
  vp run typecheck
  vp check
  ```

  Expected: zero warnings, zero errors, all tests green.

- [ ] **Step 12.14: Exercise the panel in the running app.**

  `vp run dev`, open a project's Git Manager, and verify against **both** a local project and a remote-hosted project (attach one per `docs/user/remote-access.md`): the stash list shows entries created on the command line; apply/pop/drop each work and refresh the list; the per-entry diff renders; the merge dialog shows all three preview presentations; and starting `git merge` manually in a terminal makes the in-progress banner appear without any client-side inference.

- [ ] **Step 12.15: TDD proof.** Make `buildStashRows` return `[]` unconditionally and `summarizeMergePreview` return the clean presentation unconditionally. Re-run the Step 12.13 test filter and confirm the affected tests DO fail. Restore the real implementations.

- [ ] **Step 12.16: Mark phase complete.** Change Phase 12 row in `tasks.md` → `Status = completed`, `Finished = YYYY-MM-DD HH:MM`. Append a final summary entry under your Detailed Progress section: what was delivered, how many tests landed, any deviations from the plan.

> **No commit step.** This skill is commit-free: no phase ever produces or requests a git commit. Whether and when to commit the resulting work is a decision the user makes after execution, outside the scope of any phase.

---

## Verification

- [ ] The stash list shows every entry `git stash list` reports, including entries created outside BiBCode and entries belonging to other branches; no marker-scoped filtering exists anywhere in the code.
- [ ] Only PHASE-00's declared methods are used: `rg -n "getStashDiff|listStashes|applyStash|popStash|dropStash" apps/web/src` returns nothing. The stash file list comes from `gitManager.getStashes`; a per-path stash patch comes from `gitManager.getDiff` with `{ _tag: "stash", sha, path }`.
- [ ] Stash selection is stored as a **sha** and passed directly to `getDiff`; `resolveStashIndex` is used only when apply/pop/drop needs the current mutation selector. A no-longer-present stash refetches `gitManager.getStashes` instead of failing hard. `rg -n "selectedStashIndex" apps/web/src` returns nothing.
- [ ] Apply, pop and drop each dispatch a `GitManagerOperationRequest` through PHASE-10's `createRuntimeCommand` wrapper for `gitManager.runOperation` (a streaming **command** in `EnvironmentStreamCommandRpcTag`) on the existing per-`(environmentId, cwd)` lane; no component calls the RPC client's `request` or `runStream` directly.
- [ ] Every disabled control's tooltip and `aria-describedby` text is the server's `message` string, byte-for-byte; `rg -n "already checked out|is blocked|in progress" apps/web/src/components/gitManager` finds no client-authored policy strings.
- [ ] The in-progress strip appears for a merge, rebase, cherry-pick or revert started outside the panel, and disappears when it is continued or aborted. It is distinct from PHASE-10's `<GitManagerOperationBanner>`, which still renders live operation progress.
- [ ] All new tests green: `vp test run apps/web/src/components/gitManager/stash apps/web/src/components/gitManager/merge`.
- [ ] `vp check` clean and `vp run typecheck` clean.
- [ ] Validated end to end against **both** a local project and a remote-hosted project.
- [ ] **Zero-telemetry check:** this phase added no analytics, crash reporting, usage counter, remote feature flag, avatar or identity fetch, third-party host contact, or new dependency. Confirm with `git diff apps/web/package.json` (empty) and by grepping the new files for `fetch(`, `XMLHttpRequest`, `new Image(`, `src="http` — all must be absent.
- [ ] Final `git diff` and `git status --short` review for unintended edits, generated files, debug output and dependency drift.
- [ ] TDD-proof step performed and described in the per-phase notes.

## Notes for downstream phases

- **PHASE-15 consumes these exports.** `GitManagerInProgressStrip` is exported from `apps/web/src/components/gitManager/GitManagerInProgressStrip.tsx` with props `{ operation: GitManagerInProgressOperation; onContinue: () => void; onAbort: () => void; blocked: GitManagerBlockedReason | null }`. PHASE-15 must reuse it for rebase/cherry-pick conflicts rather than rendering a second strip, and must render live operation progress through PHASE-10's `<GitManagerOperationBanner>`. Pass stable memoized callbacks.
- `GitManagerStashList` exposes `{ scope, projectRef, entries, selectedSha, onSelectStash: (sha: string) => void, onApply, onPop, onDrop, operationInFlight: boolean }`. `onSelectStash` must be a stable callback (memoize it) — the list is virtualized.
- The pure helpers `buildStashRows`, `resolveStashActionState`, `resolveStashDiscardDialogCopy`, `summarizeMergePreview` and `resolveMergeConfirmCopy` live in the `.logic.ts` siblings and are safe to import from any later phase; nothing in them touches React or atoms.
- **Store slice ownership:** this phase owns exactly `selectedStashSha` and `stashPaneOpen` in `apps/web/src/gitManagerStore.ts`. PHASE-14, PHASE-15 and PHASE-16 must add their own disjoint fields and must not rename or reshape these two.
- **Stable stash identity:** `GitManagerDiffSource`'s stash arm carries `sha`, and `GitManagerStashEntry.sha` is the identity used by `selectedStashSha`. The diff pane passes that sha directly to `getDiff`; PHASE-09 resolves it against the current stash list and returns a structured error if it was dropped or popped, which this phase handles by refetching `gitManager.getStashes`. `resolveStashIndex(entries, sha)` remains only for apply/pop/drop mutation selectors. Because `bibcode:git-manager-state:v1` persists the sha rather than the shifting list index, a selection remains safe across reloads and cannot silently point at a different stash.
- The stash created by PHASE-10's `<GitManagerSwitchWithChangesDialog>` under the `"stash"` strategy is an ordinary, visible entry and appears in this list like any other (spec § 6.3, § 6.4). The dialog copy says so; do not filter it out here.
- The stash diff uses the cache scope string `"git-manager-stash"` with `getRenderablePatch`. PHASE-14 and PHASE-16 must use distinct scope strings (`"git-manager-staging"`, `"git-manager-image"`) so the FNV cache keys in `apps/web/src/lib/diffRendering.ts` never collide.
- Confirmed divergence from the plan's assumptions, already handled here: `apps/web` has `msw` installed but **no test uses it and there is no global test setup file**; tests import from `"vite-plus/test"`, run under the `unit` project (`apps/web/vite.config.app.mjs`, indicative :41 — re-verify), and opt into DOM per file. Any later phase needing a network-denial harness must build it from scratch (PHASE-17 does).
