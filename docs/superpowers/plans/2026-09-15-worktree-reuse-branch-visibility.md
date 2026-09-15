# Create Worktree "Reuse branch" Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The **Reuse branch** checkbox in the Create Worktree dialog is visible whenever a branch is selected, disabled with an explanation when the branch cannot be reused, and the dialog explains when the branch list failed to load.

**Architecture:** The control exists (`apps/web/src/components/CreateWorktreeDialog.tsx:661-676`) but is unmounted unless `canReuseBranch(ref)` is true, which requires a local, non-current branch not checked out in any worktree (`CreateWorktreeDialog.logic.ts:69-72`). Orca ADE, the source of the port, always mounts the control for any selected branch and disables it instead. Heavy worktree users therefore never see it. The fix gates on "a branch is selected", renders the checkbox disabled with a reason when reuse is impossible, folds the existing "already checked out" status note into that reason, and surfaces `refsQuery.error` so an empty branch list is never silent. Submission semantics (`resolveWorktreeCreateInput`) are unchanged.

**Tech Stack:** React 19, Vitest via Vite+ (`node scripts/run-local-vp.mjs`), happy-dom for the DOM suite.

**Spec:** User request, 2026-09-15, verbatim: "in the create new worktree dialog, we add the reuse branch checkbox feature from orca ADE, but the checkbox is not visible." Diagnosis evidence: the conditional at `CreateWorktreeDialog.tsx:661` (`{canReuseSelectedBranch ? (...) : null}`); the existing test `CreateWorktreeDialog.test.tsx:1546` that asserts `not.toContain("Reuse branch")` for an occupied branch; Orca ADE's extracted renderer mounts the control with `disabled: !E` and `aria-hidden` collapse rather than unmounting it.

## Global Constraints

- Reuse remains possible only for a free local branch (`canReuseBranch` unchanged). Remote branches and occupied branches still go through the new-branch flow with the server's safe suffixed name.
- The checkbox is disabled, never hidden, once a branch is selected. Disabled states explain themselves (`UI.md` "Make disabled/unavailable states understandable").
- Copy stays short and uses the existing wording: "Reuse branch" / "Check out the existing branch instead of creating a new one from it."
- No contract, server, or RPC change; `vcs.listRefs` payload is unchanged.
- `apps/web` change: run the `vercel-react-best-practices` review and the `UI.md` review before completion.
- Preserve the browser-gated `describe` structure: DOM tests execute through `CreateWorktreeDialog.dom.test.tsx`, which re-imports `CreateWorktreeDialog.test.tsx` under happy-dom.

---

### Task 1: Always show the control for a selected branch

**Files:**
- Modify: `apps/web/src/components/CreateWorktreeDialog.tsx:661-686`
- Test: `apps/web/src/components/CreateWorktreeDialog.test.tsx` (browser interactions `describe` starting line 1240; occupied-branch test at lines 1529-1550; helpers `mountDialog`, `requiredButton`, `testState.refs`)

**Interfaces:**
- Consumes: `selectedBranchRef` (line 289-292), `canReuseSelectedBranch` (line 295), `reuseSelectedBranch` state (line 134), `handleReuseSelectedBranchChange` (lines 305-318, already returns early when reuse is not allowed).
- Produces: a `reuseBranchHint(ref)` helper in `CreateWorktreeDialog.logic.ts` returning the explanation string; Task 2 leaves it untouched.

- [ ] **Step 1: Flip the existing assertion and add the failing tests**

In `CreateWorktreeDialog.test.tsx`, in the test "explains when the selected local branch is already checked out" (line 1529), replace:

```ts
      expect(container.textContent).not.toContain("Reuse branch");
```

with:

```ts
      const reuseLabel = Array.from(container.querySelectorAll("label")).find((label) =>
        label.textContent?.includes("Reuse branch"),
      );
      expect(reuseLabel).toBeDefined();
      const reuseCheckbox = reuseLabel?.querySelector<HTMLInputElement>("input[type='checkbox']");
      expect(reuseCheckbox?.disabled).toBe(true);
      expect(reuseCheckbox?.checked).toBe(false);
```

Then add two tests after it, inside the same `describe`:

```tsx
    it("offers Reuse branch disabled for a selected remote branch and says why", async () => {
      testState.refs = [{ name: "origin/feature/remote-only", isRemote: true, remoteName: "origin" }];
      const { container, root } = await mountDialog();

      await React.act(async () => requiredButton(container, "Branch").click());
      await React.act(async () => requiredButton(container, "origin/feature/remote-only").click());

      const reuseLabel = Array.from(container.querySelectorAll("label")).find((label) =>
        label.textContent?.includes("Reuse branch"),
      );
      const reuseCheckbox = reuseLabel?.querySelector<HTMLInputElement>("input[type='checkbox']");
      expect(reuseCheckbox?.disabled).toBe(true);
      expect(container.textContent).toContain(
        '"origin/feature/remote-only" is a remote branch. A local branch will be created from it.',
      );

      await React.act(async () => root.unmount());
      container.remove();
    });

    it("offers Reuse branch enabled and checked for a free local branch", async () => {
      testState.refs = [{ name: "feature/free", isRemote: false, current: false, worktreePath: null }];
      const { container, root } = await mountDialog();

      await React.act(async () => requiredButton(container, "Branch").click());
      await React.act(async () => requiredButton(container, "feature/free").click());

      const reuseLabel = Array.from(container.querySelectorAll("label")).find((label) =>
        label.textContent?.includes("Reuse branch"),
      );
      const reuseCheckbox = reuseLabel?.querySelector<HTMLInputElement>("input[type='checkbox']");
      expect(reuseCheckbox?.disabled).toBe(false);
      expect(reuseCheckbox?.checked).toBe(true);
      expect(container.textContent).toContain(
        "Check out the existing branch instead of creating a new one from it.",
      );

      await React.act(async () => root.unmount());
      container.remove();
    });
```

If a `VcsRef` fixture in this file requires additional fields (for example `isDefault`), copy the shape from the existing `testState.refs` entries near line 1530.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
node scripts/run-local-vp.mjs test run apps/web/src/components/CreateWorktreeDialog.dom.test.tsx
```

Expected: FAIL. The occupied-branch and remote-branch tests fail because no `label` containing "Reuse branch" exists; the free-branch test passes already (it documents the unchanged path).

- [ ] **Step 3: Add the hint helper**

In `apps/web/src/components/CreateWorktreeDialog.logic.ts`, after `canReuseBranch` (line 72), add:

```ts
/** Explains why the Reuse branch control is enabled or disabled for the selected ref. */
export function reuseBranchHint(ref: RefLike & { readonly name: string }): string {
  if (canReuseBranch(ref)) {
    return "Check out the existing branch instead of creating a new one from it.";
  }
  if (ref.isRemote === true) {
    return `"${ref.name}" is a remote branch. A local branch will be created from it.`;
  }
  return `"${ref.name}" is already checked out. A new branch ("${ref.name}-2" or the next available name) will be created from it.`;
}
```

If `RefLike` already includes `name`, drop the intersection and take `RefLike` directly.

- [ ] **Step 4: Replace the conditional block and the duplicate status note**

In `CreateWorktreeDialog.tsx`, replace lines 661-686 (the `canReuseSelectedBranch ? (...)` block and the following `selectedBranchRef && ... role="status"` paragraph) with:

```tsx
            {selectedBranchRef ? (
              <div className="space-y-1 pt-1">
                <label className="flex w-fit items-center gap-2 text-xs text-foreground">
                  <input
                    type="checkbox"
                    checked={reuseSelectedBranch}
                    disabled={!canReuseSelectedBranch}
                    onChange={(event) => handleReuseSelectedBranchChange(event.target.checked)}
                    className="accent-primary size-4 disabled:opacity-50"
                  />
                  Reuse branch
                </label>
                <p className="text-muted-foreground pl-6 text-xs" role="status">
                  {reuseBranchHint(selectedBranchRef)}
                </p>
              </div>
            ) : null}
```

Import `reuseBranchHint` from `./CreateWorktreeDialog.logic` alongside the existing `canReuseBranch` import.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
node scripts/run-local-vp.mjs test run apps/web/src/components/CreateWorktreeDialog.dom.test.tsx apps/web/src/components/CreateWorktreeDialog.test.tsx apps/web/src/components/CreateWorktreeDialog.logic.test.ts
```

Expected: PASS. The previously passing assertion `'"main" is already checked out. A new branch ("main-2" or the next available name) will be created from it.'` still passes because the hint reproduces that copy.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/CreateWorktreeDialog.tsx apps/web/src/components/CreateWorktreeDialog.logic.ts apps/web/src/components/CreateWorktreeDialog.test.tsx
git commit -m "fix(worktrees): keep Reuse branch visible and explain when it is disabled"
```

---

### Task 2: Surface a failed branch list

**Files:**
- Modify: `apps/web/src/components/CreateWorktreeDialog.tsx` (branch list rendering near lines 640-660, where `refs` from `refsQuery.data?.refs ?? []` at line 288 is mapped)
- Test: `apps/web/src/components/CreateWorktreeDialog.test.tsx` (the test harness controls `refsQuery` through the mocked `vcsEnvironment.listRefs`; use the same mechanism the "Branch" mode tests use to supply `testState.refs`)

**Interfaces:**
- Consumes: `refsQuery.error` (the query object produced by `useEnvironmentQuery` at line 282-286, same shape `RemoteDirectoryPickerDialog.tsx:496-500` renders as `{query.error}`).
- Produces: nothing new for other tasks.

- [ ] **Step 1: Write the failing test**

Add inside the browser interactions `describe`:

```tsx
    it("explains when the branch list could not be loaded", async () => {
      testState.refsError = "Git is unavailable on this host.";
      const { container, root } = await mountDialog();

      await React.act(async () => requiredButton(container, "Branch").click());

      const alert = container.querySelector("[role='alert']");
      expect(alert?.textContent).toContain("Git is unavailable on this host.");
      expect(alert?.textContent).toContain("Branches could not be loaded");

      await React.act(async () => root.unmount());
      container.remove();
      testState.refsError = null;
    });
