# Environment Navigation, Center Settings, And Removal UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the repository-grouped sidebar with the approved `Environment -> Project -> Main/threads` navigation tree, keep all details and settings in center workspaces, support useful offline read-only state, and make every removal consequence explicit.

**Architecture:** A pure environment-tree projection consumes normalized catalog, cached shell, and client preference records and produces one flattened, stable row list. A virtualized WAI-ARIA tree renders navigation only. Routes own selection; a dedicated environment center route owns overview/settings/add/remove surfaces. Mutation admission is enforced once in client runtime, while the UI explains the same typed reason rather than queuing offline actions.

**Tech Stack:** React 19, TypeScript 7, Effect 4, Zustand 5, TanStack Router, existing `@legendapp/list` virtualization, Base UI, Tauri bridge capabilities, IndexedDB environment UI state from Plan 20, Vite+ and Testing Library.

**Spec:** [Product and UX specification](./01-product-and-ux.spec.md) and [approved left-panel mockups](./left-panel-mockups.md)

## Global Constraints

- The left panel is navigation only: environment, project, Main, ordinary thread, and worktree-backed thread rows. No tabs, diagnostics panels, connection forms, terminal/file/diff panels, or extra Worktrees level appear there.
- A project belongs to exactly one environment. No active source, draft key, sorting rule, or visual row groups repositories across environments.
- Project selection opens its permanent `kind = "default"` thread labeled Main. The client never creates a missing Main as a click fallback.
- `kind = "panel"` threads remain center tabs/surfaces and never become left rows.
- Expansion, manual order, pinning, alias, hidden state, and exact selected IDs are client-local and identity-scoped.
- First use expands only the selected path; after a user changes disclosure state, cold start restores it exactly.
- Status changes never reorder an already placed environment. New rows receive their default position once.
- Offline cache is visibly stale and read-only. No turn, Git, terminal, worktree, project, thread, setting, uninstall, or purge mutation is queued for replay.
- All statuses use text/icon/accessibility names, not color alone, and there is no generic `Error` row state.
- Environment settings and destructive flows render in the center workspace. The left kebab only navigates to those destinations or performs a reversible immediate action such as Hide after confirmation.
- Keep-data is recommended. Remote uninstall and remote data purge are separate optional, unchecked choices.
- There is no permission-level editor; paired clients are displayed as full environment administrators.
- Preserve existing scoped worktree state, pin/unread metadata, keyboard shortcuts, removal-plan safety, and process cleanup.

---

## File Structure

- Delete after migration: `apps/web/src/sidebarProjectGrouping.ts`, test, `environmentGrouping.test.ts`, and `logicalProject.ts`.
- Create: `apps/web/src/environmentTree.ts`, `environmentTree.test.ts` — pure tree/order/search projection.
- Create: `apps/web/src/environmentNavigationStore.ts`, test — v2 identity-scoped UI state.
- Modify: `apps/web/src/uiStateStore.ts`, test — bounded legacy migration only.
- Modify: `apps/web/src/sidebarWorkspaceMetaStore.ts`, test — scoped thread pin/unread retention.
- Refactor: `apps/web/src/components/Sidebar.tsx`, `Sidebar.logic.ts`, tests — shell and shared behavior.
- Create: `apps/web/src/components/sidebar/EnvironmentTree.tsx`, `EnvironmentRow.tsx`, `ProjectRow.tsx`, `ThreadRow.tsx` and tests.
- Create: `apps/web/src/components/environments/EnvironmentWorkspace.tsx`, model, tabs, add, and removal components/tests.
- Create: `apps/web/src/routes/_chat.environments.$environmentId.tsx`, `_chat.environments.add.tsx`.
- Create: `apps/web/src/routes/settings.environments.tsx`; modify settings navigation/connections redirect.
- Modify: `apps/web/src/components/add-project/useAddProjectWorkflow.ts`, tests — existing-project disposition.
- Modify: `apps/web/src/composerDraftStore.ts`, `hooks/useHandleNewThread.ts`, `components/ChatView.tsx` and tests — physical scoped project keys.
- Modify: `packages/client-runtime/src/operations/commands.ts`, `state/runtime.ts` and tests — central mutation admission.
- Modify: `packages/contracts/src/settings.ts`, tests and `apps/server/src/server_settings/mod.rs` — remove project-grouping settings from active schema.
- Generate, do not hand-edit: `apps/web/src/routeTree.gen.ts`.

