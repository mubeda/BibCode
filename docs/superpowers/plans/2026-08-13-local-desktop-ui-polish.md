# Local Desktop UI Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Polish discovered-worktree and Activity layouts, and make the v0.3.14 desktop UI local-only while preserving Windows WSL and all underlying remote functionality.

**Architecture:** Add one pure runtime/platform presentation policy in `apps/web`, with a narrow adapter that reads the current host. All affected desktop entry points consume that policy; browser/hosted behavior remains unchanged. Extract WSL settings into a focused component so Windows can render local controls without mounting the remote Connections page, then apply test-first layout corrections and verify one exact packaged v0.3.14 app through Codex Computer Use.

**Tech Stack:** React 19, TypeScript, TanStack Router, Tailwind CSS, Base UI, Vite+, happy-dom, Tauri 2, pnpm 11, Codex Computer Use.

## Global Constraints

- Target v0.3.14 only; do not build, launch, or use v0.3.13.
- Hide remote-device controls only in desktop presentation; do not remove or disable remote contracts, persistence, state, RPC, server, bridge, or browser/hosted functionality.
- macOS and Linux desktop expose only the primary local environment.
- Windows desktop exposes the primary local environment plus WSL as a same-device backend.
- Claude, Codex, Cursor, and OpenCode remain visible; Grok remains hidden from ordinary provider action and Settings surfaces.
- Hidden controls must be absent from the DOM and accessibility tree, not concealed with CSS.
- Keep exact worktree paths available through keyboard focus, accessible description, and tooltip.
- Do not add polling, sleeps, global mutable test switches, duplicate connection owners, or asynchronous policy work.
- Use Codex Computer Use, never Orca, for packaged UI interaction.
- Preserve all important fixes already merged from `main` and the provider visibility commit `12847faf`.

---

## File Structure

### New focused units

- `apps/web/src/connection/environmentPresentationPolicy.ts` — pure runtime/platform matrix and target-level visibility decisions.
- `apps/web/src/connection/environmentPresentationPolicy.test.ts` — exhaustive browser/macOS/Linux/Windows/unknown policy contract.
- `apps/web/src/connection/currentEnvironmentPresentation.ts` — sole adapter from `isDesktopHost` and `navigator.platform` to the pure policy.
- `apps/web/src/connection/currentEnvironmentPresentation.test.ts` — current-host adapter coverage without mutating production policy state.
- `apps/web/src/components/settings/LocalEnvironmentSettings.tsx` — Windows WSL settings owner extracted from the full Connections page.
- `apps/web/src/components/settings/LocalEnvironmentSettings.test.tsx` — WSL loading, mutation, confirmation, retry, and desktop-local registration coverage.
- `apps/web/src/routes/settings.connections.test.tsx` — direct-route destination contract for browser, Windows desktop, and macOS/Linux desktop.

### Existing units changed in place

- Add Project workflow/steps/dialog and tests consume filtered targets and omit redundant selectors.
- Connections settings, route, settings navigation, root shell, chat banner, sidebar recovery, and their tests consume the central policy.
- Worktree discovery logic/component/tests compact paths and add deterministic duplicate-name discriminators.
- Activity dock/tests make title and elapsed metadata one vertical text column.
- Living user documentation records the current presentation boundary.

---

### Task 1: Central Environment Presentation Policy

**Files:**
- Create: `apps/web/src/connection/environmentPresentationPolicy.ts`
- Create: `apps/web/src/connection/environmentPresentationPolicy.test.ts`
- Create: `apps/web/src/connection/currentEnvironmentPresentation.ts`
- Create: `apps/web/src/connection/currentEnvironmentPresentation.test.ts`
- Read: `apps/web/src/env.ts`
- Read: `apps/web/src/connection/desktopLocal.ts`
- Read: `apps/web/src/lib/utils.ts`

**Interfaces:**
- Consumes: `ConnectionTarget`, `isDesktopLocalConnectionTarget`, `isDesktopHost`, and existing platform string helpers.
- Produces:

```ts
export type ClientPresentationSurface = "browser" | "desktop";
export type DesktopHostPlatform = "macos" | "windows" | "linux" | "unknown";
export type ConnectionsPresentation = "full" | "local-wsl" | "redirect-general";

export interface EnvironmentPresentationPolicy {
  readonly surface: ClientPresentationSurface;
  readonly platform: DesktopHostPlatform;
  readonly connectionsPresentation: ConnectionsPresentation;
  readonly showRemoteDeviceControls: boolean;
  readonly showLocalEnvironmentSettings: boolean;
  readonly presentsTarget: (target: ConnectionTarget) => boolean;
  readonly permitsConnectionAction: (target: ConnectionTarget) => boolean;
}

export function createEnvironmentPresentationPolicy(input: {
  readonly surface: ClientPresentationSurface;
  readonly platform: DesktopHostPlatform;
}): EnvironmentPresentationPolicy;

export function normalizeDesktopHostPlatform(platform: string): DesktopHostPlatform;
export function readCurrentEnvironmentPresentationPolicy(): EnvironmentPresentationPolicy;
```

- [ ] **Step 1: Write the failing pure matrix tests**

Cover these literal outcomes:

```ts
it.each([
  ["browser", "macos", "full", true],
  ["desktop", "macos", "redirect-general", false],
  ["desktop", "linux", "redirect-general", false],
  ["desktop", "windows", "local-wsl", false],
  ["desktop", "unknown", "redirect-general", false],
] as const)("derives %s/%s presentation", (surface, platform, connections, remote) => {
  const policy = createEnvironmentPresentationPolicy({ surface, platform });
  expect(policy.connectionsPresentation).toBe(connections);
  expect(policy.showRemoteDeviceControls).toBe(remote);
});

it("shows only primary and Windows desktop-local targets in local-only desktop mode", () => {
  const windows = createEnvironmentPresentationPolicy({
    surface: "desktop",
    platform: "windows",
  });
  expect(windows.presentsTarget(primaryTarget)).toBe(true);
  expect(windows.presentsTarget(wslTarget)).toBe(true);
  expect(windows.presentsTarget(sshTarget)).toBe(false);
  expect(windows.presentsTarget(relayTarget)).toBe(false);
  expect(windows.presentsTarget(remoteBearerTarget)).toBe(false);
});
```

