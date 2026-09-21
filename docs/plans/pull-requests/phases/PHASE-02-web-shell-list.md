# Pull Requests / Phase 02 — Web shell: routes, sidebar button, store, settings, list view

> **For agentic workers:** implemented by Codex (`codex:rescue`), reviewed by the coordinating Claude session. Tick checkboxes as you go. Red → green for every behaviour. The coordinator verifies this phase visually with Playwright before accepting it.

**Goal:** Make the module reachable and useful for reading: two routes, the sidebar button with highlight, the per-project view-state store, the availability resolver (setting + capability + context), the Settings switch and host list, the list view with tabs, filters, rows, "Load more", and every empty/unavailable/error state.

**Architecture:** Mirrors the Git Manager shell (`research/bibcode-integration-surface.md` § 1–3). `PullRequestsPanel` resolves availability once, reads the context query, and renders either an explicit state or the list/detail view chosen by the route. All server data flows through `pullRequestsEnvironment` atoms; no component calls `request` directly. The detail route renders a placeholder frame this phase (header with number + "Loading…"); Phase 04 fills it.

**Tech Stack:** React 19, TanStack Router file routes, zustand + persist, `@effect/atom` query families through `useEnvironmentQuery`, Tailwind 4, `@base-ui/react` (Tabs, Menu, Tooltip), `lucide-react`, `@legendapp/list` for virtualisation, Vitest (happy-dom).

---

## Files

