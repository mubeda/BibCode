# Shared Workspace Folder Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Settings → General → Workspace use Add Project's native folder picker for desktop-hosted environments while retaining the in-app browser for remote hosts.

**Architecture:** Move the native picker capability check and WSL path-routing logic into a shared web module. Keep Add Project's public adapter stable, then have Workspace call the same shared function for primary and desktop-local environments and fall back to `RemoteDirectoryPickerDialog` for remote environments.

**Tech Stack:** React 19, TypeScript, Vite+, LocalApi/DesktopBridge, existing WSL path utilities.

## Global Constraints

- Primary “This device” and desktop-local WSL environments use the operating system's native picker.
- SSH, relay, and other remote environments retain `RemoteDirectoryPickerDialog`.
- Cancelling a picker must not update settings.
- A selection may update only the environment that initiated it.
- Do not change the Tauri command, Rust dialog implementation, backend RPCs, or visual layout.
- Add no dependencies.
- `vp check` and `vp run typecheck` must pass.

---

### Task 1: Extract the shared host-folder picker

**Files:**
- Create: `apps/web/src/components/hostFolderPicker.ts`
- Create: `apps/web/src/components/hostFolderPicker.test.ts`
- Modify: `apps/web/src/components/add-project/pickAddProjectFolder.ts`
- Modify: `apps/web/src/components/add-project/AddProjectDialog.logic.ts`
- Modify: `apps/web/src/components/add-project/useAddProjectWorkflow.ts`
- Test: `apps/web/src/components/add-project/pickAddProjectFolder.test.ts`
- Test: `apps/web/src/components/add-project/AddProjectDialog.logic.test.ts`

**Interfaces:**
- Consumes: `LocalApi["dialogs"]["pickFolder"]`, `resolveProjectPickerTarget`, `resolveWslProjectSelection`, `applyWslEnvironmentConfiguration`, and `parseWslUncPath`.
- Produces:

```ts
export interface HostFolderPickerTarget {
  readonly environmentId: EnvironmentId;
  readonly platform: string | null;
  readonly isPrimary: boolean;
  readonly desktopInstanceId: string | null;
  readonly nativePickerAvailable: boolean;
}

export type PickHostFolderResult =
  | { readonly _tag: "Cancelled" }
  | { readonly _tag: "Selected"; readonly environmentId: EnvironmentId; readonly path: string }
  | { readonly _tag: "Failure"; readonly message: string };

export interface PickHostFolderInput {
  readonly host: HostFolderPickerTarget;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly initialPath: string;
  readonly dialogs: Pick<LocalApi["dialogs"], "pickFolder">;
  readonly getWslState: () => Promise<DesktopWslState | null>;
  readonly primaryRunningDistro: string | null;
  readonly wslCandidates: ReadonlyArray<WslEnvironmentCandidate<EnvironmentId>>;
}

export function canUseNativeHostFolderPicker(target: HostFolderPickerTarget): boolean;
export function getEnvironmentBrowsePlatform(os: string | null | undefined): string | null;
export function readPrimaryRunningDistro(): string | null;
export function pickHostFolder(input: PickHostFolderInput): Promise<PickHostFolderResult>;
```

- Preserves: `pickAddProjectFolder`, `PickAddProjectFolderInput`, and `PickAddProjectFolderResult` as a thin compatibility adapter for existing Add Project consumers.

- [ ] **Step 1: Write the failing shared-module tests**

Create `hostFolderPicker.test.ts` with the existing primary, WSL, cancellation, and unsupported-host cases. Include this capability assertion:

```ts
expect(
  canUseNativeHostFolderPicker({
    environmentId: EnvironmentId.make("primary"),
    platform: "Win32",
    isPrimary: true,
    desktopInstanceId: null,
    nativePickerAvailable: true,
  }),
).toBe(true);

expect(
  canUseNativeHostFolderPicker({
    environmentId: EnvironmentId.make("remote"),
    platform: "Linux",
    isPrimary: false,
    desktopInstanceId: null,
    nativePickerAvailable: true,
  }),
).toBe(false);
```

- [ ] **Step 2: Run the new test and verify RED**

Run:

```bash
vp test run --project unit apps/web/src/components/hostFolderPicker.test.ts
```

