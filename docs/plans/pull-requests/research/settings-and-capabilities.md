# Settings page and capability/availability patterns — research map

Captured 2026-09-20 from the working tree at 15fabc78. Line numbers drift.

## 1. Settings page

- `apps/web/src/routes/settings.tsx:95` — `/settings` route; `beforeLoad` redirects to `/settings/general`; child routes `settings.general.tsx`, `settings.agents.tsx`, `settings.source-control.tsx`, `settings.providers.tsx`, `settings.remote-servers.tsx`, `settings.local-environment.tsx`, `settings.status-bar.tsx`, `settings.terminal.tsx`, `settings.keybindings.tsx`, `settings.archived.tsx`, `settings.about.tsx`, `settings.diagnostics.tsx`, `settings.connections.tsx`.
- `apps/web/src/components/settings/SettingsSidebarNav.tsx:53` — `BASE_SETTINGS_NAV_ITEMS` (General, Remote Servers, Agents, Status Bar, Terminal, Keybindings, Providers, Source Control, Archive, About) with `{label, to, icon}`; `settingsNavItemsFor(policy)` (:72) splices "Local environment" conditionally. Registering a section = `SettingsSectionPath` union + nav item + route file.
- Layout primitives: `apps/web/src/components/settings/settingsLayout.tsx` — `SettingsPageContainer`, `SettingsSection`, `SettingsRow` (title, description, resetAction, status, control), `SettingResetButton`. Toggle: `Switch` (`apps/web/src/components/ui/switch.tsx`), e.g. `SettingsPanels.tsx:617-622`.
- End-to-end boolean example `enableProviderUpdateChecks`: UI `SettingsPanels.tsx:678-703` → `usePrimarySettings()` (`apps/web/src/hooks/useSettings.ts:258`, merges `ServerSettings` + localStorage `ClientSettings` into `UnifiedSettings`) → `useUpdateSettingsTarget`/`splitPatch()` (:270/:151, routes keys by `SERVER_SETTINGS_KEYS = Struct.keys(ServerSettings.fields)`) → RPC `server.getSettings`/`server.updateSettings` (`apps/server/src/rpc/methods.rs:118,125`; wire `ServerSettingsPatch` `packages/contracts/src/settings.ts:638`) → `ProviderSettingsStore` (`apps/server/src/server_settings/mod.rs:243`) → `state_dir/settings.json` (`persistence/state_files.rs:65`), `apply_patch()` (:418), `strip_defaults()` (:531), `write_json_atomically` (:549). One file per server instance (environment), not per project.
- Client-only settings: `ClientSettingsSchema` (`settings.ts:109`), `ClientSettingsPatch` (:674), persisted via `apps/web/src/localApi.ts:53-65` (desktop bridge or `clientPersistenceStorage.ts`).

## 2. Settings → Source Control section

- `apps/web/src/components/settings/SourceControlSettings.tsx:443 SourceControlSettingsPanel()` — sections "Version Control" (git/jj) and "Source Control Providers" (github/gitlab/azure-devops/bitbucket) from one discovery query: `useEnvironmentQuery(sourceControlEnvironment.discovery({environmentId, input: {}}))` (:445) → `apps/web/src/state/sourceControl.ts:5` → `packages/client-runtime/src/state/sourceControl.ts:17 createSourceControlEnvironmentAtoms` → `WS_METHODS.serverDiscoverSourceControl` (`packages/contracts/src/rpc.ts:461`).
- Rescan: `handleScan = () => discovery.refresh()` (:457), button `aria-label="Rescan server environment"` (:470).
- Row: `DiscoveryItemRow` (:212) renders `SourceControlProviderDiscoveryItem { kind, status, auth: {status, account}, executable, installHint, version }`; `authPresentation()` (:98), `itemSummary()` (:157), account via `RedactedAccount`/`RedactedSensitiveText`. Icons `SOURCE_CONTROL_PROVIDER_ICONS` → `GitHubIcon/GitLabIcon/AzureDevOpsIcon/BitbucketIcon` in `apps/web/src/components/Icons.tsx`.
- Consumer: `apps/web/src/components/GitActionsControl.tsx:419-433` builds `publishAccountByProvider` from discovery; `canPublishRepository` at `GitManagerPanel.tsx:1660`.

## 3. Availability patterns

A. Environment capability → per-action `disabledReason: string | null` (`apps/web/src/components/gitManager/gitManagerAvailability.ts`):

- `ExecutionEnvironmentCapabilities` (`packages/contracts/src/environment.ts:37-53`) flags `gitManagerReads`, `gitManagerBranchSyncOperations`, `gitManagerStashMergeOperations`, `gitManagerRewriteOperations`, `gitManagerTagOperations`, `gitManagerPullRequests`, `gitManagerLiveSignal`.
- `resolveGitManagerAvailability(connectionState, serverConfig)` (:75) → `{kind:"ready"} | {kind:"pending",reason} | {kind:"disconnected",reason} | {kind:"unsupported",missingCapability}`.
- `resolveGitManagerCapabilityDisabledReasons(serverConfig)` (:32) → per action `string | null`; `pullRequests` reason constant at :18 ("This environment does not support Git Manager pull request operations."), consumed at `GitManagerPanel.tsx:1200`.
- Rendering: `GitManagerPanel.tsx:844-866` — `disabled={reason !== null}`, `title={reason}`, `aria-describedby` → visually hidden span. Whole-panel: `GitManagerUnavailableState({reason})` (:131), `unavailableReason()` (:151).

