# Task 9H Per-Runtime Process Ownership Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make shutdown of one in-process server runtime terminate and reap
only that runtime's provider and terminal process trees, while peer runtimes in
the same operating-system process remain live.

**Architecture:** Treat the existing per-runtime `ProcessAttributionRegistry`
as the exact root source of truth and as the shutdown admission fence. Shutdown
freezes that registry and captures an identity-safe closure of its registered
roots and currently visible descendants before either manager drops its
registrations. A persistent provider or terminal spawn that reaches
registration after freeze receives a typed rejection and its existing
uncommitted owner kills and reaps it before returning. Existing process-group
and Windows Job owners remain the primary kill-and-reap mechanism; after they
finish, one residual pass resamples surviving captured roots, includes late
descendants, and signals only exact captured identities. The shared-PID
descendant sweep is removed.

**Tech Stack:** Rust 2024, Tokio, `sysinfo`, Linux pidfds, Windows process
handles and Job Objects, Unix process groups, portable-pty, Cargo tests.

## Global Constraints

- Start from clean tracked commit `9c83db92`; preserve ignored Task 9 evidence
  and unrelated user work.
- Do not serialize package, module, or process tests and do not add a
  process-wide test lock.
- Do not widen production or test timeouts and do not add sleeps or scheduler
  yields as synchronization.
- Keep process identity as `(pid, started_at)` on every platform; a numeric PID
  alone is never signal authority.
- Keep the registry bounded at `512` live root registrations. Never evict a
  live registration and never await while holding its `std::sync::Mutex`.
- Existing provider process groups and terminal process groups/Windows Jobs
  remain the primary owners and reapers. The new residual pass is idempotent
  and cannot replace or race those owners with a broad sweep.
- A root registration attempted after shutdown freeze returns a typed
  `Shutdown` rejection; capacity exhaustion returns a distinct typed
  `Capacity` rejection. Neither process is published as live. Provider spawn
  retains its child wrapper until terminate-and-wait completes; terminal work
  remains owned by `UncommittedPtyProcess`, whose process-group/Job kill and PTY
  waiter reap before startup returns.
- Preserve public RPC, schema, persistence, provider command, and terminal
  command behavior. Add no production Node runtime or helper sidecar.
- Linux, macOS, and Windows remain supported. Platform-specific signaling may
  differ, but ownership selection and PID-reuse rejection are identical.
- Run focused tests after each behavior change, then `vp check`,
  `vp run typecheck`, `cargo fmt --all --check`, and affected-target Clippy with
  warnings denied.

---

## Diagnosis and ownership trace

### Root cause

`ServerTerminalServices::shutdown` currently calls
`NativeProcessSampler::cleanup_descendants(std::process::id())` after terminal
shutdown. Multiple `ProductionRuntime` values can share that process ID in the
desktop host and in parallel tests. The sampler therefore selects children of
every peer runtime. macOS reports unsupported identity-bound signaling, while
Linux sends `SIGKILL` through a verified pidfd and Windows calls
`TerminateProcess` through a verified handle. Identity verification prevents
PID reuse, but it does not prove runtime ownership, so the target set is wrong.

### Existing process owners

| Spawn class | Lifetime and current owner | Task 9H treatment |
| --- | --- | --- |
| Native Codex, Claude, Cursor, Grok, and OpenCode sessions | `AttributedChild` retains a `ProcessRegistration`; process-wrap owns a Unix process group or Windows Job and `ProviderRuntimeSupervisor` kills and waits during session shutdown. | Freeze and capture the exact registered root before supervisor cleanup; leave kill/reap with the supervisor, then identity-clean only a surviving captured closure. |
| Ordinary and provider terminals | `TerminalManager` retains a root registration; `PortablePtyProcess` owns the Unix process group or Windows Job; `UncommittedPtyProcess` owns every pre-publication failure. | Freeze registration before capture; a racing pre-publication child is rejected and cleaned by its uncommitted owner; leave normal kill/reap with the manager and identity-clean only captured residuals. |
| Provider-terminal observer helpers | They are launched under the prepared terminal process tree and are retained by observer worker/reaper ownership. | They inherit the captured PTY root and require no second registry. |
| Shared process runner, Git runner, provider maintenance, and most inventory probes | Whole operations are bounded by cancellation/timeout and their local supervised process-group/Job owner waits before returning. | Do not register transient roots or duplicate their lifecycle in Task 9H. |
| Provider usage and relay validation probes | The request future owns a kill-on-drop child and bounded completion; they are not persistent runtime sessions. | Keep request ownership. They are outside the runtime-session residual sweep and are not a reason to signal peer descendants. |
| External editor launch | Intentionally detached and transferred to the user/editor application. | Explicitly exclude it from runtime shutdown ownership. |
| Desktop UI/WebView and WSL/SSH backend processes | Owned by the Tauri host and `DesktopBridge`/backend supervisor, not the in-process server runtime. | Never include them in server-runtime cleanup. |

