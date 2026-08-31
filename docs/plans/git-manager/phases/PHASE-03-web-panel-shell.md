# Git Manager / Phase 03 — Web panel shell: route, sidebar button, view-state store

> **For agentic workers:** REQUIRED SUB-SKILL: invoke `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` before touching code. Atomic steps use checkbox (`- [ ]`) syntax for tracking — tick them off in this file as you go.

**Goal:** Make the Git Manager reachable — a project-scoped route, the sidebar entry point, the LRU-2 view-state store, the unavailable state, and the toolbar skeleton with the worktree selector — with no git data rendered yet.

**Architecture:** A TanStack file route under the `_chat` layout renders the panel as the centre view, keyed by `(environmentId, projectId)`. The centre-panel store stays thread-keyed and is deliberately untouched: the Git Manager is **not** a new `CenterSurface` kind, which avoids the persisted-state sanitiser, the exhaustive kind switches and the mount predicate entirely. A new persisted zustand store holds view state — not mounted components — for the two most recently used projects. Implements the master plan's § Client (Route, Sidebar button, View state) and Slice 1's shell.

**Tech Stack:** React 19 / Vite+ / TanStack Router / zustand / Effect Atom — apps/web. Tailwind CSS 4 + @base-ui/react + lucide-react. Virtualization @legendapp/list; diffs @pierre/diffs. Test: `vp test <path>` (happy-dom, msw). Checks: `vp check`, `vp run typecheck`.

---

## Files

- **Create:** `apps/web/src/routes/_chat.project.$environmentId.$projectId.git.tsx` — the project-scoped route
- **Create:** `apps/web/src/gitManagerStore.ts` — persisted LRU-2 view-state store
- **Create:** `apps/web/src/gitManagerStore.test.ts` — LRU eviction, keying and migration tests
- **Create:** `apps/web/src/state/gitManager.ts` — web instantiation of the client-runtime atom family
- **Create:** `apps/web/src/components/gitManager/GitManagerPanel.tsx` — panel shell, tabs, unavailable state
- **Create:** `apps/web/src/components/gitManager/GitManagerPanel.test.tsx`
- **Create:** `apps/web/src/components/gitManager/GitManagerToolbar.tsx` — toolbar skeleton with the worktree selector
- **Create:** `apps/web/src/components/gitManager/GitManagerToolbar.test.tsx`
- **Create:** `apps/web/src/components/gitManager/gitManagerAvailability.ts` — pure availability/capability resolution
- **Create:** `apps/web/src/components/gitManager/gitManagerAvailability.test.ts`
- **Modify:** `apps/web/src/components/Sidebar.tsx` — the Git Manager button after "New worktree"
- **Modify:** `apps/web/src/components/Sidebar.test.tsx` (or the closest existing sidebar test file) — button behaviour
- **Modify (generated, never hand-edited):** `apps/web/src/routeTree.gen.ts`

## Dependencies

- Phase 00: Wire contracts for the whole feature

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

5. `Skill(skill="web-design-guidelines")` — *the new icon-only sidebar button and tabs need labels and keyboard access*
6. `Skill(skill="vercel-react-best-practices")` — *the panel must not hold subscriptions for unviewed projects*

## Documents to Read

- `AGENTS.md` — repo-wide required pre-work, evidence and completion rules
- `docs/plans/git-manager/git-manager-spec.md` — scope and constraints (§ 4 surface and lifecycle, § 5 toolbar, § 6.1 worktrees)
- `docs/plans/git-manager/git-manager-plan.md` — architecture and global constraints (§ Client)
- `docs/plans/git-manager/research/bibcode-integration-surface.md` — § 1 has the "New worktree" handler chain, § 5 the remote-server constraints, § 7 the web conventions
- `docs/architecture/connection-runtime.md` — disconnected environments must never be re-dialled by a mounting panel; capability reads come from the same session
- `docs/architecture/remote.md` — `(environmentId, projectId)` addressing and opaque remote paths
- `apps/web/src/sourceControlPanelStore.ts` — the persisted-zustand convention this store must follow
- `docs/plans/git-manager/phases/PHASE-00-contracts.md` § Notes for downstream phases — the atom module and capability flag names

If a file does not exist, report it back in the per-phase notes section of `tasks.md` and continue with what's available.

---

## Pre-execution check

- [ ] **Step 03.0: Claim the phase.** Open `../tasks.md`. Change Phase 03 row → `Status = in_progress`, `Agent = phase-03`, `Started = YYYY-MM-DD HH:MM`. Append a "started — picked up" entry under your Detailed Progress section.

## Atomic steps

