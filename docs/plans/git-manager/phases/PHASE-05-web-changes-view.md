# Git Manager / Phase 05 — Web changes view

> **For agentic workers:** REQUIRED SUB-SKILL: invoke `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` before touching code. Atomic steps use checkbox (`- [ ]`) syntax for tracking — tick them off in this file as you go.

**Goal:** Render the Git Manager's changed-file list — live, virtualised, filterable, with inclusion state, context menu, submodule and conflict presentation, and the agent-activity indicator.

**Architecture:** A new `apps/web/src/components/gitManager/changes/` subtree mounted into the Changes tab pane PHASE-03 left empty. Working-tree data comes from the **existing** `subscribeVcsStatus` stream via `vcsEnvironment.status`; conflicted paths come from PHASE-01's `gitManager.getRefs` snapshot, because `VcsWorkingTreeFileStatus` has no unmerged state. This phase is read + selection only — inclusion toggles update local state and the shared draft, but no commit or discard is issued; that lands in PHASE-08. Implements the master plan's § Client (Lists, Agent-activity indicator) and Slice 1's changes half.

**Tech Stack:** React 19 / Vite+ / TanStack Router / zustand / Effect Atom — apps/web. Tailwind CSS 4 + @base-ui/react + lucide-react. Virtualization @legendapp/list; diffs @pierre/diffs. Test: `vp test <path>` (happy-dom, msw). Checks: `vp check`, `vp run typecheck`.

---

## Files

- **Create:** `apps/web/src/components/gitManager/changes/GitManagerChangesView.tsx` — the tab's root
- **Create:** `apps/web/src/components/gitManager/changes/GitManagerChangesView.test.tsx`
- **Create:** `apps/web/src/components/gitManager/changes/GitManagerChangesList.tsx` — virtualised list at 29px rows
- **Create:** `apps/web/src/components/gitManager/changes/GitManagerChangesList.test.tsx`
- **Create:** `apps/web/src/components/gitManager/changes/GitManagerChangeRow.tsx` — one row: inclusion, status icon, submodule/conflict badge
- **Create:** `apps/web/src/components/gitManager/changes/changesList.logic.ts` — pure filtering, inclusion and conflict-join logic
- **Create:** `apps/web/src/components/gitManager/changes/changesList.logic.test.ts`
- **Create:** `apps/web/src/components/gitManager/changes/GitManagerAgentActivity.tsx` — the passive indicator
- **Create:** `apps/web/src/components/gitManager/changes/GitManagerAgentActivity.test.tsx`
- **Modify:** `apps/web/src/components/gitManager/GitManagerPanel.tsx` — **one line only**, mounting `<GitManagerChangesView …>` into the Changes pane

**PHASE-06 runs in the same round and owns `apps/web/src/components/gitManager/history/`.** Do not touch that directory, `apps/web/src/gitManagerStore.ts`, `apps/web/src/state/gitManager.ts`, or any `packages/` file. A store field you need but do not have is requested through `tasks.md`, not added here.

## Dependencies

- Phase 01: Server read modules and read RPCs
- Phase 03: Web panel shell: route, sidebar button, view-state store

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

5. `Skill(skill="vercel-react-best-practices")` — *a list re-rendering under a live agent-driven stream is the hot path here*
6. `Skill(skill="web-design-guidelines")` — *checkboxes, context menu and status badges need labels and keyboard access*

## Documents to Read

- `AGENTS.md` — repo-wide required pre-work, evidence and completion rules
- `docs/plans/git-manager/git-manager-spec.md` — scope and constraints (§ 3.1 changes view, § 6.2 concurrent agent activity, § 8 row heights)
- `docs/plans/git-manager/git-manager-plan.md` — architecture and global constraints (§ Client)
- `docs/plans/git-manager/research/github-desktop-analysis.md` — § 1.1 is the behaviour contract for every control in this view
- `docs/architecture/rpc-and-orchestration.md` — how `subscribeVcsStatus` reconnects and what a partial stream looks like
- `apps/web/src/components/SourceControlChangesList.tsx` and `SourceControlRowActions.logic.ts` — the existing row and context-menu conventions to follow
- `docs/plans/git-manager/phases/PHASE-01-server-read-rpcs.md` § Notes for downstream phases — where conflicted paths come from
- `docs/plans/git-manager/phases/PHASE-03-web-panel-shell.md` § Notes for downstream phases — the prop contract and store selectors

