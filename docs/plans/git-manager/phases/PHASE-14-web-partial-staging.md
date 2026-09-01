# Git Manager / Phase 14 — Web partial staging gutter

> **For agentic workers:** REQUIRED SUB-SKILL: invoke `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` before touching code. Atomic steps use checkbox (`- [ ]`) syntax for tracking — tick them off in this file as you go.

**Goal:** Give the Git Manager diff a per-line and per-hunk selection gutter with drag-select and tri-state hunk handles, wired to PHASE-11's partial staging, partial unstaging and partial discard.

**Architecture:** This phase adds an immutable line-selection model and an interactive gutter under `apps/web/src/components/gitManager/staging/`, layered on the existing `@pierre/diffs` renderer rather than a new one. `AnnotatableCodeView` (`apps/web/src/components/diffs/AnnotatableCodeView.tsx`) already exposes `enableGutterUtility`, `enableLineSelection`, controlled `selectedLines` / `onSelectedLinesChange`, `onLineSelectionEnd` and `renderAnnotation`; this phase drives them from a selection model instead of the review-comment flow. It implements Slice 5's client half (`git-manager-plan.md` § Slices). The client computes selection geometry only; every patch is constructed server-side by PHASE-11.

**Tech Stack:** React 19 / Vite+ / TanStack Router / zustand / Effect Atom — apps/web. Tailwind CSS 4 + @base-ui/react + lucide-react. Virtualization @legendapp/list; diffs @pierre/diffs. Test: `vp test run <path>` (tests import from `vite-plus/test`; DOM opt-in per file with a `// @vitest-environment happy-dom` first-line docblock). Checks: `vp check`, `vp run typecheck`.

---

## Files