### Task 1: Remove cross-environment logical project grouping

**Files:**

- Modify: `apps/web/src/logicalProject.ts`, `composerDraftStore.ts`, `hooks/useHandleNewThread.ts`, `components/ChatView.tsx`
- Modify: `apps/web/src/sidebarProjectGrouping.ts`, `components/WorktreeDiscoverySection.tsx`, `components/Sidebar.tsx`
- Modify: `packages/contracts/src/settings.ts`, `apps/server/src/server_settings/mod.rs`
- Test: corresponding `.test.ts`/`.test.tsx` files
- Delete after callers migrate: `apps/web/src/logicalProject.ts`, `sidebarProjectGrouping.ts`, `environmentGrouping.test.ts`, `sidebarProjectGrouping.test.ts`

- [x] **Step 1: Rewrite tests to assert physical ownership**

```ts
expect(projectTreeKey(primaryProject)).toBe(
  scopedProjectKey({
    environmentId: primaryEnvironmentId,
    projectId: primaryProject.id,
  }),
);
expect(projectTreeKey(remoteSameRepository)).not.toBe(projectTreeKey(primaryProject));
```

Assert same remote URL in two environments yields two project rows, a project never has `memberProjects`, and Worktree Discovery receives one scoped project.

- [x] **Step 2: Run grouping/draft tests and confirm RED**

```sh
vp test apps/web/src/environmentGrouping.test.ts apps/web/src/sidebarProjectGrouping.test.ts apps/web/src/composerDraftStore.test.ts apps/web/src/hooks/useHandleNewThread.test.tsx
```

- [x] **Step 3: Replace logical keys with `scopedProjectKey`**

Use `{ environmentId, projectId }` for draft lookup, active-project highlighting, project ordering, discovery, and new-thread seed context. Repository identity remains useful server metadata but never a UI ownership key.

- [x] **Step 4: Migrate legacy drafts without merging them**

Rekey each persisted draft from its own stored project/environment reference. If a legacy logical mapping points to several physical drafts, publish each under its scoped key. Quarantine a mapping with no recoverable project reference; never choose an environment by array order.

- [x] **Step 5: Remove project-grouping preferences from active settings**

Delete `sidebarProjectGroupingMode` and overrides from UI and active contract/defaults. The persisted settings decoder may ignore the old fields for one migration version, but runtime and RPC never write or expose a compatibility alias.

- [x] **Step 6: Delete grouping modules and run focused tests**

```sh
vp test apps/web/src/composerDraftStore.test.ts apps/web/src/hooks/useHandleNewThread.test.tsx apps/web/src/components/ChatView.hooks.test.tsx apps/web/src/components/WorktreeDiscoverySection.test.tsx packages/contracts/src/settings.test.ts
git add -A apps/web/src/logicalProject.ts apps/web/src/sidebarProjectGrouping.ts apps/web/src/environmentGrouping.test.ts apps/web/src/sidebarProjectGrouping.test.ts apps/web/src/composerDraftStore.ts apps/web/src/composerDraftStore.test.ts apps/web/src/hooks apps/web/src/components/ChatView.tsx apps/web/src/components/WorktreeDiscoverySection.tsx packages/contracts/src/settings.ts packages/contracts/src/settings.test.ts apps/server/src/server_settings/mod.rs
git commit -m "refactor(web): make projects strictly environment owned"
```

Implemented environment-scoped project identity throughout draft lookup,
ordering, active highlighting, new-thread seeding, sidebar rows, and worktree
discovery. Legacy draft mappings are rebuilt only from recoverable stored
environment/project ownership; ambiguous repository-derived mappings never
enter active state. Retired grouping settings decode as ignored unknown input,
and the grouping modules and public client-runtime export were deleted.
Migration-only aliases preserve and rewrite the former physical project order
keys, while draft remapping removes both stale source keys and deliberately
displaced destination state instead of leaving unreachable composer content.

