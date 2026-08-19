# Git Manager / Phase 02 — Project route, panel shell, store, sidebar button

> **For agentic workers:** REQUIRED SUB-SKILL: invoke `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` before touching code. Atomic steps use checkbox (`- [ ]`) syntax — tick them off in this file as you go.

**Goal:** Make the Git Manager reachable and shaped — a project-scoped route with a region-based shell, a two-project LRU state store, the read atoms, and the sidebar button that opens it.

**Architecture:** Implements § "Phase 2 — Project route, panel shell, ref tree" of `../master-plan.md`, minus the ref tree itself. The shell renders four **region files** (`RefTreeRegion`, `CommitGraphRegion`, `CommitDetailRegion`, `OperationsRegion`) created here as placeholders; Phases 05, 06, 08 and 09 each own exactly one of them, which is what keeps parallel web phases from editing the same file. This phase also owns the whole read-atom layer in `state/gitManager.ts` so no later phase has to touch it.

**Tech Stack:** React 19 + TypeScript + TanStack Router + zustand + `@effect/atom-react`. Test: `vp test apps/web/src/components/git-manager`. Gates: `vp check`, `vp run typecheck`. UI primitives: `@base-ui/react`, `lucide-react`, Tailwind via `cn()`.

---

## Files

- **Create:** `apps/web/src/routes/_chat.project.$environmentId.$projectId.tsx` — the project-scoped route.
- **Create:** `apps/web/src/gitManagerStore.ts` + `gitManagerStore.test.ts` — per-project view state with a 2-entry LRU.
- **Create:** `apps/web/src/state/gitManager.ts` — read atoms for graph pages, refs snapshot, commit detail, commit diff.
- **Create:** `apps/web/src/components/git-manager/GitManagerView.tsx` + `GitManagerView.test.tsx` — the shell.
- **Create:** `apps/web/src/components/git-manager/GitManagerUnavailable.tsx` — disconnected/unsupported state.
- **Create:** `apps/web/src/components/git-manager/RefTreeRegion.tsx` — placeholder owned by Phase 05.
- **Create:** `apps/web/src/components/git-manager/CommitGraphRegion.tsx` — placeholder owned by Phase 06.
- **Create:** `apps/web/src/components/git-manager/CommitDetailRegion.tsx` — placeholder owned by Phase 08.
- **Create:** `apps/web/src/components/git-manager/OperationsRegion.tsx` — placeholder owned by Phase 09.
- **Modify:** `apps/web/src/components/Sidebar.tsx` — add the git-manager button before the new-worktree button (~line 3037-3069) and restore an open project view from the project-header click.
- **Modify:** `apps/web/src/components/Sidebar.test.tsx` — cover the new button and the restore behavior.

## Dependencies

- Phase 00: Wire contracts for the whole feature.

## Owner Agent

`general-purpose`

## Risk / Effort

Risk: Medium (touches a 4,685-line Sidebar and adds a new route). Effort: ~2.5 h.

---

## Skills to Invoke (teammate-side)

**Always-on:**

1. `Skill(skill="superpowers:using-superpowers")` — establish skill discipline
2. `Skill(skill="superpowers:subagent-driven-development")` — execution discipline for this phase
3. `Skill(skill="superpowers:test-driven-development")` — red-green-refactor for the store and route tests
4. `Skill(skill="superpowers:verification-before-completion")` — required gate before marking complete

**Matched for this phase:**

5. `Skill(skill="vercel-react-best-practices")` — stable callbacks and no re-render storms in the shell
6. `Skill(skill="ponytail:ponytail")` — smallest possible edit inside the 4,685-line Sidebar

## Documents to Read

- `../master-plan.md` — § Technical Requirements → Web (routing, visibility, components), § Phase 2.
- `../issue.specs` — § Interview Notes → "Surface and visibility" (the exact show/hide rule).
- `AGENTS.md` (repo root) — package roles; `apps/web` owns UX only, the server owns policy.
- `.repos/effect-smol/LLMS.md` — required before writing Effect code (the atoms in `state/gitManager.ts`).
- `apps/web/src/components/CreateWorktreeDialog.tsx` — the RPC-command + atom pattern to copy.
- `apps/web/src/state/vcs.ts` — how `vcsEnvironment` query atoms are declared.
- `apps/web/src/centerPanelStore.ts` — note it is **thread-keyed**; do not force project state into it.
- `apps/web/src/components/Sidebar.tsx:3037-3069` — the icon-button row on the project header (`new-worktree-button` is the anchor).
- `apps/web/src/routes/_chat.$environmentId.$threadId.tsx` — the sibling route shape.

