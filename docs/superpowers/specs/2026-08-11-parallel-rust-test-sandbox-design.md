# Parallel Rust Test Sandbox Design

**Status:** Approved in conversation on 2026-08-11; written-spec review pending.

## Problem

BiBCode is a multithreaded, real-time application, but the server and desktop
package scripts and CI currently pass `--test-threads=1` to Rust's test
harness. The workspace graph still runs the two Cargo commands concurrently,
which has exposed rotating failures in provider probes, helper readiness,
relay validation, Git/source-control fixtures, desktop RPCs, and native command
tests.

Serial execution hides logical races and test isolation defects. Increasing
production timeouts would also hide the problem and weaken real-time failure
bounds. The test architecture must instead support Rust's default parallel
threads while preserving production deadlines and real child-process,
cancellation, output-drain, RPC, and reap assertions.

## Goals

- Run server and desktop Rust tests with default parallel test threads.
- Keep server and desktop package tasks concurrent in the workspace graph.
- Eliminate in-process mutation of process-global `PATH` and current directory.
- Replace broad test serialization locks and mutable static overrides with
  instance-owned dependencies and resources.
- Use positive synchronization to establish concurrency order; wall-clock
  timeouts remain diagnostic failure bounds only.
- Preserve real processes, real local sockets/listeners, bounded output,
  cancellation, and child/task cleanup coverage.
- Treat newly exposed production races as product defects with deterministic
  RED-to-GREEN regression tests.
- Maintain or improve concurrent test throughput and record timing/concurrency
  evidence without a brittle cross-machine wall-clock threshold.

## Non-goals

- Widening production provider, Git, relay, terminal, RPC, or desktop command
  deadlines.
- Replacing real-process integration fixtures with mocks.
- Serializing the workspace graph, Cargo package tasks, or Rust test binaries.
- Adding compatibility aliases, public test APIs, protocol changes, or
  persistence changes.
- Treating every graph-only failure as a production race without tracing its
  state and resource ownership.

## Current Failure Model

The current suite contains four distinct kinds of concurrency risk:

1. Process-global test mutation: server tests alter `PATH` and current
   directory; desktop tests use mutable static command overrides.
2. Broad lock convoys: `EXTERNAL_PROCESS_TEST_LOCK` and other shared test locks
   serialize unrelated fixtures and conceal their true dependencies.
3. Observation races: tests poll PID/socket/output files or rely on
   `yield_now`, sleeps, or short wall-clock deadlines rather than awaiting a
   positive start/listen/request/reap event.
4. Genuine product races: parallel execution may reveal stale publication,
   lock-order, cancellation, or resource ownership bugs in production code.

Rust prevents unsynchronized memory access, but it does not prevent logical
races or unsafe process-global test behavior. The design addresses both.

## Chosen Approach

Use resource-scoped test sandboxes and eliminate mutable process globals. A
narrow lock may remain only for a proven irreducible singleton and must have a
named resource, documented ownership, bounded scope, and cancellation/panic
release coverage. A test that genuinely requires global process state runs in
an isolated child test process instead of sharing that state with other test
threads.

This is preferred over:

- selective or global suite serialization, which hides concurrency defects;
- merely splitting the broad lock into smaller permanent locks, which leaves
  a fragile classification burden;
- increasing fixture and production timeouts, which does not establish
  ordering and degrades failure detection.

The implementation may use narrowly classified locks as a migration aid, but
the final state removes them wherever explicit dependency injection or
subprocess isolation can model the resource correctly.

## Architecture

### Instance-owned launch context

Internal process-launch boundaries accept an immutable, instance-owned launch
context that is `Send + Sync`. It contains the executable selection,
environment overlay, command-local working directory, and other launch inputs
that a caller already owns. Production constructors capture production
defaults once. Tests construct explicit contexts and never mutate the parent
process environment or current directory.

The context is internal. It does not change public RPCs, persistence, provider
behavior, or production timeout policy.

### Test sandbox

Private server and desktop test-support modules provide a `TestSandbox` that
owns all resources created for one fixture:

- unique temporary root and derived script/PID/socket/output paths;
- explicit executable paths and environment overlay;
- retained ephemeral TCP/Unix listener ownership;
- command-local working directory;
- readiness and lifecycle channels;
- child/task handles and cancellation tokens;
- cleanup and leak accounting.

Sandboxes do not share mutable global state. Multiple sandboxes must be able to
run the same fixture concurrently with distinct identities.

### Owned fixture primitives

The sandbox exposes focused primitives rather than one large test framework:

- `FixtureExecutable` provides an explicit executable path and environment.
- `FixtureServer` retains its listener, owns its task, and signals readiness.
- `FixtureProcess` uses the real process supervisor and owns bounded output
  drains, cancellation, termination, and reap evidence.
- `FixtureWorkingDirectory` supplies command-local CWD. Tests of invalid global
  CWD run in an isolated child test process.
- `FixtureBarrier` reports monotonic events such as child spawned, listener
  ready, PID published, request received, cancellation observed, and child
  reaped.