The server runtime already creates one `ProcessAttributionRegistry` and passes
the same clone to its provider factory, terminal manager, provider-terminal
observer supervisor, and resource sampler. No new global registry or public
configuration is required.

## Alternatives and trade-offs

### Chosen: freeze the existing per-runtime root registry

Add a one-way shutdown freeze that copies registered root identities under the
short registry mutex. Sample the native table after releasing the mutex and
capture the exact roots plus their identity-valid descendants. The freeze is
the linearization point: any racing persistent spawn after it receives a typed
registration error and must clean its uncommitted process before returning.
After manager cleanup, resample and union descendants of any still live
captured root with exact identities from the initial closure. This catches
ordinary late forks without ever walking from the shared application PID.

This is the smallest design with one source of truth. It preserves the existing
process group/Job as the authoritative descendant owner and uses enumeration
only as a residual safety pass. A descendant that forks after initial capture
and whose root exits before the residual sample is still covered by the
manager-owned process group/Job; enumeration is not promoted into a second
reaper.

### Rejected: a second registry of process handles and Job/group tokens

A new shutdown registry could retain every child wrapper, Job, process group,
and wait future. It could be exact, but it would duplicate the owners already
held by provider and terminal managers, require invasive changes to transient
Git/probe/update paths, and create double-kill and double-wait hazards. Task 9H
does not need that second source of truth.

### Rejected: retain the shared-PID sweep behind an exclusivity flag

The native CLI often has one runtime, but the desktop host and tests can have
peers, and no current lifecycle authority proves exclusivity atomically with
child creation. Adding a process-wide runtime counter would still leave a race
between the proof and a peer start. The broad sweep is therefore retired rather
than conditionally retained.

## Shutdown sequence and invariants

1. Drain worktree operations, catalog observation, delivery, effects, and
   provider-update scheduling as today.
2. Call `ProcessAttributionRegistry::freeze_and_snapshot_identities`. This
   makes registration one-way closed and copies at most 512 exact roots without
   awaiting under the mutex. A provider or terminal spawn that raced across
   this point receives a typed rejection and its existing uncommitted owner
   kills and reaps it; no new manager lifecycle protocol is required.
3. `NativeProcessSampler::capture_runtime_process_ownership` samples after the
   mutex is released. It accepts a root only when the sampled creation identity
   matches, walks only parent links whose exact parent identity is already in
   the owned closure, rejects creation-time inversion/cycles, deduplicates, and
   stores identities leaf-first.
4. Provider shutdown and terminal shutdown retain their current
   graceful/forced process-group or Job termination and wait behavior. Provider
   actor queue ordering and terminal lifecycle cancellation continue to reject
   later work; the registry fence closes the narrower post-spawn publication
   race.
5. `cleanup_runtime_process_ownership` samples once more. It selects only exact
   initial identities still alive plus descendants of still-live captured
   roots, again with identity-valid parent links, and signals leaves before
   roots. `NotFound` and `StaleIdentity` mean the captured process is already
   gone and are successful idempotent outcomes; unsupported/rejected/read
   failures remain bounded diagnostics.
6. A second shutdown is inert. A restarted `ProductionRuntime` owns a fresh,
   unfrozen registry and cannot inherit the old runtime's roots or snapshot.

No filesystem, protocol, persistence, authentication, or desktop trust
boundary changes. Registry copying is `O(512)` under a short lock; native table
walks occur only at shutdown and are linear in sampled rows. No new hot-path
task, queue, polling loop, or allocation occurs during ordinary execution.

---

### Task 1: Freeze and capture exact runtime ownership

**Files:**

- Modify: `apps/server/src/diagnostics/registry.rs`
- Modify: `apps/server/src/diagnostics/native.rs`
- Modify: `apps/server/src/diagnostics/mod.rs`
- Test: `apps/server/src/diagnostics/registry.rs`
- Test: `apps/server/src/diagnostics/native.rs`