Expected: FAIL because `hostFolderPicker.ts` does not exist.

- [ ] **Step 3: Implement the shared module and compatibility adapter**

Move the body of `pickAddProjectFolder` into `pickHostFolder`. Replace its Add Project type dependency with `HostFolderPickerTarget`, and use the shared capability function:

```ts
export function canUseNativeHostFolderPicker(target: HostFolderPickerTarget): boolean {
  return target.nativePickerAvailable && (target.isPrimary || target.desktopInstanceId !== null);
}

export function getEnvironmentBrowsePlatform(os: string | null | undefined): string | null {
  if (os === "windows") return "Win32";
  if (os === "darwin") return "MacIntel";
  if (os === "linux") return "Linux";
  return null;
}

export function readPrimaryRunningDistro(): string | null {
  if (typeof window === "undefined" || window.desktopBridge === undefined) return null;
  try {
    return (
      window.desktopBridge
        .getLocalEnvironmentBootstraps()
        .find((entry) => entry.id === PRIMARY_LOCAL_ENVIRONMENT_ID)?.runningDistro ?? null
    );
  } catch {
    return null;
  }
}

export async function pickHostFolder(
  input: PickHostFolderInput,
): Promise<PickHostFolderResult> {
  if (!canUseNativeHostFolderPicker(input.host)) {
    return {
      _tag: "Failure",
      message: "This host does not support folder picking. Enter its project path manually.",
    };
  }

  const wslState =
    input.host.isPrimary && input.host.platform === "Linux"
      ? await input.getWslState().catch(() => null)
      : null;
  const targetEnvironmentId = resolveProjectPickerTarget({
    browseEnvironmentId: input.host.environmentId,
    primaryEnvironmentId: input.primaryEnvironmentId,
    desktopInstanceId: input.host.desktopInstanceId,
    wslConfiguration: wslState,
  });
  const pickedPath = await input.dialogs.pickFolder({
    initialPath: input.initialPath,
    ...(targetEnvironmentId ? { targetEnvironmentId } : {}),
  });
  if (!pickedPath) return { _tag: "Cancelled" };
  if (!parseWslUncPath(pickedPath)) {
    return {
      _tag: "Selected",
      environmentId: input.host.environmentId,
      path: pickedPath,
    };
  }

  const selection = resolveWslProjectSelection(
    pickedPath,
    applyWslEnvironmentConfiguration(
      input.wslCandidates,
      input.primaryEnvironmentId,
      wslState,
      input.primaryRunningDistro,
    ),
  );
  return selection
    ? { _tag: "Selected", environmentId: selection.environmentId, path: selection.linuxPath }
    : {
        _tag: "Failure",
        message: "Start the matching WSL backend, then choose the folder again.",
      };
}
```

Make `pickAddProjectFolder.ts` delegate without duplicating selection logic:

```ts
export const pickAddProjectFolder = pickHostFolder;
export type PickAddProjectFolderInput = PickHostFolderInput;
export type PickAddProjectFolderResult = PickHostFolderResult;
```

Make `shouldUseNativePicker` delegate to `canUseNativeHostFolderPicker` so Add Project and Workspace cannot drift. Move `getEnvironmentBrowsePlatform` into the shared module and re-export it from `AddProjectDialog.logic.ts` to preserve existing imports. Move `readPrimaryRunningDistro` from `useAddProjectWorkflow.ts` into the shared module and update that consumer.

- [ ] **Step 4: Run shared and Add Project tests and verify GREEN**

Run:

```bash
vp test run --project unit apps/web/src/components/hostFolderPicker.test.ts apps/web/src/components/add-project/pickAddProjectFolder.test.ts apps/web/src/components/add-project/AddProjectDialog.logic.test.ts apps/web/src/components/add-project/useAddProjectWorkflow.test.tsx
```

Expected: all selected tests PASS.

- [ ] **Step 5: Commit Task 1**

