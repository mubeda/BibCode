# Remote Update Version Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the installed and remote application versions together on the About screen when a desktop update is available.

**Architecture:** Reuse `DesktopUpdateState.availableVersion`, which already reaches `AboutVersionSection`. Pass it into the existing title component and conditionally append it to the build-time `APP_VERSION`; no updater, bridge, or contract changes are needed.

**Tech Stack:** React 19, TypeScript, Vite+ tests

## Global Constraints

- Render `Version 0.2.14 → 0.2.15` when `availableVersion` is present.
- Keep the existing installed-only label when `availableVersion` is absent.
- Preserve browser builds and existing update actions, descriptions, and tooltips.
- Add no dependencies or new updater state.

---

### Task 1: Render the available version in the About title

**Files:**

- Modify: `apps/web/src/components/settings/SettingsPanels.tsx:224-330`
- Test: `apps/web/src/components/settings/SettingsPanels.test.tsx:889-915`

**Interfaces:**

- Consumes: `DesktopUpdateState.availableVersion: string | null`
- Produces: `AboutVersionTitle({ availableVersion }: { readonly availableVersion?: string | null })`

- [ ] **Step 1: Write the failing rendering assertion**

In the existing `downloads available updates and surfaces download failures` test, add the installed-to-remote label assertion after rendering:

```tsx
const markup = render(<GeneralSettingsPanel />);
expect(markup).toContain("9.9.9-test → 10.0.0");
expect(markup).toContain("Update available.");
expect(markup).toContain("Update 10.0.0 ready to download");
```

- [ ] **Step 2: Run the focused test and verify the new assertion fails**

Run:

```powershell
vp test run apps/web/src/components/settings/SettingsPanels.test.tsx --project unit
```

Expected: FAIL because the markup contains `9.9.9-test` but not `9.9.9-test → 10.0.0`.

- [ ] **Step 3: Pass the existing available version into the title**

Update `AboutVersionTitle` to accept the nullable version and append it only when present:

```tsx
function AboutVersionTitle({ availableVersion }: { readonly availableVersion?: string | null }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span>Version</span>
      <code className="text-[11px] font-medium text-muted-foreground">
        {APP_VERSION}
        {availableVersion ? <> → {availableVersion}</> : null}
      </code>
    </span>
  );
}
```

Pass the updater value from `AboutVersionSection`:

```tsx
<SettingsRow
  title={<AboutVersionTitle availableVersion={updateState?.availableVersion} />}
```

Leave the browser fallback’s existing `<AboutVersionTitle />` call unchanged so it continues to show only `APP_VERSION`.

- [ ] **Step 4: Run the focused test and verify it passes**

Run:

```powershell
vp test run apps/web/src/components/settings/SettingsPanels.test.tsx --project unit
```

Expected: PASS.

- [ ] **Step 5: Run the required repository checks**

Run:

```powershell
vp check
vp run typecheck
```

Expected: both commands exit successfully.

- [ ] **Step 6: Commit the implementation**

```powershell
git add -- apps/web/src/components/settings/SettingsPanels.tsx apps/web/src/components/settings/SettingsPanels.test.tsx
git commit -m "fix: show remote version for available updates"
```
