# 95 Percent Test Coverage Design

**Date:** 2026-07-22

## Goal

Raise repository-wide automated test coverage to at least 95% for every configured TypeScript and Rust metric while preserving the existing owned-source inventories and adding deterministic tests that verify meaningful behavior, failure handling, and operational boundaries.

## Success Criteria

The work is complete only when all of the following are true in one fresh verification run:

- TypeScript statements, branches, functions, and lines are each at least 95% under the root Vite+ V8 coverage configuration.
- Rust regions, functions, and lines are each at least 95% under the workspace `cargo llvm-cov` configuration.
- The configured thresholds in `vite.config.shared.ts` and `scripts/check-rust-coverage.ts` are 95 for every existing metric.
- The root `test:coverage` script succeeds without narrowing the source inventory or suppressing owned code.
- `vp check` and `vp run typecheck` succeed, as required by `AGENTS.md`.

Coverage percentages are repository-wide aggregate percentages. Individual files, packages, and crates are not required to reach 95%, although every owned cohort below 95% is included in the broad coverage sweep.

## Measured Baseline

The baseline was measured from commit `af21e848fa` on 2026-07-22 with the current coverage inventories. The TypeScript suite passed 6,756 tests across 501 test files.

| System | Metric | Covered / Total | Baseline | Minimum additional covered items at the current denominator |
| --- | --- | ---: | ---: | ---: |
| TypeScript | Statements | 37,709 / 40,285 | 93.60% | 562 |
| TypeScript | Branches | 26,772 / 29,738 | 90.02% | 1,480 |
| TypeScript | Functions | 9,050 / 9,843 | 91.94% | 301 |
| TypeScript | Lines | 35,378 / 37,546 | 94.22% | 291 |
| Rust | Regions | 83,953 / 93,364 | 89.92% | 4,743 |
| Rust | Functions | 5,967 / 6,721 | 88.78% | 418 |
| Rust | Lines | 62,045 / 67,391 | 92.07% | 1,977 |

Small testability refactors can change denominators, so these counts are planning guides. The acceptance criterion is the percentages reported by fresh complete coverage runs.

The initial Rust execution passed its tests but report generation required explicit `LLVM_PROFDATA` and `LLVM_COV` paths because the active Homebrew Rust sysroot did not contain those tools. This is a local toolchain concern, not a repository policy change.

## Chosen Approach

Use a broad package-by-package sweep. Coverage work is divided along repository ownership boundaries, and every cohort currently below 95% receives a measured test pass. This favors consistent coverage across the codebase over the shortest aggregate-only path.

The formal acceptance criterion remains repository-wide aggregate coverage. Package and crate results are diagnostic guides and progress indicators rather than new per-package gates.

## Architecture and Work Partition

### TypeScript cohorts

The TypeScript sweep is divided into these ownership cohorts:

1. Marketing entrypoints and configuration modules.
2. Web application pure logic, stores, routes, hooks, and components.
3. Client-runtime authorization, connections, operations, relay, RPC, and state modules.
4. Contracts fixture-export scripts and schema-adjacent tooling.
5. Shared runtime utilities.
6. Relay infrastructure, including worker and HTTP boundaries.
7. Repository scripts and build/configuration entrypoints.
8. The T4Code Oxlint plugin.

Every cohort below 95% receives focused tests. Work within a cohort proceeds from deterministic pure logic through error and state-transition paths, then reaches framework and platform adapters.

### Rust cohorts

The Rust sweep starts at the crate boundary and then follows server domains:

1. Desktop host backend, bridge, preview, configuration, SSH, updates, and window behavior.
2. Server authentication and lifecycle.
3. Persistence and state files.
4. Provider models, protocols, runtimes, and inventory.
5. Orchestration engine, effects, and RPC adapters.
6. Source control, Git, review, and process execution.
7. Terminal history, manager, PTY, and wire behavior.
8. Workspace paths, entries, search, service, watcher, and RPC behavior.
9. Diagnostics, telemetry, logging, relay, and HTTP boundaries.

Existing module tests and integration tests under `apps/server/tests` remain the preferred homes. The desktop crate uses module tests and its existing public-contract tests according to the behavior under test.

## Test Construction and Measurement

Each cohort begins with the machine-generated coverage report. Files are ranked by uncovered branches, functions, regions, and lines. Selection remains broad across the cohort, but the highest uncovered counts within that cohort are handled first.

