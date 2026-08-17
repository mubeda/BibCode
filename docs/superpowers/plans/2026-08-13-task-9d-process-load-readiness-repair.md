# Task 9D Process-Load Readiness Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:systematic-debugging before superpowers:test-driven-development.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair the two server-library failures exposed by the first complete
parallel workspace graph without widening production deadlines or hiding load.

**Architecture:** Preserve `run_supervised` as the sole subprocess lifecycle
owner and distinguish an execution future that is actually ready from a child
that was reaped outside that future. Give the timeout boundary one non-waiting
poll of the already-pinned execution and make the regression positively drive
that exact future to readiness before the simultaneous timeout wake. Separately,
prove each live provider fixture protocol milestone through fixture-owned events;
if the Codex two-second wrapper is only a test-task scheduling watchdog, retain
all product/protocol assertions under one load-appropriate test-only failure
bound.

**Tech Stack:** Rust 2024, Tokio multi-thread and paused-time tests,
`process-wrap`, native provider fixture processes, Vite+ concurrent package
graph.

## Global Constraints

- Baseline is clean tracked commit `e6bf7162`.
- Do not widen a production provider, process, cleanup, or protocol deadline.
- Do not add sleeps, yields, polling loops, global locks, package serialization,
  harness-thread reduction, or biased selection that weakens cancellation
  precedence.
- Preserve bounded stdout/stderr collection, finite process admission,
  cancellation, process-tree termination, direct-root fallback, and final reap.
- Test bounds diagnose an owner that never publishes its positive milestone;
  they are test-only outer watchdogs and do not define or replace a production
  provider latency/deadline contract.
- Each deterministic source repair requires a RED at the owning seam before
  GREEN. A fixture-only watchdog repair requires retained graph-failure evidence,
  positive fixture/protocol events, and unchanged protocol-result assertions.
- Run one complete graph at a time. Do not create unbounded child processes or
  helper tasks; retain the Task 9 run-one high-water baseline of 79 descendants,
  47 Rust-test-owned child/helpers, and 2 top-level Rust test binaries.

---

### Task 1: Classify execution readiness and provider progress

**Files:**

- Inspect: `apps/server/src/process/supervised.rs`
- Inspect: `apps/server/src/production/provider_runtime.rs`
- Inspect: `apps/server/src/provider_terminal/codex.rs`
- Inspect: `apps/server/src/provider_terminal/claude.rs`
- Append: `.superpowers/sdd/2026-08-11-parallel-rust-test-sandboxes/task-9-report.md`

**Interfaces:**

- Consumes: `execute_child`, the pinned stdin/wait/stdout/stderr execution
  future, `NativeProviderDriverFactory`, and native fixture protocols.
- Produces: a written classification that names the exact future or protocol
  milestone missing at each observed watchdog.

- [ ] **Step 1: Run only the two exact observed failures**

```bash
cargo test -p bibcode-server --lib process::supervised::tests::ready_execution_wins_the_timeout_wake_without_a_separate_waker -- --exact --nocapture
cargo test -p bibcode-server --lib production::provider_runtime::tests::native_process_adapters_cover_live_codex_claude_cursor_and_grok_commands -- --exact --nocapture
```

Record test and wall time. An isolated pass establishes only load sensitivity.

- [ ] **Step 2: Trace supervised future readiness**

Confirm whether `CompletionGatedChild::wait` returning its externally obtained
status also makes the complete pinned execution ready on the same poll. Trace
stdin completion and both pipe collectors as co-owned readiness prerequisites.
The classification must distinguish these states:

```text
external child process exited/reaped
  != ChildWrapper::wait future observed ready
  != complete supervised execution future observed ready
```

- [ ] **Step 3: Trace native-provider positive milestones**

Map fixture process entry, request read, response write/flush, driver reader
acceptance, Codex initialize/initialized/thread-start responses, and
`ProviderDriver::start` completion. Reuse or add test-owned marker files/channels
only at the real fixture boundary when existing evidence cannot identify the
last completed milestone.

- [ ] **Step 4: Run a bounded controlled load reproducer**

Use the already-built server test binary with bounded independent CPU/process
load or the package graph, but never launch more than one full graph at once.
Record whether the supervised future and each Codex milestone complete before
the test task observes them. Do not edit a duration to classify the result.

- [ ] **Step 5: Rank and falsify the hypotheses**

