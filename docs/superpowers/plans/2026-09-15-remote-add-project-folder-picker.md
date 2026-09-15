# Remote Add Project Folder Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adding a project to a remote server browses that server's directories in a folder picker instead of asking for a typed path; local and mapped WSL hosts keep the native OS folder dialog.

**Architecture:** `useAddProjectWorkflow.browse()` (`apps/web/src/components/add-project/useAddProjectWorkflow.ts:306-310`) already branches on `shouldUseNativePicker(selectedHost)`; hosts that cannot use the native picker currently fall to the `"host-path"` text step. The existing `RemoteDirectoryPickerDialog` (`apps/web/src/components/settings/RemoteDirectoryPickerDialog.tsx`) browses any server directory through the unscoped `filesystem.browse` RPC and is used only by Settings → Workspace. This plan extracts its body into a shared `RemoteDirectoryBrowser` component, keeps the Settings dialog as a thin wrapper, and renders the browser as a new `"remote-browse"` step inside the Add Project dialog. No server change is required beyond a missing unit test for `browse_directory` in directory mode, which the picker relies on.

**Tech Stack:** React 19, Effect atoms via `@bibcode/client-runtime`, Vitest via Vite+, Rust server (test only).

**Spec:** User request, 2026-09-15, verbatim: "RemoteServer: add project should display a folder pickup dialog with remote files, currently if i want to add a new project just an file editor with the home simbol is used. I think we already have this file browser component but we do not use it, we should only use it for remote severs". Historical intent: `docs/superpowers/specs/2026-08-02-shared-workspace-folder-picker-design.md:22` ("SSH, relay, and other remote environments continue opening `RemoteDirectoryPickerDialog`, because a native operating-system picker cannot browse those server filesystems.") and `docs/plans/remote-servers/phases/phase-6-environment-rail.md:2457-2461`, which deferred the picker.

## Global Constraints

- Routing stays on the single existing predicate `shouldUseNativePicker(host)` → `canUseNativeHostFolderPicker` (`apps/web/src/components/hostFolderPicker.ts:35-37`). Hosts that can use the native dialog are unchanged. Assumption: a browser-mode primary host (no `window.desktopBridge`) also gets the server browser, because a native dialog is impossible there and the user's phrase "only for remote servers" targets local desktop hosts keeping the native picker.
- The picker consumes only `filesystem.browse` (read scope) and `projects.createEntry` (New folder); no new RPC, contract, or server behaviour.
- Project registration still goes through `input.operations.addFolder({ environmentId, workspaceRoot, shouldContinue })` exactly as `submitHostPath` does (`useAddProjectWorkflow.ts:354-371`).
- The manual path entry stays reachable: the browse step's path field accepts a typed path, and a "Type a path instead" secondary action switches to the existing `"host-path"` step.
- Initial path is `selectedHost.baseDirectory`, so `addProjectBaseDirectory` settings are honoured.
- `apps/web` change: run the `vercel-react-best-practices` review and the `UI.md` review before completion.
- Preserve the existing `RemoteDirectoryPickerDialog` public props so `WorktreeWorkspaceSetting.tsx:287-295` and its tests are unchanged.

---

### Task 1: Extract `RemoteDirectoryBrowser` from the Settings dialog

**Files:**
- Create: `apps/web/src/components/RemoteDirectoryBrowser.tsx`
- Modify: `apps/web/src/components/settings/RemoteDirectoryPickerDialog.tsx` (becomes a `Dialog` wrapper around the browser)
- Test: `apps/web/src/components/RemoteDirectoryBrowser.test.tsx` (new, real React mount following `RemoteDirectoryPickerDialog.runtime.test.tsx`), existing `RemoteDirectoryPickerDialog.test.tsx` and `.runtime.test.tsx` must keep passing

**Interfaces:**
- Produces:

