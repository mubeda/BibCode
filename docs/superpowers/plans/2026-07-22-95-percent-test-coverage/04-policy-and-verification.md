# 95 Percent Coverage Policy and Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Raise both configured coverage gates from 90 to 95 after measured reports prove the target, then pass the repository-wide coverage, check, and typecheck commands.

**Architecture:** Change the policy tests first so they fail against the old gates, minimally update the TypeScript and Rust runner thresholds, then verify one clean combined run with the unchanged inventories. Finish with repository quality checks and an artifact/status audit.

**Tech Stack:** Vite+, Vitest, V8 coverage, TypeScript, `cargo-llvm-cov`, Cargo, Vite+ repository checks.

## Global Constraints

- Start this plan only after TypeScript statements, branches, functions, and lines and Rust regions, functions, and lines are each at least 95.20% in fresh full-language reports.
- Configure exactly 95 for every existing coverage metric; do not add per-file, per-package, or per-crate gates.
- Do not modify TypeScript includes/excludes, Rust workspace/all-targets scope, build-script inclusion, single-job setting, or Windows MSVC wrapper behavior.
- The root `test:coverage` script remains `vp run test:coverage:ts && vp run test:coverage:rust`.
- `vp run test:coverage`, `vp check`, and `vp run typecheck` must all pass in the final source state.
- Do not commit coverage reports, LLVM profiles, caches, or build output.

---

### Task 1: Raise Coverage Policy Test-First

**Files:**

- Modify: `scripts/coverage-config.test.ts`
- Modify: `scripts/check-rust-coverage.test.ts`
- Modify after the red test: `vite.config.shared.ts`
- Modify after the red test: `scripts/check-rust-coverage.ts`

**Interfaces:**

- Consumes: `coverage.thresholds`, `buildRustCoverageCommand()`, and the existing Windows/non-Windows command projections.
- Produces: exact aggregate 95% V8 and `cargo-llvm-cov` gates with unchanged scope and ordering.

- [ ] **Step 1: Change only the TypeScript policy expectation to 95**

Replace the threshold test with:

```ts
it("enforces 95% thresholds for every primary TypeScript metric", async () => {
  const viteModule = await loadRootViteModule();
  const thresholds = viteModule.default.test?.coverage?.thresholds;

  expect(thresholds).toMatchObject({
    lines: 95,
    statements: 95,
    functions: 95,
    branches: 95,
  });
});
```

- [ ] **Step 2: Change both Rust command expectations to 95**

In the non-Windows and Windows expected arrays, replace each threshold pair with this exact ordered tail:

```ts
"--fail-under-lines",
"95",
"--fail-under-functions",
"95",
"--fail-under-regions",
"95",
"--jobs",
"1",
```

- [ ] **Step 3: Run policy tests and verify the red state**

Run: `vp test scripts/coverage-config.test.ts scripts/check-rust-coverage.test.ts`

Expected: failures show actual threshold values `90` where tests expect `95`; inventory and command-scope assertions continue to pass.

- [ ] **Step 4: Raise the TypeScript configuration minimally**

Change only the threshold object in `vite.config.shared.ts`:

```ts
thresholds: {
  lines: 95,
  statements: 95,
  functions: 95,
  branches: 95,
},
```

- [ ] **Step 5: Raise the Rust command minimally**

Change only these values in `scripts/check-rust-coverage.ts`:

```ts
"--fail-under-lines",
"95",
"--fail-under-functions",
"95",
"--fail-under-regions",
"95",
```

- [ ] **Step 6: Run policy tests and verify green**

Run: `vp test scripts/coverage-config.test.ts scripts/check-rust-coverage.test.ts`

Expected: both files pass, including full inventory, root script, Windows wrapper, process-status, and spawn-error assertions.

- [ ] **Step 7: Review the policy diff for prohibited scope changes**

```bash
git diff -- vite.config.shared.ts scripts/check-rust-coverage.ts scripts/coverage-config.test.ts scripts/check-rust-coverage.test.ts
```

Expected: seven production threshold values and ten mirrored test-expectation values change from `90` to `95`, plus the TypeScript test title; no include, exclude, argument ordering, workspace, target, build-script, jobs, or script changes.

- [ ] **Step 8: Commit the policy gate**

```bash
git add vite.config.shared.ts scripts/check-rust-coverage.ts scripts/coverage-config.test.ts scripts/check-rust-coverage.test.ts
git commit -m "test: enforce 95 percent coverage"
```

### Task 2: Run the Combined Repository Coverage Gate

**Files:**

- Generate locally: `coverage/**`
- Generate locally: `target/llvm-cov-target/**`
- Read: final TypeScript text summary.
- Read: final Rust `TOTAL` summary row.

**Interfaces:**