The initial RED run failed on the new scoped draft-map assertion and the still
active grouping defaults. The final focused gate passed 856 tests across 14
contract, client-runtime, store, hook, route, sidebar, chat, discovery, and UI
state files; `vp check` passed with the one pre-existing unused fixture warning,
and the complete workspace typecheck graph passed. A repository-wide run outside
the sandbox passed 8,387 tests and exposed eight earlier-plan fixture/ledger
failures (five relay UUID fixtures, one remote-auth UUID fixture, one stale
desktop-bridge mock, and one dependency ledger); those are tracked for a
separate repair commit before Task 2. Independent review found and verified the
two migration/remap fixes above, with no remaining P0-P2 finding. The remote
environment and worktree lifecycle runbooks were reviewed and remain accurate;
the active connection architecture wording was updated to match strict
environment ownership.

### Task 2: Build a pure stable environment-tree projection

**Files:**

- Create: `apps/web/src/environmentTree.ts`, `environmentTree.test.ts`
- Modify: `apps/web/src/components/Sidebar.logic.ts`, test

**Interfaces:**

- Consumes: known environments, per-environment cached/live projects/threads, WSL bindings, activity metadata, and client preferences.
- Produces: flat `EnvironmentTreeRow[]` plus key/index/parent maps; it performs no I/O and starts no subscriptions.

- [ ] **Step 1: Write table tests for the approved hierarchy**

Cover primary, several remote environments, same repo in two environments, Main first, ordinary before worktree, panel excluded, collapsed parents, selected path first-use expansion, exact later collapse, stopped/offline cached descendants, and status-stable order.

- [ ] **Step 2: Define explicit row types**

```ts
type EnvironmentTreeRow =
  | {
      kind: "environment";
      key: string;
      environmentId: EnvironmentId;
      level: 1;
      status: EnvironmentStatus;
    }
  | { kind: "project"; key: string; environmentId: EnvironmentId; projectId: ProjectId; level: 2 }
  | {
      kind: "thread";
      key: string;
      environmentId: EnvironmentId;
      projectId: ProjectId;
      threadId: ThreadId;
      level: 3;
      role: "main" | "ordinary" | "worktree";
    };
```

Each row also carries `parentKey`, `isExpanded`, `isSelected`, `ariaPosInSet`, `ariaSetSize`, cached/stale flags, and compact presentation values prepared outside React components.

- [ ] **Step 3: Implement one-time environment placement**

When a new environment lacks an order record, insert it by: manual/pinned position, primary, currently Running WSL, connected remote, offline/stopped. Persist the resulting key array immediately. Subsequent status changes retain the stored order.

- [ ] **Step 4: Implement project/thread ordering**

Project order is scoped to the environment. Threads are stable-partitioned as Main, pinned ordinary, ordinary, pinned worktree, worktree while preserving the existing configured thread sort within each partition. Panel threads are filtered before count/ARIA metadata.

- [ ] **Step 5: Prove linear derivation and referential reuse**

Build each environment subtree independently, memoize by environment shell revision + preference revision, and reuse unchanged row objects. Add a 100-environment/1,000-visible-row benchmark with a fixed upper budget recorded in the test rather than an unmeasured claim.

- [ ] **Step 6: Run tree tests and commit**

```sh
vp test apps/web/src/environmentTree.test.ts apps/web/src/components/Sidebar.logic.test.ts
git add apps/web/src/environmentTree.ts apps/web/src/environmentTree.test.ts apps/web/src/components/Sidebar.logic.ts apps/web/src/components/Sidebar.logic.test.ts
git commit -m "feat(web): derive a stable environment navigation tree"
```

### Task 3: Persist exact scoped navigation state and migrate v1 preferences

**Files:**