```tsx
export interface RemoteDirectoryBrowserProps {
  readonly environmentId: EnvironmentId;
  readonly initialPath: string;
  /** Re-runs the reset effect (path, hidden toggle, warnings) when it changes; dialogs pass `open`. */
  readonly resetKey: unknown;
  /** Called with the canonical directory path when the user confirms. */
  readonly onSelect: (path: string) => void;
  /** Called when the user cancels; the host decides what cancel means. */
  readonly onCancel: () => void;
  /** Optional extra secondary action rendered next to Cancel (Add Project uses "Type a path instead"). */
  readonly secondaryAction?: { readonly label: string; readonly onClick: () => void };
  readonly selectLabel?: string;
}
export function RemoteDirectoryBrowser(props: RemoteDirectoryBrowserProps): React.JSX.Element;
```

- The browser renders everything currently between `<DialogHeader>` and the closing `</DialogPopup>` in `RemoteDirectoryPickerDialog.tsx:305-517`: toolbar (Up, path `DraftInput`, Refresh, New folder), breadcrumb rail, folder list, hidden-folder toggle, fallback warning, error, and a footer row with Cancel, the optional secondary action, and the Select button (`disabled={directoryPath === null || query.isPending || query.error !== null}`).

- [ ] **Step 1: Write the failing browser test**

Create `apps/web/src/components/RemoteDirectoryBrowser.test.tsx` by copying the module-mock setup from `settings/RemoteDirectoryPickerDialog.runtime.test.tsx` (mocks for `~/state/query`, `~/state/projects`, `~/state/filesystem`, `~/state/use-atom-command`) and add:

```tsx
it("selects the canonical directory and exposes the secondary action", async () => {
  browseState.result = {
    parentPath: "/srv",
    directoryPath: "/srv/code",
    ancestorPath: "/srv",
    breadcrumbs: [{ name: "srv", path: "/srv" }, { name: "code", path: "/srv/code" }],
    entries: [{ name: "app", path: "/srv/code/app", kind: "directory" }],
  };
  const onSelect = vi.fn();
  const onCancel = vi.fn();
  const secondary = vi.fn();
  const { container, root } = await mount(
    <RemoteDirectoryBrowser
      environmentId={ENV}
      initialPath="/srv/code"
      resetKey={true}
      onSelect={onSelect}
      onCancel={onCancel}
      secondaryAction={{ label: "Type a path instead", onClick: secondary }}
    />,
  );

  await act(async () => requiredButton(container, "Type a path instead").click());
  expect(secondary).toHaveBeenCalledOnce();

  await act(async () => requiredButton(container, "Select folder").click());
  expect(onSelect).toHaveBeenCalledWith("/srv/code");

  await act(async () => requiredButton(container, "Cancel").click());
  expect(onCancel).toHaveBeenCalledOnce();

  await act(async () => root.unmount());
  container.remove();
});
```

Use the same `browseState`, `mount`, `requiredButton`, and `ENV` helper names the runtime test defines (copy them).

- [ ] **Step 2: Run the test to verify it fails**

```bash
node scripts/run-local-vp.mjs test run apps/web/src/components/RemoteDirectoryBrowser.test.tsx
```

Expected: FAIL, module `./RemoteDirectoryBrowser` does not exist.

- [ ] **Step 3: Move the body into the new component**

Create `apps/web/src/components/RemoteDirectoryBrowser.tsx` by moving from `RemoteDirectoryPickerDialog.tsx` everything except the `Dialog`/`DialogPopup`/`DialogHeader` shell: the helper functions `validateNewFolderName` and `createFolderErrorMessage`, the `PickerContextIdentity`/`RefreshAfterNavigation` types, all state and effects, `navigateTo`, the create-folder flow, and the JSX from the toolbar through the error paragraph. Replace every use of `open` in the reset effect and context identity with `resetKey`, and change the query guard from `open ? filesystemEnvironment.browse(...) : null` to always call `filesystemEnvironment.browse(...)` (the browser is only mounted while visible). Render this footer in place of `DialogFooter`:

```tsx
      <div className="flex items-center justify-end gap-2 pt-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        {secondaryAction ? (
          <Button type="button" variant="ghost" onClick={secondaryAction.onClick}>
            {secondaryAction.label}
          </Button>
        ) : null}
        <Button
          type="button"
          disabled={directoryPath === null || query.isPending || query.error !== null}
          onClick={() => {
            if (directoryPath) onSelect(directoryPath);
          }}
        >
          {selectLabel ?? "Select folder"}
        </Button>
      </div>
```