```bash
git add apps/web/src/components/hostFolderPicker.ts apps/web/src/components/hostFolderPicker.test.ts apps/web/src/components/add-project/pickAddProjectFolder.ts apps/web/src/components/add-project/AddProjectDialog.logic.ts apps/web/src/components/add-project/useAddProjectWorkflow.ts apps/web/src/components/add-project/pickAddProjectFolder.test.ts apps/web/src/components/add-project/AddProjectDialog.logic.test.ts
git commit -m "refactor: share native host folder picker"
```

### Task 2: Route Workspace through the shared picker

**Files:**
- Modify: `apps/web/src/components/settings/WorktreeWorkspaceSetting.tsx`
- Modify: `apps/web/src/components/settings/WorktreeWorkspaceSetting.test.tsx`

**Interfaces:**
- Consumes: `canUseNativeHostFolderPicker`, `pickHostFolder`, `useDesktopLocalBootstraps`, `desktopLocalBackendId`, `isDesktopLocalConnectionTarget`, `readLocalApi`, and the current environment presentations.
- Produces: Workspace Browse behavior that selects the shared native picker for primary/desktop-local hosts and `RemoteDirectoryPickerDialog` for all other hosts.

- [ ] **Step 1: Write failing Workspace routing tests**

Extend the existing harness with a shared picker mock:

```ts
hostPicker: vi.fn(async () => ({
  _tag: "Selected" as const,
  environmentId: EnvironmentId.make("host-one"),
  path: "D:\\Worktrees",
})),
```

Replace the current local-picker expectation with:

```ts
it("uses the shared native picker for the primary desktop host", async () => {
  const local = connectedEnvironment("host-one", "This device");
  harness.environments = [local];
  harness.primaryEnvironment = local;
  await renderSetting();

  await invoke(button("Browse"), "onClick");

  expect(harness.hostPicker).toHaveBeenCalledOnce();
  expect(latest(harness.pickers).open).toBe(false);
  expect(harness.updateByEnvironment.get("host-one")).toHaveBeenCalledWith({
    worktreeBaseDirectory: "D:\\Worktrees",
  });
});
```

Add the remote fallback test:

```ts
it("keeps the server browser for a remote host", async () => {
  harness.environments = [connectedEnvironment("remote", "SSH host")];
  harness.primaryEnvironment = null;
  await renderSetting();

  await invoke(button("Browse"), "onClick");

  expect(harness.hostPicker).not.toHaveBeenCalled();
  expect(latest(harness.pickers).open).toBe(true);
});
```

Add the cancellation test:

```ts
it("leaves Workspace unchanged when native picking is cancelled", async () => {
  const local = connectedEnvironment("host-one", "This device");
  harness.environments = [local];
  harness.primaryEnvironment = local;
  harness.hostPicker.mockResolvedValueOnce({ _tag: "Cancelled" });
  await renderSetting();

  await invoke(button("Browse"), "onClick");

  expect(harness.updateByEnvironment.get("host-one")).toBeUndefined();
});
```

Add the visible failure test:

```ts
it("shows a native picker failure without changing Workspace", async () => {
  const local = connectedEnvironment("host-one", "This device");
  harness.environments = [local];
  harness.primaryEnvironment = local;
  harness.hostPicker.mockResolvedValueOnce({
    _tag: "Failure",
    message: "Native folder picker failed.",
  });
  const setting = await renderSetting();

  await invoke(button("Browse"), "onClick");

  expect(setting.container.textContent).toContain("Native folder picker failed.");
  expect(harness.updateByEnvironment.get("host-one")).toBeUndefined();
});
```

Add the stale-result test with a deferred native result:

```ts
it("ignores a native selection after the selected host changes", async () => {
  const local = connectedEnvironment("host-one", "This device");
  const remote = connectedEnvironment("host-two", "SSH host");
  harness.environments = [local, remote];
  harness.primaryEnvironment = local;
  let resolveSelection!: (result: PickHostFolderResult) => void;
  harness.hostPicker.mockReturnValueOnce(
    new Promise((resolve) => {
      resolveSelection = resolve;
    }),
  );
  const setting = await renderSetting();

  const browsing = invoke(button("Browse"), "onClick");
  await invoke(select("Workspace host"), "onValueChange", "host-two");
  await rerender(setting);
  resolveSelection({
    _tag: "Selected",
    environmentId: EnvironmentId.make("host-one"),
    path: "D:\\Stale",
  });
  await browsing;

  expect(harness.updateByEnvironment.get("host-one")).toBeUndefined();
  expect(harness.updateByEnvironment.get("host-two")).toBeUndefined();
});
```