- Create: `apps/web/src/environmentNavigationStore.ts`, test
- Modify: `apps/web/src/uiStateStore.ts`, test
- Modify: `apps/web/src/sidebarWorkspaceMetaStore.ts`, test
- Modify: `apps/web/src/connection/storage.ts`, test

- [ ] **Step 1: Write migration/restart tests**

Cover clean start, old project CWD keys, old grouped physical keys, scoped thread pin/unread, corrupt records, removed IDs, hidden selected environment, cached offline selection, quota failure, and reload after manual collapse.

- [ ] **Step 2: Define the v2 document stored through Plan 20**

```ts
export type EnvironmentNavigationStateV2 = {
  schemaVersion: 2;
  selected: { environmentId: string; projectId: string | null; threadId: string | null } | null;
  expandedEnvironmentIds: readonly string[];
  expandedProjectKeys: readonly string[];
  manuallyToggledKeys: readonly string[];
  environmentOrder: readonly string[];
  pinnedEnvironmentIds: readonly string[];
  projectOrderByEnvironment: Readonly<Record<string, readonly string[]>>;
};
```

Aliases and `hidden` remain on `KnownEnvironment`; thread pins/unread remain in the scoped workspace metadata store.

- [ ] **Step 3: Implement first-use versus explicit disclosure**

With no `manuallyToggledKeys`, synthesize expansion for the selected ancestor path and persist it. Once a row is manually toggled, restore that exact value on startup; route hydration does not silently reopen it.

- [ ] **Step 4: Migrate only unambiguous v1 state**

Map a legacy project key only when current cached/live data resolves it to one scoped project. Preserve scoped thread keys. Drop ambiguous repository-group order entries rather than applying them to both environments. Write one migration receipt and stop reading localStorage v1 after success.

- [ ] **Step 5: Implement authoritative fallback**

Do not change selection for offline/missing-from-stale-discovery. After explicit Forget/delete or an authoritative online snapshot proves removal, fall back to parent, next project's Main, environment overview, then primary environment.

- [ ] **Step 6: Run persistence tests and commit**

```sh
vp test apps/web/src/environmentNavigationStore.test.ts apps/web/src/uiStateStore.test.ts apps/web/src/sidebarWorkspaceMetaStore.test.ts apps/web/src/connection/storage.test.ts
git add apps/web/src/environmentNavigationStore.ts apps/web/src/environmentNavigationStore.test.ts apps/web/src/uiStateStore.ts apps/web/src/uiStateStore.test.ts apps/web/src/sidebarWorkspaceMetaStore.ts apps/web/src/sidebarWorkspaceMetaStore.test.ts apps/web/src/connection/storage.ts apps/web/src/connection/storage.test.ts
git commit -m "feat(web): persist exact environment tree state"
```

### Task 4: Render a virtualized accessible navigation-only tree

**Files:**

- Create: `apps/web/src/components/sidebar/EnvironmentTree.tsx`, test
- Create: `apps/web/src/components/sidebar/EnvironmentRow.tsx`, test
- Create: `apps/web/src/components/sidebar/ProjectRow.tsx`, test
- Create: `apps/web/src/components/sidebar/ThreadRow.tsx`, test
- Refactor: `apps/web/src/components/Sidebar.tsx`, `Sidebar.test.tsx`
- Modify: `apps/web/src/components/AppSidebarLayout.tsx`, test

- [ ] **Step 1: Write semantic and interaction tests**

Assert one `role=tree`, visible `treeitem` rows, exact levels/set positions, separate caret/name actions, `aria-expanded`, `aria-selected`, status text, environment/project/thread accessible names, context-menu keyboard access, and no center-only panel/thread in the DOM.

- [ ] **Step 2: Create small memoized row components**

`EnvironmentRow` owns caret, status, alias, condition badge, and kebab. `ProjectRow` owns project selection and project actions. `ThreadRow` owns Main/ordinary/worktree icon/adornments and current pin/unread/activity behavior. None reads global network/Git state independently.

- [ ] **Step 3: Render the flat projection with existing `LegendList`**

Use stable row keys and an estimated fixed row height with measured exceptions. Maintain key-to-index mapping so keyboard focus scrolls the target into the rendered window before moving focus. Populate ARIA sibling metadata from the projection, not DOM siblings.