- **Create:** `apps/web/src/routes/_chat.project.$environmentId.$projectId.pull-requests.tsx`
- **Create:** `apps/web/src/routes/_chat.project.$environmentId.$projectId.pull-requests.$number.tsx`
- **Modify (generated):** `apps/web/src/routeTree.gen.ts`
- **Create:** `apps/web/src/state/pullRequests.ts` — `pullRequestsEnvironment = createPullRequestsEnvironmentAtoms(connectionAtomRuntime)`
- **Create:** `apps/web/src/pullRequestsStore.ts` + `pullRequestsStore.test.ts`
- **Create:** `apps/web/src/components/pullRequests/pullRequestsAvailability.ts` + `.test.ts`
- **Create:** `apps/web/src/components/pullRequests/PullRequestsPanel.tsx` + `.test.tsx`
- **Create:** `apps/web/src/components/pullRequests/PullRequestsUnavailableState.tsx` + `.test.tsx`
- **Create:** `apps/web/src/components/pullRequests/list/PullRequestsListView.tsx`, `PullRequestsFilters.tsx`, `PullRequestsRow.tsx`, `pullRequestsList.logic.ts` (+ tests for each)
- **Create:** `apps/web/src/components/pullRequests/shared/PullRequestsActor.tsx` (initials avatar, never an image), `PullRequestsStateIcon.tsx`, `PullRequestsLabelChip.tsx` (+ tests)
- **Create:** `apps/web/src/components/pullRequests/shared/projectModuleRoute.logic.ts` + test — `projectModuleRouteProjectKey(pathname, …)`
- **Modify:** `apps/web/src/components/Sidebar.tsx` — button, handler, highlight; `Sidebar.test.tsx`
- **Modify:** `apps/web/src/components/settings/SourceControlSettings.tsx` + test — "Pull requests" switch, per-host list for GitHub/GitLab rows
- **Modify:** `apps/web/src/components/gitManager/provider/GitManagerPullRequestPanel.tsx` + test — "Open in Pull Requests" link on each row
- **Modify:** `apps/web/src/hooks/useSettings.ts` only if `pullRequestsEnabled` needs a selector helper (follow `diffIgnoreWhitespace`'s pattern)

## Dependencies

- Phase 00 (contracts, atoms, setting). Phase 01 for live data during verification.

## Owner Agent

Codex via `codex:rescue`. Reviewer: coordinator (Playwright + `vercel-react-best-practices` + `UI.md`).

## Risk / Effort

Risk: Medium. Effort: ~6 h.

---

## Discipline

- Read `AGENTS.md` and `UI.md` at the repository root. Disabled controls explain themselves; errors say what happened and what to do; empty states offer the next action.
- No `<img>`, no avatar URL, no `fetch`, no timer, no window-focus refetch anywhere in `components/pullRequests/**`. A telemetry test lands in Phase 10 and will fail otherwise.
- Do not create a new `CenterSurface` kind or touch `centerPanelStore.ts`; this is a route, like the Git Manager.
- Copy follows the host vocabulary from `context.capabilities.vocabulary` (never hard-code "merge request").

## Documents to Read

- `pull-requests-spec.md` § 4 surface, § 6 availability, § 8.1 list, § 9 behaviour
- `pull-requests-plan.md` § Client
- `research/bibcode-integration-surface.md` § 1–3, `research/settings-and-capabilities.md` § 1–4
- `apps/web/src/routes/_chat.project.$environmentId.$projectId.git.tsx`, `apps/web/src/gitManagerStore.ts`, `apps/web/src/components/gitManager/gitManagerAvailability.ts`, `GitManagerPanel.tsx` (unavailable state + `disabledReason` button pattern at ~:844-866), `SourceControlSettings.tsx`

---

## Pre-execution check

- [x] **Step 02.0: Claim the phase** in `../tasks.md` (`codex-02`).

## Atomic steps

- [x] **Step 02.1: Locate the surface.**

  ```bash
  rg -n 'git-manager-button|handleOpenGitManagerClick|openGitManagerForProjectMember|gitManagerRouteProjectKey|gitManagerActive' apps/web/src/components/Sidebar.tsx
  rg -n 'projectKey|parseProjectKey' packages/client-runtime/src/state/entities.ts
  rg -n 'resolveGitManagerAvailability|GitManagerUnavailableState' apps/web/src/components/gitManager/*.ts*
  rg -n 'diffIgnoreWhitespace' apps/web/src/hooks/useSettings.ts apps/web/src/components/settings/*.tsx
  rg -n 'validateSearch' apps/web/src/routes/*.tsx | head
  ```

- [x] **Step 02.2: Store test first.** `apps/web/src/pullRequestsStore.test.ts`:

  ```ts
  import { describe, expect, it } from "vitest";
  import { usePullRequestsStore } from "./pullRequestsStore";
  const ref = (e: string, p: string) => ({ environmentId: e, projectId: p }) as never;
  describe("pullRequestsStore", () => {
    it("keeps the two most recently used projects", () => {
      const s = usePullRequestsStore.getState();
      s.touchProject(ref("a", "1"));
      s.touchProject(ref("a", "2"));
      s.touchProject(ref("a", "3"));
      expect(Object.keys(usePullRequestsStore.getState().byProjectKey)).toHaveLength(2);
    });
    it("stores drafts per pull request number and survives partialize", () => {
      const s = usePullRequestsStore.getState();
      s.setCommentDraft(ref("a", "1"), 14, "hello");
      expect(usePullRequestsStore.getState().selectDraft(ref("a", "1"), 14).comment).toBe("hello");
    });
    it("keeps viewed files per pull request", () => {
      const s = usePullRequestsStore.getState();
      s.toggleViewedFile(ref("a", "1"), 14, "src/a.ts");
      expect(s.selectViewState(ref("a", "1")).viewedFiles[14]).toEqual(["src/a.ts"]);
    });
  });
  ```

- [x] **Step 02.3: Run; expect FAIL.** `vp test run apps/web/src/pullRequestsStore.test.ts`

- [x] **Step 02.4: Implement the store** following `gitManagerStore.ts` exactly (persist name `bibcode:pull-requests-state:v1`, version 1, `resolveStorage`, `projectKey(ref)` keys, LRU 2 via `lastUsedAt`). State per project: `checkoutCwd: string | null`, `listTab: "open" | "closed" | "merged" | "all"`, `filters: { search, author, assignee, reviewer, reviewStatus, draft, labels, milestone, targetBranch }`, `sort`, `scrollTop: number`, `lastNumber: number | null`, `viewedFiles: Record<number, string[]>`, `drafts: Record<number, PullRequestsDraft>` with `PullRequestsDraft = { comment: string; pendingReview: PendingInlineComment[]; mergeSubject: string; mergeBody: string; titleEdit: string | null; bodyEdit: string | null; commentEdits: Record<string, string> }`, `lastUsedAt`. Actions: `touchProject`, `setCheckoutCwd`, `setListTab`, `setFilters`, `setSort`, `setScrollTop`, `setLastNumber`, `toggleViewedFile`, `setCommentDraft`, `setPendingReview`, `setMergeDraft`, `setTitleEdit`, `setBodyEdit`, `setCommentEdit`, `clearDraft(ref, number)`. Selectors: `selectViewState(ref)`, `selectDraft(ref, number)`. Export `PendingInlineComment = { id: string; path: string; line: number; startLine: number | null; side: "left" | "right"; body: string }`.

- [x] **Step 02.5: Run; expect PASS.**

- [x] **Step 02.6: Availability resolver + tests.** `pullRequestsAvailability.ts`:

  ```ts
  export type PullRequestsAvailability =
    | { kind: "ready" }
    | { kind: "disabled_in_settings" }
    | { kind: "pending"; reason: string }
    | { kind: "disconnected"; reason: string }
    | { kind: "unsupported"; missingCapability: string };
  export function resolvePullRequestsAvailability(
    connectionState,
    serverConfig,
    pullRequestsEnabled: boolean,
  ): PullRequestsAvailability;
  export function resolvePullRequestsMutationsDisabledReason(serverConfig): string | null; // "This environment does not support Pull Requests actions."
  export const PULL_REQUESTS_DISABLED_IN_SETTINGS_MESSAGE =
    "Pull requests are turned off in Settings → Source Control.";
  ```

  Copy `resolveGitManagerAvailability`'s connection-state handling verbatim; capability `pullRequestsReads`. Tests: setting off wins over everything; null config → pending; disconnected → disconnected, never dials; capability false → unsupported naming `pullRequestsReads`.

- [x] **Step 02.7: Web atoms + routes.** `apps/web/src/state/pullRequests.ts` (three lines, like `state/gitManager.ts`). List route file: copy the Git Manager route file, rename to `PullRequestsListRouteView`, render `<ChatRouteInset><PullRequestsPanel projectRef={projectRef} /></ChatRouteInset>`, path `/_chat/project/$environmentId/$projectId/pull-requests`. Detail route: same plus `validateSearch: (search) => ({ tab: ["conversation","commits","checks","files"].includes(search.tab) ? search.tab : "conversation" })` and `<PullRequestsPanel projectRef number={Number(params.number)} tab={search.tab} />`; a non-integer `number` redirects to the list route. Run `vp run dev` once (or the build) to regenerate `routeTree.gen.ts`; never hand-edit it.

- [x] **Step 02.8: Sidebar.** Add `openPullRequestsForProjectMember` + `handleOpenPullRequestsClick` next to the Git Manager ones (same `runProjectMemberAction` chain, navigate to `/project/$environmentId/$projectId/pull-requests`). Add the fourth hover-strip `Tooltip` block after the Git Manager one: `GitPullRequestIcon`, `aria-label={`Pull Requests for ${project.displayName}`}`, `data-testid="pull-requests-button"`, tooltip "Pull Requests". Render the button only when `pullRequestsEnabled` (read via `usePrimarySettings`). Replace the `gitManagerRouteProjectKey` memo's `pathname.endsWith("/git")` with `projectModuleRouteProjectKey(pathname, routeProjectScopedKey, projectPhysicalKeyByScopedRef, physicalToLogicalKey)` from the new logic file, which matches `/git` **or** `/pull-requests` (with or without `/<number>`); rename the memo and the `gitManagerActive` prop to `moduleRouteProjectKey` / `moduleRouteActive` **only if** the rename stays under 30 lines of churn; otherwise keep the names and document that they now cover both modules. Tests in `Sidebar.test.tsx` mirroring `:3633,3658,3680-3683,3742-3750` for the new button (aria-label, highlight on `/pull-requests/14`, idempotent navigation, grouped member) plus one asserting the button is absent when `pullRequestsEnabled` is false.

- [x] **Step 02.9: Settings.** In `SourceControlSettingsPanel`, add a `SettingsSection title="Pull Requests"` (before "Source Control Providers") with one `SettingsRow` titled "Pull requests", description "Show the Pull Requests button on every project and enable the pull request views.", control `<Switch checked={pullRequestsEnabled} onCheckedChange={(checked) => updateSettings({ pullRequestsEnabled: Boolean(checked) })} aria-label="Enable pull requests" />`. In `DiscoveryItemRow` for `github` and `gitlab`, when `item.auth.hosts` (add this optional field to the contracts `SourceControlProviderAuth` schema as `hosts: Schema.optional(Schema.Array(Schema.Struct({ host, account: NullOr(String), authenticated: Boolean })))` and populate it in `apps/server/src/source_control/discovery.rs` from the already-parsed per-host results — a two-file server change; keep it minimal and covered by the existing discovery unit test) is present, render one line per host: `host — Authenticated as <RedactedAccount>` or `host — Not authenticated`. Test: the switch toggles the setting; the host list renders two hosts.

- [x] **Step 02.10: Panel + states.** `PullRequestsPanel.tsx` props `{ projectRef: ScopedProjectRef; number?: number; tab?: PullRequestsDetailTab }`. Resolve project via `useProject`, connection state via the same hook the Git Manager uses, `serverConfig` via `useServerConfigs`, availability via Step 02.6. When not `ready`, render `PullRequestsUnavailableState` with the reason (settings-off state links to `/settings/source-control`). When ready: `checkoutCwd` from the store or the project's main checkout (`project.workspaceRoot`, opaque), mount `pullRequestsEnvironment.getContext({ environmentId, input: { cwd } })`; while pending show a skeleton; `unavailable` → `PullRequestsUnavailableState` showing `message`, the `authCommand` in a copyable `<code>` block when present, `installHint` when present, and a **Rescan** button that calls `refresh()`; `available` → header + (number ? detail placeholder : `PullRequestsListView`). Header: provider icon (`GitHubIcon`/`GitLabIcon` from `components/Icons.tsx`), `repository`, host when not `github.com`/`gitlab.com`, account login, worktree selector (reuse the Git Manager toolbar's selector component if it is exported; otherwise a minimal `Select` over the worktree catalog atoms), Refresh, Rescan, **New pull request** (opens `GitManagerCreatePullRequestDialog` with `{ environmentId, cwd }` — verify its props), and an "Open in browser" link to `context.webUrl` via `useOpenPrLink`/`shell.openExternal`.