```

Extend the test file's `testState` with `refsError: null as string | null` and make the mocked `listRefs` query return `{ data: undefined, error: testState.refsError, isPending: false }` when `refsError` is set, following how the file already fakes the query result for `testState.refs`.

- [ ] **Step 2: Run the test to verify it fails**

```bash
node scripts/run-local-vp.mjs test run apps/web/src/components/CreateWorktreeDialog.dom.test.tsx
```

Expected: FAIL because no `[role='alert']` is rendered.

- [ ] **Step 3: Render the error**

In `CreateWorktreeDialog.tsx`, directly above the branch results list (before the `refs` map in Branch mode), add:

```tsx
            {refsQuery.error ? (
              <p role="alert" className="text-destructive text-xs">
                Branches could not be loaded. {String(refsQuery.error)} Retry after fixing Git,
                or type a branch name to create a new one.
              </p>
            ) : null}
```

If `refsQuery.error` is an `Error` instance in this hook, render `refsQuery.error.message` instead of `String(...)`; match whatever `RemoteDirectoryPickerDialog.tsx:496-500` does for the same hook.

- [ ] **Step 4: Run the test to verify it passes**

```bash
node scripts/run-local-vp.mjs test run apps/web/src/components/CreateWorktreeDialog.dom.test.tsx apps/web/src/components/CreateWorktreeDialog.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/CreateWorktreeDialog.tsx apps/web/src/components/CreateWorktreeDialog.test.tsx
git commit -m "fix(worktrees): report a failed branch list in the Create Worktree dialog"
```

---

### Task 3: Documentation, reviews, and validation

**Files:**
- Modify: `docs/user/workspace-ui.md:62-64`

- [ ] **Step 1: Update the user doc**

Replace the sentence beginning "Selecting a free local branch suggests its name and enables **Reuse branch** by default;" with:

```markdown
Selecting any branch shows **Reuse branch**. It is enabled and on by default
for a free local branch; for a remote branch or a branch already checked out
elsewhere it stays visible but disabled, with a note explaining that a new
branch will be created from it through the server's safe suffixed-branch flow.
If the branch list fails to load, the dialog says so and a typed name still
creates a new branch.
```

Keep the following sentence about edited names being preserved.

- [ ] **Step 2: Run the required reviews**

Invoke the `vercel-react-best-practices` skill against `CreateWorktreeDialog.tsx` (the change adds no hooks; `reuseBranchHint` is a pure call inside render). Review against `UI.md`: disabled state explains itself, no confirmation dialog added, copy stays under one sentence per line. Record both outcomes in the final report.

- [ ] **Step 3: Run repository gates**

```bash
node scripts/run-local-vp.mjs test run apps/web/src/components/CreateWorktreeDialog.dom.test.tsx apps/web/src/components/CreateWorktreeDialog.test.tsx apps/web/src/components/CreateWorktreeDialog.logic.test.ts
vp check
vp run typecheck
rg -n "Reuse branch" docs/testing
```

Expected: tests green, `vp check` and `typecheck` green, no runbook mentions the control (report the runbooks as reviewed and unchanged).

- [ ] **Step 4: Commit**

```bash
git add docs/user/workspace-ui.md
git commit -m "docs(worktrees): describe the always-visible Reuse branch control"
```

## Out of scope

- Full Orca parity that lets a remote branch be reused as-is (would change `resolveWorktreeCreateInput` at `CreateWorktreeDialog.logic.ts:229-238` and server behaviour).
- Orca's animated collapse presentation; the disabled control is the smaller change and satisfies `UI.md`.

## Self-review

- Spec coverage: checkbox visible for any selected branch (Task 1); explanation when disabled (Task 1); silent empty list fixed (Task 2); docs (Task 3).
- Placeholder scan: none.
- Type consistency: `reuseBranchHint(ref)` is defined in Task 1 Step 3 and used in Task 1 Step 4 with the same name; `canReuseSelectedBranch` and `selectedBranchRef` are existing identifiers.
