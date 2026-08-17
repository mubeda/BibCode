# Task 9J Claude Probe Cache Test Ownership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan.

**Goal:** Remove the process-wide test lock around Claude activity-probe coverage so the affected tests run concurrently without sharing mutable cache fixtures, while preserving the production cache's process-wide reuse, bounded memory, single-flight behavior, and hot-path performance.

**Architecture:** Extract the existing Claude probe cache state behind a cheap cloneable owner. Production constructors continue to clone a single process-global owner, so executable-identity caching and cross-runtime reuse do not change. A documentation-hidden integration-test context owns a fresh cache and constructs factories or direct probes bound to that cache, making reset, seeding, and inspection local to one test rather than coordinated by a global async lock.

**Tech Stack:** Rust, Tokio, std synchronization primitives, Cargo integration tests.

## Global constraints and decision record

- Keep `apps/server` as the state owner; do not introduce a dependency or protocol change.
- Do not serialize tests, widen timeouts, add scheduler sleeps, or hold a synchronous lock across an await.
- Preserve production semantics: one process-global cache, exact executable metadata/version keys, ready-entry LRU capacity 64, bounded in-flight entries, and watch-based single-flight.
- A test cache owner must be independently bounded and must become reclaimable when its test context, factories, and in-flight producers are gone.
- The deterministic regression must prove two cache owners can mutate their caches concurrently without capacity, reset, or identity interference.
- On macOS, concurrently executing several previously unseen temporary script paths is admitted serially and can consume the production two-second probe deadline. The isolated test context therefore launches Unix `.sh` fixtures as data through the stable `/bin/sh` executable. This is a fixture-launch policy only: production continues executing the resolved Claude program directly, and the deadline is not widened.
- Run affected tests in the default harness and explicitly with 8 and 12 test threads; test correctness must not depend on their scheduling order.

### Alternatives considered

1. **Make every production factory own a fresh cache.** This eliminates the global owner, but changes supported production behavior: multiple runtimes/factories would repeat executable resolution and `--version`/`--help` probes. That is an unnecessary startup and process-load regression, so it is rejected.
2. **Namespace test entries inside the process-global state.** This avoids reset collisions but retains shared capacity, eviction, mutex, in-flight bookkeeping, and namespace-cleanup coupling. It also leaves test-only identifiers in the production cache abstraction, so it is rejected.
3. **Use an explicit cache owner with a static production default and isolated test contexts.** This preserves the production topology and moves only test fixture state into the fixture that owns it. This is the selected design.

For the newly exposed cold-script admission failure, serializing tests or widening the production deadline would both hide load behavior and are rejected. A process-global mutable dispatcher would reintroduce shared fixture state. A test-context-owned launch policy using the stable platform interpreter keeps payloads and caches independent while allowing the operating system to execute one already-admitted program concurrently; this is selected for Unix integration fixtures. Windows already launches `.ps1` fixtures through the stable PowerShell program.

No living architecture document changes are expected because the production runtime topology, public protocol, and lifecycle guarantees are unchanged. The Task 9 evidence report will record the test-fixture ownership change.

## Task 1: Add a deterministic cache-owner isolation regression

**Files:**

- Modify: `apps/server/tests/production_provider_runtime.rs`

1. Add an integration test that creates multiple Claude probe test contexts and drives distinct real script probes plus cache mutation concurrently from a positive synchronization barrier.
2. Seed one owner's cache to its capacity while the other owner completes a real executable probe, then assert each owner sees only its own bounded entries and paths.
3. Import the not-yet-existing test context and run the exact test. Record the expected compile failure as RED: the server exposes no independently owned Claude probe cache fixture.

## Task 2: Introduce explicit Claude probe cache ownership

**Files:**

- Modify: `apps/server/src/production/provider_runtime.rs`

1. Wrap `ClaudeProbeCacheState` in a cloneable owner backed by `Arc<StdMutex<_>>`.
2. Replace direct access to the `OnceLock<StdMutex<_>>` with a `OnceLock` holding the production owner. Default production construction must continue cloning that single owner.
3. Pass the owner explicitly through executable resolution, cache lookup/single-flight, producer completion, and the Claude driver spawn path.
4. Add a documentation-hidden `ClaudeActivityProbeTestContext` whose fresh owner can construct a bound `NativeProviderDriverFactory`, run direct probes, and inspect or seed only its own cache.
5. Carry a test-only fixture launch policy with that context so Unix `.sh` payloads run through `/bin/sh`; keep the production launch policy direct and unchanged.
6. Keep every mutex critical section synchronous and bounded; in-flight producer tasks retain an owner clone only until completion.
7. Run the exact isolation test and the existing cache behavior tests until GREEN.

## Task 3: Remove process-global test coordination

**Files:**

- Modify: `apps/server/tests/production_provider_runtime.rs`

1. Delete `CLAUDE_ACTIVITY_PROBE_TEST_LOCK` and all twelve whole-test acquisitions.
2. Give each affected test its own `ClaudeActivityProbeTestContext`.
3. Replace global reset/seed/introspection helpers with context methods and build every affected native driver factory through the context.
4. Preserve existing behavioral assertions for caching, retries, invalidation, LRU bounds, deadlines, hook capability selection, shutdown, and transcript recovery.
5. Run the exact cache tests concurrently, then the affected test target with default, 8, and 12 test threads.

## Task 4: Validate, review, and report

**Files:**

- Modify ignored evidence only: `.superpowers/sdd/2026-08-11-parallel-rust-test-sandboxes/task-9-report.md`
- Modify ignored evidence only: `.superpowers/sdd/2026-08-11-parallel-rust-test-sandboxes/progress.md`

1. Run `cargo fmt --all --check`.
2. Run focused exact tests, all affected Claude/provider-runtime tests, and the full `production_provider_runtime` integration target with default, 8, and 12 threads.
3. Run the affected `bibcode-server` package tests as proportionate to failures and risk.
4. Run Clippy for affected server targets with warnings denied, then `vp check` and `vp run typecheck`.
5. Request an independent code review of the stable diff; resolve all Important findings and rerun affected evidence.
6. Review `git diff`, `git status --short`, and static searches proving no test lock/global reset path remains.
7. Commit only the scoped tracked implementation and plan; update the ignored Task 9 report/ledger with exact commands and residual risk.