---

## Pre-execution check

- [ ] **Step 02.0: Claim the phase.** Set Phase 02 in `../tasks.md` → `in_progress`, `Agent = phase-02`, `Started = YYYY-MM-DD HH:MM`; append a "picked up" line.

## Atomic steps

- [ ] **Step 02.1: Locate the surface area.**

	```bash
	grep -n "new-worktree-button" apps/web/src/components/Sidebar.tsx
	grep -rn "createFileRoute" apps/web/src/routes/_chat.\$environmentId.\$threadId.tsx
	```

	Read the button block and the sibling route. Note the router's file-naming convention and whether route generation is automatic. Record deviations in `../tasks.md`.

- [ ] **Step 02.2: Author the first failing test** — `apps/web/src/gitManagerStore.test.ts`:

	```ts
	import { describe, expect, it } from "vite-plus/test";
	import { GIT_MANAGER_CACHE_LIMIT, gitManagerStoreActions, useGitManagerStore } from "./gitManagerStore";

	describe("gitManagerStore", () => {
	  it("keeps at most two projects and evicts the least recently used", () => {
	    const ref = (id: string) => ({ environmentId: "local", projectId: id });
	    gitManagerStoreActions.open(ref("a"));
	    gitManagerStoreActions.open(ref("b"));
	    gitManagerStoreActions.open(ref("c"));
	    const state = useGitManagerStore.getState();
	    expect(Object.keys(state.byProjectKey)).toHaveLength(GIT_MANAGER_CACHE_LIMIT);
	    expect(state.byProjectKey["local:a"]).toBeUndefined();
	  });
	});
	```

- [ ] **Step 02.3: Run it; expect FAIL** — module not found.

	```bash
	vp test apps/web/src/gitManagerStore.test.ts
	```

- [ ] **Step 02.4: Implement `gitManagerStore.ts`** — zustand store, `byProjectKey` keyed with the existing `scopedProjectKey` helper, `lru: string[]`, `GIT_MANAGER_CACHE_LIMIT = 2`, and the selectors named in `../master-plan.md` § Phase 2 (`selectGitManagerProjectState`, `hasOpenGitManager`) plus actions to set selection, filter, loaded page count, and scroll index.

- [ ] **Step 02.5: Run the test; expect PASS.**

- [ ] **Step 02.6: Add store tests for state retention** — reopening a cached project returns the previous selection/scroll; opening a third project evicts the oldest but leaves the other two intact.

- [ ] **Step 02.7: Write `state/gitManager.ts`** — read atoms wrapping `vcs.listCommitGraph`, `vcs.graphRefs`, `vcs.commitDetail`, `vcs.commitDiff` for a given environment + cwd, following `apps/web/src/state/vcs.ts`. Note that file's real shape: it is a thin wrapper over atoms defined in `@bibcode/client-runtime/state/vcs`, not raw zustand. Match that layering — the client-runtime layer owns the RPC atoms, `apps/web/src/state/gitManager.ts` wraps them for the UI, and zustand holds only panel/view state. Commit-graph paging must echo the result's `tips` back on every subsequent page (the server pins pages to that snapshot), and expose a splice-on-generation-bump entry point rather than a blunt "discard everything" refresh. Export a `useGitManagerReads(projectRef)` hook returning `{ refs, graphPages, loadNextPage, commitDetail, commitDiff, isUnavailable, refresh }`. Later phases consume this and must not add their own read atoms.

- [ ] **Step 02.8: Write the shell + its failing test first.** `GitManagerView.test.tsx` asserts: it renders the four regions; when the environment is disconnected it renders `GitManagerUnavailable` instead and never calls the read atoms. Then implement `GitManagerView.tsx` with the layout from the screenshots — toolbar slot on top (`OperationsRegion`), `RefTreeRegion` on the left, `CommitGraphRegion` centre, `CommitDetailRegion` bottom — and the four placeholder region files, each exporting a component that renders a single "coming in phase NN" empty state.

	**Region components take no props.** Each one reads the project identity from the route params (and its data from `useGitManagerReads` / `gitManagerStore`) on its own. This is what makes the conflict-free rounds real: if regions were prop-driven, every later web phase would have to edit `GitManagerView.tsx` to add its props, and the phases would collide. Write this convention as a comment at the top of `GitManagerView.tsx` and in each placeholder, so the phase that replaces a region does not "helpfully" convert it to props.