- [ ] **Step 4: Implement WAI-ARIA Tree View keys**

Up/Down moves visible focus; Right expands or moves to first child; Left collapses or moves to parent; Home/End, character type-ahead, Enter/Space activation, Escape search clear, and Shift+F10 context menu are deterministic. Selection and focus remain visually distinct.

- [ ] **Step 5: Remove left-panel informational surfaces**

Delete project environment badges, grouped-member menus, project grouping controls, aggregate availability panels, and settings/detail content from the left. Keep compact row statuses and bottom navigation actions only.

- [ ] **Step 6: Run component tests and commit**

```sh
vp test apps/web/src/components/sidebar apps/web/src/components/Sidebar.test.tsx apps/web/src/components/AppSidebarLayout.test.tsx
git add apps/web/src/components/sidebar apps/web/src/components/Sidebar.tsx apps/web/src/components/Sidebar.test.tsx apps/web/src/components/AppSidebarLayout.tsx apps/web/src/components/AppSidebarLayout.test.tsx
git commit -m "feat(web): render the environment project thread tree"
```

### Task 5: Make project selection open Main and handle duplicate repository adds

**Files:**

- Modify: `apps/web/src/components/sidebar/ProjectRow.tsx`, test
- Modify: `apps/web/src/components/add-project/useAddProjectWorkflow.ts`, test
- Modify: `apps/web/src/hooks/useHandleNewThread.ts`, test
- Modify: `apps/web/src/components/Sidebar.logic.ts`, test

- [ ] **Step 1: Write failing Main and duplicate-add tests**

Assert project click navigates to its existing default thread, Main reads `Main` even when stored title differs, Main has no rename/archive/delete menu, missing Main reports an invariant fault without a client-created thread, and `disposition: existing` focuses the returned project/Main with an informational notice.

- [ ] **Step 2: Delete client-side default-thread creation**

Remove the fallback in `handlePrimaryRowClick`, `newThreadId()`, provider fallback selection, and `createDefaultThread`. Plan 10 guarantees `mainThreadId` in project create/read results.

- [ ] **Step 3: Handle idempotent project creation**

```ts
if (result.disposition === "existing") {
  navigateToThread({ environmentId, threadId: result.mainThreadId });
  toastManager.add({ type: "info", title: "Already added in this environment." });
}
```

An identical remote in another environment remains unrelated; an independent clone in the same environment is accepted by the server and receives its own project/Main.

- [ ] **Step 4: Preserve flat workspace semantics**

Main remains first. Ordinary and worktree-backed threads keep current activity, branch, missing-path, dirty, locked, detach, Git removal-plan, terminal, unread, and pin behaviors without adding a Worktrees parent.

- [ ] **Step 5: Run workflow/sidebar tests and commit**

```sh
vp test apps/web/src/components/add-project/useAddProjectWorkflow.test.ts apps/web/src/hooks/useHandleNewThread.test.tsx apps/web/src/components/sidebar/ProjectRow.test.tsx apps/web/src/components/Sidebar.logic.test.ts
git add apps/web/src/components/add-project/useAddProjectWorkflow.ts apps/web/src/components/add-project/useAddProjectWorkflow.test.ts apps/web/src/hooks/useHandleNewThread.ts apps/web/src/hooks/useHandleNewThread.test.tsx apps/web/src/components/sidebar/ProjectRow.tsx apps/web/src/components/sidebar/ProjectRow.test.tsx apps/web/src/components/Sidebar.logic.ts apps/web/src/components/Sidebar.logic.test.ts
git commit -m "feat(web): open permanent Main for project navigation"
```

### Task 6: Add ancestor-preserving search and central offline mutation admission

**Files:**

- Modify: `apps/web/src/environmentTree.ts`, test
- Modify: `apps/web/src/components/sidebar/EnvironmentTree.tsx`, test
- Create: `packages/client-runtime/src/operations/admission.ts`, test
- Modify: `packages/client-runtime/src/operations/commands.ts`, test
- Modify: `packages/client-runtime/src/state/runtime.ts`, test
- Modify: `apps/web/src/components/ChatView.tsx`, project/Git/terminal/worktree action surfaces and tests