Each unit has one ownership boundary and can be replaced internally without
changing its callers.

## Execution and Cleanup Flow

1. Allocate a sandbox and unique resources.
2. Build the real operation with an explicit launch context.
3. Poll or spawn the operation so process/task creation can occur.
4. Await a positive readiness event.
5. Execute concurrent operations and assertions.
6. Complete, cancel, time out, or induce the planned failure.
7. Await terminal cleanup and verify child/task/listener/resource release.

Wall-clock timeouts wrap these steps only as bounded diagnostic watchdogs. A
timeout never establishes that an ordering event occurred.

An explicit async shutdown path performs full cleanup. Drop remains a fallback
that cancels/terminates owned work without blocking. No blocking mutex or
filesystem/process operation may be held across an async wait.

## Thread-safety Rules

- Shared immutable state uses `Arc`.
- Counters and one-way flags use atomics with documented ordering.
- Coordination uses `oneshot`, `mpsc`, `Notify`, `Barrier`, or narrowly scoped
  async locks.
- Blocking filesystem/process work uses existing bounded blocking boundaries.
- Lock ordering is documented for any path that acquires more than one lock.
- Test fixture state is never stored in an unscoped mutable static.
- Tests do not call process-global environment or CWD mutation while other
  threads exist.
- Partial file publication is not treated as readiness; use an atomic write or
  a positive channel/barrier and validate complete content.
- Every cancellation and panic path releases permits, listeners, tasks, and
  child ownership.

## Failure Classification

Every parallel failure is classified before editing:

### Production concurrency defect

Examples include stale state publication, lock-order cycles, duplicate
terminal/process ownership, lost cancellation, or unsafe cleanup. Fix the
production state owner and add a deterministic regression. The defect blocks
completion.

### Fixture isolation defect

Examples include shared environment/CWD, mutable static overrides, reused
paths, dropped listener handoff, or polling a partially written PID file.
Move the fixture to instance-owned resources and positive synchronization.

### Genuine bounded-resource exhaustion

Use a named, finite admission mechanism owned by the affected subsystem. Test
capacity, fairness, cancellation, and recovery explicitly. Do not replace it
with an unnamed global lock or unbounded queue.

## Migration Sequence

1. Add server and desktop sandbox primitives with concurrent self-tests,
   cancellation cleanup, panic cleanup, and leak accounting.
2. Replace process-global `PATH` mutation with explicit executable/environment
   injection in provider, Git, source-control, relay, and maintenance tests.
3. Replace global CWD mutation with command-local CWD; move irreducible invalid
   global-CWD coverage to a child test process.
4. Replace desktop WSL and similar mutable static overrides with instance-owned
   resolver/config dependencies.
5. Migrate process fixtures to unique resources and positive readiness/reap
   barriers. Remove redundant extended observation timeouts where barriers
   make them unnecessary.
6. Remove broad process locks and superseded module locks after their callers
   migrate. Retain only documented irreducible singleton locks.
7. Remove `--test-threads=1` from server, desktop, and CI.
8. Run the default-thread suites and concurrent workspace graph. Fix each newly
   exposed product or fixture race according to the classification above.

Changes are committed and reviewed by ownership boundary so regressions remain
attributable and reversible.

## Verification

Focused acceptance:

- Concurrent instances of each migrated fixture use distinct PID, socket,
  path, listener, and process identities.
- Cancellation before readiness and after readiness reaps the exact child.
- Panic/abort cleanup releases all owned resources.
- Bounded stdout/stderr remain bounded while both streams drain concurrently.
- No in-process test mutates global `PATH` or current directory.
- No broad test lock remains.

Suite acceptance:

- `cargo test -p bibcode-server` passes with default test threads.
- `cargo test -p bibcode-desktop` passes with default test threads.
- Server and desktop package tests pass when launched concurrently.
- `vp run test` passes three consecutive clean runs with the normal parallel
  task graph.
- CI's Rust workspace command passes without `--test-threads=1`.
- `vp check`, `vp run typecheck`, `cargo fmt --all --check`, and
  workspace all-target Clippy with warnings denied pass.
- Final diff/status review shows no dependency drift, generated noise,
  `.repos`, `.codegraph`, or ignored evidence staged.

## Performance Evidence

Record for isolated and concurrent runs:

- wall-clock duration;
- maximum concurrently active fixtures/children;
- any named resource admission wait;
- leaked child/listener/task count at completion.

The acceptance gate does not use a fixed cross-machine wall-clock threshold.
Instead, the graph must remain parallel, complete reliably, expose bounded
resource ownership, and avoid new blocking or global serialization. Material
performance regression discovered on the same host must be diagnosed before
completion.

## Rollout and Compatibility

All new APIs are private/internal testability boundaries. Production defaults,
deadlines, RPC schemas, persistence, authentication, and provider behavior
remain unchanged. The runner flag removal lands only after fixture migrations
and focused concurrency tests are green, preventing an intermediate commit
from making the repository's standard test command unusable.
