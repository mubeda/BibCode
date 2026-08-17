# Task 9 Provider-Process Load Deadline Repair Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:systematic-debugging before superpowers:test-driven-development.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Classify and repair the three provider-process deadline failures that
appear only while the server and desktop package tests run concurrently.

**Architecture:** Keep the server as the sole owner of provider subprocesses and
the shared supervised pipe collector. First distinguish process lifecycle or
capacity failure from host scheduler delay with positive fixture-owned events.
If the production owner is sound, make load-sensitive tests wait for positive
process milestones under one test-only outer failure bound while retaining the
unchanged production probe/start deadlines and all kill/reap/output assertions.

**Tech Stack:** Rust 2024, Tokio multi-thread tests, process-wrap, supervised
process trees, Vite+ concurrent package graph.

## Global Constraints

- Baseline is clean commit `8918ae20`.
- Do not widen a production provider deadline.
- Do not add sleeps, yields, global locks, package serialization, harness-thread
  reduction, or weaker assertions.
- Preserve bounded stdout/stderr collection, finite process admission,
  cancellation, ownership-unit termination, direct-root fallback, and reap.
- The desktop package remains an independent concurrent load owner; do not edit
  it unless positive evidence places the defect there.
- A source repair requires a deterministic RED at the owning seam before GREEN.
- Run only the three exact tests matching the observed Task 9 failures before a
  controlled paired-load reproducer.

---

### Task 1: Reproduce and locate the expiring boundary

**Files:**

- Inspect: `apps/server/src/production/provider_runtime.rs`
- Inspect: `apps/server/src/provider_terminal/claude.rs`
- Inspect: `apps/server/src/provider_terminal/codex.rs`
- Inspect: `apps/server/src/process/supervised.rs`
- Inspect: `apps/server/src/process/background.rs`
- Review: `.superpowers/sdd/2026-08-11-parallel-rust-test-sandboxes/task-9-report.md`

**Interfaces:**

- Consumes: `NativeProviderDriverFactory`,
  `SystemClaudeCapabilityProbeRunner`,
  `SystemCodexCapabilityProbeRunner`, and `run_supervised`.
- Produces: a written classification naming the exact owner and milestone that
  failed to complete before the observed deadline.

- [ ] **Step 1: Run only the three observed exact tests once**

```bash
cargo test -p bibcode-server --lib production::provider_runtime::tests::native_process_adapters_cover_live_codex_claude_cursor_and_grok_commands -- --exact --nocapture
cargo test -p bibcode-server --lib provider_terminal::claude::tests::two_claude_probes_bound_both_output_streams_in_parallel -- --exact --nocapture
cargo test -p bibcode-server --lib provider_terminal::codex::tests::two_codex_probes_bound_both_output_streams_in_parallel -- --exact --nocapture
```

Record elapsed wall time and all cleanup diagnostics. An isolated pass is only
evidence that the failure is load-sensitive.

- [ ] **Step 2: Separate build contention from runtime contention**

Prebuild both package test binaries, then run the server library with the
desktop library test binary as an already-built concurrent load owner. Repeat
with compile/link load but no desktop tests. Record CPU pressure, runnable
processes, the failing milestone, and whether any supervised child is admitted,
spawned, producing stdout/stderr, exited, killed, or reaped.

- [ ] **Step 3: Add test-owned diagnostic milestones only if output is ambiguous**

Use `FixtureEvent` or test-only channels at the real spawn, first pipe byte,
child exit, cleanup request, and reap boundaries. Do not change any duration or
production branch. Remove diagnostics that do not become an enduring assertion.

- [ ] **Step 4: Classify before repair**

- Production defect: lost ownership, pipe collection deadlock, unbounded or
  unfair capacity, cleanup retention, or a provider process that misses its
  actual product deadline after positive CPU admission.
- Fixture defect: readiness/output generation depends on ambient process state
  or has no positive milestone owner.
- Scheduler watchdog defect: the product operation completes correctly after
  the test task was not scheduled inside its short wall-clock observation
  window, with no capacity, ownership, pipe, or cleanup failure.

Stop as `NEEDS_CONTEXT` if the repair changes production capacity, ownership,
or deadline policy beyond the existing approved architecture.

### Task 2: Write the owner-level RED and make the smallest repair

**Files:**

- Modify/Test only the owner proven by Task 1.
- Update living provider/process documentation only if a lifecycle or capacity
  invariant changes.

**Interfaces:**

- Preserves: `run_supervised` cancellation/timeout cleanup, stream byte caps,
  production provider probe deadlines, and package concurrency.
- Produces: deterministic positive-milestone coverage for the failed
  interleaving.

- [ ] **Step 1: Write and run one deterministic RED**

For a production or fixture defect, control the exact owner interleaving with
barriers/channels. For a scheduler-watchdog defect, hold the test task behind a
positive fixture event while the owned subprocess completes, then prove the old
short outer observation deadline expires even though the process lifecycle is
healthy. Name the production change that would make the RED pass before writing
it.

- [ ] **Step 2: Implement one minimal GREEN repair**

Repair the named owner. If Task 1 proves only a scheduler-watchdog defect, retain
every production deadline and replace the affected test's short scheduler
observation timeout with positive `FixtureEvent` gates plus one test-only outer
failure bound large enough to diagnose a genuinely stalled owner. The outer
bound must not substitute for the probe's internal timeout assertion.

- [ ] **Step 3: Preserve lifecycle assertions**

Exercise and assert process admission, distinct child ownership, both bounded
output streams, timeout/cancellation kill, and final reap. No test may pass only
because a timed-out child was abandoned.

- [ ] **Step 4: Commit the scoped RED-to-GREEN repair**

Commit only the owner-level source/test/doc changes and append exact RED/GREEN
evidence to the Task 9 report.

### Task 3: Verify the concurrent contract and review

**Files:**

- Review all Task 9B changes.
- Append: `.superpowers/sdd/2026-08-11-parallel-rust-test-sandboxes/task-9-report.md`

**Interfaces:**

- Produces: package-level concurrency evidence and a read-only review verdict.

- [ ] **Step 1: Run focused suites at three harness widths**

Run the three exact tests and complete affected provider modules at default,
`--test-threads=8`, and `--test-threads=12`.

- [ ] **Step 2: Run the server package alone**

```bash
vp run --filter bibcode test
```

- [ ] **Step 3: Run the prescribed concurrent package envelope**

```bash
vp run --filter bibcode test & server_pid=$!
vp run --filter @bibcode/desktop test & desktop_pid=$!
wait "$server_pid"
wait "$desktop_pid"
```

Both package commands must exit zero. Record cleanup warnings and final child
survivors; zero survivors does not waive an incomplete-cleanup warning.

- [ ] **Step 4: Run static and Rust gates**

```bash
vp check
vp run typecheck
cargo fmt --all --check
cargo clippy -p bibcode-server --all-targets -- -D warnings
git diff --check
git status --short
```

- [ ] **Step 5: Obtain independent read-only review**

Review the scoped diff for production deadline drift, hidden serialization,
unowned children, pipe backpressure, retained permits, and tests that can pass
without positive completion/reap evidence. Address every Critical or Important
finding before resuming Task 9.