- [ ] **Step 1: Write search and offline command tests**

Search matches alias/canonical environment label, project title/path, thread title, worktree path/branch; retains environment/project ancestors; omits hidden environments in normal search; supports type-ahead and activation. Every mutation category returns `environmentReadOnly` while cached/offline and records no deferred command.

- [ ] **Step 2: Add normalized search terms to the projection**

Fold Unicode/case once per source revision. For each descendant match, include its ancestor chain and compute ARIA positions within the filtered tree. Do not create a global results group or clone rows under multiple parents.

- [ ] **Step 3: Enforce read-only once in client runtime**

```ts
export class EnvironmentMutationBlocked extends Data.TaggedError("EnvironmentMutationBlocked")<{
  reason: "offline" | "stopped" | "authenticationRequired" | "versionIncompatible" | "updating";
}> {}
```

Check the verified supervisor session/generation immediately before dispatch in `createEnvironmentCommand` and `createEnvironmentRpcCommand`. Queries may read cache; mutations never enter a replay queue.

- [ ] **Step 4: Present the same reason in center surfaces**

Show `Offline · last synchronized …`, stale/read-only banners, content-unavailable-offline where cache is absent, and nearby disabled-action reasons. Keep cached messages and tree rows readable without replacing their domain statuses.

- [ ] **Step 5: Run search/admission tests and commit**

```sh
vp test apps/web/src/environmentTree.test.ts apps/web/src/components/sidebar/EnvironmentTree.test.tsx packages/client-runtime/src/operations/admission.test.ts packages/client-runtime/src/operations/commands.test.ts packages/client-runtime/src/state/runtime.test.ts
git add apps/web/src/environmentTree.ts apps/web/src/environmentTree.test.ts apps/web/src/components/sidebar/EnvironmentTree.tsx apps/web/src/components/sidebar/EnvironmentTree.test.tsx packages/client-runtime/src/operations/admission.ts packages/client-runtime/src/operations/admission.test.ts packages/client-runtime/src/operations/commands.ts packages/client-runtime/src/operations/commands.test.ts packages/client-runtime/src/state/runtime.ts packages/client-runtime/src/state/runtime.test.ts apps/web/src/components/ChatView.tsx
git commit -m "feat(environments): search ownership paths and block offline writes"
```

### Task 7: Build the center environment workspace and Add Environment flow

**Files:**

- Create: `apps/web/src/components/environments/EnvironmentWorkspace.tsx`, test
- Create: `apps/web/src/components/environments/environmentWorkspaceModel.ts`, test
- Create: `apps/web/src/components/environments/OverviewTab.tsx`, `ConnectionTab.tsx`, `ServiceTab.tsx`, `SecurityTab.tsx`, `ProjectsStorageTab.tsx`, `UpdatesTab.tsx`, `DiagnosticsTab.tsx`, `PlatformTab.tsx`
- Create: `apps/web/src/components/environments/AddEnvironmentWorkspace.tsx`, test
- Create: `apps/web/src/routes/_chat.environments.$environmentId.tsx`, `_chat.environments.add.tsx` and route tests
- Create: `apps/web/src/routes/settings.environments.tsx`
- Modify: `apps/web/src/components/settings/SettingsSidebarNav.tsx`, test
- Modify: `apps/web/src/routes/settings.connections.tsx`

- [ ] **Step 1: Write route/tab/authority tests**

Assert environment-name selection opens Overview, reload preserves selected tab, cached server fields become read-only, client alias/order/pin remain editable offline, host controls require DesktopBridge/local-control/SSH admin authority, and no permission editor or telemetry control exists.

- [ ] **Step 2: Create one center route with stable tabs**

Use `/environments/$environmentId?tab=overview|connection|service|security|projects|updates|diagnostics|platform`. Validate search params and default to Overview. Do not hand-edit `routeTree.gen.ts`; regenerate through normal router/build tooling.