- **Create:** `apps/web/src/components/gitManager/staging/gitManagerLineSelection.ts` — the immutable selection model
- **Create:** `apps/web/src/components/gitManager/staging/gitManagerLineSelection.test.ts`
- **Create:** `apps/web/src/components/gitManager/staging/gitManagerHunkModel.ts` — contiguous-run grouping and tri-state hunk handles
- **Create:** `apps/web/src/components/gitManager/staging/gitManagerHunkModel.test.ts`
- **Create:** `apps/web/src/components/gitManager/staging/GitManagerStagingGutter.tsx` — the interactive gutter rendered into the diff
- **Create:** `apps/web/src/components/gitManager/staging/GitManagerStagingGutter.test.tsx`
- **Create:** `apps/web/src/components/gitManager/staging/GitManagerPartialDiscardDialog.tsx` + `.logic.ts` + `.logic.test.ts` — partial discard of a selection, behind confirmation
- **Modify:** `apps/web/src/components/gitManager/changes/GitManagerDiffPane.tsx` — pass the gutter and the selection into the diff (exact file name to be confirmed against PHASE-05's working tree)
- **Modify:** `apps/web/src/gitManagerStore.ts` — add ONLY the `staging` view-state slice (`lineSelectionByPath`); do not touch other slices
- **Modify:** `apps/web/src/state/gitManager.ts` — re-export PHASE-11's partial stage, unstage and discard commands (`gitManager.stagePartial`, `gitManager.unstagePartial`, `gitManager.discardPartial`) if PHASE-11 left the web wrapper incomplete.

## Dependencies

- Phase 11: Server hunk and line staging
- Phase 08: Web staging and commit UI

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

5. `Skill(skill="vercel-react-best-practices")` — _drag-select fires per pointer move over a virtualized diff_
6. `Skill(skill="web-design-guidelines")` — _the gutter must be keyboard-operable, not pointer-only_

## Documents to Read

- `AGENTS.md` — repo-wide required pre-work, evidence and completion rules
- `docs/plans/git-manager/git-manager-spec.md` — scope and constraints; § 3.1 (hunk- and line-level staging), § 6.5 (discard confirmations), § 8 (diff size ladder)
- `docs/plans/git-manager/git-manager-plan.md` — architecture and global constraints; § Server "The staging model", § Client "Diffs"
- `docs/plans/git-manager/research/github-desktop-analysis.md` — § 1.1 rows "Partial staging" and "DiffSelection model" are the behaviour contract; § 3.2 is the server-side patch pipeline PHASE-11 implements
- `docs/plans/git-manager/research/bibcode-integration-surface.md` — § 3.4 the existing diff path and worker pool
- `docs/reference/scripts.md` — the exact `vp` commands used below
- `apps/web/src/components/diffs/AnnotatableCodeView.tsx` — the existing gutter/selection props this phase drives
- `apps/web/src/lib/diffRendering.ts` — `getRenderablePatch`, `compactPartialHunkOffsets`, `FileDiffMetadata` hunk fields

---

## Pre-execution check

- [ ] **Step 14.0: Claim the phase.** Open `../tasks.md`. Change Phase 14 row → `Status = in_progress`, `Agent = phase-14` (or your subagent name), `Started = YYYY-MM-DD HH:MM`. Append a "started — picked up" entry under your Detailed Progress section.

## Atomic steps

- [ ] **Step 14.1: Locate the surface area being changed.**

  ```bash
  rg -n "enableGutterUtility|enableLineSelection|selectedLines|onSelectedLinesChange|onLineSelectionEnd|renderAnnotation" apps/web/src/components/diffs/AnnotatableCodeView.tsx
  rg -n "SelectedLineRange|FileDiffMetadata|hunks" apps/web/src/lib/diffRendering.ts apps/web/src/reviewCommentContext.ts
  rg -n "stagePartial|unstagePartial|discardPartial|selectedLines|GitManagerDiffSource" packages/contracts/src/gitManager.ts packages/client-runtime/src/state/gitManager.ts
  rg --files apps/web/src/components/gitManager
  ```

  `AnnotatableCodeView` props (indicative :73 — re-verify) are `files`, `sectionId`, `sectionTitle`, `composerDraftTarget`, `options`, `viewerRef`, `className`, `renderHeaderPrefix`; its internal `CodeView` options include `enableGutterUtility`, `enableLineSelection`, `onLineSelectionEnd` and controlled `selectedLines` (indicative :238-245). `SelectedLineRange` from `@pierre/diffs` is `{ start, end, side, endSide? }` with `side: "additions" | "deletions"`. `packages/contracts/src/gitManager.ts` is authoritative for the wire selection shape PHASE-11 accepts.

  **PHASE-00's Step 00.7 method table is binding and wins every disagreement.** This phase has exactly three mutations available: **`gitManager.stagePartial`**, **`gitManager.unstagePartial`** and **`gitManager.discardPartial`**. PHASE-11's `format_selection_patch`, `parse_working_tree_diff` and the `selectedLines` wire field are still correct names: they identify the patch algorithm and the request payload, not the RPC.

  **Four contracts PHASE-11 published that this phase must honour exactly:**
  1.  `selectedLines` is a set of **0-based indices over the unified-diff body of the file's current working-tree-source diff** — staged for unstage, unstaged for stage or discard — in the same coordinate space the client's parsed patch uses. Derive the indices from the same diff payload the server produced, or the selection will not line up.
  2.  Every selection request carries the generation the diff was read at. A mismatch returns a structured stale error: re-read the diff and ask the user to re-select rather than retrying blindly. Partial unstage and partial discard fail closed.
  3.  Untracked files are made diffable server-side with `git add --intent-to-add`, so the gutter may be offered on them.
  4.  A **renamed** path falls back to whole-file staging with a stated reason — the reference's index-recreation path is not implemented. Render that reason instead of offering a gutter that cannot work.

  Record further deviations in the per-phase notes of `tasks.md`.

- [ ] **Step 14.2: Author the first failing test.**

  Path: `apps/web/src/components/gitManager/staging/gitManagerLineSelection.test.ts`

  Import `describe, expect, it` from `"vite-plus/test"`. Pin one behaviour of the immutable model, mirroring the reference contract in `research/github-desktop-analysis.md` § 1.1: `createLineSelection(kind)` for `kind: "all" | "none"` produces a selection whose `type` is `"all"` or `"none"` and whose diverging-index set is empty; `withToggleLine(selection, index)` returns a NEW selection whose `type` becomes `"partial"` and whose set holds exactly that index. The model must be a default type plus a set of diverging unified-diff line indices — never a materialised per-line array.

- [ ] **Step 14.3: Run the new test; expect FAIL** (the module does not exist yet).

  ```bash
  vp test run apps/web/src/components/gitManager/staging/gitManagerLineSelection.test.ts
  ```

- [ ] **Step 14.4: Implement the minimum to make Step 14.2 pass.**

  Path: `apps/web/src/components/gitManager/staging/gitManagerLineSelection.ts`

  Export `type GitManagerLineSelectionType = "all" | "partial" | "none"`, `interface GitManagerLineSelection { readonly type; readonly diverging: ReadonlySet<number>; readonly selectable: ReadonlySet<number> | null }`, `createLineSelection`, `withToggleLine`. Every mutator returns a new object; nothing is mutated in place.

- [ ] **Step 14.5: Run the test; expect PASS.**

- [ ] **Step 14.6: Add the remaining selection-model tests and implementation, one at a time.**

  - `withLineSelection(selection, index, selected)` — set a single line explicitly.
  - `withRangeSelection(selection, from, to, selected)` — the drag-select primitive; must be inclusive of both ends and correct when `from > to`.
  - `withSelectAll` / `withSelectNone` — collapse back to a pure type with an empty set.
  - `isLineSelected(selection, index)` — reads through the default type when the index is not diverging.
  - `resolveSelectionType(selection)` — returns `"all"` when every selectable line is selected, `"none"` when none is, `"partial"` otherwise. Cover the empty-file edge case.
  - `toWireSelection(selection, path, generation)` — produces PHASE-11's request payload from the model, carrying the generation the diff was read at. Assert it sends 0-based unified-diff line indices, never a patch: patch construction is server-owned by `format_selection_patch` in `apps/server/src/git/manager/patch.rs` (`git-manager-plan.md` § Server).
  - A stale-generation response leaves the selection untouched and surfaces the server's message; assert it does not silently retry.

- [ ] **Step 14.7: Add the hunk-model tests, then implement `gitManagerHunkModel.ts`.**

  The reference's "hunk" for staging purposes is **a run of consecutive added/deleted lines, not a `@@` hunk** (`research/github-desktop-analysis.md` § 1.1). Export `groupContiguousRuns(fileDiff)` deriving those runs from `FileDiffMetadata.hunks[]` (`splitLineStart`, `unifiedLineStart`, `splitLineCount`, `unifiedLineCount`, `isPartial`) plus the line kinds, and `resolveHunkHandleState(selection, run)` returning `"all" | "partial" | "none"`. Cover: a run split by a context line becomes two runs; a run whose lines are half selected reports `"partial"`; toggling a `"partial"` handle selects the whole run (matching the reference's tri-state behaviour, where a Partial _file_ checkbox instead toggles to excluded — keep the two rules distinct and test both).

