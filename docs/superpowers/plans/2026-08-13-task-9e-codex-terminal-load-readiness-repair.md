# Task 9E Codex Terminal Load Readiness Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:systematic-debugging before superpowers:test-driven-development.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Diagnose and repair the two Codex provider-terminal tests that fail
only in the loaded workspace graph, without widening a production deadline or
weakening process ownership evidence.

**Architecture:** Keep `run_supervised` and `CodexHelperSupervisor` as the sole
owners of their respective child lifecycles. First add or reuse fixture-owned
milestones at child spawn, request/body entry, output or readiness publication,
owner completion, and final reap to distinguish scheduler latency from a real
timeout or capacity defect. A load-only test watchdog will become one shared
absolute integration deadline over ordered positive events; a production
timeout or admission repair is permitted only after a deterministic boundary
RED proves the production owner can reject work that is already ready.

**Tech Stack:** Rust 2024, Tokio multi-thread tests, `process-wrap`, bounded
supervised output collection, fixture-owned Unix processes and sockets, Vite+
concurrent package graph.

## Global Constraints

- Baseline is clean commit `7031076a` after the reviewed Task 9D repair.
- Do not widen a production capability-probe, helper-readiness, cleanup, or
  admission deadline.
- Do not add sleeps, yields, polling loops, global locks, package
  serialization, harness-thread reduction, or unbounded helper/process work.
- Preserve cancellation precedence, byte-bounded stdout and stderr, exact PID
  ownership, process-tree termination, helper admission caps, and final reap.
- A production repair requires a deterministic RED at its exact timeout,
  readiness, or admission boundary before GREEN.
- A test-only deadline is one absolute, integration-scale watchdog shared by
  ordered owner events. Stages cannot reset or extend it.
- Run one complete graph at a time from an isolated Cargo target and stop on a
  different failure.

---

### Task 1: Reproduce and classify both loaded boundaries

**Files:**

- Inspect/Test: `apps/server/src/provider_terminal/codex.rs`
- Inspect: `apps/server/src/process/supervised.rs`
- Review: `docs/architecture/providers.md`
- Review: `docs/architecture/activity-observation.md`
- Append: `.superpowers/sdd/2026-08-11-parallel-rust-test-sandboxes/task-9-report.md`

**Interfaces:**

- Consumes: `SystemCodexCapabilityProbeRunner`, `run_supervised`,
  `SystemCodexHelperLauncher`, `CodexHelperSupervisorInitializer`, and
  `CodexHelperSupervisor`.
- Produces: a written classification naming the last positive process/fixture
  milestone and the exact timer or admission owner that returned first.

- [ ] **Step 1: Run the two exact observed failures first**

```bash
cargo test -p bibcode-server --lib provider_terminal::codex::tests::two_codex_probes_bound_both_output_streams_in_parallel -- --exact --nocapture
cargo test -p bibcode-server --lib provider_terminal::codex::tests::two_codex_helpers_publish_distinct_pids_and_reap_in_parallel -- --exact --nocapture
```

Record test and wall time. An isolated pass proves only load sensitivity.

- [ ] **Step 2: Trace capability-probe ownership**

Map executable admission and spawn, fixture body entry, first and final writes
to both streams, child exit, pipe EOF, `run_supervised` completion, and reap.
Confirm that the default three-second runner timeout is a production capability
deadline, while any wrapper added by the integration regression is test-only.
Audit the shared supervised-process admission cap at 16 and require evidence of
successful recovery if it is reached.

- [ ] **Step 3: Trace helper readiness ownership**

Map supervisor initialization, slot reservation, exact child spawn/PID,
fixture request/argument entry, socket publication, supervisor readiness
publication, returned helper ownership, terminate request, wait completion, and
reap. Audit the helper slot cap and all concurrently live helpers; distinguish
`wait_ready` failure, slot refusal, product readiness timeout, and the outer
test watchdog in diagnostics.

- [ ] **Step 4: Reproduce under bounded graph-like load**

Use the already-built server library test binary with bounded independent load,
then one isolated-target `vp run test` only after the focused reproducer. Record
positive milestones, admission counts, process counts, cleanup diagnostics,
and final survivors. Do not change a duration to obtain this classification.

- [ ] **Step 5: Rank the evidence**

Classify each failure as exactly one of:

1. product owner defect: ready work loses at a timeout boundary, admission is
   leaked/unfair, wakeup is lost, or child/reap ownership is incomplete;
2. fixture protocol defect: a required process milestone is never published or
   its owner result is hidden behind an unrelated event wait;
3. scheduler watchdog defect: all required process and ownership milestones
   complete, but a short test observation bound expires under loaded scheduling.

Stop for architecture approval if the evidence calls for changing a production
capacity or deadline policy rather than its existing boundary semantics.

### Task 2: Make capability-probe coverage event-owned under load

**Files:**

- Modify/Test: `apps/server/src/provider_terminal/codex.rs`
- Modify only if a production invariant changes:
  `docs/architecture/providers.md`

**Interfaces:**

- Preserves: the default three-second production probe timeout,
  `CODEX_PROBE_OUTPUT_LIMIT` per stream, cancellation precedence, cleanup
  timeout, and exact child reap.
- Produces: a paired regression that cannot pass without both real fixtures
  entering, publishing their complete oversized stdout and stderr payloads,
  returning from the owned supervised execution, and being reaped.

- [ ] **Step 1: Add ordered fixture milestones before changing a watchdog**

Give each sandbox independent spawn/body-entered, stdout-published,
stderr-published, and process-exited evidence. Retain one joined owner per probe
and publish owner completion only after `SystemCodexCapabilityProbeRunner::run`
returns. Every expectation reports the last reached milestone.