Also prove macOS/Linux/unknown desktop reject WSL and every remote target, while browser mode presents all existing target kinds.

- [ ] **Step 2: Run the pure tests and verify RED**

Run:

```bash
cd apps/web
vp test run --passWithNoTests src/connection/environmentPresentationPolicy.test.ts
```

Expected: FAIL because `environmentPresentationPolicy.ts` and its exports do not exist.

- [ ] **Step 3: Implement the pure matrix**

Use target tags and the existing desktop-local classifier only:

```ts
function isLocalDesktopTarget(
  policy: Pick<EnvironmentPresentationPolicy, "surface" | "platform">,
  target: ConnectionTarget,
): boolean {
  if (target._tag === "PrimaryConnectionTarget") return true;
  return (
    policy.surface === "desktop" &&
    policy.platform === "windows" &&
    isDesktopLocalConnectionTarget(target)
  );
}

export function createEnvironmentPresentationPolicy(input: {
  readonly surface: ClientPresentationSurface;
  readonly platform: DesktopHostPlatform;
}): EnvironmentPresentationPolicy {
  const browser = input.surface === "browser";
  const connectionsPresentation = browser
    ? "full"
    : input.platform === "windows"
      ? "local-wsl"
      : "redirect-general";
  const presentsTarget = (target: ConnectionTarget) =>
    browser || isLocalDesktopTarget(input, target);
  return {
    ...input,
    connectionsPresentation,
    showRemoteDeviceControls: browser,
    showLocalEnvironmentSettings: connectionsPresentation === "local-wsl",
    presentsTarget,
    permitsConnectionAction: presentsTarget,
  };
}
```

Normalize `MacIntel`, `Mac*`, `Win32`, `Windows`, and Linux strings with the existing utility predicates. Unknown desktop input must remain `unknown` and fail closed.

- [ ] **Step 4: Add the current-host adapter test and verify RED**

Stub the existing environment module and navigator, dynamically import the adapter, and assert:

```ts
expect(readCurrentEnvironmentPresentationPolicy()).toMatchObject({
  surface: "desktop",
  platform: "windows",
  connectionsPresentation: "local-wsl",
});
```

Run the adapter test and expect failure because its module is absent.

- [ ] **Step 5: Implement the current-host adapter**

Keep all global reads in this file:

```ts
export function readCurrentEnvironmentPresentationPolicy(): EnvironmentPresentationPolicy {
  const platform = typeof navigator === "undefined" ? "" : navigator.platform;
  return createEnvironmentPresentationPolicy({
    surface: isDesktopHost ? "desktop" : "browser",
    platform: normalizeDesktopHostPlatform(platform),
  });
}
```

- [ ] **Step 6: Run both tests and commit**

```bash
cd apps/web
vp test run --passWithNoTests \
  src/connection/environmentPresentationPolicy.test.ts \
  src/connection/currentEnvironmentPresentation.test.ts
cd ../..
git add apps/web/src/connection/environmentPresentationPolicy.ts \
  apps/web/src/connection/environmentPresentationPolicy.test.ts \
  apps/web/src/connection/currentEnvironmentPresentation.ts \
  apps/web/src/connection/currentEnvironmentPresentation.test.ts
git commit -m "feat(web): centralize desktop environment presentation"
```

Expected: all tests pass; the commit contains only the policy and adapter units.

---

### Task 2: Add Project Local Location Presentation

**Files:**
- Modify: `apps/web/src/components/add-project/useAddProjectWorkflow.ts:55-103,548-590`
- Modify: `apps/web/src/components/add-project/AddProjectSteps.tsx:17-29,196-266`
- Modify: `apps/web/src/components/AddProjectDialog.tsx:48-64`
- Modify: `apps/web/src/components/add-project/useAddProjectWorkflow.public.test.tsx`
- Modify: `apps/web/src/components/add-project/AddProjectSteps.test.tsx`
- Modify: `apps/web/src/components/AddProjectDialog.test.tsx`

**Interfaces:**
- Consumes: `readCurrentEnvironmentPresentationPolicy()` and `policy.presentsTarget(target)` from Task 1.
- Produces:

```ts
export type AddProjectLocationLabel = "Host" | "Location" | null;

export interface AddProjectWorkflow {
  readonly hosts: ReadonlyArray<AddProjectHostOption>;
  readonly locationLabel: AddProjectLocationLabel;
  // existing members unchanged
}

export interface AddProjectStartStepProps {
  readonly hosts: ReadonlyArray<AddProjectHostOption>;
  readonly locationLabel: AddProjectLocationLabel;
  // existing members unchanged
}
```

- [ ] **Step 1: Write failing workflow visibility tests**

In the public workflow harness, provide primary, desktop-local WSL, SSH, relay, and bearer environments. Mock the current policy for each case and assert:

```ts
expect(result.current.hosts.map((host) => host.label)).toEqual(["This device"]);
expect(result.current.locationLabel).toBeNull();
```

for macOS desktop, and:

```ts
expect(result.current.hosts.map((host) => host.label)).toEqual([
  "This device",
  "Ubuntu (WSL)",
]);
expect(result.current.locationLabel).toBe("Location");
```

for Windows desktop. Add a browser case proving all current hosts remain present with `locationLabel === "Host"`.

- [ ] **Step 2: Write failing start-step DOM tests**

Render `AddProjectStartStep` with one host and `locationLabel={null}`. Assert there is no `Host`, `Location`, or combobox. Render the Windows case with two hosts and assert a **Location** combobox containing This device and WSL. Retain the current keyboard/action tests.

