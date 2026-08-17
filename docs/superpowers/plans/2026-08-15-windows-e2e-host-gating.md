# Windows E2E Host Gating Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep simulated Windows fixture construction portable while executing the generated Cursor `.cmd` action shim only on native Windows.

**Architecture:** The parameterized inventory test remains host-independent and continues to verify `mac`, `linux`, and `win` environment/filesystem contracts everywhere. Automatic run-root allocation takes an injectable parent selected by the actual host, never by `BIBCODE_E2E_PLATFORM`; target simulation still owns generated paths and settings. A dedicated `it.runIf(process.platform === "win32")` test owns the real `cmd.exe` execution and action-log assertion, while an explicit Windows-only native CI step and parsed workflow contract keep that test in the supported validation path.

**Tech Stack:** TypeScript, Vite+ Test/Vitest-compatible `it.runIf`, Node.js child processes and filesystem fixtures.

## Global Constraints

- Do not change packaged desktop behavior or provider launch behavior.
- Do not emulate or install a Windows command processor on macOS or Linux.
- Do not replace the native execution assertion with a mocked `spawnSync`.
- Do not skip the portable Windows environment and filesystem assertions.
- Do not use the simulated target to choose the host filesystem's automatic run-root parent.
- Do not change CI concurrency, timeouts, platform matrices, dependencies, or lockfiles.
- Stop broad verification on the first distinct failure and diagnose that exact failure before any rerun or repair.

---

### Task 1: Separate portable fixture assertions and retain native Windows CI execution

**Files:**

- Modify: `apps/desktop/e2e/support/test-project.test.ts:173-217`
- Modify: `apps/desktop/e2e/support/test-project.ts:1085-1095`
- Modify: `scripts/ci-platform-contract.test.ts:126-162`
- Modify: `.github/workflows/ci.yml:207-216`
- Test: `apps/desktop/e2e/support/test-project.test.ts`
- Test: `scripts/ci-platform-contract.test.ts`

**Interfaces:**

- Consumes: `prepareDesktopUiTestContext(environment, hostTemporaryDirectory)`, `archiveAndCleanupDesktopUiTestContext(context)`, and actual-host temporary-directory selection.
- Produces: one host-independent allocation/inventory contract, one native-Windows-only Cursor `.cmd` execution contract, and one Windows CI workflow contract that runs it.

Final-review amendment: add a parameterized RED proving simulated `mac`,
`linux`, and `win` contexts all allocate an automatic run root beneath one
injected, test-owned host temporary parent. Then make the parent injectable and
default it from the actual host (`%TEMP%` on Windows, short `/tmp` on Unix for
the provider socket-path budget). Keep `BIBCODE_E2E_PLATFORM` responsible only
for generated target paths, settings, shims, and environment presentation.

- [ ] **Step 1: Preserve the observed RED evidence**

Run on macOS:

```bash
vp test run apps/desktop/e2e/support/test-project.test.ts \
  -t "isolates provider user inventory inside the disposable run root"
```

Expected RED on the pre-fix revision: the simulated `win` case calls
`C:\Windows\System32\cmd.exe`, fails with `spawnSync ... ENOENT`, and reports
one failed test. This RED was observed at pulled HEAD `4972a0dc`.

- [ ] **Step 2: Keep the parameterized test portable**

In `isolates provider user inventory inside the disposable run root`, retain
the Windows `USERPROFILE`, `HOME`, `APPDATA`, `LOCALAPPDATA`,
`PSModuleAnalysisCachePath`, and directory assertions. Remove only the block
that constructs `editorShimPath`, invokes `NodeChildProcess.spawnSync`, and
reads `nativeActionLogPath`.

The Windows branch must end after these portable assertions:

```ts
expect(environment.USERPROFILE).toBe(expectedFixtureUserHome);
expect(environment.HOME).toBe(expectedFixtureUserHome);
expect(environment.APPDATA).toBe(expectedAppData);
expect(environment.LOCALAPPDATA).toBe(expectedLocalAppData);
expect(environment.PSModuleAnalysisCachePath).toBe(expectedPowerShellModuleCache);
expect(NodeFS.statSync(expectedAppData).isDirectory()).toBe(true);
expect(NodeFS.statSync(expectedLocalAppData).isDirectory()).toBe(true);
expect(NodeFS.statSync(NodePath.dirname(expectedPowerShellModuleCache)).isDirectory()).toBe(true);
```

- [ ] **Step 3: Add the native Windows action-shim test**

Immediately after the parameterized `describe.each` block, add:

```ts
it.runIf(process.platform === "win32")(
  "executes the Cursor action shim through the native Windows command processor",
  () => {
    const environment: NodeJS.ProcessEnv = { BIBCODE_E2E_PLATFORM: "win" };
    const context = prepareDesktopUiTestContext(environment);
    contexts.push(context);
    const editorShimPath = NodePath.join(context.shimDirectory, "cursor.cmd");
    const editorTarget = String.raw`C:\fixture\userdata\logs`;
    const editorLaunch = NodeChildProcess.spawnSync(
      process.env.ComSpec ?? "cmd.exe",
      ["/d", "/c", `${editorShimPath} ${editorTarget}`],
      {
        env: { ...process.env, ...environment },
        encoding: "utf8",
        shell: false,
      },
    );

    expect(editorLaunch.error).toBeUndefined();
    expect(editorLaunch.status, editorLaunch.stderr).toBe(0);
    expect(JSON.parse(NodeFS.readFileSync(context.nativeActionLogPath, "utf8").trim())).toEqual({
      action: "openInEditor",
      args: [editorTarget],
    });
  },
);
```