Use these predictions in order:

1. The boundary test gates only `ChildWrapper::wait`, so one timeout-branch poll
   can consume that gate yet still leave stdout/stderr collectors pending. A
   positive ready signal from the entire execution future will eliminate the
   failure without production arbitration changes.
2. The execution future has a lost wake after a child/pipe transition. Driving
   the same pinned future to `Ready` before the timeout must still reproduce the
   timeout if this is true.
3. The provider fixture completes its native protocol, but the two-second outer
   `timeout(codex.start())` expires because the test task is not scheduled under
   graph load. Fixture-owned response/completion evidence will precede the
   `Elapsed` result.
4. The provider process or protocol stalls before a positive response. The last
   fixture milestone will remain absent and the owner, pipe, or protocol path
   requires repair instead of a watchdog change.
5. Finite process/helper capacity is exhausted. Named admission or spawn
   evidence will show a bounded capacity failure and successful recovery; absent
   such evidence rules this out.

### Task 2: Make the supervised boundary regression prove real readiness

**Files:**

- Modify/Test: `apps/server/src/process/supervised.rs`
- Modify only if behavior changes: `docs/architecture/providers.md`

**Interfaces:**

- Consumes: one pinned `execute_child` future and Tokio's `poll_fn`/paused clock.
- Produces: deterministic coverage in which cancellation remains first, a fully
  ready execution beats timeout, and a pending execution times out.

- [ ] **Step 1: Write the deterministic readiness RED**

Replace the external-reap proxy with a test owner that receives a positive
signal only when polling the complete pinned execution returned `Ready`, retains
that ready output without reconstructing the operation, then exposes completion
at the simultaneous timeout wake. The test must fail if timeout is chosen after
the same execution future has proved ready.

- [ ] **Step 2: Run the exact RED**

```bash
cargo test -p bibcode-server --lib process::supervised::tests::ready_execution_wins_the_timeout_wake_without_a_separate_waker -- --exact --nocapture
```

Expected: fail for the old proxy or arbitration at the named boundary, not from
a child spawn, pipe, or assertion setup error.

- [ ] **Step 3: Implement the smallest owner repair**

If the production final poll is already correct, repair only the regression
harness so “completed” means the complete owned execution returned `Ready`.
If the new RED proves a production lost-ready race, change only `execute_child`:
cancellation stays the first biased branch, the timeout branch performs one
non-waiting poll of the same pinned execution, `Ready` is returned, and `Pending`
times out immediately. Do not repoll in a loop or extend the deadline.

- [ ] **Step 4: Verify all arbitration cases**

```bash
cargo test -p bibcode-server --lib process::supervised::tests -- --nocapture
cargo test -p bibcode-server --lib process::supervised::tests -- --test-threads=8 --nocapture
cargo test -p bibcode-server --lib process::supervised::tests -- --test-threads=12 --nocapture
```

The suite must continue to prove pending timeout, cancellation precedence,
required-stream cleanup, owned reap after cleanup timeout, bounded streams, and
zero unowned child lifecycle.

- [ ] **Step 5: Commit the scoped boundary repair**

```bash
git add apps/server/src/process/supervised.rs docs/architecture/providers.md
git commit -m "test(process): prove execution readiness at timeout"
```

Stage `docs/architecture/providers.md` only if the production invariant changed.

### Task 3: Make native-provider coverage owner-event driven

**Files:**

- Modify/Test: `apps/server/src/production/provider_runtime.rs`
- Modify/Test only if its fixture owner is causal:
  `apps/server/src/provider_terminal/codex.rs`
- Modify only if production behavior changes: `docs/architecture/providers.md`

**Interfaces:**

- Consumes: native fixture process/protocol milestones and the unchanged
  production `ProviderDriver` methods.
- Produces: coverage that cannot pass without fixture process entry, protocol
  response publication, driver start completion, event delivery, command
  capture, and joined shutdown.

- [ ] **Step 1: Add the missing positive fixture assertion**

Before changing a watchdog, add a fixture-owned marker/channel for the last
ambiguous Codex milestone identified in Task 1. Assert each milestone separately
with contextual failure text. The production change that must make the test fail
is dropping, misrouting, or not flushing the corresponding native protocol
response.

- [ ] **Step 2: Run the exact test against the old wrapper**