- [ ] **Step 3: Run focused tests and verify RED**

```bash
cd apps/web
vp test run --passWithNoTests \
  src/components/add-project/useAddProjectWorkflow.public.test.tsx \
  src/components/add-project/AddProjectSteps.test.tsx \
  src/components/AddProjectDialog.test.tsx
```

Expected: FAIL because the workflow does not filter by policy and the start step has no `locationLabel` contract.

- [ ] **Step 4: Filter targets and derive the label**

Read the policy once in `useAddProjectWorkflow`, filter before mapping, and preserve the existing fallback primary:

```ts
const presentation = readCurrentEnvironmentPresentationPolicy();
const presentedEnvironments = environments.filter((environment) =>
  presentation.presentsTarget(environment.entry.target),
);
const catalogHosts = presentedEnvironments.map((environment): AddProjectHostOption => {
  const isPrimary = environment.environmentId === primaryEnvironment?.environmentId;
  const desktopInstanceId = isDesktopLocalConnectionTarget(environment.entry.target)
    ? (desktopLocalBootstraps.find(
        (bootstrap) => bootstrap.httpBaseUrl === environment.displayUrl,
      )?.id ?? null)
    : null;
  return {
    environmentId: environment.environmentId,
    label: resolveEnvironmentOptionLabel({
      isPrimary,
      environmentId: environment.environmentId,
      runtimeLabel: environment.label,
    }),
    platform: getEnvironmentBrowsePlatform(environment.serverConfig?.environment.platform.os),
    baseDirectory: defaultAddProjectParent(
      environment.serverConfig?.settings?.addProjectBaseDirectory,
    ),
    isPrimary,
    desktopInstanceId,
    nativePickerAvailable: typeof window !== "undefined" && window.desktopBridge !== undefined,
  };
});
const hosts = catalogHosts.length > 0 ? catalogHosts : [fallbackHost(primaryEnvironmentId)];
const locationLabel: AddProjectLocationLabel =
  presentation.surface === "browser"
    ? "Host"
    : presentation.platform === "windows" && hosts.length > 1
      ? "Location"
      : null;
```

Pass `locationLabel` through `AddProjectWorkflow` and `AddProjectDialog`.

- [ ] **Step 5: Render no redundant field and a Windows Location field**

Replace the unconditional Host label with:

```tsx
{locationLabel === null ? null : (
  <label className="flex items-center gap-3">
    <span className="font-medium text-muted-foreground text-sm">{locationLabel}</span>
    <Select
      disabled={busy}
      items={hostItems}
      modal={false}
      onValueChange={(value) => {
        if (value !== null) onSelectHost(value as EnvironmentId);
      }}
      value={selectedEnvironmentId}
    >
      <SelectTrigger aria-label={locationLabel} className="w-auto min-w-40" size="sm">
        <SelectValue />
      </SelectTrigger>
      <SelectPopup>
        {hosts.map((host) => (
          <SelectItem key={host.environmentId} value={host.environmentId}>
            {host.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  </label>
)}
```

Do not render a disabled selector when the label is null.

- [ ] **Step 6: Run the focused matrix and commit**

```bash
cd apps/web
vp test run --passWithNoTests \
  src/components/add-project/AddProjectDialog.logic.test.ts \
  src/components/add-project/useAddProjectWorkflow.test.tsx \
  src/components/add-project/useAddProjectWorkflow.public.test.tsx \
  src/components/add-project/AddProjectSteps.test.tsx \
  src/components/AddProjectDialog.test.tsx
cd ../..
git add apps/web/src/components/AddProjectDialog.tsx \
  apps/web/src/components/add-project/AddProjectSteps.tsx \
  apps/web/src/components/add-project/AddProjectSteps.test.tsx \
  apps/web/src/components/add-project/useAddProjectWorkflow.ts \
  apps/web/src/components/add-project/useAddProjectWorkflow.test.tsx \
  apps/web/src/components/add-project/useAddProjectWorkflow.public.test.tsx \
  apps/web/src/components/AddProjectDialog.test.tsx
git commit -m "fix(web): present only local project locations"
```

Expected: all focused tests pass and remote target behavior remains covered in browser mode.

---

### Task 3: Windows Local Environment Settings Without Remote Controls

**Files:**
- Create: `apps/web/src/components/settings/LocalEnvironmentSettings.tsx`
- Create: `apps/web/src/components/settings/LocalEnvironmentSettings.test.tsx`
- Create: `apps/web/src/routes/settings.connections.test.tsx`
- Modify: `apps/web/src/components/settings/ConnectionsSettings.tsx:1977-3725`
- Modify: `apps/web/src/components/settings/ConnectionsSettings.test.tsx`
- Modify: `apps/web/src/components/settings/SettingsSidebarNav.tsx:30-122`
- Modify: `apps/web/src/components/settings/SettingsSidebarNav.test.tsx`
- Modify: `apps/web/src/routes/settings.connections.tsx:1-7`

**Interfaces:**
- Consumes: `ConnectionsPresentation`, `readCurrentEnvironmentPresentationPolicy()`, existing `desktopWslStateAtom`, bridge WSL methods, `useEnvironments`, `SettingsPageContainer`, `SettingsSection`, and `SettingsRow`.
- Produces:

```ts
export function LocalEnvironmentSettings(): ReactElement;

export function settingsNavItemsFor(
  policy: EnvironmentPresentationPolicy,
): ReadonlyArray<SettingsNavItem>;

export function connectionsRouteDestination(
  policy: EnvironmentPresentationPolicy,
): "/settings/connections" | "/settings/general";
```

- [ ] **Step 1: Write failing Windows local-settings tests**

Create a focused harness using the existing WSL bridge/state fixtures. Assert that Windows local presentation contains **Local environment**, **WSL backend**, distro selection, retry/error state, WSL-only confirmation, and disable confirmation, but contains none of:

```ts
for (const hiddenText of [
  "Network access",
  "Tailscale HTTPS",
  "Authorized clients",
  "BiBCode Connect",
  "Remote environments",
  "Add environment",
  "SSH",
]) {
  expect(markup).not.toContain(hiddenText);
}
```

Port the current WSL mutation assertions from `ConnectionsSettings.test.tsx` to the new component test without weakening them.

- [ ] **Step 2: Write failing navigation and route tests**

Assert the settings nav matrix:

```ts
expect(settingsNavItemsFor(windowsPolicy).map((item) => item.label)).toContain(
  "Local environment",
);
expect(settingsNavItemsFor(macPolicy).map((item) => item.label)).not.toContain(
  "Local environment",
);
expect(settingsNavItemsFor(browserPolicy).map((item) => item.label)).not.toContain(
  "Local environment",
);
```

Assert `connectionsRouteDestination` returns Connections for browser and Windows, General for macOS/Linux/unknown desktop. Assert desktop settings footer markup omits BiBCode Connect sign-in/avatar while browser markup retains them.

- [ ] **Step 3: Run focused tests and verify RED**

```bash
cd apps/web
vp test run --passWithNoTests \
  src/components/settings/LocalEnvironmentSettings.test.tsx \
  src/components/settings/ConnectionsSettings.test.tsx \
  src/components/settings/SettingsSidebarNav.test.tsx \
  src/routes/settings.connections.test.tsx
```

Expected: FAIL because the local component, policy-derived nav, and route destination do not exist.

- [ ] **Step 4: Extract WSL ownership into `LocalEnvironmentSettings`**

Move the WSL-only state and handlers from `ConnectionsSettings` into the new component:

- `isUpdatingWslBackend`, `desktopWslMutationError`, and `pendingWslChange`;
- `desktopWslStateAtom` query and `refreshDesktopWslState`;
- `applyWslSettingChange`, retry, disable, distro, and WSL-only handlers;
- desktop-local registration loss detection via `isDesktopLocalConnectionTarget`;
- the WSL settings row, recovery row, enable-mode dialog, and confirmation dialog.

The component's top-level structure is:

```tsx
export function LocalEnvironmentSettings() {
  const desktopBridge = window.desktopBridge;
  const { environments } = useEnvironments();
  // existing WSL state and callbacks, moved without remote dependencies
  return (
    <SettingsPageContainer>
      <SettingsSection title="Local environment">{renderWslRow()}</SettingsSection>
      {wslDialogs}
    </SettingsPageContainer>
  );
}
```

When the bridge or WSL state is unavailable, keep the existing error/retry or loading presentation; never substitute a remote setup control.

- [ ] **Step 5: Make Connections a policy wrapper**

Rename the current implementation internally to `FullConnectionsSettings`, remove the moved WSL code from it, and export:

```tsx
export function ConnectionsSettings() {
  const policy = readCurrentEnvironmentPresentationPolicy();
  if (policy.connectionsPresentation === "local-wsl") {
    return <LocalEnvironmentSettings />;
  }
  if (policy.connectionsPresentation === "redirect-general") {
    return null;
  }
  return <FullConnectionsSettings />;
}
```

The full browser page must retain all existing remote behavior and tests.

- [ ] **Step 6: Gate the route and settings navigation**

Add Connections to `SettingsSectionPath`, but include it only for Windows local presentation:

```ts
const LOCAL_ENVIRONMENT_NAV_ITEM = {
  label: "Local environment",
  to: "/settings/connections",
  icon: MonitorIcon,
} as const;

export function settingsNavItemsFor(policy: EnvironmentPresentationPolicy) {
  return policy.showLocalEnvironmentSettings
    ? [BASE_SETTINGS_NAV_ITEMS[0]!, LOCAL_ENVIRONMENT_NAV_ITEM, ...BASE_SETTINGS_NAV_ITEMS.slice(1)]
    : BASE_SETTINGS_NAV_ITEMS;
}

export function connectionsRouteDestination(
  policy: EnvironmentPresentationPolicy,
): "/settings/connections" | "/settings/general" {
  return policy.connectionsPresentation === "redirect-general"
    ? "/settings/general"
    : "/settings/connections";
}
```

Render BiBCode Connect sign-in/avatar only when `policy.showRemoteDeviceControls` is true. In the route `beforeLoad`, throw `redirect({ to: "/settings/general", replace: true })` when the destination helper returns General.

- [ ] **Step 7: Run the focused matrix and commit**

```bash
cd apps/web
vp test run --passWithNoTests \
  src/components/settings/ConnectionsSettings.logic.test.ts \
  src/components/settings/ConnectionsSettings.test.tsx \
  src/components/settings/LocalEnvironmentSettings.test.tsx \
  src/components/settings/SettingsSidebarNav.test.tsx \
  src/routes/settings.connections.test.tsx
cd ../..
git add apps/web/src/components/settings/ConnectionsSettings.tsx \
  apps/web/src/components/settings/ConnectionsSettings.test.tsx \
  apps/web/src/components/settings/LocalEnvironmentSettings.tsx \
  apps/web/src/components/settings/LocalEnvironmentSettings.test.tsx \
  apps/web/src/components/settings/SettingsSidebarNav.tsx \
  apps/web/src/components/settings/SettingsSidebarNav.test.tsx \
  apps/web/src/routes/settings.connections.tsx \
  apps/web/src/routes/settings.connections.test.tsx
git commit -m "fix(web): keep desktop connection settings local"
```

Expected: Windows WSL and full browser Connections suites pass independently; macOS/Linux direct-route behavior is deterministic.

---

### Task 4: Remove Remaining Desktop Remote Entry Points