- [ ] **Step 14.8: Add the gutter component test, then implement `GitManagerStagingGutter.tsx`.**

  Follow the dominant house style in `apps/web/src/components/SourceControlSection.test.tsx`: `vi.hoisted` harness + `renderToStaticMarkup`, no jsdom; add `// @vitest-environment happy-dom` on line 1 only for the pointer-drag test that genuinely needs DOM events. Assert:
  - each line checkbox carries an `aria-label` naming the line number and side;
  - each hunk handle exposes `aria-checked` with `"true" | "false" | "mixed"`;
  - the gutter is keyboard-operable — Space toggles the focused line, Shift+Space extends from the last anchor;
  - a staged selection exposes a keyboard-reachable partial-unstage control, while an unstaged selection exposes partial-stage;
  - pointer drag from line A to line B selects the inclusive range through `withRangeSelection`, and a drag that leaves the diff still terminates the drag;
  - the gutter is **disabled while a commit is in flight and while whitespace is hidden**, matching the reference contract, and renders the reason rather than silently no-opping;
  - the gutter is **not offered at all** when PHASE-06's `classifyDiffPayload` (`apps/web/src/components/gitManager/history/diffLadder.ts`) reports the file as large-text, binary, submodule or unrenderable, nor on a renamed path — each case renders its stated reason. Reuse `classifyDiffPayload`; do not bypass it, and do not re-implement the size ladder.

  Wire it through `AnnotatableCodeView`'s existing `enableGutterUtility` / `enableLineSelection` / `onSelectedLinesChange` / `onLineSelectionEnd` props. Do not fork the component and do not add a second diff renderer or worker pool.

- [ ] **Step 14.9: Wire selection to PHASE-11's staging commands.**

  Modify the Git Manager diff pane created by PHASE-05 to pass `selection`, `onSelectionChange` and the staging actions. An unstaged partial selection dispatches **`gitManager.stagePartial`**; a staged partial selection exposes the gutter's unstage control and dispatches **`gitManager.unstagePartial`**. Both go through existing environment-scoped Effect Atom commands on the per-`(environmentId, cwd)` lane — never a raw RPC `request`. Unstaging changes only the index; discarding changes only the working tree. They are **not equivalent and must never be substituted for one another**. Assert with tests that changing the selection does not re-issue either command, that the correct command is chosen from the staged state, and that each command carries the current selection at press time (take a fresh snapshot; do not close over a stale one — agents write to this repository continuously, spec § 6.2).