Then reduce `settings/RemoteDirectoryPickerDialog.tsx` to:

```tsx
export function RemoteDirectoryPickerDialog({
  open,
  environmentId,
  initialPath,
  onOpenChange,
  onSelect,
}: RemoteDirectoryPickerDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-xl">
        <DialogHeader className="pb-4">
          <DialogTitle>Select Workspace folder</DialogTitle>
          <DialogDescription>Browse directories on the selected BiBCode host.</DialogDescription>
        </DialogHeader>
        <div className="px-6 pb-5">
          {open ? (
            <RemoteDirectoryBrowser
              environmentId={environmentId}
              initialPath={initialPath}
              resetKey={open}
              onSelect={onSelect}
              onCancel={() => onOpenChange(false)}
            />
          ) : null}
        </div>
      </DialogPopup>
    </Dialog>
  );
}
```

Keep `RemoteDirectoryPickerDialogProps` exported with the same shape.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
node scripts/run-local-vp.mjs test run apps/web/src/components/RemoteDirectoryBrowser.test.tsx apps/web/src/components/settings/RemoteDirectoryPickerDialog.test.tsx apps/web/src/components/settings/RemoteDirectoryPickerDialog.runtime.test.tsx apps/web/src/components/settings/WorktreeWorkspaceSetting.test.tsx
```

Expected: PASS. If a static-markup test in `RemoteDirectoryPickerDialog.test.tsx` asserted on the `DialogFooter` markup, update its expectation to the new footer classes; behaviour assertions stay the same.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/RemoteDirectoryBrowser.tsx apps/web/src/components/RemoteDirectoryBrowser.test.tsx apps/web/src/components/settings/RemoteDirectoryPickerDialog.tsx apps/web/src/components/settings/RemoteDirectoryPickerDialog.test.tsx
git commit -m "refactor(web): extract RemoteDirectoryBrowser from the settings picker dialog"
```

---

### Task 2: Route non-native hosts to a `remote-browse` step

**Files:**
- Modify: `apps/web/src/components/add-project/AddProjectDialog.logic.ts:13` (`AddProjectStep` union)
- Modify: `apps/web/src/components/add-project/useAddProjectWorkflow.ts` (`browse` at 306-310; add `selectBrowsedFolder` and `openHostPath`; export them from the workflow object)
- Test: `apps/web/src/components/add-project/useAddProjectWorkflow.test.tsx:209-214` and new cases

**Interfaces:**
- Produces on the workflow object: `step: "start" | "host-path" | "remote-browse" | "clone" | "create"`, `selectBrowsedFolder(path: string): Promise<void>`, `openHostPath(): void`.

- [ ] **Step 1: Update and add workflow tests**

Replace the test at line 209 with:

```tsx
  it("opens the server directory browser when the selected host is not picker-routable", async () => {
    const view = await mountWorkflow({ open: true });
    act(() => view.current.selectHost(ENV_REMOTE));
    await act(async () => view.current.browse());
    expect(view.current.step).toBe("remote-browse");
    expect(testState.pickFolder).not.toHaveBeenCalled();
  });

  it("adds the browsed folder on the remote host", async () => {
    const view = await mountWorkflow({ open: true });
    act(() => view.current.selectHost(ENV_REMOTE));
    await act(async () => view.current.browse());
    await act(async () => view.current.selectBrowsedFolder("/srv/code/app"));
    expect(testState.operations.addFolder).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId: ENV_REMOTE, workspaceRoot: "/srv/code/app" }),
    );
    expect(testState.onOpenChange).toHaveBeenCalledWith(false);
  });

  it("switches from the browser to manual path entry", async () => {
    const view = await mountWorkflow({ open: true });
    act(() => view.current.selectHost(ENV_REMOTE));
    await act(async () => view.current.browse());
    act(() => view.current.openHostPath());
    expect(view.current.step).toBe("host-path");
    expect(view.current.error).toBeNull();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
node scripts/run-local-vp.mjs test run apps/web/src/components/add-project/useAddProjectWorkflow.test.tsx
```