- [ ] **Step 03.1: Locate the surface area being changed.** Line numbers are indicative; re-verify.

	```bash
	ls apps/web/src/routes/
	rg -n 'new-worktree-button|handleCreateWorktreeClick|runProjectMemberAction|openWorktreeForProjectMember|SIDEBAR_ICON_ACTION_BUTTON_CLASS' apps/web/src/components/Sidebar.tsx
	rg -n 'projectKey|parseProjectKey' packages/client-runtime/src/state/entities.ts
	rg -n 'useEnvironmentConnectionState' apps/web/src/state/environments.ts
	cat apps/web/src/connection/environmentCompat.ts
	```

	Confirm the **flat dot-separated** file-route convention (`_chat.$environmentId.$threadId.tsx`), so the new file is `_chat.project.$environmentId.$projectId.git.tsx` giving the URL `/project/$environmentId/$projectId/git`. Confirm `apps/web/src/routeTree.gen.ts` is tracked and plugin-generated — **never hand-edit it**; it regenerates when the dev server or build runs.

- [ ] **Step 03.2: Author the first failing test.** Path: `apps/web/src/gitManagerStore.test.ts`

	```ts
	import { describe, expect, it } from "vitest";
	import { useGitManagerStore } from "./gitManagerStore";

	const ref = (environmentId: string, projectId: string) =>
	  ({ environmentId, projectId }) as never;

	describe("gitManagerStore", () => {
	  it("evicts the least recently used project when a third is touched", () => {
	    const store = useGitManagerStore.getState();
	    store.touchProject(ref("env-a", "p1"));
	    store.touchProject(ref("env-a", "p2"));
	    store.touchProject(ref("env-a", "p3"));
	    const keys = Object.keys(useGitManagerStore.getState().byProjectKey);
	    expect(keys).toHaveLength(2);
	    expect(keys).not.toContain("env-a:p1");
	  });

	  it("keys by environment and project, not by bare project id", () => {
	    const store = useGitManagerStore.getState();
	    store.setActiveTab(ref("env-a", "p1"), "history");
	    expect(store.selectViewState(ref("env-b", "p1")).activeTab).toBe("changes");
	  });
	});
	```

- [ ] **Step 03.3: Run the new test; expect FAIL** (the store does not exist yet).

	```bash
	vp test run apps/web/src/gitManagerStore.test.ts
	```

- [ ] **Step 03.4: Implement the minimum to make Step 03.2 pass.** Path: `apps/web/src/gitManagerStore.ts`. Follow `apps/web/src/sourceControlPanelStore.ts` exactly: `create<…>()(persist(…))` with `name: "bibcode:git-manager-state:v1"`, `version: 1`, `storage: createJSONStorage(() => resolveStorage(...))` from `./lib/storage`, and `partialize` to the state record. Key with `projectKey(ref)` from `@bibcode/client-runtime/state/entities` — **never a bare `projectId`**, which collides across environments. State per project: `selectedWorktreeCwd`, `activeTab` (`"changes" | "history"`), `selectedRef`, `selectedCommitSha`, `selectedFilePath`, `filterText`, `loadedPageCount`, `scrollAnchor`, `commitDraft`, `lastUsedAt`. `touchProject` sets `lastUsedAt` and evicts down to the two most recent.

- [ ] **Step 03.5: Run the test; expect PASS.**

- [ ] **Step 03.6: Add the availability resolution and its tests.** Path: `apps/web/src/components/gitManager/gitManagerAvailability.ts` — a pure function taking the connection state and the environment's `ServerConfig` and returning a discriminated result: `{ kind: "ready" }`, `{ kind: "pending" }`, `{ kind: "disconnected", reason }`, `{ kind: "unsupported", missingCapability }`. Read the capability the way `apps/web/src/connection/environmentCompat.ts` does (`serverConfig?.environment.capabilities.gitManagerReads === true`) — from the same session the requests will run on. Tests: a `null` `ServerConfig` yields `pending`, never `unsupported`; a deliberately disconnected environment yields `disconnected` and the panel must **not** trigger a dial.

- [ ] **Step 03.7: Create the web atom wrapper.** Path: `apps/web/src/state/gitManager.ts`

	```ts
	import { createGitManagerEnvironmentAtoms } from "@bibcode/client-runtime/state/git-manager";

	import { connectionAtomRuntime } from "../connection/runtime";

	export const gitManagerEnvironment = createGitManagerEnvironmentAtoms(connectionAtomRuntime);
	```

	Mirrors `apps/web/src/state/vcs.ts`. No other web file may call `request` directly.