**Interfaces:**

- Produces:

```rust
pub(crate) fn freeze_and_snapshot_identities(&self) -> Vec<ProcessIdentity>;

pub(crate) fn register_identity(
    &self,
    identity: ProcessIdentity,
    metadata: ProcessRegistrationMetadata,
) -> Result<ProcessRegistration, ProcessRegistrationError>;

#[derive(Clone, Debug, Default)]
pub(crate) struct RuntimeProcessOwnership {
    roots: Vec<ProcessIdentity>,
    captured: Vec<ProcessIdentity>,
}

pub(crate) async fn capture_runtime_process_ownership(
    &self,
    roots: Vec<ProcessIdentity>,
) -> Result<RuntimeProcessOwnership, SamplingError>;

pub(crate) async fn cleanup_runtime_process_ownership(
    &self,
    ownership: RuntimeProcessOwnership,
) -> Result<ProcessCleanupReport, SignalError>;
```

- `RuntimeProcessOwnership` remains crate-internal and contains no public
  schema or serialized state.
- `freeze_and_snapshot_identities` is one-way and idempotent. A new runtime
  receives a new unfrozen registry. `ProcessRegistrationError` distinguishes
  `Shutdown` from `Capacity`; persistent process callers must fail closed and
  clean their uncommitted child for either result.

- [ ] **Step 1: Write failing registry and closure tests**

Add literal synthetic process rows proving:

```rust
#[test]
fn shutdown_freeze_is_idempotent_and_rejects_late_roots() {
    // Register roots A and B, freeze twice, and assert both snapshots contain
    // exactly A then B. A later registration returns None and neither snapshot
    // nor registry length grows.
}

#[test]
fn owned_closure_excludes_a_peer_runtime_under_the_same_server_pid() {
    // Rows: server -> A -> A-child and server -> B -> B-child.
    // Capturing root A yields [A-child, A] and never B/B-child.
}

#[test]
fn owned_closure_rejects_pid_reuse_and_creation_time_inversion() {
    // A captured root with start 100 must not match PID A/start 200, and a
    // child whose start precedes its parent must not enter the closure.
}

#[test]
fn residual_selection_includes_descendants_forked_after_initial_capture() {
    // Initial rows contain root A. Residual rows contain A and a new A-child;
    // final cleanup candidates are [A-child, A]. A peer B remains excluded.
}
```

The production mutation caught is replacing per-runtime roots with
`std::process::id()` or accepting a numeric PID without its creation identity.

- [ ] **Step 2: Run the exact tests and record RED**

Run:

```bash
cargo test -p bibcode-server --lib \
  diagnostics::registry::tests::shutdown_freeze_is_idempotent_and_rejects_late_roots \
  -- --exact --nocapture
cargo test -p bibcode-server --lib \
  diagnostics::native::tests::owned_closure_excludes_a_peer_runtime_under_the_same_server_pid \
  -- --exact --nocapture
```

Expected: compile failure because the freeze and runtime-ownership APIs do not
exist. Do not write production code until both tests have demonstrated this
failure.

- [ ] **Step 3: Implement the bounded freeze and pure closure selector**

Add `accepting_registrations: bool` to `RegistryState`, initialized to `true`.
`freeze_and_snapshot_identities` sets it to `false`, copies identities in
`registration_order`, and releases the mutex. `register_identity` returns
`Err(ProcessRegistrationError::Shutdown)` after freeze without evicting or
mutating existing entries. Capacity returns
`Err(ProcessRegistrationError::Capacity)` and also never evicts a live owner.

Implement a pure helper in `native.rs` that indexes rows by exact identity and
PID, seeds only exact matching roots, traverses children only from already
owned exact parents, enforces `parent.started_at <= child.started_at`, guards
cycles, deduplicates nested roots, and emits deepest-first identities. Both
initial capture and residual selection use this same helper.

- [ ] **Step 4: Implement identity-only residual cleanup**

Resample after manager shutdown. Union exact still-live identities from the
initial capture with the current closure of still-live roots, sort deepest
first, and call the existing platform identity-bound signal seam. Treat
`NotFound` and `StaleIdentity` as the already-satisfied cleanup state. Keep the
existing bounded `ProcessCleanupReport` for real failures.