- [ ] **Step 14.10: Add partial-discard tests, then implement the dialog.**

  Path: `apps/web/src/components/gitManager/staging/GitManagerPartialDiscardDialog.tsx` + `.logic.ts`.

  Use a plain `Dialog` from `apps/web/src/components/ui/dialog.tsx` with nullable `pending*` state and a pure `resolvePartialDiscardDialogCopy(selection, path)` in the `.logic.ts` sibling — the house convention (see `apps/web/src/components/SourceControlPanel.logic.ts`, indicative :146). The copy must state exactly what will be discarded and that the change cannot be recovered; the confirm button uses `variant="destructive"`. The dialog dispatches **`gitManager.discardPartial`**, whose reverse-patch construction is server-owned; it never constructs a patch itself.

- [ ] **Step 14.11: Add the store slice and its test.**

  Add only `lineSelectionByPath: Record<string, SerializedGitManagerLineSelection>` to `apps/web/src/gitManagerStore.ts`, inside the existing per-project view-state record keyed by `(environmentId, projectId)`, plus its setter alongside PHASE-03's existing action set (`touchProject`, `setSelectedWorktree`, `setActiveTab`, `setSelectedRef`, `setSelectedCommit`, `setSelectedFile`, `setFilterText`, `setScrollAnchor`, `setLoadedPageCount`). Serialise the diverging set as a sorted number array so the persisted `bibcode:git-manager-state:v1` payload stays JSON-safe, and add the field to the store's sanitiser so a reload does not silently drop it. PHASE-03's note is explicit that a new field is requested through `tasks.md` before it is added — do that. Extend PHASE-03's existing store test.

- [ ] **Step 14.12: Full build + test gate.**

  ```bash
  vp test run apps/web/src/components/gitManager/staging apps/web/src/gitManagerStore.test.ts
  vp run typecheck
  vp check
  ```

  Expected: zero warnings, zero errors, all tests green.

- [ ] **Step 14.13: Exercise the gutter in the running app.**

  `vp run dev`, open the Git Manager Changes tab on a file with several separated edits, and verify against **both** a local project and a remote-hosted project (attach one per `docs/user/remote-access.md`): drag-selecting a range highlights exactly those lines; a hunk handle shows the mixed state and toggling it selects the whole run; staging a partial selection stages exactly those lines (confirm with `git diff --cached` in a terminal); unstaging a partial selection removes exactly those lines from the index without changing the working-tree file; partial discard removes exactly those lines from the working tree without changing the index; and the gutter is disabled with a stated reason while a commit runs.

- [ ] **Step 14.14: TDD proof.** Make `withRangeSelection` ignore its `to` argument and `resolveHunkHandleState` always return `"none"`. Re-run the Step 14.12 test filter and confirm the affected tests DO fail. Restore the real implementations.

- [ ] **Step 14.15: Mark phase complete.** Change Phase 14 row in `tasks.md` → `Status = completed`, `Finished = YYYY-MM-DD HH:MM`. Append a final summary entry under your Detailed Progress section: what was delivered, how many tests landed, any deviations from the plan.

> **No commit step.** This skill is commit-free: no phase ever produces or requests a git commit. Whether and when to commit the resulting work is a decision the user makes after execution, outside the scope of any phase.

---

## Verification

- [ ] The selection model is immutable: every mutator returns a new object, proven by an identity assertion in the tests.
- [ ] No patch text is constructed anywhere in `apps/web` — `rg -n '@@ -|\\+\\+\\+ b/' apps/web/src/components/gitManager/staging` returns nothing; the client sends line indices only.
- [ ] The gutter is fully keyboard-operable and every control carries an `aria-label` or `aria-checked`; hunk handles expose `"mixed"` for the partial state.
- [ ] Drag-select is disabled while committing and while whitespace is hidden, with the reason rendered.
- [ ] The gutter stages unstaged selections and unstages staged selections through their distinct RPC commands; partial discard is never used as an unstage substitute.
- [ ] The existing `@pierre/diffs` worker pool is reused; `rg -n "DiffWorkerPoolProvider|WorkerPoolContextProvider" apps/web/src/components/gitManager` finds no second pool.
- [ ] All new tests green: `vp test run apps/web/src/components/gitManager/staging`.
- [ ] `vp check` clean and `vp run typecheck` clean.
- [ ] Validated end to end against **both** a local project and a remote-hosted project.
- [ ] **Zero-telemetry check:** this phase added no analytics, crash reporting, usage counter, remote feature flag, avatar or identity fetch, third-party host contact, or new dependency. Confirm with `git diff apps/web/package.json` (empty) and by grepping the new files for `fetch(`, `XMLHttpRequest`, `new Image(`, `src="http` — all must be absent.
- [ ] Final `git diff` and `git status --short` review for unintended edits, generated files, debug output and dependency drift.
- [ ] TDD-proof step performed and described in the per-phase notes.