- [ ] **Step 03.8: Build the panel shell.** Path: `apps/web/src/components/gitManager/GitManagerPanel.tsx`. Props: `{ projectRef: ScopedProjectRef }`. It resolves the project through `useProject(projectRef)` (`apps/web/src/state/entities.ts`, indicative :122-125), treats `workspaceRoot` as an **opaque** path (it may live on a remote host — never resolve or join it client-side), reads the view state from the store, renders the `unavailable` state from Step 03.6 verbatim when not `ready`, and otherwise renders the toolbar plus a Changes/History tab strip with empty panes. Tabs use `@base-ui/react` primitives and are keyboard-navigable. Failing test first: the panel renders the disconnected reason and issues **no** RPC when the environment is disconnected.

- [ ] **Step 03.9: Build the toolbar skeleton with the worktree selector.** Path: `apps/web/src/components/gitManager/GitManagerToolbar.tsx`. Three segments per spec § 5, with only segment 1 functional in this phase: the worktree selector listing the project's main checkout plus its worktrees (from the existing worktree-catalog atoms), **defaulting to the main checkout on open** and persisting the choice into the store for the session. Segments 2 and 3 render disabled placeholders with `aria-label`s; PHASE-10 fills them. Failing test first: opening the panel selects the main checkout even when the store holds a worktree from a previous session for a *different* project.

- [ ] **Step 03.10: Create the route.** Path: `apps/web/src/routes/_chat.project.$environmentId.$projectId.git.tsx`. `createFileRoute` with a component that reads `Route.useParams()`, builds the `ScopedProjectRef`, and renders `<GitManagerPanel projectRef={…} />`. A missing or unknown project redirects the same way `_chat.$environmentId.$threadId.tsx` handles a missing thread. The route encodes the panel, so a reload lands back on the same project (spec § 4).

- [ ] **Step 03.11: Add the sidebar button.** In `apps/web/src/components/Sidebar.tsx`, add a `handleOpenGitManagerClick` next to `handleCreateWorktreeClick` (indicative :2514-2519) that calls the **existing** `runProjectMemberAction` (indicative :2475-2497) so a grouped row disambiguates to one physical project exactly as "New worktree" does. The member action navigates to `/project/$environmentId/$projectId/git`. Add the button inside the same hover strip (indicative `<div>` at :3140), immediately **after** the `new-worktree-button` block, reusing `SIDEBAR_ICON_ACTION_BUTTON_CLASS`, the `Tooltip`/`TooltipTrigger` shape, a `lucide-react` icon, `data-testid="git-manager-button"`, and `aria-label={`Git Manager for ${project.displayName}`}`. Clicking it when the panel is already open navigates to the same route, which focuses rather than duplicating (spec § 4, decision 7).

- [ ] **Step 03.12: Add the remaining tests.** One at a time, each failing first:
	- The sidebar button on a multi-member group opens the member chooser and navigates for the chosen member only.
	- Navigating twice to the same project does not create a second panel.
	- View state survives a store rehydrate for the two most recent projects and is gone for the third.
	- `commitDraft` round-trips through the store and its persisted key. **Do not** assert anything about the existing per-thread Source Control draft here: `apps/web/src/sourceControlPanelStore.ts` is keyed `byThreadKey` (a scoped *thread* key), this store is keyed by project, and reconciling the two is PHASE-08's job. This phase only provides the field.
	- The panel holds no subscription when unmounted (assert the atom family is not subscribed after unmount).

- [ ] **Step 03.13: Full build + test gate.**

	```bash
	vp test run apps/web/src/gitManagerStore.test.ts
	vp test run apps/web/src/components/gitManager
	vp test run apps/web/src/components/Sidebar.test.tsx
	vp run typecheck
	vp check
	```

	Expected: zero warnings, zero errors, all tests green. `routeTree.gen.ts` regenerates during the dev/build run — commit nothing, but confirm it changed and was **not** hand-edited.

- [ ] **Step 03.14: Stack-specific verification.** Run the app (`vp run dev`), open a **local** project and a **remote-hosted** project, click the new sidebar button on each, reload the page, and confirm both land back in the Git Manager on the correct project. Disconnect the remote environment and confirm the panel shows the unavailable state and does not re-dial. `superpowers:verification-before-completion` is mandatory here.

- [ ] **Step 03.15: TDD proof.** Change the store's LRU limit to a no-op (keep everything) and change the panel's availability branch to always return `ready`. Re-run the Step 03.13 filters and confirm the eviction test and the disconnected-state test fail. Restore.

- [ ] **Step 03.16: Mark phase complete.** Change Phase 03 row in `tasks.md` → `Status = completed`, `Finished = YYYY-MM-DD HH:MM`. Append a final summary: what landed, how many tests, the exact store selector names, and any deviation.