Do not wait on a numeric PID or invent a second reaper. Provider/terminal
owners retain wait authority; this pass only terminates a captured residual.

- [ ] **Step 5: Run GREEN and focused diagnostics modules**

Run:

```bash
cargo test -p bibcode-server --lib diagnostics::registry::tests -- --test-threads=8
cargo test -p bibcode-server --lib diagnostics::native::tests -- --test-threads=8
cargo test -p bibcode-server --lib diagnostics::resource_sampler::tests -- --test-threads=8
```

Expected: all pass with no process-global lock and no shared-PID selection.

- [ ] **Step 6: Commit Task 1**

```bash
git add apps/server/src/diagnostics/registry.rs \
  apps/server/src/diagnostics/native.rs apps/server/src/diagnostics/mod.rs
git commit -m "fix(process): capture exact runtime process ownership"
```

---

### Task 2: Fail closed when a persistent spawn races registry freeze

**Files:**

- Modify: `apps/server/src/production/provider_runtime.rs`
- Modify: `apps/server/src/terminal/manager.rs`
- Test: `apps/server/src/production/provider_runtime.rs`
- Test: `apps/server/src/terminal/manager.rs`

**Interfaces:**

- Produces:

```rust
pub(crate) enum ProcessRegistrationError {
    Shutdown,
    Capacity,
}
```

- Provider mapping: `Shutdown` becomes `ProviderRuntimeError::Shutdown` after
  terminate-and-wait; `Capacity` becomes the existing typed spawn error with a
  bounded detail after terminate-and-wait.
- Terminal mapping: `Shutdown` becomes `TerminalError::Shutdown` while the
  `UncommittedPtyProcess` still owns cleanup; `Capacity` becomes a typed spawn
  failure and is cleaned by the same owner.

- [ ] **Step 1: Write failing admission-fence tests**

Add tests proving:

```rust
#[tokio::test]
async fn provider_spawn_rejected_after_freeze_is_killed_and_reaped() {
    // Freeze the factory's registry, launch a positively gated real provider,
    // assert typed Shutdown, and prove the exact child identity disappears.
}

#[tokio::test]
async fn provider_capacity_rejection_is_killed_and_reaped() {
    // Fill the bounded registry, launch a positively gated real provider,
    // assert typed spawn/capacity failure, and prove no child survives.
}

#[tokio::test]
async fn terminal_spawn_rejected_after_freeze_is_killed_and_reaped() {
    // Freeze the manager registry before a real start; assert typed Shutdown,
    // no live session publication, and exact child reap by the uncommitted
    // process owner.
}
```

The production mutations caught are treating ownership registration as
best-effort and returning from startup while an unregistered child remains
live.

- [ ] **Step 2: Run exact RED tests**

Run each test by exact fully qualified name with `--nocapture`. Expected:
compile/type failure because registration does not return typed errors and the
provider path cannot await cleanup. Confirm fixtures use positive readiness and
exact process identity, not timing.

- [ ] **Step 3: Make provider registration and cleanup fail closed**

Make the native provider `spawn_child` path async. After spawn, require an exact
live identity and typed registry success before returning the child wrapper. On
`Shutdown`, `Capacity`, or missing exact identity, call the existing bounded
`terminate_and_wait`, log only bounded secondary cleanup failures, and then
return the primary typed error. Do not detach cleanup or register transient
probe/maintenance work.

- [ ] **Step 4: Make terminal registration fail closed**

Require an exact live identity and typed registry success before constructing
or publishing the terminal session. On `Shutdown` return
`TerminalError::Shutdown`; on `Capacity` return a typed spawn failure. In both
cases the still-armed `UncommittedPtyProcess` kills the process group/Job and
the existing PTY waiter reaps the root. Preserve the manager's existing final
lifecycle cancellation check; do not add another manager fence.

- [ ] **Step 5: Run GREEN and affected manager suites**

Run:

```bash
cargo test -p bibcode-server --lib production::provider_runtime::tests -- --test-threads=8
cargo test -p bibcode-server --lib terminal::manager::tests -- --test-threads=8
cargo test -p bibcode-server --test production_provider_runtime -- --test-threads=8
cargo test -p bibcode-server --test provider_terminal_supervisor -- --test-threads=8
```

Expected: all pass; no widened deadlines, detached owner, or test
serialization.

- [ ] **Step 6: Commit Task 2**