- [ ] **Step 02.9: Add the route.** `apps/web/src/routes/_chat.project.$environmentId.$projectId.tsx` renders `GitManagerView` for the params, inside the same `SidebarInset` shell the thread route uses. Add a route test asserting the params reach the view.

- [ ] **Step 02.10: Add the sidebar button (failing test first).** In `Sidebar.test.tsx`, assert a control with `data-testid="git-manager-button"` and accessible name `Git manager for <project>` exists on each project card and navigates to `/project/<environmentId>/<projectId>`. Then add the button in `Sidebar.tsx` immediately **before** the new-worktree `Tooltip` block, reusing `SIDEBAR_ICON_ACTION_BUTTON_CLASS`, with `GitBranchIcon` and the tooltip text `Git manager`.

- [ ] **Step 02.11: Add the card-restore behavior (failing test first).** Assert: after opening project A's manager and navigating to a thread, clicking project A's header navigates back to the project route **and** still toggles the thread list; clicking a project that was never opened only toggles. Implement by consulting `hasOpenGitManager(...)` in the existing project-header click handler — do not replace the existing toggle.

- [ ] **Step 02.11b: Cover every environment kind (AC13).** Add tests that the button renders and the route resolves for a local project, a desktop-local sandbox project, and a remote-environment project — the RPCs are environment-scoped, so the only thing that varies is which environment the atoms address. A disconnected environment renders `GitManagerUnavailable`. Without this, AC13 has no coverage anywhere in the plan.

- [ ] **Step 02.12: Accessibility pass.** Icon-only button has an `aria-label`; the region placeholders are landmarks or labelled containers; keyboard focus order runs toolbar → tree → graph → detail.

- [ ] **Step 02.13: Full gate.**

	```bash
	vp test apps/web/src/components/git-manager apps/web/src/gitManagerStore.test.ts apps/web/src/components/Sidebar.test.tsx
	vp run typecheck
	vp check
	```

- [ ] **Step 02.14: Run it for real.** Start the dev server, click the button on a project card, confirm the shell renders, navigate to a thread and back via the card, confirm the view returns. **Phase 01 runs in the same round, so the read RPCs may not exist yet** — read errors or empty regions are expected here; this step asserts the button, navigation, restore and unavailable states only, not real Git data. `superpowers:verification-before-completion` is mandatory here — tests alone do not close this step.

- [ ] **Step 02.15: TDD proof.** Set `GIT_MANAGER_CACHE_LIMIT` to `99` and re-run the store tests — the eviction test must fail. Restore, re-run, confirm green.

- [ ] **Step 02.16: Mark complete.** Phase 02 row → `completed`, `Finished = YYYY-MM-DD HH:MM`, plus a summary.

> **No commit step.** This plan is commit-free.

---

## Verification

- [ ] The git-manager button appears on every project card, before the new-worktree button, with an accessible name, and opens the project route.
- [ ] Navigating to a thread hides the view; clicking the project card restores it with its previous selection and scroll; a never-opened project only toggles its thread list.
- [ ] A third project evicts the least-recently-used entry; the other two keep their state.
- [ ] A disconnected environment renders the unavailable state instead of erroring.
- [ ] The four region placeholders exist and are rendered by the shell.
- [ ] `vp test` (scoped), `vp run typecheck`, `vp check` all clean.
- [ ] Change exercised in the running app, not only in tests.
- [ ] TDD-proof step performed and described in the per-phase notes.

## Notes for downstream phases

- **Region ownership is the conflict rule:** Phase 05 owns `RefTreeRegion.tsx`, Phase 06 `CommitGraphRegion.tsx`, Phase 08 `CommitDetailRegion.tsx`, Phase 09 `OperationsRegion.tsx`. No other phase may edit a region it does not own, and nobody but this phase edits `GitManagerView.tsx` until Phase 11. **Regions are prop-less and read the route params themselves** — a later phase that converts a region to props forces an edit to the shell and breaks the conflict-free guarantee for its whole round.
- All reads go through `useGitManagerReads(projectRef)` from `state/gitManager.ts`. Later phases must not declare their own read atoms; operation (write) atoms belong in Phase 09's separate `state/gitManagerOperations.ts`.
- Selection state (`selectedRef`, `selectedCommitSha`, `selectedFilePath`, `filter`, `scrollIndex`) lives in `gitManagerStore` — Phases 05/06/08 read and write it through the exported actions rather than holding local state, or the LRU cache restores nothing.
- Record the exact route path you registered in your completion notes; Phase 11 and the docs phase both cite it.