- [ ] **Step 2: Run the old boundary under controlled load**

Require the graph failure or controlled equivalent to show whether the
production timeout expires before fixture entry/output or after the child and
both pipe owners are already ready. If the process itself never reaches its
milestones, do not change the test watchdog.

- [ ] **Step 3: Write the evidence-authorized RED**

If already-ready work loses at the production boundary, write a deterministic
paused/gated RED for that exact owner and preserve the deadline. Otherwise,
retain the loaded-graph RED and add a deterministic milestone-owner test in
which work is delayed beyond three seconds but completes before a single
test-only absolute diagnostic deadline; the old use of the production deadline
for a load test must fail while all child lifecycle evidence remains healthy.

- [ ] **Step 4: Implement the smallest GREEN repair**

For a production boundary race, use one final non-waiting poll of the same
pinned owner after cancellation has retained precedence. For a scheduler-only
test defect, use a test-configured runner and one shared absolute integration
watchdog over the ordered events; do not change `Default`, production call
sites, or the dedicated timeout/kill/reap regression.

- [ ] **Step 5: Verify capability cleanup and bounds**

Assert both output buffers equal `CODEX_PROBE_OUTPUT_LIMIT`, observed fixture
output exceeds the limit, both owner results are joined, timeout/cancellation
still kill, and the exact PIDs no longer exist after reap.

### Task 3: Make helper startup report and retain its real owner state

**Files:**

- Modify/Test: `apps/server/src/provider_terminal/codex.rs`
- Modify only if a lifecycle invariant changes:
  `docs/architecture/activity-observation.md`

**Interfaces:**

- Preserves: `CODEX_HELPER_READY_TIMEOUT`, bounded supervisor and process
  admission, readiness-before-return, cancellation, termination, and reap.
- Produces: two concurrent helper fixtures whose exact owner results, distinct
  PIDs, request/socket readiness, termination, and reap are all observed under
  one shared absolute test deadline.

- [ ] **Step 1: Make the owner result observable alongside readiness**

Retain and join each `launcher.start` owner while waiting for fixture events.
An early `Err` must fail immediately with its exact initialization, capacity,
spawn, or readiness cause instead of letting an unrelated readiness-event
watchdog expire.

- [ ] **Step 2: Add the missing positive fixture milestones**

Prove child spawn/PID publication, fixture body/request entry, socket
publication, supervisor readiness, returned helper, termination request, and
reap completion. Use independent event generations/checkpoints for both
fixtures and one shared absolute integration deadline.

- [ ] **Step 3: Write a deterministic boundary RED if production loses ready state**

If `CodexHelperSupervisorInitializer::wait_ready` or the helper readiness loop
can time out when its watched state/socket is already ready, gate that state at
the exact timeout wake and require one final non-waiting observation. If no
production race is proven, change only the fixture-owner/watchdog protocol.

- [ ] **Step 4: Preserve capacity and no-survivor coverage**

Run the existing saturation regression and a paired live-helper regression.
Require slot recovery only after the helper's owned wait/reap completes, then
verify no exact PID survives. No event may stand in for joining the real owner.

- [ ] **Step 5: Commit scoped RED-to-GREEN changes**

Commit only the Codex provider-terminal source/test changes and any required
living-document correction. Append exact RED/GREEN evidence to the ignored
Task 9 report.

### Task 4: Verify the loaded contract and obtain independent review

**Files:**

- Review: Task 9E diff from `7031076a` through the final scoped commit.
- Append: `.superpowers/sdd/2026-08-11-parallel-rust-test-sandboxes/task-9-report.md`

**Interfaces:**

- Produces: focused, module, package, loaded-graph, resource-bound, static-gate,
  and independent-review evidence.

- [ ] **Step 1: Run exact and complete Codex module coverage**

```bash
cargo test -p bibcode-server --lib provider_terminal::codex::tests::two_codex_probes_bound_both_output_streams_in_parallel -- --exact --nocapture
cargo test -p bibcode-server --lib provider_terminal::codex::tests::two_codex_helpers_publish_distinct_pids_and_reap_in_parallel -- --exact --nocapture
cargo test -p bibcode-server --lib provider_terminal::codex::tests -- --nocapture
cargo test -p bibcode-server --lib provider_terminal::codex::tests -- --test-threads=8 --nocapture
cargo test -p bibcode-server --lib provider_terminal::codex::tests -- --test-threads=12 --nocapture
```

- [ ] **Step 2: Run the complete server library under graph-like load**

Use an isolated Cargo target and the same bounded sampler/load shape that
reproduced Task 9E. Require every server library test to pass, no admission or
cleanup warning in the scoped paths, and no surviving helper or probe PID.

- [ ] **Step 3: Run one replacement workspace graph**

```bash
vp run test
```

Run it sequentially after focused validation, with the isolated target and the
Task 9 process sampler. Stop on a different failure. Record server, desktop,
web, helper/process high-water counts, cleanup diagnostics, temporary roots,
and final survivors.

- [ ] **Step 4: Run repository gates**

```bash
cargo fmt --all --check
cargo clippy -p bibcode-server --all-targets -- -D warnings
vp check
vp run typecheck
git diff --check
git status --short
```

- [ ] **Step 5: Obtain independent read-only review**

Review for production deadline drift, timeout masking, stage-by-stage deadline
reset, hidden serialization, leaked capacity, unjoined tasks, output-bound
weakening, event-only false positives, unowned children, missing final reap,
and conclusions unsupported by the loaded graph. Address every Critical or
Important finding before Task 9 resumes.