If a file does not exist, report it back in the per-phase notes section of `tasks.md` and continue with what's available.

---

## Pre-execution check

- [ ] **Step 05.0: Claim the phase.** Open `../tasks.md`. Change Phase 05 row → `Status = in_progress`, `Agent = phase-05`, `Started = YYYY-MM-DD HH:MM`. Append a "started — picked up" entry under your Detailed Progress section.

## Atomic steps

- [ ] **Step 05.1: Locate the surface area being changed.** Line numbers are indicative; re-verify.

	```bash
	rg -n 'vcsEnvironment.status' apps/web/src/components/SourceControlPanel.tsx
	rg -n 'VcsWorkingTreeFileStatus|VcsStagingArea' packages/contracts/src/git.ts
	rg -n 'buildRowContextMenu|getRowActions' apps/web/src/components/SourceControlRowActions.logic.ts
	rg -n 'useThreadShellsForProjectRefs' apps/web/src/state/entities.ts
	rg -n 'LegendList' apps/web/src/components/BranchToolbarBranchSelector.tsx
	```

	Note that `VcsWorkingTreeFileStatus` (indicative git.ts:48-55) is `modified | added | deleted | renamed | copied | untracked` — **no unmerged and no submodule state**. Conflict presentation therefore joins `GitManagerRefsSnapshot.conflictedPaths` from `gitManager.getRefs` onto the stream's file list; submodule presentation joins the refs snapshot's worktree/submodule information. Record in `tasks.md` if the working tree disagrees.

- [ ] **Step 05.2: Author the first failing test.** Path: `apps/web/src/components/gitManager/changes/changesList.logic.test.ts`

	```ts
	import { describe, expect, it } from "vitest";
	import { buildChangeRows } from "./changesList.logic";

	describe("buildChangeRows", () => {
	  it("marks a file as conflicted when the refs snapshot lists it", () => {
	    const rows = buildChangeRows({
	      files: [
	        { path: "src/a.ts", insertions: 1, deletions: 0, status: "modified", area: "unstaged" },
	        { path: "src/b.ts", insertions: 2, deletions: 2, status: "modified", area: "unstaged" },
	      ],
	      conflictedPaths: ["src/b.ts"],
	      submodulePaths: [],
	      filterText: "",
	      excludedPaths: new Set(),
	    });
	    expect(rows.map((row) => row.path)).toEqual(["src/a.ts", "src/b.ts"]);
	    expect(rows[1]!.conflicted).toBe(true);
	    expect(rows[0]!.conflicted).toBe(false);
	  });
	});
	```

- [ ] **Step 05.3: Run the new test; expect FAIL** (`buildChangeRows` does not exist).

	```bash
	vp test run apps/web/src/components/gitManager/changes/changesList.logic.test.ts
	```

- [ ] **Step 05.4: Implement the minimum to make Step 05.2 pass.** Path: `apps/web/src/components/gitManager/changes/changesList.logic.ts`. Export `ChangeRow` and `buildChangeRows(input)` — a pure function, no React, no atoms. Keep every subsequent behaviour in this module so it stays unit-testable without rendering.

- [ ] **Step 05.5: Run the test; expect PASS.**