```bash
git add apps/server/src/production/provider_runtime.rs \
  apps/server/src/terminal/manager.rs
git commit -m "fix(server): reject unowned persistent process spawns"
```

---

### Task 3: Replace the shared-PID sweep in runtime shutdown

**Files:**

- Modify: `apps/server/src/production/server_terminal.rs`
- Modify: `apps/server/src/production/runtime.rs`
- Modify: `apps/server/src/production/worktree_runtime.rs`
- Modify: `apps/server/tests/production_server_terminal_rpc.rs`
- Modify: `docs/architecture/overview.md`
- Modify: `docs/architecture/providers.md`
- Test: `apps/server/src/production/server_terminal.rs`
- Test: `apps/server/tests/production_server_terminal_rpc.rs`

**Interfaces:**

- `ServerTerminalServices::new` receives the same
  `ProcessAttributionRegistry` already passed to the terminal manager and
  native resource sampler.
- Produces crate-internal begin/capture/finish shutdown methods that retain a
  `RuntimeProcessOwnership` value across provider and terminal cleanup.
- Removes `cleanup_descendants(std::process::id())` from every runtime shutdown
  path. The Task 8 harness may retain its direct diagnostic seam test, but
  production runtime code must have no shared-PID cleanup caller.

- [ ] **Step 1: Write the deterministic two-runtime RED regression**

Create two independent `ProcessAttributionRegistry` values, two real
`TerminalManager` values using `PortablePtyBackend`, and two
`ServerTerminalServices` values in one test process. For each service:

1. Launch a real shell terminal through the production manager.
2. Subscribe before writing a unique readiness token.
3. Write the token and wait until its real output is observed.
4. Capture its exact root identity from its own registry.

Then shut down service A and assert, by positive conditions rather than sleep:

- A's exact root identity disappears;
- B's exact root identity still matches the native process table;
- B accepts a second unique command and returns its output;
- shutting down B removes B's exact root identity.

Run without a global lock and with test harness thread counts `default`, `8`,
and `12`. On Linux/Windows the current production sweep kills B and the test
fails at the second response/liveness assertion. On macOS, where the dangerous
signal is unsupported, the Task 1 literal ownership-selection RED is the
host-independent proof that the production target set is wrong; the real test
still proves manager ownership and response/reap behavior.

- [ ] **Step 2: Record RED and inspect survivors**

Run:

```bash
cargo test -p bibcode-server --lib \
  production::server_terminal::tests::shutdown_reaps_only_its_runtime_child_and_peer_remains_responsive \
  -- --exact --nocapture
```

Expected before implementation: the test or its ownership assertion fails
because `ServerTerminalServices` has no per-runtime shutdown snapshot and uses
the application PID. Record PID, creation identity, and command for A and B;
the test cleanup must always release/kill both fixtures after an assertion
failure.

- [ ] **Step 3: Wire exact capture through production shutdown**

In `ProductionRuntime::quiesce_for_update`, preserve upstream drain ordering,
then:

1. freeze the shared runtime registry and capture ownership;
2. run provider shutdown;
3. run terminal manager shutdown;
4. run residual identity cleanup with the retained snapshot;
5. preserve the first bounded manager error while still attempting every later
   cleanup stage.

For standalone `ServerTerminalServices::shutdown`, begin terminal shutdown,
capture from its registry, and finish through the same path. Remove the
application-PID descendant sweep and its misleading success warning.

- [ ] **Step 4: Update living architecture documentation**

In `docs/architecture/overview.md` and `docs/architecture/providers.md`, state
that each runtime owns one bounded root registry, provider/terminal process
groups or Jobs are the primary termination/reap owners, shutdown freezes and
captures exact identities before manager teardown, and no in-process runtime
may signal arbitrary descendants of the shared desktop/test PID.

- [ ] **Step 5: Run GREEN at default/8/12 and integration coverage**

Run:

```bash
cargo test -p bibcode-server --lib \
  production::server_terminal::tests::shutdown_reaps_only_its_runtime_child_and_peer_remains_responsive \
  -- --exact --nocapture
cargo test -p bibcode-server --lib production::server_terminal::tests
cargo test -p bibcode-server --lib production::server_terminal::tests -- --test-threads=8
cargo test -p bibcode-server --lib production::server_terminal::tests -- --test-threads=12
cargo test -p bibcode-server --test production_server_terminal_rpc -- --test-threads=8
cargo test -p bibcode-server --test server_runtime -- --test-threads=8
cargo test -p bibcode-server --test production_provider_runtime -- --test-threads=8
cargo test -p bibcode-server --test terminal_rpc -- --test-threads=8
```