**Files:**
- Modify: `apps/web/src/routes/__root.tsx:125-145`
- Modify: `apps/web/src/routes/__root.test.tsx`
- Modify: `apps/web/src/components/ChatView.tsx:2049-2070,2299-2335`
- Modify: `apps/web/src/components/ChatView.hooks.test.tsx`
- Modify: `apps/web/src/components/Sidebar.tsx:3640-3895,3968-4002,4625-4645`
- Modify: `apps/web/src/components/sidebar/SidebarProjectAvailability.tsx:6-92`
- Modify: `apps/web/src/components/sidebar/SidebarProjectAvailability.test.tsx`
- Verify unchanged browser onboarding: `apps/web/src/routes/_chat.index.tsx`
- Verify unchanged direct capability routes: `apps/web/src/routes/pair.tsx` and remote runtime modules.

**Interfaces:**
- Consumes: Task 1 policy and target predicates.
- Produces: no desktop-mounted relay installer, no remote Connect/Retry/Connections actions, and preserved local/WSL/browser recovery.

- [ ] **Step 1: Write failing root-shell and banner tests**

In `__root.test.tsx`, render authenticated desktop local-only policy and assert the relay installer mock is absent; render browser policy and assert it remains.

In the ChatView harness, exercise three unavailable targets:

```ts
expect(macRemoteBanner.textContent).not.toContain("Reconnect");
expect(macRemoteBanner.textContent).not.toContain("Connections");
expect(windowsWslBanner.textContent).toContain("Reconnect");
expect(windowsWslBanner.textContent).not.toContain("Connections");
expect(browserRemoteBanner.textContent).toContain("Reconnect");
expect(browserRemoteBanner.textContent).toContain("Connections");
```

- [ ] **Step 2: Write failing sidebar recovery tests**

Change `SidebarProjectAvailabilityProps` to accept explicit booleans:

```ts
readonly showRetry: boolean;
readonly showConnectionSettings: boolean;
```

Test that remote desktop unavailable state shows passive error text and Diagnostics only; local/WSL desktop retains Retry; browser retains Retry and Settings.
In the parent Sidebar test, keep a saved remote project row mounted while its
Retry and Settings controls are absent, proving the presentation policy never
deletes or filters stored project data.

- [ ] **Step 3: Run focused tests and verify RED**

```bash
cd apps/web
vp test run --passWithNoTests \
  src/routes/__root.test.tsx \
  src/components/ChatView.hooks.test.tsx \
  src/components/Sidebar.test.tsx \
  src/components/sidebar/SidebarProjectAvailability.test.tsx
```

Expected: FAIL because every current surface still exposes its remote action or lacks explicit presentation props.

- [ ] **Step 4: Gate the root and ChatView**

Read the policy once per owner component. Render the relay dialog only for full remote presentation:

```tsx
{presentation.showRemoteDeviceControls ? <RelayClientInstallDialog /> : null}
```

Resolve the active unavailable environment target from `environmentById`. Build actions as:

```tsx
const permitsReconnect =
  target !== undefined && presentation.permitsConnectionAction(target);
const showConnections = presentation.showRemoteDeviceControls;

actions:
  permitsReconnect || showConnections ? (
    <>
      {permitsReconnect ? <ReconnectButton /> : null}
      {showConnections ? <ConnectionsButton /> : null}
    </>
  ) : undefined;
```

Do not alter connection state or the reconnect command.

- [ ] **Step 5: Gate sidebar recovery actions**

At the Sidebar owner, resolve `projectAvailability.environmentId` to its target and derive:

```ts
const showRetry =
  target !== null && presentation.permitsConnectionAction(target);
const showConnectionSettings =
  presentation.showRemoteDeviceControls ||
  (presentation.showLocalEnvironmentSettings && target !== null && presentation.presentsTarget(target));
```

Render Retry and Settings only when their explicit props are true. Keep Diagnostics, recovery, cached-data, and safe storage actions unchanged.

- [ ] **Step 6: Audit ordinary UI entry points**

Run:

```bash
rg -n "settings/connections|BiBCodeConnectSidebar|RelayClientInstallDialog|Add environment|Remote link|Tailscale|Network access|Authorized clients" apps/web/src \
  -g '!**/*.test.*' -g '!routeTree.gen.ts'
```

Expected intentional matches after this task:

- browser/hosted onboarding;
- the gated Connections route/page;
- components retained as underlying functionality;
- policy-gated root/settings imports.

No unconditional desktop navigation or mount remains.

- [ ] **Step 7: Run focused tests and commit**

```bash
cd apps/web
vp test run --passWithNoTests \
  src/routes/__root.test.tsx \
  src/components/ChatView.hooks.test.tsx \
  src/components/Sidebar.test.tsx \
  src/components/sidebar/SidebarProjectAvailability.test.tsx \
  src/components/cloud/RelayClientInstallDialog.test.tsx
cd ../..
git add apps/web/src/routes/__root.tsx apps/web/src/routes/__root.test.tsx \
  apps/web/src/components/ChatView.tsx apps/web/src/components/ChatView.hooks.test.tsx \
  apps/web/src/components/Sidebar.tsx apps/web/src/components/Sidebar.test.tsx \
  apps/web/src/components/sidebar/SidebarProjectAvailability.tsx \
  apps/web/src/components/sidebar/SidebarProjectAvailability.test.tsx
git commit -m "fix(web): hide remote desktop connection actions"
```

Expected: local/WSL recovery works; remote desktop controls are absent; browser controls remain.

---

### Task 5: Compact Discovered Worktree Rows

**Files:**
- Modify: `apps/web/src/components/WorktreeDiscoverySection.logic.ts:12-79`
- Modify: `apps/web/src/components/WorktreeDiscoverySection.logic.test.ts:20-135`
- Modify: `apps/web/src/components/WorktreeDiscoverySection.tsx:116-177,334-430,474-526`
- Modify: `apps/web/src/components/WorktreeDiscoverySection.test.tsx:267-790`

**Interfaces:**
- Consumes: existing catalog grouping and adoption behavior.
- Produces:

```ts
export interface WorktreeDiscoveryCandidatePresentation {
  readonly candidate: VcsWorktreeDescriptor;
  readonly label: string;
  readonly discriminator: string | null;
}
```

- [ ] **Step 1: Write failing duplicate and grouping logic tests**

Create two same-branch candidates under one parent and candidates under two different parents. Assert:

```ts
expect(groups[0]?.parentGroups).toMatchObject([
  {
    parentDirectory: "/Users/admin/conductor/workspaces",
    candidates: [
      { label: "hotfix/PFS-1817", discriminator: "pathfinder-hotfix" },
      { label: "hotfix/PFS-1817", discriminator: "pathfinder-review" },
    ],
  },
  {
    parentDirectory: "/Users/admin/orca/workspaces",
    candidates: [{ label: "alpha", discriminator: null }],
  },
]);
```

The discriminator is the exact final path component and is null unless the same parent subgroup has a duplicate primary label.

- [ ] **Step 2: Write failing DOM/accessibility tests**

Assert the initial card and shown discovered rows:

- render each exact parent directory once;
- render branch labels and required duplicate discriminators;
- do not visibly repeat each full candidate path;
- retain each exact path in the Add action name, focusable accessible description, and tooltip;
- keep Add controls after the shrinking text element; and
- use `min-w-0`, block-level truncation, and a stable trailing action data marker.

Use exact DOM assertions, for example:

```ts
expect(parentRows.map((row) => row.textContent)).toEqual([
  "/Users/admin/conductor/workspaces",
  "/Users/admin/orca/workspaces",
]);
expect(candidateRow.querySelector("[data-worktree-candidate-copy]")?.className).toContain(
  "min-w-0",
);
expect(candidateRow.lastElementChild?.getAttribute("data-worktree-add-action")).toBe("true");
```

- [ ] **Step 3: Run focused tests and verify RED**

```bash
cd apps/web
vp test run --passWithNoTests \
  src/components/WorktreeDiscoverySection.logic.test.ts \
  src/components/WorktreeDiscoverySection.test.tsx
```

Expected: FAIL because candidates have no discriminator and paths are still visibly repeated.

- [ ] **Step 4: Add deterministic duplicate discriminators**

After sorting each parent subgroup, count exact display labels and populate only duplicate rows:

```ts
const labelCounts = new Map<string, number>();
for (const item of candidates) {
  labelCounts.set(item.label, (labelCounts.get(item.label) ?? 0) + 1);
}
return candidates.map((item) => ({
  ...item,
  discriminator:
    (labelCounts.get(item.label) ?? 0) > 1
      ? getFinalPathComponentForDisplay(item.candidate.path)
      : null,
}));
```

Handle both `/` and `\\` separators without normalizing or changing the submitted path.

- [ ] **Step 5: Render parent-once compact rows**

Make `CandidateDetails` label-only visually. The visible copy wrapper itself is
the focusable tooltip trigger; do not create an invisible focus target:

```tsx
<Tooltip>
  <TooltipTrigger
    render={
      <span
        aria-label={fullPathName}
        className="flex min-w-0 flex-1 flex-col items-start overflow-hidden rounded-sm text-left outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
        data-worktree-candidate-copy
        tabIndex={0}
      />
    }
  >
    <span className="block max-w-full truncate text-[11px] font-medium">{label}</span>
    {discriminator ? (
      <span className="block max-w-full truncate font-mono text-[9px] text-muted-foreground">
        {discriminator}
      </span>
    ) : null}
  </TooltipTrigger>
  <TooltipPopup side="top"><span className="font-mono">{path}</span></TooltipPopup>
</Tooltip>
```

Use the same parent-group wrapper for hidden-card and shown-row modes. Mark the trailing Add button with `data-worktree-add-action="true"`, `shrink-0`, and preserve every existing command and pending-state guard.

- [ ] **Step 6: Run focused tests and commit**

```bash
cd apps/web
vp test run --passWithNoTests \
  src/components/WorktreeDiscoverySection.logic.test.ts \
  src/components/WorktreeDiscoverySection.test.tsx \
  src/components/Sidebar.test.tsx
cd ../..
git add apps/web/src/components/WorktreeDiscoverySection.logic.ts \
  apps/web/src/components/WorktreeDiscoverySection.logic.test.ts \
  apps/web/src/components/WorktreeDiscoverySection.tsx \
  apps/web/src/components/WorktreeDiscoverySection.test.tsx
git commit -m "fix(web): compact discovered worktree paths"
```

Expected: grouping/adoption behavior remains green, full paths remain accessible, and no visible candidate path can widen the card.

---

### Task 6: Align Activity Metadata Under Titles

**Files:**
- Modify: `apps/web/src/components/activity/ActivityDock.tsx:416-535`
- Modify: `apps/web/src/components/activity/ActivityDock.test.tsx`
- Verify: `apps/web/src/components/activity/ProviderTerminalActivityDock.test.tsx`
- Verify: `apps/web/src/components/ActivitySurfaces.test.tsx`

**Interfaces:**
- Consumes: existing Activity view model, elapsed labels, section state, and compact/expanded modes.
- Produces: expanded section copy wrappers marked by `data-activity-section-copy` with title/count and metadata as vertical children.

- [ ] **Step 1: Write failing geometry tests**

For expanded Subagents and Background Tasks, assert the primary and metadata nodes share the same vertical copy wrapper:

```ts
for (const section of ["subagents", "backgroundTasks"] as const) {
  const copy = container.querySelector(`[data-activity-section-copy="${section}"]`);
  const primary = container.querySelector(`[data-activity-section-primary="${section}"]`);
  const metadata = container.querySelector(`[data-activity-section-metadata="${section}"]`);
  expect(copy?.className).toContain("flex-col");
  expect(primary?.parentElement).toBe(copy);
  expect(metadata?.parentElement).toBe(copy);
}
```