- [ ] **Step 05.6+: Add the remaining behaviour, one failing test at a time.**
	1. **Filtering** — free text over the path, case-insensitive, plus the boolean filters (included / excluded / new / modified / deleted) combined with AND. When a filter hides an included file, `buildChangeRows` reports `hiddenIncludedCount` so the view can warn "hidden changes will be committed".
	2. **Inclusion state** — tri-state per the reference implementation (`all | partial | none`). Partial exists in the model now so PHASE-14's gutter has somewhere to write; in this phase a file is only `all` or `none`. Toggling a `partial` file goes to excluded.
	3. **Include-all header** — mirrors the visible rows only when a filter is active, and labels "N of M changed files".
	4. **Selection semantics** — a click changes the *viewed* file only; Space/Enter toggles inclusion. These are two different interactions and must not be conflated.
	5. **Submodule rows** — a dirty submodule is uncommittable (checkbox disabled with a reason); a partially committable submodule is forced to `partial`.
	6. **Conflicted rows** — rendered with a distinct badge and excluded from inclusion toggling until resolved. Marker counts land in PHASE-15; this phase shows the conflicted state only.
	7. **Blank slates** — "No local changes", and a filter-miss slate with "Clear filters".

- [ ] **Step 05.7: Build the virtualised list.** `GitManagerChangesList.tsx` uses `@legendapp/list` at a fixed **29px** row height (spec § 8), keyed by path. Rows are memoised and receive stable callbacks; the list must not re-render every row when the stream emits an unchanged snapshot. Failing test first: emitting the same status snapshot twice renders each row's body once.

- [ ] **Step 05.8: Wire the live stream.** `GitManagerChangesView.tsx` takes `{ scope: { environmentId, cwd }, projectRef }` from PHASE-03 and subscribes through `vcsEnvironment.status({ environmentId, input: { cwd } })` plus `gitManagerEnvironment.getRefs({ environmentId, input: { cwd } })`. No raw `request` calls. Handle `EnvironmentRpcUnavailableError` distinctly from a git error, and render the pending state before the first connect generation. Failing test first (msw-backed): a reconnect re-attaches the subscription and the list repopulates without a manual refresh.

- [ ] **Step 05.9: Build the context menu.** Reuse the native menu path (`readLocalApi()?.contextMenu.show`) with the browser fallback in `apps/web/src/contextMenuFallback.ts`, following `buildRowContextMenu` in `SourceControlRowActions.logic.ts`. Items: Ignore file / Ignore folder / Ignore all `<ext>` (cap the extension submenu at 5), Include/Exclude selected, Copy path, Copy relative path, Reveal, Open in editor. **Discard is present but disabled with a "lands in PHASE-08" affordance removed before that phase completes** — or omit it entirely and let PHASE-08 add it; record which you chose in `tasks.md`.

- [ ] **Step 05.10: Build the agent-activity indicator.** `GitManagerAgentActivity.tsx` is **presentation only** — it never gates or delays a git operation (spec § 6.2). Source: `useThreadShellsForProjectRefs([projectRef])` (`apps/web/src/state/entities.ts`, indicative :116-120), filtered to threads whose `worktreePath` matches the selected `cwd` (a `null` `worktreePath` means the main checkout) and whose `session.status` is `"starting"` or `"running"`. Render a passive badge naming how many sessions are active. Failing test first: a running session in a *different* worktree does not light the indicator.

- [ ] **Step 05.11: Full build + test gate.**

	```bash
	vp test run apps/web/src/components/gitManager/changes
	vp run typecheck
	vp check
	```

	Expected: zero warnings, zero errors, all tests green.

- [ ] **Step 05.12: Stack-specific verification.** Run the app (`vp run dev`), open the Git Manager on a **local** project and on a **remote-hosted** project. Modify files outside the app and confirm the list updates from the stream without a manual refresh. Start an agent session in the selected checkout and confirm the indicator appears. Verify keyboard navigation and that every icon-only control has an `aria-label`. `superpowers:verification-before-completion` is mandatory here.

- [ ] **Step 05.13: TDD proof.** Make `buildChangeRows` ignore `conflictedPaths` and make the filter always return every row. Re-run the Step 05.11 filter and confirm the conflict test and the filter tests fail. Restore.