- [x] **Step 02.11: List view.** `PullRequestsListView` props `{ scope: { environmentId, cwd }, projectRef, context: PullRequestsContextAvailable }`. Tabs from `capabilities.closedTabIncludesMerged` (GitHub: Open / Closed; GitLab: Open / Merged / Closed / All) with counts when `counts` non-null. `PullRequestsFilters`: search input (debounced 300 ms, Enter applies), Author menu (Anyone / Me / custom login), Assignee, Reviewer, Review status (per host: GitHub `review_required|approved|changes_requested`; GitLab `approved|not_approved`), Draft (All / Drafts / Ready), Labels (multi-select from `getVocabulary` labels, loaded on open), Milestone (from vocabulary), Target branch (from vocabulary branches), Sort menu, Clear filters. `pullRequestsList.logic.ts`: `buildListInput(state, cwd) → PullRequestsListInput`, `rowTimeLabel(row)`, `rowStateIcon(row)`. Pages: mount `list` for `cursor: null`; "Load more" mounts the next cursor and appends (keep an array of cursors in component state; Refresh resets to `[null]` and calls `refresh()`). Rows (`PullRequestsRow`, virtualised with `@legendapp/list`, fixed 56 px): state icon (open green `GitPullRequestIcon`, draft grey `GitPullRequestDraftIcon`, merged purple `GitMergeIcon`, closed red `GitPullRequestClosedIcon`), title (link → detail route), label chips with host colour (`PullRequestsLabelChip` computes readable text colour), meta line `#N opened <time> by <login>` / `!N · created <time> by <name>`, review-decision text, checks icon (`CircleCheckIcon` green / `CircleXIcon` red / `CircleDotIcon` amber) when non-null, `approvals x of y` and unresolved count when non-null, comment count with `MessageSquareIcon`, "Draft" badge. Empty: "No open pull requests" / "Nothing matches these filters" + **Clear filters**. Error: `PullRequestsOperationError.message` + `hostDetail` (muted) + **Retry**.