Retain compact-mode assertions so no metadata geometry change leaks into the compact dock.

- [ ] **Step 2: Run the exact test and verify RED**

```bash
cd apps/web
vp test run --passWithNoTests src/components/activity/ActivityDock.test.tsx
```

Expected: FAIL because the current copy wrapper is not a flex column.

- [ ] **Step 3: Implement the minimal layout correction**

For both expanded sections, change only the copy wrapper:

```tsx
<span
  className="flex min-w-0 flex-1 flex-col"
  data-activity-section-copy="subagents"
>
```

and the equivalent `backgroundTasks` wrapper. Preserve icon/status rails, count copy, elapsed computation, aria labels, actions, and compact markup.

- [ ] **Step 4: Run Activity coverage and commit**

```bash
cd apps/web
vp test run --passWithNoTests \
  src/components/activity/ActivityDock.test.tsx \
  src/components/activity/ProviderTerminalActivityDock.test.tsx \
  src/components/ActivitySurfaces.test.tsx \
  src/components/ChatView.test.tsx
cd ../..
git add apps/web/src/components/activity/ActivityDock.tsx \
  apps/web/src/components/activity/ActivityDock.test.tsx
git commit -m "fix(web): align activity section metadata"
```

Expected: all tests pass with no lifecycle or control behavior changes.

---

### Task 7: Living Documentation and Provider Regression Contract

**Files:**
- Modify: `docs/user/workspace-ui.md:27-70,220-250`
- Modify: `docs/user/remote-access.md:1-25,98-160`
- Verify: `apps/web/src/components/chat/ChatHeaderPanelMenu.logic.test.ts`
- Verify: `apps/web/src/components/chat/providerAgentActions.test.ts`
- Verify: `apps/web/src/components/settings/SettingsPanels.test.tsx`
- Verify: `apps/web/src/components/settings/providerDriverMeta.ts`

**Interfaces:**
- Consumes: implemented behavior from Tasks 1-6 and provider visibility commit `12847faf`.
- Produces: current user-facing documentation without changing remote architecture or provider runtime behavior.

- [ ] **Step 1: Update workspace UI documentation**

Replace the unconditional Add Project host-selection statement with the exact presentation:

```md
On macOS and Linux desktop, Add Project uses this device and omits a redundant
location selector. On Windows, it shows **Location** when a mapped WSL backend
is available, offering **This device** and the usable WSL locations. Browser
clients retain connected-host selection.
```

Document worktree parent grouping, compact branch rows, duplicate discriminators, and full-path tooltip/focus/accessibility behavior. Document that Activity elapsed metadata aligns under the section title.

- [ ] **Step 2: Update remote-access documentation**

Add a leading current-product note:

```md
The v0.3.14 macOS, Linux, and Windows desktop UI is presented as local-only.
Remote connection, pairing, SSH, Tailscale, network-exposure, and BiBCode
Connect controls are hidden without removing their underlying implementation.
Windows keeps **Settings → Local environment** for WSL. The browser/hosted UI
retains the full remote workflow described below.
```

Change Windows WSL references from Connections to Local environment. Keep the remaining remote documentation explicitly scoped to browser/hosted or future re-enabled presentation; do not claim the functionality was deleted.

- [ ] **Step 3: Run provider visibility regressions**

```bash
cd apps/web
vp test run --passWithNoTests \
  src/components/chat/ChatHeaderPanelMenu.logic.test.ts \
  src/components/chat/ChatHeaderPanelMenu.test.tsx \
  src/components/chat/providerAgentActions.test.ts \
  src/components/settings/SettingsPanels.test.tsx
```

Expected: Claude, Codex, Cursor, and OpenCode are visible where configured; Grok chat, terminal, default, and Settings rows remain absent; Cursor/OpenCode have no Early Access badge.

- [ ] **Step 4: Audit documentation and commit**

```bash
rg -n "Settings → Connections|Host|full host path|Activity" docs/user/workspace-ui.md docs/user/remote-access.md
git diff --check
git add docs/user/workspace-ui.md docs/user/remote-access.md
git commit -m "docs: describe local-only desktop presentation"
```

Expected: current desktop and browser/hosted boundaries are explicit and non-contradictory.

---

### Task 8: Broad Automated and Packaged v0.3.14 Verification

**Files:**
- Verify all changed files from Tasks 1-7.
- Create ignored evidence only: `.superpowers/visual/2026-08-13-local-desktop-ui-polish/*`
- Do not edit tracked source during evidence capture unless a failing check returns the work to the owning task's RED/GREEN cycle.

**Interfaces:**
- Consumes: committed Tasks 1-7 and the existing v0.3.14 Tauri build workflow.
- Produces: complete automated results, one exact packaged process, original-resolution screenshots, enlarged crops, and a pixel-level review ledger.

- [ ] **Step 1: Run the complete focused web matrix**

```bash
cd apps/web
vp test run --passWithNoTests \
  src/connection/environmentPresentationPolicy.test.ts \
  src/connection/currentEnvironmentPresentation.test.ts \
  src/components/add-project/AddProjectDialog.logic.test.ts \
  src/components/add-project/useAddProjectWorkflow.test.tsx \
  src/components/add-project/useAddProjectWorkflow.public.test.tsx \
  src/components/add-project/AddProjectSteps.test.tsx \
  src/components/AddProjectDialog.test.tsx \
  src/components/settings/ConnectionsSettings.logic.test.ts \
  src/components/settings/ConnectionsSettings.test.tsx \
  src/components/settings/LocalEnvironmentSettings.test.tsx \
  src/components/settings/SettingsSidebarNav.test.tsx \
  src/routes/settings.connections.test.tsx \
  src/routes/__root.test.tsx \
  src/components/ChatView.hooks.test.tsx \
  src/components/Sidebar.test.tsx \
  src/components/sidebar/SidebarProjectAvailability.test.tsx \
  src/components/WorktreeDiscoverySection.logic.test.ts \
  src/components/WorktreeDiscoverySection.test.tsx \
  src/components/activity/ActivityDock.test.tsx \
  src/components/activity/ProviderTerminalActivityDock.test.tsx \
  src/components/ActivitySurfaces.test.tsx \
  src/components/chat/ChatHeaderPanelMenu.logic.test.ts \
  src/components/chat/providerAgentActions.test.ts \
  src/components/settings/SettingsPanels.test.tsx
cd ../..
```