- [ ] **Step 05.14: Mark phase complete.** Change Phase 05 row in `tasks.md` → `Status = completed`, `Finished = YYYY-MM-DD HH:MM`. Append a final summary: what landed, how many tests, the exported prop contract, and any deviation.

> **No commit step.** This skill is commit-free: no phase ever produces or requests a git commit. Whether and when to commit the resulting work is a decision the user makes after execution, outside the scope of any phase.

---

## Verification

- [ ] The changed-file list renders live from `subscribeVcsStatus`, virtualised at 29px rows, and updates without a manual refresh when files change on disk.
- [ ] Conflicted files are marked from `GitManagerRefsSnapshot.conflictedPaths`, not from a status field that cannot express them.
- [ ] Filtering (free text plus the five boolean filters) works and reports the hidden-included count.
- [ ] Inclusion is tri-state in the model; click changes the viewed file, Space/Enter toggles inclusion.
- [ ] Submodule rows present uncommittable and partially-committable states correctly.
- [ ] The agent-activity indicator reflects only sessions in the **selected** checkout and never gates or delays anything.
- [ ] No git policy is derived client-side; any server-authored message is rendered verbatim, exposed through both a tooltip and `aria-describedby` on a disabled control, and an unknown blocked code fails closed.
- [ ] All server data flows through `vcsEnvironment` / `gitManagerEnvironment` atoms; no raw `request` or `runStream` call exists in this subtree.
- [ ] Every icon-only control has an `aria-label`; the list is keyboard-navigable.
- [ ] `apps/web/src/gitManagerStore.ts` and `apps/web/src/components/gitManager/history/` are untouched; `GitManagerPanel.tsx` changed by one mount line only.
- [ ] `vp check` and `vp run typecheck` clean; all new tests green.
- [ ] Validated end to end against **both** a local project and a remote-hosted project.
- [ ] **Zero telemetry:** this phase adds no analytics, crash reporting, usage counter, remote feature flag, avatar/identity fetch, third-party host contact, or new dependency. `git diff apps/web/package.json pnpm-lock.yaml` shows no change, and no component fetches an avatar or any third-party asset.
- [ ] Final `git diff` and `git status --short` review: no generated files, no debug output, no unrelated edits.
- [ ] TDD-proof step performed and described in the per-phase notes.

## Notes for downstream phases

- **`GitManagerChangesView` props are `{ scope: { environmentId: EnvironmentId; cwd: string }; projectRef: ScopedProjectRef }`.** Both must be stable/memoised objects; passing a fresh literal per render defeats the row memoisation.
- **`changesList.logic.ts` is the single source of row derivation.** PHASE-08 and PHASE-14 extend `ChangeRow` (adding `selection` detail for partial staging) rather than building a parallel model. `ChangeRow` fields today: `path`, `status`, `area`, `insertions`, `deletions`, `inclusion` (`"all" | "partial" | "none"`), `conflicted`, `submodule`, `disabledReason`.
- **PHASE-08 owns every mutation in this view.** It adds the include/exclude commands (`vcs.stageFiles` / `vcs.unstageFiles`), the commit box, the undo-commit strip and the discard confirmations, wiring them to the existing `SourceControlActionScope = { environmentId, cwd }` hooks in `apps/web/src/state/sourceControlActions.ts`. It must reuse this phase's `ChangeRow.inclusion` rather than introducing a second inclusion model.
- **PHASE-14 (partial staging gutter)** writes `inclusion: "partial"` and a per-line selection into the same `ChangeRow`; the tri-state already exists so PHASE-14 does not have to widen the type.
- **PHASE-15 (conflict UI)** adds marker counts and ours/theirs resolution to the conflicted rows this phase marks; the `conflicted` flag and its badge stay where they are.
- **The agent-activity indicator is presentation only** and must stay that way — no phase may make a git operation wait on it.