## Notes for downstream phases

- **PHASE-15 and PHASE-16 import from `apps/web/src/components/gitManager/staging/gitManagerLineSelection.ts`.** Exported names are `GitManagerLineSelectionType`, `GitManagerLineSelection`, `createLineSelection`, `withToggleLine`, `withLineSelection`, `withRangeSelection`, `withSelectAll`, `withSelectNone`, `isLineSelected`, `resolveSelectionType`, `toWireSelection`. Do not re-derive these.
- `GitManagerStagingGutter` props are `{ fileDiff: FileDiffMetadata; selection: GitManagerLineSelection; onSelectionChange: (next: GitManagerLineSelection) => void; disabledReason: string | null }`, and it is mounted from a surface that already receives `{ scope: { environmentId, cwd }, projectRef }` per PHASE-03's prop contract. `onSelectionChange` must be a stable memoized callback — the diff is virtualized and re-renders on every status generation bump.
- `groupContiguousRuns` and `resolveHunkHandleState` in `gitManagerHunkModel.ts` are pure and reusable; PHASE-15's conflict list may reuse `groupContiguousRuns` for marker grouping.
- **Store slice ownership:** this phase owns exactly `lineSelectionByPath` in `apps/web/src/gitManagerStore.ts`. PHASE-12 owns `selectedStashSha` / `stashPaneOpen`; PHASE-15 owns `multiCommitSelection`; PHASE-16 owns `imageDiffMode` / `providerPaneOpen`.
- This phase uses the diff cache scope string `"git-manager-staging"` with `getRenderablePatch`. PHASE-12 uses `"git-manager-stash"` and PHASE-16 uses `"git-manager-image"`; keep them distinct so the FNV keys in `apps/web/src/lib/diffRendering.ts` never collide.
- **Naming that is correct and must not be "fixed":** PHASE-11's `format_selection_patch` and `parse_working_tree_diff` are server functions in `apps/server/src/git/manager/patch.rs`, and `selectedLines` is the request payload field. None of them is an RPC name, so none of them conflicts with the `gitManager.*` method table.
- **Divergence found, already handled here:** the plan assumed the partial-staging gutter is entirely new work. It is not — `AnnotatableCodeView` already exposes gutter and line-selection hooks used by the review-comment flow, and `apps/web/src/lib/diffRendering.ts` already exports `compactPartialHunkOffsets` for partial patches. The new work is the selection model and the staging wiring, not the interaction primitives.
- **Second divergence:** `apps/web` carried no client-side diff size ladder before this feature — the only tuning constants are in `apps/web/src/components/DiffWorkerPoolProvider.tsx` (`poolSize`, `totalASTLRUCacheSize: 240`, `tokenizeMaxLineLength: 1_000`, indicative :51-77). PHASE-06 introduced the ladder as `classifyDiffPayload` in `apps/web/src/components/gitManager/history/diffLadder.ts` and recorded that the reference's 1MB syntax-highlight cap is already satisfied by the existing pool. Use `classifyDiffPayload`; if it is absent when this phase runs, do not add a ladder here — report it in `tasks.md`.
- **Resolved partial-unstage contract:** the canonical table in
  `PHASE-00-contracts.md` defines `gitManager.stagePartial`,
  `gitManager.unstagePartial` and `gitManager.discardPartial`. The gutter offers
  `unstagePartial` for staged selections because BiBCode keeps a visible index,
  unlike the reference implementation's hidden index rebuilt at commit time.
  Unstaging reverses the selected patch in the index without touching the
  working tree; discarding reverses it in the working tree without touching the
  index. They are not equivalent and must never be substituted for one another.