Expected: FAIL, `step` is `"host-path"` and `selectBrowsedFolder`/`openHostPath` are undefined.

- [ ] **Step 3: Implement the step**

In `AddProjectDialog.logic.ts` line 13:

```ts
export type AddProjectStep = "start" | "host-path" | "remote-browse" | "clone" | "create";
```

In `useAddProjectWorkflow.ts`, change the first branch of `browse` to:

```ts
    if (!shouldUseNativePicker(selectedHost)) {
      setStep("remote-browse");
      setError(null);
      return;
    }
```

Add after `submitHostPath`:

```ts
  const openHostPath = useCallback(() => {
    setStep("host-path");
    setError(null);
  }, []);

  const selectBrowsedFolder = useCallback(
    async (path: string) => {
      const generation = beginAsync();
      if (generation === null) {
        return;
      }
      await completeOperation(generation, (shouldContinue) =>
        input.operations.addFolder({
          environmentId: selectedHost.environmentId,
          workspaceRoot: path,
          shouldContinue,
        }),
      );
    },
    [beginAsync, completeOperation, input.operations, selectedHost.environmentId],
  );
```

Add `openHostPath` and `selectBrowsedFolder` to the returned workflow object and to the `AddProjectWorkflow` type (wherever `submitHostPath` is declared).

- [ ] **Step 4: Run the tests to verify they pass**

```bash
node scripts/run-local-vp.mjs test run apps/web/src/components/add-project/useAddProjectWorkflow.test.tsx apps/web/src/components/add-project/AddProjectDialog.logic.test.ts apps/web/src/components/hostFolderPicker.test.ts
```

Expected: PASS (34 workflow tests: 31 existing minus the replaced one plus three).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/add-project/AddProjectDialog.logic.ts apps/web/src/components/add-project/useAddProjectWorkflow.ts apps/web/src/components/add-project/useAddProjectWorkflow.test.tsx
git commit -m "feat(add-project): route non-native hosts to a server directory browser step"
```

---

### Task 3: Render the browser step in the dialog

**Files:**
- Modify: `apps/web/src/components/AddProjectDialog.tsx:61-70` (add the `remote-browse` branch next to `host-path`)
- Modify: `apps/web/src/components/add-project/AddProjectSteps.tsx` (add `AddProjectRemoteBrowseStep` next to `AddProjectHostPathStep` at line 375)
- Test: `apps/web/src/components/AddProjectDialog.test.tsx:158-208` (mocks the workflow hook) and `apps/web/src/components/add-project/AddProjectSteps.test.tsx`

**Interfaces:**
- Consumes: `RemoteDirectoryBrowser` from Task 1; `workflow.step`, `workflow.selectBrowsedFolder`, `workflow.openHostPath`, `workflow.back`, `workflow.selectedHost` from Task 2.
- Produces:

```tsx
export interface AddProjectRemoteBrowseStepProps {
  readonly hostLabel: string;
  readonly environmentId: EnvironmentId;
  readonly initialPath: string;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onSelect: (path: string) => void;
  readonly onCancel: () => void;
  readonly onTypePath: () => void;
}
export function AddProjectRemoteBrowseStep(props: AddProjectRemoteBrowseStepProps): React.JSX.Element;
```

- [ ] **Step 1: Write the failing dialog test**

In `AddProjectDialog.test.tsx`, following the pattern of the host-path step test (which sets the mocked workflow's `step`), add:

```tsx
it("renders the server directory browser for the remote-browse step", () => {
  mockWorkflow({ step: "remote-browse" });
  const markup = render(<AddProjectDialog open onOpenChange={vi.fn()} />);
  expect(markup).toContain("Open project folder on Remote");
  expect(markup).toContain("Type a path instead");
  expect(markup).toContain("Select folder");
});
```

Mock `~/components/RemoteDirectoryBrowser` in this file the way `WorktreeWorkspaceSetting.test.tsx:134` mocks `./RemoteDirectoryPickerDialog`, rendering its `secondaryAction.label` and `selectLabel ?? "Select folder"` as plain text so the assertions above hold.

- [ ] **Step 2: Run the test to verify it fails**

```bash
node scripts/run-local-vp.mjs test run apps/web/src/components/AddProjectDialog.test.tsx
```

Expected: FAIL, nothing is rendered for an unknown step.

- [ ] **Step 3: Implement the step component and dialog branch**

In `AddProjectSteps.tsx` add:

```tsx
export function AddProjectRemoteBrowseStep({
  hostLabel,
  environmentId,
  initialPath,
  busy,
  error,
  onSelect,
  onCancel,
  onTypePath,
}: AddProjectRemoteBrowseStepProps) {
  return (
    <div className="space-y-5" aria-busy={busy}>
      <StepHeading
        description={`Choose a folder on ${hostLabel}.`}
        title={`Open project folder on ${hostLabel}`}
      />
      <RemoteDirectoryBrowser
        environmentId={environmentId}
        initialPath={initialPath}
        resetKey={environmentId}
        onSelect={onSelect}
        onCancel={onCancel}
        secondaryAction={{ label: "Type a path instead", onClick: onTypePath }}
        selectLabel={busy ? "Opening…" : "Open project"}
      />
      {error ? <ErrorMessage>{error}</ErrorMessage> : null}
    </div>
  );
}
```

Import `RemoteDirectoryBrowser` from `~/components/RemoteDirectoryBrowser` and `EnvironmentId` from `@bibcode/contracts`. In `AddProjectDialog.tsx`, after the `host-path` branch add:

```tsx
          {workflow.step === "remote-browse" ? (
            <AddProjectRemoteBrowseStep
              hostLabel={workflow.selectedHost.label}
              environmentId={workflow.selectedHost.environmentId}
              initialPath={workflow.selectedHost.baseDirectory}
              busy={workflow.busy}
              error={workflow.error}
              onSelect={(path) => void workflow.selectBrowsedFolder(path)}
              onCancel={workflow.back}
              onTypePath={workflow.openHostPath}
            />
          ) : null}