This is real native execution on Windows and an explicit skip on macOS/Linux.

- [ ] **Step 4: Run the exact test file to verify GREEN**

Run:

```bash
vp test run apps/desktop/e2e/support/test-project.test.ts
```

Expected on macOS/Linux: every portable test passes and the dedicated native
Windows test is skipped. Expected on Windows: every test passes, including the
real `.cmd` execution and exact action-log assertion.

- [ ] **Step 5: Write and verify the failing Windows CI contract**

In `scripts/ci-platform-contract.test.ts`, add this test inside
`describe("cross-platform CI contract", ...)`:

```ts
it("runs the native desktop E2E support contracts on Windows", () => {
  const { workflow } = readWorkflow(CI_WORKFLOW_PATH);
  const nativeSteps = requireJob(workflow, "native_desktop").steps ?? [];
  const windowsE2eStep = nativeSteps.find(
    (step) => step.name === "Test Windows desktop E2E support contracts",
  );

  expect(windowsE2eStep?.if).toBe("matrix.platform == 'win'");
  expect(windowsE2eStep?.run).toBe(
    "vp test run apps/desktop/e2e/support/test-project.test.ts",
  );
});
```

Run:

```bash
vp test run scripts/ci-platform-contract.test.ts \
  -t "runs the native desktop E2E support contracts on Windows"
```

Expected RED before the workflow edit: `windowsE2eStep` is absent, so the
condition assertion receives `undefined`.

- [ ] **Step 6: Add the native Windows CI step**

In `.github/workflows/ci.yml`, immediately after `Test desktop Rust host`, add:

```yaml
      - name: Test Windows desktop E2E support contracts
        if: matrix.platform == 'win'
        run: vp test run apps/desktop/e2e/support/test-project.test.ts
```

This does not change the platform matrix or concurrency. Linux and macOS skip
the step; Windows runs the real `.cmd` assertion after the frozen dependency
install.

- [ ] **Step 7: Run the exact fixture and CI contracts to verify GREEN**

Run:

```bash
vp test run \
  apps/desktop/e2e/support/test-project.test.ts \
  scripts/ci-platform-contract.test.ts
```

Expected on macOS/Linux: portable fixture tests and the CI contract pass; the
native Windows action-shim test is skipped. Expected on Windows: all tests pass,
including the real `.cmd` execution.

- [ ] **Step 8: Run the changed desktop/script focused matrix**

Run:

```bash
vp test run \
  apps/desktop/e2e/support/activity-session.test.ts \
  apps/desktop/e2e/support/app-lifecycle.test.ts \
  apps/desktop/e2e/support/build-packaged-app.test.ts \
  apps/desktop/e2e/support/test-project.test.ts \
  apps/desktop/e2e/support/ui-state.test.ts \
  apps/desktop/e2e/support/window-size.test.ts \
  scripts/coverage-config.test.ts \
  scripts/ci-platform-contract.test.ts \
  scripts/run-tauri-build.test.mjs \
  scripts/tauri-hardening.test.ts \
  scripts/toolchain-contract.test.ts
```

Expected: all enabled tests pass; only the native Windows action-shim test is
skipped on a non-Windows host.

- [ ] **Step 9: Commit the test-boundary and CI repair**

```bash
git add apps/desktop/e2e/support/test-project.test.ts \
  scripts/ci-platform-contract.test.ts .github/workflows/ci.yml
git commit -m "test(desktop): gate Windows action shim natively"
```

---

### Task 2: Verify the complete pulled revision plus repair

**Files:**

- Review: `apps/desktop/e2e/support/test-project.test.ts`
- Review: `scripts/ci-platform-contract.test.ts`
- Review: `.github/workflows/ci.yml`
- Review: `docs/superpowers/specs/2026-08-15-windows-e2e-host-gating-design.md`
- Review: `docs/superpowers/plans/2026-08-15-windows-e2e-host-gating.md`

**Interfaces:**

- Consumes: Task 1's host-independent and native-Windows test split.
- Produces: fresh package, workspace, Rust, and static verification evidence for the current branch.

- [ ] **Step 1: Run the workspace package graph**

Run as the only broad test owner:

```bash
vp run test
```

Expected: every package test task passes. If a different failure appears, stop
without a blind broad rerun and diagnose the smallest exact owner.

- [ ] **Step 2: Run the complete Rust workspace**

After the package graph exits, run:

```bash
cargo test --workspace -j 2
```

Expected: all Rust library, integration, binary, and doc tests pass.

- [ ] **Step 3: Run formatting and static gates sequentially**

Run:

```bash
vp check
vp run typecheck
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
```

Expected: every command exits zero. Report existing nonfatal diagnostics
separately; do not classify them as passes for a command that failed.

- [ ] **Step 4: Audit the final branch**

Run:

```bash
git diff --check
git status --short
git log --oneline -10
```

Confirm the repair changes only the test boundary, parsed CI contract, one
Windows-only native CI step, and planning artifacts; no generated files or
debug output are tracked, and the branch contains no uncommitted changes.

- [ ] **Step 5: Report native evidence accurately**

Report the exact focused and broad command outcomes. On macOS/Linux, classify
the Windows `.cmd` execution as unavailable native evidence while reporting
the simulated Windows environment/filesystem checks as compatibility evidence.
Do not claim the `.cmd` assertion passed without a native Windows run or CI
result that executed it.