- [x] **Step 02.12: Git Manager pane link.** In `GitManagerPullRequestPanel.tsx`'s `PullRequestRow`, add a small secondary link "Open in Pull Requests" navigating to `/project/$environmentId/$projectId/pull-requests/$number` (the pane knows `scope.environmentId`; it needs `projectRef` — add an optional `projectRef` prop threaded from `GitManagerPanel`, rendering the link only when present). Test: link href.

- [x] **Step 02.13: Tests.** One failing-first test per: unavailable-state rendering for each context code (auth command shown and copyable); list renders rows from a mocked `list` atom; tab switch rebuilds the input; "Load more" appends and keeps earlier rows; Refresh resets cursors; filters clear; the panel issues no request when disconnected; the detail placeholder renders number and tab. Use the same atom-mocking approach as `GitManagerPullRequestPanel.test.tsx`.

- [x] **Step 02.14: Gate.**

  ```bash
  vp test run apps/web/src/pullRequestsStore.test.ts apps/web/src/components/pullRequests apps/web/src/components/Sidebar.test.tsx apps/web/src/components/settings apps/web/src/components/gitManager/provider
  vp run typecheck
  vp check
  cargo test -p bibcode-server discovery -j 2   # if Step 02.9 touched discovery.rs
  ```

- [x] **Step 02.15: TDD proof.** Force `resolvePullRequestsAvailability` to always return `ready`; the settings-off and disconnected tests must fail. Restore.