Expected: every focused behavior passes.

- [ ] **Step 2: Run package and workspace gates sequentially**

```bash
vp run --filter @bibcode/web test
vp run --filter @bibcode/desktop test
vp check
vp run typecheck
vp run test
git diff --check
git status --short
```

Expected: all commands exit zero. Do not run multiple Cargo/Vite+ graph owners concurrently. Record any existing non-fatal diagnostic separately; do not hide it by changing timeouts or serialization.

- [ ] **Step 3: Verify version and build the exact desktop app**

```bash
node -e 'const fs=require("fs"); for (const file of ["apps/web/package.json","apps/desktop/package.json"]) { const value=JSON.parse(fs.readFileSync(file,"utf8")); if (value.version !== "0.3.14") throw new Error(`${file}: ${value.version}`); }'
vp run build:desktop
test -x target/release/bundle/macos/BiBCode.app/Contents/MacOS/BiBCode
```

Expected: both packages are exactly `0.3.14`; the worktree-local `.app` exists and is executable.

- [ ] **Step 4: Launch exactly one worktree bundle with Codex Computer Use**

Invoke `computer-use:computer-use`. Quit only a previously recorded executable from this exact worktree through normal UI. Confirm it is absent, then launch:

```bash
open -n /Users/admin/.codex/worktrees/142f/BibCode/target/release/bundle/macos/BiBCode.app
```

Record the exact PID and command. Never launch an installed `/Applications/BiBCode.app`, another worktree, v0.3.13, or a second packaged instance.

- [ ] **Step 5: Exercise worktree and performance-sensitive workflows**

Through Codex Computer Use:

1. open the existing externally created Git worktree project;
2. show the discovered-worktree card with candidates from at least two parent directories;
3. keyboard-focus and hover a compact candidate to expose its exact path;
4. adopt one candidate and confirm it becomes a normal workspace/thread without running worktree creation;
5. create/switch threads and center/right panels;
6. open Activity with live Subagents and, when available, Background Tasks;
7. exercise streaming activity, panel switching, narrow sidebar, and narrow Activity sheet states;
8. open Add Project and Settings; and
9. inspect provider Settings and the new-panel/provider-terminal menu.

Expected: external worktrees, thread state, panels, and prior performance fixes remain functional with no visible stale state or excessive remounting.

- [ ] **Step 6: Capture original-resolution evidence**

Save screenshots to `.superpowers/visual/2026-08-13-local-desktop-ui-polish/` for:

1. normal and narrow discovered-worktree cards;
2. candidate path tooltip and keyboard focus ring;
3. adopted external worktree row/thread;
4. Activity Subagents and Background Tasks at normal and narrow widths;
5. Add Project without a Host selector on macOS;
6. Settings nav/footer and direct Connections navigation result;
7. provider Settings cards;
8. chat `+` provider and provider-terminal menu;
9. thread/panel/streaming states used for performance regression review.

- [ ] **Step 7: Inspect every screenshot at original resolution and enlarged crops**

Use `view_image` at `original` detail and create lossless enlarged crops when needed. For every frame, explicitly check:

- no horizontal overflow, clipping, path/action overlap, or hidden Add button;
- parent paths appear once and candidate labels remain distinguishable;
- full paths appear in tooltips/focus accessibility, not repeated row text;
- elapsed metadata aligns beneath Activity titles, not beneath icons;
- no SSH, remote host, pairing, Tailscale, BiBCode Connect, network exposure, advertised endpoint, relay install, or remote Connections affordance is visible;
- Claude, Codex, Cursor, and OpenCode are visible; Grok and Grok Terminal are absent;
- Cursor/OpenCode have no Early Access badge;
- focus rings are complete; icons, status, and text are pixel-aligned;
- no raw provider/native IDs, unexpected layout shifts, duplicate icons, stale banners, or regression in thread/panel responsiveness appears.

If any check fails, return to its owning task, add a deterministic failing test, implement the smallest fix, rerun focused and applicable broad gates, rebuild once, and repeat only affected visual states.

- [ ] **Step 8: Final diff/status audit and completion commit if required**

```bash
git diff --check
git status --short
git log --oneline --decorate -12
git diff c5409e781be37ff2587ee24807c8de1acb86fbf4..HEAD --stat
```

Expected: no generated/debug/evidence files are tracked, no important `main` fix is lost, and only intentional commits exist. If visual verification required no source correction, do not create an empty commit.

---

## Completion Evidence Checklist

- [ ] Central policy matrix is green for browser, macOS desktop, Linux desktop, Windows desktop, and unknown desktop.
- [ ] Add Project hides the redundant selector on macOS/Linux and exposes only local+WSL Location on Windows.
- [ ] Windows Local environment settings retain WSL; desktop remote controls are absent.
- [ ] Browser/hosted remote workflows remain green.
- [ ] Worktree candidates group by exact parent, never overflow, and retain exact accessible paths.
- [ ] Activity metadata aligns under titles for both roster sections.
- [ ] Claude, Codex, Cursor, and OpenCode remain visible; Grok remains hidden.
- [ ] Complete web, desktop, workspace test graph, check, and typecheck gates pass.
- [ ] Exactly one v0.3.14 packaged app was visually exercised through Codex Computer Use.
- [ ] Original-resolution and enlarged-crop pixel review found no remaining collision, overflow, remote affordance, or performance regression.
- [ ] Final range preserves the latest `main` history and has a clean tracked worktree.
