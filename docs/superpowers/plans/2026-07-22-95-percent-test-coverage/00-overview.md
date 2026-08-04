# 95 Percent Test Coverage Program Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Raise repository-wide TypeScript and Rust test coverage to at least 95% in every configured metric without narrowing either owned-source inventory.

**Architecture:** Execute four independently reviewable coverage projects: TypeScript, Rust desktop, Rust server, and the final policy gate. Each project works from a fresh machine-readable coverage report, closes deterministic behavioral gaps in ranked cohorts, and commits only after focused tests and its full-language coverage checkpoint pass.

**Tech Stack:** Vite+, Vitest, V8 coverage, React Testing Library, Effect 4, Rust, Cargo, Tokio, Tauri, `cargo-llvm-cov`.

## Global Constraints

- Acceptance is repository-wide aggregate coverage, not per-file, per-package, or per-crate coverage.
- TypeScript statements, branches, functions, and lines must each be at least 95%.
- Rust regions, functions, and lines must each be at least 95%.
- Preserve the existing `coverageInclude`, `coverageExclude`, and Cargo workspace inventories.
- Do not add source exclusions, coverage-ignore pragmas, test-only production paths, generated no-op calls, duplicate trivial files, or invocation-only tests.
- Tests must assert stable behavior, errors, cleanup, or state transitions. Mock only actual I/O and platform boundaries.
- Do not use live public services, provider CLIs, user credentials, user Git configuration, existing keychains, fixed ports, or unbounded sleeps.
- Keep `packages/contracts` schema-only and do not import application runtime logic into it.
- Before writing or changing Effect code, read `.repos/effect-smol/LLMS.md` and follow the repository's vendored Effect examples.
- Keep the coverage thresholds at 90 until fresh TypeScript and Rust reports both prove every metric is at least 95%.
- `vp run test:coverage`, `vp check`, and `vp run typecheck` must pass before completion.
- Never commit `coverage/`, `target/llvm-cov*`, `.profraw`, or other generated coverage artifacts.

---

## Program Baseline

The baseline was captured from commit `af21e848fa` on 2026-07-22 with the unchanged inventories.

| System | Metric | Covered / Total | Baseline | Additional covered items needed at the current denominator |
| --- | --- | ---: | ---: | ---: |
| TypeScript | Statements | 37,709 / 40,285 | 93.60% | 562 |
| TypeScript | Branches | 26,772 / 29,738 | 90.02% | 1,480 |
| TypeScript | Functions | 9,050 / 9,843 | 91.94% | 301 |
| TypeScript | Lines | 35,378 / 37,546 | 94.22% | 291 |
| Rust | Regions | 83,953 / 93,364 | 89.92% | 4,743 |
| Rust | Functions | 5,967 / 6,721 | 88.78% | 418 |
| Rust | Lines | 62,045 / 67,391 | 92.07% | 1,977 |

Denominators can move when a legitimate testability refactor is introduced. The percentages from a fresh complete run, rather than these raw deltas, decide acceptance.

## Plan Set and Dependency Order

1. [`01-typescript-coverage.md`](./01-typescript-coverage.md) covers marketing/configuration, web, client runtime, contracts tooling, relay infrastructure, shared utilities, repository scripts, and the Oxlint plugin. It ends only when all four TypeScript metrics are at least 95%.
2. [`02-rust-desktop-coverage.md`](./02-rust-desktop-coverage.md) covers the Tauri desktop host and records its contribution to the Rust aggregate.
3. [`03-rust-server-coverage.md`](./03-rust-server-coverage.md) covers server domains and ends only when all three workspace Rust metrics are at least 95%.
4. [`04-policy-and-verification.md`](./04-policy-and-verification.md) changes the gates from 90 to 95 test-first, runs the repository-wide coverage command, and performs the required quality checks.