> **No commit step.** This skill is commit-free: no phase ever produces or requests a git commit. Whether and when to commit the resulting work is a decision the user makes after execution, outside the scope of any phase.

---

## Verification

- [ ] `/project/$environmentId/$projectId/git` renders the panel and survives a page reload on the same project.
- [ ] The sidebar button sits immediately after "New worktree", reuses `runProjectMemberAction` for grouped rows, has an `aria-label`, and focuses an already-open panel rather than opening a second.
- [ ] The store is keyed by `projectKey(environmentId, projectId)`, persists under `bibcode:git-manager-state:v1`, holds at most two projects, and holds **state only** — no panel stays mounted and no subscription is held for an unviewed project.
- [ ] `commitDraft` exists as a persisted store field and round-trips; sharing it with the existing per-thread Source Control draft is explicitly **out of scope** for this phase and left to PHASE-08.
- [ ] Disconnected, reconnecting and capability-lacking environments each render an explicit unavailable state naming the reason, and none dials a deliberately disconnected environment.
- [ ] `apps/web/src/centerPanelStore.ts` and its sanitiser are **unchanged** — the Git Manager is not a `CenterSurface` kind.
- [ ] The toolbar defaults to the project's main checkout on open; switching to a worktree is explicit and remembered for the session.
- [ ] `vp check` and `vp run typecheck` clean; all new tests green.
- [ ] Validated end to end against **both** a local project and a remote-hosted project.
- [ ] **Zero telemetry:** this phase adds no analytics, crash reporting, usage counter, remote feature flag, avatar/identity fetch, third-party host contact, or new dependency. `git diff apps/web/package.json pnpm-lock.yaml` shows no change.
- [ ] Final `git diff` and `git status --short` review: the only generated change is `apps/web/src/routeTree.gen.ts`; no debug output, no unrelated edits.
- [ ] TDD-proof step performed and described in the per-phase notes.

## Notes for downstream phases

- **The route is `/project/$environmentId/$projectId/git`**, file `apps/web/src/routes/_chat.project.$environmentId.$projectId.git.tsx`. No later phase adds a second Git Manager route.
- **`GitManagerPanel` props are `{ projectRef: ScopedProjectRef }`** and nothing else. It resolves `cwd` itself from the selected worktree and passes `{ environmentId, cwd }` down. PHASE-05, PHASE-06, PHASE-08, PHASE-10 and PHASE-12 receive `{ scope: { environmentId, cwd }, projectRef }` as props — a stable, memoised object.
- **Store API other phases call:** `useGitManagerStore` with selectors `selectViewState(ref)`, and actions `touchProject(ref)`, `setSelectedWorktree(ref, cwd)`, `setActiveTab(ref, tab)`, `setSelectedRef(ref, name)`, `setSelectedCommit(ref, sha)`, `setSelectedFile(ref, path)`, `setFilterText(ref, text)`, `setScrollAnchor(ref, anchor)`, `setLoadedPageCount(ref, n)`. **PHASE-05 and PHASE-06 run in the same round and must not change this store's shape.** A field either exists here already or is requested through `tasks.md`; do not add one unilaterally.
- **PHASE-05 owns `apps/web/src/components/gitManager/changes/`, PHASE-06 owns `apps/web/src/components/gitManager/history/`.** Both mount inside the tab panes this phase leaves empty. Neither edits `GitManagerPanel.tsx` beyond the single line that mounts its own subtree — coordinate that line through `tasks.md`.
- **PHASE-08 owns the shared commit draft.** This store carries a `commitDraft` field keyed by `(environmentId, projectId)`; the existing `apps/web/src/sourceControlPanelStore.ts` is keyed `byThreadKey` (a scoped **thread** key) under `bibcode:source-control-panel-state:v1`. Spec § 12 decision 12 requires one source of truth per `(environmentId, cwd)`, so PHASE-08 must reconcile the two — most likely by re-keying the draft on `(environmentId, cwd)` and having both surfaces read it — and must not leave two independent drafts behind.
- **PHASE-10 fills toolbar segments 2 and 3.** The placeholders in `GitManagerToolbar.tsx` are marked with a `TODO(PHASE-10)` comment and must be removed when that phase lands.
- **Server data goes through `gitManagerEnvironment` in `apps/web/src/state/gitManager.ts`.** No web file calls `request` or `runStream` directly; mutations run on the existing per-`(environmentId, cwd)` lane.
- **Availability is resolved once** by `gitManagerAvailability.ts`. Later phases gate their own capability flag (`gitManagerCommitOperations`, `gitManagerBranchSyncOperations`, …) through the same helper rather than reading `serverConfig` ad hoc.