- Consumes: root `test:coverage` script and the newly configured 95% gates.
- Produces: one passing command proving both language aggregates meet policy in the same source state.

- [ ] **Step 1: Resolve LLVM tools for the active Rust toolchain**

```bash
rustup component add llvm-tools
RUSTUP_TOOLCHAIN_NAME="$(rustup show active-toolchain | awk '{print $1}')"
RUSTUP_TOOLCHAIN_ROOT="$(rustup run "$RUSTUP_TOOLCHAIN_NAME" rustc --print sysroot)"
RUSTUP_TOOLCHAIN_HOST="$(rustup run "$RUSTUP_TOOLCHAIN_NAME" rustc -vV | sed -n 's/^host: //p')"
export LLVM_PROFDATA="$RUSTUP_TOOLCHAIN_ROOT/lib/rustlib/$RUSTUP_TOOLCHAIN_HOST/bin/llvm-profdata"
export LLVM_COV="$RUSTUP_TOOLCHAIN_ROOT/lib/rustlib/$RUSTUP_TOOLCHAIN_HOST/bin/llvm-cov"
test -x "$LLVM_PROFDATA"
test -x "$LLVM_COV"
```

Expected: both executable checks pass. These environment variables are inherited by the Vite+ script and `cargo llvm-cov` child.

- [ ] **Step 2: Run the exact repository coverage command**

Run: `LLVM_PROFDATA="$LLVM_PROFDATA" LLVM_COV="$LLVM_COV" vp run test:coverage`

Expected: the full TypeScript suite passes its 95% statements/branches/functions/lines gates, then the full Rust workspace passes its 95% lines/functions/regions gates.

- [ ] **Step 3: Preserve exact completion evidence**

Record in the implementation handoff:

- TypeScript covered/total and percentage for statements, branches, functions, and lines.
- Rust covered/total and percentage for regions, functions, and lines.
- Total TypeScript test files/tests and Rust tests executed.

Do not claim success from focused runs or a prior report.

### Task 3: Run Required Quality Gates and Audit the Result

**Files:**

- Verify: all modified source and test files.
- Verify ignored only: `coverage/**`, `target/llvm-cov*`, `.profraw` files.

**Interfaces:**

- Consumes: final coverage-green source state.
- Produces: repository checks, typecheck, formatting hygiene, clean tracked status, and a concise completion record.

- [ ] **Step 1: Run the required repository check**

Run: `vp check`

Expected: formatting, linting, tests/checks wired into `vp check`, and repository policy all pass with no warnings promoted to failures.

- [ ] **Step 2: Run the required typecheck**

Run: `vp run typecheck`

Expected: all workspace TypeScript projects pass. This explicit command is required even if another command already performed a typecheck.

- [ ] **Step 3: Run Rust tests without instrumentation**

Run: `cargo test --workspace --all-targets`

Expected: all tests pass in the ordinary developer test mode as well as under coverage instrumentation.

- [ ] **Step 4: Check whitespace and tracked artifacts**

```bash
git diff --check
git status --short
git status --short --ignored coverage target | sed -n '1,120p'
```

Expected: `git diff --check` is silent; tracked status contains only intentional source/test/plan changes or is clean after commits; coverage output appears only as ignored.

- [ ] **Step 5: Re-run the focused policy tests after all formatting**

Run: `vp test scripts/coverage-config.test.ts scripts/check-rust-coverage.test.ts`

Expected: both policy files remain green and confirm inventories and thresholds.

- [ ] **Step 6: Inspect the final commit range**

```bash
git log --oneline --decorate -20
git diff --stat af21e848fa..HEAD
git diff af21e848fa..HEAD -- vite.config.shared.ts scripts/check-rust-coverage.ts
```

Expected: commits are organized by green coverage cohort; the configuration diff changes thresholds only.

### Task 4: Final Completion Record

**Files:**

- Read: `docs/superpowers/specs/2026-07-22-95-percent-test-coverage-design.md`
- Read: this plan set.

**Interfaces:**

- Consumes: output from Tasks 1-3.
- Produces: final user handoff with measured evidence and no unsupported completion claims.

- [ ] **Step 1: Verify every success criterion explicitly**

Check all seven metrics, all seven configured thresholds, unchanged inventories, passing combined coverage, passing `vp check`, passing `vp run typecheck`, and ignored generated artifacts.

- [ ] **Step 2: Report the result concisely**

The completion message must include:

```text
TypeScript: statements __%, branches __%, functions __%, lines __%.
Rust: regions __%, functions __%, lines __%.
Verification: vp run test:coverage; vp check; vp run typecheck; cargo test --workspace --all-targets.
Policy: aggregate thresholds are 95; source inventories are unchanged.
```

Replace each blank with the exact final percentage from the same-source-state verification run. Do not round values below 95 upward and do not describe the work as complete if any command failed.