```

Update the dialog test's expectation to `"Open project"` if it asserted `"Select folder"` and the busy-false label is preferred; keep one assertion on the visible select label.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
node scripts/run-local-vp.mjs test run apps/web/src/components/AddProjectDialog.test.tsx apps/web/src/components/add-project/AddProjectSteps.test.tsx apps/web/src/components/RemoteDirectoryBrowser.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/AddProjectDialog.tsx apps/web/src/components/add-project/AddProjectSteps.tsx apps/web/src/components/AddProjectDialog.test.tsx apps/web/src/components/add-project/AddProjectSteps.test.tsx
git commit -m "feat(add-project): browse remote host folders when adding a project"
```

---

### Task 4: Server test for directory-mode browsing the picker relies on

**Files:**
- Test: `apps/server/src/workspace/entries.rs` test module (existing test at line 223 covers autocomplete mode only)

**Interfaces:**
- Consumes: `browse_directory(requested_path: &str, cwd: Option<&Path>) -> Result<BrowseResult, WorkspaceError>` (`entries.rs:121`) and `expand_home` (`entries.rs:195`).

- [ ] **Step 1: Write the test**

```rust
    #[tokio::test]
    async fn browse_directory_expands_home_and_reports_breadcrumbs_and_ancestor() {
        let root = tempfile::tempdir().unwrap();
        let nested = root.path().join("code/app");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::create_dir(root.path().join("code/.hidden")).unwrap();

        let result = browse_directory(&root.path().join("code").to_string_lossy(), None)
            .await
            .unwrap();
        let canonical = std::fs::canonicalize(root.path().join("code")).unwrap();
        assert_eq!(result.directory_path.as_deref(), Some(canonical.to_str().unwrap()));
        assert_eq!(
            result.ancestor_path.as_deref(),
            Some(canonical.parent().unwrap().to_str().unwrap())
        );
        let names: Vec<_> = result.entries.iter().map(|entry| entry.name.as_str()).collect();
        assert_eq!(names, vec![".hidden", "app"]);
        assert!(result.breadcrumbs.as_ref().is_some_and(|crumbs| !crumbs.is_empty()));

        let home = browse_directory("~", None).await;
        match dirs::home_dir() {
            Some(_) => assert!(home.is_ok()),
            None => assert!(home.is_err()),
        }

        let missing = browse_directory(&root.path().join("nope").to_string_lossy(), None).await;
        assert!(matches!(
            missing,
            Err(WorkspaceError::Operation { .. }) | Err(WorkspaceError::NotFound { .. })
        ));
    }
```