- [ ] **Step 3: Build the approved content model**

- Overview: alias/canonical label, environment/storage UUIDs, OS/arch/version/capabilities/status/counts/active route.
- Connection: ordered routes, active/pin/autoconnect, identity/trust verification, pair again.
- Service: mode/mechanism/account/paths/bind/health and authorized host controls.
- Security: full-admin paired clients, DPoP fingerprints/timestamps/revoke; no permission levels.
- Projects & Storage, Updates, Diagnostics, and Platform fields exactly from the approved spec.

- [ ] **Step 4: Build Add Environment in the center**

Offer discovered WSL cards, SSH import/manual target, and Direct HTTPS. Direct entry accepts `https://`/`wss://` only and explains certificate system trust or secure-channel pinning; no HTTP option or insecure override is rendered. Probe/setup/pair progress consumes Plan 40 stages.

- [ ] **Step 5: Redirect legacy Connections navigation**

Make `/settings/connections` redirect to `/settings/environments`; global settings lists Known/Hidden environments and Add Environment, while selecting one opens its center workspace. Plan 60 deletes the old Connect-heavy component after replacement coverage is green.

- [ ] **Step 6: Run route/workspace tests and commit**

```sh
vp test apps/web/src/components/environments apps/web/src/routes/_chat.environments.\$environmentId.test.tsx apps/web/src/routes/_chat.environments.add.test.tsx apps/web/src/components/settings/SettingsSidebarNav.test.tsx
vp run --filter @bibcode/web typecheck
git add apps/web/src/components/environments apps/web/src/routes/_chat.environments.\$environmentId.tsx apps/web/src/routes/_chat.environments.\$environmentId.test.tsx apps/web/src/routes/_chat.environments.add.tsx apps/web/src/routes/_chat.environments.add.test.tsx apps/web/src/routes/settings.environments.tsx apps/web/src/routes/settings.connections.tsx apps/web/src/components/settings/SettingsSidebarNav.tsx apps/web/src/components/settings/SettingsSidebarNav.test.tsx apps/web/src/routeTree.gen.ts
git commit -m "feat(web): add center environment workspaces"
```

### Task 8: Implement Hide, Forget, Uninstall, Purge, and Force Remove consequences

**Files:**

- Create: `apps/web/src/components/environments/EnvironmentRemovalWorkspace.tsx`, test
- Create: `apps/web/src/components/environments/environmentRemovalModel.ts`, test
- Modify: `apps/web/src/components/sidebar/EnvironmentRow.tsx`, test
- Modify: `apps/web/src/routes/settings.environments.tsx`, test
- Modify: `packages/client-runtime/src/connection/registry.ts`, test
- Modify: `apps/web/src/connection/storage.ts`, test

- [ ] **Step 1: Write the complete action matrix as tests**

Cover Disconnect, Hide/restore, Forget, online optional uninstall, online optional purge, stale removal plan, partial remote failure, offline force removal, primary environment, WSL stopped/setup required, and typed alias mismatch. Assert remote action options are unavailable offline and never queued.

- [ ] **Step 2: Implement reversible Hide**

Explain that routes, credentials, cache, and settings remain. Hide updates client metadata only and immediately offers Undo. Hidden environments appear in Settings -> Environments -> Hidden and normal search excludes them.

- [ ] **Step 3: Build the online full-removal decision model**

The required effect is `Remove from this client`. Independently offer unchecked `Uninstall BiBCode Server` and unchecked destructive `Delete remote data, projects, and worktrees`. Keep data is visibly recommended. Fetch a fresh versioned server removal plan and restate exact effects before execution.

- [ ] **Step 4: Guard purge separately**

Require the current environment alias, show verified data root/storage identity and project/worktree/process counts, reject stale identity/plan versions, close admission, drain/reap, execute server deletion, verify outcome, then clear local state. A failed remote step retains catalog metadata and a resumable outcome record.

- [ ] **Step 5: Implement explicit offline force removal**