- [x] **Step 02.16: Mark complete** in `tasks.md` with store selector names, component props, and any deviation.

---

## Verification (coordinator runs Playwright in browser mode against `vp run dev` with the `mubeda/BibCode` checkout added as a project)

- [x] Sidebar shows the fourth button after Git Manager; clicking navigates to `/project/…/pull-requests`; the project row highlights; reload lands on the list; `/pull-requests/14` highlights too.
- [x] Settings → Source Control shows the "Pull requests" switch; off hides the button and the route shows the settings-off message with a link; GitHub row lists `github.com — Authenticated as …`.
- [x] List shows real rows from `mubeda/BibCode` (Open / Closed tabs with counts), filters change the query, "Load more" appends, Refresh reloads, errors render with Retry (simulate by revoking `gh` auth in a copy of the config or by pointing `GH_CONFIG_DIR` at an empty dir for the dev server).
- [x] Unavailable states verified for: a project with no remote, a Bitbucket remote, an unknown host (shows the `glab auth login --hostname` command).
- [x] No `<img>` in the rendered DOM; no network request other than the WebSocket RPC (Playwright `page.on("request")`).
- [x] `vercel-react-best-practices` review recorded (list virtualised, filters debounced, no inline component definitions, primitive deps) and `UI.md` review recorded.
- [x] `vp check`, `vp run typecheck` clean; all tests green; no dependency change.

## Notes for downstream phases

- `PullRequestsPanel` props are `{ projectRef, number?, tab? }`; it passes `{ scope: { environmentId, cwd }, projectRef, context }` to `PullRequestsListView` and (Phase 04) `PullRequestsDetailView`.
- Store API: `usePullRequestsStore` with `selectViewState(ref)`, `selectDraft(ref, number)`, and the actions listed in Step 02.4. Phases 04/06/08 add fields only through `tasks.md` coordination.
- `PullRequestsUnavailableState` and `PullRequestsActor`/`PullRequestsStateIcon`/`PullRequestsLabelChip` are shared by the detail view.
- The host vocabulary is read from `context.capabilities.vocabulary`; never hard-code host words.