Tests verify stable contracts rather than merely invoking code:

- Pure functions, reducers, and parsers use table-driven input/output and boundary cases.
- React components and hooks use observable rendering, accessible interaction, cleanup, and state transitions.
- Effect services use test layers, deterministic clocks, typed success and failure paths, and explicit cancellation.
- Rust services use module or integration tests with temporary directories, temporary repositories, loopback listeners, and controlled process fixtures.
- Native desktop boundaries use portable decision logic and injected platform adapters when direct execution is unsafe or unavailable.

The preferred order within every cohort is:

1. Untested or lightly tested deterministic logic.
2. Error, fallback, cancellation, timeout, retry, and cleanup behavior.
3. State-machine and concurrency transitions.
4. Component, service, and adapter workflows.
5. Narrow testability extractions where a platform boundary otherwise prevents reliable testing.

After each cohort:

1. Run its focused tests.
2. Run the complete relevant language coverage suite.
3. Record aggregate and cohort-level deltas against the prior report.
4. Remove or revise tests that lack meaningful assertions or introduce nondeterminism.

Coverage reports remain local build artifacts and are not committed.

## Testability Changes

Production changes are limited to maintainable seams needed for deterministic testing. Acceptable changes include:

- extracting a pure decision function from a component or native adapter;
- injecting a clock, process runner, filesystem operation, HTTP transport, or platform fact;
- splitting an oversized module along an existing responsibility boundary; and
- replacing implicit global state with an explicit existing service interface.

Every production change begins with a failing behavior assertion and follows a red-green-refactor cycle. Test-only production methods, conditional behavior compiled only for tests, generated no-op calls, coverage ignore pragmas, and assertions against incidental mock call trivia are prohibited.

No production behavior is intentionally changed. If a coverage test exposes a defect, the defect is fixed in its own failing-test-first change and documented in the implementation work.

## Reliability and Failure Handling

New tests must be deterministic and isolated under load and on retries. They may not depend on:

- live provider CLIs or public services;
- user credentials, user Git configuration, or an existing keychain;
- fixed ports, execution order, or existing machine state;
- real updater endpoints, SSH hosts, or GitHub services; or
- unbounded sleeps, polling, or unresolved background tasks.

Asynchronous tests use fake time, bounded deadlines, scripted peers, or explicit cancellation. Filesystem and Git tests create temporary resources and clean them up even after failure. Loopback network tests bind ephemeral ports. Tests that leave warnings, leaked tasks, unhandled rejections, orphan processes, or nondeterministic timing are not accepted.

Platform-specific behavior is tested through existing abstractions or narrowly extracted seams. Unsupported host paths are not hidden with new exclusions. Where a path is genuinely non-executable on the current host, the implementation must test the portable decision contract and preserve the platform-specific inventory.

## Coverage Policy

The existing inventories remain authoritative:

- TypeScript continues using `coverageInclude`, `coverageExclude`, and the policy tests in `scripts/coverage-config.test.ts`.
- Rust continues covering the entire Cargo workspace with all targets and build scripts.

The implementation must not add source exclusions, ignore pragmas, duplicate trivial files, generated assertions, or test-only branches to manufacture the target percentage.

Thresholds remain at 90 during the coverage cohorts. Only after a clean TypeScript report and a clean Rust report each meet or exceed 95% in every configured metric are the gates and policy tests raised from 90 to 95.

## Verification

Focused commands are selected for each cohort. Final verification uses the repository commands exactly:

```bash
vp run test:coverage
vp check
vp run typecheck
```

The completion audit reads the final TypeScript summary and Rust `TOTAL` row and confirms that every metric is at least 95%. It also confirms:

- every configured threshold is exactly 95;
- TypeScript coverage includes and excludes were not narrowed;
- the Rust workspace scope was not narrowed;
- generated coverage and instrumentation artifacts are uncommitted; and
- each package or crate cohort below 95% at baseline received a measured test pass.

## Out of Scope

- Requiring every individual source file, package, or crate to reach 95%.
- Replacing Vite+ or `cargo llvm-cov` with another coverage system.
- Adding browser end-to-end infrastructure solely for this goal.
- Excluding owned source or counting generated code to manipulate the aggregate.
- Unrelated feature work or broad architectural rewrites that do not directly support deterministic coverage.