B. Add-panel-surface menu: `apps/web/src/components/RightPanelTabs.tsx:65 SURFACE_DISABLED_REASONS`; `SurfaceMenuItem({available, disabledReason, onClick})` (:83) wraps disabled items in `DisabledReasonTooltip` (:74). Desktop gating via `isDesktopHost` (`apps/web/src/env.ts:6`) and `isPreviewSupportedInRuntime()` (`previewStateStore.ts:412`).

C. Worktree catalog policy: `packages/client-runtime/src/state/worktrees.ts:118-152 WorktreeCatalogCapabilityPolicy` + `selectWorktreeCatalogCapabilityPolicy(descriptor)`.

Common vocabulary: server reports capability booleans on `ServerConfig.environment.capabilities`; client resolves them into `disabledReason` per action or a `kind`-tagged union per surface; disabled controls always carry their own reason.

## 4. Per-project web state

- `apps/web/src/gitManagerStore.ts:1-90 useGitManagerStore { byProjectKey, toolbarByProjectKey }`, keys `projectKey(ref)`/`parseProjectKey` (`packages/client-runtime/src/state/entities.ts:48,60`, format `${environmentId}�${projectId}`), zustand `persist` with `createJSONStorage(resolveStorage)`, key `bibcode:git-manager-state:v1`. `rightPanelStore.ts` uses the same pattern keyed by `scopedThreadKey`.
- `ScopedProjectRef` (`packages/contracts/src/environment.ts:108`) `{environmentId, projectId}`.
- Client knowledge of the provider: `RepositoryIdentity` (`environment.ts:97-106`) `{canonicalKey, locator, rootPath?, displayName?, provider?, owner?, name?}` on `EnvironmentProject.repositoryIdentity` (grouping in `packages/client-runtime/src/state/projectGrouping.ts:37-176`); capability `repositoryIdentity` (`environment.ts:31`).
- Sidebar data: `apps/web/src/state/entities.ts:104 useProjects()`, `:108 useServerConfigs()`; `ProjectFavicon` (`components/ProjectFavicon.tsx:8`).

## 5. Permission precedents

- `canPush` is client-derived (`GitActionsControl.logic.ts:107-122`, `SourceControlPrimaryAction.logic.ts`), not a server flag. No server-reported per-action permission exists. Closest precedent: the capability/`disabledReason` pattern. `GitManagerPullRequestEntry` (`packages/contracts/src/gitManager.ts:466-489`) has only `{number, title, url, baseBranch, headBranch, state}`.

## 6. UI.md rules (repo root)

- Priority 5 "Make actions visually obvious." — "Do not make clickable and non-clickable elements look the same."
- Priority 6 "Respect limited attention."
- Do: "Make disabled/unavailable states understandable."; "Make errors actionable: say what happened and how to fix it."; "Preserve user work aggressively."; "Let users recover from mistakes."; "Confirm only actions that are destructive, expensive, or hard to undo."; "Make destructive actions reversible where possible."; "Make primary actions visually distinct."; "Make secondary actions available but not distracting."
- Don't: "Do not design from an internal feature checklist."; "Do not expose implementation details as UI choices."; "Do not add preferences as a substitute for design decisions."

## 7. Desktop bridge / external actions

- Open URL: `LocalApi.shell.openExternal` (`packages/contracts/src/ipc.ts:1273,1379`), impl `apps/web/src/localApi.ts:28-40` (desktop `desktopBridge.openExternal`, browser `window.open(..., "noopener,noreferrer")`). Helpers `apps/web/src/lib/openPullRequestLink.ts:32 openPullRequestLink(shell, url)` and `useOpenPrLink()` (:50) with toast on failure.
- Open in editor: RPC `shellEnvironment.openInEditor` (`apps/web/src/editorPreferences.ts:67`, `Sidebar.tsx:1590`), catalog `apps/web/src/components/chat/OpenInPicker.tsx` (`EditorId` incl. `vscode`, `vscode-insiders`, `zed`), `ChatHeaderActions.tsx:116 useOpenInEditorController`.
- Checkout locally: precedent is Git Manager branch checkout in `GitManagerToolbar.tsx` / `toolbar/GitManagerBranchDropdown.tsx` gated by `*DisabledReason` props.

## 8. Copy, icons, panel system

- Strings inline in JSX, no i18n. Icons: `lucide-react` (`GitPullRequestIcon`, `RefreshCwIcon`, ...) plus local brand icons in `components/Icons.tsx`.
- Right panel: `apps/web/src/rightPanelStore.ts:19-28 RIGHT_PANEL_KINDS = ["plan","diff","sourceControl","files","file","preview","terminal","activity"]`, `RightPanelSurface` variants (:39-58), per-thread state (`bibcode:right-panel-state:v2`, version 9). "Add panel surface" menu at `RightPanelTabs.tsx:450-497`. The Git Manager's provider pane (`GitManagerPullRequestPanel`) is the centre-panel location PRs occupy today.