Warn that the server may keep running; remote projects/worktrees/data remain; other clients remain paired; re-adding requires pairing; and manual host cleanup may be required. Require the alias plus an explicit Force remove checkbox. Then cancel local supervisors/operations and clear secrets, cache, UI state, routes/bindings, and environment metadata in Plan 20 order. Record remote outcome as `unknown`, not success.

- [ ] **Step 6: Make remote uninstall optional and data-preserving**

Uninstall removes service/binary, preserves data by default, and asks whether to Forget locally after verified success. It never implies purge. WSL menus expose Stop Server and Windows WSL management but never distro unregister/delete.

- [ ] **Step 7: Run removal/storage tests and commit**

```sh
vp test apps/web/src/components/environments/EnvironmentRemovalWorkspace.test.tsx apps/web/src/components/environments/environmentRemovalModel.test.ts apps/web/src/components/sidebar/EnvironmentRow.test.tsx apps/web/src/connection/storage.test.ts packages/client-runtime/src/connection/registry.test.ts
git add apps/web/src/components/environments/EnvironmentRemovalWorkspace.tsx apps/web/src/components/environments/EnvironmentRemovalWorkspace.test.tsx apps/web/src/components/environments/environmentRemovalModel.ts apps/web/src/components/environments/environmentRemovalModel.test.ts apps/web/src/components/sidebar/EnvironmentRow.tsx apps/web/src/components/sidebar/EnvironmentRow.test.tsx apps/web/src/routes/settings.environments.tsx apps/web/src/connection/storage.ts apps/web/src/connection/storage.test.ts packages/client-runtime/src/connection/registry.ts packages/client-runtime/src/connection/registry.test.ts
git commit -m "feat(environments): make removal consequences explicit"
```

### Task 9: Validate visuals, accessibility, scale, and update living documentation

**Files:**

- Modify: `apps/desktop/e2e/specs/main-window.e2e.ts`, `platform-capabilities.e2e.ts`
- Create: `apps/desktop/e2e/specs/environment-navigation.e2e.ts`
- Modify: `docs/user/quick-start.md`, `remote-access.md`, `server-administration.md`
- Create: `docs/user/environment-navigation.md`
- Modify: `docs/architecture/overview.md`, `connection-runtime.md`, `worktree-catalog.md`
- Modify: `docs/reference/encyclopedia.md`
- Modify: `docs/testing/cross-platform-validation.md`, native desktop runbooks, `execution-report-template.md`

- [ ] **Step 1: Add native visual fixtures for every required state**

Capture first run, several online environments, WSL Setup required/Stopped, connecting/reconnecting, offline full cache/metadata/no cache, auth required, version mismatch, updating, identity mismatch, duplicate add, search, hidden restoration, online removal, offline force removal, narrow layout, reduced motion, and large tree.

- [ ] **Step 2: Compare against the approved wireframes**

Verify hierarchy, flat thread rows, text statuses, selected-path expansion, center settings, and absence of left-panel tabs/detail panels. Styling follows current BiBCode tokens; wireframes define structure, not pixel copying.

- [ ] **Step 3: Run keyboard/screen-reader/performance evidence**

Exercise all tree keys, focus after route change, virtual row activation, context menus, non-color status, 200% zoom, reduced motion, 100 environments/1,000 rows, search input latency, and no reordering during status churn.

- [ ] **Step 4: Update living documentation**

Document environment ownership, Main, worktree row behavior, search ancestry, offline read-only behavior, environment center tabs, Add Environment, statuses, aliases/order/pins/hidden, all removal choices, and accessibility controls. Remove current living guidance for cross-environment repository grouping.

- [ ] **Step 5: Run final UI gates and commit**

```sh
vp test apps/web/src/environmentTree.test.ts apps/web/src/components/Sidebar.test.tsx apps/web/src/components/sidebar apps/web/src/components/environments
vp run --filter @bibcode/web typecheck
vp run --filter @bibcode/web build
git diff --check
git add apps/desktop/e2e/specs apps/web/src docs/user docs/architecture docs/reference/encyclopedia.md docs/testing
git commit -m "docs: validate environment-owned navigation and settings"
```