Expected: every command exits zero, B responds after A shutdown, both exact
roots are reaped by their own shutdown, and no unsupported shared-PID cleanup
warning is emitted.

- [ ] **Step 6: Commit Task 3**

```bash
git add apps/server/src/production/server_terminal.rs \
  apps/server/src/production/runtime.rs \
  apps/server/src/production/worktree_runtime.rs \
  apps/server/tests/production_server_terminal_rpc.rs \
  docs/architecture/overview.md docs/architecture/providers.md
git commit -m "fix(server): scope shutdown cleanup to runtime owners"
```

---

### Task 4: Cross-platform gates, soak, and independent review

**Files:**

- Modify: `.superpowers/sdd/2026-08-11-parallel-rust-test-sandboxes/task-9-report.md` (ignored evidence only)
- Modify: `.superpowers/sdd/2026-08-11-parallel-rust-test-sandboxes/progress.md` (ignored evidence only)
- Review: all Task 9H tracked changes from `9c83db92` through final HEAD.

**Interfaces:**

- Produces evidence that ownership is exact under default parallel execution,
  Linux pidfds, Windows validated handles/Jobs, and macOS process-group cleanup.
- Produces an independent `Ready: Yes/No` verdict with Critical, Important,
  and Minor findings.

- [ ] **Step 1: Run platform and static ownership gates**

Run native platform tests plus the repository's existing stable Windows target
compile/harness used for diagnostics and process ownership. Confirm the Windows
build compiles `OpenProcess`, creation-time verification, `TerminateProcess`,
and Job-backed primary cleanup. Run static searches showing:

```bash
rg -n "cleanup_descendants\(std::process::id\(\)\)" apps/server/src
rg -n "test-threads=1|serial_test|#\[serial" apps/server .github scripts
```

Expected: the production shared-PID cleanup search is empty; serialization
search results are only approved isolated subprocess cases already documented
by Task 9.

- [ ] **Step 2: Run focused and broad Rust verification**

Run sequentially:

```bash
cargo test -p bibcode-server -j 2
cargo test --workspace -j 2
cargo fmt --all --check
cargo clippy -p bibcode-server --all-targets -- -D warnings
vp check
vp run typecheck
git diff --check
```

If the change affects the Task 8 source-inclusion harness, also run its exact
fixture manifest. Do not serialize the server/workspace suites.

- [ ] **Step 3: Run the Task 9 concurrent graph and survivor audit**

Run one clean `vp run test` with the existing Task 9 PID/start-time/command and
temporary-root before/after sampler. If any test fails or any scoped survivor
appears, stop and diagnose that exact failure before further graph runs. If the
first graph is green, run the remaining consecutive final-code graphs required
by the parent Task 9 plan.

Expected: all package tasks pass; no new scoped survivor/root; no
identity-bound cleanup warning selecting peer runtime children; no
admission/capacity regression.

- [ ] **Step 4: Request independent review and address findings**

Give the reviewer the Task 9 final blocker, this amendment, base
`9c83db92`, final HEAD, the RED/GREEN evidence, and explicit questions about:

- registry-freeze/capture/cleanup linearization;
- descendants forked between initial and residual samples;
- PID reuse and creation-time inversion;
- process-group/Job primary ownership and double-kill/double-wait;
- typed late-spawn rejection, owned cleanup, and idempotent shutdown;
- registry capacity, restart isolation, and lock/await behavior;
- Linux, macOS, and Windows selection/signal semantics;
- accidental policy, timeout, serialization, or public API drift.

Address every Critical or Important finding before Task 9 resumes.

- [ ] **Step 5: Record exact evidence and final diff review**

Append exact commands, pass counts, durations, platform limitations, warning
counts, survivor/root deltas, review verdict, and residual risks to the ignored
Task 9 report/ledger. Review:

```bash
git diff --stat 9c83db92..HEAD
git diff --check 9c83db92..HEAD
git status --short
```

Expected: only scoped diagnostics/manager/runtime/tests/living-doc changes are
tracked; no `.codegraph/`, `.repos/`, dependency, lockfile, generated, debug,
or unrelated files are included.