The TypeScript plan can run independently of both Rust plans. The Rust desktop and Rust server plans share one workspace coverage denominator, so execute them sequentially or rebase one cohort's measurements before accepting the other. The policy plan depends on all three coverage plans.

### Task 1: Capture a Reproducible Starting Point

**Files:**

- Read: `vite.config.shared.ts`
- Read: `scripts/check-rust-coverage.ts`
- Read: `scripts/coverage-config.test.ts`
- Generate locally: `coverage/coverage-final.json`
- Generate locally: `coverage/coverage-summary.json`
- Generate locally: `target/llvm-cov-report.json`

**Interfaces:**

- Consumes: the current Vite+ coverage inventory and complete Cargo workspace.
- Produces: fresh machine-readable reports used by every cohort in this plan set.

- [ ] **Step 1: Confirm the worktree is clean apart from intentional plan files**

```bash
git status --short
```

Expected: no unrecognized source changes. Do not delete or overwrite user-owned changes if the worktree is not clean.

- [ ] **Step 2: Run the complete TypeScript suite and write both report formats**

```bash
vp test --coverage --coverage.reporter=json --coverage.reporter=json-summary --coverage.reporter=text
```

Expected: 501 test files and 6,756 tests pass at the baseline revision; `coverage/coverage-final.json` and `coverage/coverage-summary.json` exist.

- [ ] **Step 3: Resolve the Rust LLVM tools without changing repository configuration**

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

Expected: both executable checks succeed. Keep these exports in the execution shell for every direct `cargo llvm-cov` command.

- [ ] **Step 4: Run the instrumented Rust workspace and write JSON**

```bash
LLVM_PROFDATA="$LLVM_PROFDATA" LLVM_COV="$LLVM_COV" cargo llvm-cov clean --workspace
LLVM_PROFDATA="$LLVM_PROFDATA" LLVM_COV="$LLVM_COV" cargo llvm-cov --workspace --all-targets --no-report --jobs 1
LLVM_PROFDATA="$LLVM_PROFDATA" LLVM_COV="$LLVM_COV" cargo llvm-cov report --json --output-path target/llvm-cov-report.json
LLVM_PROFDATA="$LLVM_PROFDATA" LLVM_COV="$LLVM_COV" cargo llvm-cov report --summary-only
```

Expected: all Rust tests pass and the summary matches the baseline within ordinary line-mapping drift.

- [ ] **Step 5: Record, but do not commit, the baseline reports**

```bash
git status --short --ignored coverage target/llvm-cov-report.json
```

Expected: reports appear only as ignored local artifacts.

## Cohort Measurement Contract

Every task in the language plans uses the following loop. A cohort is not accepted merely because its focused tests pass.

1. Add one named behavior or table of related boundary cases.
2. Run the exact focused test command in that task.
3. Regenerate the complete language coverage report.
4. Confirm the cohort's uncovered branch/function/line count decreased and no global metric regressed unexpectedly.
5. Inspect warnings and cleanup behavior; fix leaked listeners, tasks, processes, timers, or resources.
6. Commit the green cohort with its before/after aggregate percentages in the commit body.

Use this exact TypeScript summary reader after a full report:

```bash
node - <<'NODE'
const summary = require("./coverage/coverage-summary.json").total;
for (const metric of ["statements", "branches", "functions", "lines"]) {
  console.log(`${metric}: ${summary[metric].covered}/${summary[metric].total} (${summary[metric].pct}%)`);
}
NODE
```

Use this exact Rust summary command after an instrumented run:

```bash
LLVM_PROFDATA="$LLVM_PROFDATA" LLVM_COV="$LLVM_COV" cargo llvm-cov report --summary-only
```

## Completion Boundary

Do not start the policy plan while any language metric is below 95.00%. Aim for at least 95.20% before raising gates so small instrumentation shifts do not make the final gate flaky. If a metric is between 95.00% and 95.19%, execute the next reserve file named in the corresponding language plan before changing policy.