- [ ] **Step 2: Run the Workspace test and verify RED**

Run:

```bash
vp test run --project unit apps/web/src/components/settings/WorktreeWorkspaceSetting.test.tsx
```

Expected: FAIL because Workspace still always opens `RemoteDirectoryPickerDialog` and never calls the shared picker.

- [ ] **Step 3: Implement native/local routing with remote fallback**

Build the shared target from the selected environment:

```ts
const isPrimary = environment.environmentId === primaryEnvironmentId;
const desktopInstanceId = isDesktopLocalConnectionTarget(environment.entry.target)
  ? (desktopLocalBootstraps.find(
      (bootstrap) => bootstrap.httpBaseUrl === environment.displayUrl,
    )?.id ?? null)
  : null;
const nativeTarget = {
  environmentId: environment.environmentId,
  platform: getEnvironmentBrowsePlatform(environment.serverConfig?.environment.platform.os),
  isPrimary,
  desktopInstanceId,
  nativePickerAvailable: typeof window !== "undefined" && window.desktopBridge !== undefined,
};
```

Pass `primaryEnvironment?.environmentId ?? null` from `WorktreeWorkspaceSetting` into `EnvironmentWorktreeWorkspaceSetting` as `primaryEnvironmentId`; do not infer primary status from list order.

Build the WSL candidates from the same environment and bootstrap identities used to create `desktopInstanceId`:

```ts
const wslCandidates = environments.flatMap((candidate) => {
  const backendId = desktopLocalBackendId(candidate.entry.target);
  if (backendId === null) return [];
  const bootstrap = desktopLocalBootstraps.find(
    (entry) => entry.httpBaseUrl === candidate.displayUrl,
  );
  return [{
    environmentId: candidate.environmentId,
    backendId,
    runningDistro: bootstrap?.runningDistro ?? null,
  }];
});
```

On Browse, call `pickHostFolder` only when `canUseNativeHostFolderPicker(nativeTarget)` is true. Use this complete request shape:

```ts
const api = readLocalApi();
if (api === undefined) {
  setError("Folder picking is unavailable.");
  return;
}
let result: PickHostFolderResult;
try {
  result = await pickHostFolder({
    host: nativeTarget,
    primaryEnvironmentId,
    initialPath: configured || "~",
    dialogs: api.dialogs,
    getWslState: () =>
      typeof window === "undefined" || window.desktopBridge === undefined
        ? Promise.resolve(null)
        : window.desktopBridge.getWslState(),
    primaryRunningDistro: readPrimaryRunningDistro(),
    wslCandidates,
  });
} catch (cause) {
  if (requestIsCurrent()) {
    setError(cause instanceof Error ? cause.message : "Folder picking failed.");
  }
  return;
}
```

Handle results as follows:

```ts
switch (result._tag) {
  case "Cancelled":
    return;
  case "Failure":
    setError(result.message);
    return;
  case "Selected":
    if (result.environmentId === environment.environmentId && requestIsCurrent()) {
      await save(result.path);
    }
}
```

Use a request token cleared on unmount so a stale native selection cannot save to a newly selected host. For hosts without native picker support, keep `setPickerOpen(true)` and the existing `RemoteDirectoryPickerDialog` unchanged.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
vp test run --project unit apps/web/src/components/settings/WorktreeWorkspaceSetting.test.tsx apps/web/src/components/hostFolderPicker.test.ts apps/web/src/components/add-project/pickAddProjectFolder.test.ts apps/web/src/components/add-project/useAddProjectWorkflow.test.tsx
```

Expected: all selected tests PASS.

- [ ] **Step 5: Run repository-required checks**

Run:

```bash
vp check
vp run typecheck
```

Expected: both commands exit 0.

- [ ] **Step 6: Commit Task 2**

```bash
git add apps/web/src/components/settings/WorktreeWorkspaceSetting.tsx apps/web/src/components/settings/WorktreeWorkspaceSetting.test.tsx
git commit -m "fix: use native picker for local Workspace"
```