```bash
cargo test -p bibcode-server --lib production::provider_runtime::tests::native_process_adapters_cover_live_codex_claude_cursor_and_grok_commands -- --exact --nocapture
```

Preserve the prior graph RED as the required load failure. If the fixture cannot
publish its positive completion milestone under controlled load, stop and repair
that owner rather than changing the wrapper.

- [ ] **Step 3: Make only the evidence-authorized repair**

Graph pass 3 proved that the two-second wrapper measures host scheduling rather
than a production/provider latency contract: neither fixture response was
prepared by the wrapper deadline, while the same fixture immediately processed
graceful shutdown during bounded cleanup. Replace that wrapper with a single
15-second integration-scale, test-only diagnostic deadline shared by ordered
positive milestones: initialize response ready, thread/start response ready,
then owner completion. Retain one joined owner task and every result, resume,
event, request, command, and shutdown assertion. On watchdog expiry, report the
last reached milestone, abort and join the owner, then run bounded graceful to
owned kill/reap cleanup. Do not change `codex.start`, a production deadline, or
any internal provider timeout.

Add a deterministic paused/gated owner regression proving work delayed beyond
two seconds but released before the shared diagnostic deadline succeeds only
after all ordered milestones. Retain the unresponsive-shutdown regression to
prove an owner that never reaches the next milestone fails bounded and reaps.

- [ ] **Step 4: Verify exact and module coverage at three widths**

```bash
cargo test -p bibcode-server --lib production::provider_runtime::tests::native_process_adapters_cover_live_codex_claude_cursor_and_grok_commands -- --exact --nocapture
cargo test -p bibcode-server --lib production::provider_runtime::tests -- --nocapture
cargo test -p bibcode-server --lib production::provider_runtime::tests -- --test-threads=8 --nocapture
cargo test -p bibcode-server --lib production::provider_runtime::tests -- --test-threads=12 --nocapture
```

Repeat the exact target under bounded graph-like load and require all positive
fixture/protocol assertions plus joined shutdown.

- [ ] **Step 5: Commit the scoped provider test/owner repair**

```bash
git add apps/server/src/production/provider_runtime.rs apps/server/src/provider_terminal/codex.rs docs/architecture/providers.md
git commit -m "test(provider): observe native startup completion under load"
```

Stage only files with evidence-authorized changes.

### Task 4: Verify load contract, resource bounds, and independent review

**Files:**

- Append: `.superpowers/sdd/2026-08-11-parallel-rust-test-sandboxes/task-9-report.md`
- Append: `.superpowers/sdd/2026-08-11-parallel-rust-test-sandboxes/progress.md`
- Review: Task 9D diff from `e6bf7162` through the final scoped commit.

**Interfaces:**

- Produces: complete evidence that Task 9D is safe under default parallel load,
  without resource leakage or hidden serialization.

- [ ] **Step 1: Run the complete affected modules at default/8/12**

Run `process::supervised::tests` and
`production::provider_runtime::tests` at all three harness widths. Both exact
targets must be explicitly present and green.

- [ ] **Step 2: Run the server package**

```bash
vp run --filter bibcode test
```

Require every server test binary to pass with default Rust harness threads.

- [ ] **Step 3: Run one complete workspace graph under the Task 9 sampler**

```bash
vp run test
```

Record package results, the two target lines, descendant/helper/test-binary
high-water counts, cleanup diagnostics, new temp roots, and final survivors.
Compare counts with 79/47/2; investigate a material increase or any unbounded
growth before proceeding. A web exit 137 is residual only after the server is
green and no causal shared resource or leaked descendant is identified.

- [ ] **Step 4: Run static gates**

```bash
vp check
vp run typecheck
cargo fmt --all --check
cargo clippy -p bibcode-server --all-targets -- -D warnings
git diff --check
git status --short
```

- [ ] **Step 5: Obtain independent read-only review**

Review for production deadline drift, false “already complete” evidence,
cancellation-priority regression, busy polling, lost wakes, timeout extension,
unbounded process/helper creation, missing fixture milestones, hidden
serialization, unowned child cleanup, and weak graph-load conclusions. Address
every Critical or Important finding before Task 9 resumes.

- [ ] **Step 6: Commit tracked report updates if repository policy requires it**

The SDD ledger/report are ignored evidence by current repository policy; do not
force-add them. Commit only a required tracked living-document correction, then
report the exact commands and residual risks to the Task 9 coordinator.