Match the `BrowseResult` field names to the struct definition in `entries.rs` (`directory_path`, `ancestor_path`, `breadcrumbs`, `entries`); the contract at `packages/contracts/src/filesystem.ts:25-31` mirrors them in camelCase.

- [ ] **Step 2: Run the test**

```bash
cargo test -p bibcode-server --lib -j 2 workspace::entries::tests::browse_directory_expands_home_and_reports_breadcrumbs_and_ancestor
```

Expected: PASS on first run (this locks in existing behaviour). If a field name differs, correct the test, not the implementation.

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/workspace/entries.rs
git commit -m "test(server): cover directory-mode filesystem browsing"
```

---

### Task 5: Documentation, reviews, and validation

**Files:**
- Modify: `docs/user/workspace-ui.md:74-76`
- Modify: `docs/architecture/connection-runtime.md:389`
- Review only: `docs/user/remote-access.md`, `docs/testing/` runbooks

- [ ] **Step 1: Update the docs**

In `docs/user/workspace-ui.md`, replace "Local and mapped WSL locations use the native folder picker; browser-only remote hosts accept an explicit host path." with:

```markdown
Local and mapped WSL locations use the native folder picker. Remote hosts, and
browser clients without a native dialog, open a folder browser that lists the
selected host's directories; **Type a path instead** switches to manual entry
of an absolute or home-relative path.
```

In `docs/architecture/connection-runtime.md` after "**Add project** targets the selected environment." add:

```markdown
When the target cannot use the native folder dialog, the dialog embeds
`RemoteDirectoryBrowser`, which lists directories through the read-scoped
`filesystem.browse` RPC on that environment's server.
```

- [ ] **Step 2: Run the required reviews**

Invoke the `vercel-react-best-practices` skill on `RemoteDirectoryBrowser.tsx`, `AddProjectSteps.tsx`, `AddProjectDialog.tsx`, and `useAddProjectWorkflow.ts`. Review against `UI.md`: recognition over recall (folder list instead of typed path), manual entry preserved, the Select button disabled until a canonical directory is loaded with the error paragraph explaining why. Record both outcomes.

- [ ] **Step 3: Run repository gates**

```bash
node scripts/run-local-vp.mjs test run apps/web/src/components/RemoteDirectoryBrowser.test.tsx apps/web/src/components/settings apps/web/src/components/add-project apps/web/src/components/AddProjectDialog.test.tsx
cargo test -p bibcode-server --lib -j 2 workspace::entries
vp check
vp run typecheck
rg -n "Add project|add-project" docs/testing
```

Expected: all green. If a runbook lists the add-project flow among packaged UI flows, add one line describing the remote browser step; otherwise report runbooks as reviewed and unchanged.

- [ ] **Step 4: Commit**

```bash
git add docs/user/workspace-ui.md docs/architecture/connection-runtime.md
git commit -m "docs(add-project): describe the remote folder browser"
```

## Out of scope

- Routing the clone/create steps' parent-folder button (`canPickParent`, `useAddProjectWorkflow.ts:535`) to the remote browser; it stays hidden for remote hosts as today.
- Filtering add-project hosts by connection phase (a disconnected remote host opens the browser, whose error paragraph reports the failure).

## Self-review

- Spec coverage: remote add project shows a folder browser (Tasks 2-3), reuses the existing component (Task 1), local hosts unchanged (Task 2 guard), docs (Task 5).
- Placeholder scan: none.
- Type consistency: `RemoteDirectoryBrowserProps` fields (`environmentId`, `initialPath`, `resetKey`, `onSelect`, `onCancel`, `secondaryAction`, `selectLabel`) match between Task 1 and Task 3; `selectBrowsedFolder`/`openHostPath` match between Tasks 2 and 3; step literal `"remote-browse"` is identical everywhere.
